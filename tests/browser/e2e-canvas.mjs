// Resizing the canvas.
//
// The canvas is the frame, not the picture. Resizing it used to scale every
// layer by the width and height factors *independently*, so changing only the
// height stretched everything vertically — asking for a taller canvas is not
// asking for taller people. Leaving the artwork alone is the default now, with
// Fit and Fill as uniform, non-distorting alternatives.
import { chromium } from 'playwright-core'
import { importAndPlace } from '../e2e-helpers.mjs'

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

/** Every layer's geometry, rounded, so two states can be compared exactly. */
const geom = () => page.evaluate(() => window.__pfState().doc.layers.map((l) => ({
  id: l.id,
  x: Math.round(l.x * 100) / 100,
  y: Math.round(l.y * 100) / 100,
  w: Math.round(l.w * 100) / 100,
  h: Math.round(l.h * 100) / 100,
})))

const size = () => page.evaluate(() => {
  const d = window.__pfState().doc
  return { w: d.width, h: d.height }
})

const start = await size()
const before = await geom()
console.log('canvas:', JSON.stringify(start), 'layers:', before.length)
check('a document to resize', before.length >= 1 && start.w > 0)

// --- Leave: the artwork is untouched --------------------------------------------
await page.evaluate(() => window.__pfState().setDocResize('leave'))
await page.evaluate(([w, h]) => window.__pfState().resizeDoc(w, h), [start.w, start.h * 2])
await page.waitForTimeout(200)
const tallerSize = await size()
const taller = await geom()
console.log('after doubling the height:', JSON.stringify(tallerSize))
check('the canvas actually changed', tallerSize.h === start.h * 2 && tallerSize.w === start.w,
  `${tallerSize.w}x${tallerSize.h}`)
// This is the bug, stated precisely: the old code gave every layer h * 2.
check('and not one layer moved or stretched',
  JSON.stringify(taller) === JSON.stringify(before),
  JSON.stringify(taller[0]) + ' was ' + JSON.stringify(before[0]))

// Width alone, and both at once, are the same promise.
await page.evaluate(([w, h]) => window.__pfState().resizeDoc(w, h), [start.w * 3, start.h * 2])
await page.waitForTimeout(200)
const wider = await geom()
check('widening leaves it alone too', JSON.stringify(wider) === JSON.stringify(before))

// Shrinking below the content is allowed — it crops, it does not squash.
await page.evaluate(([w, h]) => window.__pfState().resizeDoc(w, h), [40, 40])
await page.waitForTimeout(200)
const tiny = await geom()
check('and shrinking crops rather than squashing',
  JSON.stringify(tiny) === JSON.stringify(before), JSON.stringify(tiny[0]))

await page.evaluate(([w, h]) => window.__pfState().resizeDoc(w, h), [start.w, start.h])
await page.waitForTimeout(200)

// --- Fit and Fill scale uniformly ------------------------------------------------
// The point of both is that they never distort: whatever the canvas does, the
// layer's own aspect ratio has to come out unchanged.
const ratioOf = (l) => Math.round((l.w / l.h) * 1000) / 1000
const firstBefore = before[0]

await page.evaluate(() => window.__pfState().setDocResize('fit'))
await page.evaluate(([w, h]) => window.__pfState().resizeDoc(w, h), [start.w, start.h * 2])
await page.waitForTimeout(200)
const fitted = (await geom())[0]
console.log('fit:', JSON.stringify(fitted))
check('fit keeps the layer aspect ratio', ratioOf(fitted) === ratioOf(firstBefore),
  `${ratioOf(fitted)} vs ${ratioOf(firstBefore)}`)
check('and fits inside the new canvas',
  fitted.w <= start.w + 0.5 && fitted.h <= start.h * 2 + 0.5,
  `${fitted.w}x${fitted.h} in ${start.w}x${start.h * 2}`)

await page.evaluate(() => window.__pfState().undo())
await page.waitForTimeout(200)
await page.evaluate(() => window.__pfState().setDocResize('fill'))
await page.evaluate(([w, h]) => window.__pfState().resizeDoc(w, h), [start.w, start.h * 2])
await page.waitForTimeout(200)
const filled = (await geom())[0]
console.log('fill:', JSON.stringify(filled))
check('fill keeps the layer aspect ratio too', ratioOf(filled) === ratioOf(firstBefore),
  `${ratioOf(filled)} vs ${ratioOf(firstBefore)}`)
