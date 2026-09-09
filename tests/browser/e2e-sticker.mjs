// Sticker borders, and the two ways the border used to disagree with the picture.
//
// A sticker border is a dilation of whatever is left of the layer, so it has to
// be grown from the *finished* alpha — the background key, the lasso mask and
// the erase strokes together. It used to read only the background key, which
// meant an erased region kept its border (pixels gone from the picture, still
// present in the shape the border was traced from) and a lasso-masked cutout
// with no background removal got no border at all.
import { chromium } from 'playwright-core'
import { importAndPlace } from '../e2e-helpers.mjs'
import fs from 'fs'
import path from 'path'

const OUT = 'shots/sticker'
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
await importAndPlace(page, 'public/test/greenscreen.gif', { timeout: 20000 })
await page.evaluate(() => { window.__pfState().setPlaying(false); window.__pfState().setTime(0) })
await page.waitForTimeout(500)

/**
 * Counts pixels of the border colour in a document region, and the pixels that
 * are opaque at all. The border is pure magenta here so it can be told apart
 * from the artwork by colour alone rather than by guessing at a silhouette.
 */
const survey = (box) => page.evaluate((b) => {
  const st = window.__pfState()
  const c = document.createElement('canvas')
  c.width = st.doc.width
  c.height = st.doc.height
  const ctx = c.getContext('2d', { willReadFrequently: true })
  window.__pfRender.renderDocument(ctx, st.doc, 0)
  const x = Math.max(0, Math.round(b.x))
  const y = Math.max(0, Math.round(b.y))
  const w = Math.min(c.width - x, Math.round(b.w))
  const h = Math.min(c.height - y, Math.round(b.h))
  if (w <= 0 || h <= 0) return { border: 0, opaque: 0, total: 0 }
  const d = ctx.getImageData(x, y, w, h).data
  let border = 0
  let opaque = 0
  for (let i = 0; i < d.length; i += 4) {
    if (d[i + 3] < 128) continue
    opaque++
    if (d[i] > 200 && d[i + 1] < 80 && d[i + 2] > 200) border++
  }
  return { border, opaque, total: w * h }
}, box)

const layer = await page.evaluate(() => {
  const st = window.__pfState()
  const l = st.doc.layers.find((x) => x.type === 'image')
  st.select([l.id])
  st.updateLayer(l.id, {
    bgRemove: { ...window.__pfMatte.defaultBgRemove(), on: true, mode: 'auto', tolerance: 40 },
    sticker: { ...window.__pfSubject.defaultSticker(), on: true, outline: 14, color: '#ff00ff', shadow: 0 },
  })
  const b = window.__pfState().doc.layers.find((x) => x.id === l.id)
  return { id: l.id, x: b.x, y: b.y, w: b.w, h: b.h }
})
await page.waitForTimeout(300)

/** The box the opaque pixels occupy, in document pixels. The keyed subject is
 *  not centred in its frame, so a band drawn through the middle of the *layer*
 *  can miss it completely and measure nothing. */
const subjectBox = () => page.evaluate(() => {
  const st = window.__pfState()
  const c = document.createElement('canvas')
  c.width = st.doc.width
  c.height = st.doc.height
  const ctx = c.getContext('2d', { willReadFrequently: true })
  window.__pfRender.renderDocument(ctx, st.doc, 0)
  const d = ctx.getImageData(0, 0, c.width, c.height).data
  let x0 = c.width; let y0 = c.height; let x1 = -1; let y1 = -1
  for (let y = 0; y < c.height; y++) {
    for (let x = 0; x < c.width; x++) {
      if (d[(y * c.width + x) * 4 + 3] < 128) continue
      if (x < x0) x0 = x
      if (x > x1) x1 = x
      if (y < y0) y0 = y
      if (y > y1) y1 = y
    }
  }
  return x1 < 0 ? null : { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 }
})

const whole = { x: layer.x - 40, y: layer.y - 40, w: layer.w + 80, h: layer.h + 80 }
const base = await survey(whole)
console.log('with a border:', JSON.stringify(base))
check('a cut-out gets a sticker border', base.border > 200, `${base.border} border px`)
const box = await subjectBox()
console.log('subject box:', JSON.stringify(box))
check('the subject occupies a real region', box && box.w > 20 && box.h > 20,
  box ? `${box.w}x${box.h}` : 'nothing opaque')
await page.screenshot({ path: path.join(OUT, '01-border.png') })

