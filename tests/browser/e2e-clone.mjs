// The clone stamp.
//
// The thing it exists for is removing a mark — a watermark, a blemish — by
// copying a clean piece of the picture over it. So the fixture is exactly that:
// a flat field with a bright blot in it, and the test is whether the blot can be
// made to go away while everything else stays where it was.
import { chromium } from 'playwright-core'
import fs from 'fs'
import path from 'path'

const OUT = 'shots/clone'
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

const setup = await page.evaluate(async () => {
  const c = document.createElement('canvas')
  c.width = 200
  c.height = 200
  const x = c.getContext('2d')
  x.fillStyle = '#2c6e49'
  x.fillRect(0, 0, 200, 200)
  // The blot to be removed, well away from the clean area it will be copied from.
  x.fillStyle = '#ffdd00'
  x.fillRect(140, 140, 40, 40)
  const blob = await new Promise((r) => c.toBlob(r, 'image/png'))
  const a = await window.__pfAssets.loadImageFile(
    new File([blob], 'blot.png', { type: 'image/png' }))
  const st = window.__pfState()
  st.placeMedia([a.id], { resizeDocToFirst: true })
  await new Promise((r) => setTimeout(r, 400))
  st.setPlaying(false)
  const l = window.__pfState().doc.layers[0]
  return { id: l.id, x: l.x, y: l.y, w: l.w, h: l.h }
})

/** How much of a document region is the blot's yellow. */
const blotPixels = (box) => page.evaluate((b) => {
  const st = window.__pfState()
  const c = document.createElement('canvas')
  c.width = st.doc.width
  c.height = st.doc.height
  const ctx = c.getContext('2d', { willReadFrequently: true })
  window.__pfRender.renderDocument(ctx, st.doc, 0)
  const d = ctx.getImageData(b.x, b.y, b.w, b.h).data
  let yellow = 0
  let green = 0
  for (let i = 0; i < d.length; i += 4) {
    if (d[i] > 200 && d[i + 1] > 180 && d[i + 2] < 90) yellow++
    else if (d[i] < 90 && d[i + 1] > 80 && d[i + 2] < 120) green++
  }
  return { yellow, green, total: b.w * b.h }
}, box)

const blotBox = { x: 140, y: 140, w: 40, h: 40 }
const before = await blotPixels(blotBox)
console.log('the blot before:', JSON.stringify(before))
check('there is a mark to remove', before.yellow > 1400, `${before.yellow} yellow pixels`)

// --- it refuses politely before a source is set --------------------------------------
const noSource = await page.evaluate((s) => {
  const st = window.__pfState()
  const started = st.beginClone(s.id, [s.x + 160, s.y + 160])
  return { started, notice: window.__pfState().notice?.text || '' }
}, setup)
console.log('with no source:', JSON.stringify(noSource))
check('painting before a source is set does nothing', noSource.started === null)
check('and says what to do', /alt-click/i.test(noSource.notice), noSource.notice)

// --- cloning clean field over the blot -------------------------------------------------
const painted = await page.evaluate((s) => {
  const st = window.__pfState()
  // Copy from a clean patch 100px up and to the left of the blot.
  st.setCloneSource([s.x + 60, s.y + 60])
  st.beginClone(s.id, [s.x + 150, s.y + 150], { size: 0.22, hardness: 1 })
  // Paint across the whole blot.
  for (let i = 0; i <= 14; i++) {
    for (let j = 0; j <= 3; j++) {
      window.__pfState().extendClone(s.id, [s.x + 142 + i * 2.6, s.y + 144 + j * 11])
    }
  }
  window.__pfState().endClone()
  const l = window.__pfState().doc.layers.find((x) => x.id === s.id)
  return {
    strokes: l.clone?.strokes?.length || 0,
    points: l.clone?.strokes?.[0]?.pts?.length || 0,
    offset: l.clone?.strokes?.[0] ? [
      +l.clone.strokes[0].ox.toFixed(3), +l.clone.strokes[0].oy.toFixed(3),
    ] : null,
  }
}, setup)
console.log('after painting:', JSON.stringify(painted))
check('a stroke is recorded', painted.strokes === 1 && painted.points > 20,
  `${painted.strokes} stroke, ${painted.points} points`)
