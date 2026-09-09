// Layer clipboard, the layers-panel context menu, and the polygonal lasso with
// its cut / mask / erase actions — asserted on rendered pixels, not just state.
import { chromium } from 'playwright-core'
import { importAndPlace } from '../e2e-helpers.mjs'
import fs from 'fs'
import path from 'path'

const OUT = 'shots-lasso'
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
const layerCount = () => page.evaluate(() => window.__pfState().doc.layers.length)

await page.goto('http://localhost:5173/', { waitUntil: 'networkidle' })
await page.evaluate(() => indexedDB.deleteDatabase('pixelforge'))
await page.reload({ waitUntil: 'networkidle' })
await importAndPlace(page, 'public/test/motion.gif', { timeout: 10000 })
await page.waitForTimeout(700)
await page.evaluate(() => { window.__pfState().setPlaying(false); window.__pfState().setTime(0) })

// --- clipboard --------------------------------------------------------------
await page.evaluate(() => {
  const s = window.__pfState()
  s.select([s.doc.layers[0].id])
})
await page.locator('.stage canvas').click({ position: { x: 5, y: 5 } }) // focus the document
await page.evaluate(() => window.__pfState().select([window.__pfState().doc.layers[0].id]))
await page.waitForTimeout(150)

const base = await layerCount()
await page.keyboard.press('Control+c')
await page.waitForTimeout(150)
const copied = await page.evaluate(() => window.__pfState().clipboard.length)
check('Ctrl+C copies the selected layer', copied === 1)

await page.keyboard.press('Control+v')
await page.waitForTimeout(300)
const pasted = await layerCount()
console.log('layers after paste:', pasted, '(was', base, ')')
check('Ctrl+V pastes it as a new layer', pasted === base + 1)
check('the pasted layer becomes the selection',
  await page.evaluate(() => window.__pfState().selectedIds.length) === 1)

const offset = await page.evaluate(() => {
  const ls = window.__pfState().doc.layers
  return { a: ls[0].x, b: ls[ls.length - 1].x }
})
check('the pasted copy is offset so it is visible', offset.b === offset.a + 16)

await page.keyboard.press('Control+x')
await page.waitForTimeout(300)
check('Ctrl+X removes the layer again', (await layerCount()) === base)

// --- layers panel context menu ---------------------------------------------
await page.locator('.layer').first().click({ button: 'right' })
await page.waitForTimeout(250)
check('right-clicking a layer opens a context menu',
  (await page.locator('.ctx-menu').count()) === 1)
const menuItems = await page.locator('.ctx-menu .ctx-item').allTextContents()
console.log('menu items:', JSON.stringify(menuItems))
check('the menu offers duplicate, copy and delete',
  menuItems.some((t) => t.startsWith('Duplicate')) &&
  menuItems.some((t) => t.startsWith('Copy')) &&
  menuItems.some((t) => t.startsWith('Delete')))

await page.locator('.ctx-menu .ctx-item', { hasText: 'Duplicate' }).first().click()
await page.waitForTimeout(300)
check('Duplicate from the menu adds a layer', (await layerCount()) === base + 1)
check('the menu closes after choosing an item',
  (await page.locator('.ctx-menu').count()) === 0)

await page.evaluate(() => {
  const s = window.__pfState()
  s.removeLayers(s.doc.layers.slice(1).map((l) => l.id))
})
await page.waitForTimeout(200)

// --- polygonal lasso --------------------------------------------------------
await page.evaluate(() => window.__pfState().select([window.__pfState().doc.layers[0].id]))
await page.keyboard.press('l')
await page.waitForTimeout(450)

const view = await page.evaluate(() => {
  const s = window.__pfState()
  const r = document.querySelector('.stage canvas').getBoundingClientRect()
  return { cx: r.x, cy: r.y, ...s.view }
})
const at = (dx, dy) => [view.cx + view.panX + dx * view.zoom, view.cy + view.panY + dy * view.zoom]

