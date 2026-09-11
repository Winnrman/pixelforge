// Watermarks, on pictures made of numbers.
//
// The fixture is a photograph-like picture — a gradient, soft coloured
// shapes, grain — with a mark stamped over it on a slanted grid: a short word
// of strokes, tilted, forty per cent white. Every number about the mark is
// known, so the search is judged on whether it finds *those* numbers, and the
// removal on how close it gets to the picture without the mark.
import { fft } from '../../src/engine/fft.js'
import {
  detectWatermark, deblend, tileOf, unpackAlpha, toStored, fromStored, autocorrelation, featureOf,
  downscale,
} from '../../src/engine/watermark.js'

const checks = []
const check = (name, ok, detail = '') => {
  checks.push([name, ok])
  console.log((ok ? 'PASS  ' : 'FAIL  ') + name + (detail ? '  — ' + detail : ''))
}

function rng(seed) {
  let s = seed >>> 0
  return () => ((s = (Math.imul(s, 1103515245) + 12345) >>> 0) / 4294967296)
}

function photo(w, h, seed = 3) {
  const r = rng(seed)
  const blobs = Array.from({ length: 45 }, () => ({
    x: r() * w, y: r() * h, rad: 15 + r() * 80, col: [r() * 255, r() * 255, r() * 255], k: 0.5 + r() * 0.5,
  }))
  const d = new Uint8ClampedArray(w * h * 4)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let c = [60 + (120 * x) / w, 80 + (60 * y) / h, 150 - (70 * x) / w]
      for (const b of blobs) {
        const dd = ((x - b.x) ** 2 + (y - b.y) ** 2) / (2 * b.rad * b.rad)
        if (dd > 6) continue
        const t = Math.exp(-dd) * b.k
        c = c.map((v, i) => v * (1 - t) + b.col[i] * t)
      }
      const p = (y * w + x) * 4
      for (let i = 0; i < 3; i++) d[p + i] = c[i] + (r() - 0.5) * 16
      d[p + 3] = 255
    }
  }
  return d
}

/**
 * One copy of the mark: five letter-ish shapes of strokes, turned by `deg`,
 * rasterised with 4x4 supersampling so its edges are soft the way type is.
 * Returns the copy's opacity on a grid centred on the copy.
 */
function markTile(deg, R = 48) {
  const th = (deg * Math.PI) / 180
  const rects = []
  for (let i = 0; i < 5; i++) {
    const u0 = -40 + i * 17
    rects.push([u0, -8, 3, 16])
    rects.push([u0, -8, 10, 3])
    if (i % 2) rects.push([u0, -1, 8, 3])
    else rects.push([u0, 5, 10, 3])
  }
  const size = R * 2 + 1
  const tile = new Float32Array(size * size)
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let hit = 0
      for (let sy = 0; sy < 4; sy++) {
        for (let sx = 0; sx < 4; sx++) {
          const X = x - R + (sx + 0.5) / 4 - 0.5
          const Y = y - R + (sy + 0.5) / 4 - 0.5
          // Back into the word's own frame.
          const u = X * Math.cos(th) + Y * Math.sin(th)
          const v = -X * Math.sin(th) + Y * Math.cos(th)
          if (rects.some(([a, b, cw, ch]) => u >= a && u < a + cw && v >= b && v < b + ch)) hit++
        }
      }
      tile[y * size + x] = hit / 16
    }
  }
  return { tile, size, R }
}

/** Stamps the mark over a picture on the grid v1, v2 from o; returns where it went. */
function stamp(d, w, h, { v1, v2, o, deg, opacity, colour = 255 }) {
  const { tile, size, R } = markTile(deg)
  const truth = new Float32Array(w * h)
  let inside = 0
  for (let n = -12; n <= 12; n++) {
    for (let m = -12; m <= 12; m++) {
      const cx = o[0] + m * v1[0] + n * v2[0]
      const cy = o[1] + m * v1[1] + n * v2[1]
      if (cx < -R || cy < -R || cx > w + R || cy > h + R) continue
      if (cx >= 0 && cx < w && cy >= 0 && cy < h) inside++
      for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
          const a = tile[y * size + x]
          if (!a) continue
          const X = cx - R + x
          const Y = cy - R + y
          if (X < 0 || Y < 0 || X >= w || Y >= h) continue
          truth[Y * w + X] = a * opacity
        }
      }
    }
  }
  for (let i = 0; i < w * h; i++) {
    const a = truth[i]
    if (!a) continue
    for (let c = 0; c < 3; c++) d[i * 4 + c] = d[i * 4 + c] * (1 - a) + colour * a
  }
  return { truth, inside }
}

