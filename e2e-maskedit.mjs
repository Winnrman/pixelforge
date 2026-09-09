// Repairing a mask instead of redrawing it.
//
// Cutting a subject out is one gesture and getting it perfect is not. The cut
// takes a slice off an arm or a leg, and until now the only answer was to draw
// the whole outline again — on a shape traced by the AI selector, that is
// hundreds of points thrown away to win back a sliver.
//
// So a mask is several outlines that union. The missing piece is drawn on its
// own and added, and if it reaches outside the layer's frame — which is exactly
// where a cut that was too tight leaves it, because masking trims the frame down
// to what was kept — the frame grows to meet it.
//
// Measured in pixels off a real render. "Did the fields change" cannot tell the
// difference between a piece added and a hole punched, and punching a hole is
// the failure this is one winding order away from.
import { chromium } from 'playwright-core'
import fs from 'fs'
import path from 'path'

const OUT = 'shots-maskedit'
fs.mkdirSync(OUT, { recursive: true })

const browser = await chromium.launch({
  executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  headless: true,
})
const page = await browser.newPage({ viewport: { width: 1500, height: 950 } })
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

// A solid picture, so whatever the mask keeps is opaque and whatever it drops is
// nothing. Every sample below is "is there anything here", which is the only
// question a mask answers.
const start = await page.evaluate(async () => {
  const st = window.__pfState()
  st.setPlaying(false)
  const c = document.createElement('canvas')
  c.width = 400
  c.height = 400
  const g = c.getContext('2d')
  g.fillStyle = '#00c000'
  g.fillRect(0, 0, 400, 400)
  const blob = await new Promise((r) => c.toBlob(r))
  await st.addImages([new File([blob], 'green.png', { type: 'image/png' })], { place: true })
  await new Promise((r) => setTimeout(r, 800))
  const l = window.__pfState().doc.layers[0]
  return { id: l.id, box: { x: l.x, y: l.y, w: l.w, h: l.h } }
})
const BOX = start.box

/** Is anything drawn at this fraction of where the picture originally was? */
const litAt = (fx, fy) => page.evaluate(([x, y]) => {
  const st = window.__pfState()
  const c = document.createElement('canvas')
  c.width = st.doc.width
  c.height = st.doc.height
  const ctx = c.getContext('2d', { willReadFrequently: true })
  window.__pfRender.renderDocument(ctx, st.doc, 0)
  return ctx.getImageData(Math.round(x), Math.round(y), 1, 1).data[3] > 128
}, [BOX.x + BOX.w * fx, BOX.y + BOX.h * fy])

const lasso = (pts) => page.evaluate(([box, ps, id]) => {
  const st = window.__pfState()
  st.select([id])
  st.setLasso({
    points: ps.map(([fx, fy]) => [box.x + box.w * fx, box.y + box.h * fy]),
    closed: true,
  })
}, [BOX, pts, start.id])

const layer = () => page.evaluate((id) => {
  const l = window.__pfState().doc.layers.find((x) => x.id === id)
  return {
    x: Math.round(l.x), y: Math.round(l.y), w: Math.round(l.w), h: Math.round(l.h),
    outlines: 1 + (l.mask?.plus?.length || 0),
  }
}, start.id)

// --- cut it too tight -------------------------------------------------------------
// The left half only, standing in for an outline that missed a leg.
await lasso([[0.05, 0.05], [0.5, 0.05], [0.5, 0.95], [0.05, 0.95]])
const masked = await page.evaluate(() => window.__pfState().applyLasso('mask'))
await page.waitForTimeout(400)
const trimmed = await layer()
console.log('after masking to the left half:', JSON.stringify(masked), JSON.stringify(trimmed))
check('masking keeps what was inside the outline', masked.ok === true && await litAt(0.25, 0.5))
check('and drops what was outside it', !(await litAt(0.75, 0.5)))
// This is what makes the repair awkward and is the reason the frame has to grow:
// the frame is now the size of what was kept, so the piece that was missed is
// not merely uncovered, it is outside the layer altogether.
check('and shrinks the frame to what it kept', trimmed.w < BOX.w * 0.6, `${trimmed.w}px of ${BOX.w}`)

// --- add the missing piece back ----------------------------------------------------
await lasso([[0.55, 0.3], [0.9, 0.3], [0.9, 0.7], [0.55, 0.7]])
const added = await page.evaluate(() => window.__pfState().applyLasso('mask-add'))
await page.waitForTimeout(400)
const grown = await layer()
console.log('after adding a piece outside the frame:', JSON.stringify(added), JSON.stringify(grown))
check('a piece can be added to a mask that already exists', added.ok === true, JSON.stringify(added))
check('and the mask is two outlines now', grown.outlines === 2, `${grown.outlines}`)
check('the frame grew to hold the piece', grown.w > trimmed.w * 1.5, `${trimmed.w} -> ${grown.w}`)
check('the piece is drawn', await litAt(0.75, 0.5))
check('and so is everything that was already there', await litAt(0.25, 0.5))
check('while the gap between them stays out', !(await litAt(0.52, 0.5)))
check('and so does everything above the piece', !(await litAt(0.75, 0.1)))
await page.screenshot({ path: path.join(OUT, '01-added.png') })

