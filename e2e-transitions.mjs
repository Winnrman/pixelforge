// Transitions, on rendered pixels.
//
// test-transitions.mjs checks the arithmetic. This checks the thing that
// actually matters: that dragging one clip over another makes the picture turn
// into the other one, and that halfway through a dissolve the frame is genuinely
// half of each rather than half of one over a hole.
import { chromium } from 'playwright-core'
import { importAndPlace } from './e2e-helpers.mjs'
import fs from 'fs'
import path from 'path'

const OUT = 'shots-transitions'
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

// Two flat colours, one per clip, so every pixel of every frame has a right
// answer that can be stated in advance.
const setup = await page.evaluate(async () => {
  const make = async (colour, name) => {
    const c = document.createElement('canvas')
    c.width = 200
    c.height = 120
    const x = c.getContext('2d')
    x.fillStyle = colour
    x.fillRect(0, 0, 200, 120)
    const blob = await new Promise((r) => c.toBlob(r, 'image/png'))
    return window.__pfAssets.loadImageFile(new File([blob], name, { type: 'image/png' }))
  }
  const red = await make('#c81414', 'red.png')
  const blue = await make('#1414c8', 'blue.png')
  const st = window.__pfState()
  st.placeMedia([red.id], { resizeDocToFirst: true })
  await new Promise((r) => setTimeout(r, 400))
  window.__pfState().placeMedia([blue.id])
  await new Promise((r) => setTimeout(r, 400))
  window.__pfState().setPlaying(false)

  // Two clips on one track: red for a second, then blue.
  const s = window.__pfState()
  const [a, b] = s.doc.layers
  s.updateLayer(a.id, { track: 0, clip: { start: 0, in: 0, out: 1000 } })
  window.__pfState().updateLayer(b.id, { track: 0, clip: { start: 1000, in: 0, out: 1000 } })
  await new Promise((r) => setTimeout(r, 200))
  return { a: a.id, b: b.id, w: window.__pfState().doc.width, h: window.__pfState().doc.height }
})
console.log('fixture:', JSON.stringify(setup))

/** The average colour of the whole frame at a time, and where it sits red-to-blue. */
const frameAt = (t, box = null) => page.evaluate(([time, b]) => {
  const st = window.__pfState()
  const c = document.createElement('canvas')
  c.width = st.doc.width
  c.height = st.doc.height
  const ctx = c.getContext('2d', { willReadFrequently: true })
  window.__pfRender.renderDocument(ctx, st.doc, time)
  const r = b || { x: 0, y: 0, w: st.doc.width, h: st.doc.height }
  const d = ctx.getImageData(r.x, r.y, r.w, r.h).data
  let red = 0
  let green = 0
  let blue = 0
  let alpha = 0
  const n = d.length / 4
  for (let i = 0; i < d.length; i += 4) {
    red += d[i]
    green += d[i + 1]
    blue += d[i + 2]
    alpha += d[i + 3]
  }
  return {
    r: Math.round(red / n), g: Math.round(green / n), b: Math.round(blue / n),
    a: Math.round(alpha / n),
  }
}, [t, box])

// --- a plain cut, before anything overlaps ------------------------------------
const cutA = await frameAt(500)
const cutB = await frameAt(1500)
console.log('as a straight cut:', JSON.stringify(cutA), JSON.stringify(cutB))
check('the first clip plays first', cutA.r > 180 && cutA.b < 40, JSON.stringify(cutA))
check('and the second one after it', cutB.b > 180 && cutB.r < 40, JSON.stringify(cutB))
check('with nothing mixing in between', (await frameAt(999)).r > 180)

