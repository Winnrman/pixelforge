// The eraser, and the two interaction bugs that shipped alongside it.
//
// The eraser exists to clean up what a background removal got wrong, so what
// matters is that it takes pixels away where you painted and nowhere else,
// that it survives being moved and resized with the layer, and that one drag is
// one undo.
import { chromium } from 'playwright-core'
import { importAndPlace } from '../e2e-helpers.mjs'
import fs from 'fs'
import path from 'path'

const OUT = 'shots/erase'
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
await page.waitForTimeout(500)

/** Alpha of the composited document at a document pixel. */
const alphaAt = (x, y) => page.evaluate(([x, y]) => {
  const st = window.__pfState()
  const c = document.createElement('canvas')
  c.width = st.doc.width
  c.height = st.doc.height
  const ctx = c.getContext('2d', { willReadFrequently: true })
  window.__pfRender.renderDocument(ctx, st.doc, 0)
  return ctx.getImageData(Math.round(x), Math.round(y), 1, 1).data[3]
}, [x, y])

// --- the tool exists and is reachable --------------------------------------------
await page.evaluate(() => window.__pfState().setTool('erase'))
await page.waitForTimeout(250)
const tool = await page.evaluate(() => ({
  tool: window.__pfState().tool,
  rail: [...document.querySelectorAll('.rail-opt-label')].map((el) => el.textContent),
}))
console.log('eraser options:', JSON.stringify(tool))
check('there is an eraser tool', tool.tool === 'erase')
check('with brush size, hardness and a mode', tool.rail.length === 3, tool.rail.join(', '))
await page.keyboard.press('v')
await page.waitForTimeout(100)
await page.keyboard.press('e')
await page.waitForTimeout(150)
check('E selects it', await page.evaluate(() => window.__pfState().tool) === 'erase')

// --- the brush ring -------------------------------------------------------------
// Erasing without one is guesswork: the brush is a fraction of the *layer*
// width, so the same setting is a different number of pixels on every layer.
const ring = await page.evaluate(async () => {
  const st = window.__pfState()
  st.setTool('erase')
  st.select([st.doc.layers[0].id])
  const c = document.querySelector('.stage canvas')
  const r = c.getBoundingClientRect()
  const v = st.view
  const at = (dx, dy) => ({ x: r.left + v.panX + dx * v.zoom, y: r.top + v.panY + dy * v.zoom })

  const sample = async (dx, dy) => {
    const p = at(dx, dy)
    c.dispatchEvent(new PointerEvent('pointermove', {
      bubbles: true, clientX: p.x, clientY: p.y, pointerId: 9,
    }))
    // The overlay repaints on the animation frame, so wait for a couple.
    await new Promise((res) => requestAnimationFrame(() => requestAnimationFrame(res)))
    const ctx = c.getContext('2d', { willReadFrequently: true })
    const cx = Math.round((p.x - r.left) * (c.width / r.width))
    const cy = Math.round((p.y - r.top) * (c.height / r.height))
    // Scan outward along a row for the brightest ring pixel away from the centre.
    const row = ctx.getImageData(cx, cy, Math.min(300, c.width - cx), 1).data
    let found = -1
    for (let i = 6; i < row.length / 4; i++) {
      const o = i * 4
      if (row[o] > 200 && row[o + 1] > 200 && row[o + 2] > 200) { found = i; break }
    }
    return found
  }

  const small = await sample(120, 100)
  st.setToolOptions({ brush: { ...st.toolOptions.brush, size: 0.2 } })
  const large = await sample(120, 100)
  st.setToolOptions({ brush: { ...st.toolOptions.brush, size: 0.06 } })
  return { small, large, zoom: v.zoom }
})
console.log('brush ring radius in canvas px:', JSON.stringify(ring))
check('the eraser draws a ring at the cursor', ring.small > 0, `radius ${ring.small}`)
check('and it grows with the brush size', ring.large > ring.small * 2,
  `${ring.small} -> ${ring.large}`)

