// Editing a stretch of an outline, under plain node.
//
// One point at a time is fine for a rectangle and hopeless for a traced subject,
// where the part that came out wrong is forty points along one side. So a run of
// points can be banded and then treated as one thing: dragged, or dropped.
//
// Dropping is the interesting half. The outline is a closed loop, so taking a
// run out of it leaves no hole — the points either side become neighbours and
// the loop closes straight across. That is the repair, not a side effect of it:
// band the place where a trace wandered off into the background and back, delete
// it, and what is left is a straight line between the two places it was right.
import {
  bandRect, pointsInRect, nearSelection, dropPoints, movePoints, selectionBounds,
} from '../../src/engine/lassoedit.js'

const checks = []
const check = (name, ok, detail = '') => {
  checks.push([name, ok])
  console.log((ok ? 'PASS  ' : 'FAIL  ') + name + (detail ? '  — ' + detail : ''))
}

// A ten-point loop: a square with an excursion out to the right along the top,
// standing in for a trace that wandered into the background and came back.
const loop = [
  [0, 0], [10, 0],
  [12, 1], [14, 2], [12, 3],          // the excursion — indices 2, 3, 4
  [10, 4], [10, 20], [0, 20], [-1, 10], [-1, 5],
]

// --- the band ------------------------------------------------------------------
{
  const r = bandRect([10, 8], [2, 3])
  check('a band is the same rectangle whichever corner it started from',
    r.x === 2 && r.y === 3 && r.w === 8 && r.h === 5, JSON.stringify(r))
  check('and a band of no size is still a rectangle',
    JSON.stringify(bandRect([4, 4], [4, 4])) === '{"x":4,"y":4,"w":0,"h":0}')

  const got = pointsInRect(loop, bandRect([11, -1], [15, 4]))
  check('it picks out the points inside it and no others',
    got.join() === '2,3,4', got.join())
  check('by index, so the same point twice over is still two points',
    pointsInRect([[1, 1], [1, 1]], { x: 0, y: 0, w: 2, h: 2 }).join() === '0,1')
  check('a band on the edge of a point takes it, being a selection and not a cut',
    pointsInRect([[5, 5]], { x: 5, y: 5, w: 0, h: 0 }).length === 1)
  check('and a band over nothing picks nothing',
    pointsInRect(loop, { x: 100, y: 100, w: 5, h: 5 }).length === 0)
}

// --- taking hold of what was picked ------------------------------------------------
{
  check('pressing on a picked point means the whole run',
    nearSelection(loop, [2, 3, 4], [14.5, 2.2], 1))
  check('pressing well away from it does not',
    !nearSelection(loop, [2, 3, 4], [5, 15], 1))
  check('and an unpicked point is not something to take hold of',
    !nearSelection(loop, [2, 3, 4], [0, 0], 1))
  check('nothing picked means nothing to grab', !nearSelection(loop, [], [0, 0], 1))
}

// --- moving it ------------------------------------------------------------------
{
  const moved = movePoints(loop, [2, 3, 4], -3, 0)
  check('every point in the run moves together',
    moved[2][0] === 9 && moved[3][0] === 11 && moved[4][0] === 9,
    JSON.stringify(moved.slice(2, 5)))
  check('and nothing else moves at all',
    moved[0][0] === 0 && moved[5][0] === 10 && moved.length === loop.length)
  check('the outline it was given is left alone',
    loop[2][0] === 12, String(loop[2][0]))
  check('moving nothing is not moving everything',
    JSON.stringify(movePoints(loop, [], 5, 5)) === JSON.stringify(loop))
}

// --- dropping it ------------------------------------------------------------------
{
  const cut = dropPoints(loop, [2, 3, 4])
  check('a run can be dropped', cut.ok === true, JSON.stringify(cut))
  check('and says how many went', cut.removed === 3, String(cut.removed))
  check('what is left is the rest of the outline, in order',
    cut.points.length === 7 && cut.points[1][0] === 10 && cut.points[2][0] === 10,
    JSON.stringify(cut.points))
  // The whole point: the loop closes across the gap by itself, because a closed
  // outline has no ends for a gap to be left in.
  check('the points either side of the gap are neighbours now',
    JSON.stringify(cut.points[1]) === '[10,0]' && JSON.stringify(cut.points[2]) === '[10,4]',
    JSON.stringify(cut.points.slice(1, 3)))
  check('the excursion is gone from the outline',
    !cut.points.some((q) => q[0] > 10), JSON.stringify(cut.points))

  // An outline that quietly became a line would apply as an empty mask and look
  // like the tool had eaten the layer, so it refuses and says why.
  const most = dropPoints([[0, 0], [1, 0], [1, 1], [0, 1]], [0, 1])
  check('dropping down to two points is refused', most.ok === false, JSON.stringify(most))
  check('and it says why rather than leaving you to guess',
    /three/.test(most.reason || ''), most.reason)
  check('three left is still an outline',
    dropPoints([[0, 0], [1, 0], [1, 1], [0, 1]], [3]).ok === true)
  check('dropping nothing is refused too, having nothing to do',
    dropPoints(loop, []).ok === false)
}

// --- the box drawn round it ---------------------------------------------------------
{
  const b = selectionBounds(loop, [2, 3, 4])
  check('a run has a box round it',
    b.x === 12 && b.y === 1 && b.w === 2 && b.h === 2, JSON.stringify(b))
  check('one point is a box of no size, not nothing',
    JSON.stringify(selectionBounds(loop, [0])) === '{"x":0,"y":0,"w":0,"h":0}')
  check('and nothing picked has no box at all', selectionBounds(loop, []) === null)
  check('an index that is not there is skipped rather than crashing',
    selectionBounds(loop, [99]) === null)
}

console.log(checks.filter(([, o]) => o).length + ' of ' + checks.length + ' passed')
process.exit(checks.some(([, ok]) => !ok) ? 1 : 0)
