// Proves a project actually round-trips: build a keyframed document, save the
// .pfz, reload the page into a clean state, reopen the file, and assert the
// rendered pixels are identical at every sampled time.
import { chromium } from 'playwright-core'
import { importAndPlace } from '../e2e-helpers.mjs'
import fs from 'fs'
import path from 'path'

const OUT = 'shots/project'
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

// A cheap content hash of the composited document at several playback times.
const SIGNATURE = () => {
  const s = window.__pfState()
  const { renderDocument } = window.__pfRender
  const c = document.createElement('canvas')
  c.width = s.doc.width
  c.height = s.doc.height
  const ctx = c.getContext('2d', { willReadFrequently: true })
  const dur = s.duration || 1000
  const out = []
  for (const f of [0, 0.2, 0.4, 0.6, 0.8]) {
    renderDocument(ctx, s.doc, dur * f)
    const d = ctx.getImageData(0, 0, c.width, c.height).data
    let h = 2166136261
    for (let i = 0; i < d.length; i += 17) { h ^= d[i]; h = Math.imul(h, 16777619) }
    out.push((h >>> 0).toString(16))
  }
  return out.join('-')
}

await page.goto('http://localhost:5173/', { waitUntil: 'networkidle' })
await page.evaluate(() => indexedDB.deleteDatabase('pixelforge'))
await page.reload({ waitUntil: 'networkidle' })

await importAndPlace(page, 'public/test/motion.gif', { timeout: 10000 })
await page.waitForTimeout(700)

// Build something worth saving: a keyframed pixelate overlay plus a text layer.
await page.evaluate(() => {
  const s = window.__pfState()
  const { makeEffectLayer, makeTextLayer } = window.__pfStore
  s.setPlaying(false)
  s.setTime(0)

  const fx = makeEffectLayer({
    name: 'Tracking blur', shape: 'ellipse', effect: 'pixelblur',
    x: 30, y: 40, w: 110, h: 90, pixelSize: 11, blurRadius: 4, feather: 6,
  })
  s.addLayer(fx)
  s.setAutoTrack(fx.id, true)
  s.setTime(900)
  s.setLayerAtTime(fx.id, { x: 190, y: 110, w: 70, h: 60, opacity: 0.55 })

  s.addLayer(makeTextLayer({ text: 'round trip', x: 20, y: 10, w: 260, size: 28, color: '#ffcc33' }))
  s.setProjectName('Round Trip')
  s.setTime(0)
})
await page.waitForTimeout(400)
await page.screenshot({ path: path.join(OUT, '01-before-save.png') })

const before = await page.evaluate(SIGNATURE)
const beforeState = await page.evaluate(() => {
  const s = window.__pfState()
  const fx = s.doc.layers.find((l) => l.type === 'effect')
  return {
    layers: s.doc.layers.length,
    w: s.doc.width, h: s.doc.height, duration: s.duration,
    tracks: Object.fromEntries(Object.entries(fx.tracks).map(([k, v]) => [k, v.length])),
    effect: fx.effect, pixelSize: fx.pixelSize, feather: fx.feather,
    name: s.projectName,
  }
})
console.log('before:', JSON.stringify(beforeState))
console.log('signature before:', before)

// Save now keeps the project in the browser; Export writes the file.
const dl = page.waitForEvent('download', { timeout: 30000 })
await page.click('header button.btn.primary')
await page.waitForTimeout(300)
await page.click('.segmented button:has-text("Project")')
await page.waitForTimeout(200)
await page.click('.modal-foot .btn.primary')
const download = await dl
const pfz = path.join(OUT, 'roundtrip.pfz')
await download.saveAs(pfz)
const size = fs.statSync(pfz).size
console.log('saved:', download.suggestedFilename(), size, 'bytes')
check('Export writes a .pfz file', /\.pfz$/.test(download.suggestedFilename()) && size > 1000)

// The archive must be a real zip carrying the untouched source media.
const zipBytes = fs.readFileSync(pfz)
check('project file is a real ZIP', zipBytes[0] === 0x50 && zipBytes[1] === 0x4b)
const srcGif = fs.readFileSync('public/test/motion.gif')
check('original GIF bytes are embedded verbatim', zipBytes.includes(srcGif.subarray(0, 512)))

const entries = await page.evaluate(async (b64) => {
  const bin = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))
  const { unzipSync, strFromU8 } = await import('/node_modules/fflate/esm/browser.js')
  const files = unzipSync(bin)
  return { names: Object.keys(files), meta: JSON.parse(strFromU8(files['project.json'])) }
}, zipBytes.toString('base64'))
console.log('zip entries:', JSON.stringify(entries.names))
check('archive contains project.json, media and a thumbnail',
  entries.names.includes('project.json') &&
  entries.names.some((n) => n.startsWith('assets/')) &&
  entries.names.includes('thumbnail.png'))
