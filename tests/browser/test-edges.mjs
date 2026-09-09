// Edge finding and the live-wire path, on shapes whose edges are known exactly.
//
// Run in a browser rather than plain node: buildEdgeMap draws through a canvas,
// which is the only sane way to accept an image, a video frame or a bitmap
// without three code paths. The shapes are drawn here, so every assertion is
// against a boundary whose position is arithmetic rather than opinion.
import { chromium } from 'playwright-core'

const browser = await chromium.launch({
  executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  headless: true,
})
const page = await browser.newPage()
page.on('pageerror', (e) => console.log('PAGEERROR', e.message))
await page.goto('http://localhost:5173/', { waitUntil: 'networkidle' })

const checks = []
const check = (name, ok, detail = '') => {
  checks.push([name, ok])
  console.log((ok ? 'PASS  ' : 'FAIL  ') + name + (detail ? '  — ' + detail : ''))
}

const run = (fn, arg) => page.evaluate(fn, arg)

// --- a bright square on a dark ground -------------------------------------------
const square = await run(async () => {
  const E = window.__pfEdges
  const c = document.createElement('canvas')
  c.width = 200
  c.height = 200
  const x = c.getContext('2d')
  x.fillStyle = '#101014'
  x.fillRect(0, 0, 200, 200)
  x.fillStyle = '#e8e8f0'
  x.fillRect(50, 50, 100, 100)
  const map = E.buildEdgeMap(c, 200)
  const at = (px, py) => map.grad[Math.round(py) * map.w + Math.round(px)]
  return {
    w: map.w,
    h: map.h,
    onEdge: +at(50, 100).toFixed(3),
    insideFlat: +at(100, 100).toFixed(3),
    outsideFlat: +at(20, 20).toFixed(3),
  }
})
console.log('square:', JSON.stringify(square))
check('an edge map is built at working size', square.w === 200 && square.h === 200)
check('the boundary is a strong edge', square.onEdge > 0.5, String(square.onEdge))
check('flat interior is not', square.insideFlat < 0.02, String(square.insideFlat))
check('and neither is flat background', square.outsideFlat < 0.02, String(square.outsideFlat))

// --- a colour edge at constant brightness ------------------------------------------
// The case that matters for artwork in one hue: green on grey at the same
// luminance. A luminance-only gradient sees nothing here.
const colour = await run(async () => {
  const E = window.__pfEdges
  const c = document.createElement('canvas')
  c.width = 120
  c.height = 60
  const x = c.getContext('2d')
  // Two colours chosen to have near-identical luma, very different hue.
  x.fillStyle = 'rgb(0, 160, 0)'
  x.fillRect(0, 0, 60, 60)
  x.fillStyle = 'rgb(120, 120, 120)'
  x.fillRect(60, 0, 60, 60)
  const px = x.getImageData(0, 0, 120, 60).data
  const luma = (i) => 0.2126 * px[i] + 0.7152 * px[i + 1] + 0.0722 * px[i + 2]
  const map = E.buildEdgeMap(c, 120)
  return {
    lumaLeft: Math.round(luma((30 * 120 + 30) * 4)),
    lumaRight: Math.round(luma((30 * 120 + 90) * 4)),
    atSeam: +map.grad[30 * map.w + 60].toFixed(3),
  }
})
console.log('colour seam:', JSON.stringify(colour))
check('the two colours are close in brightness',
  Math.abs(colour.lumaLeft - colour.lumaRight) < 22,
  `${colour.lumaLeft} vs ${colour.lumaRight}`)
check('and the colour seam is still found', colour.atSeam > 0.5, String(colour.atSeam))

