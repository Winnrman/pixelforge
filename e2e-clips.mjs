// Clips: cutting, trimming and arranging media on the timeline.
//
// test-clips.mjs pins the arithmetic. This checks the thing the arithmetic is
// for — that a clip changes what is actually on the canvas at a given time.
// A model that computes the right numbers while the renderer keeps drawing the
// same frame would pass every unit test and be useless.
import { chromium } from 'playwright-core'
import { importAndPlace } from './e2e-helpers.mjs'
import fs from 'fs'
import path from 'path'

const OUT = 'shots-clips'
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
await importAndPlace(page, 'public/test/motion.gif', { timeout: 20000 })
await page.evaluate(() => { window.__pfState().setPlaying(false); window.__pfState().setTime(0) })
await page.waitForTimeout(500)

/** How much of the canvas is covered at a document time. */
const coverAt = (ms) => page.evaluate((t) => {
  const st = window.__pfState()
  const c = document.createElement('canvas')
  c.width = st.doc.width
  c.height = st.doc.height
  const ctx = c.getContext('2d', { willReadFrequently: true })
  window.__pfRender.renderDocument(ctx, st.doc, t)
  const d = ctx.getImageData(0, 0, c.width, c.height).data
  let opaque = 0
  let sum = 0
  for (let i = 0; i < d.length; i += 4) {
    if (d[i + 3] > 128) { opaque++; sum += d[i] + d[i + 1] * 3 + d[i + 2] * 7 }
  }
  return { opaque, sum }
}, ms)

const base = await page.evaluate(() => {
  const st = window.__pfState()
  const l = st.doc.layers[0]
  return { id: l.id, duration: Math.round(st.duration), assetMs: Math.round(window.__pfAssets.getAsset(l.assetId).duration) }
})
console.log('layer:', JSON.stringify(base))
check('a clip to work with', base.assetMs > 500, `${base.assetMs}ms of media`)

// --- a layer with no clip is untouched --------------------------------------------
// Every project made before clips existed has to keep working, and an overlay on
// a looping GIF wants to be visible throughout.
const before = await coverAt(0)
check('an unclipped layer draws at time zero', before.opaque > 100, `${before.opaque} px`)
check('and still draws well past the media length',
  (await coverAt(base.assetMs * 3)).opaque > 100)

// --- making a clip ------------------------------------------------------------------
const made = await page.evaluate((id) => {
  const st = window.__pfState()
  st.makeClip(id, 1000)
  const l = window.__pfState().doc.layers.find((x) => x.id === id)
  return { clip: l.clip, duration: Math.round(window.__pfState().duration) }
}, base.id)
console.log('after makeClip at 1000:', JSON.stringify(made))
check('the layer gains a clip', !!made.clip && made.clip.start === 1000)
check('covering the whole source', made.clip.in === 0 && made.clip.out === base.assetMs,
  JSON.stringify(made.clip))
check('and the timeline grows to hold it', made.duration >= 1000 + base.assetMs,
  `${made.duration}ms`)

// The cut is the point: before its start there must be nothing.
const gap = await coverAt(500)
const inside = await coverAt(1500)
console.log('at 500ms:', JSON.stringify(gap), 'at 1500ms:', JSON.stringify(inside))
check('nothing is drawn before the clip starts', gap.opaque === 0, `${gap.opaque} px`)
check('and it is drawn once inside', inside.opaque > 100, `${inside.opaque} px`)
const after = await coverAt(1000 + base.assetMs + 200)
check('and nothing after it ends', after.opaque === 0, `${after.opaque} px`)
await page.screenshot({ path: path.join(OUT, '01-clip.png') })

// --- a clip plays its piece once, it does not loop -------------------------------------
// This is what makes trimming mean anything: trimmed-off frames must not come
// back around.
const trimmed = await page.evaluate((id) => {
  const st = window.__pfState()
  st.slideClip(id, 0)
  const l = window.__pfState().doc.layers.find((x) => x.id === id)
  const half = Math.round((l.clip.out - l.clip.in) / 2)
  st.trimClip(id, 'end', half)
  const after = window.__pfState().doc.layers.find((x) => x.id === id)
  return { clip: after.clip, half, duration: Math.round(window.__pfState().duration) }
}, base.id)
console.log('trimmed to half:', JSON.stringify(trimmed))
check('trimming the end shortens the clip', trimmed.clip.out <= trimmed.half + 40,
  JSON.stringify(trimmed.clip))
check('the trimmed part is gone, not wrapped around',
  (await coverAt(trimmed.half + 150)).opaque === 0)

