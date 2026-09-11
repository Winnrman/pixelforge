// Watermarks: finding a mark repeated across a picture, and taking it off.
//
// A watermark is laid over a picture again and again — tilted, often, and
// faint, so as to spoil the picture without hiding it. Both of those are what
// give it away. Repeated means the picture looks like itself shifted from one
// copy to the next, which an autocorrelation finds. And laid *over* means every
// copy is the same mark on top of a different piece of picture: line the
// copies up and take the middle value, and the picture — different under every
// copy — cancels, while the mark, the same under every copy, stays.
//
// What comes out is the mark itself — how opaque it is at every pixel, and
// what colour — and where each copy of it sits. A faint mark is then taken off
// exactly rather than painted over: if a pixel is 35% white over the picture,
// the picture is what is left when the 35% white is subtracted and the rest
// scaled back up. That is the real picture underneath, not an estimate of it.
// Only where the mark is nearly opaque, and too little picture is left to
// recover, are pixels filled from around instead.
//
// Copies are found two ways. Stamped on a regular grid, the grid is found and
// every copy follows from it, including the ones half off the edge. Placed by
// hand or by a generator that jitters them, the mark is cut out of the picture
// and looked for everywhere. Either way what is kept is the same thing: one
// copy of the mark and the list of places it went.

import { fft2d, nextPow2 } from './fft.js'
import { pushPull, dilate, distanceTo } from './heal.js'
import { zlibSync, unzlibSync } from 'fflate'

export const hasDewater = (l) => !!l?.dewater?.on

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v))

// The worst agreement between copies a removal is trusted with. A mark read
// right makes every copy agree on its opacity to within a quarter or so; past
// this the grid or the copies were wrong, and taking off what was found would
// smear the picture rather than clean it.
const TRUSTED_FIT = 0.45

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
// indices, and must be inside the grid.
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