// --- painting removes pixels, and only where painted -----------------------------
const id = await page.evaluate(() => {
  const st = window.__pfState()
  const layerId = st.doc.layers[0].id
  st.select([layerId])
  return layerId
})
const before = { mid: await alphaAt(120, 160), top: await alphaAt(120, 20) }

await page.evaluate((layerId) => {
  const st = window.__pfState()
  st.beginErase(layerId, [0.15, 0.5])
  for (let i = 1; i <= 24; i++) window.__pfState().extendErase(layerId, [0.15 + i * 0.03, 0.5])
}, id)
await page.waitForTimeout(300)
const after = { mid: await alphaAt(120, 160), top: await alphaAt(120, 20) }
console.log('alpha before:', JSON.stringify(before), 'after:', JSON.stringify(after))
check('painting removes pixels under the brush', after.mid < 30, `alpha ${before.mid} -> ${after.mid}`)
check('and leaves the rest of the layer alone', after.top === before.top,
  `alpha ${before.top} -> ${after.top}`)

const stored = await page.evaluate((layerId) => {
  const l = window.__pfState().doc.layers.find((x) => x.id === layerId)
  return {
    strokes: l.erase.strokes.length,
    points: l.erase.strokes[0].pts.length,
    // Points must be normalised, not document pixels, or they cannot follow the
    // layer when it moves.
    normalised: l.erase.strokes[0].pts.every(([x, y]) => x >= 0 && x <= 1 && y >= 0 && y <= 1),
    size: l.erase.strokes[0].size,
  }
}, id)
console.log('stroke:', JSON.stringify(stored))
check('the stroke is stored as points, not baked pixels', stored.strokes === 1 && stored.points > 5)
check('in layer coordinates', stored.normalised)
// --- one drag is one undo -----------------------------------------------------------
await page.evaluate(() => window.__pfState().undo())
await page.waitForTimeout(250)
const undone = await page.evaluate((layerId) =>
  window.__pfState().doc.layers.find((x) => x.id === layerId).erase?.strokes.length ?? 0, id)
check('one undo removes the whole stroke, not one point of it', undone === 0, `${undone} strokes`)
check('and the pixels come back', await alphaAt(120, 160) === before.mid)
await page.evaluate(() => window.__pfState().redo())
await page.waitForTimeout(250)
check('redo puts it back', await alphaAt(120, 160) < 30)

// Thinning is checked here, after the undo test, because probing it adds
// history of its own. The stroke above steps 0.03 at a brush of 0.06, well clear
// of the threshold, so every one of its points is rightly kept — the claim only
// applies to points painted closer together than that.
const thinned = await page.evaluate((layerId) => {
  const st = window.__pfState()
  st.beginErase(layerId, [0.5, 0.2])
  // 40 moves a thousandth apart, far below the threshold.
  for (let i = 1; i <= 40; i++) window.__pfState().extendErase(layerId, [0.5 + i * 0.001, 0.2])
  const l = window.__pfState().doc.layers.find((x) => x.id === layerId)
  const pts = l.erase.strokes[l.erase.strokes.length - 1].pts.length
  window.__pfState().clearErase(layerId)
  return pts
}, id)
console.log('points kept from 41 sub-threshold moves:', thinned)
check('points too close together are dropped as it paints', thinned < 10,
  `${thinned} of 41 kept`)

// --- the erasure follows the layer ---------------------------------------------------
// This is the reason for storing points rather than a raster: moving or resizing
// the layer has to carry the hole with it.
const moved = await page.evaluate((layerId) => {
  const st = window.__pfState()
  const l = st.doc.layers.find((x) => x.id === layerId)
  st.updateLayer(layerId, { x: l.x + 40, y: l.y + 30 })
  return { x: l.x + 40, y: l.y + 30 }
}, id)
await page.waitForTimeout(250)
console.log('after moving by 40,30:', JSON.stringify(moved))
check('the hole moves with the layer', await alphaAt(160, 190) < 30,
  `alpha at the moved position: ${await alphaAt(160, 190)}`)
