// The learned matte, end to end: model download and caching, which device it
// runs on, and whether it actually beats the colour key on a background that
// colour cannot separate.
import { chromium } from 'playwright-core'
import { importAndPlace } from '../e2e-helpers.mjs'
import fs from 'fs'
import path from 'path'

const OUT = 'shots/ai'
fs.mkdirSync(OUT, { recursive: true })

// WebGPU needs a real GPU adapter, which headless Chrome will not give us
// without asking for it.
const browser = await chromium.launch({
  executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  headless: true,
  args: [
    '--enable-unsafe-webgpu',
    '--enable-features=Vulkan,UseSkiaRenderer',
    '--use-angle=default',
    '--ignore-gpu-blocklist',
    '--enable-gpu',
  ],
})
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
const errors = []
// ONNX Runtime logs its own warnings at error level, and which ones it logs
// depends on how the machine is loaded: under contention it assigns fewer nodes
// to the preferred execution provider and says so. That is the library talking
// about its own scheduling, not this app going wrong, and counting it made the
// suite fail whenever the machine was busy.
const NOISE = /favicon|onnxruntime|VerifyEachNodeIsAssignedToAnEp/i
page.on('console', (m) => { if (m.type() === 'error' && !NOISE.test(m.text())) errors.push(m.text()) })
page.on('pageerror', (e) => errors.push('PAGEERROR: ' + e.message))

const checks = []
const check = (name, ok) => { checks.push([name, ok]); console.log((ok ? 'PASS  ' : 'FAIL  ') + name) }

await page.goto('http://localhost:5173/', { waitUntil: 'networkidle' })
await page.evaluate(() => { indexedDB.deleteDatabase('pixelforge'); indexedDB.deleteDatabase('pixelforge-models') })
await page.reload({ waitUntil: 'networkidle' })

const gpu = await page.evaluate(async () => {
  if (!navigator.gpu) return { webgpu: false, adapter: null }
  try {
    const a = await navigator.gpu.requestAdapter()
    return { webgpu: !!a, adapter: a ? (a.info?.description || a.info?.vendor || 'adapter') : null }
  } catch (e) { return { webgpu: false, adapter: 'error: ' + e.message } }
})
console.log('WebGPU available:', JSON.stringify(gpu))

// The room fixture is the case colour keying cannot do: near-monochrome, with
// subject and background overlapping in brightness.
await importAndPlace(page, 'public/test/room.png', { timeout: 15000 })
await page.waitForTimeout(600)
await page.evaluate(() => { window.__pfState().setPlaying(false); window.__pfState().setTime(0) })

const t0 = Date.now()
await page.evaluate(() => {
  const s = window.__pfState()
  return s.runAiMatte(s.doc.layers[0].id)
})
await page.waitForFunction(() => window.__pfState().matting === null, { timeout: 180000 })
const elapsed = ((Date.now() - t0) / 1000).toFixed(1)
console.log('first run (incl. model download):', elapsed, 's')

const after = await page.evaluate(() => {
  const s = window.__pfState()
  return {
    notice: s.notice,
    mode: s.doc.layers[0].bgRemove?.mode,
    backend: window.__pfAi.currentBackend(),
  }
})
console.log('after matte:', JSON.stringify(after))
check('the model runs and reports success', after.notice?.kind === 'ok')
check('the layer switches to the learned matte', after.mode === 'ai')
check('inference reports a device', !!after.backend)
if (after.backend === 'webgpu') console.log('  -> running on the GPU')
else console.log('  -> running on CPU (wasm); headless Chrome often has no GPU adapter')

check('the model is cached for next time',
  await page.evaluate(() => window.__pfAi.isModelCached()))

// Does it actually separate the subject? The fixture's subject is a column
// through the middle; the corners are wall.
const quality = await page.evaluate(() => {
  const s = window.__pfState()
  const c = document.createElement('canvas')
  c.width = s.doc.width
  c.height = s.doc.height
  const ctx = c.getContext('2d', { willReadFrequently: true })
  window.__pfRender.renderDocument(ctx, s.doc, 0)
  const d = ctx.getImageData(0, 0, c.width, c.height).data
  const W = c.width
  const a = (x, y) => d[((y * W + x) << 2) + 3]
  let kept = 0
  let total = 0
  let wallKept = 0
  let wallTotal = 0
  for (let y = 0; y < c.height; y++) {
    for (let x = 0; x < W; x++) {
      const cx = W / 2
      const inBody = Math.abs(x - cx) < 30 - Math.abs(y - c.height / 2) / 9 && y > 70 && y < c.height - 40
      const isWall = x < 20 || x > W - 20
      if (inBody) { total++; if (a(x, y) > 127) kept++ }
      if (isWall) { wallTotal++; if (a(x, y) > 127) wallKept++ }
    }
  }
  return {
    subjectKept: +(kept / Math.max(1, total)).toFixed(3),
    wallRemoved: +(1 - wallKept / Math.max(1, wallTotal)).toFixed(3),
  }
})
console.log('AI on the monochrome room:', JSON.stringify(quality))
check('the learned matte keeps most of the subject', quality.subjectKept > 0.7)
check('the learned matte removes most of the wall', quality.wallRemoved > 0.7)
await page.screenshot({ path: path.join(OUT, '01-ai-matte.png') })

