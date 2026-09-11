// The magic eraser, without its model.
//
// The fixture is what the tool is for: a photograph — grain, a sky, a hill —
// with a caption burnt into it, white with a dark outline, running across both
// the sky and the edge of the hill. The same scene is drawn a second time with
// no caption, so the result is judged against what was really under the text
// rather than against whether it looks plausible.
//
// The model's address is blocked for the whole suite. That is the path this
// suite is about: every stroke has to come out right from the surrounding
// pixels alone, instantly, on a machine that has never downloaded anything —
// and has to say so rather than hang.
import { chromium } from 'playwright-core'
import fs from 'fs'

const OUT = 'shots/heal'
fs.mkdirSync(OUT, { recursive: true })

const browser = await chromium.launch({
  executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  headless: true,
})
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
const errors = []
// The blocked download reports itself as a failed resource; that is this suite
// doing its job, not the app going wrong.
const NOISE = /favicon|huggingface|ERR_FAILED|Failed to load resource/i
page.on('console', (m) => { if (m.type() === 'error' && !NOISE.test(m.text())) errors.push(m.text()) })
page.on('pageerror', (e) => errors.push('PAGEERROR: ' + e.message))
let modelAsked = 0
await page.route(/huggingface\.co|hf\.co|\.onnx/, (route) => { modelAsked++; return route.abort() })

const checks = []
const check = (name, ok, detail = '') => {
  checks.push([name, ok])
  console.log((ok ? 'PASS  ' : 'FAIL  ') + name + (detail ? '  — ' + detail : ''))
}

await page.goto('http://localhost:5173/', { waitUntil: 'networkidle' })
await page.evaluate(() => { indexedDB.deleteDatabase('pixelforge'); indexedDB.deleteDatabase('pixelforge-models') })
await page.reload({ waitUntil: 'networkidle' })

// The scene, drawn by one function with and without its caption, from the same
// seeded grain — so the two differ by the caption and nothing else.
await page.evaluate(() => {
  window.__scene = (withText) => {
    const c = document.createElement('canvas')
    c.width = 480
    c.height = 320
    const g = c.getContext('2d', { willReadFrequently: true })
    const sky = g.createLinearGradient(0, 0, 0, 320)
    sky.addColorStop(0, '#5b86c4')
    sky.addColorStop(1, '#c9d9ee')
    g.fillStyle = sky
    g.fillRect(0, 0, 480, 320)
    g.fillStyle = '#3f6b3a'
    g.beginPath()
    g.moveTo(0, 232)
    g.quadraticCurveTo(240, 150, 480, 240)
    g.lineTo(480, 320)
    g.lineTo(0, 320)
    g.fill()
    const img = g.getImageData(0, 0, 480, 320)
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
      g.strokeText('SALE 50% OFF', 110, 200)
      g.fillText('SALE 50% OFF', 110, 200)
    }
    return c
  }
})

const setup = await page.evaluate(async () => {
  const blob = await new Promise((r) => window.__scene(true).toBlob(r, 'image/png'))
  const a = await window.__pfAssets.loadImageFile(new File([blob], 'sale.png', { type: 'image/png' }))
  const st = window.__pfState()
  st.placeMedia([a.id], { resizeDocToFirst: true })
  await new Promise((r) => setTimeout(r, 400))
  st.setPlaying(false)
  st.setTime(0)
  st.setView({ fitRequest: Date.now() })
  await new Promise((r) => setTimeout(r, 500))
  const l = window.__pfState().doc.layers[0]
  return { id: l.id, doc: [window.__pfState().doc.width, window.__pfState().doc.height] }
})
check('the picture is placed full size', setup.doc.join() === '480,320', setup.doc.join())

/**
 * How far the rendered document is from the clean scene over a box: the mean
 * error, and how many pixels are off by enough to be visibly caption — the
 * leftovers a fill is actually judged by.
 */
