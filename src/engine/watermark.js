// Watermarks: finding a mark repeated across a picture, and taking it off.
//
// A watermark is laid over a picture over and over, on a grid — tilted, often,
// and faint, so as to spoil the picture without hiding it. Both of those are
// what give it away. Repeated means the picture looks like itself shifted by
// the grid step, which an autocorrelation finds in one pass. And laid *over*
// means every copy is the same mark on top of a different piece of picture:
// line the copies up and take the middle value, and the picture — different
// under every copy — cancels, while the mark, the same under every copy, stays.
//
// What comes out is the mark itself: how opaque it is at every pixel of one
// tile, and what colour it is. A faint mark is then taken off exactly rather
// than painted over — if a pixel is 35% white over the picture, the picture is
// what is left when the 35% white is subtracted and the rest scaled back up.
// That is the real picture underneath, not an estimate of it. Only where the
// mark is nearly opaque, and there is too little picture left to recover, are
// the pixels filled from around instead.
//
// Everything stored is small: the grid, one tile's opacity, the colour. The
// picture itself is never rewritten.

import { fft2d, nextPow2 } from './fft.js'
import { pushPull, dilate, distanceTo } from './heal.js'
import { zlibSync, unzlibSync } from 'fflate'

export const hasDewater = (l) => !!l?.dewater?.on

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v))

// ---- picture arithmetic ----------------------------------------------------------

/** An area-averaged copy no larger than `maxSide`. */
export function downscale(rgba, w, h, maxSide) {
  const s = Math.min(1, maxSide / Math.max(w, h))
  if (s >= 1) return { data: rgba, w, h }
  const nw = Math.max(1, Math.round(w * s))
  const nh = Math.max(1, Math.round(h * s))
  const out = new Uint8ClampedArray(nw * nh * 4)
  for (let y = 0; y < nh; y++) {
    const y0 = Math.floor((y * h) / nh)
    const y1 = Math.max(y0 + 1, Math.floor(((y + 1) * h) / nh))
    for (let x = 0; x < nw; x++) {
      const x0 = Math.floor((x * w) / nw)
      const x1 = Math.max(x0 + 1, Math.floor(((x + 1) * w) / nw))
      let r = 0
      let g = 0
      let b = 0
      let a = 0
      let n = 0
      for (let yy = y0; yy < y1; yy++) {
        for (let xx = x0; xx < x1; xx++) {
          const p = (yy * w + xx) * 4
          r += rgba[p]
          g += rgba[p + 1]
          b += rgba[p + 2]
          a += rgba[p + 3]
          n++
        }
      }
      const q = (y * nw + x) * 4
      out[q] = r / n
      out[q + 1] = g / n
      out[q + 2] = b / n
      out[q + 3] = a / n
    }
  }
  return { data: out, w: nw, h: nh }
}

export function luma(rgba, w, h) {
  const out = new Float32Array(w * h)
  for (let i = 0, p = 0; i < out.length; i++, p += 4) out[i] = 0.299 * rgba[p] + 0.587 * rgba[p + 1] + 0.114 * rgba[p + 2]
  return out
}

function channel(rgba, n, c) {
  const out = new Float32Array(n)
  for (let i = 0; i < n; i++) out[i] = rgba[i * 4 + c]
  return out
}

// A box blur, twice, which is close enough to a Gaussian for telling a thin
// stroke from the ground it sits on. Running sums, so the radius costs nothing.
function boxPass(src, w, h, r, horizontal) {
  const out = new Float32Array(w * h)
  const len = horizontal ? w : h
  const pre = new Float64Array(len + 1)
  for (let line = 0; line < (horizontal ? h : w); line++) {
    for (let i = 0; i < len; i++) {
      const idx = horizontal ? line * w + i : i * w + line
      pre[i + 1] = pre[i] + src[idx]
    }
    for (let i = 0; i < len; i++) {
      const a = Math.max(0, i - r)
      const b = Math.min(len, i + r + 1)
      const idx = horizontal ? line * w + i : i * w + line
      out[idx] = (pre[b] - pre[a]) / (b - a)
    }
  }
  return out
}

export function blur1(src, w, h, r) {
  let v = src
  for (let k = 0; k < 2; k++) v = boxPass(boxPass(v, w, h, r, true), w, h, r, false)
  return v
}