check('manifest records format and version',
  entries.meta.format === 'pixelforge-project' && entries.meta.version === 1)

// Reload into a completely clean session.
await page.evaluate(() => indexedDB.deleteDatabase('pixelforge'))
await page.reload({ waitUntil: 'networkidle' })
await page.waitForTimeout(500)
const emptyAfterReload = await page.evaluate(() => window.__pfState().doc.layers.length)
check('a reload really does lose everything without a project file', emptyAfterReload === 0)

// Reopen the saved project from disk.
await page.click('button[title^="Open a saved project"]')
await page.waitForTimeout(400)
await page.setInputFiles('.pf-project-input', pfz)
await page.waitForFunction(() => window.__pfState().doc.layers.length > 0, { timeout: 20000 })
await page.waitForTimeout(900)
await page.evaluate(() => { window.__pfState().setPlaying(false); window.__pfState().setTime(0) })
await page.screenshot({ path: path.join(OUT, '02-after-open.png') })

const afterState = await page.evaluate(() => {
  const s = window.__pfState()
  const fx = s.doc.layers.find((l) => l.type === 'effect')
  return {
    layers: s.doc.layers.length,
    w: s.doc.width, h: s.doc.height, duration: s.duration,
    tracks: Object.fromEntries(Object.entries(fx.tracks).map(([k, v]) => [k, v.length])),
    effect: fx.effect, pixelSize: fx.pixelSize, feather: fx.feather,
    name: s.projectName,
  }
})
const after = await page.evaluate(SIGNATURE)
console.log('after :', JSON.stringify(afterState))
console.log('signature after :', after)

check('layer count, canvas size and duration survive the round trip',
  afterState.layers === beforeState.layers && afterState.w === beforeState.w &&
  afterState.h === beforeState.h && afterState.duration === beforeState.duration)
check('keyframe tracks survive intact',
  JSON.stringify(afterState.tracks) === JSON.stringify(beforeState.tracks))
check('effect settings survive intact',
  afterState.effect === beforeState.effect && afterState.pixelSize === beforeState.pixelSize &&
  afterState.feather === beforeState.feather)
check('project name is restored', afterState.name === beforeState.name)
check('reopened document renders pixel-identically at every sampled time', after === before)

// Layers must still be live and editable, not flattened.
const editable = await page.evaluate(() => {
  const s = window.__pfState()
  const fx = s.doc.layers.find((l) => l.type === 'effect')
  s.setTime(450)
  const midX = window.__pfKeys.resolveLayer(fx, 450).x
  const tracksBefore = Object.keys(fx.tracks).length
  s.setLayerAtTime(fx.id, { pixelSize: 30 })
  // Re-read: the store hands back a new doc object after every mutation.
  const after = window.__pfState().doc.layers.find((l) => l.id === fx.id)
  return {
    midX,
    autoTrack: after.autoTrack === true,
    tracksBefore,
    tracksAfter: Object.keys(after.tracks).length,
    valueAtPlayhead: window.__pfKeys.resolveLayer(after, 450).pixelSize,
  }
})
console.log('post-open edit:', JSON.stringify(editable))
check('reopened overlay still tweens between its keys',
  editable.midX > 30 && editable.midX < 190)
check('auto-tracking state survives the round trip', editable.autoTrack)
check('reopened project is still editable, and still auto-tracks',
  editable.tracksAfter === editable.tracksBefore + 1 && editable.valueAtPlayhead === 30)

// --- autosave recovery ------------------------------------------------------
await page.waitForTimeout(1600) // let the debounced autosave land
await page.reload({ waitUntil: 'networkidle' })
await page.waitForTimeout(1200)
const banner = await page.locator('.recovery').count()
check('a reload offers to recover the autosaved session', banner === 1)
await page.screenshot({ path: path.join(OUT, '03-recovery.png') })

if (banner) {
  await page.click('.recovery .btn.primary')
  await page.waitForFunction(() => window.__pfState().doc.layers.length > 0, { timeout: 20000 })
  await page.waitForTimeout(600)
  const recovered = await page.evaluate(() => {
    const s = window.__pfState()
    const fx = s.doc.layers.find((l) => l.type === 'effect')
    return { layers: s.doc.layers.length, tracks: Object.keys(fx?.tracks || {}).length }
  })
  console.log('recovered:', JSON.stringify(recovered))
  check('recovered session restores layers and their keyframes',
    recovered.layers === beforeState.layers && recovered.tracks > 0)
}

console.log(errors.length ? '\nCONSOLE ERRORS:\n  ' + errors.slice(0, 10).join('\n  ') : '\nno console errors')
await browser.close()
process.exit(checks.some(([, ok]) => !ok) ? 1 : 0)