check('and the old position is filled again', await alphaAt(120, 160) === before.mid)

await page.evaluate((layerId) => {
  const st = window.__pfState()
  const l = st.doc.layers.find((x) => x.id === layerId)
  st.updateLayer(layerId, { x: l.x - 40, y: l.y - 30, w: l.w * 2, h: l.h * 2 })
}, id)
await page.waitForTimeout(250)
// At twice the size the same normalised stroke sits twice as far down the layer.
check('the hole scales with the layer', await alphaAt(240, 320) < 30,
  `alpha ${await alphaAt(240, 320)}`)
// Restored explicitly rather than by undo: updateLayer deliberately does not
// push history, so undoing here would roll back past the import instead.
await page.evaluate((layerId) => {
  const st = window.__pfState()
  const l = st.doc.layers.find((x) => x.id === layerId)
  st.updateLayer(layerId, { x: 0, y: 0, w: l.w / 2, h: l.h / 2 })
}, id)
await page.waitForTimeout(250)
check('the layer is back where it started', await alphaAt(120, 160) < 30,
  `alpha ${await alphaAt(120, 160)}`)

// --- the box follows what is left ---------------------------------------------------
// Erasing from an edge leaves a box measuring space that is no longer there, so
// the handles and the rotation pivot drift away from the artwork.
const refit = await page.evaluate((layerId) => {
  const st = window.__pfState()
  st.clearErase(layerId, { all: true })
  const before = { ...window.__pfState().doc.layers.find((x) => x.id === layerId) }
  const shoot = () => {
    const s2 = window.__pfState()
    const c = document.createElement('canvas')
    c.width = s2.doc.width
    c.height = s2.doc.height
    const ctx = c.getContext('2d', { willReadFrequently: true })
    window.__pfRender.renderDocument(ctx, s2.doc, 0)
    return ctx.getImageData(0, 0, c.width, c.height)
  }
  // A wide hard band down the right-hand third, top to bottom.
  st.beginErase(layerId, [0.72, -0.05], { size: 0.7, hardness: 1 })
  for (let i = 0; i <= 20; i++) window.__pfState().extendErase(layerId, [0.72, -0.05 + i * 0.06])
  const shotBefore = shoot()
  const patch = window.__pfState().refitToVisible(layerId)
  const shotAfter = shoot()
  const after = window.__pfState().doc.layers.find((x) => x.id === layerId)
  let diff = 0
  for (let i = 0; i < shotBefore.data.length; i += 4) {
    for (let k = 0; k < 4; k++) {
      if (Math.abs(shotBefore.data[i + k] - shotAfter.data[i + k]) > 3) { diff++; break }
    }
  }
  return {
    refitted: !!patch,
    before: [Math.round(before.w), Math.round(before.h)],
    after: [Math.round(after.w), Math.round(after.h)],
    diff,
    total: shotBefore.data.length / 4,
    strokeSize: +after.erase.strokes[0].size.toFixed(4),
    beforeStroke: 0.7,
  }
}, id)
console.log('refit after erasing an edge:', JSON.stringify(refit))
check('the box shrinks to what is left', refit.after[0] < refit.before[0] * 0.6,
  `${refit.before[0]} -> ${refit.after[0]} wide`)
check('and keeps its height, which was untouched', refit.after[1] === refit.before[1],
  `${refit.before[1]} -> ${refit.after[1]}`)
check('refitting moves nothing on screen', refit.diff === 0,
  `${refit.diff} of ${refit.total} pixels differ`)
// The brush is a fraction of the layer width, and the width just changed.
check('the stored stroke is rescaled so it covers the same pixels',
  Math.abs(refit.strokeSize - refit.beforeStroke * (refit.before[0] / refit.after[0])) < 0.02,
  `${refit.beforeStroke} -> ${refit.strokeSize}`)