// --- the live-wire follows the edge -------------------------------------------------
const path = await run(async () => {
  const E = window.__pfEdges
  const c = document.createElement('canvas')
  c.width = 200
  c.height = 200
  const x = c.getContext('2d')
  x.fillStyle = '#101014'
  x.fillRect(0, 0, 200, 200)
  x.fillStyle = '#e8e8f0'
  x.fillRect(50, 50, 100, 100)
  const map = E.buildEdgeMap(c, 200)
  // Two corners of the square, asked for across the *inside*. A straight line
  // would cut through the middle; the edge runs around the side.
  const p = E.livewire(map, { x: 50, y: 55 }, { x: 50, y: 145 })
  const offEdge = p.filter((q) => Math.abs(q.x - 50) > 3).length
  // And a diagonal, where the cheap route is along two sides rather than through.
  const d = E.livewire(map, { x: 55, y: 50 }, { x: 145, y: 150 })
  const throughMiddle = d.filter((q) => q.x > 70 && q.x < 130 && q.y > 70 && q.y < 130).length
  return { n: p.length, offEdge, diag: d.length, throughMiddle }
})
console.log('live-wire:', JSON.stringify(path))
check('a path is returned', path.n > 40, `${path.n} points`)
check('and it hugs the edge rather than cutting across',
  path.offEdge <= 4, `${path.offEdge} points off the edge`)
check('a diagonal request goes around, not through the middle',
  path.throughMiddle === 0, `${path.throughMiddle} points inside`)

// --- snapping an approximate outline onto the boundary ---------------------------------
const snapped = await run(async () => {
  const E = window.__pfEdges
  const c = document.createElement('canvas')
  c.width = 200
  c.height = 200
  const x = c.getContext('2d')
  x.fillStyle = '#101014'
  x.fillRect(0, 0, 200, 200)
  x.fillStyle = '#e8e8f0'
  x.fillRect(50, 50, 100, 100)
  const map = E.buildEdgeMap(c, 200)
  // An outline three pixels inside the true boundary, like a matte traced at a
  // lower resolution than the picture.
  const loose = [
    { x: 53, y: 70 }, { x: 53, y: 100 }, { x: 53, y: 130 },
    { x: 100, y: 53 }, { x: 130, y: 53 },
  ]
  const tight = E.snapToEdges(loose, map, { radius: 5 })
  const err = (pts, want, axis) => Math.max(...pts.map((p) => Math.abs(p[axis] - want)))
  return {
    beforeLeft: err(loose.slice(0, 3), 50, 'x'),
    afterLeft: err(tight.slice(0, 3), 50, 'x'),
    beforeTop: err(loose.slice(3), 50, 'y'),
    afterTop: err(tight.slice(3), 50, 'y'),
  }
})
console.log('snapping:', JSON.stringify(snapped))
check('an outline inside the boundary is pulled onto it',
  snapped.afterLeft < snapped.beforeLeft && snapped.afterLeft <= 1,
  `${snapped.beforeLeft}px out -> ${snapped.afterLeft}px`)
check('on both axes', snapped.afterTop < snapped.beforeTop && snapped.afterTop <= 1,
  `${snapped.beforeTop}px out -> ${snapped.afterTop}px`)

// --- it refuses to invent an edge ------------------------------------------------------
const flat = await run(async () => {
  const E = window.__pfEdges
  const c = document.createElement('canvas')
  c.width = 80
  c.height = 80
  const x = c.getContext('2d')
  x.fillStyle = '#303038'
  x.fillRect(0, 0, 80, 80)
  const map = E.buildEdgeMap(c, 80)
  const pts = [{ x: 40, y: 40 }, { x: 20, y: 60 }]
  const out = E.snapToEdges(pts, map, { radius: 6 })
  return out.map((p, i) => p.x === pts[i].x && p.y === pts[i].y)
})
// On a soft boundary the strongest thing nearby may be noise, and dragging an
// outline onto noise is worse than leaving it where the model put it.
check('with no edge nearby the points are left alone', flat.every(Boolean), JSON.stringify(flat))

console.log(checks.filter(([, o]) => o).length + ' of ' + checks.length + ' passed')
await browser.close()
process.exit(checks.some(([, ok]) => !ok) ? 1 : 0)
