// The gradient line, under plain node.
//
// Two colours and an angle is simple enough that the only thing to get wrong is
// the geometry — and getting it wrong does not look wrong, it looks like a
// gradient that is subtly banded at the corners or never quite reaches its end
// colour. Neither announces itself, so it is worth pinning down.
import { gradientLine, isGradient, seedStop } from './src/engine/gradient.js'

const checks = []
const check = (name, ok, detail = '') => {
  checks.push([name, ok])
  console.log((ok ? 'PASS  ' : 'FAIL  ') + name + (detail ? '  — ' + detail : ''))
}
const near = (a, b, tol = 0.001) => Math.abs(a - b) <= tol

// --- which pairs are a gradient at all -----------------------------------------
check('two colours make a gradient', isGradient('#fff', '#000'))
check('one does not', !isGradient('#fff', null))
check('and neither does the same one twice', !isGradient('#fff', '#fff'))
check('"none" is not a colour to fade into', !isGradient('#fff', 'none'))
check('nor to fade from', !isGradient('none', '#fff'))

// --- the line across the box ---------------------------------------------------
{
  const a = gradientLine(100, 50, 0)
  check('0 degrees runs left to right',
    near(a.x0, -50) && near(a.y0, 0) && near(a.x1, 50) && near(a.y1, 0), JSON.stringify(a))
  check('and is as long as the box is wide', near(a.len, 100), String(a.len))

  const b = gradientLine(100, 50, 90)
  check('90 runs top to bottom',
    near(b.x0, 0) && near(b.y0, -25) && near(b.x1, 0) && near(b.y1, 25), JSON.stringify(b))
  check('and is as long as the box is tall', near(b.len, 50), String(b.len))

  const c = gradientLine(100, 50, 180)
  check('180 is the same line the other way round',
    near(c.x0, 50) && near(c.x1, -50), JSON.stringify(c))

  // On a square, the diagonal case is the one that says whether the length is
  // right: corner to corner, not edge to edge and not the bounding circle.
  const d = gradientLine(100, 100, 45)
  check('45 on a square reaches corner to corner',
    near(d.x0, -50) && near(d.y0, -50) && near(d.x1, 50) && near(d.y1, 50), JSON.stringify(d))
}

// --- what the length is actually for -------------------------------------------
// Both end colours have to arrive exactly at the corners. Shorter and the
// corners are flat bands of the end colours; longer and neither end colour
// appears at full strength anywhere in the box. Either reads as a mistake and
// neither reads as *this* mistake, so it is checked as the invariant it is,
// across a spread of angles and shapes rather than at one convenient one.
{
  let worstLow = 1
  let worstHigh = 0
  let squashed = null
  for (const [w, h] of [[100, 50], [50, 100], [200, 200], [17, 300], [640, 360]]) {
    for (let angle = 0; angle < 360; angle += 7) {
      const g = gradientLine(w, h, angle)
      const dx = g.x1 - g.x0
      const dy = g.y1 - g.y0
      const d2 = dx * dx + dy * dy
      for (const [cx, cy] of [[-w / 2, -h / 2], [w / 2, -h / 2], [w / 2, h / 2], [-w / 2, h / 2]]) {
        // Where this corner falls along the gradient, 0 at one end and 1 at the other.
        const t = ((cx - g.x0) * dx + (cy - g.y0) * dy) / d2
        if (t < -0.001 || t > 1.001) squashed = { w, h, angle, t: +t.toFixed(4) }
        worstLow = Math.min(worstLow, t)
        worstHigh = Math.max(worstHigh, t)
      }
    }
  }
  check('no corner of any box falls outside the gradient', !squashed, JSON.stringify(squashed))
  check('and at every angle some corner reaches each end',
    near(worstLow, 0, 0.002) && near(worstHigh, 1, 0.002),
    `${worstLow.toFixed(4)} to ${worstHigh.toFixed(4)}`)
}

// --- the colour offered when you turn it on ------------------------------------
// Turning a gradient on has to show a gradient. Offered the same colour twice
// the button appears to do nothing, and the feature looks broken before it has
// been used once.
{
  const lum = (hex) => {
    const n = parseInt(hex.slice(1), 16)
    return (0.2126 * ((n >> 16) & 255) + 0.7152 * ((n >> 8) & 255) + 0.0722 * (n & 255)) / 255
  }
  const white = seedStop('#ffffff')
  const black = seedStop('#101018')
  const pink = seedStop('#ff2d78')
  check('a light colour is offered a darker one', lum(white) < lum('#ffffff') - 0.2,
    `${white} at ${lum(white).toFixed(2)}`)
  check('and a dark one a lighter one', lum(black) > lum('#101018') + 0.2,
    `${black} at ${lum(black).toFixed(2)}`)
  check('always something visibly different', isGradient('#ff2d78', pink) && pink !== '#ff2d78', pink)
  check('and something valid out of nonsense', /^#[0-9a-f]{6}$/.test(seedStop('not a colour')),
    seedStop('not a colour'))
  check('every stop it offers is a real six-digit colour',
    ['#000000', '#ffffff', '#808080', '#ff2d78', '#0a0a0a'].every((h) => /^#[0-9a-f]{6}$/.test(seedStop(h))))
}

console.log(checks.filter(([, o]) => o).length + ' of ' + checks.length + ' passed')
process.exit(checks.some(([, ok]) => !ok) ? 1 : 0)
