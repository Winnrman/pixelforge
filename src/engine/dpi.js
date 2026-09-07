// Physical size, for printing.
//
// A PNG is dimensionless by default: it carries a pixel count and nothing about
// how big those pixels are meant to be. Print software then guesses — usually 72
// or 96 dpi — so a sticker exported at 1200px comes out as a 12-inch sticker
// unless you correct it by hand at the other end. The fix is the `pHYs` chunk,
// which states pixels per metre, and which every print pipeline reads.
//
// This module writes that chunk and does the arithmetic that turns "100mm wide
// at 300dpi" into a pixel count.

const MM_PER_INCH = 25.4

export const UNITS = [
  { id: 'mm', label: 'mm', perInch: MM_PER_INCH },
  { id: 'cm', label: 'cm', perInch: MM_PER_INCH / 10 },
  { id: 'in', label: 'in', perInch: 1 },
]

const unitOf = (id) => UNITS.find((u) => u.id === id) || UNITS[0]

/** The resolutions worth offering, and what each is actually for. */
export const DPI_PRESETS = [
  { dpi: 72, label: '72 — screen' },
  { dpi: 150, label: '150 — draft print' },
  { dpi: 300, label: '300 — print' },
  { dpi: 600, label: '600 — fine print' },
]

/** Pixels needed for a physical size at a given dpi. */
export function pxFor(size, unit, dpi) {
  const u = unitOf(unit)
  return Math.max(1, Math.round((size / u.perInch) * dpi))
}

/** The physical size a pixel count comes out as at a given dpi. */
export function sizeFor(px, unit, dpi) {
  const u = unitOf(unit)
  return (px / dpi) * u.perInch
}

/** Pixels per metre, as the PNG spec wants it. */
export const ppmFor = (dpi) => Math.round(dpi / 0.0254)

/** And back again, for reading a file's own claim. */
export const dpiForPpm = (ppm) => Math.round(ppm * 0.0254)

// PNG chunk CRC. Small enough that pulling in a dependency for it would cost
// more than it saves.
const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()

function crc32(bytes) {
  let c = 0xffffffff
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

const SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]

const isPng = (b) => b.length > 8 && SIG.every((v, i) => b[i] === v)

function physChunk(dpi) {
  const out = new Uint8Array(21)
  const view = new DataView(out.buffer)
  view.setUint32(0, 9)                       // data length
  out.set([0x70, 0x48, 0x59, 0x73], 4)       // 'pHYs'
  const ppm = ppmFor(dpi)
  view.setUint32(8, ppm)                     // pixels per unit, x
  view.setUint32(12, ppm)                    // pixels per unit, y
  out[16] = 1                                // unit specifier: 1 = the metre
  view.setUint32(17, crc32(out.subarray(4, 17)))
  return out
}

/**
 * Returns the PNG bytes with a `pHYs` chunk stating the given resolution.
 *
 * Inserted straight after `IHDR`, which the spec requires to come first, and
 * replacing any `pHYs` already present rather than writing a second one — two
 * would be invalid and readers disagree about which wins.
 *
 * Returns the input unchanged if it is not a PNG, so a caller can apply this
 * without first checking what it has.
 */
export function withDPI(bytes, dpi) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
  if (!isPng(b) || !(dpi > 0)) return b

  const parts = [b.subarray(0, 8)]
  let i = 8
  let placed = false
  while (i + 8 <= b.length) {
    const len = new DataView(b.buffer, b.byteOffset + i, 4).getUint32(0)
    const type = String.fromCharCode(b[i + 4], b[i + 5], b[i + 6], b[i + 7])
    const end = i + 12 + len
    if (end > b.length) break
    if (type !== 'pHYs') parts.push(b.subarray(i, end))
    if (type === 'IHDR') { parts.push(physChunk(dpi)); placed = true }
    i = end
    if (type === 'IEND') break
  }
  if (!placed) return b

  const total = parts.reduce((n, p) => n + p.length, 0)
  const out = new Uint8Array(total)
  let at = 0
  for (const p of parts) { out.set(p, at); at += p.length }
  return out
}

/** The resolution a PNG claims, or null if it does not claim one. */
export function readDPI(bytes) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
  if (!isPng(b)) return null
  let i = 8
  while (i + 8 <= b.length) {
    const view = new DataView(b.buffer, b.byteOffset + i)
    const len = view.getUint32(0)
    const type = String.fromCharCode(b[i + 4], b[i + 5], b[i + 6], b[i + 7])
    if (type === 'pHYs' && len === 9) {
      const unit = b[i + 16]
      const ppm = new DataView(b.buffer, b.byteOffset + i + 8).getUint32(0)
      // Unit 0 means "no unit" — an aspect ratio only, not a physical size.
      return unit === 1 ? dpiForPpm(ppm) : null
    }
    i += 12 + len
    if (type === 'IEND') break
  }
  return null
}

/** A blob with the resolution written into it. */
export async function blobWithDPI(blob, dpi) {
  if (!(dpi > 0)) return blob
  const bytes = withDPI(new Uint8Array(await blob.arrayBuffer()), dpi)
  return new Blob([bytes], { type: blob.type || 'image/png' })
}
