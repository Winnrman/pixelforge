// The magnetic lasso, and edge-aware AI selection.
//
// The case that motivated both: artwork in one hue, where the subject and the
// background are the same brightness and differ only in colour, with a soft
// boundary between them. A luminance edge map finds nothing there, and a matte
// predicted at 512px lands near the outline rather than on it.
//
// So the fixture is built to be exactly that hard: a shape whose colour differs
// from the ground while its brightness barely does.
import { chromium } from 'playwright-core'
import fs from 'fs'
import path from 'path'

const OUT = 'shots/magnet'
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

// --- a deliberately hard picture ------------------------------------------------
const made = await page.evaluate(async () => {
  const c = document.createElement('canvas')
  c.width = 400
  c.height = 300
  const x = c.getContext('2d')
  // Ground and subject at nearly the same luminance, far apart in hue.
  x.fillStyle = 'rgb(64, 96, 64)'
  x.fillRect(0, 0, 400, 300)
  x.fillStyle = 'rgb(96, 78, 40)'
  x.beginPath()
  x.ellipse(200, 150, 110, 80, 0, 0, Math.PI * 2)
  x.fill()
  const blob = await new Promise((r) => c.toBlob(r, 'image/png'))
  const a = await window.__pfAssets.loadImageFile(
    new File([blob], 'hard.png', { type: 'image/png' }))
  window.__pfState().placeMedia([a.id], { resizeDocToFirst: true })
  await new Promise((r) => setTimeout(r, 300))
  const l = window.__pfState().doc.layers[0]

  // How close in brightness the two really are, and how strong the colour edge is.
  const px = x.getImageData(0, 0, 400, 300).data
  const luma = (i) => 0.2126 * px[i] + 0.7152 * px[i + 1] + 0.0722 * px[i + 2]
  const map = window.__pfEdges.edgeMapFor(
    window.__pfAssets.getAsset(l.assetId).frames?.[0]?.bitmap
    || window.__pfRender.sourceFor(l, 0))
  return {
    id: l.id,
    w: l.w, h: l.h,
    lumaGround: Math.round(luma((20 * 400 + 20) * 4)),
    lumaSubject: Math.round(luma((150 * 400 + 200) * 4)),
    // The ellipse's left edge at its widest is x=90, y=150.
    gradAtEdge: map ? +map.grad[Math.round(150 * map.scale) * map.w + Math.round(90 * map.scale)].toFixed(2) : null,
    gradInside: map ? +map.grad[Math.round(150 * map.scale) * map.w + Math.round(200 * map.scale)].toFixed(2) : null,
  }
})
console.log('hard fixture:', JSON.stringify(made))
check('the subject and ground are nearly the same brightness',
  Math.abs(made.lumaGround - made.lumaSubject) < 12,
  `${made.lumaGround} vs ${made.lumaSubject}`)
check('yet the boundary is found as a strong edge', made.gradAtEdge > 0.3,
  String(made.gradAtEdge))
check('and the flat interior is not', made.gradInside < 0.05, String(made.gradInside))

// --- the magnetic path follows the boundary --------------------------------------
const magnet = await page.evaluate((id) => {
  const st = window.__pfState()
  const l = st.doc.layers.find((x) => x.id === id)
  // Document coordinates. The layer was placed at the document's size, so image
  // pixels and document pixels line up here.
  const sx = l.x + l.w * (90 / 400)
  const sy = l.y + l.h * (110 / 300)
  const ex = l.x + l.w * (90 / 400)
  const ey = l.y + l.h * (190 / 300)
  const pathPts = st.magnetPath(id, [sx, sy], [ex, ey])

  // How far each point sits from the true ellipse, in image pixels.
  const cx = 200
  const cy = 150
  const rx = 110
  const ry = 80
  const err = pathPts.map(([dx, dy]) => {
    const ix = ((dx - l.x) / l.w) * 400
    const iy = ((dy - l.y) / l.h) * 300
    // Distance from the ellipse, measured along the ray from its centre.
    const ang = Math.atan2((iy - cy) / ry, (ix - cx) / rx)
    const ex2 = cx + rx * Math.cos(ang)
    const ey2 = cy + ry * Math.sin(ang)
    return Math.hypot(ix - ex2, iy - ey2)
  })
  // The ends are pinned to the points asked for, and those are deliberately off
  // the boundary — a rough drag starts wherever the hand happened to be. The
  // path has to travel from there to the edge, so the points either side of the
  // ends are on the approach. What is being claimed is what happens once it
  // arrives: the middle.
  const cut = Math.max(1, Math.round(err.length * 0.2))
  const middle = err.slice(cut, -cut)
  return {
    n: pathPts.length,
    profile: err.map((e) => Math.round(e)),
    ends: [+err[0].toFixed(1), +err[err.length - 1].toFixed(1)],
    worst: +Math.max(...middle).toFixed(1),
    mean: +(middle.reduce((a, b) => a + b, 0) / middle.length).toFixed(1),
  }
}, made.id)
console.log('magnetic path:', JSON.stringify(magnet))
check('the path has real detail, not two endpoints', magnet.n > 5, `${magnet.n} points`)
// The straight line between those two points cuts about 12px inside the
// ellipse at its middle; hugging the boundary is what beats that.
check('and it follows the boundary rather than cutting across',
  magnet.mean < 3, `mean ${magnet.mean}px off the true edge`)
