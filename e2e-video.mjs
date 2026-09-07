// MP4 import: demux, on-demand decode, scrubbing, and frame-accurate export.
//
// The fixture encodes its own frame index as a white bar along the top (width =
// (index + 1) * 4 px), so a decoded frame can be identified rather than guessed
// at. The disc follows the same known path as the GIF fixture.
import { chromium } from 'playwright-core'
import { importAndPlace } from './e2e-helpers.mjs'
import fs from 'fs'
import path from 'path'

const OUT = 'shots-video'
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

const codecs = await page.evaluate(() => typeof VideoDecoder !== 'undefined')
console.log('WebCodecs available:', codecs)
check('the browser can decode video', codecs)

await importAndPlace(page, 'public/test/motion.mp4', { timeout: 30000 })
await page.waitForTimeout(900)
await page.evaluate(() => { window.__pfState().setPlaying(false); window.__pfState().setTime(0) })
await page.waitForTimeout(600)

const meta = await page.evaluate(() => {
  const s = window.__pfState()
  const a = window.__pfAssets.getAsset(s.doc.layers[0].assetId)
  return {
    isVideo: !!a.isVideo,
    w: a.width, h: a.height,
    frames: a.frames.length,
    duration: Math.round(a.duration),
    docW: s.doc.width, docH: s.doc.height,
    storeDuration: Math.round(s.duration),
    cached: a.cache.map.size,
    limit: a.cache.limit,
  }
})
console.log('imported:', JSON.stringify(meta))
check('the MP4 is recognised as video', meta.isVideo)
check('its size and frame count are read from the container',
  meta.w === 320 && meta.h === 200 && meta.frames === 48)
check('duration is right (48 frames at 24fps = 2s)',
  Math.abs(meta.duration - 2000) < 60 && Math.abs(meta.storeDuration - 2000) < 60)
check('the canvas takes the video size', meta.docW === 320 && meta.docH === 200)
check('only part of the clip is held in memory', meta.cached > 0 && meta.cached <= meta.limit)

/** Reads the marker bar to find out which frame is actually on screen. */
const frameOnScreen = () => page.evaluate(async () => {
  const s = window.__pfState()
  await window.__pfRender.awaitVideo(s.doc, s.time)
  const c = document.createElement('canvas')
  c.width = s.doc.width
  c.height = s.doc.height
  const ctx = c.getContext('2d', { willReadFrequently: true })
  window.__pfRender.renderDocument(ctx, s.doc, s.time)
  const d = ctx.getImageData(0, 2, c.width, 1).data
  let bar = 0
  for (let x = 0; x < c.width; x++) {
    const i = x * 4
    if (d[i] > 200 && d[i + 1] > 200 && d[i + 2] > 200) bar = x + 1
    else break
  }
  return Math.round(bar / 4) - 1
})

// --- scrubbing lands on the right frame --------------------------------------
const wanted = [0, 6, 17, 30, 47]
const got = []
for (const f of wanted) {
  await page.evaluate((t) => window.__pfState().setTime(t), (f / 24) * 1000 + 1)
  await page.waitForTimeout(260)
  got.push(await frameOnScreen())
}
console.log('asked for frames', JSON.stringify(wanted), '-> got', JSON.stringify(got))
check('scrubbing shows the frame that was asked for',
  got.every((v, i) => v === wanted[i]))
await page.screenshot({ path: path.join(OUT, '01-scrubbed.png') })

// --- seeking backwards must re-decode from a keyframe ------------------------
await page.evaluate(() => window.__pfState().setTime(0))
await page.waitForTimeout(300)
const back = await frameOnScreen()
console.log('after seeking back to 0 ->', back)
check('seeking backwards decodes again from a keyframe', back === 0)

