// The magic eraser: paint over something and it is replaced by what was
// probably behind it.
//
// This file is the arithmetic, with no canvas in it, so every step can be
// checked on numbers alone. Turning strokes into pixels, working out which of
// those pixels are the text, filling the hole, and deciding what the model
// should be shown all happen here; `healed.js` is what runs it against a real
// picture and keeps the results.
//
// Strokes live in the *picture's* frame — fractions of the asset's width and
// height — and not the layer box's, which is what every other brush uses. A
// repair belongs to the picture: crop the layer, flip it, refit it or copy a
// piece of it to a new layer and the text is still gone from the same place,
// with nothing to rebase, because none of those things move the picture's own
// pixels.

export const defaultHealBrush = () => ({
  size: 0.045,       // fraction of the layer's width, like every other brush
})

export const hasHeal = (l) => (l?.heal?.strokes?.length || 0) > 0

let seq = 0
/** A stroke in the picture's frame. `size` is a fraction of the asset width. */
export const newHealStroke = (size, pts, kind) => ({
  id: `h${Date.now().toString(36)}${(++seq).toString(36)}`,
  ...(kind ? { kind } : {}),
  size,
  pts,
})

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v))

// ---- strokes to pixels -----------------------------------------------------

/** The pixels a stroke can touch, clipped to the picture. */
export function strokeBox(stroke, aw, ah, pad = 0) {
  const r = stroke.kind === 'region' ? 0 : (stroke.size || 0) * aw / 2
  let x0 = Infinity
  let y0 = Infinity
  let x1 = -Infinity
  let y1 = -Infinity
  for (const [u, v] of stroke.pts || []) {
    x0 = Math.min(x0, u * aw)
    y0 = Math.min(y0, v * ah)
    x1 = Math.max(x1, u * aw)
    y1 = Math.max(y1, v * ah)
  }
  if (!Number.isFinite(x0)) return null
  const e = r + pad + 1
  const box = {
    x0: clamp(Math.floor(x0 - e), 0, aw),
    y0: clamp(Math.floor(y0 - e), 0, ah),
    x1: clamp(Math.ceil(x1 + e), 0, aw),
    y1: clamp(Math.ceil(y1 + e), 0, ah),
  }
  return box.x1 > box.x0 && box.y1 > box.y0 ? box : null
}

/** A box as the rectangle the rest of the code passes around. */
export const boxRect = (b) => ({ x: b.x0, y: b.y0, w: b.x1 - b.x0, h: b.y1 - b.y0 })

/**
 * Which pixels of `region` a stroke covers, as 0/1.
 *
 * Pixel centres, hard-edged. A soft brush is the wrong instrument here: half a
 * letter's worth of alpha left at the edge of a fill is exactly the ghost the
 * tool exists to get rid of, so the edge is decided outright and the fill is
 * made opaque right up to it.
 */
export function rasterStroke(stroke, aw, ah, region) {
  const { x: rx, y: ry, w, h } = region
  const out = new Uint8Array(w * h)
  const pts = (stroke.pts || []).map(([u, v]) => [u * aw - rx, v * ah - ry])
  if (!pts.length) return out

  if (stroke.kind === 'region') {
    // Even-odd, a scanline at a time. The same rule the canvas fills a lasso
    // with, so an outline that crosses itself means the same thing here.
    if (pts.length < 3) return out
    const xs = []
    for (let y = 0; y < h; y++) {
      const cy = y + 0.5
      xs.length = 0
      for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
        const [xi, yi] = pts[i]
        const [xj, yj] = pts[j]
        if ((yi > cy) !== (yj > cy)) xs.push(xi + ((cy - yi) / (yj - yi)) * (xj - xi))
      }
      xs.sort((a, b) => a - b)
      for (let k = 0; k + 1 < xs.length; k += 2) {
        const a = clamp(Math.ceil(xs[k] - 0.5), 0, w)
        const b = clamp(Math.floor(xs[k + 1] - 0.5), -1, w - 1)
        for (let x = a; x <= b; x++) out[y * w + x] = 1
      }
    }
    return out
  }

  const r = Math.max(0.5, (stroke.size || 0) * aw / 2)
  const r2 = r * r
  const segs = pts.length === 1 ? [[pts[0], pts[0]]] : pts.slice(1).map((p, i) => [pts[i], p])
  for (const [a, b] of segs) {
    const x0 = clamp(Math.floor(Math.min(a[0], b[0]) - r), 0, w)
    const x1 = clamp(Math.ceil(Math.max(a[0], b[0]) + r), 0, w)
    const y0 = clamp(Math.floor(Math.min(a[1], b[1]) - r), 0, h)
    const y1 = clamp(Math.ceil(Math.max(a[1], b[1]) + r), 0, h)
    const dx = b[0] - a[0]
    const dy = b[1] - a[1]
    const len2 = dx * dx + dy * dy
    for (let y = y0; y < y1; y++) {
      const py = y + 0.5
      for (let x = x0; x < x1; x++) {
        const i = y * w + x
        if (out[i]) continue
        const px = x + 0.5
        // Distance from the pixel centre to the segment, clamped to its ends —
        // which is what makes the caps round.
        const t = len2 ? clamp(((px - a[0]) * dx + (py - a[1]) * dy) / len2, 0, 1) : 0
        const ex = px - (a[0] + t * dx)
        const ey = py - (a[1] + t * dy)
        if (ex * ex + ey * ey <= r2) out[i] = 1
      }
    }
  }
  return out
}

