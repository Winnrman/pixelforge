import { chromium } from 'playwright-core'
import { importAndPlace } from './e2e-helpers.mjs'
const browser = await chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true })
const page = await browser.newPage({ viewport: { width: 1600, height: 950 } })
page.on('pageerror', e => console.log('PAGEERROR:', e.message))
await page.goto('http://localhost:5173/', { waitUntil: 'networkidle' })
await page.evaluate(() => indexedDB.deleteDatabase('pixelforge'))
await page.reload({ waitUntil: 'networkidle' })
await importAndPlace(page, 'public/test/beeps.mp4', { timeout: 40000 })
await page.evaluate(() => { window.__pfState().setPlaying(false); window.__pfState().setTime(0) })
await page.waitForTimeout(2000)
await page.evaluate(() => { const b = [...document.querySelectorAll('.tl-tabs button')].find(x => /^Video/.test(x.textContent)); if (b) b.click() })
await page.waitForTimeout(2000)
console.log(await page.evaluate(() => {
  const c = document.querySelector('.audio-clip canvas')
  if (!c) return { none: true, rows: document.querySelectorAll('.audio-row').length }
  const ctx = c.getContext('2d', { willReadFrequently: true })
  const d = ctx.getImageData(0, 0, c.width, c.height).data
  // Column heights: how tall the drawn wave is at each x.
  const heights = []
  for (let x = 0; x < c.width; x += Math.max(1, Math.floor(c.width / 12))) {
    let lit = 0
    for (let y = 0; y < c.height; y++) if (d[(y * c.width + x) * 4 + 3] > 8) lit++
    heights.push(Math.round((lit / c.height) * 100))
  }
  const st = window.__pfState()
  const l = st.doc.layers[0]
  const a = window.__pfAssets.getAsset(l.assetId)
  const range = window.__pfClips.clipRange(l, a)
  return {
    canvas: { w: c.width, h: c.height },
    heightsPercent: heights,
    range: { start: Math.round(range.start), end: Math.round(range.end) },
    assetWindow: [
      Math.round(window.__pfClips.assetTimeFor(l, range.start, a)),
      Math.round(window.__pfClips.assetTimeFor(l, range.end, a)),
    ],
    audioDur: a.audio ? Math.round(a.audio.duration * 1000) : null,
    peaks: window.__pfWave.hasPeaks(a),
  }
}))
await page.screenshot({ path: 'shots-editing/03-wave.png' })
await browser.close()
