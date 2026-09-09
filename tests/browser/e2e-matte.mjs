// Background removal by colour key, measured on a fixture with known ground
// truth: a disc of known position and radius on a near-flat green field, with a
// patch of pure background colour hidden inside the subject.
import { chromium } from 'playwright-core'
import { importAndPlace } from '../e2e-helpers.mjs'
import fs from 'fs'
import path from 'path'

const OUT = 'shots-matte'
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
await importAndPlace(page, 'public/test/greenscreen.gif', { timeout: 10000 })
await page.waitForTimeout(700)
await page.evaluate(() => { window.__pfState().setPlaying(false); window.__pfState().setTime(0) })
await page.screenshot({ path: path.join(OUT, '01-original.png') })

// Turn keying on through the store, exactly as the panel does.
await page.evaluate(() => {
  const s = window.__pfState()
  const l = s.doc.layers[0]
  s.updateLayer(l.id, { bgRemove: { ...window.__pfMatte.defaultBgRemove(), on: true } })
})
await page.waitForTimeout(500)
await page.screenshot({ path: path.join(OUT, '02-keyed.png') })

// Ground truth: at t=0 the disc sits at (250, 100) with radius 34, and the
// inner green dot is centred 12 left and 8 up from that, radius 7.
const probe = await page.evaluate(() => {
  const s = window.__pfState()
  const c = document.createElement('canvas')
  c.width = s.doc.width
  c.height = s.doc.height
  const ctx = c.getContext('2d', { willReadFrequently: true })
  window.__pfRender.renderDocument(ctx, s.doc, 0)
  const d = ctx.getImageData(0, 0, c.width, c.height).data
  const alphaAt = (x, y) => d[((y * c.width + x) << 2) + 3]

  // Classify every pixel against the truth to get real rates.
  let tp = 0
  let fp = 0
  let tn = 0
  let fn = 0
  for (let y = 0; y < c.height; y++) {
    for (let x = 0; x < c.width; x++) {
      const inSubject = Math.hypot(x - 250, y - 100) < 33
      const kept = alphaAt(x, y) > 127
      if (inSubject && kept) tp++
      else if (inSubject && !kept) fn++
      else if (!inSubject && kept) fp++
      else tn++
    }
  }
  return {
    farCorner: alphaAt(4, 4),
    nearSubject: alphaAt(250 - 60, 100),
    subjectCentre: alphaAt(250 + 18, 100 + 14),
    innerDot: alphaAt(250 - 12, 100 - 8),
    keptOfSubject: +(tp / (tp + fn)).toFixed(4),
    removedOfBackground: +(tn / (tn + fp)).toFixed(4),
  }
})
console.log('key probe:', JSON.stringify(probe))
check('flat background is removed', probe.farCorner === 0 && probe.nearSubject === 0)
check('the subject is kept', probe.subjectCentre === 255)
check('over 99% of the subject survives', probe.keptOfSubject > 0.99)
check('over 99% of the background goes', probe.removedOfBackground > 0.99)

// The connectivity rule is the interesting one: a background-coloured patch
// walled off inside the subject must survive by default, and vanish when the
// key is told to reach anywhere.
check('a matching colour inside the subject is kept (edge-reach)', probe.innerDot === 255)

const global = await page.evaluate(() => {
  const s = window.__pfState()
  const l = s.doc.layers[0]
  s.updateLayer(l.id, { bgRemove: { ...l.bgRemove, contiguous: false } })
  const st = window.__pfState()
  const c = document.createElement('canvas')
  c.width = st.doc.width
  c.height = st.doc.height
  const ctx = c.getContext('2d', { willReadFrequently: true })
  window.__pfRender.renderDocument(ctx, st.doc, 0)
  const d = ctx.getImageData(0, 0, c.width, c.height).data
  const alphaAt = (x, y) => d[((y * c.width + x) << 2) + 3]
  s.updateLayer(l.id, { bgRemove: { ...l.bgRemove, contiguous: true } })
  return { innerDot: alphaAt(250 - 12, 100 - 8), subject: alphaAt(250 + 18, 100 + 14) }
})
console.log('global-reach probe:', JSON.stringify(global))
check('the same colour is removed everywhere when reach is unrestricted',
  global.innerDot === 0 && global.subject === 255)

// Keying must follow the animation, frame by frame.
const overTime = await page.evaluate(() => {
  const s = window.__pfState()
  const c = document.createElement('canvas')
  c.width = s.doc.width
  c.height = s.doc.height
  const ctx = c.getContext('2d', { willReadFrequently: true })
  const out = []
  for (const f of [0, 6, 12, 18]) {
    const t = (f / 24) * s.duration
    const u = f / 24
    const ex = Math.round(160 + Math.cos(u * Math.PI * 2) * 90)
    const ey = Math.round(100 + Math.sin(u * Math.PI * 2) * 55)
    window.__pfRender.renderDocument(ctx, s.doc, t)
    const d = ctx.getImageData(0, 0, c.width, c.height).data
    out.push({
      f,
      atSubject: d[((ey * c.width + ex) << 2) + 3],
      atCorner: d[((4 * c.width + 4) << 2) + 3],
    })
  }
  return out
})
console.log('per-frame:', JSON.stringify(overTime))
check('every frame keys, following the moving subject',
  overTime.every((o) => o.atSubject === 255 && o.atCorner === 0))