// ---- distance ----------------------------------------------------------------

const FAR = 1e12

// One dimension of the exact squared distance transform (Felzenszwalb and
// Huttenlocher): the lower envelope of the parabolas rooted at each set sample.
function edt1d(f, n, d, v, z) {
  let k = 0
  v[0] = 0
  z[0] = -Infinity
  z[1] = Infinity
  for (let q = 1; q < n; q++) {
    let s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k])
    while (s <= z[k]) {
      k--
      s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k])
    }
    k++
    v[k] = q
    z[k] = s
    z[k + 1] = Infinity
  }
  k = 0
  for (let q = 0; q < n; q++) {
    while (z[k + 1] < q) k++
    const dq = q - v[k]
    d[q] = dq * dq + f[v[k]]
  }
}

/**
 * How far every pixel is from the nearest set one, in pixels — exactly, not the
 * city-block guess. Exact because it decides how far a dilation reaches, and a
 * square-cornered guess grows a round letter into a box.
 */
export function distanceTo(mask, w, h) {
  const n = Math.max(w, h)
  const f = new Float64Array(n)
  const d = new Float64Array(n)
  const v = new Int32Array(n)
  const z = new Float64Array(n + 1)
  const grid = new Float64Array(w * h)
  for (let i = 0; i < w * h; i++) grid[i] = mask[i] ? 0 : FAR
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) f[y] = grid[y * w + x]
    edt1d(f, h, d, v, z)
    for (let y = 0; y < h; y++) grid[y * w + x] = d[y]
  }
  const out = new Float32Array(w * h)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) f[x] = grid[y * w + x]
    edt1d(f, w, d, v, z)
    for (let x = 0; x < w; x++) out[y * w + x] = Math.sqrt(d[x])
  }
  return out
}

/** Grows a mask outward by `r` pixels, round-cornered. */
export function dilate(mask, w, h, r) {
  if (r <= 0) return mask.slice()
  const dist = distanceTo(mask, w, h)
  const out = new Uint8Array(w * h)
  for (let i = 0; i < out.length; i++) out[i] = dist[i] <= r ? 1 : 0
  return out
}

// ---- which pixels are the text -------------------------------------------------

const BINS = 16          // per channel: 4096 colours, enough to tell ink from paper
const binOf = (d, p) => ((d[p] >> 4) << 8) | ((d[p + 1] >> 4) << 4) | (d[p + 2] >> 4)

// A 3x3x3 box over the colour cube, so a colour and its near neighbours count
// as the same thing — JPEG noise should not make every pixel of a flat sky a
// colour nobody has seen before.
function smoothCube(hist) {
  const B = BINS
  const out = new Float32Array(hist.length)
  for (let r = 0; r < B; r++) {
    for (let g = 0; g < B; g++) {
      for (let b = 0; b < B; b++) {
        let s = 0
        for (let dr = -1; dr <= 1; dr++) {
          const rr = r + dr
          if (rr < 0 || rr >= B) continue
          for (let dg = -1; dg <= 1; dg++) {
            const gg = g + dg
            if (gg < 0 || gg >= B) continue
            for (let db = -1; db <= 1; db++) {
              const bb = b + db
              if (bb < 0 || bb >= B) continue
              s += hist[(rr << 8) | (gg << 4) | bb]
            }
          }
        }
        out[(r << 8) | (g << 4) | b] = s
      }
    }
  }
  return out
}

