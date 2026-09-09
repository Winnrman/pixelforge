// Repairing a mask instead of redrawing it.
//
// Cutting a subject out is one gesture and getting it perfect is not. The cut
// takes a slice off an arm or a leg, and until now the only answer was to draw
// the whole outline again — on a shape traced by the AI selector, that is
// hundreds of points thrown away to win back a sliver.
//
// So a mask is several outlines that union. The missing piece is drawn on its
// own and added, and if it reaches outside the layer's frame — which is exactly
// where a cut that was too tight leaves it, because masking trims the frame down
// to what was kept — the frame grows to meet it.
//
// Measured in pixels off a real render. "Did the fields change" cannot tell the
// difference between a piece added and a hole punched, and punching a hole is
// the failure this is one winding order away from.
import { chromium } from 'playwright-core'
import fs from 'fs'
import path from 'path'

const OUT = 'shots-maskedit'
fs.mkdirSync(OUT, { recursive: true })

const browser = await chromium.launch({
  executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  headless: true,
})
const page = await browser.newPage({ viewport: { width: 1500, height: 950 } })
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

// A solid picture, so whatever the mask keeps is opaque and whatever it drops is
// nothing. Every sample below is "is there anything here", which is the only
// question a mask answers.
const start = await page.evaluate(async () => {
  const st = window.__pfState()
  st.setPlaying(false)
  const c = document.createElement('canvas')
  c.width = 400
  c.height = 400
  const g = c.getContext('2d')
  g.fillStyle = '#00c000'
  g.fillRect(0, 0, 400, 400)
  const blob = await new Promise((r) => c.toBlob(r))
  await st.addImages([new File([blob], 'green.png', { type: 'image/png' })], { place: true })
  await new Promise((r) => setTimeout(r, 800))
  const l = window.__pfState().doc.layers[0]
  return { id: l.id, box: { x: l.x, y: l.y, w: l.w, h: l.h } }
})
const BOX = start.box

/** Is anything drawn at this fraction of where the picture originally was? */
const litAt = (fx, fy) => page.evaluate(([x, y]) => {
  const st = window.__pfState()
  const c = document.createElement('canvas')
  c.width = st.doc.width
  c.height = st.doc.height
  const ctx = c.getContext('2d', { willReadFrequently: true })
  window.__pfRender.renderDocument(ctx, st.doc, 0)
  return ctx.getImageData(Math.round(x), Math.round(y), 1, 1).data[3] > 128
}, [BOX.x + BOX.w * fx, BOX.y + BOX.h * fy])

const lasso = (pts) => page.evaluate(([box, ps, id]) => {
  const st = window.__pfState()
  st.select([id])
  st.setLasso({
    points: ps.map(([fx, fy]) => [box.x + box.w * fx, box.y + box.h * fy]),
    closed: true,
  })
}, [BOX, pts, start.id])

const layer = () => page.evaluate((id) => {
  const l = window.__pfState().doc.layers.find((x) => x.id === id)
  return {
    x: Math.round(l.x), y: Math.round(l.y), w: Math.round(l.w), h: Math.round(l.h),
    outlines: 1 + (l.mask?.plus?.length || 0),
  }
}, start.id)

// --- cut it too tight -------------------------------------------------------------
// The left half only, standing in for an outline that missed a leg.
await lasso([[0.05, 0.05], [0.5, 0.05], [0.5, 0.95], [0.05, 0.95]])
const masked = await page.evaluate(() => window.__pfState().applyLasso('mask'))
await page.waitForTimeout(400)
const trimmed = await layer()
console.log('after masking to the left half:', JSON.stringify(masked), JSON.stringify(trimmed))
check('masking keeps what was inside the outline', masked.ok === true && await litAt(0.25, 0.5))
check('and drops what was outside it', !(await litAt(0.75, 0.5)))
// This is what makes the repair awkward and is the reason the frame has to grow:
// the frame is now the size of what was kept, so the piece that was missed is
// not merely uncovered, it is outside the layer altogether.
check('and shrinks the frame to what it kept', trimmed.w < BOX.w * 0.6, `${trimmed.w}px of ${BOX.w}`)