// k-th smallest of a[0..n), in place.
function select(a, n, k) {
  let lo = 0
  let hi = n - 1
  while (lo < hi) {
    const pivot = a[(lo + hi) >> 1]
    let i = lo
    let j = hi
    while (i <= j) {
      while (a[i] < pivot) i++
      while (a[j] > pivot) j--
      if (i <= j) {
        const t = a[i]
        a[i] = a[j]
        a[j] = t
        i++
        j--
      }
    }
    if (k <= j) hi = j
    else if (k >= i) lo = i
    else return a[k]
  }
  return a[k]
}
const medianOf = (a, n) => (n ? select(a, n, n >> 1) : 0)

// A value between pixels, read off the four around it. Coordinates are pixel
// indices, and must be inside the picture.
function bilinear(arr, w, h, x, y, stride = 1, c = 0) {
  const x0 = Math.floor(x)
  const y0 = Math.floor(y)
  const x1 = Math.min(w - 1, x0 + 1)
  const y1 = Math.min(h - 1, y0 + 1)
  const fx = x - x0
  const fy = y - y0
  const at = (xx, yy) => arr[(yy * w + xx) * stride + c]
  return (at(x0, y0) * (1 - fx) + at(x1, y0) * fx) * (1 - fy) + (at(x0, y1) * (1 - fx) + at(x1, y1) * fx) * fy
}

// ---- finding the repetition -------------------------------------------------------

/**
 * The picture's fine detail, flattened: what is left after taking away the
 * broad shapes, squashed so a hard edge in the photograph counts no more than
 * a faint stroke of a watermark. Without the squashing the strongest edge in
 * the picture would decide what the picture "resembles when shifted".
 */
export function featureOf(gray, w, h) {
  const b = blur1(gray, w, h, 2)
  const hp = new Float32Array(w * h)
  for (let i = 0; i < hp.length; i++) hp[i] = gray[i] - b[i]
  const step = Math.max(1, Math.floor(hp.length / 20000))
  const sample = new Float64Array(Math.ceil(hp.length / step))
  let n = 0
  for (let i = 0; i < hp.length; i += step) sample[n++] = Math.abs(hp[i])
  const k = 1 / (3 * medianOf(sample, n) + 0.5)
  let mean = 0
  for (let i = 0; i < hp.length; i++) {
    hp[i] = Math.tanh(hp[i] * k)
    mean += hp[i]
  }
  mean /= hp.length
  for (let i = 0; i < hp.length; i++) hp[i] -= mean
  return hp
}

/**
 * How much the feature map resembles itself at every shift, as a function
 * `(dx, dy) -> -1..1`. Padded so no shift wraps round into itself, and each
 * shift divided by how much of the picture overlapped at it — or a short
 * shift would always win on overlap alone.
 */
export function autocorrelation(f, w, h) {
  // Twice the picture, so a shift of nearly its whole width still does not
  // wrap: a mark repeated three times across is checked at two steps, which
  // is most of the picture.
  const P = nextPow2(Math.ceil(Math.max(w, h) * 2))
  const re = new Float64Array(P * P)
  const im = new Float64Array(P * P)
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) re[y * P + x] = f[y * w + x]
  fft2d(re, im, P, P, false)
  for (let i = 0; i < re.length; i++) {
    re[i] = re[i] * re[i] + im[i] * im[i]
    im[i] = 0
  }
  fft2d(re, im, P, P, true)
  const zero = re[0] / (w * h) || 1
  return (dx, dy) => {
    const ax = Math.abs(dx)
    const ay = Math.abs(dy)
    if (ax >= w || ay >= h) return 0
    const v = re[(((dy % P) + P) % P) * P + (((dx % P) + P) % P)]
    return v / ((w - ax) * (h - ay)) / zero
  }
}

const dot = (a, b) => a[0] * b[0] + a[1] * b[1]
const norm2 = (a) => dot(a, a)

// The shortest pair of vectors describing the same grid: a grid can be
// described by long slanted vectors or short square ones, and only the short
// ones say how far apart the marks really are.
function reduceBasis(a, b) {
  for (let it = 0; it < 32; it++) {
    if (norm2(a) > norm2(b)) [a, b] = [b, a]
    const mu = Math.round(dot(a, b) / norm2(a))
    if (!mu) break
    b = [b[0] - mu * a[0], b[1] - mu * a[1]]
  }
  // Pointing down or right, so the same grid is always written the same way.
  const tidy = (v) => (v[1] < 0 || (v[1] === 0 && v[0] < 0) ? [-v[0], -v[1]] : v)
  return [tidy(a), tidy(b)]
}

function parabola(l, c, r) {
  const d = l - 2 * c + r
  return d < 0 ? clamp((0.5 * (l - r)) / d, -0.5, 0.5) : 0
}

/**
 * The grid of a repeated mark, from the autocorrelation: the peaks it makes,
 * and the two shortest steps that explain them. Null when nothing repeats.
 */