/**
 * Narrows a brushed band down to the text inside it.
 *
 * A brush laid over a line of type covers the letters *and* the background
 * between and around them, and all of that background is real picture — the
 * best possible evidence for what belongs in the holes. Throwing it away and
 * inventing the whole band is how a fill ends up a smear across a sky that was
 * perfectly visible between the letters.
 *
 * The question asked is which colours are in the band but not around it. Type
 * is set in a colour chosen to stand out from what it sits on, so its colour
 * is common under the brush and rare just outside; the background's colours
 * are common in both. Every band pixel whose colour is markedly more common
 * inside than out is taken to be text, and the result is grown by a few pixels
 * so the anti-aliasing, the compression ringing and any outline go with it.
 *
 * It only narrows when it is sure. If nothing stands out — the brush is over a
 * paragraph and the ring around it is as full of text as the band is, or over
 * an object that is simply different — the whole band is filled, which is what
 * a plain brush would have done anyway. Under-reaching leaves half a letter
 * behind, which is the one outcome worse than a softer fill.
 */
export function hugText(rgba, band, w, h, { brushPx = 20 } = {}) {
  const n = w * h
  let inBand = 0
  for (let i = 0; i < n; i++) if (band[i]) inBand++
  const whole = (why) => ({ mask: band.slice(), mode: 'band', share: 1, why })
  if (!inBand) return whole('empty')

  // The ring: what sits just outside the brush. Wide enough to see the
  // background properly, narrow enough not to reach the next line of type.
  const R = clamp(Math.round(brushPx * 0.45), 3, 36)
  const dist = distanceTo(band, w, h)
  const hb = new Float32Array(BINS * BINS * BINS)
  const hr = new Float32Array(BINS * BINS * BINS)
  let nr = 0
  let nb = 0
  for (let i = 0, p = 0; i < n; i++, p += 4) {
    if (rgba[p + 3] < 16) continue
    if (band[i]) { hb[binOf(rgba, p)]++; nb++ } else if (dist[i] <= R) { hr[binOf(rgba, p)]++; nr++ }
  }
  // Nothing to compare against — a band covering the whole picture, or one
  // over transparency. There is no telling ink from paper without paper.
  if (nr < 24 || nb < 8) return whole('no-ring')

  const sb = smoothCube(hb)
  const sr = smoothCube(hr)
  // A floor under the ring's density, so a colour that happens to be absent
  // from a small ring is not infinitely foreign.
  const floor = 0.5 / nr
  const ratio = new Float32Array(BINS * BINS * BINS)
  for (let k = 0; k < ratio.length; k++) {
    if (!sb[k]) continue
    ratio[k] = (sb[k] / nb) / Math.max(sr[k] / nr, floor)
  }

  // Two thresholds. A colour far more common under the brush than around it is
  // certainly ink; one only somewhat more common is ink if it touches ink —
  // the blend of letter and paper along every edge, a soft shadow, the ringing
  // a JPEG leaves round type. Growing through those and stopping at anything as
  // common outside as in is what keeps the gaps between letters: they are
  // paper, and a blanket margin grown round every letter closed them, turning
  // a caption into one solid block with the background under it lost.
  const STRONG = 2.5
  const WEAK = 1.25
  const ink = new Uint8Array(n)
  const stack = []
  let found = 0
  for (let i = 0, p = 0; i < n; i++, p += 4) {
    if (!band[i]) continue
    // A transparent pixel under the brush is not ink, whatever colour its
    // invisible channels happen to hold.
    if (rgba[p + 3] < 16) continue
    if (ratio[binOf(rgba, p)] > STRONG) { ink[i] = 1; found++; stack.push(i) }
  }
  if (found < Math.max(6, nb * 0.02)) return whole('nothing-stands-out')
  while (stack.length) {
    const i = stack.pop()
    const x = i % w
    const y = (i - x) / w
    for (let dy = -1; dy <= 1; dy++) {
      const yy = y + dy
      if (yy < 0 || yy >= h) continue
      for (let dx = -1; dx <= 1; dx++) {
        const xx = x + dx
        if (xx < 0 || xx >= w) continue
        const j = yy * w + xx
        if (ink[j] || !band[j] || rgba[j * 4 + 3] < 16) continue
        if (ratio[binOf(rgba, j * 4)] > WEAK) { ink[j] = 1; stack.push(j) }
      }
    }
  }

  // Then a pixel or two more, for the edge pixels the colours could not tell.
  const grow = clamp(Math.round(brushPx * 0.035), 1, 4)
  const mask = dilate(ink, w, h, grow)
  let covered = 0
  for (let i = 0; i < n; i++) if (mask[i] && band[i]) covered++
  const share = covered / inBand
  // Most of the band is "text" anyway: the saving is not worth the risk of a
  // leftover fleck, so fill all of it.
  if (share > 0.8) {
    for (let i = 0; i < n; i++) if (band[i]) mask[i] = 1
    return { mask, mode: 'band', share, why: 'mostly-ink' }
  }
  return { mask, mode: 'hug', share, grow, why: 'ink' }
}