// Erasing a hole in the middle touches no edge, so the box must not change.
const hole = await page.evaluate((layerId) => {
  const st = window.__pfState()
  st.clearErase(layerId, { all: true })
  window.__pfState().refitToVisible(layerId)
  const before = { ...window.__pfState().doc.layers.find((x) => x.id === layerId) }
  st.beginErase(layerId, [0.5, 0.5], { size: 0.15, hardness: 1 })
  window.__pfState().extendErase(layerId, [0.52, 0.5])
  const patch = window.__pfState().refitToVisible(layerId)
  const after = window.__pfState().doc.layers.find((x) => x.id === layerId)
  return {
    changed: !!patch,
    same: Math.round(before.w) === Math.round(after.w) && Math.round(before.h) === Math.round(after.h),
    box: [Math.round(after.w), Math.round(after.h)],
  }
}, id)
console.log('after a hole in the middle:', JSON.stringify(hole))
check('a hole in the middle leaves the box alone', hole.same, hole.box.join('x'))

// Put the layer back as it was found: the refit above genuinely shrank it and
// cleared its strokes, and the checks that follow address it in its original
// coordinates with the original band erased.
await page.evaluate((layerId) => {
  const st = window.__pfState()
  st.clearErase(layerId, { all: true })
  st.updateLayer(layerId, {
    src: null, x: 0, y: 0, w: st.doc.width, h: st.doc.height,
    cropT: 0, cropR: 0, cropB: 0, cropL: 0, zoom: 1, panX: 0, panY: 0,
  })
  // The same horizontal band the first section painted, so the restore test
  // below has something to put back.
  window.__pfState().beginErase(layerId, [0.15, 0.5])
  for (let i = 1; i <= 24; i++) window.__pfState().extendErase(layerId, [0.15 + i * 0.03, 0.5])
}, id)
await page.waitForTimeout(250)

// --- restore paints it back -----------------------------------------------------------
const restored = await page.evaluate((layerId) => {
  const st = window.__pfState()
  st.beginErase(layerId, [0.4, 0.5], { mode: 'restore', size: 0.12 })
  for (let i = 1; i <= 6; i++) window.__pfState().extendErase(layerId, [0.4 + i * 0.01, 0.5])
  const l = window.__pfState().doc.layers.find((x) => x.id === layerId)
  return l.erase.strokes.map((s) => s.mode)
}, id)
await page.waitForTimeout(300)
console.log('stroke modes:', JSON.stringify(restored))
check('a restore stroke is recorded as one', restored.includes('restore'))
// Sampled at the middle of the restore stroke: it is centred at 0.4 of a 240px
// layer, so x=100. At x=120 it is under the soft edge of the brush and comes
// back only partly, which is correct but is not what this claim is about.
const back = await alphaAt(100, 160)
const edge = await alphaAt(120, 160)
console.log('alpha at the restore centre:', back, '· at its soft edge:', edge)
check('and it puts the pixels back', back > 200, `alpha ${back}`)
check('with a soft edge rather than a hard one', edge > 60 && edge < back,
  `${edge} against ${back} at the centre`)
await page.screenshot({ path: path.join(OUT, '01-erase.png') })

// --- it survives a save ----------------------------------------------------------------
const roundTrip = await page.evaluate(async () => {
  const st = window.__pfState()
  const blob = await window.__pfProject.packProject(st.doc, { time: 0, name: 'EraseTest' })
  const out = await window.__pfProject.unpackProject(new File([blob], 'e.pfz', { type: 'application/zip' }))
  const l = out.doc.layers.find((x) => x.erase?.strokes?.length)
  return { strokes: l?.erase.strokes.length || 0, modes: l?.erase.strokes.map((s) => s.mode) }
})
console.log('after a project round trip:', JSON.stringify(roundTrip))
check('strokes are saved with the project', roundTrip.strokes === 2, `${roundTrip.strokes}`)
check('including which ones restore', (roundTrip.modes || []).includes('restore'))

