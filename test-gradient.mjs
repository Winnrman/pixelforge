// The gradient line, under plain node.
//
// Two colours and an angle is simple enough that the only thing to get wrong is
// the geometry — and getting it wrong does not look wrong, it looks like a
// gradient that is subtly banded at the corners or never quite reaches its end
// colour. Neither announces itself, so it is worth pinning down.
import {
  gradientLine, isGradient, seedStop, gradientOf, stopPatch, gradientAxis, stopAt,
  gradientBox, placeIn, withAlpha, gradientPatch,
} from './src/engine/gradient.js'

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
// One end of a colour dissolving into whatever is behind it is a gradient, and
// it is the same colour at both ends — so the opacities count too.
check('the same colour at two opacities is still a gradient',
  isGradient('#fff', '#fff', 1, 0))
check('and at the same opacity is still not', !isGradient('#fff', '#fff', 0.5, 0.5))

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

// --- one gradient, two spellings ------------------------------------------------
// A shape fills and a text layer colours, so the same three things are `fill`,
// `fill2`, `fillAngle` on one and `color`, `color2`, `colorAngle` on the other.
// Everything downstream wants the gradient, not the spelling.
{
  const shape = { type: 'shape', fill: '#f00', fill2: '#00f', fillAngle: 30, fillStop: 0.2, fillStop2: 0.8 }
  const text = { type: 'text', color: '#f00', color2: '#00f', colorAngle: 30 }
  check('a shape gradient reads out under one name', gradientOf(shape)?.angle === 30
    && gradientOf(shape).stop === 0.2 && gradientOf(shape).stop2 === 0.8,
    JSON.stringify(gradientOf(shape)))
  check('and a text one under the other', gradientOf(text)?.from === '#f00'
    && gradientOf(text).angle === 30, JSON.stringify(gradientOf(text)))
  check('a flat layer has no gradient at all',
    gradientOf({ type: 'shape', fill: '#f00', fill2: null }) === null)
  check('and neither has anything else', gradientOf({ type: 'image', fill: '#f00', fill2: '#00f' }) === null)
  check('stops default to the whole run', gradientOf(text).stop === 0 && gradientOf(text).stop2 === 1,
    JSON.stringify(gradientOf(text)))

  check('a stop is written back under the right name',
    JSON.stringify(stopPatch(shape, { stop2: 0.4 })) === '{"fillStop2":0.4}',
    JSON.stringify(stopPatch(shape, { stop2: 0.4 })))
  check('and so is a text one',
    JSON.stringify(stopPatch(text, { stop: 0.4 })) === '{"colorStop":0.4}',
    JSON.stringify(stopPatch(text, { stop: 0.4 })))
  check('a stop dragged past either end is held there',
    stopPatch(shape, { stop: -3 }).fillStop === 0 && stopPatch(shape, { stop: 9 }).fillStop === 1)
}

// --- the bar the knobs sit on ---------------------------------------------------
{
  const l = {
    type: 'shape', x: 100, y: 100, w: 200, h: 100, rotation: 0,
    fill: '#f00', fill2: '#00f', fillAngle: 0, fillStop: 0, fillStop2: 1,
  }
  const axis = gradientAxis(l)
  check('the bar runs the width of the box at 0 degrees',
    near(axis.p0.x, 100) && near(axis.p1.x, 300) && near(axis.p0.y, 150) && near(axis.p1.y, 150),
    JSON.stringify({ p0: axis.p0, p1: axis.p1 }))
  check('with a knob at each end while the stops are at each end',
    near(axis.a.x, axis.p0.x) && near(axis.b.x, axis.p1.x), JSON.stringify({ a: axis.a, b: axis.b }))

  const pulled = gradientAxis({ ...l, fillStop2: 0.25 })
  check('and the second knob a quarter along when it is dragged there',
    near(pulled.b.x, 150) && near(pulled.a.x, 100), JSON.stringify(pulled.b))

  // Turning the layer turns the bar with it, because the gradient is the
  // shape's, not the page's.
  const turned = gradientAxis({ ...l, rotation: 90 })
  check('a turned layer turns its bar',
    near(turned.p0.x, 200) && near(turned.p0.y, 50) && near(turned.p1.y, 250),
    JSON.stringify({ p0: turned.p0, p1: turned.p1 }))

  // Where the pointer is *along* the bar. Off to one side is not an error and
  // not an angle to change: it is the same place on the line, which is what
  // lets the bar be drawn clear of the box handles it would otherwise sit on.
  check('a point on the bar reads as its place along it', near(stopAt(axis, 150, 150), 0.25),
    String(stopAt(axis, 150, 150)))
  check('and a point beside the bar reads exactly the same',
    near(stopAt(axis, 150, 400), 0.25), String(stopAt(axis, 150, 400)))
  check('past the end is the end', stopAt(axis, -500, 150) === 0 && stopAt(axis, 5000, 150) === 1)
  check('a flat layer has no bar', gradientAxis({ ...l, fill2: null }) === null)
}