export function findLattice(ac, w, h, { minPeriod = 5, floor = 0.1 } = {}) {
  const maxX = Math.floor(w / 2)
  const maxY = Math.floor(h / 2)
  const peaks = []
  for (let dy = 0; dy <= maxY; dy++) {
    for (let dx = -maxX; dx <= maxX; dx++) {
      if (dy === 0 && dx <= 0) continue
      if (dx * dx + dy * dy < minPeriod * minPeriod) continue
      const v = ac(dx, dy)
      if (v < floor) continue
      let top = true
      for (let j = -2; j <= 2 && top; j++) {
        for (let i = -2; i <= 2; i++) {
          if ((i || j) && ac(dx + i, dy + j) > v) { top = false; break }
        }
      }
      if (top) peaks.push({ v: [dx, dy], s: v })
    }
  }
  if (!peaks.length) return null
  peaks.sort((a, b) => b.s - a.s)
  const best = peaks[0].s
  const inRange = (v) => Math.abs(v[0]) < w * 0.75 && Math.abs(v[1]) < h * 0.75

  // How well a step holds up taken again and again. The grid a mark is
  // stamped on repeats right across the picture; a mark that repeats *inside*
  // itself — the evenly spaced letters of a word — correlates at one letter's
  // shift, less at two, and not at all once the shift runs off the end of the
  // word. The shortest strong peak is very often the letters, so the peak that
  // wins is the one that keeps holding, not the one that is nearest.
  const holds = (v) => {
    let worst = Infinity
    let k = 1
    for (; k <= 4; k++) {
      const u = [v[0] * k, v[1] * k]
      if (!inRange(u)) break
      // A step that is not a whole number of pixels drifts as it is repeated,
      // so each repeat is looked for a pixel or two either side.
      const r = Math.min(2, k - 1)
      let top = -Infinity
      for (let j = -r; j <= r; j++) for (let i = -r; i <= r; i++) top = Math.max(top, ac(u[0] + i, u[1] + j))
      worst = Math.min(worst, top)
    }
    // One step alone is a picture with something in it twice, not a grid.
    return k > 2 ? worst : -Infinity
  }
  const cands = peaks.slice(0, 40).filter((p) => p.s >= best * 0.3)
  for (const p of cands) p.h = holds(p.v)
  const hold = Math.max(...cands.map((p) => p.h))
  if (!(hold > 0)) return null
  // The shortest of the steps that hold up nearly as well as the best: a step
  // of two tiles holds as well as a step of one, and one tile is the answer.
  const byLength = cands.filter((p) => p.h >= hold * 0.7).sort((a, b) => norm2(a.v) - norm2(b.v))
  const first = byLength[0]
  const second = cands.filter((p) => p !== first && p.h >= first.h * 0.5
    && Math.abs(first.v[0] * p.v[1] - first.v[1] * p.v[0]) / Math.sqrt(norm2(first.v) * norm2(p.v)) > 0.3)
    .sort((a, b) => norm2(a.v) - norm2(b.v))[0]
  // A mark is stamped on a grid in two directions. One direction alone is a
  // row of something in the picture — a fence, a line of windows — far more
  // often than it is a watermark.
  if (!second) return null
  const [v1, v2] = reduceBasis(first.v, second.v)
  const subpixel = (v) => {
    const c = ac(v[0], v[1])
    return [v[0] + parabola(ac(v[0] - 1, v[1]), c, ac(v[0] + 1, v[1])),
      v[1] + parabola(ac(v[0], v[1] - 1), c, ac(v[0], v[1] + 1))]
  }
  return { v1: subpixel(v1), v2: subpixel(v2), strength: Math.min(holds(v1), holds(v2)) }
}

/** A grid step sharpened against the full-size picture, to a fraction of a pixel. */
export function refineVector(F, w, h, v, radius = 2) {
  const corr = (dx, dy) => {
    const x0 = Math.max(0, -dx)
    const x1 = Math.min(w, w - dx)
    const y0 = Math.max(0, -dy)
    const y1 = Math.min(h, h - dy)
    let s = 0
    let n = 0
    for (let y = y0; y < y1; y += 2) {
      const r1 = y * w
      const r2 = (y + dy) * w + dx
      for (let x = x0; x < x1; x++) s += F[r1 + x] * F[r2 + x]
      n += x1 - x0
    }
    return n ? s / n : -Infinity
  }
  const cx = Math.round(v[0])
  const cy = Math.round(v[1])
  const seen = new Map()
  const at = (x, y) => {
    const k = x + ',' + y
    if (!seen.has(k)) seen.set(k, corr(x, y))
    return seen.get(k)
  }
  let bx = cx
  let by = cy
  for (let dy = -radius; dy <= radius; dy++) {
    for (let dx = -radius; dx <= radius; dx++) {
      if (at(cx + dx, cy + dy) > at(bx, by)) { bx = cx + dx; by = cy + dy }
    }
  }
  const c = at(bx, by)
  return [bx + parabola(at(bx - 1, by), c, at(bx + 1, by)), by + parabola(at(bx, by - 1), c, at(bx, by + 1))]
}

