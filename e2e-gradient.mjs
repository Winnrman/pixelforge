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

const OUT = 'shots-gradient'
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
check('animating a gradient tracks its angle and nothing else',
  animated.props.join() === 'colorAngle', animated.props.join())
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

console.log(errors.length ? 'CONSOLE ERRORS: ' + errors.slice(0, 5).join(' | ') : 'no console errors')
await browser.close()
process.exit(checks.some(([, ok]) => !ok) ? 1 : 0)