// --- drag the second clip back so they lap over each other ---------------------
const lapped = await page.evaluate(async (s) => {
  // 400ms of overlap: the second clip starts before the first has finished.
  window.__pfState().slideClip(s.b, 600)
  await new Promise((r) => setTimeout(r, 250))
  const st = window.__pfState()
  const pairs = window.__pfTransitions.pairsIn(st.doc.layers, (l) => window.__pfAssets.getAsset(l.assetId))
  return {
    pairs: pairs.length,
    length: pairs[0] ? Math.round(pairs[0].length) : 0,
    kind: pairs[0]?.kind,
    stored: st.doc.layers.find((l) => l.id === s.b).transition ?? null,
  }
}, setup)
console.log('after dragging them together:', JSON.stringify(lapped))
check('overlapping two clips makes a transition', lapped.pairs === 1)
check('as long as the overlap', lapped.length === 400, `${lapped.length}ms`)
check('and it is a crossfade without being asked', lapped.kind === 'crossfade')
// The whole point of the design: there is no object at the join to keep in step.
check('with nothing stored anywhere to say so', lapped.stored === null,
  JSON.stringify(lapped.stored))

// --- the dissolve itself --------------------------------------------------------
const quarter = await frameAt(700)
const half = await frameAt(800)
const threeQ = await frameAt(900)
console.log('through the dissolve:', JSON.stringify([quarter, half, threeQ]))
check('a quarter of the way through it is mostly the first clip',
  quarter.r > quarter.b, JSON.stringify(quarter))
check('halfway it is half of each',
  Math.abs(half.r - half.b) < 30 && half.r > 45 && half.b > 45, JSON.stringify(half))
check('three quarters through it is mostly the second',
  threeQ.b > threeQ.r, JSON.stringify(threeQ))
check('and it travels one way, not back and forth',
  quarter.b < half.b && half.b < threeQ.b,
  `${quarter.b} -> ${half.b} -> ${threeQ.b}`)

// A dissolve must not sag: drawing both at partial alpha over a transparent
// canvas darkens the middle, which is the bug the alpha maths exists to avoid.
check('the frame stays fully opaque all the way through',
  half.a > 250 && quarter.a > 250 && threeQ.a > 250,
  `alphas ${quarter.a}, ${half.a}, ${threeQ.a}`)
const brightness = (c) => c.r + c.g + c.b
check('and does not sag dark in the middle',
  brightness(half) > brightness(cutA) * 0.85,
  `${brightness(half)} against ${brightness(cutA)} at full`)
await page.screenshot({ path: path.join(OUT, '01-crossfade.png') })

// --- stacking order must not decide what a dissolve looks like -------------------
const restacked = await page.evaluate(async (s) => {
  const st = window.__pfState()
  // Put the arriving clip *underneath*, which is the order a user can easily end
  // up in and which the naive maths gets wrong.
  const layers = st.doc.layers.slice().reverse()
  st.setDoc?.({ ...st.doc, layers }) ?? window.__pfState().reorderLayers?.(layers)
  await new Promise((r) => setTimeout(r, 200))
  return window.__pfState().doc.layers.map((l) => l.id)
}, setup)
const halfSwapped = await frameAt(800)
console.log('with the layers stacked the other way:', JSON.stringify(restacked), JSON.stringify(halfSwapped))
check('the dissolve looks the same whichever way the layers are stacked',
  Math.abs(halfSwapped.r - half.r) < 30 && Math.abs(halfSwapped.b - half.b) < 30,
  `${JSON.stringify(half)} against ${JSON.stringify(halfSwapped)}`)

// --- the other kinds --------------------------------------------------------------
const setKind = async (kind) => {
  await page.evaluate(([id, k]) => window.__pfState().setTransitionKind(id, k), [setup.b, kind])
  await page.waitForTimeout(150)
}

await setKind('black')
const dipEarly = await frameAt(700)
const dipMid = await frameAt(800)
const dipLate = await frameAt(900)
console.log('dipping to black:', JSON.stringify([dipEarly, dipMid, dipLate]))
check('a dip to black goes dark in the middle',
  brightness(dipMid) < brightness(dipEarly) * 0.2 && brightness(dipMid) < 40,
  `${brightness(dipEarly)} -> ${brightness(dipMid)} -> ${brightness(dipLate)}`)
check('and comes out the other side as the second clip',
  dipLate.b > dipLate.r, JSON.stringify(dipLate))
check('with the first clip still itself on the way in',
  dipEarly.r > dipEarly.b, JSON.stringify(dipEarly))

await setKind('white')
const whiteMid = await frameAt(800)
console.log('dipping to white:', JSON.stringify(whiteMid))
check('a dip to white goes bright instead',
  whiteMid.r > 200 && whiteMid.g > 200 && whiteMid.b > 200, JSON.stringify(whiteMid))