// ---- filling -------------------------------------------------------------------

/**
 * Fills the holes from their surroundings, in place.
 *
 * Pull-push: the picture is halved repeatedly, each smaller level averaging
 * only the pixels that are known, until the holes have closed; then it is
 * grown back, and at every level a hole takes its colour from the level above.
 * Thin holes close in a level or two and take their colour from a pixel away;
 * wide ones reach further up and come back smooth. It is the classic way of
 * filling a membrane over a gap, it runs in a few passes over the pixels, and
 * for letter-sized holes over anything that is not busy texture it is already
 * hard to tell from the real thing.
 *
 * The alpha channel is filled with the colour, so a hole in a picture with a
 * transparent background fills to transparent rather than to black.
 */
export function pushPull(rgba, hole, w, h) {
  const levels = []
  let cw = w
  let ch = h
  let col = new Float32Array(w * h * 4)
  let wt = new Float32Array(w * h)
  let any = false
  for (let i = 0, p = 0; i < w * h; i++, p += 4) {
    if (hole[i]) continue
    wt[i] = 1
    any = true
    col[p] = rgba[p]
    col[p + 1] = rgba[p + 1]
    col[p + 2] = rgba[p + 2]
    col[p + 3] = rgba[p + 3]
  }
  if (!any) return rgba
  levels.push({ w: cw, h: ch, col, wt })

  // Pull: a 1-2-1 tent at stride two. A plain 2x2 average would leave the
  // blocks of each level visible in a wide fill.
  while (cw > 1 || ch > 1) {
    const nw = Math.max(1, (cw + 1) >> 1)
    const nh = Math.max(1, (ch + 1) >> 1)
    const ncol = new Float32Array(nw * nh * 4)
    const nwt = new Float32Array(nw * nh)
    for (let y = 0; y < nh; y++) {
      for (let x = 0; x < nw; x++) {
        let s = 0
        let r = 0
        let g = 0
        let b = 0
        let a = 0
        for (let dy = -1; dy <= 1; dy++) {
          const sy = 2 * y + dy
          if (sy < 0 || sy >= ch) continue
          const ky = dy ? 1 : 2
          for (let dx = -1; dx <= 1; dx++) {
            const sx = 2 * x + dx
            if (sx < 0 || sx >= cw) continue
            const i = sy * cw + sx
            const k = wt[i] * ky * (dx ? 1 : 2)
            if (!k) continue
            s += k
            r += col[i * 4] * k
            g += col[i * 4 + 1] * k
            b += col[i * 4 + 2] * k
            a += col[i * 4 + 3] * k
          }
        }
        const j = y * nw + x
        if (s > 0) {
          ncol[j * 4] = r / s
          ncol[j * 4 + 1] = g / s
          ncol[j * 4 + 2] = b / s
          ncol[j * 4 + 3] = a / s
          // Half the kernel known is enough to trust the average outright.
          nwt[j] = Math.min(1, s / 8)
        }
      }
    }
    cw = nw
    ch = nh
    col = ncol
    wt = nwt
    levels.push({ w: cw, h: ch, col, wt })
  }

  // Push: coarse to fine, each level's unknowns borrowing from the one above,
  // sampled bilinearly so the borrowing has no seams.
  for (let k = levels.length - 2; k >= 0; k--) {
    const f = levels[k]
    const c = levels[k + 1]
    for (let y = 0; y < f.h; y++) {
      const cy = clamp(y / 2, 0, c.h - 1)
      const y0 = Math.floor(cy)
      const y1 = Math.min(c.h - 1, y0 + 1)
      const fy = cy - y0
      for (let x = 0; x < f.w; x++) {
        const i = y * f.w + x
        const t = f.wt[i]
        if (t >= 1) continue
        const cx = clamp(x / 2, 0, c.w - 1)
        const x0 = Math.floor(cx)
        const x1 = Math.min(c.w - 1, x0 + 1)
        const fx = cx - x0
        for (let ch2 = 0; ch2 < 4; ch2++) {
          const up = (c.col[(y0 * c.w + x0) * 4 + ch2] * (1 - fx) + c.col[(y0 * c.w + x1) * 4 + ch2] * fx) * (1 - fy)
            + (c.col[(y1 * c.w + x0) * 4 + ch2] * (1 - fx) + c.col[(y1 * c.w + x1) * 4 + ch2] * fx) * fy
          f.col[i * 4 + ch2] = t * f.col[i * 4 + ch2] + (1 - t) * up
        }
        f.wt[i] = 1
      }
    }
  }

  const top = levels[0].col
  for (let i = 0, p = 0; i < w * h; i++, p += 4) {
    if (!hole[i]) continue
    rgba[p] = top[p]
    rgba[p + 1] = top[p + 1]
    rgba[p + 2] = top[p + 2]
    rgba[p + 3] = top[p + 3]
  }
  return rgba
}

