// The Video tab: a filmstrip of thumbnails under the timeline.
//
// A strip that renders *something* is easy; the checks that matter are that the
// thumbnails are the actual footage, in the right order, and that they follow a
// layer that has been retimed rather than drawing the raw clip.
import { chromium } from 'playwright-core'
import { importAndPlace } from './e2e-helpers.mjs'
import fs from 'fs'
import path from 'path'

const OUT = 'shots-filmstrip'
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
const check = (name, ok, detail = '') => {
  checks.push([name, ok])
  console.log((ok ? 'PASS  ' : 'FAIL  ') + name + (detail ? '  — ' + detail : ''))
}

await page.goto('http://localhost:5173/', { waitUntil: 'networkidle' })
await page.evaluate(() => indexedDB.deleteDatabase('pixelforge'))
await page.reload({ waitUntil: 'networkidle' })

const load = async (fixture) => {
  await page.evaluate(() => window.__pfState().resetDoc())
  await page.waitForTimeout(150)
  await importAndPlace(page, fixture, { timeout: 30000 })
  await page.evaluate(() => { window.__pfState().setPlaying(false); window.__pfState().setTime(0) })
  await page.waitForTimeout(500)
}

/** Column signatures across the strip canvas, in CSS pixels. */
const stripColumns = (n = 8) => page.evaluate((n) => {
  const c = document.querySelector('.strip canvas')
  if (!c) return null
  const ctx = c.getContext('2d')
  const img = ctx.getImageData(0, 0, c.width, c.height)
  const cols = []
  for (let k = 0; k < n; k++) {
    const x = Math.min(c.width - 1, Math.round(((k + 0.5) / n) * c.width))
    let r = 0, g = 0, b = 0, a = 0
    for (let y = 0; y < c.height; y++) {
      const i = (y * c.width + x) * 4
      r += img.data[i]; g += img.data[i + 1]; b += img.data[i + 2]; a += img.data[i + 3]
    }
    const px = c.height
    cols.push([Math.round(r / px), Math.round(g / px), Math.round(b / px), Math.round(a / px)])
  }
  return { cols, w: c.width, h: c.height }
}, n)

/**
 * Waits for a strip to be fully painted.
 *
 * Not for the "n left" badge: that only exists while work is outstanding, so it
 * is absent both before the effect starts and after it finishes, and waiting on
 * its absence passes instantly. The real condition is every slot having opaque
 * pixels.
 */
const waitForStrip = async (n = 10, timeout = 60000) => {
  const started = Date.now()
  for (;;) {
    const s = await stripColumns(n)
    if (s?.cols.length === n && s.cols.every((c) => c[3] > 200)) return Date.now() - started
    if (Date.now() - started > timeout) throw new Error('strip never finished painting')
    await new Promise((r) => setTimeout(r, 120))
  }
}

// --- the tab itself -----------------------------------------------------------
await load('public/test/motion.gif')

const tabsBefore = await page.evaluate(() =>
  [...document.querySelectorAll('.tl-tabs button')].map((b) => b.textContent.trim()))
console.log('tabs:', JSON.stringify(tabsBefore))
check('the timeline grows a tab bar', tabsBefore.length === 2, tabsBefore.join(' | '))
check('and a Video tab is offered', tabsBefore.some((t) => /^Video/.test(t)), tabsBefore.join(' | '))
check('with a count of the clips on it', /Video\s*1/.test(tabsBefore.find((t) => /^Video/.test(t)) || ''),
  tabsBefore.find((t) => /^Video/.test(t)))

check('the strip is not built until the tab is opened',
  await page.evaluate(() => document.querySelectorAll('.strip').length === 0))

await page.click('.tl-tabs button:has-text("Video")')
await page.waitForSelector('.strip canvas', { timeout: 15000 })
await waitForStrip(10)

const meta = await page.evaluate(() => ({
  rows: document.querySelectorAll('.strip-row').length,
  name: document.querySelector('.strip-name')?.textContent,
  info: document.querySelector('.strip-meta')?.textContent,
}))
console.log('strip row:', JSON.stringify(meta))
check('one strip per animated layer', meta.rows === 1)
check('labelled with the layer and what it is', /GIF/.test(meta.info || '') && /24f/.test(meta.info || ''), meta.info)

// --- the thumbnails are the real footage --------------------------------------
const gif = await stripColumns(10)
console.log('strip canvas:', gif.w, 'x', gif.h)
console.log('columns:', JSON.stringify(gif.cols))
check('the strip canvas is a sensible size', gif.w > 200 && gif.h >= 44 && gif.h <= 96, `${gif.w}x${gif.h}`)
check('every slot was painted', gif.cols.every((c) => c[3] > 200),
  `alphas ${gif.cols.map((c) => c[3]).join(',')}`)