// --- add the missing piece back ----------------------------------------------------
await lasso([[0.55, 0.3], [0.9, 0.3], [0.9, 0.7], [0.55, 0.7]])
const added = await page.evaluate(() => window.__pfState().applyLasso('mask-add'))
await page.waitForTimeout(400)
const grown = await layer()
console.log('after adding a piece outside the frame:', JSON.stringify(added), JSON.stringify(grown))
check('a piece can be added to a mask that already exists', added.ok === true, JSON.stringify(added))
check('and the mask is two outlines now', grown.outlines === 2, `${grown.outlines}`)
check('the frame grew to hold the piece', grown.w > trimmed.w * 1.5, `${trimmed.w} -> ${grown.w}`)
check('the piece is drawn', await litAt(0.75, 0.5))
check('and so is everything that was already there', await litAt(0.25, 0.5))
check('while the gap between them stays out', !(await litAt(0.52, 0.5)))
check('and so does everything above the piece', !(await litAt(0.75, 0.1)))
await page.screenshot({ path: path.join(OUT, '01-added.png') })

// --- a piece that overlaps, drawn the other way round -------------------------------
// The real repair: a sliver that laps onto what is already kept. Canvas unions
// subpaths for nothing, but only wound the same way — wound against each other
// the nonzero rule reads the overlap as a hole, and the fix bites a chunk out of
// the subject instead of filling one in. Which way round somebody draws a lasso
// is not something they decide.
// Both ways round, rather than whichever one I believed was the dangerous one:
// the first version of this test reversed the outline and reversed it into
// agreement with the base by luck, so it passed with the winding fix taken out.
const box = [[0.3, 0.4], [0.3, 0.6], [0.45, 0.6], [0.45, 0.4]]
for (const [name, pts] of [['one way', box], ['the other', [...box].reverse()]]) {
  await lasso(pts)
  const res = await page.evaluate(() => window.__pfState().applyLasso('mask-add'))
  await page.waitForTimeout(400)
  const kept = await litAt(0.37, 0.5)
  const rest = await litAt(0.15, 0.5)
  console.log(`an overlapping piece drawn ${name}:`, JSON.stringify(res), { kept, rest })
  check(`a piece drawn ${name} round adds`, res.ok === true, JSON.stringify(res))
  check(`and its overlap is still there rather than punched out (${name})`, kept)
  check(`with the rest of the subject (${name})`, rest)
  await page.evaluate((id) => window.__pfState().undoMaskAdd(id), start.id)
  await page.waitForTimeout(250)
}
// Left added, for the checks below.
await lasso(box)
await page.evaluate(() => window.__pfState().applyLasso('mask-add'))
await page.waitForTimeout(400)

// --- taking one back ----------------------------------------------------------------
const undone = await page.evaluate(async (id) => {
  window.__pfState().undoMaskAdd(id)
  await new Promise((r) => setTimeout(r, 300))
  const l = window.__pfState().doc.layers.find((x) => x.id === id)
  return { outlines: 1 + (l.mask?.plus?.length || 0) }
}, start.id)
console.log('after taking the last piece back:', JSON.stringify(undone))
check('the last piece added can be taken back', undone.outlines === 2, `${undone.outlines}`)
check('and the one before it stays', await litAt(0.75, 0.5))

// --- the button is offered where it means something ----------------------------------
// It takes the place of Mask rather than sitting beside it: on a layer already
// cut out, a second outline nearly always means "and this bit too".
const bar = await page.evaluate(async (id) => {
  const st = window.__pfState()
  st.select([id])
  st.setLasso({ points: [[10, 10], [80, 10], [80, 80], [10, 80]], closed: true })
  await new Promise((r) => setTimeout(r, 300))
  const withMask = [...document.querySelectorAll('.lasso-bar button')].map((b) => b.textContent.trim())
  // And on a layer with no mask at all.
  st.clearMask(id)
  await new Promise((r) => setTimeout(r, 300))
  const without = [...document.querySelectorAll('.lasso-bar button')].map((b) => b.textContent.trim())
  return { withMask, without }
}, start.id)
console.log('the lasso bar:', JSON.stringify(bar))
check('a masked layer is offered Add to mask',
  bar.withMask.includes('Add to mask'), bar.withMask.join(' '))
