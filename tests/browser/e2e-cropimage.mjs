// Cropping a picture, as opposed to cropping the canvas.
//
// Two different things were called crop and neither did this. The crop tool
// resized the *document*. The framing sliders moved a window over the image
// without moving the layer, so the box kept its full width around a smaller
// picture and there was nothing to press to make it fit — "it keeps the same
// width while showing less".
//
// So the claims are: the crop tool acts on the selected picture and the box
// ends up the size of what was kept; framing can be made permanent; and both
// are still non-destructive, because everything else in this editor is.
import { chromium } from 'playwright-core'
import { importAndPlace } from '../e2e-helpers.mjs'
import fs from 'fs'
import path from 'path'

const OUT = 'shots/cropimage'
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
await importAndPlace(page, 'public/test/room.png', { timeout: 20000 })
await page.evaluate(() => { window.__pfState().setPlaying(false); window.__pfState().setTime(0) })
await page.waitForTimeout(400)

const geom = () => page.evaluate(() => {
  const l = window.__pfState().doc.layers.find((x) => x.type === 'image')
  return {
    id: l.id,
    x: Math.round(l.x), y: Math.round(l.y),
    w: Math.round(l.w), h: Math.round(l.h),
    src: l.src ? { x: +l.src.x.toFixed(3), y: +l.src.y.toFixed(3), w: +l.src.w.toFixed(3), h: +l.src.h.toFixed(3) } : null,
    crop: [l.cropT || 0, l.cropB || 0, l.cropL || 0, l.cropR || 0],
    doc: { w: window.__pfState().doc.width, h: window.__pfState().doc.height },
  }
})

const before = await geom()
console.log('before:', JSON.stringify(before))
check('an image to crop', before.w > 40 && before.h > 40)

// --- the crop tool, on the selected picture -----------------------------------------
const opened = await page.evaluate((id) => {
  const st = window.__pfState()
  st.select([id])
  st.setTool('crop')
  return true
}, before.id)
await page.waitForTimeout(300)
// The box opens on the thing it will act on: that is the only signal that this
// will crop the picture and not the canvas.
const box = await page.evaluate(() => {
  const hint = document.querySelector('.rail-options .rail-hint')?.textContent || ''
  return { hint }
})
console.log('rail hint:', JSON.stringify(box.hint.slice(0, 90)))
check('the tool says what it will crop', /room\.png/.test(box.hint), box.hint.slice(0, 80))

const cropped = await page.evaluate(() => {
  const st = window.__pfState()
  const l = st.doc.layers.find((x) => x.type === 'image')
  // The middle half of the picture.
  const rect = { x: l.x + l.w * 0.25, y: l.y + l.h * 0.25, w: l.w * 0.5, h: l.h * 0.5 }
  st.cropSelectedTo(rect)
  return rect
})
await page.waitForTimeout(250)
const after = await geom()
console.log('after cropping to the middle half:', JSON.stringify(after))

// This is the whole complaint: the box has to end up the size of what was kept.
check('the layer box shrinks to the crop',
  Math.abs(after.w - before.w / 2) < 2 && Math.abs(after.h - before.h / 2) < 2,
  `${after.w}x${after.h} from ${before.w}x${before.h}`)
check('and sits where the crop was',
  Math.abs(after.x - (before.x + before.w * 0.25)) < 2, `x ${after.x}`)
check('the document is untouched',
  after.doc.w === before.doc.w && after.doc.h === before.doc.h,
  `${after.doc.w}x${after.doc.h}`)
// Non-destructive: it samples a sub-rect of the asset rather than a new bitmap.
check('it crops by moving the source window, not by baking pixels',
  after.src && Math.abs(after.src.w - 0.5) < 0.02 && Math.abs(after.src.x - 0.25) < 0.02,
  JSON.stringify(after.src))

await page.evaluate(() => window.__pfState().undo())
await page.waitForTimeout(200)
const undone = await geom()
check('and one undo brings the whole frame back',
  undone.w === before.w && undone.h === before.h && !undone.src,
  `${undone.w}x${undone.h}`)

