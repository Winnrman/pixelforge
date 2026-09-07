// The clone stamp.
//
// Paint over something with a piece of the picture from somewhere else — a
// watermark, a blemish, a stray object. The tool everyone reaches for and few
// image editors make pleasant.
//
// Strokes are kept as points and an offset, never as pixels, for the same
// reason the eraser is: everything in this editor is resolution-independent and
// undoable, and a clone that baked pixels would be the one operation that could
// not be taken back cleanly, could not scale with its layer, and would grow
// every saved project by a full-size copy of the image.
//
// The offset is the whole idea. A stroke records where the paint came *from*
// relative to where it went, so the same stroke replayed at any scale samples
// the same part of the picture.

import { rad, layerCenter } from './shapes.js'

export const defaultStamp = () => ({
  size: 0.08,        // fraction of the layer's width
  hardness: 0.7,     // 1 = a hard edge, 0 = fully soft
})

export const hasClone = (l) => (l?.clone?.strokes?.length || 0) > 0

/**
 * A stroke ready to collect points.
 *
 * `offset` is source minus destination, in layer fractions, fixed when the
 * stroke begins. Fixed, because a source that moved with the brush would smear
 * rather than copy — and fixed per *stroke*, so lifting the pointer and
 * painting again continues from the same relationship rather than resetting it.
 */
export const newStamp = (brush, offset, first) => ({
  size: brush.size,
  hardness: brush.hardness,
  ox: offset[0],
  oy: offset[1],
  pts: first ? [first] : [],
})

/**
 * Paints the clone strokes onto `ctx`, sampling `picture` — which must be the
 * layer as it would otherwise be drawn, in the same document coordinates.
 *
 * Each stroke is drawn into a scratch surface as a mask, the picture is drawn
 * through it shifted by the offset, and the result goes down over the original.
 * One surface per stroke rather than one for all of them, because strokes with
 * different offsets sample different places and cannot share a stencil.
 */
export function paintClone(ctx, layer, picture, strokes, scratchFor) {
  if (!strokes?.length) return
  const c = layerCenter(layer)
  const a = rad(layer.rotation || 0)
  const cos = Math.cos(a)
  const sin = Math.sin(a)
  const w = ctx.canvas.width
  const h = ctx.canvas.height

  // Layer fractions to document points, the same mapping the eraser uses.
  const at = (pt) => {
    const lx = (pt[0] - 0.5) * layer.w
    const ly = (pt[1] - 0.5) * layer.h
    return { x: c.x + lx * cos - ly * sin, y: c.y + lx * sin + ly * cos }
  }

  for (const st of strokes) {
    if (!st.pts?.length) continue
    const width = Math.max(0.5, (st.size || 0.08) * Math.abs(layer.w))
    const soft = (1 - Math.min(1, Math.max(0, st.hardness ?? 0.7))) * width * 0.5

    const sc = scratchFor(w, h)
    const sx = sc.getContext('2d')
    sx.setTransform(1, 0, 0, 1, 0, 0)
    sx.globalAlpha = 1
    sx.globalCompositeOperation = 'source-over'
    sx.filter = 'none'
    sx.clearRect(0, 0, w, h)

    // The offset in document units, rotated with the layer so a tilted layer
    // samples along its own axes rather than the screen's.
    const ox = st.ox * layer.w
    const oy = st.oy * layer.h
    const dx = ox * cos - oy * sin
    const dy = ox * sin + oy * cos
    // Negated, and the sign is the whole trick. The offset is *source minus
    // destination*; drawing the picture at that offset would put the source
    // where it already is and sample from the far side of the brush instead —
    // for a source up and to the left, straight off the edge of the picture.
    // Shifting by the negative is what brings the source under the brush.
    sx.drawImage(picture, -dx, -dy)

    // Punch the picture down to the stroke's shape.
    sx.save()
    sx.globalCompositeOperation = 'destination-in'
    sx.filter = soft > 0.4 ? `blur(${soft.toFixed(2)}px)` : 'none'
    sx.strokeStyle = '#fff'
    sx.fillStyle = '#fff'
    sx.lineWidth = Math.max(0.5, width - soft)
    sx.lineCap = 'round'
    sx.lineJoin = 'round'
    if (st.pts.length === 1) {
      const p = at(st.pts[0])
      sx.beginPath()
      sx.arc(p.x, p.y, Math.max(0.5, (width - soft) / 2), 0, Math.PI * 2)
      sx.fill()
    } else {
      sx.beginPath()
      const p0 = at(st.pts[0])
      sx.moveTo(p0.x, p0.y)
      for (let i = 1; i < st.pts.length; i++) {
        const p = at(st.pts[i])
        sx.lineTo(p.x, p.y)
      }
      sx.stroke()
    }
    sx.restore()

    ctx.drawImage(sc, 0, 0)
  }
}

/** A document point as a 0..1 position in the layer box. */
export function docToLayerPoint(l, px, py) {
  const c = layerCenter(l)
  const a = -rad(l.rotation || 0)
  const dx = px - c.x
  const dy = py - c.y
  const lx = dx * Math.cos(a) - dy * Math.sin(a)
  const ly = dx * Math.sin(a) + dy * Math.cos(a)
  return [lx / l.w + 0.5, ly / l.h + 0.5]
}