check('and once on the edge it stays there', magnet.worst < 3,
  `worst in the middle ${magnet.worst}px, whole profile ${magnet.profile.join(',')}`)
// Said plainly, because it is the behaviour rather than a shortcoming: the path
// starts and ends exactly where it was asked to.
check('while the ends stay where the pointer put them',
  magnet.ends[0] > 8 && magnet.ends[1] > 8, `ends ${magnet.ends.join(' and ')}px out`)

// --- it degrades honestly where there is no edge -------------------------------------
const flat = await page.evaluate(async (id) => {
  const st = window.__pfState()
  const c = document.createElement('canvas')
  c.width = 200
  c.height = 200
  const x = c.getContext('2d')
  x.fillStyle = 'rgb(70, 70, 74)'
  x.fillRect(0, 0, 200, 200)
  const blob = await new Promise((r) => c.toBlob(r, 'image/png'))
  const a = await window.__pfAssets.loadImageFile(
    new File([blob], 'flat.png', { type: 'image/png' }))
  st.resetDoc()
  window.__pfState().placeMedia([a.id], { resizeDocToFirst: true })
  await new Promise((r) => setTimeout(r, 300))
  const l = window.__pfState().doc.layers[0]
  const p = window.__pfState().magnetPath(l.id, [l.x + 20, l.y + 20], [l.x + 150, l.y + 150])
  // Straight means every point sits on the line between the ends.
  const off = p.map(([px, py]) => {
    const t = ((px - (l.x + 20)) + (py - (l.y + 20))) / 2
    return Math.abs((px - (l.x + 20)) - t) + Math.abs((py - (l.y + 20)) - t)
  })
  return { n: p.length, worst: +Math.max(...off).toFixed(1) }
}, made.id)
console.log('on a flat picture:', JSON.stringify(flat))
// With nothing to follow it should run straight rather than wander looking for
// an edge that is not there.
check('with no edge to follow it runs straight', flat.worst < 6, `${flat.worst}px off the line`)

// --- the tool offers it ---------------------------------------------------------------
const ui = await page.evaluate(async () => {
  const st = window.__pfState()
  st.setTool('lasso')
  await new Promise((r) => setTimeout(r, 250))
  const labels = [...document.querySelectorAll('.rail-options .segmented button')]
    .map((b) => b.textContent.trim())
  const magneticBtn = [...document.querySelectorAll('.rail-options .segmented button')]
    .find((b) => /Magnetic/.test(b.textContent))
  magneticBtn?.click()
  await new Promise((r) => setTimeout(r, 200))
  return {
    labels,
    magnet: window.__pfState().toolOptions.magnet === true,
    ai: window.__pfState().toolOptions.aiSelect === true,
    hint: document.querySelector('.rail-options .rail-hint')?.textContent || '',

  }
})
// The explanation lives behind the (i) on the panel heading now — panels full of
// paragraphs were what it was moved out of. The bubble is painted on the render
// after the click, so it is read on the next tick.
ui.explained = await page.evaluate(async () => {
  document.querySelector('.rail-options .info-dot')?.click()
  await new Promise((r) => setTimeout(r, 200))
  return document.querySelector('.info-bubble')?.textContent || ''
})
console.log('lasso modes:', JSON.stringify(ui.labels), 'magnet on:', ui.magnet)
check('the lasso offers three modes', ui.labels.join(',') === 'Freehand,Magnetic,AI',
  ui.labels.join(','))
check('picking Magnetic turns it on', ui.magnet === true)
// The three are one choice, so turning one on has to turn the others off.
check('and turns AI off, because they are one choice', ui.ai === false)
check('with a line saying what to do', /drag/i.test(ui.hint), ui.hint)
check('and the (i) saying what it does', /finds the edge/.test(ui.explained),
  ui.hint.slice(0, 70))

await page.screenshot({ path: path.join(OUT, '01-magnet.png') })
console.log(errors.length ? 'CONSOLE ERRORS: ' + errors.slice(0, 5).join(' | ') : 'no console errors')
await browser.close()
process.exit(checks.some(([, ok]) => !ok) ? 1 : 0)
