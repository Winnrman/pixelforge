// Motion tracking by normalized cross-correlation.
//
// No model, no network, no AI: this is classical template matching, the same
// idea behind a point tracker in a compositor. A patch of the frame under the
// layer becomes the template, and each later frame is searched for the offset
// that best correlates with it. NCC normalises out brightness and contrast
// changes, which matters for GIFs whose palettes shift between frames.
//
// Two properties of this app make it easier than the usual case: every frame is
// already decoded with random access, so tracking can run backwards as well as
// forwards; and the result is just keyframes on the existing x/y tracks, so
// everything downstream already knows what to do with it.

import { renderDocument } from './render.js'
import { getAsset } from './assets.js'

const SCALE_STEPS = [0.94, 0.97, 1, 1.03, 1.06]

/** Times to sample: real GIF frame boundaries when there are any, else a steady rate. */
export function trackTimes(doc, duration, fps = 20) {
  const set = new Set([0])
  let found = false
  for (const l of doc.layers) {
    if (l.type !== 'image' || l.visible === false) continue
    const a = getAsset(l.assetId)
    if (!a?.animated) continue
    found = true
    const sp = l.speed || 1
    const off = l.timeOffset || 0
    for (let rep = 0; off + (rep * a.duration) / sp < duration && rep < 200; rep++) {
      for (let k = 0; k < a.frames.length; k++) {
        const t = off + (rep * a.duration + (k ? a.cum[k - 1] : 0)) / sp
        if (t >= 0 && t < duration) set.add(Math.round(t))
      }
    }
  }
  if (!found) {
    const step = 1000 / Math.max(1, fps)
    for (let t = 0; t < duration; t += step) set.add(Math.round(t))
  }
  return [...set].sort((a, b) => a - b)
}

/**
 * The imagery a layer sits on top of: everything below it, minus the effect
 * overlays. Tracking the composited output would mean correlating against our
 * own pixelation, which destroys the very detail the tracker needs.
 */
function backdropDoc(doc, targetId) {
  const idx = doc.layers.findIndex((l) => l.id === targetId)
  const below = idx < 0 ? doc.layers : doc.layers.slice(0, idx)
  return {
    // Transparent, so a keyed layer's alpha survives into the tracker as a
    // per-pixel statement of where the subject is.
    ...doc,
    background: 'transparent',
    layers: below.filter((l) => l.type !== 'effect' && l.type !== 'group'),
  }
}

function toGray(data, w, h) {
  const out = new Float32Array(w * h)
  for (let i = 0, p = 0; i < out.length; i++, p += 4) {
    out[i] = 0.299 * data[p] + 0.587 * data[p + 1] + 0.114 * data[p + 2]
  }
  return out
}

function halve(src, w, h) {
  const nw = Math.max(1, w >> 1)
  const nh = Math.max(1, h >> 1)
  const out = new Float32Array(nw * nh)
  for (let y = 0; y < nh; y++) {
    for (let x = 0; x < nw; x++) {
      const sx = x << 1
      const sy = y << 1
      const x1 = Math.min(sx + 1, w - 1)
      const y1 = Math.min(sy + 1, h - 1)
      out[y * nw + x] = (src[sy * w + sx] + src[sy * w + x1] +
        src[y1 * w + sx] + src[y1 * w + x1]) / 4
    }
  }
  return { data: out, w: nw, h: nh }
}

/** Resamples a rectangle out of a grayscale plane (nearest neighbour). */
function patch(src, sw, sh, x, y, w, h, outW, outH) {
  const out = new Float32Array(outW * outH)
  for (let j = 0; j < outH; j++) {
    const fy = y + ((j + 0.5) * h) / outH
    const iy = Math.min(sh - 1, Math.max(0, Math.round(fy - 0.5)))
    for (let i = 0; i < outW; i++) {
      const fx = x + ((i + 0.5) * w) / outW
      const ix = Math.min(sw - 1, Math.max(0, Math.round(fx - 0.5)))
      out[j * outW + i] = src[iy * sw + ix]
    }
  }
  return out
}