// --- the move tool picks what you can see ------------------------------------------------
// This used to keep whatever was already selected whenever the pointer was
// inside its box, which stopped a layer in front stealing a drag — and also
// stopped a layer genuinely in front, and genuinely visible where you clicked,
// from being selected at all without deselecting first.
//
// The cure belongs in the hit test rather than in the selection: the layer in
// front was stealing clicks over its own *empty* pixels, so the test now asks
// what was drawn instead of what was bounded. What is on top and opaque wins,
// which is what every editor does.
await page.evaluate(() => {
  const st = window.__pfState()
  const { makeShapeLayer } = window.__pfStore
  // A big shape covering the whole canvas, added last so it is on top.
  st.addLayer(makeShapeLayer({
    name: 'cover', shape: 'rect', x: 0, y: 0, w: st.doc.width, h: st.doc.height, fill: '#334',
  }))
  st.setTool('move')
})
await page.waitForTimeout(250)
// Driven through real mouse input rather than synthetic PointerEvents: a
// dispatched one has no active pointer, so setPointerCapture throws and aborts
// the handler before it selects anything — which made an earlier version of
// this check pass without exercising the code at all.
const screenPoint = await page.evaluate(([dx, dy]) => {
  const c = document.querySelector('.stage canvas')
  const r = c.getBoundingClientRect()
  const v = window.__pfState().view
  return [r.left + v.panX + dx * v.zoom, r.top + v.panY + dy * v.zoom]
}, [120, 160])

const ids = await page.evaluate(() => {
  const st = window.__pfState()
  st.select([st.doc.layers[0].id])
  return { photo: st.doc.layers[0].id, top: st.doc.layers[st.doc.layers.length - 1].id }
})
await page.mouse.click(screenPoint[0], screenPoint[1])
await page.waitForTimeout(250)
const sticky = await page.evaluate(() => window.__pfState().selectedIds)
console.log('click inside the selection:', JSON.stringify({ sticky, ...ids }))
check('a solid layer in front takes the click, even with something else selected',
  sticky.length === 1 && sticky[0] === ids.top,
  `selected ${sticky}, photo ${ids.photo}, top ${ids.top}`)

// Clicking with nothing selected must still pick, or nothing could ever be chosen.
await page.evaluate(() => window.__pfState().select([]))
await page.mouse.click(screenPoint[0], screenPoint[1])
await page.waitForTimeout(250)
const changes = await page.evaluate(() => window.__pfState().selectedIds)
console.log('click with nothing selected:', JSON.stringify(changes))
check('with nothing selected it still picks the topmost layer',
  changes[0] === ids.top, `${changes[0]} vs top ${ids.top}`)

// And the half of the rule that was worth keeping: made invisible where you are
// clicking, the layer in front stops taking the click and what is behind it is
// reachable again.
const throughIt = await page.evaluate(async ([topId, photoId]) => {
  const st = window.__pfState()
  st.updateLayer(topId, { visible: false })
  st.select([photoId])
  await new Promise((r) => setTimeout(r, 250))
  return { photoId }
}, [ids.top, ids.photo])
await page.mouse.click(screenPoint[0], screenPoint[1])
await page.waitForTimeout(250)
const beneath = await page.evaluate(() => window.__pfState().selectedIds)
check('and with nothing drawn in front, the click reaches what is behind',
  beneath[0] === throughIt.photoId, `${beneath} vs ${throughIt.photoId}`)

// And shift-click must still reach through to change a selection deliberately.
// The cover goes back on first: the check above hid it to prove a click passes
// through nothing, and shift-click has to have something to reach.
await page.evaluate(([photo, topId]) => {
  const st = window.__pfState()
  st.updateLayer(topId, { visible: true })
  st.select([photo])
}, [ids.photo, ids.top])
await page.waitForTimeout(250)
await page.keyboard.down('Shift')
await page.mouse.click(screenPoint[0], screenPoint[1])
await page.keyboard.up('Shift')
await page.waitForTimeout(250)
const shifted = await page.evaluate(() => window.__pfState().selectedIds)
console.log('shift-click:', JSON.stringify(shifted))
check('shift-click still reaches the layer on top', shifted.includes(ids.top),
  shifted.join(', '))