function errorOver(a, b, where, w, h) {
  let s = 0
  let n = 0
  let visible = 0
  for (let i = 0; i < w * h; i++) {
    if (!where(i)) continue
    const e = (Math.abs(a[i * 4] - b[i * 4]) + Math.abs(a[i * 4 + 1] - b[i * 4 + 1]) + Math.abs(a[i * 4 + 2] - b[i * 4 + 2])) / 3
    s += e
    n++
    if (e > 24) visible++
  }
  return { mean: n ? s / n : 0, visible, n }
}

// --- the FFT ---------------------------------------------------------------------
{
  const r = rng(1)
  const n = 16
  const re = Float64Array.from({ length: n }, () => r() - 0.5)
  const im = Float64Array.from({ length: n }, () => r() - 0.5)
  const want = []
  for (let k = 0; k < n; k++) {
    let sr = 0
    let si = 0
    for (let t = 0; t < n; t++) {
      const a = (-2 * Math.PI * k * t) / n
      sr += re[t] * Math.cos(a) - im[t] * Math.sin(a)
      si += re[t] * Math.sin(a) + im[t] * Math.cos(a)
    }
    want.push([sr, si])
  }
  const fr = re.slice()
  const fi = im.slice()
  fft(fr, fi)
  const worst = Math.max(...want.map(([a, b], k) => Math.hypot(a - fr[k], b - fi[k])))
  check('the FFT agrees with the definition', worst < 1e-9, String(worst))
  fft(fr, fi, true)
  const back = Math.max(...[...re].map((v, k) => Math.abs(v - fr[k])))
  check('and undoes itself', back < 1e-12, String(back))
}

// --- a picture repeats where it repeats -------------------------------------------
{
  const w = 120
  const h = 90
  const g = new Float32Array(w * h)
  const r = rng(4)
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) g[y * w + x] = ((x % 20) < 3 ? 200 : 60) + r() * 30
  const ac = autocorrelation(featureOf(g, w, h), w, h)
  check('stripes every 20 pixels correlate at 20', ac(20, 0) > ac(10, 0) + 0.3 && ac(20, 0) > 0.5,
    `${ac(20, 0).toFixed(2)} at 20, ${ac(10, 0).toFixed(2)} at 10`)
}

// --- finding the mark ----------------------------------------------------------------
const W = 600
const H = 400
const clean = photo(W, H)
const marked = clean.slice()
const truthGrid = { v1: [110, 0], v2: [55, 70], o: [37, 29], deg: -25, opacity: 0.4 }
const { truth, inside } = stamp(marked, W, H, truthGrid)
const found = await detectWatermark(marked, W, H)
console.log('found:', JSON.stringify({ ...found, alpha: undefined }))
check('a repeated mark is found', found.ok === true, found.reason || '')