check('and not Mask, which would throw the outline away',
  !bar.withMask.includes('Mask'), bar.withMask.join(' '))
check('an unmasked one is offered Mask',
  bar.without.includes('Mask') && !bar.without.includes('Add to mask'), bar.without.join(' '))
await page.screenshot({ path: path.join(OUT, '02-bar.png') })

// --- trimming after a repair ---------------------------------------------------------
// Trimming fits the frame to the mask, and it used to measure only the outline
// the mask started as. On a repaired mask that means fitting the frame to the
// original cut and shaving the repair straight back off — the one thing the
// repair was for.
const retrim = await page.evaluate(async (id) => {
  const st = window.__pfState()
  st.clearMask(id)
  await new Promise((r) => setTimeout(r, 200))
  const l = window.__pfState().doc.layers.find((x) => x.id === id)
  const box = { x: l.x, y: l.y, w: l.w, h: l.h }
  const at = (fx, fy) => [box.x + box.w * fx, box.y + box.h * fy]
  st.select([id])
  st.setLasso({ points: [at(0.05, 0.05), at(0.4, 0.05), at(0.4, 0.95), at(0.05, 0.95)], closed: true })
  st.applyLasso('mask')
  await new Promise((r) => setTimeout(r, 400))
  st.setLasso({ points: [at(0.45, 0.3), at(0.95, 0.3), at(0.95, 0.7), at(0.45, 0.7)], closed: true })
  window.__pfState().applyLasso('mask-add')
  await new Promise((r) => setTimeout(r, 400))
  const wide = window.__pfState().doc.layers.find((x) => x.id === id)
  window.__pfState().trimToSubject(id, { quiet: true })
  await new Promise((r) => setTimeout(r, 400))
  const after = window.__pfState().doc.layers.find((x) => x.id === id)
  return { wide: Math.round(wide.w), after: Math.round(after.w), original: Math.round(box.w) }
}, start.id)
console.log('trimming a repaired mask:', JSON.stringify(retrim))
check('trimming a repaired mask measures the repair too',
  retrim.after > retrim.wide * 0.9, `${retrim.wide} -> ${retrim.after}`)

// --- editing the outline itself --------------------------------------------------------
// Adding a piece is a repair. This is the edit: the outline that cut too tight
// comes back as an ordinary lasso with its points intact, so a corner that
// clipped a leg can be dragged out rather than the whole shape drawn again.
const edit = await page.evaluate(async (id) => {
  const st = window.__pfState()
  st.clearMask(id)
  await new Promise((r) => setTimeout(r, 250))
  const l = window.__pfState().doc.layers.find((x) => x.id === id)
  const box = { x: l.x, y: l.y, w: l.w, h: l.h }
  const at = (fx, fy) => [box.x + box.w * fx, box.y + box.h * fy]
  st.select([id])
  // Cut too tight: the right edge stops at 40% when the subject runs to 80%.
  st.setLasso({ points: [at(0.05, 0.05), at(0.4, 0.05), at(0.4, 0.95), at(0.05, 0.95)], closed: true })
  st.applyLasso('mask')
  await new Promise((r) => setTimeout(r, 400))
  const cut = window.__pfState().doc.layers.find((x) => x.id === id)
  const trimmed = { w: Math.round(cut.w), src: Math.round(cut.src.w * 100) }

  const res = window.__pfState().editMask(id)
  await new Promise((r) => setTimeout(r, 400))
  const s2 = window.__pfState()
  const opened = s2.doc.layers.find((x) => x.id === id)
  const pts = s2.lasso.points
  const xs = pts.map((q) => q[0])
  return {
    res,
    trimmed,
    box,
    opened: { w: Math.round(opened.w), src: Math.round((opened.src?.w ?? 1) * 100), masked: !!opened.mask },
    tool: s2.tool,
    outline: { n: pts.length, right: Math.round(Math.max(...xs)), left: Math.round(Math.min(...xs)) },
  }
}, start.id)
console.log('editing a mask:', JSON.stringify(edit))
check('a mask can be handed back to the lasso', edit.res.ok === true, JSON.stringify(edit.res))
check('with the same number of points it was cut with', edit.outline.n === 4, `${edit.outline.n}`)
check('and in the same place on the picture',
  Math.abs(edit.outline.left - (edit.box.x + edit.box.w * 0.05)) < 3
  && Math.abs(edit.outline.right - (edit.box.x + edit.box.w * 0.4)) < 3,
  JSON.stringify(edit.outline))