// --- reordering layers must not raise the import veil -------------------------------------
// An HTML5 drag with no files is a layer being reordered, and it used to dim the
// whole app with "drop to add" and leave it that way.
const veil = await page.evaluate(async () => {
  const dt = new DataTransfer()
  dt.setData('text/plain', 'layer')
  window.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt }))
  await new Promise((r) => setTimeout(r, 200))
  const during = !!document.querySelector('.drop-veil') || document.body.classList.contains('dragging')
    || !!document.querySelector('.app.dragging')
  window.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: dt }))
  await new Promise((r) => setTimeout(r, 200))
  const after = !!document.querySelector('.app.dragging')
  return { during, after }
})
console.log('layer-reorder drag:', JSON.stringify(veil))
check('dragging a layer does not raise the import veil', veil.during === false)
check('and nothing is left dimmed afterwards', veil.after === false)

// A drag that really does carry files shows it — but only in the Media tab,
// which is now the one place media is added. In the editor it is as inert as a
// layer being reordered.
const fileVeil = await page.evaluate(async () => {
  const fire = async () => {
    const dt = new DataTransfer()
    dt.items.add(new File(['x'], 'a.png', { type: 'image/png' }))
    window.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt }))
    await new Promise((r) => setTimeout(r, 200))
    const during = !!document.querySelector('.app.dragging')
    window.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: dt }))
    await new Promise((r) => setTimeout(r, 200))
    return { during, after: !!document.querySelector('.app.dragging') }
  }
  window.__pfState().setWorkspace('editor')
  await new Promise((r) => setTimeout(r, 200))
  const editor = await fire()
  window.__pfState().setWorkspace('media')
  await new Promise((r) => setTimeout(r, 250))
  const bin = await fire()
  window.__pfState().setWorkspace('editor')
  return { editor, bin }
})
console.log('file drag:', JSON.stringify(fileVeil))
check('a file drag over the editor raises nothing', fileVeil.editor.during === false)
check('the same drag over the media bin does', fileVeil.bin.during === true)
check('and it clears when the drag ends', fileVeil.bin.after === false)

// --- the brush, life-size, above the sliders ------------------------------------------
// A brush is a fraction of the layer width rather than a number of pixels, so
// "6%" is a number nobody can picture. The ring on the canvas answers that once
// the pointer is out over the artwork; this answers it while your hand is still
// on the slider, which is when you are deciding.
const preview = await page.evaluate(async () => {
  const st = window.__pfState()
  const id = st.doc.layers[st.doc.layers.length - 1].id
  st.select([id])
  st.setTool('erase')
  await new Promise((r) => setTimeout(r, 350))
  const read = () => {
    const el = document.querySelector('.rail-options .brush-preview')
    const c = el?.querySelector('canvas')
    return {
      there: !!el,
      canvas: c ? { w: c.width, h: c.height } : null,
      caption: el?.querySelector('.brush-size')?.textContent || '',
    }
  }
  const small = read()
  // Same brush, twice the size: the readout has to move with it.
  const s0 = window.__pfState().toolOptions.brush
  window.__pfState().setToolOptions({ brush: { ...s0, size: (s0?.size ?? 0.06) * 2 } })
  await new Promise((r) => setTimeout(r, 300))
  const big = read()
  // Painting has never needed a layer selected — the tool takes what is under
  // the pointer — so the preview must not refuse to answer without one. It
  // still shows a size, and still grows when the slider does.
  window.__pfState().select([])
  await new Promise((r) => setTimeout(r, 300))
  const none = read()
  const b2 = window.__pfState().toolOptions.brush
  window.__pfState().setToolOptions({ brush: { ...b2, size: (b2?.size ?? 0.06) * 2 } })
  await new Promise((r) => setTimeout(r, 300))
  const noneBigger = read()
  window.__pfState().select([id])
  window.__pfState().setToolOptions({ brush: s0 })
  await new Promise((r) => setTimeout(r, 250))
  return { small, big, none, noneBigger }
})
console.log('brush preview:', JSON.stringify(preview))
const px = (s) => Number((s.match(/^(\d+) px/) || [])[1])
check('the erase tool shows the brush above its sliders', preview.small.there === true)
check('drawn on a canvas with real pixels in it',
  preview.small.canvas?.w > 0 && preview.small.canvas?.h > 0, JSON.stringify(preview.small.canvas))
