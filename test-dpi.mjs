// The pHYs chunk and the print arithmetic, under plain node.
//
// This is byte surgery on a file format, so it is worth checking against a real
// PNG rather than one this module made itself — a writer and a reader that agree
// with each other can still both be wrong.
import fs from 'fs'
import {
  withDPI, readDPI, pxFor, sizeFor, ppmFor, dpiForPpm, UNITS, DPI_PRESETS,
} from './src/engine/dpi.js'

const checks = []
const check = (name, ok, detail = '') => {
  checks.push([name, ok])
  console.log((ok ? 'PASS  ' : 'FAIL  ') + name + (detail ? '  — ' + detail : ''))
}

// --- the arithmetic -------------------------------------------------------------
check('100mm at 300dpi is 1181px', pxFor(100, 'mm', 300) === 1181, String(pxFor(100, 'mm', 300)))
check('4in at 300dpi is 1200px', pxFor(4, 'in', 300) === 1200, String(pxFor(4, 'in', 300)))
check('10cm at 300dpi matches 100mm', pxFor(10, 'cm', 300) === pxFor(100, 'mm', 300))
check('and it round trips', Math.abs(sizeFor(pxFor(100, 'mm', 300), 'mm', 300) - 100) < 0.1,
  sizeFor(pxFor(100, 'mm', 300), 'mm', 300).toFixed(3))
check('72dpi is 2835 pixels per metre', ppmFor(72) === 2835, String(ppmFor(72)))
check('300dpi is 11811 pixels per metre', ppmFor(300) === 11811, String(ppmFor(300)))
check('and that converts back', dpiForPpm(ppmFor(300)) === 300, String(dpiForPpm(ppmFor(300))))
check('every unit is offered with a conversion', UNITS.every((u) => u.perInch > 0))
check('and the presets cover screen through fine print',
  DPI_PRESETS.some((d) => d.dpi === 72) && DPI_PRESETS.some((d) => d.dpi === 600))

// --- a real PNG, made by something other than this file ---------------------------
const src = new Uint8Array(fs.readFileSync('public/test/room.png'))
check('the fixture is a PNG with no resolution of its own', readDPI(src) === null)

const at300 = withDPI(src, 300)
check('stamping one reads back', readDPI(at300) === 300, String(readDPI(at300)))
check('and the file grew by exactly one 21-byte chunk', at300.length === src.length + 21,
  `${src.length} -> ${at300.length}`)

// The chunk has to sit immediately after IHDR, which is where the spec puts it
// and where readers that do not walk the whole file will look.
const typeAt = (b, i) => String.fromCharCode(b[i + 4], b[i + 5], b[i + 6], b[i + 7])
const ihdrLen = new DataView(at300.buffer, at300.byteOffset + 8, 4).getUint32(0)
check('IHDR is still first', typeAt(at300, 8) === 'IHDR')
check('and pHYs comes straight after it', typeAt(at300, 8 + 12 + ihdrLen) === 'pHYs',
  typeAt(at300, 8 + 12 + ihdrLen))

// Re-stamping must replace, not accumulate: two pHYs chunks is an invalid file.
const at600 = withDPI(at300, 600)
check('re-stamping replaces rather than appends', at600.length === at300.length,
  `${at300.length} -> ${at600.length}`)
check('and the new value is the one that reads back', readDPI(at600) === 600,
  String(readDPI(at600)))
let physCount = 0
for (let i = 8; i + 8 <= at600.length;) {
  const len = new DataView(at600.buffer, at600.byteOffset + i, 4).getUint32(0)
  if (typeAt(at600, i) === 'pHYs') physCount++
  i += 12 + len
}
check('exactly one pHYs chunk in the file', physCount === 1, `${physCount} found`)

// --- the CRC is right, checked independently of the writer -------------------------
// A bad CRC makes the chunk invalid; most viewers ignore it silently and the
// print shop is where you would find out.
const table = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()
const crcOf = (b) => {
  let c = 0xffffffff
  for (let i = 0; i < b.length; i++) c = table[(c ^ b[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}
let allCrcOk = true
for (let i = 8; i + 8 <= at300.length;) {
  const len = new DataView(at300.buffer, at300.byteOffset + i, 4).getUint32(0)
  const stated = new DataView(at300.buffer, at300.byteOffset + i + 8 + len, 4).getUint32(0)
  if (crcOf(at300.subarray(i + 4, i + 8 + len)) !== stated) allCrcOk = false
  i += 12 + len
}
check('every chunk in the stamped file still has a valid CRC', allCrcOk)

// --- it refuses to damage what it does not understand --------------------------------
const notPng = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9])
check('a non-PNG is handed back untouched', withDPI(notPng, 300) === notPng)
check('and reading one gives null, not a guess', readDPI(notPng) === null)
check('a zero resolution is a no-op', withDPI(src, 0) === src)

console.log(checks.filter(([, o]) => o).length + ' of ' + checks.length + ' passed')
process.exit(checks.some(([, ok]) => !ok) ? 1 : 0)
