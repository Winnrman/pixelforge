// Drives the keyframe workflow through the real UI: add a pixelate overlay,
// animate it, move it at a later time, then assert the overlay actually travels
// across the frame and exports that way. Also covers per-property tracks and
// the "all keys" edit scope.
import { chromium } from 'playwright-core'
import { importAndPlace } from '../e2e-helpers.mjs'
import fs from 'fs'
import path from 'path'

const OUT = 'shots/kf'
fs.mkdirSync(OUT, { recursive: true })

const browser = await chromium.launch({
  executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  headless: true,
})
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
const errors = []
page.on('console', (m) => { if (m.type() === 'error' && !/favicon/.test(m.text())) errors.push(m.text()) })
page.on('pageerror', (e) => errors.push('PAGEERROR: ' + e.message))

const checks = []
const check = (name, ok) => { checks.push([name, ok]); console.log((ok ? 'PASS  ' : 'FAIL  ') + name) }
const fx = () => page.evaluate(() => window.__pfState().doc.layers.find((l) => l.type === 'effect'))

await page.goto('http://localhost:5173/', { waitUntil: 'networkidle' })
await importAndPlace(page, 'public/test/motion.gif', { timeout: 10000 })
await page.waitForTimeout(800)
await page.evaluate(() => { window.__pfState().setPlaying(false); window.__pfState().setTime(0) })

// Draw a pixelate ellipse near the top-left of the canvas.
await page.keyboard.press('p')
await page.waitForTimeout(400) // tool rail width transition
const box = await page.locator('.stage canvas').boundingBox()
const cx = box.x + box.width / 2
const cy = box.y + box.height / 2
await page.mouse.move(cx - 260, cy - 130)
await page.mouse.down()
await page.mouse.move(cx - 130, cy - 20, { steps: 10 })
await page.mouse.up()
await page.waitForTimeout(300)

// Arm auto-tracking from the Inspector.
await page.click('button:has-text("Add animation tracking")')
await page.waitForTimeout(250)
await page.screenshot({ path: path.join(OUT, '01-animated.png') })

const afterEnable = await fx()
check('arming tracking creates no tracks on its own',
  afterEnable.autoTrack === true && !afterEnable.tracks)

// Scrub to ~70% and drag the overlay across to the far side.
const dur = await page.evaluate(() => window.__pfState().duration)
await page.evaluate((t) => window.__pfState().setTime(t), Math.round(dur * 0.7))
await page.waitForTimeout(200)

const fxBox = await page.evaluate(() => {
  const s = window.__pfState()
  const l = s.doc.layers.find((x) => x.type === 'effect')
  return { x: l.x, y: l.y, w: l.w, h: l.h, zoom: s.view.zoom, panX: s.view.panX, panY: s.view.panY }
})
await page.keyboard.press('v')
await page.waitForTimeout(400) // rail collapses back to icon width
const liveBox = await page.locator('.stage canvas').boundingBox()
const scr = (dx, dy) =>
  [liveBox.x + fxBox.panX + dx * fxBox.zoom, liveBox.y + fxBox.panY + dy * fxBox.zoom]
const [gx, gy] = scr(fxBox.x + fxBox.w / 2, fxBox.y + fxBox.h / 2)

await page.mouse.move(gx, gy)
await page.mouse.down()
await page.mouse.move(gx + 300, gy + 200, { steps: 15 })
await page.mouse.up()
await page.waitForTimeout(300)
await page.screenshot({ path: path.join(OUT, '02-second-key.png') })

const afterMove = await fx()
console.log('tracks after moving:', JSON.stringify(Object.keys(afterMove.tracks || {})))
check('moving at a later time grows a position track by itself',
  afterMove.tracks.x.length === 2 && afterMove.tracks.y.length === 2)
check('the track is seeded from where the layer was, at t=0',
  afterMove.tracks.x[0].t === 0 && afterMove.tracks.x[0].v !== afterMove.tracks.x[1].v)
check('only the properties that actually changed get tracks',
  !afterMove.tracks.w && !afterMove.tracks.opacity && !afterMove.tracks.pixelSize)

// Interpolation must be smooth and monotonic between the two keys.
const path5 = await page.evaluate(() => {
  const l = window.__pfState().doc.layers.find((x) => x.type === 'effect')
  const { resolveLayer } = window.__pfKeys
  const [a, b] = l.tracks.x
  return [0, 0.25, 0.5, 0.75, 1].map((u) => Math.round(resolveLayer(l, a.t + (b.t - a.t) * u).x))
})
const monotonic = path5.every((v, i) => i === 0 || (path5[4] > path5[0] ? v >= path5[i - 1] : v <= path5[i - 1]))
check('position tweens smoothly between keys', monotonic && path5[0] !== path5[4])

