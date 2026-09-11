// The magic eraser's arithmetic, on pictures made of numbers.
//
// Every fixture here is a background with "ink" drawn over it, and the clean
// background is kept — so a fill is not judged by whether it looks plausible
// but by how far it lands from what was really there.
import {
  rasterStroke, strokeBox, distanceTo, dilate, hugText, pushPull, patchFill, pieces, planCrops,
  maskBounds, newHealStroke,
} from '../../src/engine/heal.js'

const checks = []
const check = (name, ok, detail = '') => {
  checks.push([name, ok])
  console.log((ok ? 'PASS  ' : 'FAIL  ') + name + (detail ? '  — ' + detail : ''))
}

// Deterministic noise, so a failure is the same failure every run.
function rng(seed) {
  let s = seed >>> 0
  return () => ((s = (Math.imul(s, 1103515245) + 12345) >>> 0) / 4294967296)
}

/** A sky: a soft gradient with grain in it, the way a photograph has. */
function sky(w, h, { seed = 7, grain = 7 } = {}) {
  const r = rng(seed)
  const d = new Uint8ClampedArray(w * h * 4)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const p = (y * w + x) * 4
      const n = () => (r() - 0.5) * 2 * grain
      d[p] = 70 + (60 * y) / h + n()
      d[p + 1] = 120 + (50 * x) / w + n()
      d[p + 2] = 190 + (30 * y) / h + n()
      d[p + 3] = 255
    }
  }
  return d
}

/**
 * Something shaped like a line of type: stems and bars, a few pixels thick,
 * with an anti-aliased edge — a pixel of half-ink round every letter, because
 * real type has one and it is the part a careless fill leaves behind.
 */
function ink(d, w, x0, y0, { letters = 8, size = 18, color = [250, 250, 250] } = {}) {
  const at = (x, y, k) => {
    const p = (y * w + x) * 4
    for (let c = 0; c < 3; c++) d[p + c] = d[p + c] * (1 - k) + color[c] * k
  }
  const cells = []
  for (let i = 0; i < letters; i++) {
    const lx = x0 + i * Math.round(size * 0.75)
    // A stem, a bar across the top and one across the middle: an E, an F, a T.
    cells.push([lx, y0, 3, size])
    cells.push([lx, y0, Math.round(size * 0.5), 3])
    if (i % 2) cells.push([lx, y0 + Math.round(size / 2), Math.round(size * 0.4), 3])
  }
  const truth = new Set()
  for (const [x, y, cw, ch] of cells) {
    for (let yy = y - 1; yy <= y + ch; yy++) {
      for (let xx = x - 1; xx <= x + cw; xx++) {
        const edge = yy < y || yy >= y + ch || xx < x || xx >= x + cw
        at(xx, yy, edge ? 0.45 : 1)
        truth.add(yy * w + xx)
      }
    }
  }
  return truth
}

const band = (w, h, y0, y1, x0 = 0, x1 = w) => {
  const m = new Uint8Array(w * h)
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) m[y * w + x] = 1
  return m
}

/** Mean distance from the truth over a set of pixels, averaged across channels. */
function error(a, b, where) {
  let s = 0
  let n = 0
  for (let i = 0; i < where.length; i++) {
    if (!where[i]) continue
    const p = i * 4
    s += Math.abs(a[p] - b[p]) + Math.abs(a[p + 1] - b[p + 1]) + Math.abs(a[p + 2] - b[p + 2])
    n += 3
  }
  return n ? s / n : 0
}

// --- strokes to pixels ----------------------------------------------------------
{
  const W = 100
  const dot = rasterStroke({ size: 0.2, pts: [[0.5, 0.5]] }, W, W, { x: 0, y: 0, w: W, h: W })
  const area = dot.reduce((a, b) => a + b, 0)
  check('a tap is a disc the size of the brush', Math.abs(area - Math.PI * 100) < Math.PI * 100 * 0.05, String(area))

  const line = rasterStroke({ size: 0.1, pts: [[0.2, 0.5], [0.8, 0.5]] }, W, W, { x: 0, y: 0, w: W, h: W })
  const la = line.reduce((a, b) => a + b, 0)
  const expected = 60 * 10 + Math.PI * 25
  check('a drag is a band with round ends', Math.abs(la - expected) < expected * 0.05, `${la} vs ${expected.toFixed(0)}`)

  const sq = rasterStroke({ kind: 'region', pts: [[0.1, 0.1], [0.5, 0.1], [0.5, 0.5], [0.1, 0.5]] }, W, W,
    { x: 0, y: 0, w: W, h: W })
  check('a lasso region fills exactly its inside', sq.reduce((a, b) => a + b, 0) === 1600,
    String(sq.reduce((a, b) => a + b, 0)))

  // Rasterising into a window has to land the same pixels as rasterising the
  // whole picture, or a fill made in a crop is a fill in the wrong place.
  const win = rasterStroke({ size: 0.1, pts: [[0.2, 0.5], [0.8, 0.5]] }, W, W, { x: 30, y: 40, w: 20, h: 20 })
  let same = true
  for (let y = 0; y < 20; y++) for (let x = 0; x < 20; x++) if (win[y * 20 + x] !== line[(y + 40) * W + x + 30]) same = false
  check('a window sees the same pixels as the whole picture', same)

  const box = strokeBox({ size: 0.1, pts: [[0.2, 0.5], [0.8, 0.5]] }, W, W)
  check('the stroke box holds the whole stroke and the brush round it',
    box.x0 <= 15 && box.x1 >= 85 && box.y0 <= 45 && box.y1 >= 55, JSON.stringify(box))
  check('and stays inside the picture', strokeBox({ size: 0.5, pts: [[0, 0]] }, W, W).x0 === 0)

  const s = newHealStroke(0.05, [[0.1, 0.1]])
  const t = newHealStroke(0.05, [[0.1, 0.1]])
  check('every stroke has an id of its own', s.id && t.id && s.id !== t.id)
}

