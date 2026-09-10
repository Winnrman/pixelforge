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
function canvasTargets(doc, others = [], lines = null) {
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
  // A margin or a column edge, which is a line the page itself declares rather
  // than one that happens to be where something was put. Ranked with the canvas
  // rather than with the layers for the same reason: it is a decision about the
  // page, so a tie against a passing layer goes to it.
  for (const at of lines?.x || []) x.push({ at, kind: 'grid' })
  for (const at of lines?.y || []) y.push({ at, kind: 'grid' })
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
      if (better) best = { delta, dist, at: t.at, kind: t.kind, box: t.box, edge: e.edge }
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
export function snapRect(rect, doc, tol = 6, others = [], lines = null) {
  const targets = canvasTargets(doc, others, lines)
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

  // Evenly spaced beats merely aligned: three things in a row with two different
  // gaps between them read as a mistake however well their edges line up. Only
  // looked for on an axis nothing else claimed, so a real alignment is never
  // given up for a rhythm.
  const even = { x: null, y: null }
  if (!x) even.x = evenGap(rect, others, tol, 'x')
  if (!y) even.y = evenGap(rect, others, tol, 'y')

  return {
    dx: x ? x.delta : (even.x?.delta || 0),
    dy: y ? y.delta : (even.y?.delta || 0),
    guides,
    spacing: [even.x, even.y].filter(Boolean),
  }
}

/**
 * A gap on one side that matches the gap on the other.
 *
 * Given a rect with a neighbour each side, there is one position where the two
 * gaps are equal — and being a few pixels off it is the thing that makes a row
 * of cards look hand-placed. This finds the nearest such position within the
 * tolerance and reports the two gaps so the canvas can mark them.
 *
 * Only neighbours that actually overlap the rect on the *other* axis count. A
 * box away up in the corner is not in this row, and treating it as one produces
 * a rhythm between things nobody would say were spaced at all.
 */
function evenGap(rect, others, tol, axis) {
  const p = axis === 'x' ? 'x' : 'y'
  const s = axis === 'x' ? 'w' : 'h'
  const q = axis === 'x' ? 'y' : 'x'
  const t = axis === 'x' ? 'h' : 'w'
  const near = others.filter((b) => b[s] > 0 && b[t] > 0
    && b[q] < rect[q] + rect[t] && b[q] + b[t] > rect[q])
  const before = near.filter((b) => b[p] + b[s] <= rect[p] + tol)
  const after = near.filter((b) => b[p] >= rect[p] + rect[s] - tol)
  if (!before.length || !after.length) return null

  let best = null
  for (const a of before) {
    for (const b of after) {
      const room = b[p] - (a[p] + a[s])
      const gap = (room - rect[s]) / 2
      if (gap < 0) continue
      const want = a[p] + a[s] + gap
      const delta = want - rect[p]
      if (Math.abs(delta) > tol) continue
      if (!best || Math.abs(delta) < Math.abs(best.delta)) {
        best = {
          axis,
          delta,
          gap,
          // The two stretches to mark, in document coordinates.
          spans: [
            { from: a[p] + a[s], to: want },
            { from: want + rect[s], to: b[p] },
          ],
          // Where to draw them: the middle of the overlap on the other axis.
          at: (Math.max(rect[q], Math.min(a[q], b[q]))
            + Math.min(rect[q] + rect[t], Math.max(a[q] + a[t], b[q] + b[t]))) / 2,
        }
      }
    }
  }
  return best
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

/**
 * Snaps the edges a resize handle is actually moving.
 *
 * Dragging a corner is not moving a box, and treating it as one would drag the
 * far side along with the near one. So only the edges named by the handle are
 * offered to the targets, and each lands on its own — which is what lets a box
 * be pulled out to exactly the width of the one above it, or to a column edge.
 *
 * The centre lines are deliberately absent: a resize does not move a centre to
 * anything, and offering the canvas centre to a growing edge would stick every
 * box halfway across the page on its way past.
 */
export function snapResize(rect, key, doc, tol = 6, others = [], lines = null) {
  const targets = canvasTargets(doc, others, lines)
  const out = { ...rect }
  const guides = []
  const k = String(key || '')

  const pull = (value, axis) => {
    const hit = bestForAxis([{ value, edge: 'edge' }], targets[axis], tol)
    return hit || null
  }

  if (k.includes('w')) {
    const hit = pull(rect.x, 'x')
    // Never through the far edge: a box dragged inside out is a box with a
    // negative width, and the answer to that is to stop rather than to flip.
    if (hit && rect.x + hit.delta < rect.x + rect.w - 1) {
      out.x = rect.x + hit.delta
      out.w = rect.w - hit.delta
      guides.push({ axis: 'x', at: hit.at, kind: hit.kind, span: spanFor(hit, out, 'y') })
    }
  }
  if (k.includes('e')) {
    const hit = pull(rect.x + rect.w, 'x')
    if (hit && rect.w + hit.delta > 1) {
      out.w = rect.w + hit.delta
      guides.push({ axis: 'x', at: hit.at, kind: hit.kind, span: spanFor(hit, out, 'y') })
    }
  }
  if (k.includes('n')) {
    const hit = pull(rect.y, 'y')
    if (hit && rect.y + hit.delta < rect.y + rect.h - 1) {
      out.y = rect.y + hit.delta
      out.h = rect.h - hit.delta
      guides.push({ axis: 'y', at: hit.at, kind: hit.kind, span: spanFor(hit, out, 'x') })
    }
  }
  if (k.includes('s')) {
    const hit = pull(rect.y + rect.h, 'y')
    if (hit && rect.h + hit.delta > 1) {
      out.h = rect.h + hit.delta
      guides.push({ axis: 'y', at: hit.at, kind: hit.kind, span: spanFor(hit, out, 'x') })
    }
  }
  return { rect: out, guides }
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