// Plot a square by clicking four corners, then close on the first point.
const SQUARE = [[40, 40], [140, 40], [140, 120], [40, 120]]
for (const [x, y] of SQUARE) {
  const [sx, sy] = at(x, y)
  await page.mouse.click(sx, sy)
  await page.waitForTimeout(90)
}
const [fx, fy] = at(SQUARE[0][0], SQUARE[0][1])
await page.mouse.click(fx, fy)
await page.waitForTimeout(300)

const lasso = await page.evaluate(() => window.__pfState().lasso)
console.log('lasso points:', lasso?.points?.length)
check('clicking plots points and closing commits the outline', lasso?.points?.length === 4)
check('the lasso action bar appears', (await page.locator('.lasso-bar').count()) === 1)
await page.screenshot({ path: path.join(OUT, '01-lasso.png') })

// --- cut to a new layer -----------------------------------------------------
const beforeCut = await layerCount()
await page.locator('.lasso-bar button', { hasText: 'Cut to layer' }).click()
await page.waitForTimeout(400)
const afterCut = await page.evaluate(() => {
  const s = window.__pfState()
  return {
    count: s.doc.layers.length,
    // The hole the piece left behind is an erase region, not an inverted mask:
    // a layer has one mask, so cutting a second piece would have filled in the
    // first hole. Strokes accumulate.
    original: {
      regions: (s.doc.layers[0].erase?.strokes || []).filter((x) => x.kind === 'region').length,
      mask: !!s.doc.layers[0].mask,
    },
    piece: {
      mask: !!s.doc.layers[1].mask,
      invert: s.doc.layers[1].mask?.invert,
      x: Math.round(s.doc.layers[1].x), y: Math.round(s.doc.layers[1].y),
      w: Math.round(s.doc.layers[1].w), h: Math.round(s.doc.layers[1].h),
    },
  }
})
console.log('after cut:', JSON.stringify(afterCut))
check('cut adds one new layer', afterCut.count === beforeCut + 1)
check('the original keeps everything outside the outline',
  afterCut.original.regions === 1 && !afterCut.original.mask,
  JSON.stringify(afterCut.original))
check('the cut-out keeps only what was inside',
  afterCut.piece.mask && afterCut.piece.invert === false)
check('the cut-out layer box hugs the outline',
  afterCut.piece.x === 40 && afterCut.piece.y === 40 &&
  afterCut.piece.w === 100 && afterCut.piece.h === 80)

// Pixels: with the cut-out hidden, the hole must be transparent.
const holes = await page.evaluate(() => {
  const s = window.__pfState()
  const c = document.createElement('canvas')
  c.width = s.doc.width
  c.height = s.doc.height
  const ctx = c.getContext('2d', { willReadFrequently: true })
  const alphaAt = (doc, x, y) => {
    window.__pfRender.renderDocument(ctx, doc, 0)
    return ctx.getImageData(x, y, 1, 1).data[3]
  }
  const hidePiece = {
    ...s.doc,
    layers: s.doc.layers.map((l, i) => (i === 1 ? { ...l, visible: false } : l)),
  }
  const onlyPiece = {
    ...s.doc,
    layers: s.doc.layers.map((l, i) => (i === 0 ? { ...l, visible: false } : l)),
  }
  return {
    holeInOriginal: alphaAt(hidePiece, 90, 80),
    originalOutside: alphaAt(hidePiece, 10, 10),
    pieceInside: alphaAt(onlyPiece, 90, 80),
    pieceOutside: alphaAt(onlyPiece, 10, 10),
    bothTogether: alphaAt(s.doc, 90, 80),
  }
})
console.log('alpha probes:', JSON.stringify(holes))
check('the cut leaves a real hole in the original', holes.holeInOriginal === 0)
check('the original is untouched outside the outline', holes.originalOutside === 255)
check('the cut-out layer carries the removed pixels', holes.pieceInside === 255)
check('the cut-out layer is empty outside the outline', holes.pieceOutside === 0)
check('the two layers together still cover the whole image', holes.bothTogether === 255)
await page.screenshot({ path: path.join(OUT, '02-after-cut.png') })