// ---- filling with the picture's own pieces --------------------------------------

// Seeded, so the same stroke on the same picture fills the same way every time.
function lcg(seed) {
  let s = seed >>> 0 || 1
  return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296)
}

// A summed-area table of the holes: how many hole pixels any rectangle holds,
// in four lookups, which is what makes "does this patch touch a hole" cheap
// enough to ask of every pixel.
function holeTable(hole, w, h) {
  const t = new Int32Array((w + 1) * (h + 1))
  for (let y = 0; y < h; y++) {
    let row = 0
    for (let x = 0; x < w; x++) {
      row += hole[y * w + x] ? 1 : 0
      t[(y + 1) * (w + 1) + x + 1] = t[y * (w + 1) + x + 1] + row
    }
  }
  return (x0, y0, x1, y1) => {
    const a = Math.max(0, x0)
    const b = Math.max(0, y0)
    const c = Math.min(w, x1 + 1)
    const d = Math.min(h, y1 + 1)
    if (c <= a || d <= b) return 0
    return t[d * (w + 1) + c] - t[b * (w + 1) + c] - t[d * (w + 1) + a] + t[b * (w + 1) + a]
  }
}

/**
 * One level of the completion: PatchMatch to find, for every patch that
 * touches the hole, the most similar patch of real picture; then every hole
 * pixel takes the colour those patches agree on. Repeated, because the
 * matches improve as the fill does.
 */