// --- with nothing selected it still crops the canvas ---------------------------------
const docCrop = await page.evaluate(() => {
  const st = window.__pfState()
  st.select([])
  const rect = { x: 0, y: 0, w: Math.round(st.doc.width * 0.6), h: Math.round(st.doc.height * 0.6) }
  st.applyCrop(rect)
  return { rect, doc: { w: window.__pfState().doc.width, h: window.__pfState().doc.height } }
})
console.log('canvas crop:', JSON.stringify(docCrop))
check('with nothing selected the canvas still crops',
  docCrop.doc.w === docCrop.rect.w && docCrop.doc.h === docCrop.rect.h,
  `${docCrop.doc.w}x${docCrop.doc.h}`)
await page.evaluate(() => window.__pfState().undo())
await page.waitForTimeout(200)

// --- framing can be made permanent ------------------------------------------------------
const framed = await page.evaluate((id) => {
  const st = window.__pfState()
  st.select([id])
  st.updateLayer(id, { cropL: 0.2, cropR: 0.1, cropT: 0.25, cropB: 0.05 })
  const l = window.__pfState().doc.layers.find((x) => x.id === id)
  return { w: Math.round(l.w), h: Math.round(l.h), crop: [l.cropT, l.cropB, l.cropL, l.cropR] }
}, before.id)
console.log('with framing insets:', JSON.stringify(framed))
// The behaviour that reads as broken until you know why: the box keeps its size.
check('framing alone leaves the layer its full size', framed.w === before.w,
  `${framed.w} against ${before.w}`)

const trimmed = await page.evaluate((id) => {
  const ok = window.__pfState().trimToCrop(id)
  const l = window.__pfState().doc.layers.find((x) => x.id === id)
  return {
    ok,
    x: Math.round(l.x), y: Math.round(l.y), w: Math.round(l.w), h: Math.round(l.h),
    crop: [l.cropT || 0, l.cropB || 0, l.cropL || 0, l.cropR || 0],
    src: l.src ? { x: +l.src.x.toFixed(3), w: +l.src.w.toFixed(3) } : null,
  }
}, before.id)
console.log('after trimming:', JSON.stringify(trimmed))
check('trimming reports it did something', trimmed.ok === true)
// 20% off the left and 10% off the right leaves 70% of the width.
check('the layer becomes the piece that was kept',
  Math.abs(trimmed.w - before.w * 0.7) < 2 && Math.abs(trimmed.h - before.h * 0.7) < 2,
  `${trimmed.w}x${trimmed.h} from ${before.w}x${before.h}`)
check('and it stays where the visible part already was',
  Math.abs(trimmed.x - (before.x + before.w * 0.2)) < 2, `x ${trimmed.x}`)
check('the insets are spent, not left on top of the new box',
  trimmed.crop.every((v) => v === 0), JSON.stringify(trimmed.crop))
check('the source window carries what they were doing',
  trimmed.src && Math.abs(trimmed.src.x - 0.2) < 0.02 && Math.abs(trimmed.src.w - 0.7) < 0.02,
  JSON.stringify(trimmed.src))

// --- it refuses when refusing is the honest answer -----------------------------------------
const refusals = await page.evaluate((id) => {
  const st = window.__pfState()
  const plain = st.trimToCrop(id)
  // Animated framing is a moving window; freezing one frame throws it away.
  st.updateLayer(id, { cropL: 0.2 })
  st.enableTrack(id, 'framing')
  st.updateLayer(id, {
    tracks: { ...(window.__pfState().doc.layers.find((x) => x.id === id).tracks || {}),
      cropL: [{ t: 0, v: 0.1 }, { t: 500, v: 0.4 }] },
  })
  const animated = window.__pfState().trimToCrop(id)
  return { plain, animated }
}, before.id)
console.log('refusals:', JSON.stringify(refusals))
check('trimming an uncropped layer does nothing', refusals.plain === false)
check('and it will not freeze an animated crop', refusals.animated === false)

