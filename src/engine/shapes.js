export const rad = (deg) => (deg * Math.PI) / 180

const clampInset = (v) => Math.min(0.98, Math.max(0, v || 0))

/**
 * Crop insets, as fractions of the layer box. These trim what the layer shows
 * without squashing it: the destination rect and the sampled source rect shrink
 * by the same amount, which is what makes an animated crop read as a reveal
 * rather than a stretch.
 */
export function cropInsets(l) {
  let cl = clampInset(l.cropL)
  let cr = clampInset(l.cropR)
  let ct = clampInset(l.cropT)
  let cb = clampInset(l.cropB)
  // Opposing insets can never eat the whole layer.
  if (cl + cr > 0.98) { const k = 0.98 / (cl + cr); cl *= k; cr *= k }
  if (ct + cb > 0.98) { const k = 0.98 / (ct + cb); ct *= k; cb *= k }
  return { cl, cr, ct, cb, kx: 1 - cl - cr, ky: 1 - ct - cb }
}

export const isCropped = (l) =>
  !!(l.cropL || l.cropR || l.cropT || l.cropB)

/** The part of a layer that is actually painted, in doc space (unrotated). */
export function visibleBox(l) {
  const c = cropInsets(l)
  return {
    x: l.x + c.cl * l.w,
    y: l.y + c.ct * l.h,
    w: l.w * c.kx,
    h: l.h * c.ky,
  }
}

export function layerCenter(l) {
  return { x: l.x + l.w / 2, y: l.y + l.h / 2 }
}

// Adds the layer's outline to the *current* path of ctx. Path coordinates bake
// the CTM at construction time, so the save/restore here leaves ctx untouched
// while still positioning the sub-path correctly.
export function addShapePath(ctx, l) {
  const c = layerCenter(l)
  const w = l.w
  const h = l.h
  ctx.save()
  ctx.translate(c.x, c.y)
  if (l.rotation) ctx.rotate(rad(l.rotation))

  switch (l.shape) {
    case 'ellipse':
      ctx.moveTo(w / 2, 0)
      ctx.ellipse(0, 0, Math.abs(w / 2), Math.abs(h / 2), 0, 0, Math.PI * 2)
      break
    case 'triangle':
      ctx.moveTo(0, -h / 2)
      ctx.lineTo(w / 2, h / 2)
      ctx.lineTo(-w / 2, h / 2)
      ctx.closePath()
      break
    case 'diamond':
      ctx.moveTo(0, -h / 2)
      ctx.lineTo(w / 2, 0)
      ctx.lineTo(0, h / 2)
      ctx.lineTo(-w / 2, 0)
      ctx.closePath()
      break
    case 'star': {
      const pts = l.starPoints || 5
      const inner = l.starInner ?? 0.45
      for (let i = 0; i < pts * 2; i++) {
        const a = (Math.PI * i) / pts - Math.PI / 2
        const r = i % 2 === 0 ? 1 : inner
        const px = Math.cos(a) * (w / 2) * r
        const py = Math.sin(a) * (h / 2) * r
        i === 0 ? ctx.moveTo(px, py) : ctx.lineTo(px, py)
      }
      ctx.closePath()
      break
    }
    case 'path': {
      const pts = l.points || []
      if (pts.length > 1) {
        for (let i = 0; i < pts.length; i++) {
          const px = (pts[i][0] - 0.5) * w
          const py = (pts[i][1] - 0.5) * h
          i === 0 ? ctx.moveTo(px, py) : ctx.lineTo(px, py)
        }
        ctx.closePath()
      }
      break
    }
    case 'rect':
    default: {
      const r = Math.min(l.radius || 0, Math.abs(w) / 2, Math.abs(h) / 2)
      if (r > 0 && ctx.roundRect) ctx.roundRect(-w / 2, -h / 2, w, h, r)
      else ctx.rect(-w / 2, -h / 2, w, h)
      break
    }
  }
  ctx.restore()
}

/**
 * Adds a layer's mask outline to the current path. Mask points are normalized
 * to the layer box (0..1), so the cut-out follows the layer when it is moved,
 * resized or rotated.
 */