// ---- the tile ----------------------------------------------------------------------

/**
 * One tile of the grid, as a small picture in the big picture's own pixels:
 * the parallelogram the two steps span from the origin, boxed, with a pixel to
 * spare round it. Every pixel of the picture has an equivalent in here, found
 * by stepping back along the grid; and every pixel in here has its copies out
 * in the picture, found by stepping forward.
 *
 * Kept in the picture's pixels rather than as fractions of a tile, so that on
 * a grid of whole pixels every copy of a pixel lands on exactly that pixel of
 * the tile — no blending between neighbours, and the edge of a letter stays
 * as sharp as it was drawn.
 */
export function tileOf(model) {
  const [ax, ay] = model.v1
  const [bx, by] = model.v2
  const det = ax * by - ay * bx
  const xs = [0, ax, bx, ax + bx]
  const ys = [0, ay, by, ay + by]
  const tx0 = Math.floor(Math.min(...xs)) - 1
  const ty0 = Math.floor(Math.min(...ys)) - 1
  return {
    v1: [ax, ay],
    v2: [bx, by],
    i00: by / det,
    i01: -bx / det,
    i10: -ay / det,
    i11: ax / det,
    tx0,
    ty0,
    tw: Math.ceil(Math.max(...xs)) + 2 - tx0,
    th: Math.ceil(Math.max(...ys)) + 2 - ty0,
  }
}

/** A point of the picture, stepped back along the grid into the tile. */
function fold(t, x, y) {
  const a = Math.floor(t.i00 * x + t.i01 * y)
  const b = Math.floor(t.i10 * x + t.i11 * y)
  return [x - a * t.v1[0] - b * t.v2[0], y - a * t.v1[1] - b * t.v2[1]]
}

// Every grid step that can carry some pixel of the tile into the picture.
function stepsInto(t, w, h) {
  const xlo = -(t.tx0 + t.tw) - 1
  const xhi = w - t.tx0 + 1
  const ylo = -(t.ty0 + t.th) - 1
  const yhi = h - t.ty0 + 1
  let mlo = Infinity
  let mhi = -Infinity
  let nlo = Infinity
  let nhi = -Infinity
  for (const [x, y] of [[xlo, ylo], [xhi, ylo], [xlo, yhi], [xhi, yhi]]) {
    const a = t.i00 * x + t.i01 * y
    const b = t.i10 * x + t.i11 * y
    mlo = Math.min(mlo, Math.floor(a) - 1)
    mhi = Math.max(mhi, Math.ceil(a) + 1)
    nlo = Math.min(nlo, Math.floor(b) - 1)
    nhi = Math.max(nhi, Math.ceil(b) + 1)
  }
  const out = []
  for (let n = nlo; n <= nhi; n++) {
    for (let m = mlo; m <= mhi; m++) {
      const dx = m * t.v1[0] + n * t.v2[0]
      const dy = m * t.v1[1] + n * t.v2[1]
      if (dx >= xlo && dx <= xhi && dy >= ylo && dy <= yhi) out.push(dx, dy)
    }
  }
  return out
}

/**
 * What the mark is, from a picture and the grid it repeats on: its opacity at
 * every pixel of one tile, and its colour.
 *
 * In three passes. First, at every pixel of the tile, the fine detail of all
 * its copies is lined up and the middle value taken: where the mark is, every
 * copy agrees; everywhere else the picture varies, and the middle value is
 * nothing much. That says *where* the mark is. Then the mark's pixels are
 * filled from around, which says roughly what the picture under each copy was.
 * Then the colour is the one that makes the mark's opacity come out the same
 * under every copy — try white, and a copy over sky and a copy over shadow
 * agree on how faint the mark is; try the wrong colour, and they cannot.
 */
