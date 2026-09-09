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

// --- the picture's own colours, under every colour control -------------------------------
// A cover looks designed rather than assembled when the type picks up a colour
// that is in the photograph. Nothing is turned on for this: the palette is read
// back off whatever picture is on the canvas.
const palette = await page.evaluate(async () => {
  const st = window.__pfState()
  st.resetDoc()
  await new Promise((r) => setTimeout(r, 300))
  // Two thirds teal, one third orange, and nothing else.
  const c = document.createElement('canvas')
  c.width = 300
  c.height = 300
  const g = c.getContext('2d')
  g.fillStyle = '#0d6e6e'
  g.fillRect(0, 0, 300, 200)
  g.fillStyle = '#e07a1f'
  g.fillRect(0, 200, 300, 100)
  const blob = await new Promise((r) => c.toBlob(r))
  await st.addImages([new File([blob], 'two-tone.png', { type: 'image/png' })], { place: true })
  await new Promise((r) => setTimeout(r, 1500))

  const colours = window.__pfState().palette
  // And that they reach the controls rather than only the store.
  window.__pfState().setTool('shape')
  const { makeShapeLayer } = window.__pfStore
  const sh = makeShapeLayer({ x: 10, y: 10, w: 40, h: 40, fill: '#ffffff' })
  window.__pfState().addLayer(sh)
  await new Promise((r) => setTimeout(r, 600))
  const dots = [...document.querySelectorAll('.inspector .swatch-dot')]
  const first = dots[0]
  const before = window.__pfState().doc.layers.find((x) => x.id === sh.id).fill
  first?.click()
  await new Promise((r) => setTimeout(r, 400))
  const after = window.__pfState().doc.layers.find((x) => x.id === sh.id).fill
  return { colours, dots: dots.length, swatch: first?.style.background || '', before, after }
})
console.log('palette:', JSON.stringify(palette))
check('the picture is read for its colours without being asked',
  palette.colours.length >= 2, JSON.stringify(palette.colours))
// Most of the frame first, so the colour offered first is the one the picture is
// mostly made of.
check('and the one it is mostly made of comes first',
  /^#0[cd]6[cde]6[cde]$/.test(palette.colours[0]), palette.colours[0])
check('the other one is there too',
  palette.colours.some((c) => /^#e0[78]/.test(c)), JSON.stringify(palette.colours))
check('they appear under the colour controls', palette.dots > 0, String(palette.dots))
check('and clicking one sets the colour', palette.after !== palette.before,
  `${palette.before} -> ${palette.after}`)

// --- duotone ------------------------------------------------------------------------------
// A photograph reprinted in two inks. It goes in beside the other looks rather
// than in a panel of its own, because it is the same machinery: a palette
// mapping applied last in the draw.
const duo = await page.evaluate(async () => {
  const st = window.__pfState()
  const img = st.doc.layers.find((l) => l.type === 'image')
  const read = () => {
    const s2 = window.__pfState()
    const c = document.createElement('canvas')
    c.width = s2.doc.width
    c.height = s2.doc.height
    const g = c.getContext('2d', { willReadFrequently: true })
    window.__pfRender.renderDocument(g, s2.doc, 0)
    const at = (x, y) => [...g.getImageData(x, y, 1, 1).data].slice(0, 3)
    return { top: at(150, 60), bottom: at(150, 260) }
  }
  const before = read()
  window.__pfState().updateLayer(img.id, {
    retro: { on: true, preset: 'duotone', opts: { shadow: '#12123a', highlight: '#f2e3c2', contrast: 1 } },
  })
  await new Promise((r) => setTimeout(r, 500))
  return { before, after: read() }
})
console.log('duotone:', JSON.stringify(duo))
// Teal above, orange below: two hues. Afterwards both are on the line between
// one ink and the other, which is the whole of what a duotone is.
const onInkLine = (c) => {
  const lo = [0x12, 0x12, 0x3a]
  const hi = [0xf2, 0xe3, 0xc2]
  // Where this colour sits between the inks, judged on red, and how far the
  // other two channels stray from where that says they should be.
  const t = (c[0] - lo[0]) / (hi[0] - lo[0])
  const want = lo.map((v, i) => v + (hi[i] - v) * t)
  return Math.max(...c.map((v, i) => Math.abs(v - want[i])))
}
check('the picture had two different hues to begin with',
  Math.abs(duo.before.top[0] - duo.before.bottom[0]) > 100, JSON.stringify(duo.before))
check('after a duotone both are on the line between the two inks',
  onInkLine(duo.after.top) < 12 && onInkLine(duo.after.bottom) < 12, JSON.stringify(duo.after))
check('and the darker half is still the darker half',
  duo.after.top[0] < duo.after.bottom[0], JSON.stringify(duo.after))

console.log(errors.length ? 'CONSOLE ERRORS: ' + errors.slice(0, 5).join(' | ') : 'no console errors')
await browser.close()
process.exit(checks.some(([, ok]) => !ok) ? 1 : 0)