// Cheap enough to scrub: keyed frames are memoised per bitmap.
const timing = await page.evaluate(() => {
  const s = window.__pfState()
  const c = document.createElement('canvas')
  c.width = s.doc.width
  c.height = s.doc.height
  const ctx = c.getContext('2d')
  const run = () => {
    const t0 = performance.now()
    for (let i = 0; i < 24; i++) {
      window.__pfRender.renderDocument(ctx, s.doc, (i / 24) * s.duration)
    }
    return performance.now() - t0
  }
  const cold = run()
  const warm = run()
  return { cold: +cold.toFixed(1), warm: +warm.toFixed(1) }
})
console.log('render 24 frames — cold:', timing.cold, 'ms  warm:', timing.warm, 'ms')
check('re-rendering keyed frames is cached, not recomputed', timing.warm < timing.cold)

// --- the harder background ---------------------------------------------------
// The other fixture sits on a checkerboard crossed by animated stripes. The
// question that matters is not "how much got removed" but "did the key eat the
// subject" — a background remover that destroys the foreground is broken, one
// that leaves clutter behind is merely limited.
await page.evaluate(() => window.__pfState().resetDoc())
await importAndPlace(page, 'public/test/motion.gif', { timeout: 10000 })
await page.waitForTimeout(600)
const busy = await page.evaluate(() => {
  const s = window.__pfState()
  const l = s.doc.layers[0]
  s.updateLayer(l.id, { bgRemove: { ...window.__pfMatte.defaultBgRemove(), on: true } })
  const st = window.__pfState()
  const c = document.createElement('canvas')
  c.width = st.doc.width
  c.height = st.doc.height
  const ctx = c.getContext('2d', { willReadFrequently: true })
  window.__pfRender.renderDocument(ctx, st.doc, 0)
  const d = ctx.getImageData(0, 0, c.width, c.height).data
  const alphaAt = (x, y) => d[((y * c.width + x) << 2) + 3]
  let removed = 0
  let subjectKept = 0
  let subjectTotal = 0
  for (let y = 0; y < c.height; y++) {
    for (let x = 0; x < c.width; x++) {
      if (alphaAt(x, y) < 128) removed++
      if (Math.hypot(x - 250, y - 100) < 30) {
        subjectTotal++
        if (alphaAt(x, y) > 127) subjectKept++
      }
    }
  }
  return {
    removedFraction: +(removed / (c.width * c.height)).toFixed(3),
    subjectKept: +(subjectKept / subjectTotal).toFixed(3),
  }
})
console.log('busy background:', JSON.stringify(busy))
check('the key does not eat the subject on a busy background', busy.subjectKept > 0.9)
await page.screenshot({ path: path.join(OUT, '03-busy.png') })

// --- the confetti regression -------------------------------------------------
// A near-monochrome, grainy scene where subject and background overlap in
// brightness. The first implementation let the flood pass through anything
// *partially* background, so it threaded through the subject and shredded it.
// The mask must now be coherent, and the panel must admit when it cannot key.
await page.evaluate(() => window.__pfState().resetDoc())
await importAndPlace(page, 'public/test/room.png', { timeout: 10000 })
await page.waitForTimeout(600)

const room = await page.evaluate(() => {
  const s = window.__pfState()
  const l = s.doc.layers[0]
  const at = (tolerance) => {
    const opts = { ...window.__pfMatte.defaultBgRemove(), on: true, tolerance }
    const bmp = window.__pfRender.sourceFor(l, 0)
    const r = window.__pfMatte.analyzeKey(bmp, opts)
    return { tolerance, removed: +r.removed.toFixed(3), frag: +r.fragmentation.toFixed(2),
      verdict: r.verdict, note: r.note }
  }
  return { def: at(34), tight: at(14) }
})
console.log('room @default:', JSON.stringify(room.def))
console.log('room @tight  :', JSON.stringify(room.tight))
check('the default key produces a coherent mask, not confetti', room.def.frag < 3)
check('a pathological tolerance is reported as speckled, not silently emitted',
  room.tight.frag > 6 && room.tight.verdict === 'bad' && /separable by colour/.test(room.tight.note))

// The green screen must not be mislabelled just because it removes most pixels.
await page.evaluate(() => window.__pfState().resetDoc())
await importAndPlace(page, 'public/test/greenscreen.gif', { timeout: 10000 })
await page.waitForTimeout(600)
const clean = await page.evaluate(() => {
  const s = window.__pfState()
  const opts = { ...window.__pfMatte.defaultBgRemove(), on: true }
  const bmp = window.__pfRender.sourceFor(s.doc.layers[0], 0)
  const r = window.__pfMatte.analyzeKey(bmp, opts)
  return { removed: +r.removed.toFixed(3), frag: +r.fragmentation.toFixed(2), verdict: r.verdict }
})
console.log('greenscreen report:', JSON.stringify(clean))
check('a good key is not flagged just for removing most of the frame',
  clean.verdict === 'ok' && clean.removed > 0.9)

// And the panel actually surfaces it, rather than the app looking fine.
await page.evaluate(() => {
  const s = window.__pfState()
  const l = s.doc.layers[0]
  s.select([l.id])
  s.updateLayer(l.id, { bgRemove: { ...window.__pfMatte.defaultBgRemove(), on: true } })
})
await page.waitForTimeout(600)
const shown = await page.locator('.inspector').innerText()
check('the panel reports how much is being removed', /Removing\s+\d+%/.test(shown))
await page.screenshot({ path: path.join(OUT, '04-report.png') })

console.log(errors.length ? 'CONSOLE ERRORS: ' + errors.slice(0, 10).join(' | ') : 'no console errors')
await browser.close()
process.exit(checks.some(([, ok]) => !ok) ? 1 : 0)
