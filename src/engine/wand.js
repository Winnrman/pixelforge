// Selecting by colour.
//
// The AI lasso finds *subjects*, which is exactly why it cannot help with a
// flat background, a logo, a sky, or a panel of a screenshot: the model is
// answering a different question. This answers the plain one — take everything
// that looks like what I clicked.
//
// The result is a mask in the same shape `maskToPolygon` already consumes, so
// what comes back is an ordinary lasso and every action that follows one —
// Copy, Cut, Mask, Erase, Pixelate — works on it unchanged.

/** Working resolution. Selecting by colour does not need full size, and the
 *  outline is smoothed and simplified afterwards regardless. */
const MAX_SIDE = 900

/**
 * Perceptual-ish distance between two colours, 0..1.
 *
 * Weighted towards green because the eye is, so a tolerance that feels right on
 * one hue feels roughly right on another. Not a real colour space — the point
 * is a slider that behaves predictably, not colorimetry.
 */
function distance(r1, g1, b1, r2, g2, b2) {
  const dr = (r1 - r2) / 255
  const dg = (g1 - g2) / 255
  const db = (b1 - b2) / 255
  return Math.sqrt((dr * dr * 0.3 + dg * dg * 0.59 + db * db * 0.11) / 0.3333)
}

/**
 * A mask of everything within `tolerance` of the colour at (x, y).
 *
 * `x` and `y` are fractions of the frame, so a caller does not have to know what
 * resolution this chose to work at.
 *
 * Alpha is part of the answer: a transparent pixel is not "the same colour" as
 * an opaque one that happens to share its RGB, and on a cut-out layer the
 * background is transparent rather than any particular colour.
 */
export function colorMask(source, x, y, opts = {}) {
  const { tolerance = 0.18, maxSide = MAX_SIDE } = opts
  const sw = source.naturalWidth || source.width
  const sh = source.naturalHeight || source.height
  if (!sw || !sh) return null
  const k = Math.min(1, maxSide / Math.max(sw, sh))
  const w = Math.max(2, Math.round(sw * k))
  const h = Math.max(2, Math.round(sh * k))

  const c = typeof OffscreenCanvas !== 'undefined'
    ? new OffscreenCanvas(w, h)
    : Object.assign(document.createElement('canvas'), { width: w, height: h })
  const ctx = c.getContext('2d', { willReadFrequently: true })
  ctx.clearRect(0, 0, w, h)
  ctx.drawImage(source, 0, 0, w, h)
  const px = ctx.getImageData(0, 0, w, h).data

  const sx = Math.max(0, Math.min(w - 1, Math.round(x * w)))
  const sy = Math.max(0, Math.min(h - 1, Math.round(y * h)))
  const at = (sy * w + sx) * 4
  const r0 = px[at]
  const g0 = px[at + 1]
  const b0 = px[at + 2]
  const a0 = px[at + 3]

  const mask = new Float32Array(w * h)
  for (let i = 0, p = 0; i < mask.length; i++, p += 4) {
    const da = Math.abs(px[p + 3] - a0) / 255
    if (da > tolerance) continue
    // Two transparent pixels match whatever their stored RGB says, because
    // nothing was ever drawn there to disagree about.
    if (a0 < 8 && px[p + 3] < 8) { mask[i] = 1; continue }
    const d = distance(px[p], px[p + 1], px[p + 2], r0, g0, b0)
    if (d <= tolerance) mask[i] = 1
  }
  return { mask, w, h, seed: { x: sx, y: sy }, color: [r0, g0, b0, a0] }
}

/** How much of the frame a mask covers, 0..1 — for telling a useful selection
 *  from one that took the whole picture. */
export function coverage(mask) {
  let n = 0
  for (let i = 0; i < mask.length; i++) if (mask[i]) n++
  return n / mask.length
}
