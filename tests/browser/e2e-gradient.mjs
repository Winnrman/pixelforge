// Gradients, on a shape's fill and a text layer's colour.
//
// Two colours and an angle. There is no gradient mode to switch into — the
// second colour being unset is what "flat" means — and the angle is an ordinary
// number, so it keyframes like rotation does and a gradient can sweep across a
// title without the animation system knowing gradients exist.
//
// Measured in pixels off a real render, because the failure this catches is not
// "no gradient" but "a gradient pointing the wrong way", and that is invisible
// to anything that only asks whether the fields were set.
import { chromium } from 'playwright-core'
import fs from 'fs'
import path from 'path'

const OUT = 'shots/gradient'
fs.mkdirSync(OUT, { recursive: true })

const browser = await chromium.launch({
  executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  headless: true,
})
const page = await browser.newPage({ viewport: { width: 1500, height: 950 } })
const errors = []
page.on('console', (m) => { if (m.type() === 'error' && !/favicon/.test(m.text())) errors.push(m.text()) })
page.on('pageerror', (e) => errors.push('PAGEERROR: ' + e.message))

const checks = []
const check = (name, ok, detail = '') => {
  checks.push([name, ok])
  console.log((ok ? 'PASS  ' : 'FAIL  ') + name + (detail ? '  — ' + detail : ''))
}

await page.goto('http://localhost:5173/', { waitUntil: 'networkidle' })
await page.evaluate(() => { indexedDB.deleteDatabase('pixelforge'); localStorage.clear() })
await page.reload({ waitUntil: 'networkidle' })
await page.waitForTimeout(400)

// A square of known colour, filling a known part of the document, so every
// sample below is a coordinate rather than a guess.
const SHAPE = { x: 100, y: 100, w: 300, h: 300 }
await page.evaluate(async (box) => {
  const st = window.__pfState()
  const { makeShapeLayer } = window.__pfStore
  const l = st.addLayer(makeShapeLayer({
    shape: 'rect', ...box, fill: '#ff0000', stroke: 'none', strokeWidth: 0, radius: 0,
  }))
  st.select([l.id])
  await new Promise((r) => setTimeout(r, 400))
}, SHAPE)

/** The document, rendered and sampled at document coordinates. */
const sample = (points) => page.evaluate((pts) => {
  const st = window.__pfState()
  const c = document.createElement('canvas')
  c.width = st.doc.width
  c.height = st.doc.height
  const ctx = c.getContext('2d', { willReadFrequently: true })
  window.__pfRender.renderDocument(ctx, st.doc, 0)
  const out = {}
  for (const [name, x, y] of pts) {
    const d = ctx.getImageData(x, y, 1, 1).data
    out[name] = [d[0], d[1], d[2], d[3]]
  }
  return out
}, points)

const CORNERS = [
  ['top', SHAPE.x + SHAPE.w / 2, SHAPE.y + 30],
  ['bottom', SHAPE.x + SHAPE.w / 2, SHAPE.y + SHAPE.h - 30],
  ['left', SHAPE.x + 30, SHAPE.y + SHAPE.h / 2],
  ['right', SHAPE.x + SHAPE.w - 30, SHAPE.y + SHAPE.h / 2],
]

// --- one colour is a flat shape -------------------------------------------------
const flat = await sample(CORNERS)
console.log('one colour:', JSON.stringify(flat))
check('a shape with one colour is flat all over',
  [flat.top, flat.bottom, flat.left, flat.right].every((p) => p[0] === 255 && p[1] === 0 && p[2] === 0),
  JSON.stringify(flat))

// --- two colours and an angle ---------------------------------------------------
const setGradient = (patch) => page.evaluate(async (p) => {
  const st = window.__pfState()
  st.updateLayer(st.doc.layers[0].id, p)
  await new Promise((r) => setTimeout(r, 300))
}, patch)

await setGradient({ fill2: '#0000ff', fillAngle: 90 })
const down = await sample(CORNERS)
console.log('90 degrees:', JSON.stringify(down))
check('90 degrees runs top to bottom',
  down.top[0] > 200 && down.top[2] < 60 && down.bottom[2] > 200 && down.bottom[0] < 60,
  JSON.stringify({ top: down.top, bottom: down.bottom }))
check('and the sides, being level with each other, match',
  Math.abs(down.left[0] - down.right[0]) < 6 && Math.abs(down.left[2] - down.right[2]) < 6,
  JSON.stringify({ left: down.left, right: down.right }))
check('with the halfway point actually halfway',
  Math.abs(down.left[0] - 127) < 12 && Math.abs(down.left[2] - 127) < 12, JSON.stringify(down.left))