export async function estimateWatermark(rgba, w, h, model, { tick = null } = {}) {
  const t = tileOf(model)
  const { tw, th, tx0, ty0 } = t
  const T = tw * th
  const N = w * h
  const steps = stepsInto(t, w, h)
  const S = steps.length / 2

  // Fine detail per channel: the picture minus a blur a little wider than a
  // stroke of the mark.
  const len = Math.min(Math.hypot(...t.v1), Math.hypot(...t.v2))
  const r = clamp(Math.round(len * 0.12), 3, 40)
  const D = [0, 1, 2].map((c) => {
    const ch = channel(rgba, N, c)
    const bl = blur1(ch, w, h, r)
    for (let i = 0; i < N; i++) ch[i] -= bl[i]
    return ch
  })
  const Y = luma(rgba, w, h)
  if (tick) await tick()

  // The copies of one tile pixel: where each lands in the picture.
  const px = new Float64Array(S)
  const py = new Float64Array(S)
  const copies = (i, j) => {
    const qx = tx0 + i
    const qy = ty0 + j
    let n = 0
    for (let k = 0; k < S; k++) {
      const x = qx + steps[2 * k]
      const y = qy + steps[2 * k + 1]
      if (x < 0 || y < 0 || x > w - 1 || y > h - 1) continue
      px[n] = x
      py[n] = y
      n++
    }
    return n
  }

  const mag = new Float32Array(T)
  const spread = new Float32Array(T)
  // How much the picture itself differs from copy to copy, by colour rather
  // than detail: a smooth photograph has little fine detail anywhere, but the
  // colour under one copy is nothing like the colour under the next.
  const vary = new Float32Array(T)
  const valid = new Uint8Array(T)
  const scratch = new Float64Array(Math.max(3, S))
  for (let j = 0; j < th; j++) {
    for (let i = 0; i < tw; i++) {
      const n = copies(i, j)
      if (n < 3) continue
      const q = j * tw + i
      valid[q] = 1
      for (let k = 0; k < n; k++) scratch[k] = bilinear(Y, w, h, px[k], py[k])
      const my = medianOf(scratch, n)
      for (let k = 0; k < n; k++) scratch[k] = Math.abs(bilinear(Y, w, h, px[k], py[k]) - my)
      vary[q] = medianOf(scratch, n)
      let m = 0
      let sp = 0
      for (let c = 0; c < 3; c++) {
        for (let k = 0; k < n; k++) scratch[k] = bilinear(D[c], w, h, px[k], py[k])
        const med = medianOf(scratch, n)
        for (let k = 0; k < n; k++) scratch[k] = Math.abs(bilinear(D[c], w, h, px[k], py[k]) - med)
        m = Math.max(m, Math.abs(med))
        sp = Math.max(sp, medianOf(scratch, n))
      }
      mag[q] = m
      spread[q] = sp
    }
  }

  const mark = new Uint8Array(T)
  let marked = 0
  let usable = 0
  for (let q = 0; q < T; q++) {
    if (!valid[q]) continue
    usable++
    if (mag[q] > 8 && mag[q] > 1.5 * spread[q]) { mark[q] = 1; marked++ }
  }
  const coverage = usable ? marked / usable : 0
  if (coverage < 0.001) return { ok: false, reason: 'faint' }
  // A mark covers some of its tile. Something that covers most of it, or a
  // picture that is the same under every copy even where there is no mark, is
  // a pattern in the picture — tiles, a fence, a fabric — and not laid on it.
  if (coverage > 0.6) return { ok: false, reason: 'periodic' }
  let nOut = 0
  const outVary = new Float64Array(usable)
  for (let q = 0; q < T; q++) if (valid[q] && !mark[q]) outVary[nOut++] = vary[q]
  if (medianOf(outVary, nOut) < 8) return { ok: false, reason: 'periodic' }

  // Out into the picture: every pixel whose tile pixel is on the mark.
  let hole = new Uint8Array(N)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const [fx, fy] = fold(t, x, y)
      const i = clamp(Math.round(fx) - tx0, 0, tw - 1)
      const j = clamp(Math.round(fy) - ty0, 0, th - 1)
      hole[y * w + x] = mark[j * tw + i]
    }
  }
  hole = dilate(hole, w, h, 2)
  const J0 = new Uint8ClampedArray(rgba)
  pushPull(J0, hole, w, h)
  if (tick) await tick()

  // The mark's colour, from the tile pixels where it is strongest.
  const core = []
  for (let q = 0; q < T; q++) if (mark[q]) core.push(q)
  core.sort((p, q) => mag[q] - mag[p])
  core.length = Math.max(Math.min(core.length, 10), Math.round(core.length * 0.4))
  const samp = new Float64Array(Math.max(9, S * 3))
  const ratios = (q, W, minGap) => {
    const n = copies(q % tw, Math.floor(q / tw))
    let k = 0
    for (let s = 0; s < n; s++) {
      for (let c = 0; c < 3; c++) {
        const j0 = bilinear(J0, w, h, px[s], py[s], 4, c)
        const gap = W[c] - j0
        if (Math.abs(gap) > minGap) samp[k++] = (bilinear(rgba, w, h, px[s], py[s], 4, c) - j0) / gap
      }
    }
    return k
  }
  const tryColour = (W) => {
    let num = 0
    let den = 0
    let used = 0
    let bad = 0
    for (const q of core) {
      const k = ratios(q, W, 25)
      if (k < 6) continue
      const med = medianOf(samp, k)
      for (let j = 0; j < k; j++) samp[j] = Math.abs(samp[j] - med)
      const mad = medianOf(samp, k)
      if (med <= 0.02 || med > 1.05) { bad++; continue }
      num += mad
      den += med
      used++
    }
    return used ? num / den + bad / (used + bad) : Infinity
  }
  let colour = null
  let fit = Infinity
  for (let g = 0; g <= 255; g += 15) {
    const s = tryColour([g, g, g])
    if (s < fit) { fit = s; colour = [g, g, g] }
  }
  if (!colour || fit > 0.75) return { ok: false, reason: 'not-a-blend' }

  // The mark's opacity at every tile pixel whose copies fall on the mark.
  const alpha = new Float32Array(T)
  for (let q = 0; q < T; q++) {
    if (!valid[q]) continue
    const n = copies(q % tw, Math.floor(q / tw))
    let inside = 0
    for (let s = 0; s < n; s++) inside += hole[Math.round(py[s]) * w + Math.round(px[s])]
    if (inside < n * 0.5) continue
    const k = ratios(q, colour, 20)
    if (k < 3) continue
    const a = medianOf(samp, k)
    alpha[q] = a < 0.015 ? 0 : clamp(a, 0, 0.97)
  }
  return { ok: true, alpha, color: colour, tile: t, coverage, fit }
}

