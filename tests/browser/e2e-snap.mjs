// Alignment snapping: dragging a layer near the canvas centre or an edge must
// land exactly on it, draw a guide, and stay escapable.
import { chromium } from 'playwright-core'
import { importAndPlace } from '../e2e-helpers.mjs'
import fs from 'fs'
import path from 'path'

const OUT = 'shots-snap'
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

await page.goto('http://localhost:5173/', { waitUntil: 'networkidle' })
await page.evaluate(() => indexedDB.deleteDatabase('pixelforge'))
await page.reload({ waitUntil: 'networkidle' })
await importAndPlace(page, 'public/test/motion.gif', { timeout: 10000 })
await page.waitForTimeout(700)
await page.evaluate(() => { window.__pfState().setPlaying(false); window.__pfState().setTime(0) })

// A small shape to drag around a 320x200 canvas.
await page.evaluate(() => {
  const s = window.__pfState()
  const { makeShapeLayer } = window.__pfStore
  const l = makeShapeLayer({ name: 'Chip', x: 20, y: 20, w: 60, h: 40 })
  s.addLayer(l)
  s.select([l.id])
})
await page.waitForTimeout(300)

const geo = await page.evaluate(() => {
  const s = window.__pfState()
  const r = document.querySelector('.stage canvas').getBoundingClientRect()
  return { cx: r.x, cy: r.y, ...s.view, doc: { w: s.doc.width, h: s.doc.height } }
})
const toScreen = (dx, dy) => [geo.cx + geo.panX + dx * geo.zoom, geo.cy + geo.panY + dy * geo.zoom]
const chip = () => page.evaluate(() => {
  const l = window.__pfState().doc.layers.find((x) => x.name === 'Chip')
  return { x: +l.x.toFixed(2), y: +l.y.toFixed(2), w: l.w, h: l.h }
})

/** Drag the chip so its centre lands near (tx, ty) in document space. */
async function dragCentreTo(tx, ty, opts = {}) {
  const c = await chip()
  const [sx, sy] = toScreen(c.x + c.w / 2, c.y + c.h / 2)
  const [ex, ey] = toScreen(tx, ty)
  await page.mouse.move(sx, sy)
  await page.mouse.down()
  if (opts.alt) await page.keyboard.down('Alt')
  await page.mouse.move(ex, ey, { steps: 12 })
  const guides = await page.evaluate(() => window.__pfSnapGuides())
  await page.mouse.up()
  if (opts.alt) await page.keyboard.up('Alt')
  await page.waitForTimeout(120)
  return { after: await chip(), guides }
}

// --- centre ------------------------------------------------------------------
const off = 4 / geo.zoom  // 4 screen px: inside the snap tolerance at any zoom
const mid = await dragCentreTo(geo.doc.w / 2 + off, geo.doc.h / 2 - off)
const midCentre = { x: mid.after.x + mid.after.w / 2, y: mid.after.y + mid.after.h / 2 }
console.log('aimed near centre ->', JSON.stringify(midCentre), 'guides', JSON.stringify(mid.guides))
check('dragging near the middle snaps exactly to the canvas centre',
  midCentre.x === geo.doc.w / 2 && midCentre.y === geo.doc.h / 2)
check('both a vertical and a horizontal guide appear', mid.guides.length === 2)
check('the guides are marked as centre lines',
  mid.guides.length === 2 && mid.guides.every((g) => g.kind === 'center'))
await page.screenshot({ path: path.join(OUT, '01-centre.png') })

// --- edges -------------------------------------------------------------------
const c0 = await chip()
const topLeft = await dragCentreTo(c0.w / 2 + off, c0.h / 2 + off)
console.log('aimed near top-left ->', JSON.stringify(topLeft.after))
check('dragging near the top-left snaps flush to both edges',
  topLeft.after.x === 0 && topLeft.after.y === 0)
check('edge guides are reported as edges',
  topLeft.guides.length === 2 && topLeft.guides.every((g) => g.kind === 'edge'))

const c1 = await chip()
const botRight = await dragCentreTo(geo.doc.w - c1.w / 2 - off, geo.doc.h - c1.h / 2 - off)
console.log('aimed near bottom-right ->', JSON.stringify(botRight.after))
check('dragging near the bottom-right snaps flush to those edges',
  botRight.after.x + botRight.after.w === geo.doc.w &&
  botRight.after.y + botRight.after.h === geo.doc.h)
await page.screenshot({ path: path.join(OUT, '02-edges.png') })

// --- no snap when far away ---------------------------------------------------
const free = await dragCentreTo(110, 70)
const freeCentre = { x: free.after.x + free.after.w / 2, y: free.after.y + free.after.h / 2 }
console.log('aimed at open space ->', JSON.stringify(freeCentre), 'guides', free.guides.length)
check('a drag well away from any line is left alone',
  Math.abs(freeCentre.x - 110) < 1.5 && Math.abs(freeCentre.y - 70) < 1.5)
check('no guides show when nothing is aligned', free.guides.length === 0)