// --- distance ---------------------------------------------------------------------
{
  const w = 37
  const h = 23
  const r = rng(3)
  const m = new Uint8Array(w * h)
  for (let i = 0; i < m.length; i++) m[i] = r() < 0.04 ? 1 : 0
  const d = distanceTo(m, w, h)
  let worst = 0
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let best = Infinity
      for (let j = 0; j < m.length; j++) {
        if (!m[j]) continue
        best = Math.min(best, Math.hypot(x - (j % w), y - Math.floor(j / w)))
      }
      worst = Math.max(worst, Math.abs(best - d[y * w + x]))
    }
  }
  check('distances are exact, not a city-block guess', worst < 1e-4, String(worst))

  const one = new Uint8Array(21 * 21)
  one[10 * 21 + 10] = 1
  const grown = dilate(one, 21, 21, 5)
  // A round dilation leaves the corners of its bounding square empty.
  check('growing a point makes a disc', grown[10 * 21 + 15] === 1 && grown[5 * 21 + 5] === 0)
}

// --- filling ----------------------------------------------------------------------
{
  const w = 120
  const h = 60
  const d = new Uint8ClampedArray(w * h * 4)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const p = (y * w + x) * 4
      d[p] = x * 2
      d[p + 1] = 100
      d[p + 2] = 255 - y * 3
      d[p + 3] = 255
    }
  }
  const clean = d.slice()
  const hole = band(w, h, 20, 40, 40, 70)
  for (let i = 0; i < hole.length; i++) if (hole[i]) { d[i * 4] = 0; d[i * 4 + 1] = 0; d[i * 4 + 2] = 0 }
  pushPull(d, hole, w, h)
  let worst = 0
  for (let i = 0; i < hole.length; i++) {
    if (!hole[i]) continue
    for (let c = 0; c < 3; c++) worst = Math.max(worst, Math.abs(d[i * 4 + c] - clean[i * 4 + c]))
  }
  check('a hole in a smooth gradient fills back to the gradient', worst < 12, `worst ${worst}`)

  let untouched = true
  for (let i = 0; i < hole.length; i++) {
    if (hole[i]) continue
    for (let c = 0; c < 4; c++) if (d[i * 4 + c] !== clean[i * 4 + c]) untouched = false
  }
  check('and nothing outside the hole is changed at all', untouched)

  // Transparent picture: the hole fills with transparency, not with black.
  const t = new Uint8ClampedArray(40 * 40 * 4)
  const th = band(40, 40, 10, 30, 10, 30)
  for (let i = 0; i < th.length; i++) if (th[i]) { t[i * 4] = 255; t[i * 4 + 3] = 255 }
  pushPull(t, th, 40, 40)
  check('a hole in transparency stays transparent', t[(20 * 40 + 20) * 4 + 3] < 10, String(t[(20 * 40 + 20) * 4 + 3]))

  const all = new Uint8ClampedArray(16 * 4).fill(9)
  pushPull(all, new Uint8Array(16).fill(1), 4, 4)
  check('a picture that is all hole is left alone rather than invented', all[0] === 9)
}

