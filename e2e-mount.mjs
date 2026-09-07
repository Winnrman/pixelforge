// Photo mounts on their own, outside a collage.
//
// The collage already prints tilted cards with a white border and a soft
// shadow. The same thing on a single image is the same code — what has to be
// true is that framing a picture does not change the picture: the card grows
// around it rather than the photo shrinking inside it.
import { chromium } from 'playwright-core'
import fs from 'fs'
import path from 'path'

const OUT = 'shots-mount'
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

const setup = await page.evaluate(async () => {
  const st = window.__pfState()
  const blob = await (await fetch('/test/room.png')).blob()
  const a = await window.__pfAssets.loadImageFile(new File([blob], 'room.png', { type: 'image/png' }))
  const made = st.placeMedia([a.id], { resizeDocToFirst: true })
  const l = window.__pfState().doc.layers.find((x) => x.id === made[0])
  return { id: l.id, x: l.x, y: l.y, w: l.w, h: l.h }
})
await page.waitForTimeout(300)
console.log('before:', JSON.stringify(setup))
check('an image on the canvas', !!setup.id)

// --- mounting it ------------------------------------------------------------------
const mounted = await page.evaluate((id) => {
  window.__pfState().mountLayers([id], 'polaroid', { border: 0.05 })
  const l = window.__pfState().doc.layers.find((x) => x.id === id)
  return {
    frame: l.frame,
    x: l.x, y: l.y, w: l.w, h: l.h,
    // Where the picture sits inside the card.
    picX: l.x + l.w * l.frame.insets.l,
    picY: l.y + l.h * l.frame.insets.t,
    picW: l.w * (1 - l.frame.insets.l - l.frame.insets.r),
    picH: l.h * (1 - l.frame.insets.t - l.frame.insets.b),
  }
}, setup.id)
console.log('after:', JSON.stringify(mounted))
check('the layer gains a mount', !!mounted.frame?.on)
check('with a deep chin, which is what makes it a Polaroid',
  mounted.frame.insets.b > mounted.frame.insets.t * 2,
  `top ${mounted.frame.insets.t}, bottom ${mounted.frame.insets.b}`)
check('and a shadow', mounted.frame.shadow > 0, `${mounted.frame.shadow}px`)

// The claim that matters: the photo is where it was, at the size it was.
check('the picture is exactly the size it was',
  Math.abs(mounted.picW - setup.w) < 0.6 && Math.abs(mounted.picH - setup.h) < 0.6,
  `${mounted.picW.toFixed(1)}x${mounted.picH.toFixed(1)} against ${setup.w}x${setup.h}`)
check('and exactly where it was',
  Math.abs(mounted.picX - setup.x) < 0.6 && Math.abs(mounted.picY - setup.y) < 0.6,
  `${mounted.picX.toFixed(1)},${mounted.picY.toFixed(1)} against ${setup.x},${setup.y}`)
check('so the card is bigger than the photo', mounted.w > setup.w && mounted.h > setup.h,
  `${mounted.w.toFixed(0)}x${mounted.h.toFixed(0)}`)

// --- changing style keeps the photo put ------------------------------------------------
const swapped = await page.evaluate((id) => {
  window.__pfState().mountLayers([id], 'border', { border: 0.05 })
  const l = window.__pfState().doc.layers.find((x) => x.id === id)
  return {
    insets: l.frame.insets,
    picW: l.w * (1 - l.frame.insets.l - l.frame.insets.r),
    picH: l.h * (1 - l.frame.insets.t - l.frame.insets.b),
  }
}, setup.id)
console.log('as an even border:', JSON.stringify(swapped))
check('an even border has an even border',
  Math.abs(swapped.insets.b - swapped.insets.t) < 0.001, JSON.stringify(swapped.insets))
// Switching mounts must not shrink the photo a little each time.
check('and the picture is still its original size',
  Math.abs(swapped.picW - setup.w) < 0.6 && Math.abs(swapped.picH - setup.h) < 0.6,
  `${swapped.picW.toFixed(1)}x${swapped.picH.toFixed(1)}`)