const measure = (box, mirror = false) => page.evaluate(([b, m]) => {
  const st = window.__pfState()
  const c = document.createElement('canvas')
  c.width = st.doc.width
  c.height = st.doc.height
  const ctx = c.getContext('2d', { willReadFrequently: true })
  window.__pfRender.renderDocument(ctx, st.doc, 0)
  const got = ctx.getImageData(b.x, b.y, b.w, b.h).data
  const clean = window.__scene(false)
  const cc = document.createElement('canvas')
  cc.width = clean.width
  cc.height = clean.height
  const cx = cc.getContext('2d', { willReadFrequently: true })
  if (m) { cx.translate(clean.width, 0); cx.scale(-1, 1) }
  cx.drawImage(clean, 0, 0)
  const want = cx.getImageData(b.x, b.y, b.w, b.h).data
  let sum = 0
  let off = 0
  let ink = 0
  for (let i = 0; i < got.length; i += 4) {
    const e = (Math.abs(got[i] - want[i]) + Math.abs(got[i + 1] - want[i + 1]) + Math.abs(got[i + 2] - want[i + 2])) / 3
    sum += e
    if (e > 48) {
      off++
      // Wrong *and* the caption's white or its outline's near-black: a piece
      // of lettering left behind, as against a horizon put back a few pixels
      // out, which is wrong in the colours of the picture.
      const lum = (got[i] + got[i + 1] + got[i + 2]) / 3
      if (lum > 235 || lum < 45) ink++
    }
  }
  return { mean: +(sum / (b.w * b.h)).toFixed(2), off, ink, total: b.w * b.h }
}, [box, mirror])

const TEXT = { x: 104, y: 164, w: 290, h: 44 }
const before = await measure(TEXT)
console.log('the caption before:', JSON.stringify(before))
check('there is a caption to remove', before.off > 1500, `${before.off} pixels off`)

// --- the tool is in the rail and on its keys ------------------------------------
const keys = await page.evaluate(async () => {
  const press = (key) => window.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }))
  const st = window.__pfState
  st().setTool('hand')
  press('j')
  const j = st().tool
  st().setTool('hand')
  press('9')
  const nine = st().tool
  st().setTool('hand')
  press('0')
  const zero = st().tool
  const btn = [...document.querySelectorAll('.rail-tools .tool')].find((b) => /Magic eraser/.test(b.title))
  return { j, nine, zero, title: btn?.title || '' }
})
console.log('keys:', JSON.stringify(keys))
check('J arms the magic eraser', keys.j === 'heal', keys.j)
check('so does 9, its place in the rail', keys.nine === 'heal', keys.nine)
check('and the clone stamp moved along to 0', keys.zero === 'clone', keys.zero)
check('its button says both keys', /\(J or 9\)/.test(keys.title), keys.title)

// --- painting over the caption ----------------------------------------------------
await page.evaluate(async () => {
  const st = window.__pfState()
  st.setTool('heal')
  // A brush a little taller than the capitals, the way anybody would size it.
  st.setToolOptions({ heal: { size: 46 / 480 } })
  st.select([])
  await new Promise((r) => setTimeout(r, 200))
})
const panel = await page.evaluate(() => {
  const opts = document.querySelector('.rail-options')
  return {
    label: opts?.querySelector('.rail-opt-label')?.textContent || '',
    preview: !!opts?.querySelector('.brush-preview canvas'),
    sliders: opts?.querySelectorAll('input[type=range]').length || 0,
  }
})
check('the rail shows the tool with its brush', /Magic eraser/.test(panel.label) && panel.preview, JSON.stringify(panel))
check('and one slider, not a panel of them', panel.sliders === 1, String(panel.sliders))

const view = await page.evaluate(() => {
  const r = document.querySelector('.stage canvas').getBoundingClientRect()
  return { x: r.x, y: r.y, ...window.__pfState().view }
})
const scr = (x, y) => [view.x + view.panX + x * view.zoom, view.y + view.panY + y * view.zoom]