await setGradient({ fillAngle: 0 })
const across = await sample(CORNERS)
console.log('0 degrees:', JSON.stringify(across))
check('0 degrees runs left to right',
  across.left[0] > 200 && across.left[2] < 60 && across.right[2] > 200 && across.right[0] < 60,
  JSON.stringify({ left: across.left, right: across.right }))

await setGradient({ fillAngle: 180 })
const back = await sample(CORNERS)
console.log('180 degrees:', JSON.stringify(back))
check('180 is the same gradient the other way round',
  back.right[0] > 200 && back.left[2] > 200, JSON.stringify({ left: back.left, right: back.right }))

// The end colours have to arrive at the very edge. A gradient line measured
// short leaves flat bands there and one measured long never reaches full
// strength at all — the edges are where both show.
await setGradient({ fillAngle: 0 })
const reach = await sample([
  ['near', SHAPE.x + 2, SHAPE.y + SHAPE.h / 2],
  ['far', SHAPE.x + SHAPE.w - 3, SHAPE.y + SHAPE.h / 2],
])
console.log('at the edges:', JSON.stringify(reach))
check('the first colour reaches the edge at full strength',
  reach.near[0] > 248 && reach.near[2] < 8, JSON.stringify(reach.near))
check('and so does the second', reach.far[2] > 248 && reach.far[0] < 8, JSON.stringify(reach.far))

// --- it turns with the shape ----------------------------------------------------
// The path builds its own transform and puts it back, so by the time the fill
// happens the context is the document again. A gradient that forgot that would
// stay pointing down while the shape turned under it.
await setGradient({ fillAngle: 90, rotation: 90 })
const turned = await sample(CORNERS)
console.log('turned a quarter:', JSON.stringify(turned))
check('turning the shape turns its gradient with it',
  turned.right[0] > 200 && turned.left[2] > 200,
  JSON.stringify({ left: turned.left, right: turned.right }))
check('and it is no longer running down the page',
  Math.abs(turned.top[0] - turned.bottom[0]) < 6,
  JSON.stringify({ top: turned.top, bottom: turned.bottom }))
await setGradient({ rotation: 0 })
await page.screenshot({ path: path.join(OUT, '01-shape.png') })

// --- text takes one too ---------------------------------------------------------
const text = await page.evaluate(async () => {
  const st = window.__pfState()
  st.doc.layers.forEach((l) => st.removeLayers([l.id]))
  await new Promise((r) => setTimeout(r, 300))
  const { makeTextLayer } = window.__pfStore
  const t = window.__pfState().addLayer(makeTextLayer({
    text: 'GRADIENT', x: 40, y: 200, w: 700, h: 200, size: 150, weight: 900,
    color: '#ff0000', strokeWidth: 0, autoSize: false, align: 'left',
  }))
  window.__pfState().select([t.id])
  await new Promise((r) => setTimeout(r, 400))

  // The highest and lowest lit pixels anywhere in the letters. Sampling a fixed
  // coordinate would be sampling whatever the font happens to do there.
  const scan = () => {
    const s2 = window.__pfState()
    const c = document.createElement('canvas')
    c.width = s2.doc.width
    c.height = s2.doc.height
    const ctx = c.getContext('2d', { willReadFrequently: true })
    window.__pfRender.renderDocument(ctx, s2.doc, 0)
    const d = ctx.getImageData(0, 0, c.width, c.height).data
    let hi = null
    let lo = null
    let lit = 0
    for (let y = 180; y < 420; y++) {
      for (let x = 20; x < 760; x++) {
        const i = (y * c.width + x) * 4
        if (d[i + 3] < 200) continue
        if (d[i] < 60 && d[i + 1] < 60) continue
        lit++
        if (!hi) hi = [d[i], d[i + 1], d[i + 2]]
        lo = [d[i], d[i + 1], d[i + 2]]
      }
    }
    return { hi, lo, lit }
  }
  const before = scan()
  window.__pfState().updateLayer(t.id, { color2: '#00ff00', colorAngle: 90 })
  await new Promise((r) => setTimeout(r, 400))
  const after = scan()
  return { id: t.id, before, after }
})
console.log('text, flat then graded:', JSON.stringify(text.before), '->', JSON.stringify(text.after))
check('there are letters on the canvas to look at', text.before.lit > 400, `${text.before.lit} px`)
check('flat text is one colour from top to bottom',
  text.before.hi[0] > 200 && text.before.lo[0] > 200 && text.before.hi[1] < 60,
  JSON.stringify(text.before))
check('graded text starts as the first colour',
  text.after.hi[0] > 150 && text.after.hi[1] < 110, JSON.stringify(text.after.hi))
check('and ends as the second', text.after.lo[1] > 150 && text.after.lo[0] < 110,
  JSON.stringify(text.after.lo))
await page.screenshot({ path: path.join(OUT, '02-text.png') })

