// Three things that were wrong with the new tools, and one that was wrong long
// before them.
//
// The eyedropper sampled per-pixel but showed nothing magnified, so at anything
// under a 4x zoom you could not tell which pixel you were about to take. The
// lasso's Erase wrote the layer's *mask*, and a layer has one mask, so erasing a
// second region put the first one back. And an inverted effect claimed the whole
// canvas, so a second "pixelate everything except this" re-covered the first.
import { chromium } from 'playwright-core'
import fs from 'fs'
import path from 'path'

const OUT = 'shots-tools2'
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

// A flat field, so every region has a known place and a known colour.
const setup = await page.evaluate(async () => {
  const c = document.createElement('canvas')
  c.width = 300
  c.height = 200
  const x = c.getContext('2d')
  x.fillStyle = '#2c6e49'
  x.fillRect(0, 0, 300, 200)
  const blob = await new Promise((r) => c.toBlob(r, 'image/png'))
  const a = await window.__pfAssets.loadImageFile(
    new File([blob], 'field.png', { type: 'image/png' }))
  const st = window.__pfState()
  st.placeMedia([a.id], { resizeDocToFirst: true })
  await new Promise((r) => setTimeout(r, 400))
  st.setPlaying(false)
  const l = window.__pfState().doc.layers[0]
  return { id: l.id, x: l.x, y: l.y, w: l.w, h: l.h }
})

/** Opaque pixels of the rendered document in a box: 0 means fully erased. */
const solidIn = (b) => page.evaluate((r) => {
  const st = window.__pfState()
  const c = document.createElement('canvas')
  c.width = st.doc.width
  c.height = st.doc.height
  const ctx = c.getContext('2d', { willReadFrequently: true })
  window.__pfRender.renderDocument(ctx, st.doc, 0)
  const d = ctx.getImageData(r.x, r.y, r.w, r.h).data
  let opaque = 0
  for (let i = 3; i < d.length; i += 4) if (d[i] > 200) opaque++
  return opaque
}, b)

// ---------------------------------------------------------------------------
// Erasing two regions leaves two holes
// ---------------------------------------------------------------------------
const A = { x: 30, y: 40, w: 40, h: 40 }
const B = { x: 200, y: 120, w: 40, h: 40 }
const box = (r) => [
  [r.x, r.y], [r.x + r.w, r.y], [r.x + r.w, r.y + r.h], [r.x, r.y + r.h],
]

const eraseRegion = (r) => page.evaluate((pts) => {
  const st = window.__pfState()
  st.setLasso({ points: pts, closed: true })
  return st.applyLasso('erase')
}, box(r))

check('the field starts solid', (await solidIn(A)) > 1500 && (await solidIn(B)) > 1500)

const first = await eraseRegion(A)
console.log('first erase:', JSON.stringify(first))
const afterFirst = { a: await solidIn(A), b: await solidIn(B) }
check('erasing a region takes it out', afterFirst.a < 100, `${afterFirst.a} opaque left`)

await eraseRegion(B)
const afterSecond = { a: await solidIn(A), b: await solidIn(B) }
console.log('after a second erase:', JSON.stringify(afterSecond))
check('erasing a second region takes that one out too', afterSecond.b < 100,
  `${afterSecond.b} opaque left`)
// The bug: the second erase was written as the layer's one mask, so it replaced
// the first and the first hole filled straight back in.
check('and the first hole is still a hole', afterSecond.a < 100,
  `${afterFirst.a} -> ${afterSecond.a} opaque`)

const stored = await page.evaluate((s) => {
  const l = window.__pfState().doc.layers.find((x) => x.id === s.id)
  return {
    strokes: l.erase?.strokes?.length || 0,
    kinds: (l.erase?.strokes || []).map((s) => s.kind || 'brush'),
    mask: !!l.mask,
  }
}, setup)
console.log('stored as:', JSON.stringify(stored))
check('as two strokes rather than one mask',
  stored.strokes === 2 && !stored.mask, JSON.stringify(stored))
check('and they are regions, not brush lines',
  stored.kinds.every((k) => k === 'region'), JSON.stringify(stored.kinds))

// It has to come back one at a time, like every other stroke.
await page.evaluate(() => window.__pfState().undo())
await page.waitForTimeout(150)
const undone = { a: await solidIn(A), b: await solidIn(B) }
console.log('after one undo:', JSON.stringify(undone))
check('one undo takes back one region, not both',
  undone.b > 1500 && undone.a < 100, JSON.stringify(undone))
await page.evaluate(() => window.__pfState().redo())
await page.waitForTimeout(150)