/**
 * Bundles a template with the moments the NCC needs.
 *
 * Weighting these by a background key was tried and measured: neutral on a clean
 * green screen and catastrophic on a busy background (1.2px mean error to 40px),
 * because a sparse weight map leaves too few pixels voting. Plain uniform
 * correlation it is.
 */
function makeTemplate(data, w, h) {
  let sv = 0
  let svv = 0
  for (let i = 0; i < data.length; i++) {
    sv += data[i]
    svv += data[i] * data[i]
  }
  const n = data.length
  const mean = sv / n
  return { data, w, h, n, mean, norm: Math.sqrt(Math.max(0, svv - n * mean * mean)) }
}

/** NCC of a template against the window of `img` whose top-left is (ox, oy). */
function ncc(T, img, iw, ih, ox, oy) {
  if (ox < 0 || oy < 0 || ox + T.w > iw || oy + T.h > ih) return -1
  const { data, w, h, n, mean: tMean, norm: tNorm } = T
  if (tNorm < 1e-6) return -1
  let sv = 0
  let svv = 0
  let dot = 0
  for (let j = 0; j < h; j++) {
    let ii = (oy + j) * iw + ox
    let ti = j * w
    for (let i = 0; i < w; i++, ii++, ti++) {
      const v = img[ii]
      sv += v
      svv += v * v
      dot += v * data[ti]
    }
  }
  const mean = sv / n
  const norm = Math.sqrt(Math.max(0, svv - n * mean * mean))
  if (norm < 1e-6) return -1
  return (dot - n * mean * tMean) / (norm * tNorm)
}

function bestOffset(T, img, iw, ih, cx, cy, radius) {
  let best = { x: cx, y: cy, score: -1 }
  for (let dy = -radius; dy <= radius; dy++) {
    for (let dx = -radius; dx <= radius; dx++) {
      const s = ncc(T, img, iw, ih, cx + dx, cy + dy)
      if (s > best.score) best = { x: cx + dx, y: cy + dy, score: s }
    }
  }
  return best
}

/**
 * Follows a layer's box through the document's frames.
 *
 * Returns `{ samples, lostAt }` where samples are `{ t, x, y, w, h, score }` in
 * document space. Tracking stops as soon as correlation falls below `minScore` —
 * reporting where it gave up is far more useful than emitting confident-looking
 * nonsense.
 */