// --- Alt escapes the snap ----------------------------------------------------
const escaped = await dragCentreTo(geo.doc.w / 2 + off, geo.doc.h / 2 - off, { alt: true })
const escCentre = { x: escaped.after.x + escaped.after.w / 2, y: escaped.after.y + escaped.after.h / 2 }
console.log('alt-drag near centre ->', JSON.stringify(escCentre))
check('holding Alt lets a layer sit just off the guide',
  Math.abs(escCentre.x - (geo.doc.w / 2 + off)) < 1.5 &&
  Math.abs(escCentre.y - (geo.doc.h / 2 - off)) < 1.5)
check('no guides are drawn while Alt is held', escaped.guides.length === 0)

// --- guides clear afterwards -------------------------------------------------
check('guides are cleared once the drag ends',
  (await page.evaluate(() => window.__pfSnapGuides())).length === 0)

// --- lining up with another layer -------------------------------------------------
// Snapping only to the canvas is the useful half of nothing: laying a word over
// a picture, what it has to line up with is the other word.
const pair = await page.evaluate(async () => {
  const st = window.__pfState()
  st.setPlaying(false)
  st.setTool('move')
  st.doc.layers.forEach((l) => st.removeLayers([l.id]))
  await new Promise((r) => setTimeout(r, 300))
  const { makeShapeLayer } = window.__pfStore
  const anchor = window.__pfState().addLayer(makeShapeLayer({
    shape: 'rect', x: 200, y: 120, w: 300, h: 80, fill: '#ff0000',
    stroke: 'none', strokeWidth: 0, radius: 0,
  }))
  const mover = window.__pfState().addLayer(makeShapeLayer({
    shape: 'rect', x: 260, y: 300, w: 120, h: 60, fill: '#00c000',
    stroke: 'none', strokeWidth: 0, radius: 0,
  }))
  window.__pfState().select([mover.id])
  await new Promise((r) => setTimeout(r, 350))
  const v = window.__pfState().view
  const box = document.querySelector('.stage canvas').getBoundingClientRect()
  const at = (x, y) => ({ x: box.left + v.panX + x * v.zoom, y: box.top + v.panY + y * v.zoom })
  return { anchor: anchor.id, mover: mover.id, grab: at(320, 330), zoom: v.zoom }
})

// Dragged so the mover's left edge lands three pixels short of the anchor's.
await page.mouse.move(pair.grab.x, pair.grab.y)
await page.mouse.down()
await page.mouse.move(pair.grab.x + (200 - 260 + 3) * pair.zoom, pair.grab.y, { steps: 10 })
const held = await page.evaluate(() => ({
  guides: (window.__pfSnapGuides() || []).map((g) => ({
    axis: g.axis, at: Math.round(g.at), kind: g.kind,
    span: g.span ? [Math.round(g.span.from), Math.round(g.span.to)] : null,
  })),
  x: Math.round(window.__pfState().doc.layers.find((l) => l.fill === '#00c000').x),
}))
await page.mouse.up()
await page.waitForTimeout(200)
console.log('dragged alongside another layer:', JSON.stringify(held))
check('a layer lines up with another layer, not just the canvas', held.x === 200, String(held.x))
check('and the guide says it was a layer it landed on',
  held.guides.some((g) => g.kind === 'layer' && g.at === 200), JSON.stringify(held.guides))
// A line across the whole frame claims agreement with everything it crosses.
check('the guide reaches between the two boxes and no further',
  held.guides[0]?.span?.[0] === 120 && held.guides[0]?.span?.[1] === 360,
  JSON.stringify(held.guides[0]?.span))
check('and it stays where it was put', await page.evaluate(
  () => Math.round(window.__pfState().doc.layers.find((l) => l.fill === '#00c000').x)) === 200)

// Nothing snaps to itself: a layer that did would refuse to leave where it was.
const alone = await page.evaluate(async () => {
  const st = window.__pfState()
  const mover = st.doc.layers.find((l) => l.fill === '#00c000')
  st.removeLayers([st.doc.layers.find((l) => l.fill === '#ff0000').id])
  await new Promise((r) => setTimeout(r, 300))
  return { x: Math.round(mover.x) }
})
const box2 = await page.evaluate(() => {
  const v = window.__pfState().view
  const r = document.querySelector('.stage canvas').getBoundingClientRect()
  const l = window.__pfState().doc.layers.find((x) => x.fill === '#00c000')
  return {
    grab: { x: r.left + v.panX + (l.x + 60) * v.zoom, y: r.top + v.panY + (l.y + 30) * v.zoom },
    zoom: v.zoom,
  }
})
await page.mouse.move(box2.grab.x, box2.grab.y)
await page.mouse.down()
await page.mouse.move(box2.grab.x + 40 * box2.zoom, box2.grab.y + 20 * box2.zoom, { steps: 8 })
await page.mouse.up()
await page.waitForTimeout(200)
const freed = await page.evaluate(
  () => Math.round(window.__pfState().doc.layers.find((l) => l.fill === '#00c000').x))
console.log('with nothing else on the canvas:', alone.x, '->', freed)
check('a layer does not snap to where it already is', freed > alone.x + 20, `${alone.x} -> ${freed}`)

console.log(errors.length ? 'CONSOLE ERRORS: ' + errors.slice(0, 5).join(' | ') : 'no console errors')
await browser.close()
process.exit(checks.some(([, ok]) => !ok) ? 1 : 0)