await page.mouse.move(...scr(100, 186))
const cursor = await page.evaluate(() => document.querySelector('.stage canvas').style.cursor)
check('the ring is the cursor, with no crosshair in it', cursor === 'none', cursor)

// Hiding the pointer is only half of that promise: the ring has to be drawn in
// its place, or there is no cursor at all. Read off the stage itself — the
// circle the ring should sit on, with the pointer there and then away.
const ringPixels = (sx, sy, r) => page.evaluate(async ([x, y, rr]) => {
  await new Promise((res) => requestAnimationFrame(() => requestAnimationFrame(res)))
  const c = document.querySelector('.stage canvas')
  const rect = c.getBoundingClientRect()
  const k = c.width / rect.width
  const g = c.getContext('2d', { willReadFrequently: true })
  const out = []
  for (let i = 0; i < 24; i++) {
    const a = (i / 24) * Math.PI * 2
    const px = Math.round((x - rect.x + rr * Math.cos(a)) * k)
    const py = Math.round((y - rect.y + rr * Math.sin(a)) * k)
    out.push([...g.getImageData(px, py, 1, 1).data.slice(0, 3)])
  }
  return out
}, [sx, sy, r])
const at = scr(100, 186)
const r = (46 / 2) * view.zoom
const withRing = await ringPixels(at[0], at[1], r)
await page.mouse.move(...scr(420, 60))
const without = await ringPixels(at[0], at[1], r)
const changed = withRing.filter((p, i) => Math.abs(p[0] - without[i][0]) + Math.abs(p[1] - without[i][1])
  + Math.abs(p[2] - without[i][2]) > 60).length
check('and the ring is drawn where the pointer is, so you can see where you are', changed >= 16,
  `${changed} of 24 points on the ring`)
await page.mouse.move(...scr(100, 186))
await page.mouse.down()
await page.mouse.move(...scr(250, 186), { steps: 12 })
const mid = await page.evaluate((id) => {
  const st = window.__pfState()
  return {
    live: st.healStroke?.pts?.length || 0,
    strokes: st.doc.layers.find((l) => l.id === id).heal?.strokes?.length || 0,
  }
}, setup.id)
await page.screenshot({ path: `${OUT}/painting.png` })
check('while painting, the stroke is a highlight', mid.live > 3, String(mid.live))
check('and nothing is filled until it is let go', mid.strokes === 0, String(mid.strokes))
await page.mouse.move(...scr(396, 186), { steps: 12 })
const t0 = Date.now()
await page.mouse.up()
const done = await page.evaluate((id) => {
  const st = window.__pfState()
  const l = st.doc.layers.find((x) => x.id === id)
  const k = l.heal?.strokes?.[0]
  return {
    strokes: l.heal?.strokes?.length || 0,
    live: !!st.healStroke,
    by: k?.patch?.by,
    mode: k?.patch?.mode,
    size: k?.size,
    first: k?.pts?.[0],
    png: (k?.patch?.png || '').slice(0, 22),
  }
}, setup.id)
console.log('let go:', JSON.stringify(done), `${Date.now() - t0}ms`)
check('letting go makes one stroke', done.strokes === 1 && !done.live, JSON.stringify(done))
check('filled at once from the surrounding pixels', done.by === 'quick', done.by)
check('and the fill is kept with it, as a picture', done.png.startsWith('data:image/png'), done.png)
check('narrowed to the letters rather than the whole band', done.mode === 'hug', done.mode)
// Stored in the picture's frame: 100/480 across and 186/320 down.
check('the stroke is stored against the picture, not the box',
  Math.abs(done.first[0] - 100 / 480) < 0.01 && Math.abs(done.first[1] - 186 / 320) < 0.01
    && Math.abs(done.size - 46 / 480) < 0.002, JSON.stringify([done.first, done.size]))

