// The magic eraser with its model.
//
// The same captioned photograph as the model-less suite, the same stroke —
// and this time the model is there. The weights are served from a copy on
// disk in place of the network, so the suite downloads them at most once per
// machine and never depends on a server being up.
//
// Three things are being found out. That the mask is read the right way round
// (the wrong way, the model repaints everything *but* the hole and every letter
// survives). That the model's fill beats the one made without it on the case
// that one cannot do — a horizon running under the whole caption. And that a
// caption too long for one crop is filled in lengths without leaving any of it.
import { chromium } from 'playwright-core'
import fs from 'fs'

const OUT = 'shots/healai'
fs.mkdirSync(OUT, { recursive: true })
const MODEL = 'shots/models/migan_pipeline_v2.onnx'
const URL = 'https://huggingface.co/andraniksargsyan/migan/resolve/main/migan_pipeline_v2.onnx'
if (!fs.existsSync(MODEL)) {
  fs.mkdirSync('shots/models', { recursive: true })
  const r = await fetch(URL)
  if (!r.ok) { console.log('FAIL  could not fetch the model for the suite: HTTP ' + r.status); process.exit(1) }
  fs.writeFileSync(MODEL, Buffer.from(await r.arrayBuffer()))
}
const weights = fs.readFileSync(MODEL)

const browser = await chromium.launch({
  executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  headless: true,
  args: ['--enable-unsafe-webgpu', '--ignore-gpu-blocklist', '--enable-gpu'],
})
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
const errors = []
const NOISE = /favicon|onnxruntime|VerifyEachNodeIsAssignedToAnEp/i
page.on('console', (m) => { if (m.type() === 'error' && !NOISE.test(m.text())) errors.push(m.text()) })
page.on('pageerror', (e) => errors.push('PAGEERROR: ' + e.message))
let served = 0
await page.route(/andraniksargsyan\/migan/, (route) => {
  served++
  return route.fulfill({
    status: 200,
    body: weights,
    headers: { 'content-type': 'application/octet-stream', 'content-length': String(weights.length) },
  })
})

const checks = []
const check = (name, ok, detail = '') => {
  checks.push([name, ok])
  console.log((ok ? 'PASS  ' : 'FAIL  ') + name + (detail ? '  — ' + detail : ''))
}

await page.goto('http://localhost:5173/', { waitUntil: 'networkidle' })
await page.evaluate(() => { indexedDB.deleteDatabase('pixelforge'); indexedDB.deleteDatabase('pixelforge-models') })
await page.reload({ waitUntil: 'networkidle' })

