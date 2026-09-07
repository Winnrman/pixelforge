// Animatable framing: crop insets that reveal rather than squash, plus zoom and
// pan of the sampled region.
import { chromium } from 'playwright-core'
import { importAndPlace } from './e2e-helpers.mjs'
import fs from 'fs'
import path from 'path'

const OUT = 'shots-framing'
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

// --- crop reveals, it does not squash ---------------------------------------
// With the bottom cropped by half, the destination AND the sampled source both
// halve, so the top half must render pixel-for-pixel as before.
const crop = await page.evaluate(() => {
  const s = window.__pfState()
  const l = s.doc.layers[0]
  const c = document.createElement('canvas')
  c.width = s.doc.width
  c.height = s.doc.height
  const ctx = c.getContext('2d', { willReadFrequently: true })
  const render = (patch) => {
    const doc = { ...s.doc, layers: [{ ...l, ...patch }] }
    window.__pfRender.renderDocument(ctx, doc, 0)
    return ctx.getImageData(0, 0, c.width, c.height).data
  }
  const hashOf = (d, x0, y0, w, h, W) => {
    let n = 2166136261
    for (let y = y0; y < y0 + h; y++) {
      for (let x = x0; x < x0 + w; x += 3) {
        const i = (y * W + x) * 4
        n ^= d[i]; n = Math.imul(n, 16777619)
        n ^= d[i + 1]; n = Math.imul(n, 16777619)
      }
    }
    return (n >>> 0).toString(16)
  }
  const W = c.width
  const H = c.height
  const plain = render({})
  const cropped = render({ cropB: 0.5 })
  const squashed = render({ h: l.h / 2 })  // what stretching would look like
  const alphaAt = (d, x, y) => d[(y * W + x) * 4 + 3]
  return {
    topPlain: hashOf(plain, 0, 0, W, Math.floor(H / 2) - 1, W),
    topCropped: hashOf(cropped, 0, 0, W, Math.floor(H / 2) - 1, W),
    topSquashed: hashOf(squashed, 0, 0, W, Math.floor(H / 2) - 1, W),
    belowCropped: alphaAt(cropped, Math.floor(W / 2), H - 4),
    belowPlain: alphaAt(plain, Math.floor(W / 2), H - 4),
  }
})
console.log('crop hashes:', JSON.stringify(crop))
check('cropping the bottom leaves the kept part pixel-identical',
  crop.topCropped === crop.topPlain)
check('that is a real crop, not the squash you get from shrinking height',
  crop.topSquashed !== crop.topPlain)
check('the cropped-away area is empty', crop.belowCropped === 0 && crop.belowPlain === 255)

// --- zoom pushes into the image ---------------------------------------------
const zoom = await page.evaluate(() => {
  const s = window.__pfState()
  const l = s.doc.layers[0]
  const { sourceRect } = window.__pfRender
  const at1 = sourceRect({ ...l, zoom: 1 })
  const at2 = sourceRect({ ...l, zoom: 2 })
  const at4 = sourceRect({ ...l, zoom: 4 })
  const panned = sourceRect({ ...l, zoom: 2, panX: 0.2 })
  const overPanned = sourceRect({ ...l, zoom: 2, panX: 5 })
  return { at1, at2, at4, panned, overPanned }
})
console.log('source rects:', JSON.stringify(zoom))
check('zoom 1 samples the whole image',
  zoom.at1.w === 1 && zoom.at1.h === 1 && zoom.at1.x === 0)
check('zoom 2 samples half the width and height, centred',
  Math.abs(zoom.at2.w - 0.5) < 1e-6 && Math.abs(zoom.at2.x - 0.25) < 1e-6)
check('zoom 4 samples a quarter', Math.abs(zoom.at4.w - 0.25) < 1e-6)
check('pan slides the sampled window', zoom.panned.x > zoom.at2.x)
check('pan cannot slide off the image',
  zoom.overPanned.x >= 0 && zoom.overPanned.x + zoom.overPanned.w <= 1 + 1e-9)

