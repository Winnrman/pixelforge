// The eyedropper.
//
// The app is full of colour controls — text, sticker border, Polaroid card,
// shape fill, canvas background — and until now the only way to set one was to
// know a hex code. Sampling the picture is the obvious way to choose a colour
// that matches the artwork, so the thing worth testing is that it samples what
// you can actually *see*: the composited document, not a layer's raw source.
import { chromium } from 'playwright-core'
import fs from 'fs'
import path from 'path'

const OUT = 'shots-eyedrop'
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

// Two flat halves, so every sample has a known right answer.
const setup = await page.evaluate(async () => {
  const c = document.createElement('canvas')
  c.width = 240
  c.height = 160
  const x = c.getContext('2d')
  x.fillStyle = '#c83232'
  x.fillRect(0, 0, 120, 160)
  x.fillStyle = '#3264c8'
  x.fillRect(120, 0, 120, 160)
  const blob = await new Promise((r) => c.toBlob(r, 'image/png'))
  const a = await window.__pfAssets.loadImageFile(
    new File([blob], 'halves.png', { type: 'image/png' }))
  const st = window.__pfState()
  st.placeMedia([a.id], { resizeDocToFirst: true })
  await new Promise((r) => setTimeout(r, 400))
  st.setPlaying(false)
  return { doc: { w: window.__pfState().doc.width, h: window.__pfState().doc.height } }
})
console.log('fixture:', JSON.stringify(setup))
check('a picture with two known colours', setup.doc.w === 240)

/** Clicks a document point with the eyedropper, in screen coordinates. */
const sampleAt = async (docX, docY) => {
  const pt = await page.evaluate(([dx, dy]) => {
    const st = window.__pfState()
    st.setTool('eyedrop')
    const canvas = document.querySelector('.stage canvas')
    const r = canvas.getBoundingClientRect()
    const v = st.view
    // The same mapping the stage uses: panX/panY is the document's top-left in
    // stage coordinates, so a document point is pan + doc * zoom. This used to
    // be written around the canvas centre, which double-counted the pan — and
    // passed anyway, because these fixture colours are split left from right at
    // full height, so an error in y could not change the answer.
    return [r.left + v.panX + dx * v.zoom, r.top + v.panY + dy * v.zoom]
  }, [docX, docY])
  await page.mouse.click(pt[0], pt[1])
  await page.waitForTimeout(200)
  return page.evaluate(() => window.__pfState().toolOptions.sampled)
}

const left = await sampleAt(40, 80)
const right = await sampleAt(200, 80)
console.log('sampled:', left, right)
check('the left half reads back its own colour', left === '#c83232', String(left))
check('and the right half reads its own', right === '#3264c8', String(right))

// --- it samples what is composited, not a layer's source --------------------------
// A half-transparent white square over the red: sampling there must give the
// blend you can see, not the red underneath or the white on top.
const overlaid = await page.evaluate(async () => {
  const st = window.__pfState()
  const { makeShapeLayer } = window.__pfStore
  st.addLayer(makeShapeLayer({
    shape: 'rect', x: 10, y: 10, w: 80, h: 80, fill: '#ffffff', opacity: 0.5,
  }))
  await new Promise((r) => setTimeout(r, 400))
  return true
})
const blended = await sampleAt(45, 45)
console.log('over a 50% white square:', blended)
check('sampling through an overlay gives the blend, not either layer',
  blended !== '#c83232' && blended !== '#ffffff', String(blended))
// Half way from #c83232 to white is about #e39898.
check('and the blend is the right one', /^#e[0-9a-f]{5}$/.test(blended || ''), String(blended))
await page.screenshot({ path: path.join(OUT, '01-eyedrop.png') })

// --- the pipette on a colour control picks straight into it --------------------------
const targeted = await page.evaluate(async () => {
  const st = window.__pfState()
  st.setTool('move')
  const shape = st.doc.layers.find((l) => l.type === 'shape')
  st.select([shape.id])
  await new Promise((r) => setTimeout(r, 400))
  const pip = [...document.querySelectorAll('.inspector .color-field .pipette')][0]
  if (!pip) return { found: false }
  pip.click()
  await new Promise((r) => setTimeout(r, 200))
  return {
    found: true,
    tool: window.__pfState().tool,
    shapeId: shape.id,
    before: window.__pfState().doc.layers.find((l) => l.id === shape.id).fill,
  }
})
console.log('pipette pressed:', JSON.stringify(targeted))
check('every colour box has a pipette', targeted.found === true)
check('and pressing it takes up the eyedropper', targeted.tool === 'eyedrop', targeted.tool)

// Sample the blue half; the shape's colour should become it.
await sampleAt(200, 120)
const applied = await page.evaluate((id) => ({
  fill: window.__pfState().doc.layers.find((l) => l.id === id).fill,
  tool: window.__pfState().tool,
}), targeted.shapeId)
console.log('after picking into it:', JSON.stringify(applied))
check('the sampled colour lands in the control that asked', applied.fill === '#3264c8',
  `${targeted.before} -> ${applied.fill}`)
// Asking for one colour should not leave you holding a different tool.
check('and the tool you had is handed back', applied.tool === 'move', applied.tool)

// --- escape abandons the request ------------------------------------------------------
const escaped = await page.evaluate(async (id) => {
  const st = window.__pfState()
  const pip = [...document.querySelectorAll('.inspector .color-field .pipette')][0]
  pip.click()
  await new Promise((r) => setTimeout(r, 150))
  const during = window.__pfState().tool
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  await new Promise((r) => setTimeout(r, 200))
  return { during, after: window.__pfState().tool, fill: window.__pfState().doc.layers.find((l) => l.id === id).fill }
}, targeted.shapeId)
console.log('escape:', JSON.stringify(escaped))
check('escape puts the eyedropper away', escaped.during === 'eyedrop' && escaped.after === 'move',
  `${escaped.during} -> ${escaped.after}`)
check('and changes nothing', escaped.fill === '#3264c8', escaped.fill)

// A pick abandoned that way must not fire into the next thing sampled.
const stale = await page.evaluate(async () => {
  window.__pfState().setTool('eyedrop')
  await new Promise((r) => setTimeout(r, 150))
  return true
})
await sampleAt(40, 120)
const notStale = await page.evaluate((id) => ({
  fill: window.__pfState().doc.layers.find((l) => l.id === id).fill,
  sampled: window.__pfState().toolOptions.sampled,
}), targeted.shapeId)
console.log('after a later free sample:', JSON.stringify(notStale))
check('an abandoned request does not catch a later sample',
  notStale.fill === '#3264c8' && notStale.sampled === '#c83232',
  `fill ${notStale.fill}, sampled ${notStale.sampled}`)

console.log(errors.length ? 'CONSOLE ERRORS: ' + errors.slice(0, 5).join(' | ') : 'no console errors')
await browser.close()
process.exit(checks.some(([, ok]) => !ok) ? 1 : 0)