check('and covers the new canvas', filled.w >= start.w - 0.5 && filled.h >= start.h * 2 - 0.5,
  `${filled.w}x${filled.h} covering ${start.w}x${start.h * 2}`)
check('fill is bigger than fit, which is the difference between them',
  filled.w > fitted.w, `${filled.w} vs ${fitted.w}`)

await page.evaluate(() => window.__pfState().undo())
await page.evaluate(() => window.__pfState().setDocResize('leave'))
await page.waitForTimeout(200)

// --- the aspect link ---------------------------------------------------------------
// The link lives in the panel, so drive the panel rather than the store. The
// Document panel only shows with nothing selected — importing leaves the new
// layer selected, which shows the layer panel instead.
await page.evaluate(() => window.__pfState().select([]))
await page.waitForTimeout(200)
const widthBox = page.locator('.inspector input.num').first()
const linkBtn = page.locator('.inspector .toggle', { hasText: 'Free' })
check('there is a link control', await linkBtn.count() === 1)
await linkBtn.click()
await page.waitForTimeout(150)
check('and it can be switched on',
  await page.evaluate(() => window.__pfState().docLinkRatio) === true)

const beforeLink = await size()
await widthBox.fill(String(beforeLink.w * 2))
await widthBox.press('Enter')
await page.waitForTimeout(250)
const linked = await size()
console.log('after doubling the width with the link on:', JSON.stringify(linked))
check('linked, the height follows the width', linked.w === beforeLink.w * 2
  && linked.h === beforeLink.h * 2, `${linked.w}x${linked.h}`)
check('so the canvas ratio is unchanged',
  Math.abs(linked.w / linked.h - beforeLink.w / beforeLink.h) < 0.001)
check('and the artwork still did not move',
  JSON.stringify(await geom()) === JSON.stringify(before))

await page.locator('.inspector .toggle', { hasText: 'Linked' }).click()
await page.waitForTimeout(150)
const unlinkedBefore = await size()
await widthBox.fill(String(Math.round(unlinkedBefore.w / 2)))
await widthBox.press('Enter')
await page.waitForTimeout(250)
const unlinked = await size()
check('unlinked, the height stays put', unlinked.h === unlinkedBefore.h,
  `${unlinked.w}x${unlinked.h}`)

// --- crop to fill, as a one-shot -----------------------------------------------------
await page.evaluate(([w, h]) => {
  const st = window.__pfState()
  st.resizeDoc(w, h)
  // Shrink a layer well inside the canvas so filling has something to do.
  const l = st.doc.layers[0]
  st.updateLayer(l.id, { x: 10, y: 10, w: l.w / 4, h: l.h / 4 })
}, [start.w, start.h])
await page.waitForTimeout(200)
const small = (await geom())[0]
await page.evaluate(() => window.__pfState().fillCanvas())
await page.waitForTimeout(250)
const covered = (await geom())[0]
const canvas = await size()
console.log('crop to fill:', JSON.stringify(small), '->', JSON.stringify(covered))
check('crop to fill grows the content to cover',
  covered.w >= canvas.w - 0.5 && covered.h >= canvas.h - 0.5,
  `${covered.w}x${covered.h} covering ${canvas.w}x${canvas.h}`)
check('without distorting it', ratioOf(covered) === ratioOf(small),
  `${ratioOf(covered)} vs ${ratioOf(small)}`)
check('and centres it rather than leaving it in the corner',
  Math.abs((covered.x + covered.w / 2) - canvas.w / 2) < 1
  && Math.abs((covered.y + covered.h / 2) - canvas.h / 2) < 1,
  `centre ${covered.x + covered.w / 2},${covered.y + covered.h / 2}`)

await page.evaluate(() => window.__pfState().undo())
await page.waitForTimeout(200)
check('and one undo puts it back',
  JSON.stringify((await geom())[0]) === JSON.stringify(small))

