// A mask made of more than one outline, under plain node.
//
// A mask used to be a single outline, which made it a thing you could only throw
// away and redraw. That is fine for a rectangle and useless for a cut-out
// subject: an outline that took a slice off somebody's leg is not one anybody
// wants to draw again from scratch, and the repair is to draw the missing piece
// and add it.
//
// Several outlines union, which canvas does for nothing when they are filled as
// subpaths of one path — but only while they are wound the same way round. That
// is the whole of the arithmetic here, and it is the part that fails silently:
// wound against each other, the overlap reads as a hole and adding a piece bites
// a chunk out of the subject instead of filling one in.
import { maskPolys, maskBounds, signedArea, windSame, hasMask } from '../../src/engine/shapes.js'

const checks = []
const check = (name, ok, detail = '') => {
  checks.push([name, ok])
  console.log((ok ? 'PASS  ' : 'FAIL  ') + name + (detail ? '  — ' + detail : ''))
}
const near = (a, b, tol = 0.001) => Math.abs(a - b) <= tol

const square = [[0, 0], [1, 0], [1, 1], [0, 1]]
const widdershins = [...square].reverse()

// --- what a mask is made of -----------------------------------------------------
{
  const one = { mask: { points: square } }
  check('a plain mask is one outline', maskPolys(one).length === 1)
  check('and still reads as a mask', hasMask(one))

  const two = { mask: { points: square, plus: [[[2, 0], [3, 0], [3, 1], [2, 1]]] } }
  check('an added piece is another outline', maskPolys(two).length === 2)
  check('the original first, because it is the one the box was fitted to',
    maskPolys(two)[0] === square)

  check('a scrap of an outline is not one',
    maskPolys({ mask: { points: square, plus: [[[0, 0], [1, 1]]] } }).length === 1)
  check('and nothing at all is no outlines', maskPolys({}).length === 0)
  check('an empty layer is not masked', !hasMask({}) && !hasMask(null))
}

// --- winding ---------------------------------------------------------------------
{
  check('the two ways round an outline have opposite signs',
    Math.sign(signedArea(square)) === -Math.sign(signedArea(widdershins)),
    `${signedArea(square)} against ${signedArea(widdershins)}`)
  check('winding an outline twice changes nothing the second time',
    signedArea(windSame(windSame(square))) === signedArea(windSame(square)),
    `${signedArea(windSame(square))}`)
  check('and the two ways round end up the same way round',
    signedArea(windSame(widdershins)) === signedArea(windSame(square)),
    `${signedArea(windSame(widdershins))} against ${signedArea(windSame(square))}`)
  check('so any two outlines end up wound together',
    [square, widdershins, [[0, 0], [0, 2], [2, 2], [2, 0]]]
      .map((p) => Math.sign(signedArea(windSame(p))))
      .every((sgn, _, all) => sgn === all[0]))
  // Not a shape at all: three points in a line have no area and no direction to
  // get wrong, and must not throw on the way through.
  check('a flat outline survives being wound', Array.isArray(windSame([[0, 0], [1, 1], [2, 2]])))
}

// --- the extent, over every outline -----------------------------------------------
// What the frame is grown to hold. Measuring only the first outline is the bug
// this exists to stop: the added piece is exactly the part that reaches outside.
{
  const b = maskBounds({ mask: { points: [[0.2, 0.2], [0.5, 0.2], [0.5, 0.5], [0.2, 0.5]] } })
  check('one outline bounds itself',
    near(b.u0, 0.2) && near(b.u1, 0.5) && near(b.v0, 0.2) && near(b.v1, 0.5), JSON.stringify(b))

  const b2 = maskBounds({
    mask: {
      points: [[0.2, 0.2], [0.5, 0.2], [0.5, 0.5], [0.2, 0.5]],
      plus: [[[0.8, -0.3], [1.4, -0.3], [1.4, 0.4], [0.8, 0.4]]],
    },
  })
  check('and an added piece outside the frame is measured with it',
    near(b2.u0, 0.2) && near(b2.u1, 1.4) && near(b2.v0, -0.3) && near(b2.v1, 0.5),
    JSON.stringify(b2))
  check('nothing masked has no extent', maskBounds({}) === null)
}

console.log(checks.filter(([, o]) => o).length + ' of ' + checks.length + ' passed')
process.exit(checks.some(([, ok]) => !ok) ? 1 : 0)