async function completeLevel(lv, seed, r, iters, rnd, tick, holeWeight = 0.5, trust = 0) {
  const { w, h, img, hole } = lv
  const holes = holeTable(hole, w, h)
  const valid = new Uint8Array(w * h)
  const src = []
  for (let y = r; y < h - r; y++) {
    for (let x = r; x < w - r; x++) {
      if (holes(x - r, y - r, x + r, y + r) === 0) { valid[y * w + x] = 1; src.push(y * w + x) }
    }
  }
  if (!src.length) return null
  const targets = []
  const isT = new Uint8Array(w * h)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (holes(x - r, y - r, x + r, y + r) > 0) { targets.push(y * w + x); isT[y * w + x] = 1 }
    }
  }

  const nq = new Int32Array(w * h).fill(-1)   // best source centre per target
  const nd = new Float64Array(w * h)          // and how far it is
  const norm = new Float64Array(w * h)        // the weight a target patch sums to
  const share = new Float64Array(w * h)       // how much of it is real picture

  // Distance between the patch at target t and source q. What is known counts
  // fully and what is only estimated counts half: the estimate is what is
  // being improved, and letting it vote as loudly as the real picture would
  // make the fill agree with its own first guess.
  const dist = (t, q, best) => {
    const tx = t % w
    const ty = (t - tx) / w
    const qx = q % w
    const qy = (q - qx) / w
    let s = 0
    for (let dy = -r; dy <= r; dy++) {
      const yy = ty + dy
      if (yy < 0 || yy >= h) continue
      const trow = yy * w
      const srow = (qy + dy) * w
      for (let dx = -r; dx <= r; dx++) {
        const xx = tx + dx
        if (xx < 0 || xx >= w) continue
        const tp = trow + xx
        const sp = srow + qx + dx
        const k = hole[tp] ? holeWeight : 1
        const a = img[tp * 3] - img[sp * 3]
        const b = img[tp * 3 + 1] - img[sp * 3 + 1]
        const c = img[tp * 3 + 2] - img[sp * 3 + 2]
        s += k * (a * a + b * b + c * c)
      }
      if (s > best) return s
    }
    return s
  }

  for (const t of targets) {
    const tx = t % w
    const ty = (t - tx) / w
    let n = 0
    let real = 0
    let all = 0
    for (let dy = -r; dy <= r; dy++) {
      if (ty + dy < 0 || ty + dy >= h) continue
      for (let dx = -r; dx <= r; dx++) {
        if (tx + dx < 0 || tx + dx >= w) continue
        const isHole = hole[(ty + dy) * w + tx + dx]
        n += isHole ? holeWeight : 1
        real += isHole ? 0 : 1
        all++
      }
    }
    norm[t] = n
    share[t] = all ? real / all : 0
    let q = seed ? seed(t) : -1
    if (q < 0 || !valid[q]) q = src[Math.floor(rnd() * src.length)]
    nq[t] = q
    nd[t] = dist(t, q, Infinity)
  }

  const attempt = (t, q) => {
    if (q < 0 || q >= w * h || !valid[q] || q === nq[t]) return
    const d = dist(t, q, nd[t])
    if (d < nd[t]) { nd[t] = d; nq[t] = q }
  }

  const acc = new Float64Array(w * h * 3)
  const wsum = new Float64Array(w * h)
  for (let it = 0; it < iters; it++) {
    for (let sweep = 0; sweep < 2; sweep++) {
      const fwd = (it + sweep) % 2 === 0
      for (let k = 0; k < targets.length; k++) {
        const t = targets[fwd ? k : targets.length - 1 - k]
        const tx = t % w
        const s = fwd ? 1 : -1
        // Propagation: a neighbour's match, shifted by one, is usually a good
        // match here too — which is how a found edge runs along the hole.
        const nx = t - s
        if (tx - s >= 0 && tx - s < w && isT[nx]) {
          const qx = (nq[nx] % w) + s
          if (qx >= 0 && qx < w) attempt(t, nq[nx] + s)
        }
        const ny = t - s * w
        if (ny >= 0 && ny < w * h && isT[ny]) attempt(t, nq[ny] + s * w)
        // Random search round the best so far, closing in.
        const bx = nq[t] % w
        const by = (nq[t] - bx) / w
        for (let R = Math.max(w, h); R >= 1; R >>= 1) {
          const cx = bx + Math.round((rnd() * 2 - 1) * R)
          const cy = by + Math.round((rnd() * 2 - 1) * R)
          if (cx >= 0 && cx < w && cy >= 0 && cy < h) attempt(t, cy * w + cx)
        }
      }
    }

    // Vote. A close match speaks louder than a poor one, measured against how
    // close matches are in this picture — grainy pictures match less closely
    // everywhere, and a fixed scale would silence them.
    const means = targets.map((t) => nd[t] / Math.max(1, norm[t])).sort((a, b) => a - b)
    const sigma = Math.max(12, means[Math.floor(means.length / 2)] || 0)
    acc.fill(0)
    wsum.fill(0)
    for (const t of targets) {
      const tx = t % w
      const ty = (t - tx) / w
      const q = nq[t]
      const qx = q % w
      const qy = (q - qx) / w
      const wt = Math.exp(-(nd[t] / Math.max(1, norm[t])) / (2 * sigma))
        * (trust ? Math.pow(0.05 + share[t], trust) : 1)
      for (let dy = -r; dy <= r; dy++) {
        const yy = ty + dy
        if (yy < 0 || yy >= h) continue
        for (let dx = -r; dx <= r; dx++) {
          const xx = tx + dx
          if (xx < 0 || xx >= w) continue
          const p = yy * w + xx
          if (!hole[p]) continue
          const sp = (qy + dy) * w + qx + dx
          acc[p * 3] += wt * img[sp * 3]
          acc[p * 3 + 1] += wt * img[sp * 3 + 1]
          acc[p * 3 + 2] += wt * img[sp * 3 + 2]
          wsum[p] += wt
        }
      }
    }
    for (let p = 0; p < w * h; p++) {
      if (!hole[p] || !(wsum[p] > 0)) continue
      img[p * 3] = acc[p * 3] / wsum[p]
      img[p * 3 + 1] = acc[p * 3 + 1] / wsum[p]
      img[p * 3 + 2] = acc[p * 3 + 2] / wsum[p]
    }
    // The distances were measured against the old fill; measure them again
    // against the new one before the next round compares against them.
    for (const t of targets) nd[t] = dist(t, nq[t], Infinity)
    if (tick) await tick()
  }
  return { w, h, nq }
}

/**
 * Fills the holes with pieces of the picture itself, in place.
 *
 * Pull-push is exact on anything smooth and wrong across an edge: a hole on a
 * horizon comes back as sky and grass averaged into a green smudge. So this
 * does what content-aware fill does — for every small patch that overlaps the
 * hole, finds the most similar patch of real picture nearby, and fills from
 * those. A patch on the horizon matches another piece of the horizon, and the
 * edge carries straight through; a patch of grain matches grain, and the fill
 * is grainy rather than smooth.
 *
 * Coarse to fine, so a wide hole is laid out small, where a patch covers a lot
 * of it, and then sharpened level by level. Pull-push provides the first guess
 * and the alpha channel; this replaces the colour.
 *
 * Async only so a long fill can let the page breathe between rounds — pass
 * `tick` for that. It does the same work either way.
 */