// Both of these are the difference between editing and merely appearing to. The
// frame is opened back out, because the edge you are trying to win back is
// outside a frame that was trimmed to what the cut kept — invisible, and a point
// you cannot see is a point you cannot drag. And the mask comes off, so what you
// drag the outline over is the photograph rather than the cut-out of it.
check('the frame opens back out to the whole picture',
  edit.opened.w > edit.trimmed.w * 2 && edit.opened.src > 95,
  `${edit.trimmed.w}px/${edit.trimmed.src}% -> ${edit.opened.w}px/${edit.opened.src}%`)
check('and the mask comes off while you work on it', edit.opened.masked === false)
check('with the lasso tool in hand', edit.tool === 'lasso', edit.tool)

// Drag the two right-hand points out, and put it back.
const redone = await page.evaluate(async (id) => {
  const st = window.__pfState()
  const box = st.doc.layers.find((x) => x.id === id)
  const wide = box.x + box.w * 0.8
  st.setLasso({
    points: st.lasso.points.map(([x, y]) => [x > box.x + box.w * 0.3 ? wide : x, y]),
    closed: true,
  })
  const res = window.__pfState().applyLasso('mask')
  await new Promise((r) => setTimeout(r, 500))
  const l = window.__pfState().doc.layers.find((x) => x.id === id)
  return { res, w: Math.round(l.w), outlines: 1 + (l.mask?.plus?.length || 0) }
}, start.id)
console.log('after dragging the edge out and re-masking:', JSON.stringify(redone))
check('the edited outline goes back on as the mask',
  redone.res.ok === true && redone.outlines === 1, JSON.stringify(redone))
check('and it keeps the wider shape it was dragged to',
  redone.w > edit.trimmed.w * 1.7, `${edit.trimmed.w} -> ${redone.w}`)
check('the leg that was cut off is there now', await litAt(0.6, 0.5))
check('and what was outside the outline still is not', !(await litAt(0.9, 0.5)))
await page.screenshot({ path: path.join(OUT, '03-edited.png') })

// --- the brush -----------------------------------------------------------------------
// An outline is a closed shape drawn round the thing being fixed, which is right
// for a missed sliver and tedious for a ragged edge. A brush has no outline to
// close: paint over what should be kept, paint over what should not.
//
// Measured in pixels, because "the stroke was recorded" cannot tell the
// difference between a mask that changed and one that changed in the wrong
// direction — and Keep and Remove are one sign apart.
// Measured against the frame the layer is in *now*: by this point the suite has
// cropped and re-cut it several times, and the box it started in is long gone.
const litIn = (box, fx, fy) => page.evaluate(([x, y]) => {
  const st = window.__pfState()
  const c = document.createElement('canvas')
  c.width = st.doc.width
  c.height = st.doc.height
  const ctx = c.getContext('2d', { willReadFrequently: true })
  window.__pfRender.renderDocument(ctx, st.doc, 0)
  return ctx.getImageData(Math.round(x), Math.round(y), 1, 1).data[3] > 128
}, [box.x + box.w * fx, box.y + box.h * fy])

const PBOX = await page.evaluate(async (id) => {
  const st = window.__pfState()
  st.clearMask(id)
  await new Promise((r) => setTimeout(r, 250))
  const l = window.__pfState().doc.layers.find((x) => x.id === id)
  const at = (fx, fy) => [l.x + l.w * fx, l.y + l.h * fy]
  st.select([id])
  // Cut to the left half again: the right half is what the brush has to win back.
  st.setLasso({ points: [at(0.05, 0.05), at(0.5, 0.05), at(0.5, 0.95), at(0.05, 0.95)], closed: true })
  st.applyLasso('mask')
  await new Promise((r) => setTimeout(r, 400))
  return { x: l.x, y: l.y, w: l.w, h: l.h }
}, start.id)
const lit = (fx, fy) => litIn(PBOX, fx, fy)
check('the right half is out after the cut', !(await lit(0.7, 0.5)))