check('and says what the brush measures on the picture',
  /^\d+ px/.test(preview.small.caption), preview.small.caption)
// The number is the half that cannot lie: whatever the box had to do to fit the
// picture in, the pixels it reports are the pixels it will paint.
check('doubling the brush doubles what it reports',
  Math.abs(px(preview.big.caption) - px(preview.small.caption) * 2) <= 2,
  `${preview.small.caption} -> ${preview.big.caption}`)
check('with nothing selected it still shows a size',
  /^\d+ px/.test(preview.none.caption) && px(preview.none.caption) > 0, preview.none.caption)
check('and still grows when the slider does',
  px(preview.noneBigger.caption) > px(preview.none.caption),
  `${preview.none.caption} -> ${preview.noneBigger.caption}`)

// The clone stamp and the mask brush get the same picture, since they are the
// same kind of thing and the question they answer is the same one.
for (const [tool, name] of [['clone', 'the clone stamp'], ['mask', 'the mask brush']]) {
  const has = await page.evaluate(async (t) => {
    window.__pfState().setTool(t)
    await new Promise((r) => setTimeout(r, 350))
    return !!document.querySelector('.rail-options .brush-preview canvas')
  }, tool)
  check(`${name} shows one too`, has === true)
}
await page.evaluate(() => window.__pfState().setTool('erase'))
await page.waitForTimeout(250)
await page.screenshot({ path: path.join(OUT, '09-brush-preview.png') })

// Reading the preview's own pixels, because "a canvas is present" cannot tell a
// live picture of the brush from an empty box — and the whole promise here is
// that what you see is what the stroke will lay down.
const drawn = await page.evaluate(async () => {
  const st = window.__pfState()
  const id = st.doc.layers[st.doc.layers.length - 1].id
  st.select([id])
  st.setTool('erase')
  await new Promise((r) => setTimeout(r, 300))

  // The alpha profile out from the middle: how wide the band is where the brush
  // is neither fully on nor fully off *is* its hardness.
  const profile = async (hardness) => {
    const b = window.__pfState().toolOptions.brush
    window.__pfState().setToolOptions({ brush: { ...b, size: 0.18, hardness } })
    await new Promise((r) => setTimeout(r, 300))
    const c = document.querySelector('.rail-options .brush-preview canvas')
    const g = c.getContext('2d', { willReadFrequently: true })
    const cy = Math.round(c.height / 2)
    const row = g.getImageData(0, cy, c.width, 1).data
    const alpha = []
    for (let x = Math.round(c.width / 2); x < c.width; x++) alpha.push(row[x * 4 + 3])
    return {
      middle: alpha[0],
      // Pixels part-way between opaque and clear: a hard edge has almost none,
      // a soft one has a wide band of them.
      falloff: alpha.filter((a) => a > 8 && a < 245).length,
      edge: alpha[alpha.length - 1],
    }
  }
  const hard = await profile(1)
  const soft = await profile(0)
  return { hard, soft }
})
console.log('brush profile:', JSON.stringify(drawn))
check('the preview actually draws the brush', drawn.hard.middle > 200, String(drawn.hard.middle))
check('a hard brush has a hard edge', drawn.hard.falloff <= 6, String(drawn.hard.falloff))
check('a soft one fades out over many pixels', drawn.soft.falloff > drawn.hard.falloff * 3,
  `${drawn.hard.falloff} -> ${drawn.soft.falloff}`)