// --- the angle is a keyframe track ----------------------------------------------
// The whole reason for the angle being a plain number rather than part of some
// gradient object: it animates with everything else, and nothing in the
// keyframe system had to learn what a gradient is.
const animated = await page.evaluate(async (id) => {
  const st = window.__pfState()
  // Paused first. The preview plays by default, and giving a still document a
  // timeline sets it running — which put the first key 200ms along instead of
  // at the start, and made the curve read as broken when it was the test that
  // was not looking where it thought.
  st.setPlaying(false)
  st.enableTrack(id, 'gradient')
  await new Promise((r) => setTimeout(r, 200))
  // Through `setLayerAtTime`, which is what the inspector uses: it decides per
  // property whether the number belongs on a key or on the base layer, and a
  // property with a track always gets a key.
  window.__pfState().setTime(0)
  window.__pfState().setLayerAtTime(id, { colorAngle: 0 })
  window.__pfState().setTime(1000)
  window.__pfState().setLayerAtTime(id, { colorAngle: 180 })
  await new Promise((r) => setTimeout(r, 300))
  const l = window.__pfState().doc.layers.find((x) => x.id === id)
  const at = (t) => window.__pfKeys.valueAt(l, 'colorAngle', t)
  return {
    props: Object.keys(l.tracks || {}),
    keys: (l.tracks?.colorAngle || []).map((k) => `${k.t}=${k.v}`),
    start: at(0),
    middle: at(500),
    end: at(1000),
  }
}, text.id)
console.log('the angle on a track:', JSON.stringify(animated))
// The whole gradient goes on one track group, the way position keys x and y
// together. A text layer has no fill angle, and `enableGroup` skips a property
// the layer has no number for — which is what lets one group serve both kinds.
check('animating a gradient keys the whole of it',
  ['colorAngle', 'colorStop', 'colorStop2'].every((k) => animated.props.includes(k)),
  animated.props.join())
check('and nothing belonging to the other kind of layer',
  !animated.props.some((k) => k.startsWith('fill')), animated.props.join())
check('and it sweeps between the keys',
  animated.start === 0 && Math.abs(animated.middle - 90) < 2 && animated.end === 180,
  JSON.stringify(animated))

// --- it survives being saved ----------------------------------------------------
// The stops and the angle are plain fields on the layer, which is the reason a
// project written before gradients existed still opens: a missing second colour
// is a flat fill, which is what those documents were.
const saved = await page.evaluate(async () => {
  const st = window.__pfState()
  const l = st.doc.layers[0]
  const blob = await window.__pfProject.packProject(st.doc, { name: 'grad' })
  const read = await window.__pfProject.unpackProject(new File([blob], 'grad.pfz'))
  const back = read.doc.layers.find((x) => x.type === 'text')
  return {
    color2: back?.color2,
    colorAngle: back?.colorAngle,
    same: back?.color === l.color,
  }
})
console.log('after a round trip:', JSON.stringify(saved))
check('a gradient is still there after saving and opening',
  saved.color2 === '#00ff00' && saved.same, JSON.stringify(saved))
check('and so is its angle', typeof saved.colorAngle === 'number', String(saved.colorAngle))

// --- the control ----------------------------------------------------------------
// One chip on the colour's own row, both ways: no button to add and a cross to
// take away.
const ui = await page.evaluate(() => {
  const chip = document.querySelector('.grad-chip')
  return {
    chip: !!chip,
    on: chip?.classList.contains('on'),
    rows: [...document.querySelectorAll('.row-label')].map((x) => x.textContent.trim()),
  }
})
check('the colour row has a gradient chip', ui.chip === true)
check('lit, because this text has one', ui.on === true)
check('and the second stop and angle are rows of their own',
  ui.rows.includes('To') && ui.rows.includes('Angle'), ui.rows.join(' '))

await page.click('.grad-chip')
await page.waitForTimeout(300)
const off = await page.evaluate(() => ({
  chipOn: document.querySelector('.grad-chip')?.classList.contains('on'),
  rows: [...document.querySelectorAll('.row-label')].map((x) => x.textContent.trim()),
  color2: window.__pfState().doc.layers[0].color2,
}))
console.log('after clicking the chip:', JSON.stringify({ chipOn: off.chipOn, color2: off.color2 }))
check('clicking it puts the colour back to flat',
  off.chipOn === false && off.color2 === null, JSON.stringify(off.color2))
check('and takes the two rows away with it',
  !off.rows.includes('To') && !off.rows.includes('Angle'), off.rows.join(' '))