// The cut-out must still animate — masking cannot flatten the GIF.
const animates = await page.evaluate(() => {
  const s = window.__pfState()
  const c = document.createElement('canvas')
  c.width = s.doc.width
  c.height = s.doc.height
  const ctx = c.getContext('2d', { willReadFrequently: true })
  const sig = (t) => {
    window.__pfRender.renderDocument(ctx, s.doc, t)
    const d = ctx.getImageData(40, 40, 100, 80).data
    let h = 2166136261
    for (let i = 0; i < d.length; i += 5) { h ^= d[i]; h = Math.imul(h, 16777619) }
    return (h >>> 0).toString(16)
  }
  return sig(0) !== sig(600)
})
check('the masked cut-out still animates frame by frame', animates)

await page.keyboard.press('Control+z')
await page.waitForTimeout(300)
check('undo reverses the cut in one step', (await layerCount()) === beforeCut)

// --- freehand trace + mask --------------------------------------------------
await page.keyboard.press('l')
await page.waitForTimeout(400)
const [tx, ty] = at(60, 60)
await page.mouse.move(tx, ty)
await page.mouse.down()
for (const [dx, dy] of [[60, 0], [60, 50], [0, 50]]) {
  const [mx, my] = at(60 + dx, 60 + dy)
  await page.mouse.move(mx, my, { steps: 6 })
}
await page.mouse.up()
await page.waitForTimeout(300)
const traced = await page.evaluate(() => window.__pfState().lasso?.points?.length || 0)
console.log('freehand points:', traced)
check('press-and-drag traces a freehand outline', traced > 5)

await page.locator('.lasso-bar button', { hasText: 'Mask' }).click()
await page.waitForTimeout(300)
const masked = await page.evaluate(() => {
  const s = window.__pfState()
  const l = s.doc.layers[0]
  const c = document.createElement('canvas')
  c.width = s.doc.width
  c.height = s.doc.height
  const ctx = c.getContext('2d', { willReadFrequently: true })
  window.__pfRender.renderDocument(ctx, s.doc, 0)
  return {
    invert: l.mask?.invert,
    inside: ctx.getImageData(90, 85, 1, 1).data[3],
    outside: ctx.getImageData(5, 5, 1, 1).data[3],
  }
})
console.log('mask probes:', JSON.stringify(masked))
check('Mask keeps only what is inside the outline',
  masked.invert === false && masked.inside === 255 && masked.outside === 0)
await page.screenshot({ path: path.join(OUT, '03-mask.png') })

// --- masking shrink-wraps the layer ---------------------------------------------------
// A layer that still measures the whole photo after cutting one person out of it
// puts the handles, the rotation pivot and the snapping nowhere near the thing
// you can see.
// The suite has cut and cropped this layer by now, so a fresh one is imported
// rather than assuming a pristine 320x200 at the origin.
await page.evaluate(() => window.__pfState().resetDoc())
await page.waitForTimeout(200)
await importAndPlace(page, 'public/test/greenscreen.gif', { timeout: 20000 })
await page.evaluate(() => { window.__pfState().setPlaying(false); window.__pfState().setTime(0) })
await page.waitForTimeout(400)