await setKind('wipe')
const wipeLeft = await frameAt(800, { x: 4, y: 40, w: 40, h: 40 })
const wipeRight = await frameAt(800, { x: 156, y: 40, w: 40, h: 40 })
console.log('wiping:', JSON.stringify(wipeLeft), JSON.stringify(wipeRight))
check('a wipe has the new clip on one side and the old on the other',
  wipeLeft.b > wipeLeft.r && wipeRight.r > wipeRight.b,
  `left ${JSON.stringify(wipeLeft)}, right ${JSON.stringify(wipeRight)}`)
check('and both sides are solid — a wipe is an edge, not a fade',
  wipeLeft.a > 250 && wipeRight.a > 250)
await page.screenshot({ path: path.join(OUT, '02-wipe.png') })

await setKind('wipe-back')
const backLeft = await frameAt(800, { x: 4, y: 40, w: 40, h: 40 })
console.log('wiping the other way:', JSON.stringify(backLeft))
check('the other direction wipes the other way', backLeft.r > backLeft.b,
  JSON.stringify(backLeft))

// --- pulling them apart ends it ------------------------------------------------
await setKind('crossfade')
const apart = await page.evaluate(async (s) => {
  window.__pfState().slideClip(s.b, 1000)
  await new Promise((r) => setTimeout(r, 250))
  const st = window.__pfState()
  return window.__pfTransitions.pairsIn(
    st.doc.layers, (l) => window.__pfAssets.getAsset(l.assetId)).length
}, setup)
console.log('after pulling them apart:', apart)
check('pulling the clips apart ends the transition', apart === 0)
check('and the cut is a cut again', (await frameAt(999)).r > 180)

// --- and it is on the timeline ---------------------------------------------------
// The flat colours above are stills, and the Video tab lists time-based media,
// so the marker needs real footage under it: the same GIF placed twice, cut into
// two clips that lap.
const onTimeline = await page.evaluate(async () => {
  window.__pfState().resetDoc()
  await new Promise((r) => setTimeout(r, 300))
  return true
})
await importAndPlace(page, 'public/test/motion.gif', { timeout: 20000 })
await page.evaluate(async () => {
  const s = window.__pfState()
  s.placeMedia([s.doc.media[s.doc.media.length - 1]])
  await new Promise((r) => setTimeout(r, 600))
  window.__pfState().setPlaying(false)
  const st = window.__pfState()
  const [a, b] = st.doc.layers
  st.updateLayer(a.id, { track: 0, clip: { start: 0, in: 0, out: 1000 } })
  window.__pfState().updateLayer(b.id, { track: 0, clip: { start: 600, in: 0, out: 1000 } })
  await new Promise((r) => setTimeout(r, 300))
})

const marker = await page.evaluate(async () => {
  const btn = [...document.querySelectorAll('button')].find((b) => /^Video/.test(b.textContent))
  if (btn) btn.click()
  await new Promise((r) => setTimeout(r, 900))
  const el = document.querySelector('.clip-transition')
  return {
    shown: !!el,
    title: el?.getAttribute('title') || '',
    width: el ? Math.round(parseFloat(el.style.width)) : 0,
    strips: document.querySelectorAll('.strip').length,
  }
})
console.log('on the timeline:', JSON.stringify(marker))
check('the clips are on the timeline', marker.strips >= 2, `${marker.strips} strips`)
check('and the overlap is drawn on the arriving one', marker.shown)
check('as wide a share of that clip as the overlap is of its length',
  Math.abs(marker.width - 40) < 8, `${marker.width}% of a 1000ms clip lapped by 400ms`)
check('saying what it is and how long it takes',
  /Crossfade/.test(marker.title) && /0\.40s/.test(marker.title), marker.title)
await page.screenshot({ path: path.join(OUT, '03-timeline.png') })

console.log(errors.length ? 'CONSOLE ERRORS: ' + errors.slice(0, 5).join(' | ') : 'no console errors')
await browser.close()
process.exit(checks.some(([, ok]) => !ok) ? 1 : 0)