// A stroke straight across the middle, in document coordinates — which is what
// the canvas hands the store, because the frame may open out as the stroke
// starts and a fraction of a box that is about to change is a fraction of
// nothing.
const painted = await page.evaluate(async ([id, box]) => {
  const st = window.__pfState()
  st.setToolOptions({ maskBrush: { ...st.toolOptions.maskBrush, size: 0.12, hardness: 1, mode: 'add' } })
  const at = (fx, fy) => [box.x + box.w * fx, box.y + box.h * fy]
  const began = st.beginMaskPaint(id, at(0.45, 0.5), { mode: 'add' })
  for (let f = 0.45; f <= 0.85; f += 0.02) window.__pfState().extendMaskPaint(id, at(f, 0.5))
  await new Promise((r) => setTimeout(r, 400))
  const l = window.__pfState().doc.layers.find((x) => x.id === id)
  return {
    began: !!began,
    strokes: l.mask?.paint?.length || 0,
    pts: l.mask.paint[0].pts.length,
    opened: Math.round(l.w),
  }
}, [start.id, PBOX])
console.log('after brushing the mask:', JSON.stringify(painted))
check('a brush stroke goes onto the mask', painted.began && painted.strokes === 1, JSON.stringify(painted))
check('and it keeps the points it was dragged through', painted.pts > 5, String(painted.pts))
// Keeping puts back what the cut took, and the cut trimmed the frame to what it
// kept — so what is being painted for is outside the frame, where there is
// nothing to paint onto. It opens back out first.
check('and the frame opens back out so there is something to paint onto',
  painted.opened > PBOX.w * 0.9, `${painted.opened} of ${Math.round(PBOX.w)}`)
check('what the brush painted is back', await lit(0.7, 0.5))
check('what it did not paint stays out', !(await lit(0.7, 0.15)))
check('and the outline it was added to is untouched', await lit(0.25, 0.5))
await page.screenshot({ path: path.join(OUT, '04-brushed.png') })

// One drag, one undo — the same promise the eraser makes.
const unpainted = await page.evaluate(async (id) => {
  window.__pfState().undoMaskPaint(id)
  await new Promise((r) => setTimeout(r, 350))
  const l = window.__pfState().doc.layers.find((x) => x.id === id)
  return { strokes: l.mask?.paint?.length || 0 }
}, start.id)
check('a stroke can be taken back', unpainted.strokes === 0, JSON.stringify(unpainted))
check('and what it painted goes with it', !(await lit(0.7, 0.5)))

// Remove is the same brush the other way round.
const removed = await page.evaluate(async ([id, box]) => {
  const st = window.__pfState()
  const at = (fx, fy) => [box.x + box.w * fx, box.y + box.h * fy]
  st.beginMaskPaint(id, at(0.15, 0.5), { mode: 'take' })
  for (let f = 0.15; f <= 0.4; f += 0.02) window.__pfState().extendMaskPaint(id, at(f, 0.5))
  await new Promise((r) => setTimeout(r, 400))
  const l = window.__pfState().doc.layers.find((x) => x.id === id)
  return { mode: l.mask.paint[0].mode, w: Math.round(l.w) }
}, [start.id, PBOX])
console.log('after brushing in Remove:', JSON.stringify(removed))
check('the same brush takes away as well as puts back', removed.mode === 'take', JSON.stringify(removed))
check('and what it painted over is gone', !(await lit(0.25, 0.5)))
check('while the rest of the cut-out stays', await lit(0.25, 0.15))