const wrap = await page.evaluate(() => {
  const st = window.__pfState()
  const id = st.doc.layers[0].id
  st.select([id])
  const shoot = () => {
    const s2 = window.__pfState()
    const c = document.createElement('canvas')
    c.width = s2.doc.width
    c.height = s2.doc.height
    const ctx = c.getContext('2d', { willReadFrequently: true })
    window.__pfRender.renderDocument(ctx, s2.doc, 0)
    return ctx.getImageData(0, 0, c.width, c.height)
  }
  const before = { ...st.doc.layers.find((l) => l.id === id) }
  // A square around the fixture's disc, which sits at (250, 100) with r=34.
  const square = [[214, 64], [286, 64], [286, 136], [214, 136]]
  // The mask is applied on its own first and photographed, because masking
  // legitimately changes almost every pixel — the claim being tested is that
  // the *trim* that follows it changes none of them.
  st.updateLayer(id, {
    mask: { points: window.__pfShapes.polygonToLayer(square, before), invert: false, feather: 0 },
  })
  const shotBefore = shoot()
  st.setLasso({ points: square })
  const res = st.applyLasso('mask')
  const shotAfter = shoot()
  const after = window.__pfState().doc.layers.find((l) => l.id === id)
  let diff = 0
  for (let i = 0; i < shotBefore.data.length; i += 4) {
    for (let k = 0; k < 4; k++) {
      if (Math.abs(shotBefore.data[i + k] - shotAfter.data[i + k]) > 3) { diff++; break }
    }
  }
  return {
    text: res.text,
    before: [Math.round(before.x), Math.round(before.y), Math.round(before.w), Math.round(before.h)],
    after: [Math.round(after.x), Math.round(after.y), Math.round(after.w), Math.round(after.h)],
    maskPts: after.mask.points.map((q) => q.map((v) => +v.toFixed(3))),
    src: after.src ? Object.fromEntries(Object.entries(after.src).map(([k, v]) => [k, +v.toFixed(3)])) : null,
    diff,
    total: shotBefore.data.length / 4,
  }
})
console.log('mask trim:', JSON.stringify(wrap))
check('masking shrinks the layer to what is left',
  wrap.after[2] === 72 && wrap.after[3] === 72, wrap.after.join(','))
check('and moves it to sit on the cut-out',
  wrap.after[0] === 214 && wrap.after[1] === 64, wrap.after.slice(0, 2).join(','))
// The points are fractions of the layer box, so shrinking the box without
// rebasing them would slide the mask across the picture.
check('the mask is renormalised onto the new box',
  JSON.stringify(wrap.maskPts) === '[[0,0],[1,0],[1,1],[0,1]]', JSON.stringify(wrap.maskPts))
check('a source window is set rather than pixels being baked', !!wrap.src && wrap.src.w < 1)
// A handful of pixels differ from resampling at a new scale; more means it moved.
check('and trimming moves nothing on screen', wrap.diff < wrap.total * 0.01,
  `${wrap.diff} of ${wrap.total} pixels differ between masked and masked-then-trimmed`)
check('the message says both things happened', /trimmed/i.test(wrap.text || ''), wrap.text)

await page.evaluate(() => window.__pfState().undo())
await page.waitForTimeout(250)
const back = await page.evaluate(() => {
  const l = window.__pfState().doc.layers[0]
  return [Math.round(l.w), Math.round(l.h)]
})
check('undo restores the whole frame', back[0] === 320 && back[1] === 200, back.join('x'))
await page.evaluate(() => window.__pfState().clearLasso())

// --- text behind, straight from an outline ------------------------------------------
// Reaching for the lasso and expecting to put something behind what you just
// outlined is the natural order. It used to demand background removal instead,
// which is a different panel and a different mental model.
await page.evaluate(() => {
  const st = window.__pfState()
  st.select([st.doc.layers[0].id])
  st.setLasso({ points: [[80, 40], [240, 40], [240, 160], [80, 160]] })
})
await page.waitForTimeout(250)
const barButtons = await page.evaluate(() =>
  [...document.querySelectorAll('.lasso-bar button')].map((b) => b.textContent.trim()))
console.log('lasso bar:', JSON.stringify(barButtons))
check('the outline bar offers Text behind', barButtons.includes('Text behind'),
  barButtons.join(', '))