/**
 * Where the mark sits in its tile, which way it is turned, and how many
 * copies of it land on the picture.
 *
 * The turn comes from the shape of one copy: the long axis of a line of
 * lettering is its baseline. Measured in the picture's own directions, not
 * the grid's, since a grid of straight words can itself be slanted.
 */
export function describe(alpha, t, w, h) {
  const { tw, th, tx0, ty0, v1, v2 } = t
  // One whole copy, looked at in the picture's own space. A mark can be longer
  // than a step of its grid — a long word on a tight grid — and measured inside
  // one tile it comes out cut into pieces and put back in the wrong order. So
  // the mark is drawn over a window a few tiles wide, the letters of each copy
  // are joined into one shape, and the biggest shape that sits wholly inside
  // the window is the copy measured.
  const reach = Math.max(Math.hypot(...v1), Math.hypot(...v2))
  const R = Math.ceil(reach * 1.6)
  const S = 2 * R + 1
  const map = new Float32Array(S * S)
  const on = new Uint8Array(S * S)
  for (let j = 0; j < S; j++) {
    for (let i = 0; i < S; i++) {
      const [fx, fy] = fold(t, i - R, j - R)
      const u = clamp(Math.round(fx) - tx0, 0, tw - 1)
      const v = clamp(Math.round(fy) - ty0, 0, th - 1)
      const a = alpha[v * tw + u]
      map[j * S + i] = a
      on[j * S + i] = a > 0.08 ? 1 : 0
    }
  }
  // How close the letters of one copy are to each other is anybody's guess, so
  // the join is grown a step at a time until the biggest shape holds a whole
  // copy's worth of mark — which one tile holds exactly — and stopped before
  // neighbouring copies run into each other.
  let tileMass = 0
  for (let j = 0; j < th; j++) {
    for (let i = 0; i < tw; i++) {
      const a = alpha[j * tw + i]
      if (!(a > 0.08)) continue
      const x = tx0 + i
      const y = ty0 + j
      const fa = t.i00 * x + t.i01 * y
      const fb = t.i10 * x + t.i11 * y
      if (fa >= 0 && fa < 1 && fb >= 0 && fb < 1) tileMass += a
    }
  }
  const dist = distanceTo(on, S, S)
  const label = new Int32Array(S * S)
  const stack = []
  const biggest = (r) => {
    label.fill(0)
    let top = null
    for (let s = 0; s < S * S; s++) {
      if (dist[s] > r || label[s]) continue
      label[s] = 1
      stack.push(s)
      let mass = 0
      let edge = false
      let mx = 0
      let my = 0
      const members = []
      while (stack.length) {
        const k = stack.pop()
        const x = k % S
        const y = (k - x) / S
        if (x === 0 || y === 0 || x === S - 1 || y === S - 1) edge = true
        if (on[k]) {
          const a = map[k]
          mass += a
          mx += a * x
          my += a * y
          members.push(k)
        }
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const xx = x + dx
            const yy = y + dy
            if (xx < 0 || yy < 0 || xx >= S || yy >= S) continue
            const q = yy * S + xx
            if (dist[q] <= r && !label[q]) { label[q] = 1; stack.push(q) }
          }
        }
      }
      if (!edge && mass > 0 && (!top || mass > top.mass)) top = { mass, mx: mx / mass, my: my / mass, members }
    }
    return top
  }
  let best = null
  for (const r of [2, 3, 4, 6, 8, 11, 15, 20, 28]) {
    if (r > reach * 0.35) break
    const c = biggest(r)
    if (!c) continue
    if (tileMass && c.mass > tileMass * 1.25) break
    best = c
    if (!tileMass || c.mass >= tileMass * 0.8) break
  }

  let angle = 0
  let cx = 0
  let cy = 0
  if (best) {
    let sxx = 0
    let syy = 0
    let sxy = 0
    for (const k of best.members) {
      const a = map[k]
      const dx = (k % S) - best.mx
      const dy = Math.floor(k / S) - best.my
      sxx += a * dx * dx
      syy += a * dy * dy
      sxy += a * dx * dy
    }
    angle = (0.5 * Math.atan2(2 * sxy, sxx - syy) * 180) / Math.PI
    cx = best.mx - R
    cy = best.my - R
  }
  if (angle <= -90) angle += 180
  if (angle > 90) angle -= 180

  const shortest = Math.max(1, Math.min(Math.hypot(...v1), Math.hypot(...v2)))
  const K = Math.ceil(Math.hypot(w, h) / shortest) + 2
  let count = 0
  for (let n = -K; n <= K; n++) {
    for (let m = -K; m <= K; m++) {
      const x = cx + m * v1[0] + n * v2[0]
      const y = cy + m * v1[1] + n * v2[1]
      if (x >= 0 && x < w && y >= 0 && y < h) count++
    }
  }
  return { angle: Math.round(angle * 10) / 10, count }
}