// The rendered pixelated region must land in different places over time.
const where = await page.evaluate(() => {
  const s = window.__pfState()
  const { renderDocument } = window.__pfRender
  const { resolveLayer } = window.__pfKeys
  const l = s.doc.layers.find((x) => x.type === 'effect')
  const c = document.createElement('canvas')
  c.width = s.doc.width
  c.height = s.doc.height
  const ctx = c.getContext('2d', { willReadFrequently: true })
  const flatness = (t, p) => {
    renderDocument(ctx, s.doc, t)
    const px = Math.max(1, Math.round(l.pixelSize))
    const img = ctx.getImageData(Math.floor(p.x / px) * px + 1, Math.floor(p.y / px) * px + 1,
      px - 2, px - 2).data
    for (let i = 4; i < img.length; i += 4) {
      if (img[i] !== img[0] || img[i + 1] !== img[1] || img[i + 2] !== img[2]) return false
    }
    return true
  }
  const t0 = l.tracks.x[0].t
  const t1 = l.tracks.x[1].t
  const k0 = resolveLayer(l, t0)
  const k1 = resolveLayer(l, t1)
  const p0 = { x: Math.round(k0.x + k0.w / 2), y: Math.round(k0.y + k0.h / 2) }
  const p1 = { x: Math.round(k1.x + k1.w / 2), y: Math.round(k1.y + k1.h / 2) }
  return {
    startCovered: flatness(t0, p0),
    endCovered: flatness(t1, p1),
    startLeftBehind: flatness(t1, p0),
  }
})
check('overlay covers its start position at the first key', where.startCovered)
check('overlay covers its end position at the last key', where.endCovered)
check('overlay has left the start position by the last key', !where.startLeftBehind)

// --- per-property tracks --------------------------------------------------
await page.evaluate(() => {
  const s = window.__pfState()
  s.setTime(400)
  s.enableTrack(s.doc.layers.find((x) => x.type === 'effect').id, 'opacity')
})
await page.waitForTimeout(200)
const withOpacity = await fx()
check('opacity becomes its own track with its own single key',
  withOpacity.tracks.opacity.length === 1 && withOpacity.tracks.opacity[0].t === 400)
check('adding an opacity track leaves position keys untouched',
  withOpacity.tracks.x.length === 2)

const laneLabels = await page.locator('.key-lane .lane-name').allTextContents()
console.log('timeline lanes:', JSON.stringify(laneLabels))
check('timeline shows one lane per animated property',
  laneLabels.includes('Position') && laneLabels.includes('Opacity') &&
  !laneLabels.includes('Size'))

const posDiamonds = await page.locator('.key-lane', { hasText: 'Position' }).locator('.kf').count()
const opaDiamonds = await page.locator('.key-lane', { hasText: 'Opacity' }).locator('.kf').count()
console.log('diamonds - position:', posDiamonds, 'opacity:', opaDiamonds)
check('each lane shows only its own keys', posDiamonds === 2 && opaDiamonds === 1)
await page.screenshot({ path: path.join(OUT, '03-timeline.png') })

// Changing an effect property while armed should track it without any ceremony.
await page.evaluate(() => {
  const s = window.__pfState()
  const l = s.doc.layers.find((x) => x.type === 'effect')
  s.setTime(700)
  s.setLayerAtTime(l.id, { feather: 22 })
})
await page.waitForTimeout(200)
const autoFeather = await fx()
console.log('feather track:', JSON.stringify(autoFeather.tracks.feather))
check('changing any armed property grows its own track automatically',
  autoFeather.tracks.feather?.length === 2 &&
  autoFeather.tracks.feather[0].t === 0 &&
  autoFeather.tracks.feather[1].t === 700 &&
  autoFeather.tracks.feather[1].v === 22)
check('the seeded first key holds the pre-edit value',
  autoFeather.tracks.feather[0].v === 0)

// --- edit scope: this key vs all keys -------------------------------------
await page.evaluate(() => {
  const s = window.__pfState()
  const l = s.doc.layers.find((x) => x.type === 'effect')
  s.setTime(0)
  s.enableTrack(l.id, 'pixelSize')
  s.setLayerAtTime(l.id, { pixelSize: 8 })
  s.setTime(1000)
  s.setLayerAtTime(l.id, { pixelSize: 40 })
})
await page.waitForTimeout(150)
const perKey = await fx()
console.log('pixelSize keys:', JSON.stringify(perKey.tracks.pixelSize.map((k) => [k.t, k.v])))
check('pixel size keys independently per keyframe',
  perKey.tracks.pixelSize.length === 2 && perKey.tracks.pixelSize[0].v === 8 &&
  perKey.tracks.pixelSize[1].v === 40)

await page.click('.segmented button:has-text("All keys")')
await page.waitForTimeout(150)
await page.evaluate(() => {
  const s = window.__pfState()
  s.setLayerAtTime(s.doc.layers.find((x) => x.type === 'effect').id, { pixelSize: 24 })
})
await page.waitForTimeout(150)
const allKeys = await fx()
console.log('pixelSize after all-keys edit:', JSON.stringify(allKeys.tracks.pixelSize.map((k) => k.v)))
check('All keys sets the value across every keyframe',
  allKeys.tracks.pixelSize.every((k) => k.v === 24))