const layersBefore = await page.evaluate(() => window.__pfState().doc.layers.length)
await page.click('.lasso-bar button:has-text("Text behind")')
await page.waitForTimeout(500)
const built = await page.evaluate(() => {
  const st = window.__pfState()
  const ls = st.doc.layers
  return {
    added: ls.length,
    masked: ls.filter((l) => l.type === 'image' && (l.mask?.points?.length || 0) >= 3).length,
    whole: ls.filter((l) => l.type === 'image' && !(l.mask?.points?.length >= 3)).length,
    hasText: ls.some((l) => l.type === 'text'),
    selectedIsText: ls.find((l) => l.id === st.selectedIds[0])?.type,
    lasso: st.lasso,
    // Cropping the backdrop as well would cut the photograph down to the person
    // standing in it, which is the opposite of a text-behind sandwich.
    wholeBox: (() => {
      const w = ls.find((l) => l.type === 'image' && !(l.mask?.points?.length >= 3))
      return w ? [Math.round(w.x), Math.round(w.y), Math.round(w.w), Math.round(w.h)] : null
    })(),
    maskedBox: (() => {
      const m = ls.find((l) => l.type === 'image' && (l.mask?.points?.length || 0) >= 3)
      return m ? [Math.round(m.x), Math.round(m.y), Math.round(m.w), Math.round(m.h)] : null
    })(),
    maskedId: ls.find((l) => l.type === 'image' && (l.mask?.points?.length || 0) >= 3)?.id,
    outlineTarget: ls.find((l) => l.type === 'text')?.outlineAbove,
  }
})
console.log('after Text behind:', JSON.stringify(built))
check('the photograph underneath stays whole', built.wholeBox
  && built.wholeBox[2] === 320 && built.wholeBox[3] === 200,
  (built.wholeBox || []).join(','))
check('while the cut-out copy shrink-wraps to the selection',
  built.maskedBox && built.maskedBox[2] < 200 && built.maskedBox[3] < 200,
  (built.maskedBox || []).join(','))
check('and the outline is aimed at that cut-out', built.outlineTarget === built.maskedId,
  `${built.outlineTarget} vs ${built.maskedId}`)
check('one click turns an outline into the sandwich', built.added === layersBefore + 3,
  `${layersBefore} -> ${built.added}`)
check('with the masked copy on top and the whole photo beneath',
  built.masked === 1 && built.whole === 1, `${built.masked} masked, ${built.whole} whole`)
check('a text layer in between, already selected so you can type',
  built.hasText && built.selectedIsText === 'text', String(built.selectedIsText))
check('and the outline is consumed', built.lasso === null)
// It ends with a text layer selected and waiting to be typed into, so staying
// in the lasso would mean the next click plots a point on top of it.
check('and it hands you back the move tool',
  await page.evaluate(() => window.__pfState().tool) === 'move',
  await page.evaluate(() => window.__pfState().tool))

// The masked copy must actually occlude: text is hidden inside the outline and
// visible outside it. That is the whole claim.
const occluded = await page.evaluate(() => {
  const st = window.__pfState()
  const text = st.doc.layers.find((l) => l.type === 'text')
  st.updateLayer(text.id, {
    text: 'BEHIND THE SUBJECT', x: 0, y: 80, w: st.doc.width, h: 60, size: 40,
    align: 'center', color: '#0000ff', strokeWidth: 0,
    // Text-behind now turns on the show-through outline by default, which
    // deliberately draws the letters' edges over the subject. This check is
    // about the *fill* being hidden, so the outline is switched off here — it
    // has its own coverage in e2e-text.
    outlineAbove: false,
  })
  st.setDoc({ background: '#ffffff' })
  const c = document.createElement('canvas')
  c.width = st.doc.width
  c.height = st.doc.height
  const ctx = c.getContext('2d', { willReadFrequently: true })
  window.__pfRender.renderDocument(ctx, window.__pfState().doc, 0)
  const d = ctx.getImageData(0, 0, c.width, c.height).data
  let inside = 0
  let outside = 0
  for (let y = 82; y < 138; y++) {
    for (let x = 0; x < c.width; x++) {
      const i = (y * c.width + x) * 4
      if (!(d[i] < 90 && d[i + 1] < 90 && d[i + 2] > 150)) continue
      if (x >= 84 && x <= 236) inside++
      else outside++
    }
  }
  return { inside, outside }
})
console.log('blue text pixels:', JSON.stringify(occluded))
check('the subject hides the text inside the outline', occluded.inside === 0,
  `${occluded.inside} px`)
check('and the text still shows outside it', occluded.outside > 60, `${occluded.outside} px`)

console.log(errors.length ? '\nCONSOLE ERRORS:\n  ' + errors.slice(0, 10).join('\n  ') : '\nno console errors')
await browser.close()
process.exit(checks.some(([, ok]) => !ok) ? 1 : 0)
