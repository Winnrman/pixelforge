// Two-stop gradients, for a shape's fill and a text layer's colour.
//
// Two colours and an angle, and nothing else. That is not a first instalment
// with the rest to follow: it is what people reach for, and every extra stop is
// a control that has to be understood before the first gradient can be made.
// A shape with one colour is a flat shape, which is why there is no mode to
// switch into — the second colour being unset *is* "no gradient".
//
// The angle is an ordinary number, which matters more than it sounds: it goes
// on a keyframe track like rotation or opacity, so a gradient can sweep across
// a title without anything here knowing that animation exists.

const rad = (deg) => (deg * Math.PI) / 180

/** Whether a pair of colours describes a gradient rather than a flat fill. */
export const isGradient = (from, to) => !!(
  from && to && from !== 'none' && to !== 'none' && from !== to
)

/**
 * The two ends of a gradient line across a `w` by `h` box centred on the origin.
 *
 * 0° runs left to right and the angle turns clockwise, so 90° runs top to
 * bottom — which is the one people mean when they say "a gradient" and is
 * therefore the default.
 *
 * The length is `|w·cos| + |h·sin|` rather than the width or the diagonal, so
 * that both end colours reach the corners exactly: shorter and the corners are
 * flat bands of the end colours, longer and neither end colour appears at full
 * strength anywhere in the box.
 */
export function gradientLine(w, h, angle = 0) {
  const a = rad(angle || 0)
  const dx = Math.cos(a)
  const dy = Math.sin(a)
  const len = Math.abs(w * dx) + Math.abs(h * dy)
  return {
    x0: (-dx * len) / 2,
    y0: (-dy * len) / 2,
    x1: (dx * len) / 2,
    y1: (dy * len) / 2,
    len,
  }
}

/**
 * What to put in `fillStyle`: the flat colour, or a gradient across the box.
 *
 * A canvas gradient is fixed in the space of the transform in force when it is
 * *painted*, so where the two ends go depends on what the caller has already
 * done to the context. Text draws inside a transform centred and rotated on its
 * own box, so it wants the line about the origin and no rotation here. A shape
 * path builds its own transform and puts it back, so by the time it fills, the
 * context is the document again and the line has to be moved and turned to meet
 * it — which is what `cx`, `cy` and `rotation` are for.
 */
export function paintFor(ctx, {
  from, to, angle = 0, w, h, cx = 0, cy = 0, rotation = 0,
}) {
  if (!isGradient(from, to)) return from
  const line = gradientLine(w, h, angle)
  // A box with no area has no gradient line to draw along, and a zero-length one
  // paints nothing at all rather than the flat colour you would expect.
  if (!(line.len > 0.01)) return from
  const t = rad(rotation || 0)
  const cos = Math.cos(t)
  const sin = Math.sin(t)
  const at = (x, y) => [cx + x * cos - y * sin, cy + x * sin + y * cos]
  const [x0, y0] = at(line.x0, line.y0)
  const [x1, y1] = at(line.x1, line.y1)
  const g = ctx.createLinearGradient(x0, y0, x1, y1)
  g.addColorStop(0, from)
  g.addColorStop(1, to)
  return g
}

/**
 * A second colour to start from, given the first.
 *
 * Turning a gradient on has to *show* a gradient — offered the same colour
 * twice, or white on white, the button appears to do nothing and the feature
 * looks broken. Halfway to black from a light colour and halfway to white from a
 * dark one is a visible ramp whatever the first colour was, and it is the same
 * hue, so it reads as a deliberate shade rather than a second colour chosen at
 * random.
 */
export function seedStop(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || '').trim())
  if (!m) return '#000000'
  const n = parseInt(m[1], 16)
  const rgb = [(n >> 16) & 255, (n >> 8) & 255, n & 255]
  const lum = (0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2]) / 255
  const towards = lum > 0.5 ? 0 : 255
  return '#' + rgb
    .map((c) => Math.round(c + (towards - c) * 0.55).toString(16).padStart(2, '0'))
    .join('')
}