// Source 90px up and left of where the brush started, over a 200px layer.
check('with the offset from source to brush, held for the stroke',
  Math.abs(painted.offset[0] + 0.45) < 0.02 && Math.abs(painted.offset[1] + 0.45) < 0.02,
  JSON.stringify(painted.offset))

const after = await blotPixels(blotBox)
console.log('the blot after:', JSON.stringify(after))
check('the mark is gone', after.yellow < before.yellow * 0.08,
  `${before.yellow} -> ${after.yellow} yellow pixels`)
check('and clean picture is there instead', after.green > after.total * 0.85,
  `${after.green} of ${after.total} now field`)
await page.screenshot({ path: path.join(OUT, '01-clone.png') })

// --- the rest of the picture is untouched ------------------------------------------------
const elsewhere = await blotPixels({ x: 10, y: 10, w: 60, h: 60 })
check('nothing happened anywhere else',
  elsewhere.green > elsewhere.total * 0.95 && elsewhere.yellow === 0,
  JSON.stringify(elsewhere))

// --- non-destructive, like everything else ------------------------------------------------
const undone = await page.evaluate(() => {
  window.__pfState().undo()
  const l = window.__pfState().doc.layers[0]
  return { strokes: l.clone?.strokes?.length || 0 }
})
await page.waitForTimeout(200)
const restored = await blotPixels(blotBox)
console.log('after undo:', JSON.stringify(undone), JSON.stringify(restored))
// One drag is one undo: history is pushed when the stroke begins, not per point.
check('one undo takes the whole stroke back', undone.strokes === 0)
check('and the mark returns', restored.yellow > before.yellow * 0.9,
  `${restored.yellow} against ${before.yellow}`)

// --- it scales with the layer rather than being baked in -----------------------------------
const scaled = await page.evaluate((s) => {
  const st = window.__pfState()
  st.redo()
  const l = st.doc.layers.find((x) => x.id === s.id)
  // Half the size: strokes are fractions of the layer, so the repair must come
  // with it rather than staying at its old pixel positions.
  st.updateLayer(s.id, { w: l.w / 2, h: l.h / 2 })
  return { w: window.__pfState().doc.layers.find((x) => x.id === s.id).w }
}, setup)
await page.waitForTimeout(200)
const half = await blotPixels({ x: 70, y: 70, w: 20, h: 20 })
console.log('at half size:', JSON.stringify(scaled), JSON.stringify(half))
check('the repair scales with the layer', half.yellow < 30,
  `${half.yellow} yellow pixels where the blot would be`)

// --- the tool is in the rail --------------------------------------------------------------
const ui = await page.evaluate(async () => {
  window.__pfState().setTool('clone')
  await new Promise((r) => setTimeout(r, 300))
  const opts = document.querySelector('.rail-options')?.textContent || ''
  return {
    tool: window.__pfState().tool,
    label: (document.querySelector('.rail-options .rail-opt-label')?.textContent || '').trim(),
    saysAlt: /alt-click/i.test(opts),
    hasBrush: /Brush/.test(opts),
  }
})
// How to set the source is explanation rather than status, so it moved behind
// the (i) with the rest of the panel's prose. The bubble is painted on the
// render after the click, so it is read on the next tick rather than in the
// same expression.
ui.explained = await page.evaluate(async () => {
  document.querySelector('.rail-options .info-dot')?.click()
  await new Promise((r) => setTimeout(r, 200))
  return document.querySelector('.info-bubble')?.textContent || ''
})
console.log('rail:', JSON.stringify(ui))
check('the clone stamp is a tool of its own', ui.tool === 'clone' && ui.label === 'Clone stamp',
  ui.label)
check('it says how to set the source', /alt-click/i.test(ui.explained),
  ui.explained.slice(0, 70))
check('and has a brush to size', ui.hasBrush)

console.log(errors.length ? 'CONSOLE ERRORS: ' + errors.slice(0, 5).join(' | ') : 'no console errors')
await browser.close()
process.exit(checks.some(([, ok]) => !ok) ? 1 : 0)