if (found.ok) {
  // The same grid however it is written: each true step is a whole number of
  // found steps, and the tiles are the same size.
  const cell = tileOf(found)
  const inFound = (v) => {
    const a = cell.i00 * v[0] + cell.i01 * v[1]
    const b = cell.i10 * v[0] + cell.i11 * v[1]
    return Math.max(Math.abs(a - Math.round(a)), Math.abs(b - Math.round(b)))
  }
  const areaTrue = Math.abs(110 * 70 - 0 * 55)
  const areaFound = Math.abs(found.v1[0] * found.v2[1] - found.v1[1] * found.v2[0])
  check('on the grid it was stamped on', inFound(truthGrid.v1) < 0.03 && inFound(truthGrid.v2) < 0.03
    && Math.abs(areaFound - areaTrue) < areaTrue * 0.02,
  `off by ${inFound(truthGrid.v1).toFixed(3)}, ${inFound(truthGrid.v2).toFixed(3)}; area ${areaFound.toFixed(0)} vs ${areaTrue}`)
  check('white', found.color.every((c) => c >= 225), JSON.stringify(found.color))
  const peak = Math.max(...found.alpha)
  check('as faint as it was laid on', Math.abs(peak - 0.4) < 0.08, peak.toFixed(3))
  check('turned the way it was turned', Math.abs(found.angle - truthGrid.deg) < 4, `${found.angle}°`)
  check('and counted', Math.abs(found.count - inside) <= 2, `${found.count} found, ${inside} placed`)

  // --- and taking it off ---------------------------------------------------------------
  const out = marked.slice()
  deblend(out, W, H, found)
  const on = (i) => truth[i] > 0.02
  const off = (i) => truth[i] === 0
  const before = errorOver(marked, clean, on, W, H)
  const after = errorOver(out, clean, on, W, H)
  const around = errorOver(out, clean, off, W, H)
  console.log(`  under the mark: ${before.mean.toFixed(2)} -> ${after.mean.toFixed(2)}; visible ${before.visible} -> ${after.visible}; around ${around.mean.toFixed(3)}`)
  check('taking it off brings back the picture under it', after.mean < before.mean * 0.2,
    `${before.mean.toFixed(2)} -> ${after.mean.toFixed(2)}`)
  check('with next to nothing of it left to see', after.visible < before.visible * 0.03,
    `${before.visible} -> ${after.visible} visibly-off pixels`)
  check('and the rest of the picture barely touched', around.mean < 1, around.mean.toFixed(3))

  // Stored small and read back the same.
  const stored = toStored(found, 1, 1)
  const back = unpackAlpha(stored.alpha)
  check('the mark is stored as a short string', stored.alpha.length < found.alpha.length / 2,
    `${stored.alpha.length} chars for ${found.alpha.length} points`)
  check('and read back to within a level', back.length === found.alpha.length
    && back.every((v, i) => Math.abs(v - found.alpha[i]) <= 0.5 / 255 + 1e-6))

  // The same mark at twice the size: the grid is in pixels, the tile in
  // fractions of itself, so the stored mark takes itself off a bigger copy.
  const big = new Uint8ClampedArray(W * 2 * H * 2 * 4)
  const bigClean = new Uint8ClampedArray(W * 2 * H * 2 * 4)
  for (let y = 0; y < H * 2; y++) {
    for (let x = 0; x < W * 2; x++) {
      const s = ((y >> 1) * W + (x >> 1)) * 4
      const t = (y * W * 2 + x) * 4
      for (let c = 0; c < 4; c++) { big[t + c] = marked[s + c]; bigClean[t + c] = clean[s + c] }
    }
  }
  // Found in the small copy, so one pixel of the big one spans half of one there.
  deblend(big, W * 2, H * 2, fromStored(toStored(found, 0.5, 0.5)))
  const bigTruth = (i) => {
    const x = i % (W * 2)
    const y = Math.floor(i / (W * 2))
    return truth[(y >> 1) * W + (x >> 1)] > 0.02
  }
  const bigAfter = errorOver(big, bigClean, bigTruth, W * 2, H * 2)
  check('the stored mark takes itself off the picture at any size', bigAfter.mean < before.mean * 0.3,
    bigAfter.mean.toFixed(2))
}

// --- a grid that is not a whole number of pixels -----------------------------------------
// Real marks are laid on at one size and the picture is then resized, so the
// step between copies is 80.3 pixels, not 80. Shrinking the fixture does that.
{
  const s = 0.73
  const sm = downscale(marked, W, H, Math.round(W * s))
  const cl = downscale(clean, W, H, Math.round(W * s))
  const tr = downscale(Uint8ClampedArray.from(truth, (v) => v * 255).reduce((a, v, i) => {
    a[i * 4] = v
    a[i * 4 + 3] = 255
    return a
  }, new Uint8ClampedArray(W * H * 4)), W, H, Math.round(W * s))
  const f2 = await detectWatermark(sm.data, sm.w, sm.h)
  check('a grid a fraction of a pixel off whole is found too', f2.ok === true, f2.reason || '')
  if (f2.ok) {
    const out = sm.data.slice()
    deblend(out, sm.w, sm.h, f2)
    const on = (i) => tr.data[i * 4] > 8
    const b = errorOver(sm.data, cl.data, on, sm.w, sm.h)
    const a = errorOver(out, cl.data, on, sm.w, sm.h)
    console.log(`  resized: under the mark ${b.mean.toFixed(2)} -> ${a.mean.toFixed(2)}; visible ${b.visible} -> ${a.visible}`)
    check('and taken off nearly as well', a.mean < b.mean * 0.3, `${b.mean.toFixed(2)} -> ${a.mean.toFixed(2)}`)
  }
}

