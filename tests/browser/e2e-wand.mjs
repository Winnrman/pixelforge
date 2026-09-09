// Selecting by colour.
//
// The AI lasso looks for subjects, which is why it is no help with a flat
// background, a logo, a sky or a panel of a screenshot — it is answering a
// different question. This answers the plain one, so the fixture is the plain
// case: shapes of known colour and known area.
import { chromium } from 'playwright-core'
import fs from 'fs'
import path from 'path'

const OUT = 'shots/wand'
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

// A flat blue ground with a red disc in the middle and a small red square in a
// corner: two regions of the same colour that are not joined.
const setup = await page.evaluate(async () => {
  const c = document.createElement('canvas')
  c.width = 300
  c.height = 200
  const x = c.getContext('2d')
  x.fillStyle = '#2050b4'
  x.fillRect(0, 0, 300, 200)
  x.fillStyle = '#c02020'
  x.beginPath()
  x.arc(150, 100, 50, 0, Math.PI * 2)
  x.fill()
  x.fillRect(10, 10, 24, 24)
  const blob = await new Promise((r) => c.toBlob(r, 'image/png'))
  const a = await window.__pfAssets.loadImageFile(
    new File([blob], 'flat.png', { type: 'image/png' }))
  const st = window.__pfState()
  st.placeMedia([a.id], { resizeDocToFirst: true })
  await new Promise((r) => setTimeout(r, 400))
  st.setPlaying(false)
  const l = window.__pfState().doc.layers[0]
  return { id: l.id, x: l.x, y: l.y, w: l.w, h: l.h }
})
console.log('fixture:', JSON.stringify(setup))
check('a picture of flat colours', setup.w === 300 && setup.h === 200)

/** The area a lasso encloses, in document units. */
const lassoArea = () => page.evaluate(() => {
  const pts = window.__pfState().lasso?.points
  if (!pts || pts.length < 3) return null
  let a = 0
  for (let i = 0; i < pts.length; i++) {
    const [x1, y1] = pts[i]
    const [x2, y2] = pts[(i + 1) % pts.length]
    a += x1 * y2 - x2 * y1
  }
  return { area: Math.abs(a) / 2, n: pts.length }
})

// --- the disc ---------------------------------------------------------------------
const disc = await page.evaluate((s) => {
  const st = window.__pfState()
  st.clearLasso?.()
  st.wandSelectAt(s.x + 150, s.y + 100)
  return !!window.__pfState().lasso
}, setup)
const discArea = await lassoArea()
console.log('clicking the disc:', JSON.stringify(discArea))
check('clicking a flat region selects it', disc && discArea, JSON.stringify(discArea))
// A circle of radius 50 is about 7854 square units.
check('and the selection is the size of that region',
  Math.abs(discArea.area - Math.PI * 50 * 50) / (Math.PI * 50 * 50) < 0.12,
  `${Math.round(discArea.area)} against ~7854`)
check('as a lasso with real detail, not a box', discArea.n > 12, `${discArea.n} points`)

// --- only the region clicked, not every pixel of that colour -------------------------
// The corner square is the same red. A lasso is one polygon, so a selection
// scattered across a picture has no way to come back — it takes the region the
// click is inside and says so, rather than pretending otherwise.
check('and not the matching square in the corner',
  discArea.area < Math.PI * 50 * 50 * 1.3, `${Math.round(discArea.area)}`)

const corner = await page.evaluate((s) => {
  window.__pfState().wandSelectAt(s.x + 22, s.y + 22)
  return true
}, setup)
const cornerArea = await lassoArea()
console.log('clicking the corner square:', JSON.stringify(cornerArea))
check('clicking the other region selects that one instead',
  Math.abs(cornerArea.area - 24 * 24) / (24 * 24) < 0.3,
  `${Math.round(cornerArea.area)} against 576`)

// --- the background ------------------------------------------------------------------
const bg = await page.evaluate((s) => {
  window.__pfState().wandSelectAt(s.x + 10, s.y + 180)
  return true
}, setup)
const bgArea = await lassoArea()
console.log('clicking the background:', JSON.stringify(bgArea))
check('clicking the background takes the background',
  bgArea.area > 300 * 200 * 0.7, `${Math.round(bgArea.area)} of 60000`)