// --- memory stays bounded while playing through ------------------------------
for (let f = 0; f < 48; f += 4) {
  await page.evaluate((t) => window.__pfState().setTime(t), (f / 24) * 1000 + 1)
  await page.waitForTimeout(90)
}
const mem = await page.evaluate(() => {
  const s = window.__pfState()
  const a = window.__pfAssets.getAsset(s.doc.layers[0].assetId)
  return { cached: a.cache.map.size, limit: a.cache.limit }
})
console.log('cache after playing through:', JSON.stringify(mem))
check('the frame cache stays within its budget', mem.cached <= mem.limit)

// --- overlays and export -----------------------------------------------------
await page.evaluate(() => {
  const s = window.__pfState()
  const { makeEffectLayer } = window.__pfStore
  s.addLayer(makeEffectLayer({ name: 'Blur', x: 200, y: 60, w: 90, h: 80, pixelSize: 10 }))
  s.setTime(0)
})
await page.waitForTimeout(400)
const overlaid = await page.evaluate(async () => {
  const s = window.__pfState()
  await window.__pfRender.awaitVideo(s.doc, 0)
  const c = document.createElement('canvas')
  c.width = s.doc.width
  c.height = s.doc.height
  const ctx = c.getContext('2d', { willReadFrequently: true })
  window.__pfRender.renderDocument(ctx, s.doc, 0)
  const px = 10
  const gx = Math.floor(240 / px) * px + 1
  const gy = Math.floor(100 / px) * px + 1
  const d = ctx.getImageData(gx, gy, px - 2, px - 2).data
  for (let i = 4; i < d.length; i += 4) {
    if (d[i] !== d[0] || d[i + 1] !== d[1] || d[i + 2] !== d[2]) return false
  }
  return true
})
check('pixelate overlays work over video', overlaid)

let exported = 0
try {
  const dl = page.waitForEvent('download', { timeout: 120000 })
  await page.click('header button.btn.primary')
  await page.waitForTimeout(400)
  await page.click('.modal-foot .btn.primary')
  const d = await dl
  const f = path.join(OUT, 'from-video.gif')
  await d.saveAs(f)
  exported = fs.statSync(f).size
} catch (err) {
  console.log('EXPORT FAILED:', String(err.message).slice(0, 120))
}
console.log('exported GIF bytes:', exported)
check('a video document exports to GIF', exported > 2000)
await page.screenshot({ path: path.join(OUT, '02-overlay.png') })

// --- 1080p: the frame pool ---------------------------------------------------
// A decoded VideoFrame occupies a slot in a small hardware pool. Holding them
// until after flush() exhausts it, the decoder stalls, and the import hangs on a
// blank canvas. This clip has one keyframe, so reaching its end means decoding a
// long run in one go.
const hd = await page.evaluate(async () => {
  const buf = await (await fetch('/test/hd.mp4')).arrayBuffer()
  const V = window.__pfVideo
  const a = await V.loadVideo(buf, 'hd.mp4', 'video/mp4')
  const started = performance.now()
  const first = await V.exactFrame(a, 0)
  const firstMs = Math.round(performance.now() - started)
  const t1 = performance.now()
  const last = await V.exactFrame(a, a.duration - 1)
  const lastMs = Math.round(performance.now() - t1)
  return {
    w: a.width, h: a.height, frames: a.frames.length,
    syncs: a.video.samples.filter((s) => s.isSync).length,
    gotFirst: !!first, gotLast: !!last, firstMs, lastMs,
    cached: a.cache.map.size, limit: a.cache.limit,
  }
})
console.log('1080p:', JSON.stringify(hd))
check('a 1080p clip decodes at all', hd.w === 1920 && hd.gotFirst)
check('decoding a long run does not stall the frame pool', hd.gotLast)
check('it stays quick', hd.firstMs < 5000 && hd.lastMs < 8000)
check('the cache respects its budget at 1080p', hd.cached <= hd.limit && hd.limit < 200)

console.log(errors.length ? 'CONSOLE ERRORS: ' + errors.slice(0, 5).join(' | ') : 'no console errors')
await browser.close()
process.exit(checks.some(([, ok]) => !ok) ? 1 : 0)