const quick = await measure(TEXT)
console.log('the caption at once:', JSON.stringify(quick))
check('the caption is gone the moment it is let go', quick.ink < before.ink * 0.02,
  `${before.ink} -> ${quick.ink} pixels of lettering`)

// With no model to be had, the quick fill is followed by one made of pieces of
// the picture — which is the one the rest of this suite judges.
await page.waitForFunction((id) => window.__pfState().doc.layers.find((l) => l.id === id)
  .heal?.strokes?.[0]?.patch?.by === 'match', setup.id, { timeout: 30000 }).catch(() => {})
const by = await page.evaluate((id) => window.__pfState().doc.layers.find((l) => l.id === id)
  .heal?.strokes?.[0]?.patch?.by, setup.id)
check('then rebuilt from pieces of the picture, with no model to ask', by === 'match', by)
const after = await measure(TEXT)
console.log('the caption after:', JSON.stringify(after))
await page.screenshot({ path: `${OUT}/removed.png` })
check('the caption is gone, not a fleck of it left', after.ink <= 10, `${before.ink} -> ${after.ink} pixels of lettering`)
// The hard part of this fixture, on purpose: the horizon runs *under* the
// caption for most of its length, and nothing but a model can know exactly
// where a curve went beneath three hundred pixels of letters. So the bar here
// is "much better than smoothing", and the model's suite holds the finer one.
check('and what replaced it is close to what was really there',
  after.mean < 9 && after.off < quick.off * 0.75, `mean ${after.mean}, ${quick.off} -> ${after.off} off`)

// Nowhere else is touched: the sky well above, the hill well below.
const sky = await measure({ x: 0, y: 0, w: 480, h: 140 })
const hill = await measure({ x: 0, y: 250, w: 480, h: 70 })
check('the rest of the picture is exactly as it was', sky.mean === 0 && hill.mean === 0,
  `${sky.mean} / ${hill.mean}`)

// --- no model: said, not hung ------------------------------------------------------
await page.waitForFunction(() => window.__pfState().healAi === false, null, { timeout: 15000 }).catch(() => {})
const offline = await page.evaluate(() => ({
  ai: window.__pfState().healAi,
  work: window.__pfState().healWork,
  hint: document.querySelector('.rail-options .rail-hint')?.textContent || '',
}))
console.log('without the model:', JSON.stringify(offline), 'requests:', modelAsked)
check('it tried for the model', modelAsked > 0, String(modelAsked))
check('and, not getting it, keeps the quick fill and stops waiting', offline.ai === false && !offline.work)
check('the rail says where the fill came from', /surrounding picture/.test(offline.hint), offline.hint)

// --- the inspector --------------------------------------------------------------------
const insp = await page.evaluate(async (id) => {
  window.__pfState().select([id])
  await new Promise((r) => setTimeout(r, 300))
  const sec = [...document.querySelectorAll('.inspector .section')]
    .find((n) => /Magic erased/.test(n.querySelector('.section-title')?.textContent || ''))
  return sec ? sec.textContent.replace(/\s+/g, ' ') : ''
}, setup.id)
check('the layer lists what was removed', /Strokes\s*1/.test(insp) && /surrounding picture/.test(insp), insp.slice(0, 120))

// --- undo and redo ------------------------------------------------------------------
await page.evaluate(() => window.__pfState().undo())
await page.waitForTimeout(200)
const undone = await measure(TEXT)
check('one undo brings the caption back', undone.off > before.off * 0.9, `${undone.off} pixels off`)
await page.evaluate(() => window.__pfState().redo())
await page.waitForTimeout(200)
const redone = await measure(TEXT)
check('and redo takes it away again, fill and all', redone.off === after.off, `${redone.off} vs ${after.off}`)