// The brush repairs a cut-out; on a layer that was never cut out it would just
// be the eraser wearing a different hat, so it says which tool that is instead.
const refused = await page.evaluate(async (id) => {
  const st = window.__pfState()
  st.undoMaskPaint(id)
  st.clearMask(id)
  await new Promise((r) => setTimeout(r, 300))
  const l = window.__pfState().doc.layers.find((x) => x.id === id)
  const began = window.__pfState().beginMaskPaint(id, [l.x + l.w / 2, l.y + l.h / 2], { mode: 'take' })
  return { began: !!began, notice: window.__pfState().notice?.text || '' }
}, start.id)
console.log('brushing a layer with nothing cut out:', JSON.stringify(refused))
check('brushing a layer that was never cut out does nothing', refused.began === false)
check('and says which tool does want that', /eraser/.test(refused.notice), refused.notice)

// --- brushed with no outline under it --------------------------------------------------
// A layer cut out by the eraser, or by a background key, has transparency but no
// outline. The mask has to start as "everything is kept" there, or the first dab
// in Remove takes the whole layer away and leaves the dab behind as the only
// thing on screen — the mask being built from nothing instead of from what is
// already there.
const noOutline = await page.evaluate(async (id) => {
  const st = window.__pfState()
  st.clearMask(id)
  await new Promise((r) => setTimeout(r, 250))
  const l = window.__pfState().doc.layers.find((x) => x.id === id)
  const box = { x: l.x, y: l.y, w: l.w, h: l.h }
  const at = (fx, fy) => [box.x + box.w * fx, box.y + box.h * fy]
  // Cut out with the eraser rather than an outline: no mask points at all.
  st.select([id])
  st.beginErase(id, [0.8, 0.8], { mode: 'erase', size: 0.3, hardness: 1 })
  st.extendErase(id, [0.9, 0.9])
  await new Promise((r) => setTimeout(r, 300))
  const began = window.__pfState().beginMaskPaint(id, at(0.2, 0.2), { mode: 'take' })
  for (let f = 0.2; f <= 0.35; f += 0.02) window.__pfState().extendMaskPaint(id, at(f, 0.2))
  await new Promise((r) => setTimeout(r, 400))
  const after = window.__pfState().doc.layers.find((x) => x.id === id)
  return { began: !!began, outline: after.mask?.points?.length || 0, box }
}, start.id)
console.log('brushing a layer with no outline:', JSON.stringify(noOutline.began))
check('a layer cut out without an outline can still be brushed', noOutline.began === true)
check('and it has no outline to have been brushed onto', noOutline.outline === 0)
check('what the stroke took is gone', !(await litIn(noOutline.box, 0.25, 0.2)))
check('and everything it did not touch is still there',
  await litIn(noOutline.box, 0.25, 0.6))

// --- a frame that grows under a stroke that is already on it ----------------------------
// Anything stored as a fraction of the box has to be read against the new one
// when the box changes, or it slides across the picture. Outlines and erase
// strokes are rebased; brush strokes on a mask are the third thing, and the one
// that is easy to forget because it only shows when a repair happens to grow the
// frame afterwards.
const regrown = await page.evaluate(async (id) => {
  const st = window.__pfState()
  st.clearMask(id)
  await new Promise((r) => setTimeout(r, 250))
  const l0 = window.__pfState().doc.layers.find((x) => x.id === id)
  const at0 = (fx, fy) => [l0.x + l0.w * fx, l0.y + l0.h * fy]
  st.select([id])
  st.setLasso({ points: [at0(0.1, 0.1), at0(0.5, 0.1), at0(0.5, 0.9), at0(0.1, 0.9)], closed: true })
  st.applyLasso('mask')
  await new Promise((r) => setTimeout(r, 400))

  // A stroke that takes a bite out of the middle of what was kept.
  const cut = window.__pfState().doc.layers.find((x) => x.id === id)
  const at = (fx, fy) => [cut.x + cut.w * fx, cut.y + cut.h * fy]
  window.__pfState().beginMaskPaint(id, at(0.3, 0.5), { mode: 'take' })
  for (let f = 0.3; f <= 0.5; f += 0.02) window.__pfState().extendMaskPaint(id, at(f, 0.5))
  await new Promise((r) => setTimeout(r, 400))
  const before = window.__pfState().doc.layers.find((x) => x.id === id)
  const box = { x: before.x, y: before.y, w: before.w, h: before.h }
  const stroke = before.mask.paint[0].pts[0]
  // The bite in document coordinates, so it can be looked for in the same place
  // after the frame moves underneath it.
  const spot = [before.x + before.w * stroke[0], before.y + before.h * stroke[1]]

  // Now add a piece that reaches outside the frame, which grows it.
  window.__pfState().setLasso({
    points: [at(1.05, 0.4), at(1.4, 0.4), at(1.4, 0.6), at(1.05, 0.6)],
    closed: true,
  })
  window.__pfState().applyLasso('mask-add')
  await new Promise((r) => setTimeout(r, 500))
  const after = window.__pfState().doc.layers.find((x) => x.id === id)
  const moved = after.mask.paint[0].pts[0]
  return {
    spot,
    grew: after.w > box.w * 1.05,
    was: box,
    now: { x: after.x, y: after.y, w: after.w, h: after.h },
    doc: [after.x + after.w * moved[0], after.y + after.h * moved[1]],
  }
}, start.id)
console.log('a frame grown under a brush stroke:', JSON.stringify(regrown))
check('adding a piece outside the frame grows it', regrown.grew === true, JSON.stringify(regrown.now))
check('and the stroke already on it stays where it was drawn',
  Math.abs(regrown.doc[0] - regrown.spot[0]) < 2 && Math.abs(regrown.doc[1] - regrown.spot[1]) < 2,
  JSON.stringify([regrown.spot, regrown.doc]))