// --- a shadow cast by the shape, not the box ---------------------------------------------
// The whole claim of this feature is that a layer throws what it draws: a circle
// throws a circle, text throws letters, a cut-out throws the subject. A shadow
// taken from the layer's rectangle would be easy and wrong, and the difference
// only shows in the corners — which is where this looks.
const shadow = await page.evaluate(async () => {
  const st = window.__pfState()
  st.resetDoc()
  st.setDoc({ width: 400, height: 400, background: '#ffffff' })
  await new Promise((r) => setTimeout(r, 250))
  const { makeShapeLayer } = window.__pfStore
  // A white circle on white, so nothing but the shadow can darken a pixel.
  const layer = makeShapeLayer({
    shape: 'ellipse', x: 120, y: 120, w: 160, h: 160,
    fill: '#ffffff', stroke: '#ffffff', strokeWidth: 0,
  })
  window.__pfState().addLayer(layer)
  await new Promise((r) => setTimeout(r, 300))
  const id = layer.id

  const sample = () => {
    const s2 = window.__pfState()
    const c = document.createElement('canvas')
    c.width = s2.doc.width
    c.height = s2.doc.height
    const g = c.getContext('2d', { willReadFrequently: true })
    window.__pfRender.renderDocument(g, s2.doc, 0)
    const at = (x, y) => g.getImageData(x, y, 1, 1).data[0]
    return {
      // Directly under the circle's bottom edge, where an offset shadow lands.
      under: at(200, 292),
      // The box corner. A shadow cast from the rectangle darkens here; one cast
      // from the circle cannot reach it.
      corner: at(288, 288),
      // Well clear of everything.
      away: at(20, 20),
      // Inside the circle, which the shadow must never darken.
      inside: at(200, 200),
    }
  }

  const off = sample()
  window.__pfState().updateLayer(id, {
    shadow: { on: true, color: '#000000', opacity: 1, blur: 10, x: 0, y: 18 },
  })
  await new Promise((r) => setTimeout(r, 350))
  const on = sample()

  // Centred and bright: the same control as a glow.
  window.__pfState().updateLayer(id, {
    shadow: { on: true, color: '#ff0000', opacity: 1, blur: 26, x: 0, y: 0 },
  })
  await new Promise((r) => setTimeout(r, 350))
  const glowCanvas = (() => {
    const s2 = window.__pfState()
    const c = document.createElement('canvas')
    c.width = s2.doc.width
    c.height = s2.doc.height
    const g = c.getContext('2d', { willReadFrequently: true })
    window.__pfRender.renderDocument(g, s2.doc, 0)
    const px = g.getImageData(200, 288, 1, 1).data
    return { r: px[0], g: px[1], b: px[2] }
  })()

  // And a shadow under a layer that is blended, which is where drawing the
  // layer into an empty surface and blending it there would come out black.
  window.__pfState().updateLayer(id, {
    shadow: { on: true, color: '#000000', opacity: 1, blur: 10, x: 0, y: 18 },
    blend: 'multiply',
    fill: '#ffffff',
  })
  await new Promise((r) => setTimeout(r, 350))
  const blended = sample()
  return { off, on, glow: glowCanvas, blended }
})
console.log('shadow:', JSON.stringify(shadow))
check('nothing is cast until it is turned on', shadow.off.under > 250, String(shadow.off.under))
check('a shadow darkens the ground beneath the shape',
  shadow.on.under < 120, String(shadow.on.under))
// The one that separates a real shadow from a lazy one.
check('and is cast by the shape rather than by the layer box',
  shadow.on.corner > 240, `corner ${shadow.on.corner} vs under ${shadow.on.under}`)
check('the shape itself stays exactly as it was', shadow.on.inside > 250, String(shadow.on.inside))
check('and the far side of the canvas is untouched', shadow.on.away > 250, String(shadow.on.away))
// On white, a red glow cannot raise the red channel — it can only hold it while
// pulling the other two down. The tint is the claim, not the brightness.
check('centred and coloured, the same control glows',
  shadow.glow.r - shadow.glow.g > 40 && shadow.glow.g === shadow.glow.b,
  JSON.stringify(shadow.glow))