// --- erasing takes the border with it -------------------------------------------
// A vertical band down the middle of the layer, erased. Nothing of the subject
// should survive there — and neither should the border, which is the bug.
const SIZE = 0.12
// The band the brush will cover, narrowed to 30% so the measurement sits
// entirely inside the stroke rather than straddling its soft edge.
const half = layer.w * SIZE * 0.3
const band = { x: box.x + box.w * 0.5 - half, y: box.y, w: half * 2, h: box.h }
const preBand = await survey(band)
console.log('the band before erasing:', JSON.stringify(preBand))
check('the band starts out full of subject', preBand.opaque > preBand.total * 0.8,
  `${preBand.opaque} of ${preBand.total}`)

await page.evaluate(([L, B, size]) => {
  const st = window.__pfState()
  st.select([L.id])
  st.setTool('erase')
  // Strokes are stored as fractions of the layer box, so the subject box has to
  // be converted out of document pixels first.
  const u = (B.x + B.w * 0.5 - L.x) / L.w
  const top = (B.y - L.y) / L.h - 0.1
  const bottom = (B.y + B.h - L.y) / L.h + 0.1
  st.beginErase(L.id, [u, top], { size, hardness: 1, mode: 'erase' })
  for (let i = 1; i <= 24; i++) {
    window.__pfState().extendErase(L.id, [u, top + ((bottom - top) * i) / 24])
  }
}, [layer, box, SIZE])
await page.waitForTimeout(300)
const inBand = await survey(band)
console.log('inside the erased band:', JSON.stringify(inBand))
// None of the *picture* survives in the gap, and everything still opaque there
// is border lining the two edges the erasure just cut. That is the whole point:
// the border is a dilation of what is left, so removing content moves it.
check('erasing takes the picture out of the gap',
  inBand.opaque - inBand.border < preBand.opaque * 0.1,
  `${inBand.opaque - inBand.border} picture px left`)
// The bug measured 0 here — the border was grown from the pre-erase shape, so
// the new edges got no border at all.
check('and the border follows the new edges it made', inBand.border > 300,
  `${inBand.border} border px in the gap`)

const after = await survey(whole)
console.log('after erasing:', JSON.stringify(after))
// Cutting a subject in two adds outline rather than removing it. The bug went
// the other way, 3768 -> 2588, because the erase simply shaved the old rim.
check('so erasing grows the total border, not shrinks it', after.border > base.border,
  `${base.border} -> ${after.border}`)
await page.screenshot({ path: path.join(OUT, '02-erased.png') })

// --- a restore stroke brings both back ------------------------------------------
await page.evaluate(([L, B, size]) => {
  const st = window.__pfState()
  const u = (B.x + B.w * 0.5 - L.x) / L.w
  const top = (B.y - L.y) / L.h - 0.1
  const bottom = (B.y + B.h - L.y) / L.h + 0.1
  st.beginErase(L.id, [u, top], { size, hardness: 1, mode: 'restore' })
  for (let i = 1; i <= 24; i++) {
    window.__pfState().extendErase(L.id, [u, top + ((bottom - top) * i) / 24])
  }
}, [layer, box, SIZE])
await page.waitForTimeout(300)
const restored = await survey(band)
console.log('after restoring:', JSON.stringify(restored))
check('a restore stroke puts the picture back', restored.opaque > preBand.opaque * 0.9,
  `${inBand.opaque} -> ${restored.opaque}, was ${preBand.opaque}`)
check('and the border retreats to the outline again', restored.border < inBand.border,
  `${inBand.border} -> ${restored.border}`)

// --- a lasso mask alone is enough to get a border --------------------------------
// This used to draw nothing: the border was grown from the background key, so a
// layer cut out purely by lasso had no shape to grow from.
await page.evaluate((L) => {
  const st = window.__pfState()
  st.updateLayer(L.id, {
    bgRemove: { ...window.__pfMatte.defaultBgRemove(), on: false },
    erase: null,
    mask: {
      points: [[0.3, 0.25], [0.7, 0.25], [0.7, 0.75], [0.3, 0.75]],
      invert: false, feather: 0,
    },
  })
}, layer)
await page.waitForTimeout(300)
const lasso = await survey(whole)
console.log('lasso-only sticker:', JSON.stringify(lasso))
// The bug measured 0: the border was grown from the background key, so a layer
// cut out purely by lasso had no shape to grow from and got nothing.
check('a lasso mask alone still gets a border', lasso.border > 200, `${lasso.border} border px`)
// The mask keeps a rectangle in the middle, so the border has to sit outside it
// rather than being clipped away by the very mask that gave it its shape.
const outside = await survey({
  x: layer.x + layer.w * 0.3 - 20, y: layer.y + layer.h * 0.25 - 20, w: 20, h: layer.h * 0.5,
})
console.log('just outside the mask:', JSON.stringify(outside))
check('and the mask does not clip its own border', outside.border > 20,
  `${outside.border} border px outside the mask`)