// --- finding the text under a brush ----------------------------------------------
{
  const w = 260
  const h = 90
  const clean = sky(w, h)
  const d = clean.slice()
  const truth = ink(d, w, 30, 36, { letters: 12, size: 18 })
  const brushed = band(w, h, 28, 62, 20, 240)
  const res = hugText(d, brushed, w, h, { brushPx: 34 })
  const missed = [...truth].filter((i) => !res.mask[i]).length
  check('under a brush, the letters are found', res.mode === 'hug', `${res.mode} ${res.why} share ${res.share?.toFixed(2)}`)
  check('every pixel of ink is in the hole, edges included', missed === 0, `${missed} of ${truth.size} missed`)
  check('and most of the background under the brush is kept as evidence',
    res.share < 0.7, `share ${res.share.toFixed(2)}`)

  // What it is for: the same fill, told less, lands closer.
  const a = d.slice()
  pushPull(a, res.mask, w, h)
  const b = d.slice()
  pushPull(b, brushed, w, h)
  const eHug = error(a, clean, brushed)
  const eBand = error(b, clean, brushed)
  console.log(`  fill error under the brush: hugging ${eHug.toFixed(2)}, whole band ${eBand.toFixed(2)}`)
  check('filling only the letters lands nearer the truth than filling the band', eHug < eBand * 0.8,
    `${eHug.toFixed(2)} vs ${eBand.toFixed(2)}`)
  check('and near enough to be grain rather than a smear', eHug < 5, eHug.toFixed(2))
}

// --- when it must not narrow -------------------------------------------------------
{
  // A paragraph: the lines above and below are as full of ink as the one under
  // the brush, so the ring cannot say what is paper. It must fall back to the
  // whole band rather than keep a guess that leaves letters behind.
  const w = 260
  const h = 120
  const d = sky(w, h, { seed: 11 })
  ink(d, w, 30, 18, { letters: 12, size: 18 })
  const mid = ink(d, w, 30, 50, { letters: 12, size: 18 })
  ink(d, w, 30, 82, { letters: 12, size: 18 })
  const brushed = band(w, h, 45, 74, 20, 240)
  const res = hugText(d, brushed, w, h, { brushPx: 29 })
  const missed = [...mid].filter((i) => !res.mask[i] && brushed[i]).length
  check('inside a paragraph, no letter under the brush is left behind', missed === 0,
    `${res.mode} ${res.why}, ${missed} missed`)

  // Plain background, nothing written on it: nothing stands out, so the whole
  // stroke is what was meant.
  const bare = sky(200, 80, { seed: 5 })
  const r2 = hugText(bare, band(200, 80, 25, 55, 20, 180), 200, 80, { brushPx: 30 })
  check('over nothing in particular, the whole stroke is filled', r2.mode === 'band', r2.why)

  // Dark type on a light ground, in a colour the picture also has a little of
  // nearby — a speck in the ring must not be enough to hide the text.
  const w3 = 240
  const h3 = 80
  const light = new Uint8ClampedArray(w3 * h3 * 4)
  const r = rng(9)
  for (let i = 0; i < w3 * h3; i++) {
    const g = 225 + (r() - 0.5) * 10
    light[i * 4] = g
    light[i * 4 + 1] = g - 4
    light[i * 4 + 2] = g - 10
    light[i * 4 + 3] = 255
  }
  const dark = ink(light, w3, 30, 30, { letters: 10, size: 16, color: [20, 20, 30] })
  ink(light, w3, 200, 4, { letters: 1, size: 6, color: [20, 20, 30] })   // the speck
  const brushed3 = band(w3, h3, 22, 56, 20, 200)
  const r3 = hugText(light, brushed3, w3, h3, { brushPx: 34 })
  check('dark on light is found too', r3.mode === 'hug' && [...dark].every((i) => r3.mask[i]), `${r3.mode} ${r3.why}`)

  // Nothing but transparency around it: no paper to compare with.
  const empty = new Uint8ClampedArray(80 * 40 * 4)
  const r4 = hugText(empty, band(80, 40, 10, 30, 10, 70), 80, 40, { brushPx: 20 })
  check('with nothing around it to compare, the whole stroke is filled', r4.mode === 'band', r4.why)
}