await page.click('.grad-chip')
await page.waitForTimeout(300)
const on = await page.evaluate(() => {
  const l = window.__pfState().doc.layers[0]
  return { color: l.color, color2: l.color2, angle: l.colorAngle }
})
console.log('and clicking it again:', JSON.stringify(on))
// Turning it on has to *show* a gradient. Offered the same colour twice, the
// chip would appear to do nothing and the feature would look broken before it
// had been used once.
check('clicking it again offers a second colour that is visibly different',
  !!on.color2 && on.color2 !== on.color, JSON.stringify(on))
await page.screenshot({ path: path.join(OUT, '03-inspector.png') })

// --- the stops, dragged on the canvas -------------------------------------------
// An angle in a panel says which way the colours run and nothing about where
// they change, and "I want more of the first one" is something you know by
// looking rather than by typing a number.
const shaped = await page.evaluate(async (box) => {
  const st = window.__pfState()
  st.setPlaying(false)
  st.doc.layers.forEach((l) => st.removeLayers([l.id]))
  await new Promise((r) => setTimeout(r, 300))
  const { makeShapeLayer } = window.__pfStore
  const l = window.__pfState().addLayer(makeShapeLayer({
    shape: 'rect', ...box, fill: '#ff0000', fill2: '#0000ff', fillAngle: 90,
    stroke: 'none', strokeWidth: 0, radius: 0,
  }))
  window.__pfState().select([l.id])
  await new Promise((r) => setTimeout(r, 500))
  return { id: l.id }
}, { x: 100, y: 100, w: 400, h: 400 })

/** Where the bar and its knobs are, in page coordinates. */
const barAt = () => page.evaluate(() => {
  const st = window.__pfState()
  const l = st.doc.layers[0]
  const g = window.__pfGradient.gradientAxis(l)
  if (!g) return null
  const v = st.view
  const c = document.querySelector('canvas').getBoundingClientRect()
  const scr = (q) => ({ x: c.left + v.panX + q.x * v.zoom, y: c.top + v.panY + q.y * v.zoom })
  const s0 = scr(g.p0)
  const s1 = scr(g.p1)
  const dx = s1.x - s0.x
  const dy = s1.y - s0.y
  const len = Math.hypot(dx, dy) || 1
  // The same sideways nudge the overlay draws with, so the test grabs the knob
  // where a person would see it.
  const off = { x: (dy / len) * 16, y: (-dx / len) * 16 }
  const sh = (q) => ({ x: q.x + off.x, y: q.y + off.y })
  return { p0: sh(s0), p1: sh(s1), a: sh(scr(g.a)), b: sh(scr(g.b)), stop: g.stop, stop2: g.stop2 }
})

const bar = await barAt()
console.log('the bar:', JSON.stringify(bar))
check('a gradient puts a bar with two knobs on the layer',
  !!bar && bar.stop === 0 && bar.stop2 === 1, JSON.stringify(bar))
check('running the way the gradient does',
  Math.abs(bar.p1.y - bar.p0.y) > 100 && Math.abs(bar.p1.x - bar.p0.x) < 1,
  JSON.stringify({ p0: bar.p0, p1: bar.p1 }))

// The knob at the far end, dragged a third of the way back: the first colour
// then holds most of the shape, which is the whole point of the thing.
const along = (t) => ({
  x: bar.p0.x + (bar.p1.x - bar.p0.x) * t,
  y: bar.p0.y + (bar.p1.y - bar.p0.y) * t,
})
await page.mouse.move(bar.b.x, bar.b.y)
await page.mouse.down()
await page.mouse.move(along(0.33).x, along(0.33).y, { steps: 8 })
await page.mouse.up()
await page.waitForTimeout(300)
const dragged = await page.evaluate(() => {
  const l = window.__pfState().doc.layers[0]
  return { stop: l.fillStop, stop2: l.fillStop2 }
})
console.log('after dragging the far knob back:', JSON.stringify(dragged))
check('dragging a knob moves that stop and only that stop',
  Math.abs(dragged.stop2 - 0.33) < 0.04 && dragged.stop === 0, JSON.stringify(dragged))

const shifted = await sample([
  ['early', 300, 103],
  ['mid', 300, 240],
  ['late', 300, 420],
  ['end', 300, 480],
])
console.log('down the shape now:', JSON.stringify(shifted))
check('so the second colour arrives sooner',
  shifted.late[2] > 250 && shifted.late[0] < 6, JSON.stringify(shifted.late))
check('and holds the rest of the shape flat',
  Math.abs(shifted.late[2] - shifted.end[2]) < 3 && Math.abs(shifted.late[0] - shifted.end[0]) < 3,
  JSON.stringify({ late: shifted.late, end: shifted.end }))
check('while the first colour still starts where it did',
  shifted.early[0] > 245 && shifted.early[2] < 12, JSON.stringify(shifted.early))
await page.screenshot({ path: path.join(OUT, '04-stops.png') })