await page.screenshot({ path: path.join(OUT, '03-lasso.png') })

// --- a lasso cutout is a cutout ---------------------------------------------------
// The switch demanded background removal while the renderer had always accepted
// a lasso mask, so cutting a subject out with the AI lasso — the natural route,
// and the one that produces the better edge — left the sticker refusing to turn
// on. The way through was to enable background removal and set it to zero: a
// step that does nothing, to satisfy a check that was wrong.
const bare = await page.evaluate(async () => {
  const st = window.__pfState()
  st.setPlaying(false)
  st.doc.layers.forEach((l) => st.removeLayers([l.id]))
  await new Promise((r) => setTimeout(r, 250))
  const c = document.createElement('canvas')
  c.width = 300
  c.height = 300
  const g = c.getContext('2d')
  g.fillStyle = '#2266cc'
  g.fillRect(0, 0, 300, 300)
  g.fillStyle = '#ffcc44'
  g.beginPath()
  g.arc(150, 150, 90, 0, Math.PI * 2)
  g.fill()
  const blob = await new Promise((r) => c.toBlob(r))
  await window.__pfState().addImages([new File([blob], 'subject.png', { type: 'image/png' })],
    { place: true })
  await new Promise((r) => setTimeout(r, 800))
  const l = window.__pfState().doc.layers[0]
  window.__pfState().select([l.id])
  window.__pfState().toggleSticker(l.id, true)
  await new Promise((r) => setTimeout(r, 250))
  return {
    id: l.id,
    box: { x: l.x, y: l.y, w: l.w, h: l.h },
    on: !!window.__pfState().doc.layers[0].sticker?.on,
    notice: window.__pfState().notice?.text || '',
  }
})
console.log('with nothing cut out:', JSON.stringify(bare.notice))
check('a layer that is not cut out still refuses to be a sticker', bare.on === false)
// And says both ways through, not only the one it used to insist on.
check('and names the lasso as well as background removal',
  /lasso/i.test(bare.notice) && /background/i.test(bare.notice), bare.notice)

const lassoed = await page.evaluate(async ([id, box]) => {
  const st = window.__pfState()
  const pt = (fx, fy) => [box.x + box.w * fx, box.y + box.h * fy]
  const ring = []
  for (let i = 0; i < 32; i++) {
    const a = (i / 32) * Math.PI * 2
    ring.push(pt(0.5 + Math.cos(a) * 0.31, 0.5 + Math.sin(a) * 0.31))
  }
  st.select([id])
  st.setLasso({ points: ring, closed: true })
  st.applyLasso('mask')
  await new Promise((r) => setTimeout(r, 400))
  window.__pfState().toggleSticker(id, true)
  await new Promise((r) => setTimeout(r, 400))

  const now = window.__pfState().doc.layers.find((x) => x.id === id)
  const s2 = window.__pfState()
  const cv = document.createElement('canvas')
  cv.width = s2.doc.width
  cv.height = s2.doc.height
  const ctx = cv.getContext('2d', { willReadFrequently: true })
  window.__pfRender.renderDocument(ctx, s2.doc, 0)
  const d = ctx.getImageData(0, 0, cv.width, cv.height).data
  let white = 0
  let subject = 0
  for (let i = 0; i < d.length; i += 4) {
    if (d[i + 3] < 200) continue
    if (d[i] > 240 && d[i + 1] > 240 && d[i + 2] > 240) white++
    else if (d[i] > 220 && d[i + 1] > 180 && d[i + 2] < 110) subject++
  }
  return {
    bgRemove: !!now.bgRemove?.on,
    mask: now.mask?.points?.length || 0,
    on: !!now.sticker?.on,
    white,
    subject,
  }
}, [bare.id, bare.box])
console.log('after lassoing the subject:', JSON.stringify(lassoed))
check('a lasso mask is a cutout as far as the sticker is concerned',
  lassoed.mask >= 3 && lassoed.on === true, JSON.stringify(lassoed))
// The point of the complaint: no background removal anywhere in this.
check('with background removal never turned on', lassoed.bgRemove === false)
check('and the border is actually drawn round it',
  lassoed.white > 500 && lassoed.subject > 2000, JSON.stringify(lassoed))

console.log(errors.length ? 'CONSOLE ERRORS: ' + errors.slice(0, 5).join(' | ') : 'no console errors')
await browser.close()
process.exit(checks.some(([, ok]) => !ok) ? 1 : 0)