/**
 * The whole search: is there a repeated mark, on what grid, and what is it.
 * `rgba` at whatever size it should be worked at; the grid and the tile come
 * back in that picture's pixels.
 */
export async function detectWatermark(rgba, w, h, { tick = null } = {}) {
  const small = downscale(rgba, w, h, 400)
  const f = featureOf(luma(small.data, small.w, small.h), small.w, small.h)
  const lat = findLattice(autocorrelation(f, small.w, small.h), small.w, small.h)
  if (!lat || lat.strength < 0.12) return { ok: false, reason: 'none', strength: lat?.strength || 0 }
  if (tick) await tick()
  const kx = w / small.w
  const ky = h / small.h
  const F = featureOf(luma(rgba, w, h), w, h)
  const v1 = refineVector(F, w, h, [lat.v1[0] * kx, lat.v1[1] * ky])
  const v2 = refineVector(F, w, h, [lat.v2[0] * kx, lat.v2[1] * ky])
  const est = await estimateWatermark(rgba, w, h, { v1, v2 }, { tick })
  if (!est.ok) return { ...est, strength: lat.strength }
  const d = describe(est.alpha, est.tile, w, h)
  const { tx0, ty0, tw, th } = est.tile
  return {
    ok: true, v1, v2, tx0, ty0, tw, th, alpha: est.alpha, color: est.color,
    angle: d.angle, count: d.count, strength: lat.strength, coverage: est.coverage, fit: est.fit,
  }
}

// ---- taking it off --------------------------------------------------------------------

