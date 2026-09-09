// Resizing the canvas.
//
// The canvas is the frame, not the picture. Resizing it used to scale every
// layer by the width and height factors *independently*, so changing only the
// height stretched everything vertically — asking for a taller canvas is not
// asking for taller people. Leaving the artwork alone is the default now, with
// Fit and Fill as uniform, non-distorting alternatives.
import { chromium } from 'playwright-core'
import { importAndPlace } from '../e2e-helpers.mjs'

const browser = await chromium.launch({
  executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  headless: true,
})
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
const errors = []
page.on('console', (m) => { if (m.type() === 'error' && !/favicon/.test(m.text())) errors.push(m.text()) })
page.on('pageerror', (e) => errors.push('PAGEERROR: ' + e.message))

const checks = []
const check = (name, ok, detail = '') => {
  checks.push([name, ok])
  console.log((ok ? 'PASS  ' : 'FAIL  ') + name + (detail ? '  — ' + detail : ''))
}

await page.goto('http://localhost:5173/', { waitUntil: 'networkidle' })
await page.evaluate(() => indexedDB.deleteDatabase('pixelforge'))
await page.reload({ waitUntil: 'networkidle' })
await importAndPlace(page, 'public/test/room.png', { timeout: 20000 })
await page.evaluate(() => { window.__pfState().setPlaying(false); window.__pfState().setTime(0) })
await page.waitForTimeout(400)

/** Every layer's geometry, rounded, so two states can be compared exactly. */
const geom = () => page.evaluate(() => window.__pfState().doc.layers.map((l) => ({
  id: l.id,
  x: Math.round(l.x * 100) / 100,
  y: Math.round(l.y * 100) / 100,
  w: Math.round(l.w * 100) / 100,
  h: Math.round(l.h * 100) / 100,
})))

const size = () => page.evaluate(() => {
  const d = window.__pfState().doc
  return { w: d.width, h: d.height }
})

const start = await size()
const before = await geom()
console.log('canvas:', JSON.stringify(start), 'layers:', before.length)
check('a document to resize', before.length >= 1 && start.w > 0)

// --- Leave: the artwork is untouched --------------------------------------------
await page.evaluate(() => window.__pfState().setDocResize('leave'))
await page.evaluate(([w, h]) => window.__pfState().resizeDoc(w, h), [start.w, start.h * 2])
await page.waitForTimeout(200)
const tallerSize = await size()
const taller = await geom()
console.log('after doubling the height:', JSON.stringify(tallerSize))
check('the canvas actually changed', tallerSize.h === start.h * 2 && tallerSize.w === start.w,
  `${tallerSize.w}x${tallerSize.h}`)
// This is the bug, stated precisely: the old code gave every layer h * 2.
check('and not one layer moved or stretched',
  JSON.stringify(taller) === JSON.stringify(before),
  JSON.stringify(taller[0]) + ' was ' + JSON.stringify(before[0]))

// Width alone, and both at once, are the same promise.
await page.evaluate(([w, h]) => window.__pfState().resizeDoc(w, h), [start.w * 3, start.h * 2])
await page.waitForTimeout(200)
const wider = await geom()
check('widening leaves it alone too', JSON.stringify(wider) === JSON.stringify(before))

// Shrinking below the content is allowed — it crops, it does not squash.
await page.evaluate(([w, h]) => window.__pfState().resizeDoc(w, h), [40, 40])
await page.waitForTimeout(200)
const tiny = await geom()
check('and shrinking crops rather than squashing',
  JSON.stringify(tiny) === JSON.stringify(before), JSON.stringify(tiny[0]))

await page.evaluate(([w, h]) => window.__pfState().resizeDoc(w, h), [start.w, start.h])
await page.waitForTimeout(200)

// --- Fit and Fill scale uniformly ------------------------------------------------
// The point of both is that they never distort: whatever the canvas does, the
// layer's own aspect ratio has to come out unchanged.
const ratioOf = (l) => Math.round((l.w / l.h) * 1000) / 1000
const firstBefore = before[0]

await page.evaluate(() => window.__pfState().setDocResize('fit'))
await page.evaluate(([w, h]) => window.__pfState().resizeDoc(w, h), [start.w, start.h * 2])
await page.waitForTimeout(200)
const fitted = (await geom())[0]
console.log('fit:', JSON.stringify(fitted))
check('fit keeps the layer aspect ratio', ratioOf(fitted) === ratioOf(firstBefore),
  `${ratioOf(fitted)} vs ${ratioOf(firstBefore)}`)
check('and fits inside the new canvas',
  fitted.w <= start.w + 0.5 && fitted.h <= start.h * 2 + 0.5,
  `${fitted.w}x${fitted.h} in ${start.w}x${start.h * 2}`)

