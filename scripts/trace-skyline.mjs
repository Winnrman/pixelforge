// Tracing the skyline out of a photograph, so text can pass behind it.
//
// The sky is blue and everything built is not: sampled across this frame, sky
// pixels run 43 to 71 more blue than red, while the shell, the glazing, the
// plaza and the distant city all come out negative. One threshold separates
// them, which no amount of eyeballing the picture would have told me.
//
// The cloud on the right is the exception — near neutral, so it reads as "not
// sky" — and it is dealt with by keeping only what is connected to the ground.
// A cloud is an island; a building is not.
import { chromium } from 'playwright-core'
import fs from 'fs'

const file = process.argv[2] || 'examples/building.jpg'
const b = await chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true })
const page = await b.newPage()
await page.goto('data:text/html,<body></body>')
const data = 'data:image/jpeg;base64,' + fs.readFileSync(file).toString('base64')

const out = await page.evaluate(async (src) => {
  const img = new Image()
  await new Promise((r, j) => { img.onload = r; img.onerror = j; img.src = src })
  const c = document.createElement('canvas')
  c.width = img.width
  c.height = img.height
  const ctx = c.getContext('2d', { willReadFrequently: true })
  ctx.drawImage(img, 0, 0)
  const d = ctx.getImageData(0, 0, c.width, c.height).data
  const W = c.width
  const H = c.height

  const solid = new Uint8Array(W * H)
  for (let i = 0, p = 0; i < d.length; i += 4, p++) {
    solid[p] = (d[i + 2] - d[i]) < 20 ? 1 : 0
  }

  // Everything joined to the ground. A cloud is an island; a building is not.
  const keep = new Uint8Array(W * H)
  const stack = []
  for (let x = 0; x < W; x++) {
    const p = (H - 1) * W + x
    if (solid[p]) { keep[p] = 1; stack.push(p) }
  }
  while (stack.length) {
    const p = stack.pop()
    const x = p % W
    const y = (p - x) / W
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = x + dx
      const ny = y + dy
      if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue
      const q = ny * W + nx
      if (solid[q] && !keep[q]) { keep[q] = 1; stack.push(q) }
    }
  }

  const line = []
  for (let x = 0; x < W; x++) {
    let top = H
    for (let y = 0; y < H; y++) if (keep[y * W + x]) { top = y; break }
    line.push(top)
  }
  // A roofline is a curve, not a comb: a light median through the jpeg noise.
  const smooth = line.map((_, i) => {
    const win = []
    for (let k = -3; k <= 3; k++) { const j = i + k; if (j >= 0 && j < line.length) win.push(line[j]) }
    win.sort((p, q) => p - q)
    return win[Math.floor(win.length / 2)]
  })
  const lowest = Math.min(...smooth)
  return { w: W, h: H, line: smooth, crest: { x: smooth.indexOf(lowest), y: lowest } }
}, data)

fs.writeFileSync('/tmp/skyline.json', JSON.stringify(out))
console.log(`${out.w}x${out.h}  crest at x=${out.crest.x} y=${out.crest.y}`)
console.log('roofline:', out.line.filter((_, i) => i % 50 === 0).join(' '))
await b.close()