await page.screenshot({ path: path.join(OUT, '08-regrown.png') })

// --- the settings live with the tool -------------------------------------------------
// They used to be in the inspector, on the far side of the window from the brush
// that needs them: pick the tool on the left, paint in the middle, cross to the
// right to feather it, and back again.
const rail = await page.evaluate(async (id) => {
  const st = window.__pfState()
  const l = st.doc.layers.find((x) => x.id === id)
  const at = (fx, fy) => [l.x + l.w * fx, l.y + l.h * fy]
  st.select([id])
  st.setLasso({ points: [at(0.1, 0.1), at(0.6, 0.1), at(0.6, 0.9), at(0.1, 0.9)], closed: true })
  st.applyLasso('mask')
  await new Promise((r) => setTimeout(r, 400))
  window.__pfState().setTool('mask')
  await new Promise((r) => setTimeout(r, 350))
  const inspector = document.querySelector('.inspector')?.textContent || ''
  return {
    text: document.querySelector('.rail-options')?.textContent || '',
    labels: [...document.querySelectorAll('.rail-options .rail-opt-label')].map((n) => n.textContent.trim()),
    buttons: [...document.querySelectorAll('.rail-options button')].map((n) => n.textContent.trim()),
    inspectorHasFeather: /Feather/.test(inspector),
  }
}, start.id)
console.log('the mask tool panel:', JSON.stringify(rail.buttons))
check('the mask tool offers Keep and Remove',
  /Keep/.test(rail.text) && /Remove/.test(rail.text), rail.text.slice(0, 120))
check('with the brush size and hardness beside them',
  rail.labels.includes('Brush size') && rail.labels.includes('Hardness'), rail.labels.join('|'))
check('and the mask settings that used to be across the window',
  rail.labels.includes('Feather') && rail.labels.includes('Keeps'), rail.labels.join('|'))
check('including handing the outline back to the lasso',
  rail.buttons.some((b) => /Edit outline/.test(b)), rail.buttons.join('|'))
check('and they are not left behind in the inspector as well', rail.inspectorHasFeather === false)
await page.screenshot({ path: path.join(OUT, '05-rail.png') })

// --- a stretch of the outline, moved and dropped ---------------------------------------
// One point at a time is fine for a rectangle and hopeless for a traced subject.
// Banding a run makes it one thing: drag it somewhere else, or delete it and let
// the loop close straight across the gap.
const view = await page.evaluate(() => {
  const s = window.__pfState()
  const r = document.querySelector('.stage canvas').getBoundingClientRect()
  return { cx: r.x, cy: r.y, ...s.view }
})
const scr = (x, y) => [view.cx + view.panX + x * view.zoom, view.cy + view.panY + y * view.zoom]