// A multiply layer drawn into an empty surface multiplies against nothing and
// comes out black, so the blend has to be applied where there is something
// underneath. A white multiply layer over white is still white.
check('a blended layer with a shadow keeps its blend',
  shadow.blended.inside > 250, String(shadow.blended.inside))
check('and still casts', shadow.blended.under < 120, String(shadow.blended.under))

// --- the panels come in the order the thing you selected wants ---------------------------
// Which panels matter depends on what is selected: a shape wants its own
// controls high up, an overlay wants the effect it applies before anything
// else, and the sections with one switch in them belong at the bottom either
// way. Read off the computed order rather than the source, since that is what
// decides what a person actually sees.
const ids = await page.evaluate(async () => {
  const st = window.__pfState()
  st.resetDoc()
  const c = document.createElement('canvas')
  c.width = 400
  c.height = 300
  const g = c.getContext('2d')
  g.fillStyle = '#4488cc'
  g.fillRect(0, 0, 400, 300)
  const blob = await new Promise((r) => c.toBlob(r))
  await st.addImages([new File([blob], 'panel.png', { type: 'image/png' })], { place: true })
  await new Promise((r) => setTimeout(r, 1200))
  const S = window.__pfStore
  const sh = S.makeShapeLayer({ x: 10, y: 10, w: 80, h: 80 })
  const fx = S.makeEffectLayer({ x: 20, y: 20, w: 80, h: 80, effect: 'pixelate' })
  const s2 = window.__pfState()
  s2.addLayer(sh)
  s2.addLayer(fx)
  return { sh: sh.id, fx: fx.id, img: s2.doc.layers.find((l) => l.type === 'image').id, shape: sh.shape, fxShape: fx.shape }
})

const panels = async (id) => {
  await page.evaluate((i) => window.__pfState().select([i]), id)
  await page.waitForTimeout(350)
  return page.evaluate(() => [...document.querySelectorAll('.inspector-body > .section')]
    .map((n) => ({
      t: n.querySelector('.section-title')?.textContent?.replace(/\s+/g, ' ').trim(),
      o: Number(getComputedStyle(n).order),
    }))
    .sort((a, b) => a.o - b.o)
    .map((x) => x.t))
}

const forShape = await panels(ids.sh)
const forEffect = await panels(ids.fx)
const forImage = await panels(ids.img)
console.log('shape :', forShape.join(' > '))
console.log('effect:', forEffect.join(' > '))
console.log('image :', forImage.join(' > '))

check('a shape leads with its own controls, then how it moves, then its shadow',
  forShape.slice(0, 5).join('|') === 'Transform|Shape|Motion tracking|Motion trails|Shadow',
  forShape.join(' > '))
// An overlay *is* its effect, so that comes before the box it sits in.
check('an overlay leads with the effect it applies',
  forEffect.slice(0, 3).join('|') === 'Overlay effect|Transform|Motion tracking',
  forEffect.join(' > '))
check('a picture leads with the things done to pictures',
  forImage.slice(0, 4).join('|') === 'Transform|Framing|Adjustments|Subject',
  forImage.join(' > '))
// The tail rule: one or two controls, or nothing to do with the kind of thing
// selected, and it goes to the bottom.
check('and the general panels fall to the end of all of them',
  forShape[forShape.length - 1] === 'Motion'
  && forImage.indexOf('Image') > forImage.indexOf('Subject'),
  `${forShape.at(-1)} / ${forImage.join(' > ')}`)

// --- a rectangle is the one you get -------------------------------------------------------
check('a new overlay is a rectangle', ids.fxShape === 'rect', ids.fxShape)
check('and so is a new shape', ids.shape === 'rect', ids.shape)
const firstShape = await page.evaluate(async () => {
  window.__pfState().setTool('shape')
  await new Promise((r) => setTimeout(r, 350))
  const b = document.querySelector('.rail-options .segmented button')
  return { title: b?.title || '', on: b?.className || '' }
})
check('the shape row offers it first', /Rectangle/.test(firstShape.title), JSON.stringify(firstShape))