// --- copies that are not on a grid, over a busy photograph ---------------------------------
// Proof marks are often laid by hand or jittered: the gaps between copies
// disagree, and no grid fits. Over a textured photograph — ridges, cloud —
// the texture also swamps the repetition. Both at once is what a real proof
// looks like.
{
  const w = 480
  const h = 560
  const busy = photo(w, h, 21)
  const r = rng(33)
  // Texture at three scales, the way terrain and cloud have it.
  const noise = (s) => {
    const cw = Math.ceil(w / s) + 2
    const ch = Math.ceil(h / s) + 2
    const g = Float32Array.from({ length: cw * ch }, () => r() - 0.5)
    return (x, y) => {
      const gx = x / s
      const gy = y / s
      const x0 = Math.floor(gx)
      const y0 = Math.floor(gy)
      const fx = gx - x0
      const fy = gy - y0
      const at = (i, j) => g[(y0 + j) * cw + x0 + i]
      return (at(0, 0) * (1 - fx) + at(1, 0) * fx) * (1 - fy) + (at(0, 1) * (1 - fx) + at(1, 1) * fx) * fy
    }
  }
  const n1 = noise(2)
  const n2 = noise(6)
  const n3 = noise(18)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const t = 70 * n1(x, y) + 90 * n2(x, y) + 110 * n3(x, y)
      const p = (y * w + x) * 4
      for (let c = 0; c < 3; c++) busy[p + c] += t
    }
  }
  const cleanBusy = busy.slice()
  // Copies where a person put them: roughly a slanted grid, never exactly.
  const spots = [[190, 40], [360, 95], [75, 150], [250, 185], [150, 290], [330, 300], [40, 380],
    [270, 410], [165, 470], [400, 500], [60, 540], [230, 600], [445, 210]]
  const { tile, size, R } = markTile(-30)
  const truthB = new Float32Array(w * h)
  let inside = 0
  for (const [cx, cy] of spots) {
    if (cx >= 0 && cx < w && cy >= 0 && cy < h) inside++
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const a = tile[y * size + x]
        if (!a) continue
        const X = cx - R + x
        const Y = cy - R + y
        if (X < 0 || Y < 0 || X >= w || Y >= h) continue
        truthB[Y * w + X] = a * 0.6
      }
    }
  }
  for (let i = 0; i < w * h; i++) {
    const a = truthB[i]
    if (a) for (let c = 0; c < 3; c++) busy[i * 4 + c] = busy[i * 4 + c] * (1 - a) + 255 * a
  }
  const fb = await detectWatermark(busy, w, h)
  console.log('scattered:', JSON.stringify({ ...fb, alpha: undefined, shade: fb.shade ? 'yes' : 'no', offsets: fb.offsets?.length }))
  check('copies scattered off any grid, over a busy photograph, are found', fb.ok === true, `${fb.reason || fb.mode}`)
  if (fb.ok) {
    check('as copies, one by one', fb.mode === 'copies', fb.mode)
    check('every one of them', Math.abs(fb.count - inside) <= 1, `${fb.count} found, ${inside} placed`)
    check('turned the way they were turned', Math.abs(fb.angle + 30) < 5, `${fb.angle}°`)
    const out = busy.slice()
    deblend(out, w, h, fb)
    const on = (i) => truthB[i] > 0.05
    const b = errorOver(busy, cleanBusy, on, w, h)
    const a = errorOver(out, cleanBusy, on, w, h)
    const off = errorOver(out, cleanBusy, (i) => truthB[i] === 0, w, h)
    console.log(`  scattered: under the mark ${b.mean.toFixed(2)} -> ${a.mean.toFixed(2)}; visible ${b.visible} -> ${a.visible}; around ${off.mean.toFixed(3)}`)
    check('and taken off every copy', a.mean < b.mean * 0.3 && a.visible < b.visible * 0.1,
      `${b.mean.toFixed(2)} -> ${a.mean.toFixed(2)}, visible ${b.visible} -> ${a.visible}`)
    check('without touching the rest of the picture', off.mean < 1, off.mean.toFixed(3))
  }
}