await page.evaluate(() => window.__pfState().undo())
await page.waitForTimeout(200)
await page.evaluate(() => window.__pfState().setDocResize('fill'))
await page.evaluate(([w, h]) => window.__pfState().resizeDoc(w, h), [start.w, start.h * 2])
await page.waitForTimeout(200)
const filled = (await geom())[0]
console.log('fill:', JSON.stringify(filled))
check('fill keeps the layer aspect ratio too', ratioOf(filled) === ratioOf(firstBefore),
  `${ratioOf(filled)} vs ${ratioOf(firstBefore)}`)
check('and covers the new canvas', filled.w >= start.w - 0.5 && filled.h >= start.h * 2 - 0.5,
  `${filled.w}x${filled.h} covering ${start.w}x${start.h * 2}`)
check('fill is bigger than fit, which is the difference between them',
  filled.w > fitted.w, `${filled.w} vs ${fitted.w}`)

await page.evaluate(() => window.__pfState().undo())
await page.evaluate(() => window.__pfState().setDocResize('leave'))
await page.waitForTimeout(200)

// --- the aspect link ---------------------------------------------------------------
// The link lives in the panel, so drive the panel rather than the store. The
// Document panel only shows with nothing selected — importing leaves the new
// layer selected, which shows the layer panel instead.
await page.evaluate(() => window.__pfState().select([]))
await page.waitForTimeout(200)
const widthBox = page.locator('.inspector input.num').first()
const linkBtn = page.locator('.inspector .toggle', { hasText: 'Free' })
check('there is a link control', await linkBtn.count() === 1)
await linkBtn.click()
await page.waitForTimeout(150)
check('and it can be switched on',
  await page.evaluate(() => window.__pfState().docLinkRatio) === true)

const beforeLink = await size()
await widthBox.fill(String(beforeLink.w * 2))
await widthBox.press('Enter')
await page.waitForTimeout(250)
const linked = await size()
console.log('after doubling the width with the link on:', JSON.stringify(linked))
check('linked, the height follows the width', linked.w === beforeLink.w * 2
  && linked.h === beforeLink.h * 2, `${linked.w}x${linked.h}`)
check('so the canvas ratio is unchanged',
  Math.abs(linked.w / linked.h - beforeLink.w / beforeLink.h) < 0.001)
check('and the artwork still did not move',
  JSON.stringify(await geom()) === JSON.stringify(before))

await page.locator('.inspector .toggle', { hasText: 'Linked' }).click()
await page.waitForTimeout(150)
const unlinkedBefore = await size()
await widthBox.fill(String(Math.round(unlinkedBefore.w / 2)))
await widthBox.press('Enter')
await page.waitForTimeout(250)
const unlinked = await size()
check('unlinked, the height stays put', unlinked.h === unlinkedBefore.h,
  `${unlinked.w}x${unlinked.h}`)

// --- crop to fill, as a one-shot -----------------------------------------------------
await page.evaluate(([w, h]) => {
  const st = window.__pfState()
  st.resizeDoc(w, h)
  // Shrink a layer well inside the canvas so filling has something to do.
  const l = st.doc.layers[0]
  st.updateLayer(l.id, { x: 10, y: 10, w: l.w / 4, h: l.h / 4 })
}, [start.w, start.h])
await page.waitForTimeout(200)
const small = (await geom())[0]
await page.evaluate(() => window.__pfState().fillCanvas())
await page.waitForTimeout(250)
const covered = (await geom())[0]
const canvas = await size()
console.log('crop to fill:', JSON.stringify(small), '->', JSON.stringify(covered))
check('crop to fill grows the content to cover',
  covered.w >= canvas.w - 0.5 && covered.h >= canvas.h - 0.5,
  `${covered.w}x${covered.h} covering ${canvas.w}x${canvas.h}`)
check('without distorting it', ratioOf(covered) === ratioOf(small),
  `${ratioOf(covered)} vs ${ratioOf(small)}`)
check('and centres it rather than leaving it in the corner',
  Math.abs((covered.x + covered.w / 2) - canvas.w / 2) < 1
  && Math.abs((covered.y + covered.h / 2) - canvas.h / 2) < 1,
  `centre ${covered.x + covered.w / 2},${covered.y + covered.h / 2}`)

await page.evaluate(() => window.__pfState().undo())
await page.waitForTimeout(200)
check('and one undo puts it back',
  JSON.stringify((await geom())[0]) === JSON.stringify(small))

console.log(errors.length ? 'CONSOLE ERRORS: ' + errors.slice(0, 5).join(' | ') : 'no console errors')
await browser.close()
process.exit(checks.some(([, ok]) => !ok) ? 1 : 0)