// --- what the overlay will actually look like ---------------------------------------------
// A pixel size is a number of document pixels, which says nothing about how
// coarse the blocks will be over the picture in front of you.
const fxPreview = await page.evaluate(async () => {
  const st = window.__pfState()
  st.setTool('effect')
  await new Promise((r) => setTimeout(r, 500))
  const c = document.querySelector('.fx-preview canvas')
  if (!c) return { there: false }
  const grab = () => {
    const g = c.getContext('2d', { willReadFrequently: true })
    return g.getImageData(0, 0, c.width, c.height).data.join(',')
  }
  const small = grab()
  window.__pfState().setToolOptions({ pixelSize: 60 })
  await new Promise((r) => setTimeout(r, 450))
  return { there: true, changed: grab() !== small, w: c.width }
})
console.log('effect preview:', JSON.stringify(fxPreview))
check('the overlay tool shows what it will do', fxPreview.there === true)
check('and the picture changes when the block size does', fxPreview.changed === true)

// --- where you are ------------------------------------------------------------------------
// Zoomed in past the frame there is nothing on screen saying which part of the
// document is in front of you. It appears only when it has something to say.
const map = await page.evaluate(async () => {
  const st = window.__pfState()
  st.setView({ fitRequest: Date.now() })
  await new Promise((r) => setTimeout(r, 600))
  const fitted = document.querySelectorAll('.minimap').length
  st.setView({ zoom: 4, panX: -300, panY: -200, fitted: false })
  await new Promise((r) => setTimeout(r, 500))
  const zoomed = document.querySelectorAll('.minimap').length
  const before = { ...window.__pfState().view }
  const frame = document.querySelector('.minimap-frame')
  const r = frame.getBoundingClientRect()
  // A press near the left edge of the frame should take the view to the left of
  // the picture.
  frame.dispatchEvent(new PointerEvent('pointerdown', {
    clientX: r.left + 12, clientY: r.top + r.height / 2, bubbles: true, pointerId: 1,
  }))
  frame.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 1 }))
  await new Promise((res) => setTimeout(res, 400))
  return { fitted, zoomed, before, after: { ...window.__pfState().view } }
})
console.log('minimap:', JSON.stringify(map))
check('nothing is shown while the whole canvas fits', map.fitted === 0, String(map.fitted))
check('and it appears once it does not', map.zoomed === 1, String(map.zoomed))
check('pressing it moves the view', map.after.panX !== map.before.panX,
  `${map.before.panX} -> ${map.after.panX}`)
check('and leaves the zoom alone, since it says where you are and not how close',
  map.after.zoom === map.before.zoom, `${map.before.zoom} -> ${map.after.zoom}`)

// --- clicking the thing in front selects the thing in front --------------------------------
// Two separate layers, one over the other, neither in a group. With the lower
// one selected, a click on the upper one has to take it — and used to not,
// because a click inside the current selection kept that selection whatever was
// on top of it.
const stacking = await page.evaluate(async () => {
  const st = window.__pfState()
  st.resetDoc()
  st.setDoc({ width: 400, height: 400, background: '#101010' })
  await new Promise((r) => setTimeout(r, 250))
  // The move tool, explicitly: the overlay preview above leaves that tool armed,
  // and a click on the canvas would draw a new overlay instead of selecting.
  st.setTool('move')
  const S = window.__pfStore
  const under = S.makeShapeLayer({ shape: 'rect', x: 40, y: 40, w: 300, h: 300, fill: '#3060c0' })
  const over = S.makeShapeLayer({ shape: 'rect', x: 120, y: 120, w: 140, h: 140, fill: '#e0a020' })
  const s2 = window.__pfState()
  s2.addLayer(under)
  s2.addLayer(over)
  // Back to a view that fits: the checks above leave it zoomed in, and a click
  // worked out against a stale view lands somewhere else entirely.
  s2.setView({ fitRequest: Date.now() })
  await new Promise((r) => setTimeout(r, 600))
  const s3 = window.__pfState()
  return {
    under: under.id,
    over: over.id,
    order: s3.doc.layers.map((x) => `${x.id}@${x.x},${x.y}`),
  }
})
console.log('stack setup:', JSON.stringify(stacking))

