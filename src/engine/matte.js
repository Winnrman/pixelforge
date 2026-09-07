// Background removal by colour keying.
//
// Deliberately not a segmentation model: no download, no network, and it runs
// per frame so an animated GIF keys itself as it plays. That buys speed and
// privacy at a real cost — it can only find a background that is distinguishable
// by colour. Flat studio backdrops, green screens, screenshots and flat-shaded
// GIFs key cleanly; a subject standing in a cluttered room does not.
//
// The default mode floods inward from the borders, so a colour that also appears
// *inside* the subject survives. That is usually what people mean by "remove the
// background" rather than "remove every greenish pixel".

const cache = new WeakMap()

export const defaultBgRemove = () => ({
  on: false,
  mode: 'auto',        // 'auto' samples the border, 'color' uses `color`
  color: '#00ff00',
  tolerance: 34,       // colour distance still counted as background
  feather: 1,          // edge softening, in pixels
  contiguous: true,    // only background connected to the edges
  shrink: 0,           // erode the kept subject, to bite off fringing
  threshold: 0.5,      // AI mode: where the predicted mask becomes opaque
  model: 'modnet',     // AI mode: which network to run
})

function hexToRgb(hex) {
  const m = /^#?([\da-f]{2})([\da-f]{2})([\da-f]{2})$/i.exec(hex || '')
  return m
    ? [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)]
    : [0, 255, 0]
}

/** Median colour of the border ring — a robust guess at "the background". */
function sampleBorder(data, w, h) {
  const rs = []
  const gs = []
  const bs = []
  const take = (x, y) => {
    const i = (y * w + x) * 4
    rs.push(data[i]); gs.push(data[i + 1]); bs.push(data[i + 2])
  }
  const stepX = Math.max(1, Math.floor(w / 64))
  const stepY = Math.max(1, Math.floor(h / 64))
  for (let x = 0; x < w; x += stepX) { take(x, 0); take(x, h - 1) }
  for (let y = 0; y < h; y += stepY) { take(0, y); take(w - 1, y) }
  const mid = (a) => { a.sort((p, q) => p - q); return a[a.length >> 1] }
  return [mid(rs), mid(gs), mid(bs)]
}

/**
 * Distance from the key colour.
 *
 * Against a saturated key — a green screen — hue should dominate, so a shadow on
 * the screen still keys while a grey shirt does not. Against a *desaturated* key
 * there is no hue to lean on, and discounting brightness the same way makes a
 * grey wall and grey-ish skin read as identical. So the weighting follows the
 * key colour's own saturation rather than being fixed.
 */
function makeDistance(kr, kg, kb) {
  const sat = Math.max(kr, kg, kb) - Math.min(kr, kg, kb)
  const t = Math.min(1, sat / 60)
  const chromaW = 1 + 1.2 * t
  const lumaW = 1 - 0.45 * t
  return (r, g, b) => {
    const dr = r - kr
    const dg = g - kg
    const db = b - kb
    const lum = (dr + dg + db) / 3
    const cr = dr - lum
    const cg = dg - lum
    const cb = db - lum
    const chroma = Math.sqrt(cr * cr + cg * cg + cb * cb)
    return Math.sqrt(chroma * chroma * chromaW + lum * lum * lumaW)
  }
}

/** Separable box blur over an alpha plane, used to soften the finished edge. */
function blurAlpha(a, w, h, radius) {
  const r = Math.min(8, Math.round(radius))
  if (r < 1) return a
  const tmp = new Float32Array(a.length)
  const norm = 1 / (r * 2 + 1)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let sum = 0
      for (let k = -r; k <= r; k++) sum += a[y * w + Math.min(w - 1, Math.max(0, x + k))]
      tmp[y * w + x] = sum * norm
    }
  }
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) {
      let sum = 0
      for (let k = -r; k <= r; k++) sum += tmp[Math.min(h - 1, Math.max(0, y + k)) * w + x]
      a[y * w + x] = sum * norm
    }
  }
  return a
}

/**
 * Writes background alpha into `data` in place.
 * Returns the number of pixels that ended up fully transparent.
 */