// --- cutting ----------------------------------------------------------------------------
const cut = await page.evaluate((id) => {
  const st = window.__pfState()
  st.clearClip(id)
  st.makeClip(id, 0)
  const l = window.__pfState().doc.layers.find((x) => x.id === id)
  const mid = Math.round((l.clip.out - l.clip.in) / 2)
  const n = st.splitClips(mid)
  const after = window.__pfState()
  const clips = after.doc.layers.filter((x) => x.clip).map((x) => ({ ...x.clip }))
  return { n, mid, clips, layers: after.doc.layers.length }
}, base.id)
console.log('cut at the middle:', JSON.stringify(cut))
check('cutting makes two clips from one', cut.clips.length === 2, `${cut.clips.length}`)
check('and they meet exactly at the cut',
  cut.clips[0].out === cut.clips[1].in
  && cut.clips[0].start + (cut.clips[0].out - cut.clips[0].in) === cut.clips[1].start,
  JSON.stringify(cut.clips))
// Nothing lost, nothing repeated: the pair must still cover what the one did.
check('together they still cover the whole source',
  cut.clips[0].in === 0 && cut.clips[1].out === base.assetMs, JSON.stringify(cut.clips))
check('the picture is unbroken across the cut',
  (await coverAt(cut.mid - 50)).opaque > 100 && (await coverAt(cut.mid + 50)).opaque > 100)

// --- deleting one half leaves a hole, and closing gaps fills it ---------------------------
const held = await page.evaluate(() => {
  const st = window.__pfState()
  const clips = st.doc.layers.filter((l) => l.clip)
  st.removeLayers([clips[0].id])
  const left = window.__pfState().doc.layers.filter((l) => l.clip)
  return { start: left[0].clip.start, n: left.length }
})
console.log('after deleting the first half:', JSON.stringify(held))
check('deleting a clip leaves the other where it was', held.start > 0, `starts at ${held.start}`)
check('so the timeline opens with a gap', (await coverAt(10)).opaque === 0)

await page.evaluate(() => window.__pfState().closeClipGaps())
await page.waitForTimeout(200)
const closed = await page.evaluate(() => {
  const l = window.__pfState().doc.layers.find((x) => x.clip)
  return { start: l.clip.start, duration: Math.round(window.__pfState().duration) }
})
console.log('after closing gaps:', JSON.stringify(closed))
check('closing gaps pulls it back to the start', closed.start === 0, `${closed.start}`)
check('and the gap is filled', (await coverAt(10)).opaque > 100)

// --- undo ---------------------------------------------------------------------------------
await page.evaluate(() => window.__pfState().undo())
await page.waitForTimeout(200)
const undone = await page.evaluate(() => ({
  start: window.__pfState().doc.layers.find((x) => x.clip).clip.start,
  duration: Math.round(window.__pfState().duration),
}))
console.log('after undo:', JSON.stringify(undone))
check('one undo puts the gap back', undone.start > 0, `${undone.start}`)
// Undo restored the document but not the length derived from it, so every clip
// was drawn against the wrong scale — a stale timeline that only became visible
// once clips could be moved.
check('and the timeline length follows it back',
  undone.duration >= undone.start, `${undone.duration}ms for a clip ending later`)

// --- the timeline shows them ----------------------------------------------------------------
const ui = await page.evaluate(async () => {
  const st = window.__pfState()
  st.setPlaying(false)
  const tabs = [...document.querySelectorAll('.tl-tabs button, .timeline button')]
  const video = tabs.find((b) => /^Video/.test(b.textContent))
  if (video) video.click()
  await new Promise((r) => setTimeout(r, 400))
  return {
    bars: document.querySelectorAll('.strip.clip').length,
    grips: document.querySelectorAll('.strip .clip-grip').length,
    // The old design drew a featureless bar *and* a filmstrip of the same media
    // below it — two rows for one object. A clip is one element now.
    rows: document.querySelectorAll('.track-row:not(.empty)').length,
    empties: document.querySelectorAll('.track-row.empty').length,
    canvases: document.querySelectorAll('.strip.clip canvas').length,
    tools: [...document.querySelectorAll('.clip-bar-tools button')].map((b) => b.textContent.trim()),
  }
})
console.log('timeline ui:', JSON.stringify(ui))
check('the video tab draws a clip per clip', ui.bars >= 1, `${ui.bars} clips`)
check('each with two grips to trim by', ui.grips === ui.bars * 2, `${ui.grips} grips`)
check('the clips sit on a track', ui.rows >= 1, `${ui.rows} tracks in use`)
// A new track is made by using it, not by pressing anything.
check('and there is an empty track to drop into', ui.empties === 1, `${ui.empties} empty`)
check('and the clip carries its own thumbnails', ui.canvases === ui.bars,
  `${ui.canvases} strips inside clips`)
check('and the edit buttons are there',
  ui.tools.some((t) => /Cut at playhead/.test(t)) && ui.tools.some((t) => /Close gaps/.test(t)),
  ui.tools.join(' | '))
// Creating a clip is a drag from the bin, so the button that used to do it is
// gone rather than sitting there as a second way to do the same thing.
check('and no button for making clips', !ui.tools.some((t) => /Make a clip/.test(t)),
  ui.tools.join(' | '))
await page.screenshot({ path: path.join(OUT, '02-timeline.png') })

