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

import { layerCenter } from './shapes.js'

const rad = (deg) => (deg * Math.PI) / 180
const clamp01 = (v) => Math.max(0, Math.min(1, Number.isFinite(v) ? v : 0))

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
  from, to, angle = 0, w, h, cx = 0, cy = 0, rotation = 0, stop = 0, stop2 = 1,
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
  // Where along the line each colour sits. Both at 0 and 1 is an even fade
  // across the whole box; pushing the second along leaves the first solid until
  // it, which is how one colour is given the majority. Sorted rather than
  // refused, because dragging one handle past the other is a thing that happens
  // and the answer is the gradient the other way round, not nothing.
  const a = clamp01(stop)
  const b = clamp01(stop2)
  g.addColorStop(Math.min(a, b), a <= b ? from : to)
  g.addColorStop(Math.max(a, b), a <= b ? to : from)
  return g
}

/**
 * A layer's gradient, whatever the layer calls it.
 *
 * A shape fills and a text layer colours, so the same three things are `fill`,
 * `fill2`, `fillAngle` on one and `color`, `color2`, `colorAngle` on the other.
 * Everything downstream — the renderer, the canvas handles, the inspector —
 * wants the gradient, not the spelling, so the spelling stops here.
 *
 * Null when there is no gradient, which is the same question as "is this flat".
 */
export function gradientOf(l) {
  const p = l?.type === 'text' ? 'color' : l?.type === 'shape' ? 'fill' : null
  if (!p) return null
  const from = p === 'fill' ? l.fill : l.color
  const to = p === 'fill' ? l.fill2 : l.color2
  if (!isGradient(from, to)) return null
  return {
    prop: p,
    from,
    to,
    angle: (p === 'fill' ? l.fillAngle : l.colorAngle) ?? 90,
    stop: clamp01((p === 'fill' ? l.fillStop : l.colorStop) ?? 0),
    stop2: clamp01((p === 'fill' ? l.fillStop2 : l.colorStop2) ?? 1),
  }
}

/** A patch setting a layer's stops, under whichever names that layer uses. */
export function stopPatch(l, { stop, stop2 }) {
  const p = l?.type === 'text' ? 'color' : 'fill'
  const out = {}
  if (stop !== undefined) out[`${p}Stop`] = clamp01(stop)
  if (stop2 !== undefined) out[`${p}Stop2`] = clamp01(stop2)
  return out
}

/**
 * The gradient's axis across a layer, in document coordinates.
 *
 * `p0` and `p1` are the ends of the run — where a stop at 0 and a stop at 1
 * would sit — and `a` and `b` are where the two stops actually are. The
 * overlay draws these and the pointer is hit-tested against them, from the one
 * function, because a handle drawn anywhere but where it is grabbed is worse
 * than no handle at all.
 */
export function gradientAxis(l) {
  const g = gradientOf(l)
  if (!g) return null
  const line = gradientLine(l.w, l.h, g.angle)
  if (!(line.len > 0.01)) return null
  const c = layerCenter(l)
  const t = rad(l.rotation || 0)
  const cos = Math.cos(t)
  const sin = Math.sin(t)
  const at = (x, y) => ({ x: c.x + x * cos - y * sin, y: c.y + x * sin + y * cos })
  const p0 = at(line.x0, line.y0)
  const p1 = at(line.x1, line.y1)
  const lerp = (u) => ({ x: p0.x + (p1.x - p0.x) * u, y: p0.y + (p1.y - p0.y) * u })
  return { ...g, p0, p1, a: lerp(g.stop), b: lerp(g.stop2) }
}

/** Where a document point falls along a gradient's axis, 0 to 1. */
export function stopAt(axis, x, y) {
  const dx = axis.p1.x - axis.p0.x
  const dy = axis.p1.y - axis.p0.y
  const d2 = dx * dx + dy * dy
  if (!d2) return 0
  return clamp01(((x - axis.p0.x) * dx + (y - axis.p0.y) * dy) / d2)
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