// --- what a gradient measures itself against ------------------------------------
// The layer's own box is right for one shape and wrong the moment a title is two
// text layers: each measures itself, so the ramp restarts on the second word
// instead of running through the pair.
{
  const top = { type: 'text', x: 100, y: 100, w: 300, h: 150, color: '#f00', color2: '#00f' }
  const bottom = { type: 'text', x: 100, y: 250, w: 300, h: 150, color: '#f00', color2: '#00f' }

  check('a layer measuring itself has no special box',
    gradientBox({ ...top, gradientSpan: 'layer' }, [top, bottom]) === null)
  check('and neither has one with nothing to span',
    gradientBox({ ...top, gradientSpan: 'group' }, []) === null)

  const box = gradientBox({ ...top, gradientSpan: 'group' }, [top, bottom])
  check('spanning the group takes in every member',
    near(box.x, 100) && near(box.y, 100) && near(box.w, 300) && near(box.h, 300),
    JSON.stringify(box))

  // A turned member sticking out of the union would take the end colour and
  // nothing else, so the box is what each layer actually occupies.
  const turned = { ...bottom, rotation: 90 }
  const wide = gradientBox({ ...top, gradientSpan: 'group' }, [top, turned])
  check('a turned member is measured by the room it really takes',
    wide.h > 300, JSON.stringify(wide))
}

// --- placing it in whichever frame the caller is already in -----------------------
{
  const l = { type: 'shape', x: 100, y: 100, w: 200, h: 100, rotation: 0 }
  const own = placeIn(l, null)
  check('with no box a shape is placed on itself',
    near(own.cx, 200) && near(own.cy, 150) && near(own.w, 200) && near(own.h, 100),
    JSON.stringify(own))
  // The bug this pins: spreading layerCenter gave x and y where cx and cy were
  // wanted, so every gradient centred on the origin and the whole shape came out
  // flat in the end colour.
  check('and names the centre the way paintFor reads it',
    own.cx !== undefined && own.cy !== undefined && own.x === undefined,
    JSON.stringify(own))

  const local = placeIn(l, null, { local: true })
  check('text is placed about the origin, its context being centred already',
    local.cx === 0 && local.cy === 0 && local.rotation === 0, JSON.stringify(local))

  const box = { x: 0, y: 0, w: 400, h: 400 }
  const doc = placeIn(l, box)
  check('a group box needs no conversion for a shape',
    near(doc.cx, 200) && near(doc.cy, 200) && doc.rotation === 0, JSON.stringify(doc))

  // Text draws inside a transform centred and turned on its own box, so a box
  // measured across the group has to be brought into that frame — and the
  // gradient turned back, or a tilted word would tilt the shared ramp with it.
  const tilted = { ...l, rotation: 90 }
  const inText = placeIn(tilted, box, { local: true })
  check('and is converted into the text’s own frame',
    near(inText.rotation, -90) && near(inText.w, 400), JSON.stringify(inText))
  check('with the group centre carried into that frame',
    near(Math.hypot(inText.cx, inText.cy), Math.hypot(200 - 200, 200 - 150)),
    JSON.stringify(inText))
}

// --- an opacity per end -----------------------------------------------------------
// The layer's own opacity is one number for the whole thing, so a pink end at
// 30% and a blue one at 90% is not something it can say.
{
  check('a solid colour is left as it was', withAlpha('#ff00aa', 1) === '#ff00aa')
  check('and so is one a hair off solid', withAlpha('#ff00aa', 0.9995) === '#ff00aa')
  check('anything less becomes rgba', withAlpha('#ff00aa', 0.3) === 'rgba(255, 0, 170, 0.300)',
    withAlpha('#ff00aa', 0.3))
  check('nothing at all is nothing at all', withAlpha('#ffffff', 0) === 'rgba(255, 255, 255, 0.000)',
    withAlpha('#ffffff', 0))
  check('past either end is held there',
    withAlpha('#ffffff', -2) === 'rgba(255, 255, 255, 0.000)' && withAlpha('#ffffff', 9) === '#ffffff')
  check('and something it cannot read is handed back untouched',
    withAlpha('rgb(1,2,3)', 0.5) === 'rgb(1,2,3)')

  const l = { type: 'shape', fill: '#f00', fill2: '#00f', fillAlpha: 0.3, fillAlpha2: 0.9 }
  const g = gradientOf(l)
  check('a layer carries an opacity for each end',
    g.alpha === 0.3 && g.alpha2 === 0.9, JSON.stringify(g))
  check('and they are written back under the layer’s own names',
    JSON.stringify(gradientPatch(l, { alpha: 0.5, alpha2: 0.25 }))
      === '{"fillAlpha":0.5,"fillAlpha2":0.25}',
    JSON.stringify(gradientPatch(l, { alpha: 0.5, alpha2: 0.25 })))
  check('a text layer under its own',
    JSON.stringify(gradientPatch({ type: 'text' }, { alpha: 0.5 })) === '{"colorAlpha":0.5}')
  check('and one end fading out makes a gradient of one colour',
    gradientOf({ type: 'shape', fill: '#f00', fill2: '#f00', fillAlpha: 1, fillAlpha2: 0 }) !== null)
}

console.log(checks.filter(([, o]) => o).length + ' of ' + checks.length + ' passed')
process.exit(checks.some(([, ok]) => !ok) ? 1 : 0)