export async function trackLayer(doc, layer, {
  times,
  anchorTime = 0,
  direction = 'forward',
  radius = 28,
  trackScale = false,
  minScore = 0.35,
  // Subjects change appearance as they move — lighting shifts, things rotate a
  // little, backgrounds slide past inside the box. Easing the template toward
  // each new match absorbs that. Measured against a fixture with known motion:
  // no adaptation drifts ~9px over a loop and heavier blends drift further and
  // less predictably; a light blend plus the drift correction below holds a mean
  // of about 1.2px and a worst case under 5px.
  adapt = 0.1,
  driftCorrect = true,
  onProgress = () => {},
} = {}) {
  const W = doc.width
  const H = doc.height
  const bdoc = backdropDoc(doc, layer.id)

  const canvas = document.createElement('canvas')
  canvas.width = W
  canvas.height = H
  const ctx = canvas.getContext('2d', { willReadFrequently: true })

  const planesAt = (t) => {
    renderDocument(ctx, bdoc, t)
    return toGray(ctx.getImageData(0, 0, W, H).data, W, H)
  }

  const tw = Math.max(8, Math.round(layer.w))
  const th = Math.max(8, Math.round(layer.h))
  if (tw > W || th > H) {
    return { samples: [], lostAt: null, reason: 'The region is larger than the canvas.' }
  }

  const anchorGray = planesAt(anchorTime)
  const anchorPatch = patch(anchorGray, W, H, layer.x, layer.y, tw, th, tw, th)
  const origin = makeTemplate(Float32Array.from(anchorPatch), tw, th)
  let full = makeTemplate(anchorPatch, tw, th)
  if (full.norm < 1e-3) {
    return { samples: [], lostAt: null, reason: 'That area is flat — there is nothing to lock onto.' }
  }
  const halfOf = (t) => {
    const h2 = halve(t.data, t.w, t.h)
    return makeTemplate(h2.data, h2.w, h2.h)
  }
  let half = halfOf(full)

  const order = direction === 'backward'
    ? times.filter((t) => t <= anchorTime).sort((a, b) => b - a)
    : times.filter((t) => t >= anchorTime).sort((a, b) => a - b)

  const samples = []
  let cx = layer.x
  let cy = layer.y
  let scale = 1
  let lostAt = null

  for (let i = 0; i < order.length; i++) {
    const t = order[i]
    if (t === anchorTime) {
      samples.push({ t, x: layer.x, y: layer.y, w: layer.w, h: layer.h, score: 1 })
      continue
    }

    const gray = planesAt(t)
    const small = halve(gray, W, H)

    // Coarse pass at half resolution over the whole search radius...
    const coarse = bestOffset(half, small.data, small.w, small.h,
      Math.round(cx / 2), Math.round(cy / 2), Math.max(2, Math.round(radius / 2)))

    // ...then a tight refine at full resolution.
    let fine = bestOffset(full, gray, W, H, coarse.x * 2, coarse.y * 2, 3)

    if (trackScale) {
      for (const step of SCALE_STEPS) {
        const sc = scale * step
        const sw = Math.max(8, Math.round(tw * sc))
        const sh = Math.max(8, Math.round(th * sc))
        if (sw > W || sh > H) continue
        const scaled = makeTemplate(patch(full.data, tw, th, 0, 0, tw, th, sw, sh), sw, sh)
        const got = bestOffset(scaled, gray, W, H,
          Math.round(fine.x + (tw - sw) / 2), Math.round(fine.y + (th - sh) / 2), 2)
        if (got.score > fine.score) {
          fine = got
          scale = sc
        }
      }
    }

    if (driftCorrect && scale === 1) {
      const anchored = bestOffset(origin, gray, W, H, fine.x, fine.y, 3)
      // Only trust the original when it still recognises the subject clearly;
      // otherwise the appearance really has changed and the adapted one is right.
      if (anchored.score > minScore + 0.15) fine = anchored
    }

    if (fine.score < minScore) { lostAt = t; break }
    cx = fine.x
    cy = fine.y
    samples.push({ t, x: cx, y: cy, w: tw * scale, h: th * scale, score: fine.score })

    if (adapt > 0 && scale === 1) {
      const seen = patch(gray, W, H, Math.round(cx), Math.round(cy), tw, th, tw, th)
      const blended = full.data
      for (let k = 0; k < blended.length; k++) {
        blended[k] = blended[k] * (1 - adapt) + seen[k] * adapt
      }
      full = makeTemplate(blended, tw, th)
      half = halfOf(full)
    }

    if (i % 4 === 0) {
      onProgress((i + 1) / order.length)
      await new Promise((r) => setTimeout(r, 0)) // keep the UI breathing
    }
  }

  samples.sort((a, b) => a.t - b.t)
  return { samples, lostAt, reason: null }
}

/**
 * Thins a tracked curve down to the keyframes that actually matter.
 *
 * Error is measured as the linear-interpolation error between kept keys —
 * exactly how the keyframe system will replay it — so anything dropped is
 * provably within `tol` pixels of the raw track. A key per frame usually
 * collapses to a handful that are still comfortable to hand-edit.
 */
export function simplifyTrack(samples, tol = 0.75) {
  if (samples.length <= 2) return samples
  const keep = new Set([0, samples.length - 1])

  const pass = (field) => {
    const walk = (a, b) => {
      if (b - a < 2) return
      const t0 = samples[a].t
      const t1 = samples[b].t
      const v0 = samples[a][field]
      const v1 = samples[b][field]
      let worst = -1
      let at = -1
      for (let i = a + 1; i < b; i++) {
        const u = t1 === t0 ? 0 : (samples[i].t - t0) / (t1 - t0)
        const err = Math.abs(samples[i][field] - (v0 + (v1 - v0) * u))
        if (err > worst) { worst = err; at = i }
      }
      if (worst > tol) {
        keep.add(at)
        walk(a, at)
        walk(at, b)
      }
    }
    walk(0, samples.length - 1)
  }

  pass('x')
  pass('y')
  return [...keep].sort((a, b) => a - b).map((i) => samples[i])
}