// Dragging one knob past the other is a thing that happens. The answer is the
// gradient the other way round, not a refusal and not a blank shape.
const crossed = await page.evaluate(async () => {
  const st = window.__pfState()
  const l = st.doc.layers[0]
  st.updateLayer(l.id, { fillStop: 0.8, fillStop2: 0.2 })
  await new Promise((r) => setTimeout(r, 300))
  const c = document.createElement('canvas')
  c.width = st.doc.width
  c.height = st.doc.height
  const ctx = c.getContext('2d', { willReadFrequently: true })
  window.__pfRender.renderDocument(ctx, window.__pfState().doc, 0)
  const px = (x, y) => { const d = ctx.getImageData(x, y, 1, 1).data; return [d[0], d[1], d[2], d[3]] }
  return { top: px(300, 130), bottom: px(300, 470) }
})
console.log('with the knobs crossed:', JSON.stringify(crossed))
check('crossing the knobs paints the gradient the other way round rather than nothing',
  crossed.top[3] === 255 && crossed.bottom[3] === 255
  && crossed.top[2] > 200 && crossed.bottom[0] > 200, JSON.stringify(crossed))

// --- the knobs must not eat the box handles -------------------------------------
// On the axis itself a stop at either end lands exactly on the handle there, and
// neither could be grabbed. The bar is drawn to one side for that reason, so the
// north handle has to still be a north handle.
await page.evaluate(async () => {
  const st = window.__pfState()
  st.updateLayer(st.doc.layers[0].id, { fillStop: 0, fillStop2: 1 })
  await new Promise((r) => setTimeout(r, 300))
})
const resize = await page.evaluate(async () => {
  const st = window.__pfState()
  const l = st.doc.layers[0]
  const v = st.view
  const c = document.querySelector('canvas').getBoundingClientRect()
  return {
    before: { y: l.y, h: l.h },
    // The north handle: top centre of the box, on the axis a stop also sits on.
    x: c.left + v.panX + (l.x + l.w / 2) * v.zoom,
    y: c.top + v.panY + l.y * v.zoom,
  }
})
await page.mouse.move(resize.x, resize.y)
await page.mouse.down()
await page.mouse.move(resize.x, resize.y + 60, { steps: 6 })
await page.mouse.up()
await page.waitForTimeout(300)
const afterResize = await page.evaluate(() => {
  const l = window.__pfState().doc.layers[0]
  return { y: Math.round(l.y), h: Math.round(l.h), stop: l.fillStop, stop2: l.fillStop2 }
})
console.log('dragging the north handle:', JSON.stringify(afterResize))
check('the box handle under a stop is still a box handle',
  afterResize.h < resize.before.h - 30, `${resize.before.h} -> ${afterResize.h}`)
check('and dragging it left the stops alone',
  afterResize.stop === 0 && afterResize.stop2 === 1, JSON.stringify(afterResize))

// --- one gradient across a group -------------------------------------------------
// A title is often two text layers, and each measuring itself means the ramp
// restarts on the second word instead of running through the pair. Measured as
// the colour down a column crossing both, because "the fields were set" cannot
// tell a shared ramp from two identical ones.
const spanned = await page.evaluate(async () => {
  const st = window.__pfState()
  st.setPlaying(false)
  st.doc.layers.forEach((l) => st.removeLayers([l.id]))
  await new Promise((r) => setTimeout(r, 300))
  const { makeShapeLayer } = window.__pfStore
  const mk = (y) => makeShapeLayer({
    shape: 'rect', x: 100, y, w: 300, h: 150, fill: '#ff0000', fill2: '#0000ff',
    fillAngle: 90, stroke: 'none', strokeWidth: 0, radius: 0,
  })
  const a = window.__pfState().addLayer(mk(100))
  const b = window.__pfState().addLayer(mk(250))
  window.__pfState().groupLayers([a.id, b.id])
  await new Promise((r) => setTimeout(r, 400))

  const down = () => {
    const s2 = window.__pfState()
    const c = document.createElement('canvas')
    c.width = s2.doc.width
    c.height = s2.doc.height
    const ctx = c.getContext('2d', { willReadFrequently: true })
    window.__pfRender.renderDocument(ctx, s2.doc, 0)
    // Red down the middle of the pair: one ramp falls all the way, two ramps
    // climb back up in the middle.
    return [110, 240, 260, 390].map((y) => ctx.getImageData(250, y, 1, 1).data[0])
  }
  const perLayer = down()
  const id = window.__pfState().doc.layers.find((l) => l.id === a.id)
  window.__pfState().select([a.id])
  // On one layer only: saying the gradient is the group's has to be enough, or
  // the setting is a chore rather than a choice.
  const applied = window.__pfState().setGradient(a.id, { span: 'group' })
  await new Promise((r) => setTimeout(r, 400))
  const perGroup = down()
  return { grouped: !!id.parentId, perLayer, perGroup, applied, first: a.id, second: b.id }
})
console.log('red down the pair:', JSON.stringify(spanned))
check('the two shapes really are in a group', spanned.grouped === true)
// The complaint this is for: the second word starts over at the first colour.
check('measuring each layer restarts the ramp on the second one',
  spanned.perLayer[2] > spanned.perLayer[1] + 100,
  `${spanned.perLayer.join(' -> ')}`)
