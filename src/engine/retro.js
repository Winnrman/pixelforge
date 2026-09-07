// Retro looks that work straight on a pixel buffer. Everything here is
// deliberately DOM-free: the same code has to run in the render pass, in the
// export worker and in plain Node tests, so it may not touch canvas, document
// or ImageData. Anything shaped like `{ data, width, height }` is accepted.

const clamp255 = (v) => (v < 0 ? 0 : v > 255 ? 255 : v)
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v)

// Rec.601 luma. Every machine imitated below was NTSC-era, so the 601 weights
// are the historically honest ones - and they are the same weights the YCbCr
// conversion in the VHS pass uses, which keeps "luma" meaning one thing here.
const luma = (r, g, b) => 0.299 * r + 0.587 * g + 0.114 * b

const hexToRgb = (hex) => {
  const s = String(hex == null ? '#000000' : hex).replace('#', '')
  const full = s.length === 3 ? s[0] + s[0] + s[1] + s[1] + s[2] + s[2] : s
  const n = parseInt(full, 16) | 0
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

// Scratch buffers keyed by role and grown on demand. A preset can be asked to
// run sixty times a second on a full frame, so allocating per call would hand
// the GC several megabytes a second for no reason.
const pool = new Map()
function scratch(key, Type, len) {
  let b = pool.get(key)
  if (!b || b.length < len || b.constructor !== Type) {
    b = new Type(len)
    pool.set(key, b)
  }
  return b
}

// --- palettes ---------------------------------------------------------------

function makePalette(hexes) {
  const rgb = new Uint8Array(hexes.length * 3)
  for (let i = 0; i < hexes.length; i++) {
    const c = hexToRgb(hexes[i])
    rgb[i * 3] = c[0]
    rgb[i * 3 + 1] = c[1]
    rgb[i * 3 + 2] = c[2]
  }
  // Nearest-colour lookups are memoised on a 5-bit-per-channel key: 32768
  // slots of Int16, filled lazily. Two palette entries would have to sit in
  // the same 8x8x8 RGB cube for the approximation to pick a wrong colour, and
  // none of these palettes are anywhere near that dense. It turns a 54-way
  // distance search into a single array read for almost every pixel, and the
  // table is palette-scoped so it stays warm across frames.
  return { n: hexes.length, rgb, cache: new Int16Array(32768).fill(-1) }
}

function nearest(pal, r, g, b) {
  const ri = clamp255(r) | 0
  const gi = clamp255(g) | 0
  const bi = clamp255(b) | 0
  const key = ((ri & 0xf8) << 7) | ((gi & 0xf8) << 2) | (bi >> 3)
  const hit = pal.cache[key]
  if (hit >= 0) return hit
  const p = pal.rgb
  let best = 0
  let bestD = Infinity
  for (let i = 0, j = 0; i < pal.n; i++, j += 3) {
    const dr = ri - p[j]
    const dg = gi - p[j + 1]
    const db = bi - p[j + 2]
    const d = dr * dr + dg * dg + db * db
    if (d < bestD) {
      bestD = d
      best = i
    }
  }
  pal.cache[key] = best
  return best
}

// Pepto's measured VIC-II colours (pepto.de/projects/colorvic), the table VICE
// and most modern C64 tooling ship as the default palette.
const C64_HEX = [
  '#000000', '#ffffff', '#880000', '#aaffee',
  '#cc44cc', '#00cc55', '#0000aa', '#eeee77',
  '#dd8855', '#664400', '#ff7777', '#333333',
  '#777777', '#aaff66', '#0088ff', '#bbbbbb',
]

// The 2C02 NTSC table as shipped by FCEUX/Nintendulator, written as RGB
// triples. The hardware exposes 64 entries but eleven of them are black,
// "blacker than black" or exact duplicates; dropping those and adding one
// black plus the 0x2D grey back leaves the 54 distinct colours a NES can show.
const NES_RGB = [
  124, 124, 124, 0, 0, 252, 0, 0, 188, 68, 40, 188,
  148, 0, 132, 168, 0, 32, 168, 16, 0, 136, 20, 0,
  80, 48, 0, 0, 120, 0, 0, 104, 0, 0, 88, 0,
  0, 64, 88,
  188, 188, 188, 0, 120, 248, 0, 88, 248, 104, 68, 252,
  216, 0, 204, 228, 0, 88, 248, 56, 0, 228, 92, 16,
  172, 124, 0, 0, 184, 0, 0, 168, 0, 0, 168, 68,
  0, 136, 136,
  248, 248, 248, 60, 188, 252, 104, 136, 252, 152, 120, 248,
  248, 120, 248, 248, 88, 152, 248, 120, 88, 252, 160, 68,
  248, 184, 0, 184, 248, 24, 88, 216, 84, 88, 248, 152,
  0, 232, 216,
  252, 252, 252, 164, 228, 252, 184, 184, 248, 216, 184, 248,
  248, 184, 248, 248, 164, 192, 240, 208, 176, 252, 224, 168,
  248, 216, 120, 216, 248, 120, 184, 248, 184, 184, 248, 216,
  0, 252, 252,
  120, 120, 120, 0, 0, 0,
]

// The four DMG greens, darkest first. Their lumas are 39/77/144/158, i.e. very
// unevenly spaced, which is why the dithering below works on an even ramp and
// only maps to these at the very end.
const DMG_HEX = ['#0f380f', '#306230', '#8bac0f', '#9bbc0f']

const palettes = {}
const c64Palette = () => (palettes.c64 || (palettes.c64 = makePalette(C64_HEX)))
function nesPalette() {
  if (!palettes.nes) {
    const n = NES_RGB.length / 3
    palettes.nes = {
      n,
      rgb: Uint8Array.from(NES_RGB),
      cache: new Int16Array(32768).fill(-1),
    }
  }
  return palettes.nes
}
const dmgRgb = Uint8Array.from(DMG_HEX.flatMap(hexToRgb))

// Bayer 4x4, pre-centred on zero. Ordered dithering is a lookup instead of a
// feedback loop, so it is the only mode that stays stable frame to frame -
// error diffusion crawls when the image moves slightly.
const BAYER4 = Float32Array.from(
  [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5],
  (v) => (v + 0.5) / 16 - 0.5,
)

// --- presets ----------------------------------------------------------------

export const RETRO_PRESETS = [
  {
    id: 'dither1bit',
    label: '1-bit dither',
    defaults: { threshold: 128, ink: '#000000', paper: '#ffffff' },
  },
  {
    id: 'gameboy',
    label: 'Game Boy',
    defaults: { dither: 'bayer', contrast: 1 },
  },
  {
    id: 'vhs',
    label: 'VHS',
    defaults: { bleed: 6, shift: 3, scanline: 0.18, jitter: 3, jitterRows: 0.05, seed: 1 },
  },
  {
    id: 'halftone',
    label: 'Halftone',
    defaults: { cell: 6, angleOffset: 0, mono: false },
  },
  {
    id: 'c64',
    label: 'Commodore 64',
    defaults: { dither: 'bayer', strength: 0.6 },
  },
  {
    id: 'nes',
    label: 'NES',
    defaults: { dither: 'bayer', strength: 0.4 },
  },
]

/**
 * How each tunable should be presented. Kept next to the presets so a new knob
 * cannot be added without deciding what its control looks like — the Inspector
 * renders straight off this rather than guessing from the value's type.
 */
export const RETRO_CONTROLS = {
  threshold: { label: 'Threshold', min: 0, max: 255, step: 1 },
  ink: { label: 'Ink', color: true },
  paper: { label: 'Paper', color: true },
  dither: { label: 'Dither', options: ['none', 'bayer', 'fs'] },
  contrast: { label: 'Contrast', min: 0.2, max: 3, step: 0.05 },
  bleed: { label: 'Chroma bleed', min: 0, max: 24, step: 1, suffix: 'px' },
  shift: { label: 'Chroma shift', min: -16, max: 16, step: 1, suffix: 'px' },
  scanline: { label: 'Scanlines', min: 0, max: 0.8, step: 0.01 },
  jitter: { label: 'Line jitter', min: 0, max: 20, step: 1, suffix: 'px' },
  jitterRows: { label: 'Jittery rows', min: 0, max: 0.4, step: 0.01 },
  seed: { label: 'Noise seed', min: 1, max: 999, step: 1 },
  cell: { label: 'Dot size', min: 2, max: 32, step: 1, suffix: 'px' },
  angleOffset: { label: 'Screen angle', min: 0, max: 90, step: 1, suffix: '°' },
  mono: { label: 'Single screen', bool: true },
  strength: { label: 'Dither strength', min: 0, max: 1, step: 0.05 },
}

export const retroDefaults = (id) => {
  const p = RETRO_PRESETS.find((x) => x.id === id)
  return p ? { ...p.defaults } : null
}

// --- 1-bit Floyd-Steinberg --------------------------------------------------

function ditherOneBit(d, w, h, o) {
  const ink = hexToRgb(o.ink)
  const paper = hexToRgb(o.paper)
  // Diffuse against the luma of the *actual* ink and paper, not 0 and 255.
  // That is what keeps the mean brightness of the output equal to the input
  // even when the two colours are, say, dark blue on cream.
  const li = luma(ink[0], ink[1], ink[2])
  const lp = luma(paper[0], paper[1], paper[2])
  const t = o.threshold == null ? 128 : o.threshold
  let a = scratch('err1a', Float32Array, w + 2)
  let b = scratch('err1b', Float32Array, w + 2)
  a.fill(0, 0, w + 2)
  b.fill(0, 0, w + 2)

  for (let y = 0; y < h; y++) {
    // Serpentine order: alternating the scan direction stops the error trail
    // from lining up into diagonal "worms" down the image.
    const ltr = (y & 1) === 0
    const dx = ltr ? 1 : -1
    const row = y * w
    for (let k = 0; k < w; k++) {
      const x = ltr ? k : w - 1 - k
      const i = (row + x) * 4
      const v = luma(d[i], d[i + 1], d[i + 2]) + a[x + 1]
      const useInk = v < t
      const e = v - (useInk ? li : lp)
      a[x + 1 + dx] += e * 0.4375
      b[x + 1 - dx] += e * 0.1875
      b[x + 1] += e * 0.3125
      b[x + 1 + dx] += e * 0.0625
      const c = useInk ? ink : paper
      d[i] = c[0]
      d[i + 1] = c[1]
      d[i + 2] = c[2]
    }
    const t2 = a
    a = b
    b = t2
    b.fill(0, 0, w + 2)
  }
}

// --- Game Boy ---------------------------------------------------------------

function gameboy(d, w, h, o) {
  const mode = o.dither || 'bayer'
  const contrast = o.contrast == null ? 1 : o.contrast
  // Quantise on an even 0/85/170/255 ramp and only then look up the DMG green.
  // Diffusing error against the real greens would bias the pattern badly,
  // because the two light greens are 14 luma apart and the gap to the darkest
  // is 105.
  const step = 255 / 3
  const put = (i, lvl) => {
    const j = lvl * 3
    d[i] = dmgRgb[j]
    d[i + 1] = dmgRgb[j + 1]
    d[i + 2] = dmgRgb[j + 2]
  }
  const shape = (r, g, b) => clamp255((luma(r, g, b) - 128) * contrast + 128)

  if (mode === 'fs') {
    let a = scratch('errGa', Float32Array, w + 2)
    let b = scratch('errGb', Float32Array, w + 2)
    a.fill(0, 0, w + 2)
    b.fill(0, 0, w + 2)
    for (let y = 0; y < h; y++) {
      const ltr = (y & 1) === 0
      const dx = ltr ? 1 : -1
      const row = y * w
      for (let k = 0; k < w; k++) {
        const x = ltr ? k : w - 1 - k
        const i = (row + x) * 4
        const v = shape(d[i], d[i + 1], d[i + 2]) + a[x + 1]
        let lvl = Math.round(v / step)
        lvl = lvl < 0 ? 0 : lvl > 3 ? 3 : lvl
        const e = v - lvl * step
        a[x + 1 + dx] += e * 0.4375
        b[x + 1 - dx] += e * 0.1875
        b[x + 1] += e * 0.3125
        b[x + 1 + dx] += e * 0.0625
        put(i, lvl)
      }
      const t2 = a
      a = b
      b = t2
      b.fill(0, 0, w + 2)
    }
    return
  }

  const bayer = mode === 'bayer'
  for (let y = 0; y < h; y++) {
    const row = y * w
    const by = (y & 3) * 4
    for (let x = 0; x < w; x++) {
      const i = (row + x) * 4
      let v = shape(d[i], d[i + 1], d[i + 2])
      if (bayer) v += BAYER4[by + (x & 3)] * step
      let lvl = Math.round(v / step)
      lvl = lvl < 0 ? 0 : lvl > 3 ? 3 : lvl
      put(i, lvl)
    }
  }
}

// --- palette quantisers (C64, NES) ------------------------------------------

function paletteQuantize(d, w, h, pal, mode, strength) {
  const p = pal.rgb
  if (mode === 'fs') {
    // Error diffusion in RGB: three interleaved channels per row buffer.
    let a = scratch('errPa', Float32Array, (w + 2) * 3)
    let b = scratch('errPb', Float32Array, (w + 2) * 3)
    a.fill(0, 0, (w + 2) * 3)
    b.fill(0, 0, (w + 2) * 3)
    for (let y = 0; y < h; y++) {
      const ltr = (y & 1) === 0
      const dx = ltr ? 3 : -3
      const row = y * w
      for (let k = 0; k < w; k++) {
        const x = ltr ? k : w - 1 - k
        const i = (row + x) * 4
        const c = (x + 1) * 3
        const r = d[i] + a[c]
        const g = d[i + 1] + a[c + 1]
        const bl = d[i + 2] + a[c + 2]
        const idx = nearest(pal, r, g, bl) * 3
        const er = r - p[idx]
        const eg = g - p[idx + 1]
        const eb = bl - p[idx + 2]
        for (let ch = 0; ch < 3; ch++) {
          const e = ch === 0 ? er : ch === 1 ? eg : eb
          a[c + dx + ch] += e * 0.4375
          b[c - dx + ch] += e * 0.1875
          b[c + ch] += e * 0.3125
          b[c + dx + ch] += e * 0.0625
        }
        d[i] = p[idx]
        d[i + 1] = p[idx + 1]
        d[i + 2] = p[idx + 2]
      }
      const t2 = a
      a = b
      b = t2
      b.fill(0, 0, (w + 2) * 3)
    }
    return
  }

  // Ordered dithering nudges the colour before the lookup, so neighbouring
  // pixels land on different palette entries and the eye mixes them. The
  // amplitude is in 8-bit units; ~40 is roughly half a step of these palettes.
  const amp = mode === 'bayer' ? (strength == null ? 0.5 : strength) * 80 : 0
  for (let y = 0; y < h; y++) {
    const row = y * w
    const by = (y & 3) * 4
    for (let x = 0; x < w; x++) {
      const i = (row + x) * 4
      const t = amp ? BAYER4[by + (x & 3)] * amp : 0
      const idx = nearest(pal, d[i] + t, d[i + 1] + t, d[i + 2] + t) * 3
      d[i] = p[idx]
      d[i + 1] = p[idx + 1]
      d[i + 2] = p[idx + 2]
    }
  }
}

// --- VHS --------------------------------------------------------------------

// Deterministic PRNG (mulberry32) so a given seed always produces the same
// dropout rows; the caller bumps the seed per frame to make it move.
function rng(seed) {
  let s = (seed | 0) + 0x6d2b79f5
  return () => {
    s = (s + 0x6d2b79f5) | 0
    let t = Math.imul(s ^ (s >>> 15), 1 | s)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function vhs(d, w, h, o) {
  const n = w * h
  const Y = scratch('vhsY', Float32Array, n)
  const Cb = scratch('vhsCb', Float32Array, n)
  const Cr = scratch('vhsCr', Float32Array, n)
  const tmp = scratch('vhsRow', Float32Array, w * 3)

  for (let i = 0, j = 0; i < n; i++, j += 4) {
    const r = d[j]
    const g = d[j + 1]
    const b = d[j + 2]
    Y[i] = 0.299 * r + 0.587 * g + 0.114 * b
    Cb[i] = -0.168736 * r - 0.331264 * g + 0.5 * b
    Cr[i] = 0.5 * r - 0.418688 * g - 0.081312 * b
  }

  // Composite video gives chroma about a tenth of the luma bandwidth, and tape
  // narrows it further. Blurring *only* Cb/Cr - never Y - is the whole trick:
  // the picture stays sharp while the colour smears, which is exactly what a
  // worn VHS looks like.
  const bleed = Math.max(0, Math.round(o.bleed || 0))
  const shift = Math.round(o.shift || 0)
  if (bleed > 0 || shift !== 0) {
    const span = bleed * 2 + 1
    for (let y = 0; y < h; y++) {
      const row = y * w
      for (let c = 0; c < 2; c++) {
        const src = c === 0 ? Cb : Cr
        // Running-sum box blur: one add and one subtract per pixel regardless
        // of radius, which matters because bleed is often 8+ px.
        let sum = 0
        for (let k = -bleed; k <= bleed; k++) {
          sum += src[row + (k < 0 ? 0 : k > w - 1 ? w - 1 : k)]
        }
        for (let x = 0; x < w; x++) {
          tmp[x] = sum / span
          const add = x + bleed + 1
          const sub = x - bleed
          sum += src[row + (add > w - 1 ? w - 1 : add)]
          sum -= src[row + (sub < 0 ? 0 : sub)]
        }
        // Chroma delay: the offset is applied on the way back so the blur and
        // the shift cost one pass together.
        for (let x = 0; x < w; x++) {
          const sx = x - shift
          src[row + x] = tmp[sx < 0 ? 0 : sx > w - 1 ? w - 1 : sx]
        }
      }
    }
  }

  // Head-switching / time-base error: a handful of whole lines slip sideways.
  // The slip takes luma with it because a real head shifts the entire line;
  // it only touches a few per cent of rows, so the picture still reads sharp.
  const jitter = Math.round(o.jitter || 0)
  const rows = clamp01(o.jitterRows == null ? 0 : o.jitterRows)
  if (jitter > 0 && rows > 0) {
    const rand = rng(o.seed == null ? 1 : o.seed)
    for (let y = 0; y < h; y++) {
      const roll = rand()
      const amt = Math.round((rand() * 2 - 1) * jitter)
      if (roll >= rows || amt === 0) continue
      const row = y * w
      for (let x = 0; x < w; x++) {
        tmp[x] = Y[row + x]
        tmp[w + x] = Cb[row + x]
        tmp[w * 2 + x] = Cr[row + x]
      }
      for (let x = 0; x < w; x++) {
        const sx = x - amt
        const c = sx < 0 ? 0 : sx > w - 1 ? w - 1 : sx
        Y[row + x] = tmp[c]
        Cb[row + x] = tmp[w + c]
        Cr[row + x] = tmp[w * 2 + c]
      }
    }
  }

  // Interlaced field gaps: darken every second line.
  const scan = clamp01(o.scanline == null ? 0 : o.scanline)
  if (scan > 0) {
    const k = 1 - scan
    for (let y = 1; y < h; y += 2) {
      const row = y * w
      for (let x = 0; x < w; x++) Y[row + x] *= k
    }
  }

  for (let i = 0, j = 0; i < n; i++, j += 4) {
    const y = Y[i]
    const cb = Cb[i]
    const cr = Cr[i]
    d[j] = clamp255(y + 1.402 * cr)
    d[j + 1] = clamp255(y - 0.344136 * cb - 0.714136 * cr)
    d[j + 2] = clamp255(y + 1.772 * cb)
  }
}

// --- halftone ---------------------------------------------------------------

// Classic process-camera screen angles. Keeping the screens 30 degrees apart
// (and yellow, the weakest ink, on the axis) is what stops the four dot grids
// from beating against each other into a moire rosette that reads as mud.
const SCREENS = [
  { ch: 0, angle: 15 },
  { ch: 1, angle: 75 },
  { ch: 2, angle: 0 },
  { ch: 3, angle: 45 },
]

function halftone(d, w, h, o) {
  const cell = Math.max(2, o.cell || 6)
  const off = ((o.angleOffset || 0) * Math.PI) / 180
  const mono = !!o.mono
  const n = w * h * 4
  // The screens sample the original while writing over it, so the source has
  // to be kept. This is the one preset that needs a full copy.
  const src = scratch('htSrc', Uint8ClampedArray, n)
  src.set(d.subarray ? d.subarray(0, n) : d)

  for (let i = 0; i < n; i += 4) {
    d[i] = 255
    d[i + 1] = 255
    d[i + 2] = 255
  }

  const screens = mono ? [{ ch: 3, angle: 45 }] : SCREENS
  for (let s = 0; s < screens.length; s++) {
    const ch = screens[s].ch
    const a = (screens[s].angle * Math.PI) / 180 + off
    const cs = Math.cos(a)
    const sn = Math.sin(a)
    // Walk the dot grid in screen space, which means covering the image's
    // bounding box transformed *into* that rotated space.
    let u0 = Infinity
    let u1 = -Infinity
    let v0 = Infinity
    let v1 = -Infinity
    for (let c = 0; c < 4; c++) {
      const px = c & 1 ? w : 0
      const py = c & 2 ? h : 0
      const u = px * cs + py * sn
      const v = -px * sn + py * cs
      if (u < u0) u0 = u
      if (u > u1) u1 = u
      if (v < v0) v0 = v
      if (v > v1) v1 = v
    }
    const i0 = Math.floor(u0 / cell) - 1
    const i1 = Math.ceil(u1 / cell) + 1
    const j0 = Math.floor(v0 / cell) - 1
    const j1 = Math.ceil(v1 / cell) + 1

    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const u = (i + 0.5) * cell
        const v = (j + 0.5) * cell
        const px = u * cs - v * sn
        const py = u * sn + v * cs
        const sx = Math.round(px) < 0 ? 0 : Math.round(px) > w - 1 ? w - 1 : Math.round(px)
        const sy = Math.round(py) < 0 ? 0 : Math.round(py) > h - 1 ? h - 1 : Math.round(py)
        const si = (sy * w + sx) * 4
        const r = src[si] / 255
        const g = src[si + 1] / 255
        const b = src[si + 2] / 255
        let cov
        if (mono) {
          cov = 1 - luma(r, g, b)
        } else {
          const k = 1 - Math.max(r, g, b)
          const inv = 1 - k
          if (ch === 3) cov = k
          else if (inv < 1e-6) cov = 0
          else cov = ((ch === 0 ? 1 - r : ch === 1 ? 1 - g : 1 - b) - k) / inv
        }
        cov = clamp01(cov)
        if (cov <= 0.002) continue
        // Area-true radius: a disc of pi*r^2 inside a cell of cell^2 gives
        // exactly `cov` ink as long as neighbouring dots do not touch, which
        // holds below ~78%. Past 90% the discs are ramped out to the cell's
        // half-diagonal so a solid black actually prints solid instead of
        // leaving the four corner gaps of a tangent-circle packing.
        let rad = Math.sqrt(cov / Math.PI)
        if (cov > 0.9) rad += (cov - 0.9) * 10 * (0.7072 - rad)
        rad *= cell
        const y0 = Math.max(0, Math.ceil(py - rad - 1))
        const y1 = Math.min(h - 1, Math.floor(py + rad + 1))
        const x0 = Math.max(0, Math.ceil(px - rad - 1))
        const x1 = Math.min(w - 1, Math.floor(px + rad + 1))
        for (let y = y0; y <= y1; y++) {
          const dy = y - py
          const row = y * w
          for (let x = x0; x <= x1; x++) {
            const dxp = x - px
            // Analytic coverage: distance to the edge, clamped to one pixel.
            // Cheaper than supersampling and smooth enough that the 50% patch
            // measures 50% ink rather than a staircase of it.
            const cvg = rad + 0.5 - Math.sqrt(dxp * dxp + dy * dy)
            if (cvg <= 0) continue
            const m = 1 - (cvg > 1 ? 1 : cvg)
            const q = (row + x) * 4
            if (ch === 3) {
              d[q] *= m
              d[q + 1] *= m
              d[q + 2] *= m
            } else {
              d[q + ch] *= m
            }
          }
        }
      }
    }
  }
}

// --- entry point ------------------------------------------------------------

/**
 * Applies a retro look to `imageData` **in place** and returns the same object.
 * `preset` is a preset id (or a preset object); `opts` overrides that preset's
 * defaults for this call. Alpha is never touched, so a masked or feathered
 * layer keeps its edge. Unknown ids are a no-op so a stale project file cannot
 * break a render.
 */
export function applyRetro(imageData, preset, opts) {
  const id = typeof preset === 'string' ? preset : preset && preset.id
  const p = RETRO_PRESETS.find((x) => x.id === id)
  if (!p || !imageData) return imageData
  const w = imageData.width | 0
  const h = imageData.height | 0
  const d = imageData.data
  if (w <= 0 || h <= 0 || !d) return imageData
  const o = { ...p.defaults, ...opts }

  switch (id) {
    case 'dither1bit':
      ditherOneBit(d, w, h, o)
      break
    case 'gameboy':
      gameboy(d, w, h, o)
      break
    case 'c64':
      paletteQuantize(d, w, h, c64Palette(), o.dither || 'none', o.strength)
      break
    case 'nes':
      paletteQuantize(d, w, h, nesPalette(), o.dither || 'none', o.strength)
      break
    case 'vhs':
      vhs(d, w, h, o)
      break
    case 'halftone':
      halftone(d, w, h, o)
      break
    default:
      break
  }
  return imageData
}