// --- dragging a clip actually moves it ---------------------------------------------------------
const dragged = await page.evaluate(() => window.__pfState().doc.layers.find((x) => x.clip).clip.start)
await page.locator('.strip.clip').first().scrollIntoViewIfNeeded()
const bar = await page.locator('.strip.clip').first().boundingBox()
const track = await page.locator('.track-lane').first().boundingBox()
// The bar has to reflect the state after the undo, not before it.
check('the bar is drawn where the clip actually is',
  bar && track && bar.x > track.x + track.width * 0.2,
  `bar at ${Math.round(bar?.x)} in a track from ${Math.round(track?.x)}`)
if (bar && track) {
  // Paced: Chrome coalesces pointermove, and a single fast sweep can deliver so
  // few events that the drag looks like it did nothing.
  await page.mouse.move(bar.x + bar.width / 2, bar.y + bar.height / 2)
  await page.mouse.down()
  for (let i = 1; i <= 5; i++) {
    await page.mouse.move(bar.x + bar.width / 2 - i * 14, bar.y + bar.height / 2)
    await page.waitForTimeout(30)
  }
  await page.mouse.up()
  await page.waitForTimeout(250)
}
const movedTo = await page.evaluate(() => window.__pfState().doc.layers.find((x) => x.clip).clip.start)
console.log('drag moved the clip:', dragged, '->', movedTo)
check('dragging the bar slides the clip', movedTo < dragged, `${dragged} -> ${movedTo}`)

// --- the thumbnails follow the clip -------------------------------------------------
// The whole reason for merging the bar into the filmstrip: trimming has to show
// you where you are landing, which means the pictures must re-slice.
const resliced = await page.evaluate(async () => {
  const st = window.__pfState()
  const l = st.doc.layers.find((x) => x.clip)
  const a = window.__pfAssets.getAsset(l.assetId)
  const F = window.__pfFilmstrip
  const before = F.stripTimes(l, a, 400, st.duration, 44, F.stripWindow(l, a, st.duration))
  st.trimClip(l.id, 'start', (l.clip.start + l.clip.out) / 2)
  const after0 = window.__pfState()
  const l2 = after0.doc.layers.find((x) => x.id === l.id)
  const after = F.stripTimes(l2, a, 400, after0.duration, 44,
    F.stripWindow(l2, a, after0.duration))
  return {
    beforeFirst: Math.round(before[0].assetT),
    afterFirst: Math.round(after[0].assetT),
    beforeSpan: Math.round(before[before.length - 1].assetT - before[0].assetT),
    afterSpan: Math.round(after[after.length - 1].assetT - after[0].assetT),
  }
})
console.log('after trimming the head:', JSON.stringify(resliced))
check('trimming moves which frames the strip shows',
  resliced.afterFirst > resliced.beforeFirst,
  `first frame ${resliced.beforeFirst}ms -> ${resliced.afterFirst}ms`)
check('and it covers less of the source', resliced.afterSpan < resliced.beforeSpan,
  `${resliced.beforeSpan}ms -> ${resliced.afterSpan}ms`)

// --- the panel is worth looking at ----------------------------------------------------
const sized = await page.evaluate(() => {
  const tl = document.querySelector('.timeline')
  const stage = document.querySelector('.stage')
  const col = tl.parentElement
  return {
    timeline: Math.round(tl.getBoundingClientRect().height),
    stage: Math.round(stage.getBoundingClientRect().height),
    column: Math.round(col.getBoundingClientRect().height),
    handle: !!document.querySelector('.tl-split'),
  }
})
console.log('layout:', JSON.stringify(sized))
check('the editing panel gets real height, not a sliver',
  sized.timeline > sized.column * 0.35, `${sized.timeline} of ${sized.column}px`)
check('and there is a handle to change it', sized.handle)
check('while the canvas keeps room to show the frame',
  sized.stage > 140, `${sized.stage}px of stage`)

// Dragging the handle upward makes it taller, and it is remembered.
const grip = await page.locator('.tl-split').boundingBox()
await page.mouse.move(grip.x + grip.width / 2, grip.y + 3)
await page.mouse.down()
for (let i = 1; i <= 5; i++) {
  await page.mouse.move(grip.x + grip.width / 2, grip.y + 3 - i * 20)
  await page.waitForTimeout(30)
}
await page.mouse.up()
await page.waitForTimeout(250)
const grew = await page.evaluate(() => ({
  timeline: Math.round(document.querySelector('.timeline').getBoundingClientRect().height),
  saved: Number(localStorage.getItem('pf-timeline-h')),
}))
console.log('after dragging the handle up:', JSON.stringify(grew))
check('dragging the handle resizes the panel', grew.timeline > sized.timeline,
  `${sized.timeline} -> ${grew.timeline}px`)
check('and the size is remembered', grew.saved > 0, `${grew.saved}px stored`)

console.log(errors.length ? 'CONSOLE ERRORS: ' + errors.slice(0, 5).join(' | ') : 'no console errors')
await browser.close()
process.exit(checks.some(([, ok]) => !ok) ? 1 : 0)
