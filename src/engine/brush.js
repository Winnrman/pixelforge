// How big a brush actually is, and how to show that.
//
// Every brush here is a fraction of the *layer* width rather than a number of
// pixels, which is what keeps a stroke the same size on the picture however far
// you are zoomed in. It also means the same setting is a different brush on
// every layer, and "6%" tells you nothing about what is about to be painted
// over. The ring on the canvas answers that once the pointer is out there; the
// preview in the rail answers it before you have committed to a stroke.
//
// The arithmetic is the same arithmetic `paintStrokes` uses to lay a stroke
// down, deliberately: a preview computed a second way is a preview that can
// disagree with the thing it is previewing.

const clamp01 = (v) => Math.max(0, Math.min(1, v))

/** The default a brush falls back to, matching `defaultBrush` in the store. */
const SIZE = 0.06
const HARDNESS = 0.65

/**
 * A brush in pixels, on whatever surface the caller is drawing to.
 *
 * `scale` is pixels of that surface per pixel of the document — the view zoom
 * for something drawn on screen, 1 for the document itself.
 */
export function brushMetrics(brush, layerW, scale = 1) {
  const raw = (brush?.size ?? SIZE) * Math.abs(layerW || 0) * scale
  // Floored so a brush is never nothing to draw. The floor belongs to drawing
  // and not to reporting, which is why the readout below measures `raw`: on no
  // layer at all the honest answer is no size, not half a pixel.
  const width = Math.max(0.5, raw)
  // Softness is a blur, and a blur spreads a stroke — so the drawn dot is
  // narrowed by what the blur will add back, which is what keeps the covered
  // width matching the ring the cursor shows.
  const soft = (1 - clamp01(brush?.hardness ?? HARDNESS)) * width * 0.5
  return { width, soft, raw, radius: Math.max(0.5, (width - soft) / 2) }
}

/**
 * The same brush, fitted into a preview box.
 *
 * To scale wherever it fits, because that is the whole point of it. A brush
 * bigger than the box is drawn as large as the box allows and says what it did
 * — a preview that silently shrinks is worse than no preview, since it reads as
 * a brush half the size of the one you are about to use.
 */
export function previewFit(brush, layerW, scale, box) {
  const m = brushMetrics(brush, layerW, scale)
  // The blur reaches past the dot, so the room needed is the dot plus its
  // spread. Without this the softest brushes clip their own falloff and read
  // as hard-edged at the box edge.
  const needed = m.width + m.soft * 2
  const room = Math.max(1, Math.min(box?.w || 0, box?.h || 0) - 2)
  const fit = needed > room ? room / needed : 1
  return {
    ...m,
    fit,
    exact: fit >= 1,
    // What the brush measures on the picture, which is the number that never
    // lies however the preview had to be drawn.
    px: Math.round(m.raw / (scale || 1)),
    drawn: { width: m.width * fit, soft: m.soft * fit, radius: m.radius * fit },
  }
}

/** How a fitted preview describes itself, or nothing when it is life-size. */
export function fitLabel(fit) {
  if (!(fit < 1)) return null
  const pct = Math.round(fit * 100)
  return `shown at ${pct}%`
}