// --- a piece that overlaps, drawn the other way round -------------------------------
// The real repair: a sliver that laps onto what is already kept. Canvas unions
// subpaths for nothing, but only wound the same way — wound against each other
// the nonzero rule reads the overlap as a hole, and the fix bites a chunk out of
// the subject instead of filling one in. Which way round somebody draws a lasso
// is not something they decide.
// Both ways round, rather than whichever one I believed was the dangerous one:
// the first version of this test reversed the outline and reversed it into
// agreement with the base by luck, so it passed with the winding fix taken out.
const box = [[0.3, 0.4], [0.3, 0.6], [0.45, 0.6], [0.45, 0.4]]
for (const [name, pts] of [['one way', box], ['the other', [...box].reverse()]]) {
  await lasso(pts)
  const res = await page.evaluate(() => window.__pfState().applyLasso('mask-add'))
  await page.waitForTimeout(400)
  const kept = await litAt(0.37, 0.5)
  const rest = await litAt(0.15, 0.5)
  console.log(`an overlapping piece drawn ${name}:`, JSON.stringify(res), { kept, rest })
  check(`a piece drawn ${name} round adds`, res.ok === true, JSON.stringify(res))
  check(`and its overlap is still there rather than punched out (${name})`, kept)
  check(`with the rest of the subject (${name})`, rest)
  await page.evaluate((id) => window.__pfState().undoMaskAdd(id), start.id)
  await page.waitForTimeout(250)
}
// Left added, for the checks below.
await lasso(box)
await page.evaluate(() => window.__pfState().applyLasso('mask-add'))
await page.waitForTimeout(400)

// --- taking one back ----------------------------------------------------------------
const undone = await page.evaluate(async (id) => {
  window.__pfState().undoMaskAdd(id)
  await new Promise((r) => setTimeout(r, 300))
  const l = window.__pfState().doc.layers.find((x) => x.id === id)
  return { outlines: 1 + (l.mask?.plus?.length || 0) }
}, start.id)
console.log('after taking the last piece back:', JSON.stringify(undone))
check('the last piece added can be taken back', undone.outlines === 2, `${undone.outlines}`)
check('and the one before it stays', await litAt(0.75, 0.5))

// --- the button is offered where it means something ----------------------------------
// It takes the place of Mask rather than sitting beside it: on a layer already
// cut out, a second outline nearly always means "and this bit too".
const bar = await page.evaluate(async (id) => {
  const st = window.__pfState()
  st.select([id])
  st.setLasso({ points: [[10, 10], [80, 10], [80, 80], [10, 80]], closed: true })
  await new Promise((r) => setTimeout(r, 300))
  const withMask = [...document.querySelectorAll('.lasso-bar button')].map((b) => b.textContent.trim())
  // And on a layer with no mask at all.
  st.clearMask(id)
  await new Promise((r) => setTimeout(r, 300))
  const without = [...document.querySelectorAll('.lasso-bar button')].map((b) => b.textContent.trim())
  return { withMask, without }
}, start.id)
console.log('the lasso bar:', JSON.stringify(bar))
check('a masked layer is offered Add to mask',
  bar.withMask.includes('Add to mask'), bar.withMask.join(' '))
check('and not Mask, which would throw the outline away',
  !bar.withMask.includes('Mask'), bar.withMask.join(' '))
check('an unmasked one is offered Mask',
  bar.without.includes('Mask') && !bar.without.includes('Add to mask'), bar.without.join(' '))
await page.screenshot({ path: path.join(OUT, '02-bar.png') })

// --- trimming after a repair ---------------------------------------------------------
// Trimming fits the frame to the mask, and it used to measure only the outline
// the mask started as. On a repaired mask that means fitting the frame to the
// original cut and shaving the repair straight back off — the one thing the
// repair was for.
const retrim = await page.evaluate(async (id) => {
  const st = window.__pfState()
  st.clearMask(id)
  await new Promise((r) => setTimeout(r, 200))
  const l = window.__pfState().doc.layers.find((x) => x.id === id)
  const box = { x: l.x, y: l.y, w: l.w, h: l.h }
  const at = (fx, fy) => [box.x + box.w * fx, box.y + box.h * fy]
  st.select([id])
  st.setLasso({ points: [at(0.05, 0.05), at(0.4, 0.05), at(0.4, 0.95), at(0.05, 0.95)], closed: true })
  st.applyLasso('mask')
  await new Promise((r) => setTimeout(r, 400))
  st.setLasso({ points: [at(0.45, 0.3), at(0.95, 0.3), at(0.95, 0.7), at(0.45, 0.7)], closed: true })
  window.__pfState().applyLasso('mask-add')
  await new Promise((r) => setTimeout(r, 400))
  const wide = window.__pfState().doc.layers.find((x) => x.id === id)
  window.__pfState().trimToSubject(id, { quiet: true })
  await new Promise((r) => setTimeout(r, 400))
  const after = window.__pfState().doc.layers.find((x) => x.id === id)
  return { wide: Math.round(wide.w), after: Math.round(after.w), original: Math.round(box.w) }
}, start.id)
console.log('trimming a repaired mask:', JSON.stringify(retrim))
check('trimming a repaired mask measures the repair too',
  retrim.after > retrim.wide * 0.9, `${retrim.wide} -> ${retrim.after}`)

console.log(errors.length ? 'CONSOLE ERRORS: ' + errors.slice(0, 5).join(' | ') : 'no console errors')
await browser.close()
process.exit(checks.some(([, ok]) => !ok) ? 1 : 0)