const off = await page.evaluate((id) => {
  window.__pfState().mountLayers([id], 'none')
  const l = window.__pfState().doc.layers.find((x) => x.id === id)
  return { frame: l.frame, w: l.w }
}, setup.id)
check('taking the mount off removes it', !off.frame)

// --- it is drawn ---------------------------------------------------------------------
// Placed rather than mounted in place: the document here is exactly the photo's
// size, so a card grown around it sits entirely off-canvas — correct, and
// invisible. Placing chooses a size, so it is placing that has to make room.
const placedForDrawing = await page.evaluate(async () => {
  const st = window.__pfState()
  st.resetDoc()
  const blob = await (await fetch('/test/room.png')).blob()
  const a = await window.__pfAssets.loadImageFile(new File([blob], 'shot.png', { type: 'image/png' }))
  const made = window.__pfState().placeMounted([a.id], 'polaroid')
  const l = window.__pfState().doc.layers.find((x) => x.id === made[0])
  const d = window.__pfState().doc
  return { fits: l.x >= -1 && l.y >= -1 && l.x + l.w <= d.width + 1 && l.y + l.h <= d.height + 1 }
})
check('a placed card fits inside the canvas', placedForDrawing.fits)

const drawn = await page.evaluate(() => {
  const st = window.__pfState()
  const c = document.createElement('canvas')
  c.width = st.doc.width
  c.height = st.doc.height
  const ctx = c.getContext('2d', { willReadFrequently: true })
  window.__pfRender.renderDocument(ctx, st.doc, 0)
  const d = ctx.getImageData(0, 0, c.width, c.height).data
  let white = 0
  for (let i = 0; i < d.length; i += 4) {
    if (d[i + 3] > 200 && d[i] > 235 && d[i + 1] > 235 && d[i + 2] > 235) white++
  }
  return white
})
console.log('white card pixels:', drawn)
check('the card actually renders', drawn > 400, `${drawn} white pixels`)
await page.screenshot({ path: path.join(OUT, '01-polaroid.png') })

// --- from the media view, in one gesture ------------------------------------------------
const fromBin = await page.evaluate(async () => {
  const st = window.__pfState()
  st.resetDoc()
  const blob = await (await fetch('/test/room.png')).blob()
  const a = await window.__pfAssets.loadImageFile(new File([blob], 'a.png', { type: 'image/png' }))
  const b = await window.__pfAssets.loadImageFile(new File([blob], 'b.png', { type: 'image/png' }))
  const made = window.__pfState().placeMounted([a.id, b.id], 'polaroid')
  const ls = window.__pfState().doc.layers.filter((l) => made.includes(l.id))
  return {
    n: ls.length,
    mounted: ls.every((l) => l.frame?.on),
    tilts: ls.map((l) => Math.round(l.rotation * 10) / 10),
  }
})
console.log('placed from the bin:', JSON.stringify(fromBin))
check('media can be placed already mounted', fromBin.n === 2 && fromBin.mounted)
// A stack of photos nobody straightened does not sit perfectly square.
check('and each one is tilted a little', fromBin.tilts.some((t) => t !== 0),
  fromBin.tilts.join(', '))
check('but not wildly', fromBin.tilts.every((t) => Math.abs(t) <= 5), fromBin.tilts.join(', '))

// --- the button is there ------------------------------------------------------------------
const ui = await page.evaluate(async () => {
  window.__pfState().setWorkspace('media')
  await new Promise((r) => setTimeout(r, 400))
  const all = [...document.querySelectorAll('.media-head button')]
  const polaroid = all.find((b) => /Polaroid/.test(b.textContent))
  return { btns: all.map((b) => b.textContent.trim()), disabled: polaroid?.disabled }
})
console.log('media buttons:', JSON.stringify(ui))
check('the media view offers it', ui.btns.some((b) => /Polaroid/.test(b)), ui.btns.join(' | '))
check('and it waits until something is picked', ui.disabled === true)

console.log(errors.length ? 'CONSOLE ERRORS: ' + errors.slice(0, 5).join(' | ') : 'no console errors')
await browser.close()
process.exit(checks.some(([, ok]) => !ok) ? 1 : 0)
