// Alignment snapping.
//
// While a layer is dragged its left / centre / right and top / centre / bottom
// are compared against the canvas edges and centre. The nearest match inside a
// tolerance wins, the drag is nudged onto it, and the line it matched is handed
// back so the canvas can draw a guide.
//
// The tolerance is expressed in screen pixels and converted by the caller, so
// snapping feels the same whether you are zoomed to 20% or 400%.

export const SNAP_TOLERANCE = 6 // screen px

/** The lines a rect can land on, in document space. */
function canvasTargets(doc) {
  return {
    x: [
      { at: 0, kind: 'edge' },
      { at: doc.width / 2, kind: 'center' },
      { at: doc.width, kind: 'edge' },
    ],
    y: [
      { at: 0, kind: 'edge' },
      { at: doc.height / 2, kind: 'center' },
      { at: doc.height, kind: 'edge' },
    ],
  }
}

function bestForAxis(edges, targets, tol) {
  let best = null
  for (const e of edges) {
    for (const t of targets) {
      const delta = t.at - e.value
      const dist = Math.abs(delta)
      if (dist > tol) continue
      if (!best || dist < best.dist) best = { delta, dist, at: t.at, kind: t.kind }
    }
  }
  return best
}

/**
 * Snaps a rect against the canvas.
 *
 * Returns the nudge to apply and the guides to draw. Both axes are decided
 * independently, so a layer can land on the vertical centre while staying free
 * horizontally.
 */
export function snapRect(rect, doc, tol = 6) {
  const targets = canvasTargets(doc)
  const x = bestForAxis([
    { value: rect.x, edge: 'left' },
    { value: rect.x + rect.w / 2, edge: 'center' },
    { value: rect.x + rect.w, edge: 'right' },
  ], targets.x, tol)
  const y = bestForAxis([
    { value: rect.y, edge: 'top' },
    { value: rect.y + rect.h / 2, edge: 'center' },
    { value: rect.y + rect.h, edge: 'bottom' },
  ], targets.y, tol)

  const guides = []
  if (x) guides.push({ axis: 'x', at: x.at, kind: x.kind })
  if (y) guides.push({ axis: 'y', at: y.at, kind: y.kind })
  return { dx: x ? x.delta : 0, dy: y ? y.delta : 0, guides }
}

/** Union of several layer boxes, in document space. */
export function unionBox(boxes) {
  let x0 = Infinity
  let y0 = Infinity
  let x1 = -Infinity
  let y1 = -Infinity
  for (const b of boxes) {
    x0 = Math.min(x0, b.x)
    y0 = Math.min(y0, b.y)
    x1 = Math.max(x1, b.x + b.w)
    y1 = Math.max(y1, b.y + b.h)
  }
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 }
}