// --- filling with the picture's own pieces -----------------------------------------
{
  // A horizon: sky over grass, with grain, and a hole straight across the edge
  // — the letter of a caption sitting on a hill. Pull-push averages the two
  // into a smudge; pieces of the real edge carry it through.
  const w = 120
  const h = 80
  const r = rng(21)
  const clean = new Uint8ClampedArray(w * h * 4)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const p = (y * w + x) * 4
      const grass = y > 38 + x * 0.08
      const n = (r() - 0.5) * 10
      clean[p] = (grass ? 60 : 150) + n
      clean[p + 1] = (grass ? 110 : 190) + n
      clean[p + 2] = (grass ? 55 : 235) + n
      clean[p + 3] = 255
    }
  }
  const hole = band(w, h, 28, 56, 56, 64)
  const smooth = clean.slice()
  pushPull(smooth, hole, w, h)
  const pieced = clean.slice()
  await patchFill(pieced, hole, w, h)
  const eSmooth = error(smooth, clean, hole)
  const ePieced = error(pieced, clean, hole)
  console.log(`  across an edge: pull-push ${eSmooth.toFixed(2)}, pieces ${ePieced.toFixed(2)}`)
  check('across an edge, filling from pieces of the picture beats smoothing', ePieced < eSmooth * 0.6,
    `${ePieced.toFixed(2)} vs ${eSmooth.toFixed(2)}`)
  // Exactly the known pixels, untouched.
  let same = true
  for (let i = 0; i < w * h; i++) {
    if (hole[i]) continue
    for (let c = 0; c < 4; c++) if (pieced[i * 4 + c] !== clean[i * 4 + c]) same = false
  }
  check('and it never touches a pixel outside the hole', same)

  // Stripes: a texture pull-push can only average into grey.
  const sw = 96
  const sh = 64
  const stripes = new Uint8ClampedArray(sw * sh * 4)
  for (let y = 0; y < sh; y++) {
    for (let x = 0; x < sw; x++) {
      const p = (y * sw + x) * 4
      const v = (x % 8) < 4 ? 40 : 210
      stripes[p] = v
      stripes[p + 1] = v
      stripes[p + 2] = v
      stripes[p + 3] = 255
    }
  }
  const sh1 = band(sw, sh, 20, 44, 36, 58)
  const a = stripes.slice()
  pushPull(a, sh1, sw, sh)
  const b = stripes.slice()
  await patchFill(b, sh1, sw, sh)
  const eA = error(a, stripes, sh1)
  const eB = error(b, stripes, sh1)
  console.log(`  stripes: pull-push ${eA.toFixed(2)}, pieces ${eB.toFixed(2)}`)
  check('a texture comes back as the texture, not its average', eB < eA * 0.35, `${eB.toFixed(2)} vs ${eA.toFixed(2)}`)

  const again = stripes.slice()
  await patchFill(again, sh1, sw, sh)
  check('and the same hole fills the same way every time', again.every((v, i) => v === b[i]))

  // All hole: nothing real to take pieces from.
  const all = new Uint8ClampedArray(20 * 20 * 4).fill(50)
  await patchFill(all, new Uint8Array(400).fill(1), 20, 20)
  check('with nothing real to copy from, it leaves the picture alone', all[0] === 50)
}

// --- what the model is shown --------------------------------------------------------
{
  const w = 800
  const h = 300
  const m = new Uint8Array(w * h)
  for (let y = 20; y < 40; y++) for (let x = 20; x < 60; x++) m[y * w + x] = 1
  for (let y = 250; y < 270; y++) for (let x = 700; x < 760; x++) m[y * w + x] = 1
  const two = pieces(m, w, h, 10)
  check('two captions in opposite corners are two pieces', two.length === 2, String(two.length))

  const word = new Uint8Array(w * h)
  for (let k = 0; k < 6; k++) for (let y = 100; y < 120; y++) for (let x = 100 + k * 12; x < 106 + k * 12; x++) word[y * w + x] = 1
  check('the letters of a word are one', pieces(word, w, h, 12).length === 1)

  const long = [{ x0: 20, y0: 130, x1: 780, y1: 170 }]
  const plan = planCrops(long, w, h, { core: 320 })
  check('a long caption is cut into lengths', plan.length === 3, String(plan.length))
  check('every crop is inside the picture',
    plan.every(({ crop: c }) => c.x >= 0 && c.y >= 0 && c.x + c.w <= w && c.y + c.h <= h),
    JSON.stringify(plan.map((p) => p.crop)))
  check('and holds the piece it is for',
    plan.every(({ core: k, crop: c }) => k.x0 >= c.x && k.x1 <= c.x + c.w && k.y0 >= c.y && k.y1 <= c.y + c.h))
  check('the lengths cover the whole caption between them',
    plan[0].core.x0 === 20 && plan[plan.length - 1].core.x1 === 780
      && plan.every((p, i) => i === 0 || p.core.x0 === plan[i - 1].core.x1))

  const small = planCrops([{ x0: 10, y0: 10, x1: 30, y1: 20 }], 120, 90)
  check('a picture smaller than a crop is shown whole',
    small[0].crop.w === 120 && small[0].crop.h === 90, JSON.stringify(small[0].crop))

  check('mask bounds', JSON.stringify(maskBounds(m, w, h)) === JSON.stringify({ x0: 20, y0: 20, x1: 760, y1: 270 }))
  check('and none for an empty mask', maskBounds(new Uint8Array(4), 2, 2) === null)
}

const failed = checks.filter(([, ok]) => !ok)
console.log(`\n${checks.length - failed.length}/${checks.length} passed`)
process.exit(failed.length ? 1 : 0)
