// Editing a stretch of an outline rather than one point of it.
//
// Dragging points one at a time is fine for a rectangle and hopeless for a
// traced subject, where the part that came out wrong is forty points along one
// side. So a run of points can be picked out with a band and then treated as a
// single thing: dragged somewhere else, or dropped.
//
// Dropping is the interesting one. The outline is a closed loop, so taking a run
// out of it does not leave a hole — the points either side of the gap become
// neighbours and the loop closes straight across. That is exactly what you want
// when a trace has wandered off into the background and back: band the excursion
// and delete it, and what is left is a straight line between the two places it
// was still right.
//
// All of it is plain arithmetic on `[x, y]` pairs in document space, kept out of
// the canvas component so it can be checked without a browser.

/** The rectangle between two corners, however they were dragged. */
export function bandRect(a, b) {
  return {
    x: Math.min(a[0], b[0]),
    y: Math.min(a[1], b[1]),
    w: Math.abs(a[0] - b[0]),
    h: Math.abs(a[1] - b[1]),
  }
}

/** Which points fall inside a band, as indices into `points`. */
export function pointsInRect(points, rect) {
  const out = []
  for (let i = 0; i < (points?.length || 0); i++) {
    const [x, y] = points[i]
    if (x >= rect.x && x <= rect.x + rect.w && y >= rect.y && y <= rect.y + rect.h) out.push(i)
  }
  return out
}

/** Whether a point is close enough to the picked run to mean "drag this". */
export function nearSelection(points, indices, p, tol) {
  for (const i of indices || []) {
    const q = points?.[i]
    if (q && Math.hypot(p[0] - q[0], p[1] - q[1]) <= tol) return true
  }
  return false
}

/**
 * The outline with a run of points taken out of it.
 *
 * Refuses rather than truncates below three: two points are not a shape, and an
 * outline that quietly became a line would apply as an empty mask and look like
 * the tool had eaten the layer.
 */
export function dropPoints(points, indices) {
  const drop = new Set(indices || [])
  if (!drop.size) return { ok: false, reason: 'Nothing picked out to remove.' }
  const kept = (points || []).filter((_, i) => !drop.has(i))
  if (kept.length < 3) {
    return { ok: false, reason: 'An outline needs three points — that would leave too few.' }
  }
  return { ok: true, points: kept, removed: (points?.length || 0) - kept.length }
}

/** The outline with a run of points shifted, and the rest left where it was. */
export function movePoints(points, indices, dx, dy) {
  const move = new Set(indices || [])
  return (points || []).map((q, i) => (move.has(i) ? [q[0] + dx, q[1] + dy] : q))
}

/** The box round a run of points, for drawing it as one thing. */
export function selectionBounds(points, indices) {
  const picked = (indices || []).map((i) => points?.[i]).filter(Boolean)
  if (!picked.length) return null
  const xs = picked.map((q) => q[0])
  const ys = picked.map((q) => q[1])
  const x = Math.min(...xs)
  const y = Math.min(...ys)
  return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y }
}