function parabola(l, c, r) {
  const d = l - 2 * c + r
  return d < 0 ? clamp((0.5 * (l - r)) / d, -0.5, 0.5) : 0
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

// A running box sum over a square grid that wraps at its edges, which is what
// a spectrum does.
function wrapBox(src, P, r) {
  const tmp = new Float64Array(P * P)
  const out = new Float64Array(P * P)
  const n = 2 * r + 1
  for (let y = 0; y < P; y++) {
    let s = 0
    for (let k = -r; k <= r; k++) s += src[y * P + ((k + P) % P)]
    for (let x = 0; x < P; x++) {
      tmp[y * P + x] = s / n
      s += src[y * P + ((x + r + 1) % P)] - src[y * P + ((x - r + P) % P)]
    }
  }
  for (let x = 0; x < P; x++) {
    let s = 0
    for (let k = -r; k <= r; k++) s += tmp[((k + P) % P) * P + x]
    for (let y = 0; y < P; y++) {
      out[y * P + x] = s / n
      s += tmp[((y + r + 1) % P) * P + x] - tmp[((y - r + P) % P) * P + x]
    }
  }
  return out
}

/**
 * How much the picture's *repeating* part resembles itself at every shift, as
 * a function `(dx, dy) -> -1..1`.
 *
 * Not the picture's own autocorrelation, which on a busy photograph —
 * clouds, a mountain range, foliage — is all texture, and texture resembles
 * itself at every short shift and at no long one. A mark stamped again and
 * again shows in the spectrum as sharp spikes standing far above everything
 * round them; the photograph's detail is a smooth spread with no spikes in it.
 * So only the spikes are kept — power well above the spectrum's own local
 * level — and the correlation is made from those alone. What comes back is
 * the repetition, with the photograph taken out of it.
 *
 * Padded so no shift wraps round into itself, tapered at the edges so the
 * picture's border does not paint a false cross through the spectrum, and each
 * shift divided by how much of the picture overlapped at it.
 */
export function autocorrelation(f, w, h) {
  const P = nextPow2(Math.ceil(Math.max(w, h) * 2))
  const re = new Float64Array(P * P)
  const im = new Float64Array(P * P)
  const taper = (i, n) => {
    const e = Math.max(1, Math.round(n * 0.08))
    return i < e ? 0.5 - 0.5 * Math.cos((Math.PI * i) / e)
      : i >= n - e ? 0.5 - 0.5 * Math.cos((Math.PI * (n - 1 - i)) / e) : 1
  }
  for (let y = 0; y < h; y++) {
    const ty = taper(y, h)
    for (let x = 0; x < w; x++) re[y * P + x] = f[y * w + x] * ty * taper(x, w)
  }
  fft2d(re, im, P, P, false)
  for (let i = 0; i < re.length; i++) {
    re[i] = re[i] * re[i] + im[i] * im[i]
    im[i] = 0
  }
  const level = wrapBox(re, P, Math.max(4, Math.round(P / 128)))
  // The broad shapes of the picture live at the lowest frequencies, where the
  // spectrum is steep and "above the local level" means nothing.
  const low = Math.max(2, Math.round(P / 256))
  for (let y = 0; y < P; y++) {
    const fy = Math.min(y, P - y)
    for (let x = 0; x < P; x++) {
      const i = y * P + x
      const fx = Math.min(x, P - x)
      re[i] = fx <= low && fy <= low ? 0 : Math.max(0, re[i] - 4 * level[i])
    }
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

/** The shifts at which the picture most resembles itself, strongest first. */
export function peaksOf(ac, w, h, { minPeriod = 5, floor = 0.1, limit = 40 } = {}) {
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
  peaks.sort((a, b) => b.s - a.s)
  return peaks.slice(0, limit)
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

/**
 * The grid of a repeated mark, from the autocorrelation: the peaks it makes,
 * and the two shortest steps that explain them. Null when nothing repeats on a
 * grid — which is not the same as nothing repeating.
 */
export function findLattice(ac, w, h, opts = {}) {
  const peaks = peaksOf(ac, w, h, opts)
  if (!peaks.length) return null
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
  const cands = peaks.filter((p) => p.s >= best * 0.3)
  for (const p of cands) p.h = holds(p.v)
  const hold = Math.max(...cands.map((p) => p.h))
  if (!(hold > 0)) return null
  // The shortest of the steps that hold up nearly as well as the best: a step
  // of two tiles holds as well as a step of one, and one tile is the answer.
  const first = cands.filter((p) => p.h >= hold * 0.7).sort((a, b) => norm2(a.v) - norm2(b.v))[0]
  const second = cands.filter((p) => p !== first && p.h >= first.h * 0.5
    && Math.abs(first.v[0] * p.v[1] - first.v[1] * p.v[0]) / Math.sqrt(norm2(first.v) * norm2(p.v)) > 0.3)
    .sort((a, b) => norm2(a.v) - norm2(b.v))[0]
  // A mark stamped on a grid repeats in two directions. One direction alone is
  // a row of something in the picture — a fence, a line of windows — far more
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

// ---- a grid's tile -------------------------------------------------------------------

/**
 * One tile of a grid: the parallelogram the two steps span from the origin,
 * boxed, with a pixel to spare round it, in the picture's own pixels.
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

/** Every grid step that carries some pixel of the tile into the picture. */
export function stepsInto(t, w, h) {
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
      if (dx >= xlo && dx <= xhi && dy >= ylo && dy <= yhi) out.push([dx, dy])
    }
  }
  return out
}

// ---- copies placed anywhere ----------------------------------------------------------

// Cross-correlation by FFT: sum over u of a(x + u) b(u), for every x.
function spectrum(src, sw, sh, P) {
  const re = new Float64Array(P * P)
  const im = new Float64Array(P * P)
  for (let y = 0; y < sh; y++) for (let x = 0; x < sw; x++) re[y * P + x] = src[y * sw + x]
  fft2d(re, im, P, P, false)
  return { re, im }
}
function correlate(A, B, P) {
  const re = new Float64Array(P * P)
  const im = new Float64Array(P * P)
  for (let i = 0; i < re.length; i++) {
    re[i] = A.re[i] * B.re[i] + A.im[i] * B.im[i]
    im[i] = A.im[i] * B.re[i] - A.re[i] * B.im[i]
  }
  fft2d(re, im, P, P, true)
  return re
}

/**
 * How well a template matches the picture with its corner at every position,
 * as a normalised correlation -1..1 — including positions where the template
 * hangs off the edge, measured on the part of it that is still on the
 * picture. The copies of a mark at the border are copies too, and have to come
 * off with the rest.
 */
export function matchMap(f, w, h, T, bw, bh) {
  const P = nextPow2(Math.max(w + bw, h + bh))
  const ones = new Float32Array(w * h).fill(1)
  const T2 = Float32Array.from(T, (v) => v * v)
  const Ff = spectrum(f, w, h, P)
  const Fm = spectrum(ones, w, h, P)
  const FT = spectrum(T, bw, bh, P)
  const FT2 = spectrum(T2, bw, bh, P)
  const A1 = correlate(Ff, FT, P)
  const A2 = correlate(Fm, FT, P)
  const A3 = correlate(Fm, FT2, P)
  const S1 = new Float64Array((w + 1) * (h + 1))
  const S2 = new Float64Array((w + 1) * (h + 1))
  for (let y = 0; y < h; y++) {
    let r1 = 0
    let r2 = 0
    for (let x = 0; x < w; x++) {
      const v = f[y * w + x]
      r1 += v
      r2 += v * v
      S1[(y + 1) * (w + 1) + x + 1] = S1[y * (w + 1) + x + 1] + r1
      S2[(y + 1) * (w + 1) + x + 1] = S2[y * (w + 1) + x + 1] + r2
    }
  }
  const rect = (S, x0, y0, x1, y1) => S[y1 * (w + 1) + x1] - S[y0 * (w + 1) + x1] - S[y1 * (w + 1) + x0] + S[y0 * (w + 1) + x0]
  const full = bw * bh
  return (ax, ay, minShare = 0.35) => {
    const x0 = Math.max(0, ax)
    const y0 = Math.max(0, ay)
    const x1 = Math.min(w, ax + bw)
    const y1 = Math.min(h, ay + bh)
    const n = (x1 - x0) * (y1 - y0)
    if (x1 <= x0 || y1 <= y0 || n < full * minShare) return -1
    const idx = (((ay % P) + P) % P) * P + (((ax % P) + P) % P)
    const s1 = rect(S1, x0, y0, x1, y1)
    const s2 = rect(S2, x0, y0, x1, y1)
    const num = A1[idx] - (s1 * A2[idx]) / n
    const vi = s2 - (s1 * s1) / n
    const vt = A3[idx] - (A2[idx] * A2[idx]) / n
    return vi > 1e-9 && vt > 1e-9 ? num / Math.sqrt(vi * vt) : -1
  }
}

/**
 * Copies of a mark that are not on a grid: found by what the picture agrees
 * with itself about.
 *
 * The strongest shifts in the autocorrelation are the ones that carry one copy
 * onto another. Wherever the picture's detail agrees with itself under those
 * shifts is mark — the photograph agrees with itself only by chance, and the
 * chances cancel over a dozen shifts. The most complete piece of that is one
 * copy; cut out, it is matched against the whole picture, and every place it
 * matches well is a copy.
 */
export function findCopies(f, w, h, ac) {
  const peaks = peaksOf(ac, w, h, { floor: 0.05, limit: 16 })
  if (!peaks.length) return null
  const A = new Float32Array(w * h)
  for (const p of peaks.slice(0, 12)) {
    const dx = Math.round(p.v[0])
    const dy = Math.round(p.v[1])
    for (let y = Math.max(0, -dy); y < Math.min(h, h - dy); y++) {
      for (let x = Math.max(0, -dx); x < Math.min(w, w - dx); x++) {
        const i = y * w + x
        const j = (y + dy) * w + x + dx
        const v = p.s * f[i] * f[j]
        A[i] += v
        A[j] += v
      }
    }
  }
  const As = blur1(A, w, h, 2)
  let top = 0
  for (let i = 0; i < As.length; i++) if (As[i] > top) top = As[i]
  if (!(top > 0)) return null
  const on = new Uint8Array(w * h)
  for (let i = 0; i < on.length; i++) on[i] = As[i] > top * 0.3 ? 1 : 0
  const joined = dilate(on, w, h, 3)

  // The most mark, in one piece, wholly on the picture.
  const label = new Uint8Array(w * h)
  const stack = []
  let best = null
  for (let s = 0; s < w * h; s++) {
    if (!joined[s] || label[s]) continue
    label[s] = 1
    stack.push(s)
    let mass = 0
    let edge = false
    let x0 = w
    let y0 = h
    let x1 = -1
    let y1 = -1
    while (stack.length) {
      const k = stack.pop()
      const x = k % w
      const y = (k - x) / w
      if (x === 0 || y === 0 || x === w - 1 || y === h - 1) edge = true
      if (on[k]) {
        mass += As[k]
        x0 = Math.min(x0, x)
        y0 = Math.min(y0, y)
        x1 = Math.max(x1, x)
        y1 = Math.max(y1, y)
      }
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx
          const yy = y + dy
          if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue
          const q = yy * w + xx
          if (joined[q] && !label[q]) { label[q] = 1; stack.push(q) }
        }
      }
    }
    if (!edge && x1 > x0 + 4 && y1 > y0 + 4 && (!best || mass > best.mass)) best = { mass, x0, y0, x1, y1 }
  }
  if (!best) return null

  let bx0 = Math.max(0, best.x0 - 2)
  let by0 = Math.max(0, best.y0 - 2)
  let bw = Math.min(w, best.x1 + 3) - bx0
  let bh = Math.min(h, best.y1 + 3) - by0
  const T = new Float32Array(bw * bh)
  for (let y = 0; y < bh; y++) for (let x = 0; x < bw; x++) T[y * bw + x] = f[(y + by0) * w + x + bx0]
  let hits = matches(f, w, h, T, bw, bh, 0.4)
  if (hits.length < 3) return null

  // A second look, with a better picture of the mark. The first template was
  // cut from one copy, ground and all, and a copy over different ground
  // matches it poorly — over busy ground, not at all. The copies already found,
  // lined up, say what the mark is without its ground: the photograph is
  // different under each and its middle value is nothing, the mark is the same
  // under each and its middle value is the mark. Taken a little wider than the
  // first cut, so a mark only partly found the first time is found whole.
  const ex = Math.round(bw * 0.3) + 2
  const ey = Math.round(bh * 0.3) + 2
  const ew = bw + 2 * ex
  const eh = bh + 2 * ey
  const med = new Float32Array(ew * eh)
  const vals = new Float64Array(hits.length)
  for (let j = 0; j < eh; j++) {
    for (let i = 0; i < ew; i++) {
      let n = 0
      for (const [hx, hy] of hits) {
        const x = Math.round(hx) - ex + i
        const y = Math.round(hy) - ey + j
        if (x >= 0 && y >= 0 && x < w && y < h) vals[n++] = f[y * w + x]
      }
      med[j * ew + i] = n >= 3 ? medianOf(vals, n) : 0
    }
  }
  let kx0 = ew
  let ky0 = eh
  let kx1 = -1
  let ky1 = -1
  for (let j = 0; j < eh; j++) {
    for (let i = 0; i < ew; i++) {
      if (Math.abs(med[j * ew + i]) < 0.2) { med[j * ew + i] = 0; continue }
      kx0 = Math.min(kx0, i)
      ky0 = Math.min(ky0, j)
      kx1 = Math.max(kx1, i)
      ky1 = Math.max(ky1, j)
    }
  }
  if (kx1 > kx0 + 4 && ky1 > ky0 + 4) {
    kx0 = Math.max(0, kx0 - 2)
    ky0 = Math.max(0, ky0 - 2)
    kx1 = Math.min(ew - 1, kx1 + 2)
    ky1 = Math.min(eh - 1, ky1 + 2)
    const nw = kx1 - kx0 + 1
    const nh = ky1 - ky0 + 1
    const T2 = new Float32Array(nw * nh)
    for (let j = 0; j < nh; j++) for (let i = 0; i < nw; i++) T2[j * nw + i] = med[(j + ky0) * ew + i + kx0]
    const again = matches(f, w, h, T2, nw, nh, 0.3)
    if (again.length >= hits.length) {
      hits = again
      bx0 = bx0 - ex + kx0
      by0 = by0 - ey + ky0
      bw = nw
      bh = nh
    }
  }
  if (hits.length < 4) return null
  return { box: [bx0, by0, bw, bh], offsets: hits.map(([x, y]) => [x - bx0, y - by0]) }
}

// Every place a template matches at least `floor`, keeping the best of any
// that crowd each other, to a fraction of a pixel.
function matches(f, w, h, T, bw, bh, floor) {
  const score = matchMap(f, w, h, T, bw, bh)
  const ax0 = -Math.floor(bw * 0.65)
  const ay0 = -Math.floor(bh * 0.65)
  const gw = w - ax0
  const gh = h - ay0
  const grid = new Float32Array(gw * gh).fill(-1)
  for (let ay = ay0; ay < h; ay++) for (let ax = ax0; ax < w; ax++) grid[(ay - ay0) * gw + ax - ax0] = score(ax, ay)
  // Copies of a mark do not overlap, so two matches closer than most of the
  // mark's length are one copy — and a word matched two letters along, which
  // a word of evenly spaced letters partly does, is not a second copy.
  const R = Math.max(4, Math.round(Math.max(bw, bh) * 0.7))
  const hits = []
  for (let gy = 0; gy < gh; gy++) {
    for (let gx = 0; gx < gw; gx++) {
      const v = grid[gy * gw + gx]
      if (v < floor) continue
      let top = true
      for (let j = -R; j <= R && top; j++) {
        const yy = gy + j
        if (yy < 0 || yy >= gh) continue
        for (let i = -R; i <= R; i++) {
          const xx = gx + i
          if (xx < 0 || xx >= gw || (!i && !j)) continue
          const u = grid[yy * gw + xx]
          if (u > v || (u === v && (j < 0 || (j === 0 && i < 0)))) { top = false; break }
        }
      }
      if (!top) continue
      const at = (i, j) => (gx + i >= 0 && gx + i < gw && gy + j >= 0 && gy + j < gh ? grid[(gy + j) * gw + gx + i] : v)
      hits.push([gx + ax0 + parabola(at(-1, 0), v, at(1, 0)), gy + ay0 + parabola(at(0, -1), v, at(0, 1))])
    }
  }
  return hits
}

/**
 * Copies found in the small working picture, placed exactly in the big one:
 * each moved the pixel or two that makes it agree best with the first.
 */
function refineCopies(F, w, h, box, offsets, radius) {
  const [bx0, by0, bw, bh] = box
  const corr = (dx, dy) => {
    let s = 0
    let sa = 0
    let sb = 0
    let n = 0
    for (let y = 0; y < bh; y += 2) {
      const ty = by0 + y
      const cy = ty + dy
      if (cy < 0 || cy >= h) continue
      for (let x = 0; x < bw; x += 2) {
        const tx = bx0 + x
        const cx = tx + dx
        if (cx < 0 || cx >= w) continue
        const a = F[ty * w + tx]
        const b = F[cy * w + cx]
        s += a * b
        sa += a * a
        sb += b * b
        n++
      }
    }
    return n > 8 && sa > 0 && sb > 0 ? s / Math.sqrt(sa * sb) : -1
  }
  return offsets.map(([ox, oy]) => {
    if (!ox && !oy) return [0, 0]
    const cx = Math.round(ox)
    const cy = Math.round(oy)
    let bx = cx
    let by = cy
    let bv = corr(cx, cy)
    for (let j = -radius; j <= radius; j++) {
      for (let i = -radius; i <= radius; i++) {
        const v = corr(cx + i, cy + j)
        if (v > bv) { bv = v; bx = cx + i; by = cy + j }
      }
    }
    return [bx + parabola(corr(bx - 1, by), bv, corr(bx + 1, by)), by + parabola(corr(bx, by - 1), bv, corr(bx, by + 1))]
  })
}

// ---- what the mark is ----------------------------------------------------------------

/**
 * What the mark is, from a picture and where its copies are: its opacity at
 * every pixel of one copy's box, and its colour.
 *
 * In three passes. First, at every pixel of the box, the fine detail of all
 * the copies is lined up and the middle value taken: where the mark is, every
 * copy agrees; everywhere else the picture varies, and the middle value is
 * nothing much. That says *where* the mark is. Then the mark's pixels are
 * filled from around, which says roughly what the picture under each copy was.
 * Then the colour is the one that makes the mark's opacity come out the same
 * under every copy — try white, and a copy over sky and a copy over shadow
 * agree on how faint the mark is; try the wrong colour, and they cannot.
 *
 * `copies` is `{ box: [x0, y0, w, h], offsets: [[dx, dy], ...] }`: one box in
 * the picture, and the shifts that carry it onto every copy.
 */
export async function estimateCopies(rgba, w, h, copies, { tick = null } = {}) {
  const [tx0, ty0, tw, th] = copies.box
  const offs = copies.offsets
  const T = tw * th
  const N = w * h
  const S = offs.length

  // Fine detail per channel: the picture minus a blur a little wider than a
  // stroke of the mark.
  const r = clamp(Math.round(Math.min(tw, th) * 0.12), 3, 40)
  const D = [0, 1, 2].map((c) => {
    const ch = channel(rgba, N, c)
    const bl = blur1(ch, w, h, r)
    for (let i = 0; i < N; i++) ch[i] -= bl[i]
    return ch
  })
  const Y = luma(rgba, w, h)
  if (tick) await tick()

  const px = new Float64Array(S)
  const py = new Float64Array(S)
  const copiesOf = (q) => {
    const qx = tx0 + (q % tw)
    const qy = ty0 + Math.floor(q / tw)
    let n = 0
    for (let k = 0; k < S; k++) {
      const x = qx + offs[k][0]
      const y = qy + offs[k][1]
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
  for (let q = 0; q < T; q++) {
    const n = copiesOf(q)
    if (n < 3) continue
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

  const mark = new Uint8Array(T)
  let marked = 0
  let usable = 0
  for (let q = 0; q < T; q++) {
    if (!valid[q]) continue
    usable++
    if (mag[q] > 8 && mag[q] > 1.5 * spread[q]) { mark[q] = 1; marked++ }
  }
  const coverage = usable ? marked / usable : 0
  if (coverage < 0.005) return { ok: false, reason: 'faint' }
  // A mark covers some of its box. Something that covers most of it, or a
  // picture that is the same under every copy even where there is no mark, is
  // a pattern in the picture — tiles, a fence, a fabric — and not laid on it.
  if (coverage > 0.6) return { ok: false, reason: 'periodic' }
  let nOut = 0
  const outVary = new Float64Array(usable)
  for (let q = 0; q < T; q++) if (valid[q] && !mark[q]) outVary[nOut++] = vary[q]
  if (medianOf(outVary, nOut) < 8) return { ok: false, reason: 'periodic' }

  // Out into the picture: every pixel of every copy that is on the mark.
  let hole = new Uint8Array(N)
  for (const [ox, oy] of offs) {
    for (let q = 0; q < T; q++) {
      if (!mark[q]) continue
      const x = Math.round(tx0 + (q % tw) + ox)
      const y = Math.round(ty0 + Math.floor(q / tw) + oy)
      if (x >= 0 && y >= 0 && x < w && y < h) hole[y * w + x] = 1
    }
  }
  hole = dilate(hole, w, h, 2)
  const J0 = new Uint8ClampedArray(rgba)
  pushPull(J0, hole, w, h)
  if (tick) await tick()

  // Which way each point of the mark pushes the picture: towards a light
  // colour or a dark one. A mark is often both — white letters with a dark
  // edge or shadow so they show on white sky too — and a mark read as one
  // colour leaves the other behind, a dark ghost round every letter.
  const YJ = luma(J0, w, h)
  const way = (q) => {
    const n = copiesOf(q)
    for (let s = 0; s < n; s++) scratch[s] = bilinear(Y, w, h, px[s], py[s]) - bilinear(YJ, w, h, px[s], py[s])
    const m = medianOf(scratch, n)
    return m > 2 ? 1 : m < -2 ? -1 : 0
  }
  const dir = new Int8Array(T)
  for (let q = 0; q < T; q++) if (mark[q]) dir[q] = way(q)
  const coreOf = (d) => {
    const c = []
    for (let q = 0; q < T; q++) if (mark[q] && dir[q] === d) c.push(q)
    c.sort((p, q) => mag[q] - mag[p])
    c.length = Math.max(Math.min(c.length, 10), Math.round(c.length * 0.4))
    return c
  }
  const sides = [{ d: 1, core: coreOf(1) }, { d: -1, core: coreOf(-1) }].sort((a, b) => b.core.length - a.core.length)
  const samp = new Float64Array(Math.max(9, S * 3))
  const ratios = (q, W, minGap) => {
    const n = copiesOf(q)
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
  const tryColour = (W, core) => {
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
  const bestColour = (core) => {
    let colour = null
    let fit = Infinity
    for (let g = 0; g <= 255; g += 15) {
      const s = tryColour([g, g, g], core)
      if (s < fit) { fit = s; colour = [g, g, g] }
    }
    return { colour, fit }
  }
  // The main colour from whichever way most of the mark pushes; the other,
  // if there is enough of it to matter, as the mark's shade.
  const main = sides[0].core.length ? bestColour(sides[0].core) : { colour: null, fit: Infinity }
  // Not judged here. One colour's opacity read on its own disagrees from
  // copy to copy wherever the mark's other colour is under it — letters over
  // their own shadow — so a two-colour mark would be turned away before its
  // second colour was ever looked at. The whole reading is judged at the end.
  if (!main.colour) return { ok: false, reason: 'not-a-blend', fit: main.fit }
  const marked2 = sides[0].core.length + sides[1].core.length
  let shadeSide = null
  if (sides[1].core.length >= Math.max(5, marked2 * 0.08)) {
    const s = bestColour(sides[1].core)
    // Loosely: the shade is read over its own letters as much as beside them,
    // so on its own it agrees poorly, and the reading as a whole is what counts.
    if (s.colour && s.fit <= 1.5) shadeSide = { d: sides[1].d, ...s }
  }
  // The mark's opacity at every pixel of the box whose copies fall on it.
  // Two colours are two layers, and where they overlap the order they were
  // laid in matters. A mark's lettering goes over its own shadow or outline,
  // and the lettering is the light part far more often than the dark — so the
  // lighter colour is taken as the top layer, whichever has more of the mark.
  let top = main
  let under = shadeSide
  if (under && under.colour[0] > top.colour[0]) [top, under] = [under, top]
  const W = top.colour
  const Sc = under ? under.colour : null
  const alpha = new Float32Array(T)
  const shade = Sc ? new Float32Array(T) : null
  // The one-colour reading, kept to compare: a second colour has to earn its
  // place, or texture under a one-colour mark becomes a "shade" of noise.
  const alphaOne = Sc ? new Float32Array(T) : null
  const inHole = new Uint8Array(T)
  for (let q = 0; q < T; q++) {
    if (!valid[q]) continue
    const n = copiesOf(q)
    let inside = 0
    for (let s = 0; s < n; s++) inside += hole[Math.round(py[s]) * w + Math.round(px[s])]
    if (inside >= n * 0.5) inHole[q] = 1
  }
  // One colour: its opacity straight from the copies. Two: each estimated
  // with the other already allowed for, a few times over. Where a letter's
  // edge lies over its own shadow, the letter was laid on picture the shadow
  // had already darkened — measured against the undarkened picture it reads
  // too faint, and whichever colour is not allowed for is left behind.
  const rounds = Sc ? 3 : 1
  for (let round = 0; round < rounds; round++) {
    for (let q = 0; q < T; q++) {
      if (!inHole[q]) continue
      const n = copiesOf(q)
      const b = shade ? shade[q] : 0
      let k = 0
      for (let s = 0; s < n; s++) {
        for (let c = 0; c < 3; c++) {
          const j0 = bilinear(J0, w, h, px[s], py[s], 4, c)
          const under = Sc ? (1 - b) * j0 + b * Sc[c] : j0
          const gap = W[c] - under
          if (Math.abs(gap) > 20) samp[k++] = (bilinear(rgba, w, h, px[s], py[s], 4, c) - under) / gap
        }
      }
      if (k >= 3) {
        const a = medianOf(samp, k)
        alpha[q] = a < 0.015 ? 0 : clamp(a, 0, 0.97)
      }
      if (!shade) continue
      if (round === 0) alphaOne[q] = alpha[q]
      const a = alpha[q]
      k = 0
      for (let s = 0; s < n; s++) {
        for (let c = 0; c < 3; c++) {
          const j0 = bilinear(J0, w, h, px[s], py[s], 4, c)
          const lifted = (bilinear(rgba, w, h, px[s], py[s], 4, c) - a * W[c]) / (1 - a)
          const gap = Sc[c] - j0
          if (Math.abs(gap) > 20) samp[k++] = (lifted - j0) / gap
        }
      }
      if (k >= 3) {
        const v = medianOf(samp, k)
        shade[q] = v < 0.015 ? 0 : clamp(v, 0, 0.97)
      }
    }
    if (tick) await tick()
  }

  // Where a letter lies over its own shadow, both colours are at work in one
  // pixel, and reading one colour's opacity at a time settles on a wrong
  // answer for both. But a pixel covered by both is still a straight line
  // from the picture under it to what is seen: its slope is how much of the
  // picture shows through, its offset how much colour was added. Across the
  // copies — each over different picture — that line can be fitted, and with
  // both colours known, slope and offset give both opacities at once.
  if (shade) {
    const xs = new Float64Array(S * 3)
    const ys = new Float64Array(S * 3)
    const slopes = new Float64Array(Math.min(4096, ((S * 3) * (S * 3 - 1)) / 2) + 1)
    const offs2 = new Float64Array(S * 3)
    for (let q = 0; q < T; q++) {
      if (!inHole[q]) continue
      const n = copiesOf(q)
      let m = 0
      let lo = Infinity
      let hi = -Infinity
      for (let s = 0; s < n; s++) {
        for (let c = 0; c < 3; c++) {
          xs[m] = bilinear(J0, w, h, px[s], py[s], 4, c)
          ys[m] = bilinear(rgba, w, h, px[s], py[s], 4, c)
          lo = Math.min(lo, xs[m])
          hi = Math.max(hi, xs[m])
          m++
        }
      }
      // The picture has to differ enough from copy to copy to draw a line
      // through; where it does not, the one-colour answer stands.
      if (m < 6 || hi - lo < 40) continue
      // Theil-Sen: the median of the slopes between pairs, which a few copies
      // over something odd cannot drag.
      let ns = 0
      const step = Math.max(1, Math.floor((m * (m - 1)) / 2 / slopes.length))
      let pair = 0
      for (let i = 0; i < m && ns < slopes.length; i++) {
        for (let j = i + 1; j < m && ns < slopes.length; j++) {
          if (pair++ % step) continue
          const dx = xs[j] - xs[i]
          if (Math.abs(dx) > 10) slopes[ns++] = (ys[j] - ys[i]) / dx
        }
      }
      if (ns < 5) continue
      const c1 = clamp(medianOf(slopes, ns), 0.03, 1)
      for (let i = 0; i < m; i++) offs2[i] = ys[i] - c1 * xs[i]
      const c0 = medianOf(offs2, m)
      const Wg = W[0]
      const Sg = Sc[0]
      if (Math.abs(Wg - Sg) < 30) continue
      const a = clamp((c0 - Sg * (1 - c1)) / (Wg - Sg), 0, 0.97)
      const b = clamp(1 - c1 / (1 - a), 0, 0.97)
      alpha[q] = a < 0.015 ? 0 : a
      shade[q] = b < 0.015 ? 0 : b
    }
  }

  // How good the whole reading is: take the mark off every copy and ask how
  // much of it is left. Read right, what remains under each copy looks like
  // the picture round it; read wrong, most of the mark's contrast is still
  // there. Measured as what is left over what there was, at the pixels where
  // the mark is plainest.
  const judge = (alpha, shade) => {
  const judged = []
  for (let q = 0; q < T; q++) if (mark[q] && inHole[q]) judged.push(q)
  judged.sort((p, q) => mag[q] - mag[p])
  judged.length = Math.min(judged.length, 600)
  const left = new Float64Array(S)
  const was = new Float64Array(S)
  const perPixel = new Float64Array(Math.max(1, judged.length))
  const perWas = new Float64Array(Math.max(1, judged.length))
  let np = 0
  for (const q of judged) {
    const a = alpha[q]
    const b = shade ? shade[q] : 0
    if (a < 0.015 && b < 0.015) continue
    const n = copiesOf(q)
    let k = 0
    for (let s = 0; s < n; s++) {
      let r = 0
      let m = 0
      for (let c = 0; c < 3; c++) {
        const i0 = bilinear(rgba, w, h, px[s], py[s], 4, c)
        const j0 = bilinear(J0, w, h, px[s], py[s], 4, c)
        let v = i0
        if (a >= 0.015) v = (v - a * W[c]) / (1 - a)
        if (b >= 0.015) v = (v - b * Sc[c]) / (1 - b)
        r += Math.abs(v - j0)
        m += Math.abs(i0 - j0)
      }
      left[k] = r / 3
      was[k] = m / 3
      k++
    }
    if (k < 3) continue
    const mw = Math.max(4, medianOf(was, k))
    perWas[np] = mw
    perPixel[np++] = medianOf(left, k) / mw
  }
  // Totalled, not a median over pixels: a shadow is a minority of a mark's
  // pixels, and a reading that leaves every shadow pixel exactly as it was
  // would not move a median at all.
  let sumLeft = 0
  let sumWas = 0
  for (let i = 0; i < np; i++) {
    sumLeft += perPixel[i] * perWas[i]
    sumWas += perWas[i]
  }
  return sumWas ? sumLeft / sumWas : Infinity
  }
  let fit = judge(alpha, shade)
  let keepShade = !!shade
  const why = {
    light: sides.find((s) => s.d === 1).core.length,
    dark: sides.find((s) => s.d === -1).core.length,
    shadeFit: shadeSide ? +shadeSide.fit.toFixed(3) : null,
    two: shade ? +fit.toFixed(3) : null,
  }
  if (shade) {
    const one = judge(alphaOne, null)
    why.one = +one.toFixed(3)
    if (one <= fit * 1.1) {
      fit = one
      keepShade = false
      alpha.set(alphaOne)
    }
  }
  if (fit > 0.6) return { ok: false, reason: 'not-a-blend', fit, why }
  return {
    ok: true, alpha, color: W, coverage, fit, why,
    ...(keepShade ? { shade, shadeColor: Sc } : {}),
  }
}

// ---- describing it -----------------------------------------------------------------

// The pieces of a mask, joined across gaps of up to `r`, biggest by mass first,
// with whether each touches the edge of the grid.
function blobs(on, weight, S, H, r) {
  const dist = distanceTo(on, S, H)
  const label = new Uint8Array(S * H)
  const stack = []
  const out = []
  for (let s = 0; s < S * H; s++) {
    if (dist[s] > r || label[s]) continue
    label[s] = 1
    stack.push(s)
    let mass = 0
    let mx = 0
    let my = 0
    let edge = false
    const members = []
    while (stack.length) {
      const k = stack.pop()
      const x = k % S
      const y = (k - x) / S
      if (x === 0 || y === 0 || x === S - 1 || y === H - 1) edge = true
      if (on[k]) {
        const a = weight[k]
        mass += a
        mx += a * x
        my += a * y
        members.push(k)
      }
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx
          const yy = y + dy
          if (xx < 0 || yy < 0 || xx >= S || yy >= H) continue
          const q = yy * S + xx
          if (dist[q] <= r && !label[q]) { label[q] = 1; stack.push(q) }
        }
      }
    }
    if (mass > 0) out.push({ mass, mx: mx / mass, my: my / mass, members, edge })
  }
  return out.sort((a, b) => b.mass - a.mass)
}

// The long axis of a shape, in degrees, -90..90: a line of lettering's baseline.
function axisOf(blob, weight, S) {
  let sxx = 0
  let syy = 0
  let sxy = 0
  for (const k of blob.members) {
    const a = weight[k]
    const dx = (k % S) - blob.mx
    const dy = Math.floor(k / S) - blob.my
    sxx += a * dx * dx
    syy += a * dy * dy
    sxy += a * dx * dy
  }
  let angle = (0.5 * Math.atan2(2 * sxy, sxx - syy) * 180) / Math.PI
  if (angle <= -90) angle += 180
  if (angle > 90) angle -= 180
  return Math.round(angle * 10) / 10
}

/**
 * Which way a grid's mark is turned and how many copies of it land on the
 * picture, from one whole copy seen in the picture's own space.
 *
 * A mark can be longer than a step of its grid — a long word on a tight grid —
 * and measured inside one tile it comes out cut into pieces and put back in
 * the wrong order. So it is drawn over a window a few tiles wide, the letters
 * of each copy joined into one shape — joined a step at a time until one shape
 * holds a whole copy's worth of mark, and no further — and the biggest shape
 * wholly inside the window is the copy measured.
 */
export function describe(alpha, t, w, h) {
  const { tw, th, tx0, ty0, v1, v2 } = t
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
  let best = null
  for (const r of [2, 3, 4, 6, 8, 11, 15, 20, 28]) {
    if (r > reach * 0.35) break
    const c = blobs(on, map, S, S, r).find((b) => !b.edge)
    if (!c) continue
    if (tileMass && c.mass > tileMass * 1.25) break
    best = c
    if (!tileMass || c.mass >= tileMass * 0.8) break
  }
  const angle = best ? axisOf(best, map, S) : 0
  const cx = best ? best.mx - R : 0
  const cy = best ? best.my - R : 0
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
  return { angle, count }
}

/** The same for copies placed anywhere: the copy in the box is the one measured. */
export function describeCopies(alpha, copies, w, h) {
  const [bx0, by0, bw, bh] = copies.box
  // Only the mark's solid part: over busy ground the faint edges of the
  // estimate pick up specks of texture, and a speck far from the middle turns
  // a shape's long axis more than a whole letter does.
  let peak = 0
  for (let i = 0; i < alpha.length; i++) if (alpha[i] > peak) peak = alpha[i]
  const floor = Math.max(0.08, peak * 0.35)
  const on = new Uint8Array(bw * bh)
  for (let i = 0; i < on.length; i++) on[i] = alpha[i] > floor ? 1 : 0
  const pieces = blobs(on, alpha, bw, bh, Math.max(3, Math.round(Math.max(bw, bh) * 0.04)))
  if (!pieces.length) return { angle: 0, count: 0 }
  // The copy the box was cut round sits in its middle. Pieces of its
  // neighbours can reach in at the edges, and measured along with it they turn
  // the answer towards wherever the neighbours happen to be.
  const big = pieces[0].mass
  const piece = pieces.filter((p) => p.mass >= big * 0.4)
    .sort((a, b) => Math.hypot(a.mx - bw / 2, a.my - bh / 2) - Math.hypot(b.mx - bw / 2, b.my - bh / 2))[0]
  const cx = bx0 + piece.mx
  const cy = by0 + piece.my
  const count = copies.offsets.filter(([dx, dy]) => cx + dx >= 0 && cx + dx < w && cy + dy >= 0 && cy + dy < h).length
  return { angle: axisOf(piece, alpha, bw), count }
}

/**
 * The whole search: is there a repeated mark, where are its copies, and what
 * is it. `rgba` at whatever size it should be worked at; the copies come back
 * in that picture's pixels.
 */
export async function detectWatermark(rgba, w, h, { tick = null } = {}) {
  // Small pictures are searched as they are: a web-sized proof is already
  // short of pixels, and halving it again loses the strokes of the mark.
  const small = downscale(rgba, w, h, 512)
  const f = featureOf(luma(small.data, small.w, small.h), small.w, small.h)
  const ac = autocorrelation(f, small.w, small.h)
  if (tick) await tick()
  const kx = w / small.w
  const ky = h / small.h
  const F = featureOf(luma(rgba, w, h), w, h)
  const tried = []
  let best = null

  // A grid, when there is one: every copy follows from two steps, the ones
  // half off the edge included.
  const lat = findLattice(ac, small.w, small.h)
  if (lat && lat.strength >= 0.12) {
    const v1 = refineVector(F, w, h, [lat.v1[0] * kx, lat.v1[1] * ky])
    const v2 = refineVector(F, w, h, [lat.v2[0] * kx, lat.v2[1] * ky])
    const t = tileOf({ v1, v2 })
    const copies = { box: [t.tx0, t.ty0, t.tw, t.th], offsets: stepsInto(t, w, h) }
    const est = await estimateCopies(rgba, w, h, copies, { tick })
    tried.push({ ...est, mode: 'grid', copies: copies.offsets.length })
    if (est.ok) {
      const d = describe(est.alpha, t, w, h)
      best = { mode: 'grid', v1, v2, ...copies, ...est, ...d }
    }
  }

  // Copies placed anywhere: looked for when there was no grid, or when the
  // grid did not explain the mark well.
  if (!best || best.fit > TRUSTED_FIT * 0.6) {
    const found = findCopies(f, small.w, small.h, ac)
    if (found) {
      // Out into the full-size picture, with room round the copy: the piece of
      // mark found first may be most of a copy rather than all of it, and a
      // box with a margin lets the rest of it show up as mark too.
      const [sx0, sy0, sw, sh] = found.box
      const mx = Math.round(sw * kx * 0.3) + 2
      const my = Math.round(sh * ky * 0.3) + 2
      const box = [Math.floor(sx0 * kx) - mx, Math.floor(sy0 * ky) - my, Math.ceil(sw * kx) + 2 * mx, Math.ceil(sh * ky) + 2 * my]
      const offsets = refineCopies(F, w, h, box, found.offsets.map(([x, y]) => [x * kx, y * ky]),
        Math.ceil(Math.max(kx, ky)) + 1)
      const copies = { box, offsets }
      const est = await estimateCopies(rgba, w, h, copies, { tick })
      tried.push({ ...est, mode: 'copies', copies: offsets.length })
      if (est.ok && (!best || est.fit < best.fit)) best = { mode: 'copies', ...copies, ...est, ...describeCopies(est.alpha, copies, w, h) }
    }
  }

  if (!best) {
    // Only a mark that was found and then could not be read is "unsure": a
    // photograph whose texture happened to repeat faintly had nothing to find.
    const periodic = tried.some((e) => e.reason === 'periodic')
    const unsure = tried.some((e) => e.reason === 'not-a-blend' && e.fit <= 0.75)
    return {
      ok: false, reason: periodic ? 'periodic' : unsure ? 'unsure' : 'none', strength: lat?.strength || 0,
      tried: tried.map((e) => ({ mode: e.mode, reason: e.reason, fit: e.fit, copies: e.copies })),
    }
  }
  if (best.fit > TRUSTED_FIT) {
    return {
      ok: false, reason: 'unsure', fit: best.fit,
      tried: tried.map((e) => ({ mode: e.mode, reason: e.reason, fit: e.fit, copies: e.copies })),
    }
  }
  return { ok: true, ...best, strength: lat?.strength || 0 }
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
 * `model` is one copy's box and the shifts to every copy, in the pixels of the
 * picture the mark was found in; `sx` and `sy` say how many of those pixels one
 * pixel of *this* picture spans, so a mark found in a working copy comes off
 * the full-size original.
 */
export function deblend(rgba, w, h, model) {
  const [bx0, by0, bw, bh] = model.box
  const A = model.alpha
  const W = model.color
  const B = model.shade || null
  const Sc = model.shadeColor || [0, 0, 0]
  const sx = model.sx || 1
  const sy = model.sy || 1
  const N = w * h
  const amap = new Float32Array(N)
  const smap = B ? new Float32Array(N) : null
  for (const [dx, dy] of model.offsets) {
    const ex0 = bx0 + dx
    const ey0 = by0 + dy
    const X0 = Math.max(0, Math.floor((ex0 + 0.5) / sx - 0.5) - 1)
    const X1 = Math.min(w - 1, Math.ceil((ex0 + bw - 0.5) / sx - 0.5) + 1)
    const Y0 = Math.max(0, Math.floor((ey0 + 0.5) / sy - 0.5) - 1)
    const Y1 = Math.min(h - 1, Math.ceil((ey0 + bh - 0.5) / sy - 0.5) + 1)
    for (let y = Y0; y <= Y1; y++) {
      const v = (y + 0.5) * sy - 0.5 - ey0
      if (v < 0 || v > bh - 1) continue
      for (let x = X0; x <= X1; x++) {
        const u = (x + 0.5) * sx - 0.5 - ex0
        if (u < 0 || u > bw - 1) continue
        const al = bilinear(A, bw, bh, u, v)
        const i = y * w + x
        if (al > amap[i]) amap[i] = al
        if (B) {
          const sh = bilinear(B, bw, bh, u, v)
          if (sh > smap[i]) smap[i] = sh
        }
      }
    }
  }
  const hole = new Uint8Array(N)
  let any = false
  const out = [0, 0, 0]
  for (let i = 0; i < N; i++) {
    const al = amap[i]
    const sh = smap ? smap[i] : 0
    if (al < 0.004 && sh < 0.004) continue
    const most = Math.max(al, sh)
    if (most >= 0.6) { hole[i] = 1; any = true }
    const p = i * 4
    let wrong = false
    // Undone in the reverse of the order it was laid on: the letters came
    // last, over their shade, so they come off first.
    const ka = 1 / (1 - Math.min(al, 0.97))
    const ks = 1 / (1 - Math.min(sh, 0.97))
    for (let c = 0; c < 3; c++) {
      let v = rgba[p + c]
      if (al >= 0.004) v = (v - al * W[c]) * ka
      if (sh >= 0.004) v = (v - sh * Sc[c]) * ks
      out[c] = v
      if (v < -30 || v > 285) wrong = true
    }
    // A pixel the mark cannot account for — darker than a white mark could
    // leave anything — is not the mark's to change. Left as it was rather
    // than pushed to black.
    if (wrong && !hole[i]) { amap[i] = 0; if (smap) smap[i] = 0; continue }
    for (let c = 0; c < 3; c++) rgba[p + c] = out[c]
    if (smap && sh > al) amap[i] = sh
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

/** The mark's opacity, as a short string: a byte a pixel, deflated. */
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

const hundredths = (v) => Math.round(v * 100) / 100

/**
 * A found mark as it is kept on a layer: one copy's box, where every copy
 * went, the mark's opacity and colour, and what it looked like — how it was
 * turned and how many copies there were. In the pixels of the copy the mark
 * was found in; `sx`/`sy` are how many of those one pixel of the original spans.
 */
export function toStored(found, sx = 1, sy = 1) {
  return {
    on: true,
    mode: found.mode,
    box: found.box,
    offsets: found.offsets.flatMap(([x, y]) => [hundredths(x), hundredths(y)]),
    sx,
    sy,
    alpha: packAlpha(found.alpha),
    color: found.color,
    ...(found.shade ? { shade: packAlpha(found.shade), shadeColor: found.shadeColor } : {}),
    angle: found.angle,
    count: found.count,
  }
}

/**
 * The stored form, ready to take the mark off a picture `aw` × `ah`. A mark
 * kept before copies were listed one by one is a grid, and its copies are laid
 * out again from its two steps.
 */
export function fromStored(d, aw = 0, ah = 0) {
  const alpha = unpackAlpha(d.alpha)
  if (d.offsets) {
    const offsets = []
    for (let i = 0; i + 1 < d.offsets.length; i += 2) offsets.push([d.offsets[i], d.offsets[i + 1]])
    return { ...d, offsets, alpha, shade: d.shade ? unpackAlpha(d.shade) : null }
  }
  const t = tileOf(d)
  return {
    ...d,
    box: [t.tx0, t.ty0, t.tw, t.th],
    offsets: stepsInto(t, Math.round(aw * (d.sx || 1)), Math.round(ah * (d.sy || 1))),
    alpha,
  }
}
