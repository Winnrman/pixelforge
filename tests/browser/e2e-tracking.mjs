// Motion tracking, checked against ground truth: the test GIF's disc follows a
// known parametric path, so tracked keyframes can be compared to the real thing.
import { chromium } from 'playwright-core'
import { importAndPlace } from '../e2e-helpers.mjs'
import fs from 'fs'
import path from 'path'

const OUT = 'shots/tracking'
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

// The fixture puts the disc at 160 + cos*90, 100 + sin*55, radius 34.
const R = 34
await page.evaluate((r) => {
  const s = window.__pfState()
  const { makeEffectLayer } = window.__pfStore
  s.addLayer(makeEffectLayer({
    name: 'Tracked blur', shape: 'ellipse', effect: 'pixelate', pixelSize: 10,
    x: 250 - r, y: 100 - r, w: r * 2, h: r * 2,
  }))
}, R)
await page.waitForTimeout(300)
await page.screenshot({ path: path.join(OUT, '01-before-track.png') })

const t0 = Date.now()
await page.evaluate(() => {
  const s = window.__pfState()
  const fx = s.doc.layers.find((l) => l.type === 'effect')
  return s.runTracker(fx.id, { direction: 'forward', radius: 32, simplify: false })
})
await page.waitForFunction(() => window.__pfState().tracking === null, { timeout: 120000 })
console.log('tracking took', ((Date.now() - t0) / 1000).toFixed(1), 's')

const raw = await page.evaluate(() => {
  const s = window.__pfState()
  const fx = s.doc.layers.find((l) => l.type === 'effect')
  return { keys: fx.tracks?.x?.length || 0, notice: s.notice, duration: s.duration }
})
console.log('raw track:', JSON.stringify(raw))
check('tracking produces a keyframe per frame', raw.keys >= 20)
check('tracking reports success', raw.notice?.kind === 'ok')

// Compare against the real disc path.
const accuracy = await page.evaluate(() => {
  const s = window.__pfState()
  const fx = s.doc.layers.find((l) => l.type === 'effect')
  const { resolveLayer } = window.__pfKeys
  const N = 24
  const total = s.duration
  let worst = 0
  const errs = []
  for (const k of fx.tracks.x) {
    const frame = Math.round((k.t / total) * N) % N
    const u = frame / N
    const ex = 160 + Math.cos(u * Math.PI * 2) * 90
    const ey = 100 + Math.sin(u * Math.PI * 2) * 55
    const got = resolveLayer(fx, k.t)
    const e = Math.hypot(got.x + got.w / 2 - ex, got.y + got.h / 2 - ey)
    errs.push(+e.toFixed(2))
    worst = Math.max(worst, e)
  }
  const mean = errs.reduce((a, b) => a + b, 0) / errs.length
  return { worst: +worst.toFixed(2), mean: +mean.toFixed(2), errs }
})
console.log('per-frame error (px):', JSON.stringify(accuracy.errs))
console.log('mean error:', accuracy.mean, 'px   worst:', accuracy.worst, 'px')
// Ground truth: the fixture's disc follows a known path, and its appearance
// changes every frame (stripes sweep across it), so this is a hard case.
check('tracked path stays close to the real motion on average', accuracy.mean < 2.5)
check('no frame strays far from the real motion', accuracy.worst < 6)

// The overlay must actually cover the disc after tracking.
const covers = await page.evaluate(() => {
  const s = window.__pfState()
  const c = document.createElement('canvas')
  c.width = s.doc.width
  c.height = s.doc.height
  const ctx = c.getContext('2d', { willReadFrequently: true })
  const N = 24
  let covered = 0
  let checked = 0
  for (let f = 0; f < N; f += 3) {
    const t = (f / N) * s.duration
    const u = f / N
    const ex = Math.round(160 + Math.cos(u * Math.PI * 2) * 90)
    const ey = Math.round(100 + Math.sin(u * Math.PI * 2) * 55)
    window.__pfRender.renderDocument(ctx, s.doc, t)
    const px = 10
    const gx = Math.floor(ex / px) * px + 1
    const gy = Math.floor(ey / px) * px + 1
    const d = ctx.getImageData(gx, gy, px - 2, px - 2).data
    let flat = true
    for (let i = 4; i < d.length; i += 4) {
      if (d[i] !== d[0] || d[i + 1] !== d[1] || d[i + 2] !== d[2]) { flat = false; break }
    }
    checked++
    if (flat) covered++
  }
  return { covered, checked }
})
console.log('frames where the disc is pixelated:', JSON.stringify(covers))
check('the overlay stays on the subject across the whole GIF',
  covers.covered === covers.checked)
await page.screenshot({ path: path.join(OUT, '02-after-track.png') })

// Simplification should shrink the key count without losing the path.
const simplified = await page.evaluate(() => {
  const s = window.__pfState()
  const fx = s.doc.layers.find((l) => l.type === 'effect')
  const before = fx.tracks.x.length
  const raw2 = fx.tracks.x.map((k) => ({
    t: k.t, x: k.v, y: fx.tracks.y.find((q) => q.t === k.t).v,
  }))
  const kept = window.__pfTracker.simplifyTrack(raw2, 0.75)
  let worst = 0
  for (const smp of raw2) {
    let a = kept[0]
    let b = kept[kept.length - 1]
    for (let i = 0; i < kept.length - 1; i++) {
      if (smp.t >= kept[i].t && smp.t <= kept[i + 1].t) { a = kept[i]; b = kept[i + 1]; break }
    }
    const u = b.t === a.t ? 0 : (smp.t - a.t) / (b.t - a.t)
    worst = Math.max(worst, Math.hypot(
      smp.x - (a.x + (b.x - a.x) * u),
      smp.y - (a.y + (b.y - a.y) * u)))
  }
  return { before, after: kept.length, worst: +worst.toFixed(2) }
})
console.log('simplify:', JSON.stringify(simplified))
check('simplify keeps fewer keyframes', simplified.after < simplified.before)
check('simplified curve stays within tolerance of the raw track', simplified.worst < 2.5)

// Tracking a featureless patch should refuse rather than drift.
const flat = await page.evaluate(async () => {
  const s = window.__pfState()
  const { makeShapeLayer, makeEffectLayer } = window.__pfStore
  s.addLayer(makeShapeLayer({ name: 'Flat', x: 0, y: 0, w: 320, h: 200, fill: '#202020' }))
  const probe = makeEffectLayer({ name: 'Probe', x: 120, y: 80, w: 50, h: 40 })
  s.addLayer(probe)
  await window.__pfState().runTracker(probe.id, { direction: 'forward' })
  return window.__pfState().notice
})
console.log('flat-area notice:', JSON.stringify(flat))
check('tracking a featureless area says so instead of drifting',
  flat?.kind === 'warn' && /flat|lock onto|find anything/i.test(flat.text))

console.log(errors.length ? '\nCONSOLE ERRORS:\n  ' + errors.slice(0, 10).join('\n  ') : '\nno console errors')
await browser.close()
process.exit(checks.some(([, ok]) => !ok) ? 1 : 0)