export function addMaskPath(ctx, l) {
  const pts = l.mask?.points
  if (!pts || pts.length < 3) return
  const c = layerCenter(l)
  ctx.save()
  ctx.translate(c.x, c.y)
  if (l.rotation) ctx.rotate(rad(l.rotation))
  for (let i = 0; i < pts.length; i++) {
    const x = (pts[i][0] - 0.5) * l.w
    const y = (pts[i][1] - 0.5) * l.h
    i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)
  }
  ctx.closePath()
  ctx.restore()
}

export const hasMask = (l) => (l?.mask?.points?.length || 0) >= 3

// Axis-aligned bounding box of the (possibly rotated) layer box, in doc space.
export function layerAABB(l) {
  const c = layerCenter(l)
  if (!l.rotation) return { x: l.x, y: l.y, w: l.w, h: l.h }
  const a = rad(l.rotation)
  const cos = Math.abs(Math.cos(a))
  const sin = Math.abs(Math.sin(a))
  const w = l.w * cos + l.h * sin
  const h = l.w * sin + l.h * cos
  return { x: c.x - w / 2, y: c.y - h / 2, w, h }
}

export function corners(l) {
  const c = layerCenter(l)
  const a = rad(l.rotation || 0)
  const cos = Math.cos(a)
  const sin = Math.sin(a)
  const hw = l.w / 2
  const hh = l.h / 2
  return [
    [-hw, -hh], [hw, -hh], [hw, hh], [-hw, hh],
  ].map(([x, y]) => ({ x: c.x + x * cos - y * sin, y: c.y + x * sin + y * cos }))
}

// Point in doc space -> layer-local space (box centred at origin, unrotated).
export function toLocal(l, px, py) {
  const c = layerCenter(l)
  const a = -rad(l.rotation || 0)
  const dx = px - c.x
  const dy = py - c.y
  return { x: dx * Math.cos(a) - dy * Math.sin(a), y: dx * Math.sin(a) + dy * Math.cos(a) }
}

export function fromLocal(l, lx, ly) {
  const c = layerCenter(l)
  const a = rad(l.rotation || 0)
  return { x: c.x + lx * Math.cos(a) - ly * Math.sin(a), y: c.y + lx * Math.sin(a) + ly * Math.cos(a) }
}

let hitCanvas = null
function pathCtx() {
  if (!hitCanvas) hitCanvas = document.createElement('canvas')
  const ctx = hitCanvas.getContext('2d')
  ctx.setTransform(1, 0, 0, 1, 0, 0)
  return ctx
}

export function hitTest(l, px, py) {
  const p = toLocal(l, px, py)
  let inBox = Math.abs(p.x) <= Math.abs(l.w) / 2 && Math.abs(p.y) <= Math.abs(l.h) / 2
  if (inBox && l.type === 'image' && isCropped(l)) {
    // Cropped-away margin is empty, so it should not catch clicks.
    const c = cropInsets(l)
    const u = p.x / l.w + 0.5
    const v = p.y / l.h + 0.5
    inBox = u >= c.cl && u <= 1 - c.cr && v >= c.ct && v <= 1 - c.cb
  }
  if (!inBox) return false

  // A masked layer is only clickable where it is actually visible, so cut-out
  // pieces stacked on their original do not steal each other's clicks.
  if (hasMask(l)) {
    const ctx = pathCtx()
    ctx.beginPath()
    addMaskPath(ctx, l)
    const inside = ctx.isPointInPath(px, py)
    if (l.mask.invert ? inside : !inside) return false
  }

  if (l.type === 'image' || l.type === 'text' || !l.shape || l.shape === 'rect') return true
  const ctx = pathCtx()
  ctx.beginPath()
  addShapePath(ctx, l)
  return ctx.isPointInPath(px, py)
}

/** Doc-space bounding box of a polygon. */
export function polygonBounds(points) {
  let x0 = Infinity
  let y0 = Infinity
  let x1 = -Infinity
  let y1 = -Infinity
  for (const [x, y] of points) {
    if (x < x0) x0 = x
    if (y < y0) y0 = y
    if (x > x1) x1 = x
    if (y > y1) y1 = y
  }
  return { x: x0, y: y0, w: Math.max(1, x1 - x0), h: Math.max(1, y1 - y0) }
}

/** Doc-space polygon -> points normalized to a layer's box (0..1). */
export function polygonToLayer(points, l) {
  return points.map(([x, y]) => {
    const p = toLocal(l, x, y)
    return [p.x / l.w + 0.5, p.y / l.h + 0.5]
  })
}