check('setting it on one layer applies it to the group',
  spanned.applied?.count === 2, JSON.stringify(spanned.applied))
check('measuring the group runs one ramp through both',
  spanned.perGroup[0] > spanned.perGroup[1]
  && spanned.perGroup[1] > spanned.perGroup[2]
  && spanned.perGroup[2] > spanned.perGroup[3],
  `${spanned.perGroup.join(' -> ')}`)
check('reaching the first colour at the top of the first',
  spanned.perGroup[0] > 230, String(spanned.perGroup[0]))
check('and the second at the bottom of the second',
  spanned.perGroup[3] < 25, String(spanned.perGroup[3]))

// The bar on the canvas has to agree with the paint, or the knobs lie about
// where the colours change.
const spanBar = await page.evaluate((id) => {
  const st = window.__pfState()
  const l = st.doc.layers.find((x) => x.id === id)
  const G = window.__pfGradient
  const members = st.doc.layers.filter((x) => x.parentId === l.parentId && x.type !== 'group')
  const own = G.gradientAxis(l)
  const across = G.gradientAxis(l, G.gradientBox(l, members))
  return {
    own: Math.round(Math.abs(own.p1.y - own.p0.y)),
    across: Math.round(Math.abs(across.p1.y - across.p0.y)),
  }
}, spanned.first)
console.log('the bar, own box against the group:', JSON.stringify(spanBar))
check('the bar spans the group too, rather than just its own layer',
  spanBar.across > spanBar.own * 1.8, `${spanBar.own}px -> ${spanBar.across}px`)

// And the control only shows where there is a group to span.
const offered = await page.evaluate(async (id) => {
  window.__pfState().select([id])
  await new Promise((r) => setTimeout(r, 300))
  const st = window.__pfState()
  const l = st.doc.layers.find((x) => x.id === id)
  const rows = [...document.querySelectorAll('.row-label')].map((x) => x.textContent.trim())
  return {
    grouped: rows.includes('Across'),
    parentId: l?.parentId, selected: st.selectedIds, span: l?.gradientSpan,
    rows: rows.join(' '),
  }
}, spanned.first)
console.log('the Across row:', JSON.stringify(offered))
check('a grouped layer is offered the choice', offered.grouped === true, JSON.stringify(offered))

const alone = await page.evaluate(async () => {
  const st = window.__pfState()
  const { makeShapeLayer } = window.__pfStore
  const l = st.addLayer(makeShapeLayer({
    shape: 'rect', x: 600, y: 100, w: 100, h: 100, fill: '#ff0000', fill2: '#00ff00',
  }))
  window.__pfState().select([l.id])
  await new Promise((r) => setTimeout(r, 350))
  return { rows: [...document.querySelectorAll('.row-label')].map((x) => x.textContent.trim()) }
})
// On a layer standing on its own the two answers are the same box, and the
// control would be a choice between a thing and itself.
check('a layer on its own is not', !alone.rows.includes('Across'), alone.rows.join(' '))

// --- a plain layer in the group joins in ------------------------------------------
// The case that made the first version useless: a gradient on one word and plain
// text on the other. "Across the group" changed which box each measured itself
// against, so the plain one stayed plain and nothing visible happened at all.
const joined = await page.evaluate(async () => {
  const st = window.__pfState()
  st.doc.layers.forEach((l) => st.removeLayers([l.id]))
  await new Promise((r) => setTimeout(r, 300))
  const { makeShapeLayer } = window.__pfStore
  const grad = window.__pfState().addLayer(makeShapeLayer({
    shape: 'rect', x: 100, y: 100, w: 300, h: 150, fill: '#ff0000', fill2: '#0000ff',
    fillAngle: 90, stroke: 'none', strokeWidth: 0, radius: 0,
  }))
  const plain = window.__pfState().addLayer(makeShapeLayer({
    shape: 'rect', x: 100, y: 250, w: 300, h: 150, fill: '#888888',
    stroke: 'none', strokeWidth: 0, radius: 0,
  }))
  window.__pfState().groupLayers([grad.id, plain.id])
  await new Promise((r) => setTimeout(r, 350))
  const was = window.__pfState().doc.layers.find((l) => l.id === plain.id)
  window.__pfState().setGradient(grad.id, { span: 'group' })
  await new Promise((r) => setTimeout(r, 350))
  const now = window.__pfState().doc.layers.find((l) => l.id === plain.id)

  // And an adjustment afterwards reaches all of them.
  window.__pfState().setGradient(grad.id, { stop2: 0.5, angle: 30 })
  await new Promise((r) => setTimeout(r, 300))
  const after = window.__pfState().doc.layers.find((l) => l.id === plain.id)
  return {
    was: { fill: was.fill, fill2: was.fill2 },
    now: { fill: now.fill, fill2: now.fill2, angle: now.fillAngle, span: now.gradientSpan },
    after: { stop2: after.fillStop2, angle: after.fillAngle },
    undone: null,
  }
})
console.log('a plain layer joining the group gradient:', JSON.stringify(joined))
check('the plain layer had no gradient to begin with', joined.was.fill2 === null,
  JSON.stringify(joined.was))