// The fixture's disc travels a circle over a dark field, so column brightness
// must vary across the strip — a strip showing one frame repeated would not.
const lum = gif.cols.map((c) => Math.round(0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2]))
const spread = Math.max(...lum) - Math.min(...lum)
console.log('column luminance:', JSON.stringify(lum), 'spread', spread)
check('the thumbnails differ across the strip', spread > 6, `spread ${spread}`)
check('and are not all the same frame', new Set(gif.cols.map((c) => c.join(','))).size >= 5,
  `${new Set(gif.cols.map((c) => c.join(','))).size} distinct of ${gif.cols.length}`)

await page.screenshot({ path: path.join(OUT, '01-gif-strip.png') })

// --- the playhead and scrubbing ------------------------------------------------
await page.evaluate(() => window.__pfState().setTime(0))
await page.waitForTimeout(150)
const atZero = await page.evaluate(() => document.querySelector('.strip-playhead').style.left)
await page.evaluate(() => window.__pfState().setTime(window.__pfState().duration * 0.75))
await page.waitForTimeout(150)
const atThreeQ = await page.evaluate(() => document.querySelector('.strip-playhead').style.left)
console.log('playhead:', atZero, '->', atThreeQ)
check('the strip carries a playhead that follows the clock',
  atZero === '0%' && Math.abs(parseFloat(atThreeQ) - 75) < 1.5, `${atZero} -> ${atThreeQ}`)

const box = await page.locator('.strip').boundingBox()
await page.mouse.click(box.x + box.width * 0.3, box.y + box.height / 2)
await page.waitForTimeout(200)
const scrubbed = await page.evaluate(() => ({
  time: window.__pfState().time,
  duration: window.__pfState().duration,
  selected: window.__pfState().selectedIds.length,
}))
console.log('after clicking 30% along:', JSON.stringify(scrubbed))
check('clicking the strip scrubs there',
  Math.abs(scrubbed.time / scrubbed.duration - 0.3) < 0.05,
  `${(scrubbed.time / scrubbed.duration * 100).toFixed(1)}%`)
check('and selects that layer', scrubbed.selected === 1)

// --- retiming a layer must move the strip with it -------------------------------
// A strip is document time, not clip time. At 2x speed the second half of the
// lane shows the clip's *second* loop, so the strip must not be identical.
const before = await stripColumns(10)
await page.evaluate(() => {
  const s = window.__pfState()
  s.updateLayer(s.doc.layers[0].id, { timeOffset: 400 })
  s.recomputeDuration()
})
await waitForStrip(10)
await page.waitForTimeout(200)
const after = await stripColumns(10)
const moved = before.cols.filter((c, i) => c.join(',') !== after.cols[i].join(',')).length
console.log('slots changed after a 400ms offset:', moved, 'of', before.cols.length)
check('offsetting the layer redraws the strip against the new timing', moved >= 4,
  `${moved} of ${before.cols.length} slots changed`)

// --- video, which has to decode rather than read frames it already holds --------
await load('public/test/motion.mp4')
// Timed from the click, not from the first poll — the effect starts as soon as
// the tab renders, so a clock started after waitForSelector misses most of it.
const vidStart = Date.now()
await page.click('.tl-tabs button:has-text("Video")')
await page.waitForSelector('.strip canvas', { timeout: 15000 })
await waitForStrip(10)
const decodeMs = Date.now() - vidStart

// A video arrives as a clip on a track now, so the row's meta column is the
// track's, not the file's — the clip carries its own name over its thumbnails.
const vidMeta = await page.evaluate(() => ({
  meta: document.querySelector('.strip-meta')?.textContent || '',
  title: document.querySelector('.clip-title')?.textContent || '',
  tip: document.querySelector('.strip.clip')?.getAttribute('title') || '',
}))
const vid = await stripColumns(10)
console.log('video strip in', decodeMs + 'ms ·', JSON.stringify(vid.cols))
check('a video layer gets a strip too', !!vid && vid.cols.length === 10)
check('and the clip says which file it is', /\.mp4/i.test(vidMeta.title),
  JSON.stringify(vidMeta))
check('with its span and what a drag does, in the tooltip',
  /drag to move/.test(vidMeta.tip) && /s to /.test(vidMeta.tip), vidMeta.tip)
check('every video slot was decoded', vid.cols.every((c) => c[3] > 200),
  `alphas ${vid.cols.map((c) => c[3]).join(',')}`)
const vlum = vid.cols.map((c) => Math.round(0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2]))
console.log('video column luminance:', JSON.stringify(vlum))
check('and the video thumbnails are different frames',
  Math.max(...vlum) - Math.min(...vlum) > 6, `spread ${Math.max(...vlum) - Math.min(...vlum)}`)
check('building the strip did not take absurdly long', decodeMs < 45000, `${decodeMs}ms`)

// Playback must still work afterwards — the thumbnails share a decoder with it.
await page.evaluate(() => { window.__pfState().setTime(0); window.__pfState().setPlaying(true) })
await page.waitForTimeout(900)
const played = await page.evaluate(() => {
  const s = window.__pfState()
  s.setPlaying(false)
  return s.time
})
console.log('playhead after 900ms of playback:', Math.round(played))
check('playback still runs after the strip was built', played > 200, `${Math.round(played)}ms`)