// The centre pixel is the fixed point of a centred zoom.
const centre = await page.evaluate(() => {
  const s = window.__pfState()
  const l = s.doc.layers[0]
  const c = document.createElement('canvas')
  c.width = s.doc.width
  c.height = s.doc.height
  const ctx = c.getContext('2d', { willReadFrequently: true })
  const px = (patch) => {
    window.__pfRender.renderDocument(ctx, { ...s.doc, layers: [{ ...l, ...patch }] }, 0)
    return [...ctx.getImageData(c.width >> 1, c.height >> 1, 1, 1).data]
  }
  return { one: px({}), two: px({ zoom: 2 }) }
})
console.log('centre pixel at zoom 1 / 2:', JSON.stringify(centre))
check('a centred zoom keeps the middle of the image put',
  centre.one.every((v, i) => Math.abs(v - centre.two[i]) <= 6))

// --- animating it -----------------------------------------------------------
await page.evaluate(() => {
  const s = window.__pfState()
  const l = s.doc.layers[0]
  s.select([l.id])
  s.setAutoTrack(l.id, true)
  s.setTime(0)
  s.setTime(900)
  s.setLayerAtTime(l.id, { cropB: 0.5, zoom: 2 })
})
await page.waitForTimeout(400)

const tracks = await page.evaluate(() => {
  const l = window.__pfState().doc.layers[0]
  return {
    keys: Object.fromEntries(Object.entries(l.tracks || {}).map(([k, v]) => [k, v.length])),
    midCropB: window.__pfKeys.resolveLayer(l, 450).cropB,
    midZoom: window.__pfKeys.resolveLayer(l, 450).zoom,
  }
})
console.log('framing tracks:', JSON.stringify(tracks))
check('changing crop while tracking grows a crop track', tracks.keys.cropB === 2)
check('changing zoom while tracking grows a zoom track', tracks.keys.zoom === 2)
check('crop tweens between keys',
  tracks.midCropB > 0.2 && tracks.midCropB < 0.3)
check('zoom tweens between keys',
  tracks.midZoom > 1.4 && tracks.midZoom < 1.6)

const lanes = await page.locator('.key-lane .lane-name').allTextContents()
console.log('timeline lanes:', JSON.stringify(lanes))
check('crop and zoom get their own timeline lanes',
  lanes.includes('Crop') && lanes.includes('Zoom'))
await page.screenshot({ path: path.join(OUT, '01-framing.png') })

// The rendered result really changes over the animation, and the layer's
// visible height shrinks as the crop comes in.
const overTime = await page.evaluate(() => {
  const s = window.__pfState()
  const c = document.createElement('canvas')
  c.width = s.doc.width
  c.height = s.doc.height
  const ctx = c.getContext('2d', { willReadFrequently: true })
  const bottomAlpha = (t) => {
    window.__pfRender.renderDocument(ctx, s.doc, t)
    return ctx.getImageData(c.width >> 1, c.height - 4, 1, 1).data[3]
  }
  return { start: bottomAlpha(0), mid: bottomAlpha(450), end: bottomAlpha(900) }
})
console.log('bottom alpha over time:', JSON.stringify(overTime))
check('the layer visibly gets shorter as the crop animates',
  overTime.start === 255 && overTime.end === 0)

// Undo should take the whole framing animation back off.
await page.evaluate(() => window.__pfState().setTime(0))
await page.waitForTimeout(150)
const exported = await (async () => {
  const dl = page.waitForEvent('download', { timeout: 60000 })
  await page.click('header button.btn.primary')
  await page.waitForTimeout(400)
  await page.click('.modal-foot .btn.primary')
  const d = await dl
  const f = path.join(OUT, 'framing.gif')
  await d.saveAs(f)
  return fs.statSync(f).size
})().catch(() => 0)
console.log('exported GIF bytes:', exported)
check('an animated crop exports to GIF', exported > 1000)

console.log(errors.length ? '\nCONSOLE ERRORS:\n  ' + errors.slice(0, 10).join('\n  ') : '\nno console errors')
await browser.close()
process.exit(checks.some(([, ok]) => !ok) ? 1 : 0)