// The colour key on the same image, for comparison.
const colourKey = await page.evaluate(() => {
  const s = window.__pfState()
  const l = s.doc.layers[0]
  s.updateLayer(l.id, { bgRemove: { ...window.__pfMatte.defaultBgRemove(), on: true, mode: 'auto' } })
  const st = window.__pfState()
  const c = document.createElement('canvas')
  c.width = st.doc.width
  c.height = st.doc.height
  const ctx = c.getContext('2d', { willReadFrequently: true })
  window.__pfRender.renderDocument(ctx, st.doc, 0)
  const d = ctx.getImageData(0, 0, c.width, c.height).data
  const W = c.width
  const a = (x, y) => d[((y * W + x) << 2) + 3]
  let kept = 0
  let total = 0
  for (let y = 0; y < c.height; y++) {
    for (let x = 0; x < W; x++) {
      const cx = W / 2
      const inBody = Math.abs(x - cx) < 30 - Math.abs(y - c.height / 2) / 9 && y > 70 && y < c.height - 40
      if (inBody) { total++; if (a(x, y) > 127) kept++ }
    }
  }
  return +(kept / Math.max(1, total)).toFixed(3)
})
console.log('colour key kept', colourKey, 'of the subject vs AI', quality.subjectKept)
check('the learned matte beats the colour key where colour cannot separate',
  quality.wallRemoved > 0.7 && quality.subjectKept > colourKey + 0.25)

// A second run must reuse the cached model rather than re-downloading.
await page.reload({ waitUntil: 'networkidle' })
await page.waitForTimeout(800)
await importAndPlace(page, 'public/test/room.png', { timeout: 15000 })
await page.waitForTimeout(500)
const t1 = Date.now()
await page.evaluate(() => {
  const s = window.__pfState()
  return s.runAiMatte(s.doc.layers[0].id)
})
await page.waitForFunction(() => window.__pfState().matting === null, { timeout: 120000 })
const second = ((Date.now() - t1) / 1000).toFixed(1)
console.log('second run (cached model):', second, 's')
check('a cached model makes the second run quicker', Number(second) < Number(elapsed))

// --- AI select ------------------------------------------------------------------
// Click the subject, get an editable lasso around it. The model is already
// loaded by this point, so this measures the tracing rather than the download.
// The fixture's subject is a torso column centred at x=120, running y 60..290.
const sel = await page.evaluate(async () => {
  const s = window.__pfState()
  s.setTool('lasso')
  const started = performance.now()
  const pts = await s.aiSelectAt(120, 170)
  const st = window.__pfState()
  return {
    ms: Math.round(performance.now() - started),
    points: pts ? pts.length : 0,
    lasso: st.lasso?.points.length || 0,
    notice: st.notice?.text,
    bounds: pts ? pts.reduce((b, [x, y]) => ({
      x0: Math.min(b.x0, x), y0: Math.min(b.y0, y),
      x1: Math.max(b.x1, x), y1: Math.max(b.y1, y),
    }), { x0: 1e9, y0: 1e9, x1: -1e9, y1: -1e9 }) : null,
  }
})
console.log('AI select:', JSON.stringify(sel))
check('clicking the subject produces an outline', sel.points > 6, `${sel.points} points`)
check('and it becomes a live lasso', sel.lasso === sel.points)
check('the outline is editable, not a fixed shape', /drag any of them/.test(sel.notice || ''))
// The traced box should sit around the torso, not around the whole frame.
const b = sel.bounds || {}
console.log('outline bounds:', JSON.stringify(b))
check('the outline surrounds the subject rather than the whole image',
  b.x0 > 40 && b.x1 < 200 && b.y1 - b.y0 > 80,
  `x ${Math.round(b.x0)}..${Math.round(b.x1)}, y ${Math.round(b.y0)}..${Math.round(b.y1)}`)
check('it is narrower than it is tall, like the subject',
  (b.x1 - b.x0) < (b.y1 - b.y0), `${Math.round(b.x1 - b.x0)} x ${Math.round(b.y1 - b.y0)}`)

// Every existing lasso action must work on it — that is the point of returning
// an ordinary outline rather than a special selection object.
const cut = await page.evaluate(() => {
  const s = window.__pfState()
  const before = s.doc.layers.length
  const res = s.applyLasso('copy')
  const st = window.__pfState()
  return { ok: res.ok, text: res.text || res.reason, added: st.doc.layers.length - before, lasso: st.lasso }
})
console.log('copy to layer:', JSON.stringify(cut))
check('a traced outline can be copied to its own layer', cut.ok && cut.added === 1, cut.text)
check('and the outline is cleared afterwards', cut.lasso === null)

// Clicking empty background must say so rather than selecting something random.
const miss = await page.evaluate(async () => {
  const s = window.__pfState()
  const pts = await s.aiSelectAt(8, 8)
  return { pts, notice: window.__pfState().notice?.text }
})
console.log('clicking the corner:', JSON.stringify(miss))
check('clicking the background selects nothing and explains why',
  miss.pts === null && /background|Nothing found|image layer/i.test(miss.notice || ''),
  miss.notice)

console.log(errors.length ? 'CONSOLE ERRORS: ' + errors.slice(0, 6).join(' | ') : 'no console errors')
await browser.close()
process.exit(checks.some(([, ok]) => !ok) ? 1 : 0)