// --- a mark in two colours ----------------------------------------------------------------
// White letters with a dark shadow a couple of pixels down and right, so they
// show on white sky as well as dark ground. Read as one colour, the shadow is
// left behind: a dark ghost of every letter.
{
  const w = 600
  const h = 400
  const base = photo(w, h, 44)
  const cleanS = base.slice()
  const grid = { v1: [110, 0], v2: [55, 70], o: [37, 29], deg: -25 }
  const shadowAt = { ...grid, o: [grid.o[0] + 2, grid.o[1] + 2], opacity: 0.45, colour: 0 }
  const { truth: shadowTruth } = stamp(base, w, h, shadowAt)
  const { truth: letterTruth } = stamp(base, w, h, { ...grid, opacity: 0.55 })
  const fs2 = await detectWatermark(base, w, h)
  console.log('two colours:', JSON.stringify({ ...fs2, alpha: undefined, shade: fs2.shade ? 'yes' : 'no', offsets: fs2.offsets?.length }))
  check('a mark with a shadow is found', fs2.ok === true, fs2.reason || '')
  if (fs2.ok) {
    check('in both its colours', !!fs2.shade && fs2.color[0] > 200 && fs2.shadeColor[0] < 60,
      `${JSON.stringify(fs2.color)} / ${JSON.stringify(fs2.shadeColor)}`)
    const out = base.slice()
    deblend(out, w, h, fs2)
    const on = (i) => shadowTruth[i] > 0.05 || letterTruth[i] > 0.05
    const b = errorOver(base, cleanS, on, w, h)
    const a = errorOver(out, cleanS, on, w, h)
    console.log(`  two colours: under the mark ${b.mean.toFixed(2)} -> ${a.mean.toFixed(2)}; visible ${b.visible} -> ${a.visible}`)
    check('and both come off, the shadow with the letters', a.mean < b.mean * 0.2 && a.visible < b.visible * 0.05,
      `${b.mean.toFixed(2)} -> ${a.mean.toFixed(2)}, visible ${b.visible} -> ${a.visible}`)
    const kept = fromStored(toStored(fs2))
    check('and the shade is kept with the mark', !!kept.shade && kept.shade.length === fs2.shade.length)
  }
}

// --- nothing it cannot account for is changed ------------------------------------------
{
  // A mark read wrong must not paint pixels black: a pixel darker than the
  // mark could have left anything is outside what the mark explains.
  const w = 20
  const h = 20
  const px = new Uint8ClampedArray(w * h * 4).fill(10)
  for (let i = 3; i < px.length; i += 4) px[i] = 255
  const model = { box: [0, 0, w, h], offsets: [[0, 0]], alpha: new Float32Array(w * h).fill(0.5), color: [255, 255, 255] }
  deblend(px, w, h, model)
  check('a pixel the mark cannot explain is left alone, not pushed to black', px[0] === 10, String(px[0]))
}

// --- and where there is nothing to find -------------------------------------------------
{
  const plain = await detectWatermark(clean, W, H)
  check('a picture with no mark on it has none found', plain.ok === false, `${plain.reason} (${(plain.strength || 0).toFixed(3)})`)

  // A pattern that *is* the picture — a tiled floor — repeats as well as any
  // watermark. It must be left alone, not "removed".
  const tiles = new Uint8ClampedArray(W * H * 4)
  const r = rng(8)
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const grout = x % 48 < 4 || y % 48 < 4
      const p = (y * W + x) * 4
      const v = grout ? 70 : 190
      tiles[p] = v + (r() - 0.5) * 12
      tiles[p + 1] = v - 10 + (r() - 0.5) * 12
      tiles[p + 2] = v - 30 + (r() - 0.5) * 12
      tiles[p + 3] = 255
    }
  }
  const floor = await detectWatermark(tiles, W, H)
  check('a tiled floor is a pattern in the picture, not a mark on it', floor.ok === false, floor.reason)

  const again = await detectWatermark(marked, W, H)
  check('the same picture is read the same way every time',
    again.ok && again.v1.join() === found.v1.join() && again.alpha.every((v, i) => v === found.alpha[i]))
}

const failed = checks.filter(([, ok]) => !ok)
console.log(`\n${checks.length - failed.length}/${checks.length} passed`)
process.exit(failed.length ? 1 : 0)