await page.evaluate(() => {
  window.__scene = (withText, { w = 480, h = 320, text = 'SALE 50% OFF', x = 110, y = 200 } = {}) => {
    const c = document.createElement('canvas')
    c.width = w
    c.height = h
    const g = c.getContext('2d', { willReadFrequently: true })
    const sky = g.createLinearGradient(0, 0, 0, h)
    sky.addColorStop(0, '#5b86c4')
    sky.addColorStop(1, '#c9d9ee')
    g.fillStyle = sky
    g.fillRect(0, 0, w, h)
    g.fillStyle = '#3f6b3a'
    g.beginPath()
    g.moveTo(0, h * 0.725)
    g.quadraticCurveTo(w / 2, h * 0.47, w, h * 0.75)
    g.lineTo(w, h)
    g.lineTo(0, h)
    g.fill()
    const img = g.getImageData(0, 0, w, h)
    let s = 12345
    const r = () => ((s = (Math.imul(s, 1103515245) + 12345) >>> 0) / 4294967296)
    for (let i = 0; i < img.data.length; i += 4) {
      const n = (r() - 0.5) * 14
      img.data[i] += n
      img.data[i + 1] += n
      img.data[i + 2] += n
    }
    g.putImageData(img, 0, 0)
    if (withText) {
      g.font = 'bold 40px Arial'
      g.lineWidth = 3
      g.strokeStyle = '#111111'
      g.fillStyle = '#ffffff'
      g.strokeText(text, x, y)
      g.fillText(text, x, y)
    }
    return c
  }

  /** Error against the clean scene over a box, and pixels still lettering. */
  window.__score = (canvas, clean, b) => {
    const got = canvas.getContext('2d', { willReadFrequently: true }).getImageData(b.x, b.y, b.w, b.h).data
    const want = clean.getContext('2d', { willReadFrequently: true }).getImageData(b.x, b.y, b.w, b.h).data
    let sum = 0
    let off = 0
    let ink = 0
    for (let i = 0; i < got.length; i += 4) {
      const e = (Math.abs(got[i] - want[i]) + Math.abs(got[i + 1] - want[i + 1]) + Math.abs(got[i + 2] - want[i + 2])) / 3
      sum += e
      if (e > 48) {
        off++
        const lum = (got[i] + got[i + 1] + got[i + 2]) / 3
        if (lum > 235 || lum < 45) ink++
      }
    }
    return { mean: +(sum / (b.w * b.h)).toFixed(2), off, ink }
  }

  window.__place = async (canvas, name) => {
    const blob = await new Promise((r) => canvas.toBlob(r, 'image/png'))
    const a = await window.__pfAssets.loadImageFile(new File([blob], name, { type: 'image/png' }))
    const st = window.__pfState()
    st.resetDoc?.()
    window.__pfState().placeMedia([a.id], { resizeDocToFirst: true })
    await new Promise((r) => setTimeout(r, 400))
    window.__pfState().setPlaying(false)
    window.__pfState().setTime(0)
    return window.__pfState().doc.layers[window.__pfState().doc.layers.length - 1].id
  }

  window.__render = () => {
    const st = window.__pfState()
    const c = document.createElement('canvas')
    c.width = st.doc.width
    c.height = st.doc.height
    window.__pfRender.renderDocument(c.getContext('2d'), st.doc, 0)
    return c
  }
})

// --- the caption over the horizon ---------------------------------------------------
const TEXT = { x: 104, y: 164, w: 290, h: 44 }
const run = await page.evaluate(async (box) => {
  const id = await window.__place(window.__scene(true), 'sale.png')
  const clean = window.__scene(false)
  const before = window.__score(window.__render(), clean, box)

  // The same stroke the model-less suite paints, through the same calls.
  const st = window.__pfState()
  st.setToolOptions({ heal: { size: 46 / 480 } })
  st.beginHeal(id, [100, 186])
  for (let x = 110; x <= 396; x += 6) window.__pfState().extendHeal([x, 186])
  window.__pfState().endHeal()
  const quick = window.__score(window.__render(), clean, box)

  // What the fill without the model makes of the same stroke, for comparison.
  const layer = window.__pfState().doc.layers.find((l) => l.id === id)
  const stroke = layer.heal.strokes[0]
  const raw = window.__pfRender.sourceFor(layer, 0)
  const patch = await window.__pfHeal.matchFill(raw, stroke)
  const img = new Image()
  img.src = patch.png
  await img.decode()
  const matched = window.__scene(true)
  matched.getContext('2d').drawImage(img, patch.x, patch.y)
  const match = window.__score(matched, clean, box)

  const t0 = performance.now()
  for (let i = 0; i < 1200; i++) {
    const k = window.__pfState().doc.layers.find((l) => l.id === id).heal.strokes[0]
    if (k.patch.by === 'ai' || window.__pfState().healAi === false) break
    await new Promise((r) => setTimeout(r, 150))
  }
  const seconds = +((performance.now() - t0) / 1000).toFixed(1)
  const k = window.__pfState().doc.layers.find((l) => l.id === id).heal.strokes[0]
  await new Promise((r) => setTimeout(r, 300))
  const ai = window.__score(window.__render(), clean, box)
  const outside = window.__score(window.__render(), clean, { x: 0, y: 0, w: 480, h: 140 })

  // Before, fill without the model, fill with it: one strip to look at.
  const strip = document.createElement('canvas')
  strip.width = 480
  strip.height = 320 * 3
  const sg = strip.getContext('2d')
  sg.drawImage(window.__scene(true), 0, 0)
  sg.drawImage(matched, 0, 320)
  sg.drawImage(window.__render(), 0, 640)
  return {
    before, quick, match, ai, outside, seconds,
    by: k.patch.by,
    healAi: window.__pfState().healAi,
    work: window.__pfState().healWork,
    backend: window.__pfInpaint.inpaintBackend(),
    strip: strip.toDataURL('image/png'),
  }
}, TEXT)
fs.writeFileSync(`${OUT}/compare.png`, Buffer.from(run.strip.split(',')[1], 'base64'))
delete run.strip
console.log('with the model:', JSON.stringify(run))

