// Painted erasing.
//
// Strokes are kept as points, not as a raster. Everything else in this editor
// is non-destructive and resolution-independent, and an eraser that baked
// pixels would be the one thing you could not undo cleanly, could not scale
// with the layer, and would bloat every save with a full-size alpha channel.
//
// Points are normalised 0..1 against the layer box — the same convention the
// lasso mask uses — so a stroke follows its layer when it is moved, resized or
// rotated instead of sliding off it.
import { rad, layerCenter } from './shapes.js'

export const defaultBrush = () => ({
  size: 0.06,        // fraction of the layer's width
  hardness: 0.65,    // 1 = a hard edge, 0 = fully soft
  mode: 'erase',     // or 'restore', which paints erased pixels back
})

export const hasErase = (l) => (l?.erase?.strokes?.length || 0) > 0

/** A stroke ready to collect points. Size is stored with it, so changing the
 *  brush afterwards does not rewrite strokes already painted. */
export const newStroke = (brush, first) => ({
  size: brush.size,
  hardness: brush.hardness,
  mode: brush.mode,
  pts: first ? [first] : [],
})

/**
 * A closed region rather than a brush line — what a lasso hands over.
 *
 * It lives in the same list as brush strokes on purpose. A lasso erase used to
 * be written as the layer's *mask*, inverted, and a layer has exactly one mask:
 * erasing a second region silently put the first one back. As a stroke it
 * accumulates like every other stroke, undoes one at a time, can be restored,
 * scales with the layer, and is already understood by the sticker cut and the
 * "Erased" panel — none of which had to learn a new shape.
 */
export const newRegion = (points, mode = 'erase') => ({
  kind: 'region',
  mode,
  pts: points,
})

/**
 * Paints the stroke set onto `ctx` in white, in document coordinates.
 *
 * The caller decides what that means: `destination-out` erases, and the same
 * shapes drawn with `destination-in` would keep only what was painted. Restore
 * strokes are skipped here and handled by the caller in a second pass, because
 * "put back what an earlier stroke removed" cannot be expressed in one pass
 * over a single alpha channel.
 */
export function paintStrokes(ctx, l, strokes, { restore = false, map = null, scale = 1 } = {}) {
  const c = layerCenter(l)
  const a = rad(l.rotation || 0)
  const cos = Math.cos(a)
  const sin = Math.sin(a)

  // Layer fractions to wherever the caller is drawing: document points by
  // default, or asset pixels when a sticker bakes its own cutout.
  const project = map || ((pt) => {
    const lx = (pt[0] - 0.5) * l.w
    const ly = (pt[1] - 0.5) * l.h
    return { x: c.x + lx * cos - ly * sin, y: c.y + lx * sin + ly * cos }
  })

  for (const st of strokes) {
    if (!st.pts?.length) continue
    if ((st.mode === 'restore') !== restore) continue

    // A region is a filled outline with no width to it — a lasso does not have
    // a brush size, and giving it one would spread the cut past the line the
    // user drew.
    if (st.kind === 'region') {
      if (st.pts.length < 3) continue
      ctx.save()
      ctx.filter = 'none'
      ctx.fillStyle = '#fff'
      ctx.beginPath()
      const q0 = project(st.pts[0])
      ctx.moveTo(q0.x, q0.y)
      for (let i = 1; i < st.pts.length; i++) {
        const q = project(st.pts[i])
        ctx.lineTo(q.x, q.y)
      }
      ctx.closePath()
      ctx.fill()
      ctx.restore()
      continue
    }

    // `scale` converts the doc-space brush width into whatever space `map`
    // lands in — asset pixels, when a sticker bakes its own cutout.
    const width = Math.max(0.5, (st.size || 0.05) * Math.abs(l.w) * scale)
    // Softness is a blur, and a blur spreads the stroke — so a soft brush is
    // drawn slightly thinner to keep its *covered* width matching the cursor.
    const soft = (1 - Math.min(1, Math.max(0, st.hardness ?? 0.65))) * width * 0.5
    ctx.save()
    ctx.filter = soft > 0.4 ? `blur(${soft.toFixed(2)}px)` : 'none'
    ctx.strokeStyle = '#fff'
    ctx.fillStyle = '#fff'
    ctx.lineWidth = Math.max(0.5, width - soft)
    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'

    const at = project

    if (st.pts.length === 1) {
      // A tap is a dot, not nothing.
      const p = at(st.pts[0])
      ctx.beginPath()
      ctx.arc(p.x, p.y, Math.max(0.5, (width - soft) / 2), 0, Math.PI * 2)
      ctx.fill()
    } else {
      ctx.beginPath()
      const p0 = at(st.pts[0])
      ctx.moveTo(p0.x, p0.y)
      for (let i = 1; i < st.pts.length; i++) {
        const p = at(st.pts[i])
        ctx.lineTo(p.x, p.y)
      }
      ctx.stroke()
    }
    ctx.restore()
  }
}

/** Whether any stroke would put pixels back, which decides if a second pass is needed. */
export const hasRestore = (l) => !!l?.erase?.strokes?.some((s) => s.mode === 'restore')

/** A document point as a 0..1 position in the layer box. */
export function docToLayer(l, px, py) {
  const c = layerCenter(l)
  const a = -rad(l.rotation || 0)
  const dx = px - c.x
  const dy = py - c.y
  const lx = dx * Math.cos(a) - dy * Math.sin(a)
  const ly = dx * Math.sin(a) + dy * Math.cos(a)
  return [lx / l.w + 0.5, ly / l.h + 0.5]
}