// A brush stroke and a lasso region live together in the same list.
const mixed = await page.evaluate((s) => {
  const st = window.__pfState()
  st.beginErase(s.id, [0.5, 0.2], { size: 0.1, hardness: 1 })
  st.extendErase(s.id, [0.55, 0.2])
  const l = window.__pfState().doc.layers.find((x) => x.id === s.id)
  return { n: l.erase.strokes.length, kinds: l.erase.strokes.map((x) => x.kind || 'brush') }
}, setup)
console.log('mixed strokes:', JSON.stringify(mixed))
check('the brush and the lasso share one list',
  mixed.n === 3 && mixed.kinds.includes('brush') && mixed.kinds.includes('region'),
  JSON.stringify(mixed.kinds))

// ---------------------------------------------------------------------------
// Two "pixelate everything except this" layers keep both windows clear
// ---------------------------------------------------------------------------
await page.evaluate(async () => {
  const st = window.__pfState()
  st.resetDoc()
  await new Promise((r) => setTimeout(r, 200))
  // Fine stripes, so pixelation is measurable as detail lost.
  const c = document.createElement('canvas')
  c.width = 300
  c.height = 200
  const x = c.getContext('2d')
  for (let i = 0; i < 300; i += 4) {
    x.fillStyle = (i / 4) % 2 ? '#ffffff' : '#101010'
    x.fillRect(i, 0, 4, 200)
  }
  const blob = await new Promise((r) => c.toBlob(r, 'image/png'))
  const a = await window.__pfAssets.loadImageFile(
    new File([blob], 'stripes.png', { type: 'image/png' }))
  window.__pfState().placeMedia([a.id], { resizeDocToFirst: true })
  await new Promise((r) => setTimeout(r, 400))
  window.__pfState().setPlaying(false)
})

/** Surviving detail in a box: left-to-right changes across it. */
const detailIn = (b) => page.evaluate((r) => {
  const st = window.__pfState()
  const c = document.createElement('canvas')
  c.width = st.doc.width
  c.height = st.doc.height
  const ctx = c.getContext('2d', { willReadFrequently: true })
  window.__pfRender.renderDocument(ctx, st.doc, 0)
  const d = ctx.getImageData(r.x, r.y, r.w, r.h).data
  let edges = 0
  for (let y = 0; y < r.h; y++) {
    for (let x = 1; x < r.w; x++) {
      const i = (y * r.w + x) * 4
      if (Math.abs(d[i] - d[i - 4]) > 60) edges++
    }
  }
  return edges
}, b)

const WIN_A = { x: 20, y: 60, w: 60, h: 60 }
const WIN_B = { x: 210, y: 60, w: 60, h: 60 }
const BETWEEN = { x: 120, y: 60, w: 60, h: 60 }

const sharp = {
  a: await detailIn(WIN_A), b: await detailIn(WIN_B), mid: await detailIn(BETWEEN),
}
console.log('detail before any effect:', JSON.stringify(sharp))
check('the stripes are sharp to begin with', sharp.a > 500 && sharp.b > 500,
  JSON.stringify(sharp))

const addWindow = (r) => page.evaluate((w) => {
  const st = window.__pfState()
  const { makeEffectLayer } = window.__pfStore
  st.addLayer(makeEffectLayer({
    name: 'Keep ' + w.x, shape: 'rect', effect: 'pixelate', pixelSize: 20,
    invert: true, x: w.x, y: w.y, w: w.w, h: w.h,
  }))
  return true
}, r)

await addWindow(WIN_A)
await page.waitForTimeout(250)
const one = { a: await detailIn(WIN_A), b: await detailIn(WIN_B), mid: await detailIn(BETWEEN) }
console.log('with one window:', JSON.stringify(one))
check('one window stays sharp', one.a > sharp.a * 0.8, `${one.a} of ${sharp.a}`)
check('and everything else is pixelated', one.mid < sharp.mid * 0.3,
  `${one.mid} of ${sharp.mid}`)

await addWindow(WIN_B)
await page.waitForTimeout(250)
const two = { a: await detailIn(WIN_A), b: await detailIn(WIN_B), mid: await detailIn(BETWEEN) }
console.log('with two windows:', JSON.stringify(two))
check('the second window is sharp too', two.b > sharp.b * 0.8, `${two.b} of ${sharp.b}`)
// The bug: the second inverted layer claimed the whole canvas, so it pixelated
// the first window straight back over.
check('and the first window stayed sharp', two.a > sharp.a * 0.8,
  `${one.a} -> ${two.a} of ${sharp.a}`)