check('the model was fetched, once', served === 1, String(served))
check('and the stroke was filled by it', run.by === 'ai' && run.healAi === true, `${run.by} after ${run.seconds}s`)
check('it says which device it ran on', !!run.backend, String(run.backend))
check('the rail is no longer busy once it is done', run.work === null)
// The mask the right way round: read backwards, the hole is the one place the
// model leaves alone, and the caption is still there.
check('the caption is gone — the mask was read the right way round', run.ai.ink <= 10,
  `${run.before.ink} -> ${run.ai.ink} pixels of lettering`)
check('nothing outside the stroke was touched', run.outside.mean === 0, String(run.outside.mean))
check('and the model puts the horizon back better than pieces of the picture can',
  run.ai.off < run.match.off && run.ai.mean <= run.match.mean,
  `model ${run.ai.off} off / mean ${run.ai.mean}, pieces ${run.match.off} / ${run.match.mean}`)

// --- a caption too long for one crop ---------------------------------------------------
const long = await page.evaluate(async () => {
  const opts = { w: 1600, h: 420, text: 'THE LONGEST SUMMER SALE OF THE YEAR', x: 90, y: 262 }
  const id = await window.__place(window.__scene(true, opts), 'long.png')
  const clean = window.__scene(false, opts)
  const box = { x: 80, y: 222, w: 1440, h: 52 }
  const before = window.__score(window.__render(), clean, box)
  const st = window.__pfState()
  st.setToolOptions({ heal: { size: 50 / 1600 } })
  st.beginHeal(id, [80, 248])
  for (let x = 90; x <= 1500; x += 8) window.__pfState().extendHeal([x, 248])
  window.__pfState().endHeal()
  const t0 = performance.now()
  for (let i = 0; i < 1600; i++) {
    const k = window.__pfState().doc.layers.find((l) => l.id === id).heal.strokes[0]
    if (k.patch.by === 'ai') break
    await new Promise((r) => setTimeout(r, 150))
  }
  const seconds = +((performance.now() - t0) / 1000).toFixed(1)
  const k = window.__pfState().doc.layers.find((l) => l.id === id).heal.strokes[0]
  const after = window.__score(window.__render(), clean, box)
  const stroke = k
  const aw = 1600
  // How many crops the plan cut it into, for the record.
  const H = window.__pfHealMath
  return { before, after, seconds, by: k.patch.by, width: stroke.patch.w, aw }
})
console.log('a long caption:', JSON.stringify(long))
check('a caption longer than one crop is filled by the model too', long.by === 'ai', `${long.by} after ${long.seconds}s`)
check('in lengths, with none of it left behind', long.after.ink <= 20,
  `${long.before.ink} -> ${long.after.ink} pixels of lettering`)

if (errors.length) console.log('errors:', errors)
check('no errors on the page', errors.length === 0, errors.slice(0, 3).join(' | '))
await browser.close()
const failed = checks.filter(([, ok]) => !ok)
console.log(`\n${checks.length - failed.length}/${checks.length} passed`)
process.exit(failed.length ? 1 : 0)