await page.screenshot({ path: path.join(OUT, '01-crop.png') })
// --- and then fitting the canvas to what is left ----------------------------------------
// The situation this exists for: crop a picture, and the canvas keeps its old
// size with empty space where the trimmed part used to be. Both the other
// actions move the *content*; this is the one that moves the frame.
const fitted = await page.evaluate(async () => {
  const st = window.__pfState()
  st.resetDoc()
  const blob = await (await fetch('/test/room.png')).blob()
  const a = await window.__pfAssets.loadImageFile(new File([blob], 'shot.png', { type: 'image/png' }))
  st.placeMedia([a.id], { resizeDocToFirst: true })
  await new Promise((r) => setTimeout(r, 300))

  const l0 = window.__pfState().doc.layers[0]
  const before = { doc: { ...window.__pfState().doc }, w: l0.w, h: l0.h }
  // Crop the right half away, exactly as the crop tool would.
  window.__pfState().select([l0.id])
  window.__pfState().cropSelectedTo({ x: l0.x, y: l0.y, w: l0.w * 0.5, h: l0.h })
  const mid = window.__pfState().doc.layers[0]
  const gap = {
    docW: window.__pfState().doc.width,
    layerW: Math.round(mid.w),
  }

  window.__pfState().fitCanvasToContent()
  const l1 = window.__pfState().doc.layers[0]
  const after = window.__pfState().doc
  return {
    startedAt: before.doc.width,
    gap,
    docW: after.width,
    docH: after.height,
    layer: { x: Math.round(l1.x), y: Math.round(l1.y), w: Math.round(l1.w), h: Math.round(l1.h) },
    src: l1.src ? +l1.src.w.toFixed(2) : null,
  }
})
console.log('crop then fit:', JSON.stringify(fitted))
// The gap is the complaint: half the canvas is now empty.
check('cropping leaves the canvas its old size',
  fitted.gap.docW === fitted.startedAt && fitted.gap.layerW < fitted.gap.docW,
  `canvas ${fitted.gap.docW}, layer ${fitted.gap.layerW}`)
check('fitting shrinks the canvas onto the content',
  fitted.docW === fitted.layer.w, `canvas ${fitted.docW}, layer ${fitted.layer.w}`)
check('and the content sits at the origin with no empty space',
  fitted.layer.x === 0 && fitted.layer.y === 0,
  `${fitted.layer.x},${fitted.layer.y}`)
check('the height is untouched, because nothing was empty there',
  fitted.docH === fitted.layer.h, `${fitted.docH} vs ${fitted.layer.h}`)
// Fitting the frame must not re-crop the picture that is already cropped.
check('and the picture itself is not trimmed again', Math.abs(fitted.src - 0.5) < 0.02,
  String(fitted.src))

const idempotent = await page.evaluate(() => {
  const st = window.__pfState()
  const before = { w: st.doc.width, h: st.doc.height }
  const changed = st.fitCanvasToContent()
  return { changed, before, after: { w: window.__pfState().doc.width, h: window.__pfState().doc.height } }
})
console.log('fitting again:', JSON.stringify(idempotent))
check('fitting an already-fitted canvas does nothing', idempotent.changed === false
  && idempotent.after.w === idempotent.before.w, JSON.stringify(idempotent.after))

await page.evaluate(() => window.__pfState().undo())
await page.waitForTimeout(200)
const undoneFit = await page.evaluate(() => window.__pfState().doc.width)
check('and one undo puts the canvas back', undoneFit === fitted.startedAt,
  `${undoneFit} vs ${fitted.startedAt}`)

// The two buttons move opposite things, and are named for which.
const labels = await page.evaluate(async () => {
  window.__pfState().select([])
  await new Promise((r) => setTimeout(r, 300))
  return [...document.querySelectorAll('.inspector button')]
    .map((b) => b.textContent.trim())
    .filter((t) => /canvas|content/i.test(t))
})
console.log('canvas buttons:', JSON.stringify(labels))
check('one button names the canvas as the thing that moves',
  labels.some((t) => /Shrink canvas to fit content/.test(t)), labels.join(' | '))
check('and the other names the content', labels.some((t) => /Scale content to fill canvas/.test(t)),
  labels.join(' | '))

console.log(errors.length ? 'CONSOLE ERRORS: ' + errors.slice(0, 5).join(' | ') : 'no console errors')
await browser.close()
process.exit(checks.some(([, ok]) => !ok) ? 1 : 0)