export async function patchFill(rgba, hole, w, h, {
  // One level down and no further. Measured on captions over a horizon, a
  // deeper pyramid was *worse*: at an eighth of the size the hole swallows the
  // gaps between letters and the edge running under them, the coarse answer
  // is a flat guess, and every finer level keeps it. Half size is enough to
  // lay out a letter-sized hole and still see the picture round it.
  radius = 3, seed = 7, tick = null, holeWeight = 0.5, trust = 0, maxLevels = 1,
  coarseIters = 6, fineIters = 3,
} = {}) {
  const n = w * h
  let count = 0
  for (let i = 0; i < n; i++) if (hole[i]) count++
  if (!count || count === n) return rgba
  pushPull(rgba, hole, w, h)

  // How deep the hole is at its deepest decides how many levels it needs: a
  // stroke of a letter is closed by one, a brushed-out logo by several.
  const keep = new Uint8Array(n)
  for (let i = 0; i < n; i++) keep[i] = hole[i] ? 0 : 1
  const depth = distanceTo(keep, w, h)
  let deepest = 0
  for (let i = 0; i < n; i++) if (hole[i] && depth[i] > deepest) deepest = depth[i]
  const P = 2 * radius + 1

  const img0 = new Float32Array(n * 3)
  for (let i = 0; i < n; i++) {
    img0[i * 3] = rgba[i * 4]
    img0[i * 3 + 1] = rgba[i * 4 + 1]
    img0[i * 3 + 2] = rgba[i * 4 + 2]
  }
  const pyr = [{ w, h, img: img0, hole }]
  let want = Math.min(maxLevels, Math.max(0, Math.ceil(Math.log2(Math.max(1, deepest) / 2))))
  while (want-- > 0) {
    const f = pyr[pyr.length - 1]
    const nw = f.w >> 1
    const nh = f.h >> 1
    if (Math.min(nw, nh) < P * 3) break
    const img = new Float32Array(nw * nh * 3)
    const hl = new Uint8Array(nw * nh)
    for (let y = 0; y < nh; y++) {
      for (let x = 0; x < nw; x++) {
        let any = 0
        for (let c = 0; c < 3; c++) {
          let s = 0
          for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) s += f.img[((2 * y + dy) * f.w + 2 * x + dx) * 3 + c]
          img[(y * nw + x) * 3 + c] = s / 4
        }
        for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) any |= f.hole[(2 * y + dy) * f.w + 2 * x + dx]
        // A coarse pixel with any hole under it is hole: the coarse level is
        // where the hole's layout is decided, so it has to cover all of it.
        hl[y * nw + x] = any ? 1 : 0
      }
    }
    pyr.push({ w: nw, h: nh, img, hole: hl })
  }

  const rnd = lcg(seed)
  let prev = null
  for (let L = pyr.length - 1; L >= 0; L--) {
    const lv = pyr[L]
    let seedFn = null
    if (prev) {
      const c = pyr[L + 1]
      // Start from the coarser answer: its colours, sampled up, and its
      // matches, doubled.
      for (let y = 0; y < lv.h; y++) {
        const cy = Math.min(c.h - 1, Math.max(0, (y - 0.5) / 2))
        const y0 = Math.floor(cy)
        const y1 = Math.min(c.h - 1, y0 + 1)
        const fy = cy - y0
        for (let x = 0; x < lv.w; x++) {
          const p = y * lv.w + x
          if (!lv.hole[p]) continue
          const cx = Math.min(c.w - 1, Math.max(0, (x - 0.5) / 2))
          const x0 = Math.floor(cx)
          const x1 = Math.min(c.w - 1, x0 + 1)
          const fx = cx - x0
          for (let ch = 0; ch < 3; ch++) {
            const at = (xx, yy) => c.img[(yy * c.w + xx) * 3 + ch]
            lv.img[p * 3 + ch] = (at(x0, y0) * (1 - fx) + at(x1, y0) * fx) * (1 - fy)
              + (at(x0, y1) * (1 - fx) + at(x1, y1) * fx) * fy
          }
        }
      }
      const pw = prev.w
      const ph = prev.h
      const pq = prev.nq
      seedFn = (t) => {
        const tx = t % lv.w
        const ty = (t - tx) / lv.w
        const cxp = Math.min(pw - 1, tx >> 1)
        const cyp = Math.min(ph - 1, ty >> 1)
        const q = pq[cyp * pw + cxp]
        if (q < 0) return -1
        const qx = (q % pw) * 2 + (tx & 1)
        const qy = Math.floor(q / pw) * 2 + (ty & 1)
        return qx < lv.w && qy < lv.h ? qy * lv.w + qx : -1
      }
    }
    const res = await completeLevel(lv, seedFn, radius, L === pyr.length - 1 ? coarseIters : fineIters,
      rnd, tick, holeWeight, trust)
    if (!res) {
      // No whole patch of real picture anywhere at this level: the hole is
      // most of the area. Pull-push's answer is the honest one then.
      if (L === 0) return rgba
      prev = null
      continue
    }
    prev = res
  }

  const out = pyr[0].img
  for (let i = 0; i < n; i++) {
    if (!hole[i]) continue
    rgba[i * 4] = out[i * 3]
    rgba[i * 4 + 1] = out[i * 3 + 1]
    rgba[i * 4 + 2] = out[i * 3 + 2]
  }
  return rgba
}

