// Cropping must resize the layer to what actually survives — not just shift it —
// while rendering identical pixels and staying undoable.
import { chromium } from 'playwright-core'
import { importAndPlace } from './e2e-helpers.mjs'
import fs from 'fs'
import path from 'path'

const OUT = 'shots-crop'
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

await page.goto('http://localhost:5173/', { waitUntil: 'networkidle' })
await page.evaluate(() => indexedDB.deleteDatabase('pixelforge'))
await page.reload({ waitUntil: 'networkidle' })
await importAndPlace(page, 'public/test/motion.gif', { timeout: 10000 })
await page.waitForTimeout(700)
await page.evaluate(() => { window.__pfState().setPlaying(false); window.__pfState().setTime(0) })

const CROP = { x: 60, y: 40, w: 160, h: 100 }

// Pixels inside the crop region, sampled before cropping.
const before = await page.evaluate((crop) => {
  const s = window.__pfState()
  const c = document.createElement('canvas')
  c.width = s.doc.width
  c.height = s.doc.height
  const ctx = c.getContext('2d', { willReadFrequently: true })
  window.__pfRender.renderDocument(ctx, s.doc, 0)
  const d = ctx.getImageData(crop.x, crop.y, crop.w, crop.h).data
  let h = 2166136261
  for (let i = 0; i < d.length; i += 7) { h ^= d[i]; h = Math.imul(h, 16777619) }
  const l = s.doc.layers[0]
  return {
    hash: (h >>> 0).toString(16),
    layer: { x: l.x, y: l.y, w: l.w, h: l.h, src: l.src || null },
    doc: [s.doc.width, s.doc.height],
  }
}, CROP)
console.log('before:', JSON.stringify(before))

await page.evaluate((crop) => window.__pfState().applyCrop(crop), CROP)
await page.waitForTimeout(300)
await page.screenshot({ path: path.join(OUT, '01-after-crop.png') })

const after = await page.evaluate(() => {
  const s = window.__pfState()
  const l = s.doc.layers[0]
  const c = document.createElement('canvas')
  c.width = s.doc.width
  c.height = s.doc.height
  const ctx = c.getContext('2d', { willReadFrequently: true })
  window.__pfRender.renderDocument(ctx, s.doc, 0)
  const d = ctx.getImageData(0, 0, c.width, c.height).data
  let h = 2166136261
  for (let i = 0; i < d.length; i += 7) { h ^= d[i]; h = Math.imul(h, 16777619) }
  return {
    hash: (h >>> 0).toString(16),
    layer: { x: l.x, y: l.y, w: l.w, h: l.h, src: l.src || null },
    doc: [s.doc.width, s.doc.height],
  }
})
console.log('after :', JSON.stringify(after))

check('canvas takes the crop size', after.doc[0] === CROP.w && after.doc[1] === CROP.h)
check('layer box is trimmed to the surviving region, not just moved',
  after.layer.x === 0 && after.layer.y === 0 &&
  after.layer.w === CROP.w && after.layer.h === CROP.h)
check('layer no longer spills outside the canvas',
  after.layer.x >= 0 && after.layer.y >= 0 &&
  after.layer.x + after.layer.w <= after.doc[0] &&
  after.layer.y + after.layer.h <= after.doc[1])
check('a source sub-rect records which part of the asset is shown',
  after.layer.src !== null &&
  Math.abs(after.layer.src.x - 60 / 320) < 0.001 &&
  Math.abs(after.layer.src.y - 40 / 200) < 0.001 &&
  Math.abs(after.layer.src.w - 160 / 320) < 0.001 &&
  Math.abs(after.layer.src.h - 100 / 200) < 0.001)
check('cropped result renders exactly the pixels that were inside the crop',
  after.hash === before.hash)