// All-keys drags offset the path rather than collapsing it.
const before = allKeys.tracks.x.map((k) => k.v)
await page.evaluate(() => {
  const s = window.__pfState()
  const l = s.doc.layers.find((x) => x.type === 'effect')
  s.setTime(0)
  s.setLayerAtTime(l.id, { x: l.tracks.x[0].v + 25 }, { relative: true })
})
await page.waitForTimeout(150)
const shifted = (await fx()).tracks.x.map((k) => k.v)
console.log('x keys before/after all-keys drag:', JSON.stringify(before), JSON.stringify(shifted))
check('All keys drag offsets the whole path, preserving its shape',
  shifted.length === 2 && Math.abs((shifted[0] - before[0]) - 25) < 0.01 &&
  Math.abs((shifted[1] - before[1]) - 25) < 0.01 && shifted[0] !== shifted[1])

await page.click('.segmented button:has-text("This key")')
await page.waitForTimeout(150)

// --- the bug this model fixes ---------------------------------------------
// Non-animatable properties must reach the base layer on an animated layer.
await page.evaluate(() => {
  const s = window.__pfState()
  s.setLayerAtTime(s.doc.layers.find((x) => x.type === 'effect').id,
    { effect: 'blur', shape: 'rect' })
})
await page.waitForTimeout(150)
const changed = await fx()
check('changing effect type on an animated layer sticks',
  changed.effect === 'blur' && changed.shape === 'rect')

await page.evaluate(() => {
  const s = window.__pfState()
  s.setLayerAtTime(s.doc.layers.find((x) => x.type === 'effect').id,
    { effect: 'pixelate', shape: 'ellipse' })
})

// --- timeline interaction --------------------------------------------------
const posLane = page.locator('.key-lane', { hasText: 'Position' })
const laneBox = await posLane.locator('.lane-track').boundingBox()
const secondKf = await posLane.locator('.kf').nth(1).boundingBox()

// Clicking empty lane space moves the playhead there. Dragging it draws a
// selection band instead of scrubbing — scrubbing by drag lives on the ruler at
// the top, and a lane that did both could only guess which was meant. The band
// itself is covered in e2e-keysel.
await page.mouse.click(laneBox.x + laneBox.width * 0.55, laneBox.y + laneBox.height / 2)
await page.waitForTimeout(150)
const scrubbed = await page.evaluate(() => window.__pfState().time)
console.log('time after lane click:', Math.round(scrubbed), 'of', Math.round(dur))
check('clicking empty lane space moves the playhead',
  Math.abs(scrubbed - dur * 0.55) < dur * 0.08)

// Retiming a diamond.
await page.mouse.move(secondKf.x + secondKf.width / 2, secondKf.y + secondKf.height / 2)
await page.mouse.down()
await page.mouse.move(laneBox.x + laneBox.width * 0.4, secondKf.y + secondKf.height / 2, { steps: 12 })
await page.mouse.up()
await page.waitForTimeout(250)
const retimed = (await fx()).tracks.x.map((k) => k.t)
console.log('position key times after drag:', JSON.stringify(retimed))
check('dragging a diamond retimes its key', retimed.length === 2 && retimed[1] !== 1008)

await page.keyboard.press('Control+z')
await page.waitForTimeout(200)
const undone = (await fx()).tracks.x.map((k) => k.t)
check('undo reverts the whole retime gesture in one step', undone[1] === 1008)

// --- stray click near the timeline must not create a layer -----------------
const layersBefore = await page.evaluate(() => window.__pfState().doc.layers.length)
await page.keyboard.press('p')
await page.waitForTimeout(400)
const stage = await page.locator('.stage canvas').boundingBox()
const panX = await page.evaluate(() => window.__pfState().view.panX)
// The empty board margin beside the document.
await page.mouse.click(stage.x + Math.max(4, panX - 20), stage.y + stage.height / 2)
await page.waitForTimeout(250)
const layersAfter = await page.evaluate(() => window.__pfState().doc.layers.length)
console.log('layers before/after stray click:', layersBefore, layersAfter)
check('a stray click off-document creates no layer', layersAfter === layersBefore)

// --- export ----------------------------------------------------------------
let exportOk = false
try {
  const dl = page.waitForEvent('download', { timeout: 60000 })
  await page.click('header button.btn.primary')
  await page.waitForTimeout(400)
  await page.click('.modal-foot .btn.primary')
  const d = await dl
  await d.saveAs(path.join(OUT, 'animated.gif'))
  console.log('exported GIF:', fs.statSync(path.join(OUT, 'animated.gif')).size, 'bytes')
  exportOk = true
} catch (err) {
  console.log('EXPORT FAILED:', String(err.message).slice(0, 140))
}
check('animated overlay exports to GIF', exportOk)

console.log(errors.length ? '\nCONSOLE ERRORS:\n  ' + errors.slice(0, 10).join('\n  ') : '\nno console errors')
await browser.close()
process.exit(checks.some(([, ok]) => !ok) ? 1 : 0)
