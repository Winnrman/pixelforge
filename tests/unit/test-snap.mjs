// Alignment snapping, under plain node.
//
// Snapping only to the canvas is the useful half of nothing. Laying a word over
// a picture, what it has to line up with is the other word — and the canvas
// centre is rarely where either of them belongs.
import { snapRect, snapResize, unionBox, SNAP_TOLERANCE } from '../../src/engine/snap.js'
import { gridLines, defaultGrid } from '../../src/engine/grid.js'

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

// --- the page's own lines -----------------------------------------------------------
// Layers snapping to each other line things up with whatever happens to be
// nearby, which is the difference between elements placed and elements composed.
// A margin says where the page stops; columns say where a line of type may begin.
{
  const page = { width: 1000, height: 1400 }
  const off = gridLines(page, { ...defaultGrid(), on: false })
  check('a grid that is off draws nothing', off.x.length === 0 && off.y.length === 0)

  const g = gridLines(page, { on: true, margin: 50, columns: 3, gutter: 20, rows: 0 })
  // 1000 wide, 50 each side, three columns and two 20px gutters: (900-40)/3.
  check('the margins are the outer lines',
    g.x.includes(50) && g.x.includes(950) && g.y.includes(50) && g.y.includes(1350),
    JSON.stringify(g))
  check('three columns come out the right width',
    g.columns.length === 3 && Math.abs(g.columns[0].w - 286.667) < 0.01,
    JSON.stringify(g.columns))
  check('and they are spaced by the gutter',
    Math.abs(g.columns[1].x - (g.columns[0].x + g.columns[0].w + 20)) < 0.01,
    JSON.stringify(g.columns.map((c) => c.x)))
  // Both sides of every column, because type is set inside a band and the far
  // side of a gutter is where the next band starts rather than where this ends.
  check('every column edge is a line to land on', g.x.length === 6, g.x.join())
  check('with no line said twice',
    new Set(g.x).size === g.x.length && new Set(g.y).size === g.y.length)

  const rows = gridLines(page, { on: true, margin: 50, columns: 1, gutter: 0, rows: 3 })
  check('rows divide the space between the margins',
    rows.y.length === 4 && Math.abs(rows.y.sort((a, b) => a - b)[1] - 483.33) < 0.5,
    rows.y.join())
  check('and one row is no division at all',
    gridLines(page, { on: true, margin: 50, columns: 1, gutter: 0, rows: 1 }).y.length === 2)

  // A margin bigger than the page has nowhere to be.
  const silly = gridLines({ width: 100, height: 100 }, { on: true, margin: 400, columns: 2 })
  check('a margin too big for the page is pulled back inside it',
    silly.x.every((v) => v >= 0 && v <= 100), silly.x.join())
}

// --- landing on it ------------------------------------------------------------------
{
  const page = { width: 1000, height: 1000 }
  const lines = gridLines(page, { on: true, margin: 60, columns: 2, gutter: 40 })
  const hit = snapRect({ x: 57, y: 300, w: 100, h: 50 }, page, 6, [], lines)
  check('a layer near a margin lands on it', Math.abs(hit.dx - 3) < 0.001, String(hit.dx))
  check('and says it was the grid rather than the canvas',
    hit.guides[0].kind === 'grid', JSON.stringify(hit.guides))
  check('without a grid the same layer is left alone',
    snapRect({ x: 57, y: 300, w: 100, h: 50 }, page, 6, []).dx === 0)
}

// --- resizing lands too ---------------------------------------------------------------
// Dragging a corner is not moving a box: only the edges the handle names may
// move, or the far side would be dragged along with the near one.
{
  const page = { width: 1000, height: 1000 }
  const other = { x: 400, y: 0, w: 200, h: 100 }
  const box = { x: 100, y: 200, w: 297, h: 100 }

  const east = snapResize(box, 'e', page, 6, [other])
  check('the edge being dragged lands on another layer',
    Math.abs(east.rect.w - 300) < 0.001 && east.rect.x === 100,
    JSON.stringify(east.rect))
  check('and the far side does not move', east.rect.x === box.x)

  const west = snapResize({ x: 397, y: 200, w: 200, h: 100 }, 'w', page, 6, [other])
  check('dragging the left edge moves the left edge',
    Math.abs(west.rect.x - 400) < 0.001 && Math.abs(west.rect.w - 197) < 0.001,
    JSON.stringify(west.rect))

  const corner = snapResize({ x: 397, y: 97, w: 200, h: 200 }, 'nw', page, 6, [other])
  check('a corner lands on both axes at once',
    Math.abs(corner.rect.x - 400) < 0.001 && Math.abs(corner.rect.y - 100) < 0.001,
    JSON.stringify(corner.rect))

  // A box dragged inside out is a box with a negative width, and the answer to
  // that is to stop rather than to flip.
  const tiny = snapResize({ x: 100, y: 200, w: 3, h: 100 }, 'w', page, 6,
    [{ x: 101, y: 0, w: 10, h: 400 }])
  check('and it never pulls an edge through the far one', tiny.rect.w > 0,
    JSON.stringify(tiny.rect))

  check('nothing in reach leaves the box exactly as it was',
    JSON.stringify(snapResize(box, 'e', page, 6, []).rect) === JSON.stringify(box))
}

// --- evenly spaced ---------------------------------------------------------------------
// Three things in a row with two different gaps read as a mistake however well
// their edges line up.
{
  const page = { width: 1000, height: 400 }
  const left = { x: 100, y: 100, w: 100, h: 100 }
  const right = { x: 600, y: 100, w: 100, h: 100 }
  // Even would be x = 350. Four out.
  const near = snapRect({ x: 354, y: 100, w: 100, h: 100 }, page, 6, [left, right])
  check('a box nearly evenly spaced is pulled to even',
    Math.abs(near.dx + 4) < 0.001, String(near.dx))
  check('and the two matching gaps are handed back to be drawn',
    near.spacing?.[0]?.spans?.length === 2, JSON.stringify(near.spacing))
  check('which are the same size', (() => {
    const [a, b] = near.spacing[0].spans
    return Math.abs((a.to - a.from) - (b.to - b.from)) < 0.001
  })(), JSON.stringify(near.spacing?.[0]?.spans))

  check('a box nowhere near even is left alone',
    snapRect({ x: 250, y: 100, w: 100, h: 100 }, page, 6, [left, right]).dx === 0)

  // Not in the row at all: a box up in the corner is not something this one is
  // spaced against, and treating it as one invents a rhythm nobody asked for.
  const away = snapRect({ x: 354, y: 100, w: 100, h: 100 }, page, 6,
    [left, { x: 600, y: 900, w: 100, h: 100 }])
  check('and a box that is not in the row does not count', away.dx === 0, String(away.dx))

  // Alignment is the stronger claim and wins the axis outright.
  const both = snapRect({ x: 354, y: 100, w: 100, h: 100 }, page, 6,
    [left, right, { x: 352, y: 300, w: 40, h: 40 }])
  check('a real alignment is never given up for a rhythm',
    Math.abs(both.dx + 2) < 0.001 && !both.spacing.length, JSON.stringify(both))
}

console.log(checks.filter(([, o]) => o).length + ' of ' + checks.length + ' passed')
process.exit(checks.some(([, ok]) => !ok) ? 1 : 0)