check('and neither fills the whole box, so the size reads as a size',
  drawn.hard.edge < 8 && drawn.soft.edge < 8, `${drawn.hard.edge} / ${drawn.soft.edge}`)

// --- a digit for each tool in the rail --------------------------------------------------
// The letter is the mnemonic every editor uses; the digit is the position in the
// rail, which is what you reach for when you are looking at it rather than
// remembering it. `1` is the selector because getting back to plain selection is
// the most common thing anybody asks of a tool bar.
await page.locator('.stage canvas').hover()
const digits = {}
for (const [key, want] of [['1', 'move'], ['4', 'lasso'], ['7', 'mask'], ['8', 'erase'], ['0', 'wand']]) {
  // Parked on something else first, so a digit that does nothing cannot pass by
  // leaving the tool where the previous check put it.
  await page.evaluate(() => window.__pfState().setTool('hand'))
  await page.waitForTimeout(120)
  await page.keyboard.press(key)
  await page.waitForTimeout(150)
  digits[key] = await page.evaluate(() => window.__pfState().tool)
  check(`${key} arms ${want}`, digits[key] === want, digits[key])
}
// And the letters still do what they always did.
await page.keyboard.press('v')
await page.waitForTimeout(150)
check('the letters still work beside them',
  (await page.evaluate(() => window.__pfState().tool)) === 'move')

// --- the ring is the cursor -------------------------------------------------------------
// A crosshair sitting inside the brush ring adds nothing and clutters the one
// thing you are trying to aim, so the tools that draw a ring hide the pointer
// and let the ring be it. The clone stamp keeps its crosshair, having no ring.
const cursors = {}
for (const tool of ['erase', 'mask', 'clone', 'lasso']) {
  cursors[tool] = await page.evaluate(async (t) => {
    const st = window.__pfState()
    st.setTool(t)
    await new Promise((r) => setTimeout(r, 250))
    const c = document.querySelector('.stage canvas')
    const r = c.getBoundingClientRect()
    // A real move, because the cursor is decided as the pointer travels.
    c.dispatchEvent(new PointerEvent('pointermove', {
      clientX: r.x + r.width / 2, clientY: r.y + r.height / 2, bubbles: true, pointerId: 1,
    }))
    await new Promise((r2) => setTimeout(r2, 200))
    return c.style.cursor
  }, tool)
}
console.log('cursors:', JSON.stringify(cursors))
check('the eraser hides the pointer and shows its ring', cursors.erase === 'none', cursors.erase)
check('and so does the mask brush', cursors.mask === 'none', cursors.mask)
check('the clone stamp keeps its crosshair, having no ring',
  cursors.clone === 'crosshair', cursors.clone)
check('and so does the lasso', cursors.lasso === 'crosshair', cursors.lasso)

// Typing a digit into a field is typing, not a shortcut.
const whileTyping = await page.evaluate(async () => {
  const st = window.__pfState()
  st.setTool('erase')
  await new Promise((r) => setTimeout(r, 200))
  const input = document.querySelector('input.project-name')
  if (!input) return { skipped: true }
  input.focus()
  input.dispatchEvent(new KeyboardEvent('keydown', { key: '1', bubbles: true }))
  await new Promise((r) => setTimeout(r, 200))
  input.blur()
  return { tool: window.__pfState().tool }
}, null)
console.log('digit while typing:', JSON.stringify(whileTyping))
if (!whileTyping.skipped) {
  check('a digit typed into a field does not change the tool', whileTyping.tool === 'erase',
    whileTyping.tool)
}

console.log(errors.length ? 'CONSOLE ERRORS: ' + errors.slice(0, 5).join(' | ') : 'no console errors')
await browser.close()
process.exit(checks.some(([, ok]) => !ok) ? 1 : 0)