// --- it belongs to the picture ------------------------------------------------------
// Flip the layer: the repair has to go with the picture, not stay where the
// brush was on the canvas.
await page.evaluate((id) => window.__pfState().updateLayer(id, { flipX: true }), setup.id)
await page.waitForTimeout(200)
const mirrored = await measure({ x: 480 - TEXT.x - TEXT.w, y: TEXT.y, w: TEXT.w, h: TEXT.h }, true)
check('flipped, the fill flips with the picture',
  mirrored.ink <= 10 && Math.abs(mirrored.off - after.off) <= after.off * 0.05 + 5, JSON.stringify(mirrored))
await page.evaluate((id) => window.__pfState().updateLayer(id, { flipX: false }), setup.id)

// Crop the left of it away and move it: still gone, from the same place in the
// picture, with nothing rebased.
const cropped = await page.evaluate(async (id) => {
  const st = window.__pfState()
  st.updateLayer(id, { cropL: 0.3 })
  await new Promise((r) => setTimeout(r, 200))
  const l = window.__pfState().doc.layers.find((x) => x.id === id)
  const c = document.createElement('canvas')
  c.width = 480
  c.height = 320
  const ctx = c.getContext('2d', { willReadFrequently: true })
  window.__pfRender.renderDocument(ctx, window.__pfState().doc, 0)
  const got = ctx.getImageData(200, 164, 190, 44).data
  const clean = window.__scene(false).getContext('2d').getImageData(200, 164, 190, 44).data
  let ink = 0
  for (let i = 0; i < got.length; i += 4) {
    const e = (Math.abs(got[i] - clean[i]) + Math.abs(got[i + 1] - clean[i + 1]) + Math.abs(got[i + 2] - clean[i + 2])) / 3
    const lum = (got[i] + got[i + 1] + got[i + 2]) / 3
    if (e > 48 && (lum > 235 || lum < 45)) ink++
  }
  window.__pfState().updateLayer(id, { cropL: 0 })
  return { ink, strokeStill: l.heal.strokes[0].pts[0][0] }
}, setup.id)
check('cropped, the fill stays in place and nothing was rebased',
  cropped.ink <= 10 && Math.abs(cropped.strokeStill - 100 / 480) < 0.01, JSON.stringify(cropped))

// --- a lasso can remove too --------------------------------------------------------
const lassoed = await page.evaluate(async (id) => {
  // A blot in a clean bit of sky, on a second picture of the same scene.
  const c = window.__scene(false)
  const g = c.getContext('2d')
  g.fillStyle = '#ff2a2a'
  g.fillRect(40, 40, 30, 30)
  const blob = await new Promise((r) => c.toBlob(r, 'image/png'))
  const a = await window.__pfAssets.loadImageFile(new File([blob], 'blot.png', { type: 'image/png' }))
  const st = window.__pfState()
  st.placeMedia([a.id])
  await new Promise((r) => setTimeout(r, 400))
  const top = window.__pfState().doc.layers[window.__pfState().doc.layers.length - 1]
  window.__pfState().updateLayer(top.id, { x: 0, y: 0, w: 480, h: 320 })
  window.__pfState().select([top.id])
  window.__pfState().setTool('lasso')
  window.__pfState().setLasso({ points: [[32, 32], [78, 32], [78, 78], [32, 78]] })
  await new Promise((r) => setTimeout(r, 300))
  const labels = [...document.querySelectorAll('.lasso-bar button')].map((b) => b.textContent)
  const res = window.__pfState().applyLasso('remove')
  await new Promise((r) => setTimeout(r, 300))
  const l = window.__pfState().doc.layers.find((x) => x.id === top.id)
  const cv = document.createElement('canvas')
  cv.width = 480
  cv.height = 320
  const ctx = cv.getContext('2d', { willReadFrequently: true })
  window.__pfRender.renderDocument(ctx, window.__pfState().doc, 0)
  const d = ctx.getImageData(40, 40, 30, 30).data
  let red = 0
  for (let i = 0; i < d.length; i += 4) if (d[i] > 200 && d[i + 1] < 90) red++
  window.__pfState().removeLayers([top.id])
  return { labels, res, kind: l.heal?.strokes?.[0]?.kind, red, lasso: !!window.__pfState().lasso }
}, setup.id)
console.log('lasso remove:', JSON.stringify(lassoed))
check('a closed lasso over a picture offers Remove', lassoed.labels.includes('Remove'), lassoed.labels.join(','))
check('and removing fills the outline in', lassoed.res.ok && lassoed.kind === 'region' && lassoed.red === 0,
  JSON.stringify(lassoed))

