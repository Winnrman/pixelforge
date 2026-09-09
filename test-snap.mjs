// Alignment snapping, under plain node.
//
// Snapping only to the canvas is the useful half of nothing. Laying a word over
// a picture, what it has to line up with is the other word — and the canvas
// centre is rarely where either of them belongs.
import { snapRect, unionBox, SNAP_TOLERANCE } from './src/engine/snap.js'

const checks = []
const check = (name, ok, detail = '') => {
  checks.push([name, ok])
  console.log((ok ? 'PASS  ' : 'FAIL  ') + name + (detail ? '  — ' + detail : ''))
}
const near = (a, b, tol = 0.001) => Math.abs(a - b) <= tol

const doc = { width: 1000, height: 600 }
const box = (x, y, w, h) => ({ x, y, w, h })

// --- the canvas, as before -------------------------------------------------------
{
  const off = snapRect(box(3, 200, 100, 50), doc, 6)
  check('a rect near the left edge is pulled onto it', near(off.dx, -3), String(off.dx))
  check('and says which line it landed on',
    off.guides.some((g) => g.axis === 'x' && g.at === 0 && g.kind === 'edge'),
    JSON.stringify(off.guides))

  const mid = snapRect(box(447, 200, 100, 50), doc, 6)
  check('the centre pulls a rect by its own centre', near(mid.dx, 3), String(mid.dx))
  check('and reads as a centre rather than an edge',
    mid.guides[0].kind === 'center', JSON.stringify(mid.guides))

  // Clear of every line on both axes. The first version of this used a box whose
  // right edge sat exactly on the canvas centre, so it was aligned already: dx
  // was zero for the opposite of the reason being checked.
  const far = snapRect(box(300, 200, 100, 50), doc, 6)
  check('nothing within reach means no nudge and no guide',
    far.dx === 0 && far.dy === 0 && far.guides.length === 0, JSON.stringify(far))

  const both = snapRect(box(3, 3, 100, 50), doc, 6)
  check('the two axes are decided separately',
    near(both.dx, -3) && near(both.dy, -3) && both.guides.length === 2, JSON.stringify(both))
}

// --- against another layer --------------------------------------------------------
{
  const anchor = box(200, 120, 300, 80)

  const left = snapRect(box(203, 300, 120, 60), doc, 6, [anchor])
  check('a rect near another layer left edge lands on it', near(left.dx, -3), String(left.dx))
  check('and the guide says it was a layer, not the canvas',
    left.guides[0].kind === 'layer' && left.guides[0].at === 200, JSON.stringify(left.guides))

  const right = snapRect(box(377, 300, 120, 60), doc, 6, [anchor])
  check('right edge to right edge works too',
    near(right.dx, 3) && right.guides[0].at === 500, JSON.stringify(right))

  const centred = snapRect(box(287, 300, 120, 60), doc, 6, [anchor])
  check('centre to centre works', near(centred.dx, 3) && centred.guides[0].at === 350,
    JSON.stringify(centred))

  const tops = snapRect(box(700, 123, 120, 60), doc, 6, [anchor])
  check('and the same six lines exist on the other axis',
    near(tops.dy, -3) && tops.guides[0].axis === 'y' && tops.guides[0].at === 120,
    JSON.stringify(tops))

  // A line across the whole frame claims agreement with everything it crosses.
  // Between two boxes it says only what it means.
  const span = left.guides[0].span
  check('a layer guide reaches from one box to the other and no further',
    span && span.from === 120 && span.to === 360, JSON.stringify(span))
  check('while a canvas guide has no span, being the whole frame',
    snapRect(box(3, 200, 100, 50), doc, 6).guides[0].span === null,
    JSON.stringify(snapRect(box(3, 200, 100, 50), doc, 6).guides[0]))
}

// --- which one wins ----------------------------------------------------------------
{
  // A layer edge sitting exactly on the canvas centre. Both are in reach and
  // equally near; the canvas is the more meaningful thing to have landed on and
  // its line is drawn across the frame anyway.
  const onCentre = box(500, 40, 200, 40)
  const tie = snapRect(box(497, 300, 100, 50), doc, 6, [onCentre])
  check('a tie between the canvas and a layer goes to the canvas',
    tie.guides[0].kind === 'center', JSON.stringify(tie.guides))

  // But a nearer layer beats a further canvas line.
  const near1 = snapRect(box(498, 300, 100, 50), doc, 6, [box(497, 40, 200, 40)])
  check('and a nearer layer beats a further canvas line',
    near1.guides[0].kind === 'layer', JSON.stringify(near1.guides))

  // The nearest of several layers wins.
  const many = snapRect(box(203, 300, 100, 50), doc, 6, [box(200, 40, 50, 50), box(206, 40, 50, 50)])
  check('the nearest of several layers is the one it lands on',
    near(many.dx, -3) && many.guides[0].at === 200, JSON.stringify(many))
}

// --- things that are not boxes -------------------------------------------------------
{
  const zero = snapRect(box(3, 200, 100, 50), doc, 6, [box(200, 120, 0, 0)])
  check('a layer with no size is not something to line up against',
    zero.guides.every((g) => g.kind !== 'layer'), JSON.stringify(zero.guides))
  check('and no other layers at all behaves as it always did',
    near(snapRect(box(3, 200, 100, 50), doc, 6, []).dx, -3))
}

// --- the union used to snap a whole selection ------------------------------------------
{
  const u = unionBox([box(10, 20, 30, 40), box(100, 5, 20, 10)])
  check('a union covers every box in it',
    u.x === 10 && u.y === 5 && u.w === 110 && u.h === 55, JSON.stringify(u))
}

check('the tolerance is in screen pixels, converted by the caller',
  SNAP_TOLERANCE > 0 && SNAP_TOLERANCE < 20, String(SNAP_TOLERANCE))

console.log(checks.filter(([, o]) => o).length + ' of ' + checks.length + ' passed')
process.exit(checks.some(([, ok]) => !ok) ? 1 : 0)