check('while everything outside both is still pixelated', two.mid < sharp.mid * 0.3,
  `${two.mid} of ${sharp.mid}`)
await page.screenshot({ path: path.join(OUT, '01-two-windows.png') })

// A third, to show it is a union rather than a special case for two.
const WIN_C = { x: 120, y: 10, w: 50, h: 40 }
await addWindow(WIN_C)
await page.waitForTimeout(250)
const three = { a: await detailIn(WIN_A), b: await detailIn(WIN_B), c: await detailIn(WIN_C) }
console.log('with three windows:', JSON.stringify(three))
check('three windows all stay sharp',
  three.a > sharp.a * 0.8 && three.b > sharp.b * 0.8 && three.c > 200,
  JSON.stringify(three))

// A plain pixelate is not a window, and still pixelates what it covers.
await page.evaluate(() => {
  const st = window.__pfState()
  const { makeEffectLayer } = window.__pfStore
  st.addLayer(makeEffectLayer({
    name: 'Plain', shape: 'rect', effect: 'pixelate', pixelSize: 20,
    invert: false, x: 20, y: 60, w: 30, h: 60,
  }))
})
await page.waitForTimeout(250)
const overA = await detailIn({ x: 22, y: 62, w: 26, h: 56 })
console.log('a plain pixelate inside a window:', overA)
check('a plain pixelate still pixelates, even inside a window',
  overA < sharp.a * 0.35, `${overA} against ${sharp.a}`)

// ---------------------------------------------------------------------------
// The eyedropper's loupe
// ---------------------------------------------------------------------------
const loupe = await page.evaluate(async () => {
  const st = window.__pfState()
  st.setTool('eyedrop')
  await new Promise((r) => setTimeout(r, 200))
  const canvas = document.querySelector('.stage canvas')
  const r = canvas.getBoundingClientRect()
  const v = st.view
  const cx = r.left + r.width / 2
  const cy = r.top + r.height / 2
  return {
    p: {
      x: cx + (150 - st.doc.width / 2) * v.zoom + v.panX,
      y: cy + (100 - st.doc.height / 2) * v.zoom + v.panY,
    },
  }
})

const stageShot = () => page.locator('.stage canvas').screenshot()

const before = await stageShot()
await page.mouse.move(loupe.p.x, loupe.p.y)
await page.waitForTimeout(300)
const after = await stageShot()
check('moving the eyedropper over the picture draws something new',
  Buffer.compare(before, after) !== 0)
await page.screenshot({ path: path.join(OUT, '02-loupe.png') })

// It has to be the loupe and not any old repaint: through the glass a stripe is
// several times wider than it is on the canvas.
const magnified = await page.evaluate(() => {
  const canvas = document.querySelector('.stage canvas')
  const dpr = canvas._dpr || 1
  const c = document.createElement('canvas')
  c.width = canvas.width
  c.height = canvas.height
  c.getContext('2d').drawImage(canvas, 0, 0)
  const st = window.__pfState()
  const v = st.view
  const r = canvas.getBoundingClientRect()
  const sx = r.width / 2 + (150 - st.doc.width / 2) * v.zoom + v.panX
  const sy = r.height / 2 + (100 - st.doc.height / 2) * v.zoom + v.panY
  // Where the glass sits: up and to the right of the cursor by gap = 18 + R.
  const lx = Math.round((sx + 80) * dpr)
  const ly = Math.round((sy - 80) * dpr)
  const w = Math.round(80 * dpr)
  const d = c.getContext('2d', { willReadFrequently: true })
    .getImageData(lx - w / 2, ly, w, 1).data
  const runs = []
  let run = 1
  for (let i = 4; i < d.length; i += 4) {
    if (Math.abs(d[i] - d[i - 4]) > 60) { runs.push(run); run = 1 } else run++
  }
  return { runs: runs.filter((n) => n > 1), dpr }
})
console.log('run lengths across the glass:', JSON.stringify(magnified))
// The stripes are 4 document pixels wide. One document pixel is about 8 screen
// pixels through the glass, so a stripe there is far wider than on the canvas.
check('and what it draws is magnified', magnified.runs.some((n) => n >= 8),
  JSON.stringify(magnified.runs.slice(0, 10)))

await page.evaluate(() => window.__pfState().setTool('move'))
await page.waitForTimeout(300)
const afterTool = await stageShot()
check('and it goes away with the tool', Buffer.compare(after, afterTool) !== 0)

console.log(errors.length ? 'CONSOLE ERRORS: ' + errors.slice(0, 5).join(' | ') : 'no console errors')
await browser.close()
process.exit(checks.some(([, ok]) => !ok) ? 1 : 0)