// Pixels too nearly covered to recover, filled from the outside in: each ring
// takes the average of the finished pixels next to it. The mark's opaque parts
// are its thin strokes, and a thin hole closed this way is invisible.
function fillInOrder(rgba, hole, w, h) {
  const done = new Uint8Array(w * h)
  for (let i = 0; i < done.length; i++) done[i] = hole[i] ? 0 : 1
  const queued = new Uint8Array(w * h)
  let front = []
  for (let i = 0; i < done.length; i++) {
    if (done[i]) continue
    const x = i % w
    const y = (i - x) / w
    let near = false
    for (let dy = -1; dy <= 1 && !near; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const xx = x + dx
        const yy = y + dy
        if (xx >= 0 && yy >= 0 && xx < w && yy < h && done[yy * w + xx]) { near = true; break }
      }
    }
    if (near) { queued[i] = 1; front.push(i) }
  }
  while (front.length) {
    const ring = front
    front = []
    const vals = new Float32Array(ring.length * 4)
    ring.forEach((i, k) => {
      const x = i % w
      const y = (i - x) / w
      let n = 0
      const acc = [0, 0, 0, 0]
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx
          const yy = y + dy
          if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue
          const j = yy * w + xx
          if (!done[j]) continue
          for (let c = 0; c < 4; c++) acc[c] += rgba[j * 4 + c]
          n++
        }
      }
      for (let c = 0; c < 4; c++) vals[k * 4 + c] = n ? acc[c] / n : rgba[i * 4 + c]
    })
    ring.forEach((i, k) => {
      for (let c = 0; c < 4; c++) rgba[i * 4 + c] = vals[k * 4 + c]
      done[i] = 1
    })
    for (const i of ring) {
      const x = i % w
      const y = (i - x) / w
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx
          const yy = y + dy
          if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue
          const j = yy * w + xx
          if (!done[j] && !queued[j]) { queued[j] = 1; front.push(j) }
        }
      }
    }
  }
}

/**
 * Takes the mark off a picture, in place.
 *
 * `model` holds the grid and the tile in the pixels of the picture the mark was
 * found in; `sx` and `sy` say how many of those pixels one pixel of *this*
 * picture spans, so a mark found in a working copy comes off the full-size
 * original.
 */
export function deblend(rgba, w, h, model) {
  const t = tileOf(model)
  const { tw, th, tx0, ty0 } = t
  const A = model.alpha
  const W = model.color
  const sx = model.sx || 1
  const sy = model.sy || 1
  const N = w * h
  const hole = new Uint8Array(N)
  const amap = new Float32Array(N)
  let any = false
  for (let y = 0; y < h; y++) {
    const ey = (y + 0.5) * sy - 0.5
    for (let x = 0; x < w; x++) {
      const ex = (x + 0.5) * sx - 0.5
      const [fx, fy] = fold(t, ex, ey)
      const u = clamp(fx - tx0, 0, tw - 1)
      const v = clamp(fy - ty0, 0, th - 1)
      const al = bilinear(A, tw, th, u, v)
      if (al < 0.004) continue
      const i = y * w + x
      amap[i] = al
      const k = 1 / (1 - Math.min(al, 0.97))
      const p = i * 4
      for (let c = 0; c < 3; c++) rgba[p + c] = (rgba[p + c] - al * W[c]) * k
      if (al >= 0.6) { hole[i] = 1; any = true }
    }
  }
  if (!any) return rgba
  // Where the mark is nearly solid, subtracting it leaves mostly noise scaled
  // up; the fill from around takes over as the mark gets more opaque.
  const filled = new Uint8ClampedArray(rgba)
  fillInOrder(filled, hole, w, h)
  for (let i = 0; i < N; i++) {
    if (!hole[i]) continue
    const s0 = clamp((amap[i] - 0.6) / 0.25, 0, 1)
    const s = s0 * s0 * (3 - 2 * s0)
    const p = i * 4
    for (let c = 0; c < 3; c++) rgba[p + c] = rgba[p + c] * (1 - s) + filled[p + c] * s
  }
  return rgba
}

// ---- keeping it ---------------------------------------------------------------------

function toB64(u8) {
  let s = ''
  for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000))
  return btoa(s)
}
function fromB64(s) {
  const bin = atob(s)
  const u = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i)
  return u
}

/** The tile's opacity, as a short string: a byte a pixel, deflated. */
export function packAlpha(alpha) {
  const u = new Uint8Array(alpha.length)
  for (let i = 0; i < u.length; i++) u[i] = Math.round(clamp(alpha[i], 0, 1) * 255)
  return toB64(zlibSync(u, { level: 9 }))
}

export function unpackAlpha(s) {
  const u = unzlibSync(fromB64(s))
  const out = new Float32Array(u.length)
  for (let i = 0; i < u.length; i++) out[i] = u[i] / 255
  return out
}

/**
 * A found mark as it is kept on a layer. The grid and tile stay in the pixels
 * of the copy they were found in; `sx`/`sy` are how many of those pixels one
 * pixel of the original picture spans.
 */
export function toStored(found, sx = 1, sy = 1) {
  return {
    on: true,
    v1: found.v1,
    v2: found.v2,
    tx0: found.tx0,
    ty0: found.ty0,
    tw: found.tw,
    th: found.th,
    sx,
    sy,
    alpha: packAlpha(found.alpha),
    color: found.color,
    angle: found.angle,
    count: found.count,
  }
}

/** The stored form, ready to take the mark off. */
export const fromStored = (d) => ({ ...d, alpha: unpackAlpha(d.alpha) })