// ---- what the model is shown ---------------------------------------------------

/**
 * The separate pieces of a mask, as boxes, with pieces closer than `gap` taken
 * together — the letters of a word are one piece, two captions at opposite
 * corners are two.
 */
export function pieces(mask, w, h, gap = 0) {
  const joined = gap > 0 ? dilate(mask, w, h, gap / 2) : mask
  const label = new Int32Array(w * h)
  const boxes = []
  const stack = []
  for (let s = 0; s < w * h; s++) {
    if (!joined[s] || label[s]) continue
    const id = boxes.length + 1
    const b = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity, n: 0 }
    label[s] = id
    stack.push(s)
    while (stack.length) {
      const i = stack.pop()
      const x = i % w
      const y = (i - x) / w
      if (mask[i]) {
        b.n++
        if (x < b.x0) b.x0 = x
        if (y < b.y0) b.y0 = y
        if (x + 1 > b.x1) b.x1 = x + 1
        if (y + 1 > b.y1) b.y1 = y + 1
      }
      for (let dy = -1; dy <= 1; dy++) {
        const yy = y + dy
        if (yy < 0 || yy >= h) continue
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx
          if (xx < 0 || xx >= w) continue
          const j = yy * w + xx
          if (joined[j] && !label[j]) { label[j] = id; stack.push(j) }
        }
      }
    }
    if (b.n) boxes.push(b)
  }
  return boxes
}

/**
 * The crops a model is run on: each a square of picture with a piece of hole in
 * the middle and context all round it.
 *
 * A model sees a fixed number of pixels. Hand it a whole long caption and it
 * shrinks the caption to fit, fills at that size and scales the fill back up —
 * soft, and visibly so beside the sharp picture around it. So a long piece is
 * cut into lengths no longer than `core`, each filled in its own crop at close
 * to its real size, one after another, each seeing the ones before it done.
 */
export function planCrops(boxes, w, h, { core = 320, min = 256, max = 640 } = {}) {
  const out = []
  for (const b of boxes) {
    const bw = b.x1 - b.x0
    const bh = b.y1 - b.y0
    const nx = Math.max(1, Math.ceil(bw / core))
    const ny = Math.max(1, Math.ceil(bh / core))
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        const c = {
          x0: Math.round(b.x0 + (bw * i) / nx),
          x1: Math.round(b.x0 + (bw * (i + 1)) / nx),
          y0: Math.round(b.y0 + (bh * j) / ny),
          y1: Math.round(b.y0 + (bh * (j + 1)) / ny),
        }
        const side = Math.max(c.x1 - c.x0, c.y1 - c.y0)
        // Context of at least the hole's own size again on every side, so a
        // stripe or a horizon has somewhere to be read from.
        const S = clamp(Math.round(side * 2.4), min, max)
        const cw = Math.min(S, w)
        const ch = Math.min(S, h)
        const cx = (c.x0 + c.x1) / 2
        const cy = (c.y0 + c.y1) / 2
        const x = clamp(Math.round(cx - cw / 2), 0, w - cw)
        const y = clamp(Math.round(cy - ch / 2), 0, h - ch)
        out.push({ core: c, crop: { x, y, w: cw, h: ch } })
      }
    }
  }
  return out
}

/** Bounds of the set pixels in a mask, or null. */
export function maskBounds(mask, w, h) {
  let x0 = w
  let y0 = h
  let x1 = -1
  let y1 = -1
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!mask[y * w + x]) continue
      if (x < x0) x0 = x
      if (x > x1) x1 = x
      if (y < y0) y0 = y
      if (y > y1) y1 = y
    }
  }
  return x1 < 0 ? null : { x0, y0, x1: x1 + 1, y1: y1 + 1 }
}