check('and is handed the group’s',
  joined.now.fill === '#ff0000' && joined.now.fill2 === '#0000ff'
  && joined.now.span === 'group', JSON.stringify(joined.now))
// Otherwise dragging one word's knob pulls the shared ramp apart at that word.
check('an adjustment afterwards reaches the whole group',
  joined.after.stop2 === 0.5 && joined.after.angle === 30, JSON.stringify(joined.after))

// --- an opacity for each end -------------------------------------------------------
// The layer's own opacity is one number for the whole thing. Wanting the pink
// end at 30% and the blue one at 90% is not something it can express, and it is
// an ordinary thing to want.
const ends = await page.evaluate(async () => {
  const st = window.__pfState()
  st.doc.layers.forEach((l) => st.removeLayers([l.id]))
  await new Promise((r) => setTimeout(r, 300))
  const { makeShapeLayer } = window.__pfStore
  const l = window.__pfState().addLayer(makeShapeLayer({
    shape: 'rect', x: 100, y: 100, w: 300, h: 300, fill: '#ff00aa', fill2: '#0000ff',
    fillAngle: 90, stroke: 'none', strokeWidth: 0, radius: 0,
  }))
  window.__pfState().select([l.id])
  const alphaDown = () => {
    const s2 = window.__pfState()
    const c = document.createElement('canvas')
    c.width = s2.doc.width
    c.height = s2.doc.height
    const ctx = c.getContext('2d', { willReadFrequently: true })
    window.__pfRender.renderDocument(ctx, s2.doc, 0)
    return [110, 390].map((y) => ctx.getImageData(250, y, 1, 1).data[3])
  }
  await new Promise((r) => setTimeout(r, 350))
  const solid = alphaDown()
  window.__pfState().setGradient(l.id, { alpha: 0.3, alpha2: 0.9 })
  await new Promise((r) => setTimeout(r, 350))
  const graded = alphaDown()
  // The same colour at both ends, one of them fading out: still a gradient, and
  // the useful one for a caption melting into a photograph.
  window.__pfState().setGradient(l.id, { to: '#ff00aa', alpha: 1, alpha2: 0 })
  await new Promise((r) => setTimeout(r, 350))
  const melt = alphaDown()
  return { solid, graded, melt, rows: [...document.querySelectorAll('.row-label')].map((x) => x.textContent.trim()) }
})
console.log('alpha down the shape:', JSON.stringify(ends))
check('a plain gradient is solid at both ends',
  ends.solid[0] > 250 && ends.solid[1] > 250, JSON.stringify(ends.solid))
check('an opacity per end is honoured',
  Math.abs(ends.graded[0] - 77) < 22 && Math.abs(ends.graded[1] - 230) < 22,
  JSON.stringify(ends.graded))
check('and one colour fading out is still a gradient',
  ends.melt[0] > 230 && ends.melt[1] < 25, JSON.stringify(ends.melt))
check('with a row for each end', ends.rows.includes('From %') && ends.rows.includes('To %'),
  ends.rows.join(' '))

// --- the border’s own opacity ----------------------------------------------------
// A solid shape behind a half-there outline is a thing to want, and one number
// for the whole layer cannot say it.
const border = await page.evaluate(async () => {
  const st = window.__pfState()
  st.doc.layers.forEach((l) => st.removeLayers([l.id]))
  await new Promise((r) => setTimeout(r, 300))
  const { makeShapeLayer } = window.__pfStore
  const l = window.__pfState().addLayer(makeShapeLayer({
    shape: 'rect', x: 150, y: 150, w: 200, h: 200, fill: '#ff0000', fill2: null,
    stroke: '#ffffff', strokeWidth: 16, radius: 0,
  }))
  window.__pfState().select([l.id])
  const look = () => {
    const s2 = window.__pfState()
    const c = document.createElement('canvas')
    c.width = s2.doc.width
    c.height = s2.doc.height
    const ctx = c.getContext('2d', { willReadFrequently: true })
    window.__pfRender.renderDocument(ctx, s2.doc, 0)
    const px = (x, y) => [...ctx.getImageData(x, y, 1, 1).data].slice(0, 3)
    return { edge: px(150, 250), middle: px(250, 250) }
  }
  await new Promise((r) => setTimeout(r, 350))
  const full = look()
  window.__pfState().updateLayer(l.id, { strokeOpacity: 0.25 })
  await new Promise((r) => setTimeout(r, 350))
  const faint = look()
  return { full, faint, rows: [...document.querySelectorAll('.row-label')].map((x) => x.textContent.trim()) }
})
console.log('the border at full then a quarter:', JSON.stringify(border))
check('a solid border draws its own colour', border.full.edge[1] > 200, JSON.stringify(border.full.edge))
check('turning it down lets the fill through',
  border.faint.edge[1] < border.full.edge[1] - 80, JSON.stringify(border.faint.edge))
