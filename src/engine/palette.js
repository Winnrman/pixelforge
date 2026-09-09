// The colours already in the picture.
//
// A cover looks designed rather than assembled when the type picks up a colour
// that is *in* the photograph — and finding that colour by eye means the
// eyedropper, a guess, and a second guess. So the picture is asked what it is
// made of, and the answer sits under every colour control in the app.
//
// The quantiser is deliberately small and its own: a five-bit-per-channel
// histogram, sorted by how much of the frame each bucket covers, then thinned so
// no two survivors are near neighbours. A photograph of a room is nine hundred
// shades of the same brown, and a palette of nine hundred browns is not a
// palette — the thinning is most of what makes this useful rather than merely
// correct.
//
// Pure arithmetic over pixel bytes, so it can be checked without a browser.

/** How far apart two colours are, weighted the way the eye is. */
export function colorDistance(a, b) {
  const dr = a[0] - b[0]
  const dg = a[1] - b[1]
  const db = a[2] - b[2]
  // Green carries most of the luminance, so an equal step in green is a bigger
  // difference than an equal step in blue. Same weighting the wand uses.
  return Math.sqrt(dr * dr * 0.9 + dg * dg * 1.6 + db * db * 0.5)
}

const hex = (c) => '#' + c.map((v) => Math.max(0, Math.min(255, Math.round(v)))
  .toString(16).padStart(2, '0')).join('')

/**
 * The colours a picture is mostly made of, most-used first.
 *
 * `data` is RGBA bytes — an `ImageData.data`, or anything shaped like one.
 * Transparent pixels are not colours and are left out, so a cut-out subject
 * gives the subject's palette rather than a majority vote for whatever the
 * background used to be.
 */
export function paletteFromPixels(data, { count = 6, minDistance = 46 } = {}) {
  if (!data || data.length < 4) return []
  const bins = new Map()
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] < 128) continue
    // Five bits a channel: fine enough to keep two genuinely different colours
    // apart, coarse enough that a gradient does not become a thousand buckets.
    const key = ((data[i] >> 3) << 10) | ((data[i + 1] >> 3) << 5) | (data[i + 2] >> 3)
    const b = bins.get(key)
    if (b) {
      b.n += 1
      b.r += data[i]
      b.g += data[i + 1]
      b.b += data[i + 2]
    } else {
      bins.set(key, { n: 1, r: data[i], g: data[i + 1], b: data[i + 2] })
    }
  }
  if (!bins.size) return []

  const sorted = [...bins.values()].sort((a, b) => b.n - a.n)
  const picked = []
  for (const b of sorted) {
    const c = [b.r / b.n, b.g / b.n, b.b / b.n]
    // Near neighbours of something already taken are the same colour as far as
    // anyone using this is concerned.
    if (picked.every((p) => colorDistance(p, c) >= minDistance)) picked.push(c)
    if (picked.length >= count) break
  }
  return picked.map(hex)
}

/**
 * The same, from a canvas or an image, downscaled first.
 *
 * A palette does not get better for being counted over eight million pixels —
 * the proportions of a photograph survive being shrunk to a thumbnail, which is
 * the whole reason a thumbnail is recognisable. So it is measured on a small
 * copy, and costs about a millisecond.
 */
export function paletteOf(src, opts = {}) {
  const sw = src?.naturalWidth || src?.width
  const sh = src?.naturalHeight || src?.height
  if (!sw || !sh) return []
  const side = opts.side || 96
  const k = Math.min(1, side / Math.max(sw, sh))
  const w = Math.max(1, Math.round(sw * k))
  const h = Math.max(1, Math.round(sh * k))
  const c = document.createElement('canvas')
  c.width = w
  c.height = h
  const ctx = c.getContext('2d', { willReadFrequently: true })
  ctx.imageSmoothingEnabled = true
  ctx.drawImage(src, 0, 0, w, h)
  return paletteFromPixels(ctx.getImageData(0, 0, w, h).data, opts)
}
