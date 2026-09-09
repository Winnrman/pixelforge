// Alignment snapping.
//
// While a layer is dragged its left / centre / right and top / centre / bottom
// are compared against the canvas edges and centre — and against the same six
// lines on every other layer. The nearest match inside a tolerance wins, the
// drag is nudged onto it, and the line it matched is handed back so the canvas
// can draw a guide.
//
// Snapping only to the canvas is the useful half of nothing: laying a word over
// a picture, what it has to line up with is the other word, and the canvas
// centre is rarely where either of them belongs.
//
// A guide against another layer is drawn as a segment reaching from one box to
// the other rather than across the whole canvas, because what it is saying is
// "these two agree" — and a line through the whole frame says that about
// everything it crosses.
//
// The tolerance is expressed in screen pixels and converted by the caller, so
// snapping feels the same whether you are zoomed to 20% or 400%.

export const SNAP_TOLERANCE = 6 // screen px

/** The lines a rect can land on, in document space. */
function canvasTargets(doc, others = []) {
  const x = [
    { at: 0, kind: 'edge' },
    { at: doc.width / 2, kind: 'center' },
    { at: doc.width, kind: 'edge' },
  ]
  const y = [
    { at: 0, kind: 'edge' },
    { at: doc.height / 2, kind: 'center' },
    { at: doc.height, kind: 'edge' },
  ]
  for (const b of others) {
    if (!(b.w > 0 && b.h > 0)) continue
    x.push(
      { at: b.x, kind: 'layer', box: b },
      { at: b.x + b.w / 2, kind: 'layer', box: b },
      { at: b.x + b.w, kind: 'layer', box: b },
    )
    y.push(
      { at: b.y, kind: 'layer', box: b },
      { at: b.y + b.h / 2, kind: 'layer', box: b },
      { at: b.y + b.h, kind: 'layer', box: b },
    )
  }
  return { x, y }
}

function bestForAxis(edges, targets, tol) {
  let best = null
  for (const e of edges) {
    for (const t of targets) {
      const delta = t.at - e.value
      const dist = Math.abs(delta)
      if (dist > tol) continue
      // Ties go to the canvas, which is the more meaningful line to have landed
      // on and the one already drawn across the whole frame.
      const better = !best || dist < best.dist
        || (dist === best.dist && best.kind === 'layer' && t.kind !== 'layer')
      if (better) best = { delta, dist, at: t.at, kind: t.kind, box: t.box }
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
export function snapRect(rect, doc, tol = 6, others = []) {
  const targets = canvasTargets(doc, others)
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

  // Where the moved rect ends up, so a guide against another layer can be drawn
  // reaching between the two of them and no further.
  const landed = { ...rect, x: rect.x + (x ? x.delta : 0), y: rect.y + (y ? y.delta : 0) }
  const guides = []
  if (x) guides.push({ axis: 'x', at: x.at, kind: x.kind, span: spanFor(x, landed, 'y') })
  if (y) guides.push({ axis: 'y', at: y.at, kind: y.kind, span: spanFor(y, landed, 'x') })
  return { dx: x ? x.delta : 0, dy: y ? y.delta : 0, guides }
}

/** How far a guide reaches along the axis it is not on: both boxes, and no more. */
function spanFor(hit, landed, axis) {
  if (!hit?.box) return null
  const a = axis === 'y'
    ? [landed.y, landed.y + landed.h]
    : [landed.x, landed.x + landed.w]
  const b = axis === 'y'
    ? [hit.box.y, hit.box.y + hit.box.h]
    : [hit.box.x, hit.box.x + hit.box.w]
  return { from: Math.min(a[0], b[0]), to: Math.max(a[1], b[1]) }
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