// --- what it will not do -------------------------------------------------------------
const refusals = await page.evaluate(async () => {
  const S = window.__pfStore
  const st = window.__pfState()
  const t = S.makeTextLayer({ x: 20, y: 20, text: 'WORDS', size: 40 })
  st.addLayer(t)
  const onText = window.__pfState().beginHeal(t.id, [40, 40])
  const noteText = window.__pfState().notice?.text || ''
  window.__pfState().removeLayers([t.id])
  return { onText, noteText }
})
check('a text layer is not something to heal, and it says why',
  refusals.onText === false && /delete it/.test(refusals.noteText), refusals.noteText)

// --- a saved project opens with the fills in, without the model ----------------------
const bytes = await page.evaluate(async () => {
  const st = window.__pfState()
  const packed = await window.__pfProject.packProject(st.doc, { time: 0, name: 'heal' })
  const b = packed instanceof Blob ? new Uint8Array(await packed.arrayBuffer()) : packed
  return Array.from(b)
})
await page.reload({ waitUntil: 'networkidle' })
await page.evaluate(() => {
  window.__scene = null
})
await page.evaluate(async (arr) => {
  const file = new File([new Uint8Array(arr)], 'heal.pfz')
  await window.__pfState().openProject(file)
}, bytes)
// The scene helper went with the reload; put it back to measure against.
await page.evaluate(() => {
  window.__scene = (withText) => {
    const c = document.createElement('canvas')
    c.width = 480
    c.height = 320
    const g = c.getContext('2d', { willReadFrequently: true })
    const sky = g.createLinearGradient(0, 0, 0, 320)
    sky.addColorStop(0, '#5b86c4')
    sky.addColorStop(1, '#c9d9ee')
    g.fillStyle = sky
    g.fillRect(0, 0, 480, 320)
    g.fillStyle = '#3f6b3a'
    g.beginPath()
    g.moveTo(0, 232)
    g.quadraticCurveTo(240, 150, 480, 240)
    g.lineTo(480, 320)
    g.lineTo(0, 320)
    g.fill()
    const img = g.getImageData(0, 0, 480, 320)
    let s = 12345
    const r = () => ((s = (Math.imul(s, 1103515245) + 12345) >>> 0) / 4294967296)
    for (let i = 0; i < img.data.length; i += 4) {
      const n = (r() - 0.5) * 14
      img.data[i] += n
      img.data[i + 1] += n
      img.data[i + 2] += n
    }
    g.putImageData(img, 0, 0)
    return c
  }
})
// Straight away, with no waiting for anything: an export made the moment a
// project opens has to be as clean as the one made before it was saved.
const reopened = await measure(TEXT)
console.log('reopened:', JSON.stringify(reopened))
check('a saved project opens with the caption still gone', reopened.off === after.off,
  `${reopened.off} vs ${after.off}`)

await page.screenshot({ path: `${OUT}/reopened.png` })
if (errors.length) console.log('errors:', errors)
check('no errors on the page', errors.length === 0, errors.slice(0, 3).join(' | '))

await browser.close()
const failed = checks.filter(([, ok]) => !ok)
console.log(`\n${checks.length - failed.length}/${checks.length} passed`)
process.exit(failed.length ? 1 : 0)