const view = await page.evaluate(() => {
  const s = window.__pfState()
  const r = document.querySelector('.stage canvas').getBoundingClientRect()
  return { cx: r.x, cy: r.y, ...s.view }
})
const at = (x, y) => [view.cx + view.panX + x * view.zoom, view.cy + view.panY + y * view.zoom]

const clickAt = async (x, y) => {
  await page.mouse.click(...at(x, y))
  await page.waitForTimeout(200)
  return page.evaluate(() => window.__pfState().selectedIds)
}

// The lower one first, on a part of it nothing covers.
const pickedUnder = await clickAt(70, 70)
check('clicking the layer underneath selects it',
  pickedUnder.join() === stacking.under, pickedUnder.join())
// Then straight onto the one in front, without deselecting anything.
const pickedOver = await clickAt(190, 190)
check('and clicking the one in front then selects that, with no deselect first',
  pickedOver.join() === stacking.over, pickedOver.join())
// And back down again.
const backDown = await clickAt(70, 70)
check('and back down to the one underneath', backDown.join() === stacking.under, backDown.join())

// Several selected and dragged by one of them must stay several — that is a
// different rule and it still holds.
const many = await page.evaluate(async ([a, b]) => {
  window.__pfState().select([a, b])
  await new Promise((r) => setTimeout(r, 200))
  return window.__pfState().selectedIds.length
}, [stacking.under, stacking.over])
const stillMany = await clickAt(190, 190)
check('a click on one of several already selected keeps the whole selection',
  many === 2 && stillMany.length === 2, `${many} -> ${stillMany.length}`)

// --- and the empty half of a cut-out does not take the click ------------------------------
// The reason the old rule existed. A subject cut out of a photograph fills a
// rectangle that is mostly nothing, and a box that catches clicks over that
// nothing steals every click meant for whatever is behind it.
const cutout = await page.evaluate(async () => {
  const st = window.__pfState()
  st.resetDoc()
  st.setDoc({ width: 400, height: 400, background: '#101010' })
  await new Promise((r) => setTimeout(r, 250))
  const S = window.__pfStore
  st.setTool('move')
  const under = S.makeShapeLayer({ shape: 'rect', x: 20, y: 20, w: 360, h: 360, fill: '#3060c0' })
  window.__pfState().addLayer(under)
  window.__pfState().setView({ fitRequest: Date.now() })
  await new Promise((r) => setTimeout(r, 500))
  // A picture whose right half is transparent, laid over the whole thing.
  const c = document.createElement('canvas')
  c.width = 200
  c.height = 200
  const g = c.getContext('2d')
  g.fillStyle = '#e0a020'
  g.fillRect(0, 0, 100, 200)
  const blob = await new Promise((r) => c.toBlob(r))
  await window.__pfState().addImages([new File([blob], 'half.png', { type: 'image/png' })], { place: true })
  await new Promise((r) => setTimeout(r, 1200))
  const img = window.__pfState().doc.layers.find((l) => l.type === 'image')
  window.__pfState().updateLayer(img.id, { x: 100, y: 100, w: 200, h: 200 })
  window.__pfState().setView({ fitRequest: Date.now() })
  await new Promise((r) => setTimeout(r, 600))
  return { under: under.id, img: img.id }
})
const view2 = await page.evaluate(() => {
  const s = window.__pfState()
  const r = document.querySelector('.stage canvas').getBoundingClientRect()
  return { cx: r.x, cy: r.y, ...s.view }
})
const clickAt2 = async (x, y) => {
  await page.mouse.click(view2.cx + view2.panX + x * view2.zoom, view2.cy + view2.panY + y * view2.zoom)
  await page.waitForTimeout(200)
  return page.evaluate(() => window.__pfState().selectedIds)
}
const onPainted = await clickAt2(150, 200)
check('the drawn half of a cut-out takes the click',
  onPainted.join() === cutout.img, onPainted.join())
const onEmpty = await clickAt2(250, 200)
check('and its empty half does not, so what is behind it is reachable',
  onEmpty.join() === cutout.under, onEmpty.join())

console.log(errors.length ? 'CONSOLE ERRORS: ' + errors.slice(0, 5).join(' | ') : 'no console errors')
await browser.close()
process.exit(checks.some(([, ok]) => !ok) ? 1 : 0)