// Corner radius must now follow the cropped shape, which was the point.
const radius = await page.evaluate(() => {
  const s = window.__pfState()
  const l = s.doc.layers[0]
  s.updateLayer(l.id, { radius: 40 })
  const st = window.__pfState()
  const c = document.createElement('canvas')
  c.width = st.doc.width
  c.height = st.doc.height
  const ctx = c.getContext('2d', { willReadFrequently: true })
  window.__pfRender.renderDocument(ctx, st.doc, 0)
  const at = (x, y) => ctx.getImageData(x, y, 1, 1).data[3]
  return { corner: at(2, 2), middle: at(80, 50) }
})
console.log('alpha at corner / middle:', JSON.stringify(radius))
check('corner radius rounds the cropped shape', radius.corner === 0 && radius.middle === 255)

await page.evaluate(() => {
  const s = window.__pfState()
  s.updateLayer(s.doc.layers[0].id, { radius: 0 })
})

// Animation still tracks after a crop.
const stillAnimates = await page.evaluate(() => {
  const s = window.__pfState()
  const c = document.createElement('canvas')
  c.width = s.doc.width
  c.height = s.doc.height
  const ctx = c.getContext('2d', { willReadFrequently: true })
  const sig = (t) => {
    window.__pfRender.renderDocument(ctx, s.doc, t)
    const d = ctx.getImageData(0, 0, c.width, c.height).data
    let h = 2166136261
    for (let i = 0; i < d.length; i += 11) { h ^= d[i]; h = Math.imul(h, 16777619) }
    return (h >>> 0).toString(16)
  }
  return { a: sig(0), b: sig(600) }
})
check('the cropped GIF still animates', stillAnimates.a !== stillAnimates.b)

// Undo must put the original back exactly.
await page.keyboard.press('Control+z')
await page.waitForTimeout(300)
const undone = await page.evaluate(() => {
  const s = window.__pfState()
  const l = s.doc.layers[0]
  return { doc: [s.doc.width, s.doc.height], layer: { x: l.x, y: l.y, w: l.w, h: l.h, src: l.src || null } }
})
console.log('undone:', JSON.stringify(undone))
check('undo restores the canvas size', undone.doc[0] === before.doc[0] && undone.doc[1] === before.doc[1])
check('undo restores the full layer, sub-rect and all',
  undone.layer.x === before.layer.x && undone.layer.y === before.layer.y &&
  undone.layer.w === before.layer.w && undone.layer.h === before.layer.h &&
  undone.layer.src === before.layer.src)

// --- document background ----------------------------------------------------
await page.evaluate(() => {
  const s = window.__pfState()
  s.updateLayer(s.doc.layers[0].id, { x: 60, y: 40, w: 200, h: 120 })
  s.select([]) // the Document panel only shows with nothing selected
})
await page.waitForTimeout(200)
await page.click('.segmented button:has-text("Color")')
await page.waitForTimeout(200)
const bgOn = await page.evaluate(() => window.__pfState().doc.background)
console.log('background after clicking Color:', bgOn)
check('choosing Color sets a visible background', bgOn !== 'transparent' && /^#/.test(bgOn))

await page.evaluate(() => window.__pfState().setDoc({ background: '#ff0000' }))
await page.waitForTimeout(200)
const painted = await page.evaluate(() => {
  const s = window.__pfState()
  const c = document.createElement('canvas')
  c.width = s.doc.width
  c.height = s.doc.height
  const ctx = c.getContext('2d', { willReadFrequently: true })
  window.__pfRender.renderDocument(ctx, s.doc, 0)
  return [...ctx.getImageData(4, 4, 1, 1).data]
})
console.log('margin pixel with red background:', JSON.stringify(painted))
check('the background colour actually paints the canvas',
  painted[0] === 255 && painted[1] === 0 && painted[2] === 0 && painted[3] === 255)

const swatch = await page.locator('input[type=color]').count()
check('a colour swatch appears once Color is chosen', swatch === 1)
await page.screenshot({ path: path.join(OUT, '02-background.png') })

console.log(errors.length ? '\nCONSOLE ERRORS:\n  ' + errors.slice(0, 10).join('\n  ') : '\nno console errors')
await browser.close()
process.exit(checks.some(([, ok]) => !ok) ? 1 : 0)
