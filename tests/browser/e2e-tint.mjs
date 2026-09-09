// Recolouring a layer.
//
// The case: a logo arrives black and has to be white. Invert would do it and
// flips every other colour on the way past; a hue rotation cannot reach white
// from black at all, because black has no hue to turn. What you want is to keep
// the shape exactly — every soft edge, every bit of anti-aliasing — and say what
// colour it is.
//
// Which makes the alpha channel the thing to watch. A recolour that fills the
// layer's box, or that hardens a soft edge, has not recoloured the artwork, it
// has replaced it.
import { chromium } from 'playwright-core'
import fs from 'fs'
import path from 'path'

const OUT = 'shots/tint'
fs.mkdirSync(OUT, { recursive: true })

const browser = await chromium.launch({
  executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  headless: true,
})
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } })
const errors = []
page.on('console', (m) => { if (m.type() === 'error' && !/favicon/.test(m.text())) errors.push(m.text()) })
page.on('pageerror', (e) => errors.push('PAGEERROR: ' + e.message))

const checks = []
const check = (name, ok, detail = '') => {
  checks.push([name, ok])
  console.log((ok ? 'PASS  ' : 'FAIL  ') + name + (detail ? '  — ' + detail : ''))
}

await page.goto('http://localhost:5173/', { waitUntil: 'networkidle' })
await page.evaluate(() => { indexedDB.deleteDatabase('pixelforge'); localStorage.clear() })
await page.reload({ waitUntil: 'networkidle' })

// A black bar with a soft edge on transparency — a logo cut out of its
// background, which is the shape this is for.
const start = await page.evaluate(async () => {
  const st = window.__pfState()
  st.setPlaying(false)
  const c = document.createElement('canvas')
  c.width = 200
  c.height = 100
  const g = c.getContext('2d')
  g.fillStyle = '#000000'
  g.fillRect(40, 20, 120, 60)
  // A deliberately half-transparent strip, so a recolour that ignores alpha is
  // caught rather than merely suspected.
  g.globalAlpha = 0.5
  g.fillRect(40, 82, 120, 10)
  const blob = await new Promise((r) => c.toBlob(r))
  await st.addImages([new File([blob], 'logo.png', { type: 'image/png' })], { place: true })
  await new Promise((r) => setTimeout(r, 900))
  const l = window.__pfState().doc.layers[0]
  st.select([l.id])
  return { id: l.id, box: { x: l.x, y: l.y, w: l.w, h: l.h } }
})

const look = () => page.evaluate((box) => {
  const st = window.__pfState()
  const c = document.createElement('canvas')
  c.width = st.doc.width
  c.height = st.doc.height
  const ctx = c.getContext('2d', { willReadFrequently: true })
  window.__pfRender.renderDocument(ctx, st.doc, 0)
  const at = (fx, fy) => [...ctx.getImageData(
    Math.round(box.x + box.w * fx), Math.round(box.y + box.h * fy), 1, 1).data]
  return { ink: at(0.5, 0.4), soft: at(0.5, 0.87), outside: at(0.04, 0.05) }
}, start.box)

const before = await look()
console.log('the logo as imported:', JSON.stringify(before))
check('it arrives black', before.ink[0] < 20 && before.ink[3] > 250, JSON.stringify(before.ink))
check('with a half-transparent strip to watch',
  before.soft[3] > 100 && before.soft[3] < 200, JSON.stringify(before.soft))
check('and nothing around it', before.outside[3] === 0, JSON.stringify(before.outside))

const tint = (patch) => page.evaluate(([id, p]) => {
  window.__pfState().updateLayer(id, { tint: p })
  return new Promise((r) => setTimeout(r, 350))
}, [start.id, patch])

await tint({ on: true, color: '#ffffff', amount: 1 })
const white = await look()
console.log('recoloured white:', JSON.stringify(white))
check('a black logo comes out white', white.ink[0] > 250 && white.ink[1] > 250 && white.ink[2] > 250,
  JSON.stringify(white.ink))
// The whole point: the shape is kept and only its colour changes.
check('the transparency around it is untouched', white.outside[3] === 0, JSON.stringify(white.outside))
check('and a soft edge stays as soft as it was',
  Math.abs(white.soft[3] - before.soft[3]) < 6,
  `${before.soft[3]} -> ${white.soft[3]}`)
await page.screenshot({ path: path.join(OUT, '01-white.png') })

await tint({ on: true, color: '#ff0000', amount: 0.5 })
const half = await look()
console.log('halfway to red:', JSON.stringify(half))
check('below full strength the original shows through',
  half.ink[0] > 100 && half.ink[0] < 160, JSON.stringify(half.ink))
check('still without touching the alpha', half.outside[3] === 0 && half.ink[3] > 250,
  JSON.stringify(half.ink))

await tint({ on: false, color: '#ff0000', amount: 1 })
const off = await look()
console.log('switched off:', JSON.stringify(off))
check('turning it off puts the colour back',
  off.ink[0] < 20 && off.ink[3] > 250, JSON.stringify(off.ink))

// The control, which is the half a person meets.
const ui = await page.evaluate(async () => {
  window.__pfState().updateLayer(window.__pfState().doc.layers[0].id,
    { tint: { on: true, color: '#ffffff', amount: 1 } })
  await new Promise((r) => setTimeout(r, 350))
  return { rows: [...document.querySelectorAll('.row-label')].map((x) => x.textContent.trim()) }
})
check('it has a colour and a strength to set',
  ui.rows.includes('Recolour') && ui.rows.includes('Colour') && ui.rows.includes('Strength'),
  ui.rows.join(' '))

console.log(errors.length ? 'CONSOLE ERRORS: ' + errors.slice(0, 5).join(' | ') : 'no console errors')
await browser.close()
process.exit(checks.some(([, ok]) => !ok) ? 1 : 0)