// Re-opening the tab must be instant, from cache rather than a second decode.
await page.click('.tl-tabs button:has-text("Keyframes")')
await page.waitForTimeout(150)
const t1 = Date.now()
await page.click('.tl-tabs button:has-text("Video")')
await page.waitForSelector('.strip canvas', { timeout: 15000 })
await waitForStrip(10)
const again = Date.now() - t1

console.log('strip rebuilt in', again + 'ms (first build was ' + decodeMs + 'ms)')
// Both are fast enough on a 2s fixture that comparing them proves nothing, so
// the cache is checked where it actually lives instead of inferred from a clock.
const cacheState = await page.evaluate(() => {
  const s = window.__pfState()
  const a = window.__pfAssets.getAsset(s.doc.layers[0].assetId)
  const F = window.__pfFilmstrip
  // The same window *and* the same width the component drew with. Thumbnails are
  // cached against the exact millisecond they were sampled at, so a different
  // element width means a different number of slots, different sample times,
  // and every lookup misses — which would look like a broken cache rather than
  // a mismeasured test.
  const l = s.doc.layers[0]
  const el = [...document.querySelectorAll('.strip')]
    .find((x) => x.querySelector('canvas'))
  const width = el ? Math.floor(el.getBoundingClientRect().width) : 800
  const shown = F.stripTimes(l, a, width, s.duration, F.THUMB_H,
    F.stripWindow(l, a, s.duration))
  return {
    width,
    slots: shown.length,
    cached: shown.filter((sl) => !!F.cachedThumb(a, sl.assetT)).length,
    // A time no slot asked for must miss, or "cached" would be meaningless.
    unseen: !!F.cachedThumb(a, 7.77),
    thumbW: F.thumbWidth(a),
    thumbH: F.THUMB_H,
  }
})
console.log('thumb cache:', JSON.stringify(cacheState))
check('every slot the strip drew is held in the cache',
  cacheState.cached === cacheState.slots && cacheState.slots > 4,
  `${cacheState.cached} of ${cacheState.slots}`)
check('and a time nothing asked for is not', cacheState.unseen === false)
check('thumbnails are kept small', cacheState.thumbH === 44 && cacheState.thumbW < 200,
  `${cacheState.thumbW}x${cacheState.thumbH}`)

await page.screenshot({ path: path.join(OUT, '02-video-strip.png') })

// --- the worst case: 1080p with a single keyframe ------------------------------
// Every thumbnail after the first has to decode forward from frame 0, and each
// decoded frame occupies a slot in the small hardware frame pool. This is the
// shape that deadlocked MP4 import, so a strip built from it is worth proving.
await load('public/test/hd.mp4')
const hdStart = Date.now()
await page.click('.tl-tabs button:has-text("Video")')
await page.waitForSelector('.strip canvas', { timeout: 15000 })
await waitForStrip(10, 90000)
const hdMs = Date.now() - hdStart
const hd = await stripColumns(10)
const hdMeta = await page.evaluate(() => {
  const s = window.__pfState()
  const a = window.__pfAssets.getAsset(s.doc.layers[0].assetId)
  return { label: document.querySelector('.strip-meta')?.textContent, w: a.width, h: a.height }
})
check('the stress fixture really is 1080p', hdMeta.w === 1920 && hdMeta.h === 1080,
  `${hdMeta.w}x${hdMeta.h}`)
const hdLum = hd.cols.map((c) => Math.round(0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2]))
console.log('1080p strip in', hdMs + 'ms ·', JSON.stringify(hdMeta), '· luminance', JSON.stringify(hdLum))
check('a 1080p clip with one keyframe still builds a full strip',
  hd.cols.every((c) => c[3] > 200), `alphas ${hd.cols.map((c) => c[3]).join(',')}`)
check('its thumbnails are real frames, not one repeated',
  Math.max(...hdLum) - Math.min(...hdLum) > 3, `spread ${Math.max(...hdLum) - Math.min(...hdLum)}`)
check('and it does not take forever', hdMs < 60000, `${hdMs}ms for 10 thumbnails`)

// The decoder must still be usable afterwards — thumbnails share its budget.
const stillDecodes = await page.evaluate(async () => {
  const s = window.__pfState()
  const a = window.__pfAssets.getAsset(s.doc.layers[0].assetId)
  const started = performance.now()
  const f = await window.__pfVideo.exactFrame(a, a.duration * 0.5)
  return { got: !!f, ms: Math.round(performance.now() - started) }
})
console.log('a fresh decode after the strip:', JSON.stringify(stillDecodes))
check('playback decoding still works after building the strip', stillDecodes.got,
  `${stillDecodes.ms}ms`)

console.log(errors.length ? 'CONSOLE ERRORS: ' + errors.slice(0, 5).join(' | ') : 'no console errors')
await browser.close()
process.exit(checks.some(([, ok]) => !ok) ? 1 : 0)