// And a limit worth stating rather than discovering: a lasso is a single
// outline with no holes, so a background that wraps around the disc comes back
// including it. The true background is 60000 - 7854 - 576 = 51570; what comes
// back is more than that, and it should be, because the alternative would be an
// outline that cannot exist.
check('and encloses what it wraps around, because one outline has no holes',
  bgArea.area > 300 * 200 - Math.PI * 50 * 50 - 576,
  `${Math.round(bgArea.area)} against a true background of 51570`)

// --- tolerance decides how much is "the same" -------------------------------------------
const gradient = await page.evaluate(async () => {
  const c = document.createElement('canvas')
  c.width = 300
  c.height = 100
  const x = c.getContext('2d')
  const g = x.createLinearGradient(0, 0, 300, 0)
  g.addColorStop(0, '#000000')
  g.addColorStop(1, '#ffffff')
  x.fillStyle = g
  x.fillRect(0, 0, 300, 100)
  const blob = await new Promise((r) => c.toBlob(r, 'image/png'))
  const a = await window.__pfAssets.loadImageFile(
    new File([blob], 'ramp.png', { type: 'image/png' }))
  const st = window.__pfState()
  st.resetDoc()
  window.__pfState().placeMedia([a.id], { resizeDocToFirst: true })
  await new Promise((r) => setTimeout(r, 400))
  const l = window.__pfState().doc.layers[0]

  const areaNow = () => {
    const pts = window.__pfState().lasso?.points
    if (!pts || pts.length < 3) return 0
    let s = 0
    for (let i = 0; i < pts.length; i++) {
      const [x1, y1] = pts[i]
      const [x2, y2] = pts[(i + 1) % pts.length]
      s += x1 * y2 - x2 * y1
    }
    return Math.abs(s) / 2
  }
  const out = {}
  for (const t of [0.05, 0.2, 0.5]) {
    window.__pfState().wandSelectAt(l.x + 150, l.y + 50, { tolerance: t })
    out[t] = Math.round(areaNow())
  }
  return out
})
console.log('on a gradient, by tolerance:', JSON.stringify(gradient))
// A ramp has no flat region, so tolerance is the whole answer: it decides how
// far from the clicked colour still counts.
check('a tighter tolerance takes less', gradient['0.05'] < gradient['0.2'],
  `${gradient['0.05']} < ${gradient['0.2']}`)
check('and a looser one takes more', gradient['0.2'] < gradient['0.5'],
  `${gradient['0.2']} < ${gradient['0.5']}`)

// --- it says so when nothing matches ------------------------------------------------------
const missed = await page.evaluate(() => {
  const st = window.__pfState()
  const before = st.lasso
  const got = st.wandSelectAt(-500, -500)
  return { got, notice: window.__pfState().notice?.text || '', kept: window.__pfState().lasso === before }
})
console.log('clicking off the picture:', JSON.stringify(missed))
check('clicking nothing returns nothing', missed.got === null)
check('and says why', /image layer/i.test(missed.notice), missed.notice)

// --- the tool is in the rail ----------------------------------------------------------------
const ui = await page.evaluate(async () => {
  window.__pfState().setTool('wand')
  await new Promise((r) => setTimeout(r, 300))
  return {
    tool: window.__pfState().tool,
    label: document.querySelector('.rail-options .rail-opt-label')?.textContent || '',
    hasTolerance: /Tolerance/.test(document.querySelector('.rail-options')?.textContent || ''),
    // The option that was cut, because a single polygon cannot hold a scattered
    // selection and offering it would promise what the result cannot carry.
    hasContiguous: /contiguous/i.test(document.querySelector('.rail-options')?.textContent || ''),
  }
})
console.log('rail:', JSON.stringify(ui))
check('the wand is a tool of its own', ui.tool === 'wand')
check('with a tolerance to set', ui.hasTolerance, ui.label)
check('and no option it could not honour', ui.hasContiguous === false)

await page.screenshot({ path: path.join(OUT, '01-wand.png') })
console.log(errors.length ? 'CONSOLE ERRORS: ' + errors.slice(0, 5).join(' | ') : 'no console errors')
await browser.close()
process.exit(checks.some(([, ok]) => !ok) ? 1 : 0)