export function keyImageData(img, opts) {
  const { data, width: w, height: h } = img
  const o = { ...defaultBgRemove(), ...opts }
  const [kr, kg, kb] = o.mode === 'auto' ? sampleBorder(data, w, h) : hexToRgb(o.color)
  const dist = makeDistance(kr, kg, kb)
  const tol = Math.max(0, o.tolerance)

  // A strict yes/no classification. The first version let the flood pass through
  // anything *partially* background, which on a noisy photo meant a near
  // continuous web of "sort of background" pixels threading through the subject
  // and shredding it. Softening belongs on the finished edge, not in the
  // decision about what the background is.
  const isBg = new Uint8Array(w * h)
  for (let i = 0, p = 0; i < isBg.length; i++, p += 4) {
    isBg[i] = dist(data[p], data[p + 1], data[p + 2]) <= tol ? 1 : 0
  }

  const alpha01 = new Float32Array(w * h)
  if (o.contiguous) {
    const reach = new Uint8Array(w * h)
    const stack = []
    const push = (x, y) => {
      const i = y * w + x
      if (reach[i] || !isBg[i]) return
      reach[i] = 1
      stack.push(i)
    }
    for (let x = 0; x < w; x++) { push(x, 0); push(x, h - 1) }
    for (let y = 0; y < h; y++) { push(0, y); push(w - 1, y) }
    while (stack.length) {
      const i = stack.pop()
      const x = i % w
      const y = (i / w) | 0
      if (x > 0) push(x - 1, y)
      if (x < w - 1) push(x + 1, y)
      if (y > 0) push(x, y - 1)
      if (y < h - 1) push(x, y + 1)
    }
    for (let i = 0; i < alpha01.length; i++) alpha01[i] = reach[i] ? 0 : 1
  } else {
    for (let i = 0; i < alpha01.length; i++) alpha01[i] = isBg[i] ? 0 : 1
  }

  if (o.shrink > 0) {
    const rounds = Math.min(4, Math.round(o.shrink))
    for (let r = 0; r < rounds; r++) {
      const prev = Float32Array.from(alpha01)
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const i = y * w + x
          let lo = prev[i]
          if (x > 0) lo = Math.min(lo, prev[i - 1])
          if (x < w - 1) lo = Math.min(lo, prev[i + 1])
          if (y > 0) lo = Math.min(lo, prev[i - w])
          if (y < h - 1) lo = Math.min(lo, prev[i + w])
          alpha01[i] = lo
        }
      }
    }
  }

  // Count the mask boundary before feathering blurs it away.
  let edges = 0
  for (let y = 0; y < h - 1; y++) {
    for (let x = 0; x < w - 1; x++) {
      const i = y * w + x
      const on = alpha01[i] >= 0.5
      if (on !== (alpha01[i + 1] >= 0.5)) edges++
      if (on !== (alpha01[i + w] >= 0.5)) edges++
    }
  }

  if (o.feather > 0) blurAlpha(alpha01, w, h, o.feather)

  let cleared = 0
  for (let i = 0, p = 3; i < alpha01.length; i++, p += 4) {
    const a = alpha01[i]
    if (a < 0.5) cleared++
    data[p] = Math.round(data[p] * a)
  }
  return { cleared, edges, total: w * h }
}

const hashOpts = (o) =>
  [o.mode, o.color, o.tolerance, o.feather, o.contiguous ? 1 : 0, o.shrink].join('|')

/**
 * A keyed copy of one decoded frame, memoised per bitmap.
 *
 * GIF frames are stable objects for the life of the asset, so a WeakMap keyed on
 * the bitmap keeps scrubbing and playback cheap — each frame is keyed once per
 * settings change, not once per repaint.
 */
export function keyedFrame(bitmap, opts) {
  const key = hashOpts({ ...defaultBgRemove(), ...opts })
  const hit = cache.get(bitmap)
  if (hit && hit.key === key) return hit.canvas

  const w = bitmap.naturalWidth || bitmap.width
  const h = bitmap.naturalHeight || bitmap.height
  if (!w || !h) return bitmap

  const canvas = hit?.canvas || document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  ctx.clearRect(0, 0, w, h)
  ctx.drawImage(bitmap, 0, 0)
  const img = ctx.getImageData(0, 0, w, h)
  keyImageData(img, opts)
  ctx.putImageData(img, 0, 0)

  cache.set(bitmap, { key, canvas })
  return canvas
}

/**
 * Judges how the key is doing, so the UI can be honest rather than silently
 * emitting a mess. Colour keying genuinely cannot separate every scene, and the
 * useful thing is to say so.
 */
export function analyzeKey(bitmap, opts) {
  const w = bitmap.naturalWidth || bitmap.width
  const h = bitmap.naturalHeight || bitmap.height
  const c = document.createElement('canvas')
  c.width = w
  c.height = h
  const ctx = c.getContext('2d', { willReadFrequently: true })
  ctx.drawImage(bitmap, 0, 0)
  const img = ctx.getImageData(0, 0, w, h)
  const { cleared, edges, total } = keyImageData(img, opts)

  const removed = cleared / total
  // Normalised against the perimeter one clean blob of this area would have:
  // a tidy mask lands near 1, speckle runs into the tens.
  const fragmentation = edges / Math.max(1, 4 * Math.sqrt(Math.max(1, cleared)))

  // Be careful what this claims. A green screen legitimately removes ~94% of the
  // frame, so a high removal fraction is not evidence of failure — and nothing
  // here can tell "removed the background" from "removed the subject too",
  // because that needs to know what the subject is. Only speckle and the
  // degenerate extremes are actually diagnosable.
  let verdict = 'ok'
  let note = ''
  if (removed > 0.995) {
    verdict = 'bad'
    note = 'Nothing is left — lower the tolerance.'
  } else if (removed < 0.02) {
    verdict = 'bad'
    note = 'Almost nothing matches the key — raise the tolerance, or pick the colour.'
  } else if (fragmentation > 6) {
    verdict = 'bad'
    note = 'Speckled, not a clean cut-out: this background is not separable by colour. '
      + 'Separating it needs subject detection, which a colour key cannot do.'
  } else if (fragmentation > 3) {
    verdict = 'warn'
    note = 'Patchy edges — try a different tolerance, or a little shrink.'
  } else {
    note = 'Check the result: a colour key cannot tell whether it took the background '
      + 'or the subject with it.'
  }
  return { removed, fragmentation, verdict, note }
}