check('and leaves the fill itself alone',
  border.faint.middle[0] > 240 && border.faint.middle[1] < 20, JSON.stringify(border.faint.middle))
check('with a row of its own', border.rows.includes('Stroke %'), border.rows.join(' '))

// --- a third colour, and a radial ---------------------------------------------------
// Both measured off the pixels, because both are the sort of thing that stores
// correctly and draws wrongly: a stop list that reaches canvas out of order
// throws, and a radial that keeps the linear line is simply a linear gradient
// with a new label on it.
const more = await page.evaluate(async () => {
  const st = window.__pfState()
  st.resetDoc()
  st.setDoc({ width: 200, height: 200, background: '#000000' })
  await new Promise((r) => setTimeout(r, 250))
  const { makeShapeLayer } = window.__pfStore
  const layer = makeShapeLayer({
    shape: 'rect', x: 0, y: 0, w: 200, h: 200,
    fill: '#ff0000', fill2: '#0000ff', fillAngle: 90, strokeWidth: 0,
  })
  window.__pfState().addLayer(layer)
  await new Promise((r) => setTimeout(r, 300))
  const id = layer.id

  const read = (pts) => {
    const s2 = window.__pfState()
    const c = document.createElement('canvas')
    c.width = s2.doc.width
    c.height = s2.doc.height
    const g = c.getContext('2d', { willReadFrequently: true })
    window.__pfRender.renderDocument(g, s2.doc, 0)
    return pts.map(([x, y]) => {
      const d = g.getImageData(x, y, 1, 1).data
      return { r: d[0], g: d[1], b: d[2] }
    })
  }

  // Top to bottom, red to blue. Nothing green anywhere.
  const two = read([[100, 6], [100, 100], [100, 194]])

  window.__pfState().setGradient(id, { mid: [{ at: 0.5, color: '#00ff00', alpha: 1 }] })
  await new Promise((r) => setTimeout(r, 350))
  const three = read([[100, 6], [100, 100], [100, 194]])

  window.__pfState().setGradient(id, { mid: [], kind: 'radial' })
  await new Promise((r) => setTimeout(r, 350))
  // Centre, and a point out towards a corner.
  const radial = read([[100, 100], [100, 6]])
  const stored = window.__pfState().doc.layers.find((x) => x.id === id)
  return { two, three, radial, kind: stored.fillKind, mid: stored.fillMid }
})
console.log('gradients:', JSON.stringify(more))

check('two colours still run end to end',
  more.two[0].r > 200 && more.two[2].b > 200 && more.two[1].g < 40,
  JSON.stringify(more.two))
// The whole point of a third stop: the middle is now the colour that was put
// there, and the ends are unmoved.
check('a colour added in the middle is drawn in the middle',
  more.three[1].g > 200 && more.three[1].r < 60 && more.three[1].b < 60,
  JSON.stringify(more.three[1]))
check('and the two ends stay where they were',
  more.three[0].r > 200 && more.three[2].b > 200, JSON.stringify(more.three))
check('taking it out again leaves nothing behind', more.mid === undefined, JSON.stringify(more.mid))

check('a radial puts the first colour in the middle',
  more.radial[0].r > 200 && more.radial[0].b < 60, JSON.stringify(more.radial[0]))
check('and the second one out at the rim',
  more.radial[1].b > more.radial[1].r, JSON.stringify(more.radial[1]))
check('which is a different picture from the linear one it replaced',
  Math.abs(more.radial[0].r - more.two[1].r) > 100,
  `${more.two[1].r} at the centre before, ${more.radial[0].r} after`)
check('and it is stored as one', more.kind === 'radial', String(more.kind))

console.log(errors.length ? 'CONSOLE ERRORS: ' + errors.slice(0, 5).join(' | ') : 'no console errors')
await browser.close()
process.exit(checks.some(([, ok]) => !ok) ? 1 : 0)