// An outline with an excursion out to the right, which is what a trace that
// wandered into the background and back looks like.
const shape = await page.evaluate(async (id) => {
  const st = window.__pfState()
  st.clearMask(id)
  await new Promise((r) => setTimeout(r, 250))
  const l = window.__pfState().doc.layers.find((x) => x.id === id)
  const at = (fx, fy) => [l.x + l.w * fx, l.y + l.h * fy]
  const pts = [
    at(0.1, 0.1), at(0.5, 0.1),
    at(0.8, 0.15), at(0.85, 0.2), at(0.8, 0.25),   // the excursion
    at(0.5, 0.3), at(0.5, 0.9), at(0.1, 0.9),
  ]
  st.select([id])
  st.setTool('lasso')
  st.setLasso({ points: pts, closed: true })
  await new Promise((r) => setTimeout(r, 300))
  return { n: pts.length, from: at(0.7, 0.08), to: at(0.95, 0.3) }
}, start.id)

// A press on the empty picture used to throw the outline away. It bands instead.
await page.mouse.move(...scr(shape.from[0], shape.from[1]))
await page.mouse.down()
await page.mouse.move(...scr(shape.to[0], shape.to[1]), { steps: 8 })
await page.mouse.up()
await page.waitForTimeout(300)
const picked = await page.evaluate(() => ({
  pick: window.__pfState().lassoPick,
  points: window.__pfState().lasso?.points?.length || 0,
}))
console.log('after banding the excursion:', JSON.stringify(picked))
check('a band across the outline picks out the run under it',
  picked.pick.join() === '2,3,4', JSON.stringify(picked.pick))
check('and the outline is still there, which a stray press used to lose',
  picked.points === shape.n, String(picked.points))
await page.screenshot({ path: path.join(OUT, '06-picked.png') })

// Dragging any point of the run moves the whole run.
const before = await page.evaluate(() => window.__pfState().lasso.points.map((q) => [...q]))
await page.mouse.move(...scr(before[3][0], before[3][1]))
await page.mouse.down()
await page.mouse.move(...scr(before[3][0] - 60, before[3][1]), { steps: 8 })
await page.mouse.up()
await page.waitForTimeout(300)
const dragged = await page.evaluate(() => window.__pfState().lasso.points.map((q) => [...q]))
console.log('after dragging the run:', JSON.stringify(dragged.slice(2, 5).map((q) => Math.round(q[0]))))
check('dragging one point of a picked run moves the whole run',
  before[2][0] - dragged[2][0] > 50 && before[4][0] - dragged[4][0] > 50,
  JSON.stringify([before[2][0] - dragged[2][0], before[4][0] - dragged[4][0]]))
check('and leaves every point outside it where it was',
  Math.abs(dragged[0][0] - before[0][0]) < 1 && Math.abs(dragged[5][0] - before[5][0]) < 1)

// And Delete takes the stretch out, closing the loop across the gap.
await page.locator('.stage canvas').hover()
await page.keyboard.press('Delete')
await page.waitForTimeout(300)
const cut = await page.evaluate(() => ({
  points: window.__pfState().lasso?.points?.length || 0,
  pick: window.__pfState().lassoPick.length,
  layers: window.__pfState().doc.layers.length,
}))
console.log('after deleting the run:', JSON.stringify(cut))
check('Delete takes the picked run out of the outline',
  cut.points === shape.n - 3, `${cut.points} of ${shape.n}`)
check('and lets go of it afterwards', cut.pick === 0)
// The nearer, smaller thing has first claim on the key: losing a whole layer
// instead of a stretch of an outline is not a mistake anyone would forgive.
check('and it is the run that goes, not the layer', cut.layers >= 1, String(cut.layers))
await page.screenshot({ path: path.join(OUT, '07-dropped.png') })

console.log(errors.length ? 'CONSOLE ERRORS: ' + errors.slice(0, 5).join(' | ') : 'no console errors')
await browser.close()
process.exit(checks.some(([, ok]) => !ok) ? 1 : 0)
