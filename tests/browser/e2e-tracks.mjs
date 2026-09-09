// Tracks.
//
// A track is one integer on a layer. The document's layer array already *is*
// stacking order, so rather than keep a second ordering beside it — two truths
// that can disagree — moving a clip between tracks re-sorts that array. The
// renderer never learns tracks exist, which is the whole point: there is one
// answer to "what is in front of what", and the timeline and the layers panel
// cannot contradict each other.
//
// So the claims worth testing are: a higher track really does draw in front,
// nothing that is not a clip gets shuffled while that happens, and a track comes
// into existence by being used rather than by pressing anything.
import { chromium } from 'playwright-core'
import { importAndPlace } from '../e2e-helpers.mjs'
import fs from 'fs'
import path from 'path'

const OUT = 'shots/tracks'
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

// Two clips from two different assets, so which one is drawn can be told apart
// by colour rather than by guessing.
const built = await page.evaluate(async () => {
  const st = window.__pfState()
  st.resetDoc()
  const load = async (url, name) => {
    const blob = await (await fetch(url)).blob()
    const f = new File([blob], name, { type: blob.type })
    const a = await window.__pfAssets.loadImageFile(f)
    return a.id
  }
  const room = await load('/test/room.png', 'room.png')
  const green = await load('/test/greenscreen.gif', 'greenscreen.gif')
  const a = window.__pfState().insertClip(room, { track: 0, at: 0 })
  const b = window.__pfState().insertClip(green, { track: 0, at: 0 })
  const clips = window.__pfState().doc.layers.filter((l) => l.clip)
  return {
    a, b,
    tracks: window.__pfState().trackCount(),
    starts: clips.map((l) => l.clip.start),
  }
})
console.log('two clips:', JSON.stringify(built))
check('two clips inserted without a button', !!built.a && !!built.b)
// Dropped at the same spot on the same row, the second lands after the first
// rather than on top of it — otherwise one silently hides the other.
check('the second lands after the first, not on top of it', built.starts[1] > 0,
  `starts ${built.starts.join(', ')}`)
check('both land on the first track', built.tracks === 1, `${built.tracks} tracks`)

/** The colour at the middle of the canvas at time 0 — which clip is in front. */
const front = () => page.evaluate(() => {
  const st = window.__pfState()
  const c = document.createElement('canvas')
  c.width = st.doc.width
  c.height = st.doc.height
  const ctx = c.getContext('2d', { willReadFrequently: true })
  window.__pfRender.renderDocument(ctx, st.doc, 0)
  const d = ctx.getImageData(Math.floor(c.width / 2), Math.floor(c.height / 2), 1, 1).data
  return [d[0], d[1], d[2]]
})

const order = () => page.evaluate(() => window.__pfState().doc.layers.map(
  (l) => `${l.name}:${l.clip ? (l.track || 0) : '-'}`))

// Deliberately stack them now: dropping one clip on top of another on the same
// row is a thing a person will do, and it is the only case where within-track
// z-order is observable at all.
await page.evaluate((id) => window.__pfState().slideClip(id, 0), built.b)
await page.waitForTimeout(150)
console.log('layer order:', JSON.stringify(await order()))
const before = await front()
console.log('front pixel with both overlapping on track 0:', JSON.stringify(before))

// --- a higher track draws in front ------------------------------------------------
const raised = await page.evaluate((id) => {
  const st = window.__pfState()
  st.setClipTrack(id, 1)
  return {
    order: window.__pfState().doc.layers.map((l) => `${l.name}:${l.clip ? (l.track || 0) : '-'}`),
    tracks: window.__pfState().trackCount(),
  }
}, built.a)
console.log('after raising the first clip:', JSON.stringify(raised))
check('using a second track creates it', raised.tracks === 2, `${raised.tracks} tracks`)
// The array is the z-order, so the raised clip has to have moved to the end of it.
check('and the layer array follows the track order',
  raised.order[raised.order.length - 1].startsWith('room'), raised.order.join(' | '))

const after = await front()
console.log('front pixel after raising:', JSON.stringify(after))
check('so what is drawn in front actually changes',
  before.join() !== after.join(), `${before.join()} -> ${after.join()}`)

// And back again. Note what is *not* claimed: the original within-track order.
// Clips on one track are arranged in time, not in depth, so which of two
// overlapping ones is in front is not something a track promises — moving out
// and back does not restore it, and should not pretend to.
await page.evaluate((id) => window.__pfState().setClipTrack(id, 0), built.a)
await page.waitForTimeout(150)
const backAgain = await page.evaluate(() => ({
  tracks: window.__pfState().trackCount(),
  order: window.__pfState().doc.layers.filter((l) => l.clip).map((l) => l.name),
}))
console.log('moved back:', JSON.stringify(backAgain))
check('moving it back collapses the tracks again', backAgain.tracks === 1,
  `${backAgain.tracks} tracks`)
// The array is still the z-order, so the front pixel must match whichever clip
// the array puts last.
const frontName = backAgain.order[backAgain.order.length - 1]
const nowFront = await front()
check('and z-order still follows the layer array',
  (frontName === 'greenscreen.gif') === (nowFront.join() === before.join()),
  `${frontName} in front, pixel ${nowFront.join()}`)

// --- a title lands above the footage, and stays on its own track ----------------------
// A title used to be a layer with no clip, which is why this once asked whether
// its position in the array survived clips moving: there was nothing else to ask.
// A title is a clip now, so it has a track, and depth is that track. What matters
// is that it arrives above the pictures and that moving *other* clips does not
// move it.
const withText = await page.evaluate((ids) => {
  const st = window.__pfState()
  const { makeTextLayer } = window.__pfStore
  const before = window.__pfState().trackCount()
  st.addLayer(makeTextLayer({ text: 'TITLE', size: 40, x: 10, y: 10, color: '#ffffff' }))
  const title = () => window.__pfState().doc.layers.find((l) => l.type === 'text')
  const trackBefore = title().track
  window.__pfState().setClipTrack(ids.a, 1)
  window.__pfState().setClipTrack(ids.b, 2)
  return {
    topTrackWas: before - 1,
    trackBefore,
    trackAfter: title().track,
    hasClip: !!title().clip,
  }
}, built)
console.log('the title:', JSON.stringify(withText))
check('a title arrives above the footage that is already there',
  withText.hasClip && withText.trackBefore > withText.topTrackWas,
  `track ${withText.trackBefore} over a top track of ${withText.topTrackWas}`)
check('and moving other clips does not move it',
  withText.trackBefore === withText.trackAfter,
  `track ${withText.trackBefore} -> ${withText.trackAfter}`)

// --- the timeline shows a row per track, and one to grow into --------------------------
const ui = await page.evaluate(async () => {
  const btn = [...document.querySelectorAll('button')].find((b) => /^Video/.test(b.textContent))
  if (btn) btn.click()
  await new Promise((r) => setTimeout(r, 500))
  const rows = [...document.querySelectorAll('.track-row')]
  return {
    total: rows.length,
    empty: rows.filter((r) => r.classList.contains('empty')).length,
    labels: rows.map((r) => r.querySelector('.track-name').textContent.trim()),
    clips: rows.map((r) => r.querySelectorAll('.strip.clip').length),
  }
})
console.log('rows:', JSON.stringify(ui))
check('a row per track', ui.total === 4, `${ui.total} rows for 3 tracks plus one empty`)
check('exactly one of them empty', ui.empty === 1)
// Front-most at the top, which is how a timeline is read and how the tracks are
// numbered: V3 above V2 above V1.
// Plain words, not NLE shorthand. "V1" has to be learned, and reads as volume.
check('front-most track at the top, named in plain words',
  ui.labels[1] === 'Track 3' && ui.labels[3] === 'Track 1', ui.labels.join(','))
await page.screenshot({ path: path.join(OUT, '01-tracks.png') })

// --- dragging a clip onto another track moves it ------------------------------------------
const dragged = await page.evaluate(() => {
  const rows = [...document.querySelectorAll('.track-row')]
  const from = rows.find((r) => r.querySelector('.strip.clip'))
  const clip = from.querySelector('.strip.clip').getBoundingClientRect()
  const target = rows[rows.length - 1].getBoundingClientRect()
  return {
    x: clip.x + clip.width / 2,
    y: clip.y + clip.height / 2,
    ty: target.y + target.height / 2,
    id: null,
  }
})
await page.mouse.move(dragged.x, dragged.y)
await page.mouse.down()
for (let i = 1; i <= 6; i++) {
  await page.mouse.move(dragged.x, dragged.y + ((dragged.ty - dragged.y) * i) / 6)
  await page.waitForTimeout(30)
}
await page.mouse.up()
await page.waitForTimeout(250)
const moved = await page.evaluate(() => {
  const l = window.__pfState().doc.layers.filter((x) => x.clip)
  return l.map((x) => `${x.name}:${x.track || 0}`)
})
console.log('after dragging down a row:', JSON.stringify(moved))
check('dragging a clip onto another row moves it there',
  moved.some((m) => m.endsWith(':0')), moved.join(' | '))

// --- dropping media on the empty track adds a clip there -------------------------------------
const dropped = await page.evaluate(async () => {
  const st = window.__pfState()
  const top = st.trackCount()
  const asset = st.doc.media[0]
  const id = st.insertClip(asset, { track: top, at: 500 })
  const l = window.__pfState().doc.layers.find((x) => x.id === id)
  return { track: l.track, start: l.clip.start, tracks: window.__pfState().trackCount() }
})
console.log('inserted on the empty track:', JSON.stringify(dropped))
check('using the empty track brings a new one into being',
  dropped.tracks === dropped.track + 1, `now ${dropped.tracks} tracks`)
check('and the clip lands where it was dropped', dropped.start === 500, `${dropped.start}ms`)

// --- closing gaps works per track, not across them ----------------------------------------------
// Clips on different rows are meant to run at the same time; pulling them into
// one queue would destroy the arrangement rather than tidy it.
const gaps = await page.evaluate(() => {
  const st = window.__pfState()
  const clips = st.doc.layers.filter((l) => l.clip)
  clips.forEach((l, i) => st.slideClip(l.id, 2000 + i * 1500))
  st.closeClipGaps()
  const after = window.__pfState().doc.layers.filter((l) => l.clip)
  const starts = {}
  for (const l of after) {
    const t = l.track || 0
    starts[t] = Math.min(starts[t] == null ? Infinity : starts[t], l.clip.start)
  }
  return starts
})
console.log('first clip on each track after closing gaps:', JSON.stringify(gaps))
check('every track closes back to zero independently',
  Object.values(gaps).every((v) => v === 0), JSON.stringify(gaps))

// --- one upward drag promotes a clip by one track, not by however many ------------
// Moving onto the empty row creates that track, which puts a new empty row above
// it — under the pointer, which creates another. Dragging up used to spawn
// tracks without limit.
const runaway = await page.evaluate(() => {
  const st = window.__pfState()
  st.resetDoc()
  return null
})
await page.evaluate(async () => {
  const st = window.__pfState()
  const blob = await (await fetch('/test/motion.gif')).blob()
  const a = await window.__pfAssets.loadImageFile(
    new File([blob], 'motion.gif', { type: 'image/gif' }))
  st.insertClip(a.id, { track: 0, at: 0 })
  await new Promise((r) => setTimeout(r, 400))
})
const start = await page.evaluate(() => {
  const clip = document.querySelector('.strip.clip').getBoundingClientRect()
  return { x: clip.x + clip.width / 2, y: clip.y + clip.height / 2, tracks: window.__pfState().trackCount() }
})
await page.mouse.move(start.x, start.y)
await page.mouse.down()
// Straight up, well past the top of the panel, pausing so every step is
// delivered — this is exactly the gesture that ran away.
for (let i = 1; i <= 12; i++) {
  await page.mouse.move(start.x, start.y - i * 14)
  await page.waitForTimeout(25)
}
await page.mouse.up()
await page.waitForTimeout(250)
const afterDrag = await page.evaluate(() => ({
  tracks: window.__pfState().trackCount(),
  rows: document.querySelectorAll('.track-row').length,
  clips: window.__pfState().doc.layers.filter((l) => l.clip).length,
}))
console.log('after dragging straight up:', JSON.stringify(afterDrag), 'from', start.tracks)
check('dragging up promotes by exactly one track', afterDrag.tracks <= start.tracks + 1,
  `${start.tracks} -> ${afterDrag.tracks} tracks`)
check('and creates no clips along the way', afterDrag.clips === 1, `${afterDrag.clips} clips`)
check('so the rows do not run away', afterDrag.rows <= 3, `${afterDrag.rows} rows`)

// --- importing a video puts it on a track, ready to cut -------------------------------
// The failure this prevents: drop in a long MP4 and get a layer that loops for
// the whole project and cannot be cut, sitting below an empty track.
const imported = await page.evaluate(async () => {
  const st = window.__pfState()
  st.resetDoc()
  const blob = await (await fetch('/test/withaudio.mp4')).blob()
  const f = new File([blob], 'withaudio.mp4', { type: 'video/mp4' })
  const a = await window.__pfAssets.loadImageFile(f)
  window.__pfState().placeMedia([a.id], { resizeDocToFirst: true })
  await new Promise((r) => setTimeout(r, 400))
  const l = window.__pfState().doc.layers.find((x) => x.assetId === a.id)
  return {
    clipped: !!l.clip,
    track: l.track,
    length: l.clip ? Math.round(l.clip.out - l.clip.in) : 0,
    assetMs: Math.round(a.duration),
  }
})
console.log('imported video:', JSON.stringify(imported))
check('an imported video arrives as a clip', imported.clipped)
check('on the first track', imported.track === 0, String(imported.track))
check('covering the whole file', Math.abs(imported.length - imported.assetMs) < 60,
  `${imported.length}ms of ${imported.assetMs}ms`)

// And being a clip is what makes it cuttable at all.
const cuttable = await page.evaluate(() => {
  const st = window.__pfState()
  const n = st.splitClips(Math.round(st.duration / 2))
  return { n, clips: window.__pfState().doc.layers.filter((l) => l.clip).length }
})
console.log('cutting the import:', JSON.stringify(cuttable))
check('so it can be cut straight away', cuttable.n === 1 && cuttable.clips === 2,
  `${cuttable.clips} clips`)

// A GIF still arrives unclipped: in this app a GIF is usually an overlay, and
// an overlay wants to be visible throughout.
const gif = await page.evaluate(async () => {
  const st = window.__pfState()
  st.resetDoc()
  const blob = await (await fetch('/test/motion.gif')).blob()
  const f = new File([blob], 'motion.gif', { type: 'image/gif' })
  const a = await window.__pfAssets.loadImageFile(f)
  window.__pfState().placeMedia([a.id], { resizeDocToFirst: true })
  await new Promise((r) => setTimeout(r, 300))
  return !!window.__pfState().doc.layers.find((x) => x.assetId === a.id)?.clip
})
check('while a GIF still arrives as a looping overlay', gif === false)

// --- clips line up with each other, and say so ------------------------------------------
const snap = await page.evaluate(async () => {
  const st = window.__pfState()
  st.resetDoc()
  const blob = await (await fetch('/test/motion.gif')).blob()
  const a = await window.__pfAssets.loadImageFile(
    new File([blob], 'a.gif', { type: 'image/gif' }))
  const first = st.insertClip(a.id, { track: 0, at: 0 })
  const second = window.__pfState().insertClip(a.id, { track: 1, at: 4000 })
  await new Promise((r) => setTimeout(r, 600))
  const f = window.__pfState().doc.layers.find((l) => l.id === first)
  return {
    first,
    second,
    firstEnd: Math.round(f.clip.start + (f.clip.out - f.clip.in)),
    secondStart: window.__pfState().doc.layers.find((l) => l.id === second).clip.start,
  }
})
console.log('two clips on two tracks:', JSON.stringify(snap))
check('a clip on its own track to drag', snap.secondStart === 4000, `${snap.secondStart}`)

const geom = await page.evaluate((id) => {
  const rows = [...document.querySelectorAll('.track-row')]
  const row = rows.find((r) => r.querySelector('.strip.clip'))
  const lane = row.querySelector('.track-lane').getBoundingClientRect()
  const clips = [...document.querySelectorAll('.strip.clip')]
  // The one on the upper track is the second: rows are drawn front-most first.
  const bar = clips[0].getBoundingClientRect()
  return {
    lane: { x: lane.x, w: lane.width },
    bar: { x: bar.x, y: bar.y, w: bar.width, h: bar.height },
    duration: window.__pfState().duration,
  }
}, snap.second)
console.log('geometry:', JSON.stringify(geom))

// Drag the second clip so its start lands *near* the first one's end — a few
// pixels off, which is exactly what a hand does.
const pxPerMs = geom.lane.w / geom.duration
const wantX = geom.lane.x + snap.firstEnd * pxPerMs + 5
const grabX = geom.bar.x + geom.bar.w / 2
const grabY = geom.bar.y + geom.bar.h / 2
const offset = grabX - geom.bar.x
await page.mouse.move(grabX, grabY)
await page.mouse.down()
let sawGuide = false
for (let i = 1; i <= 8; i++) {
  await page.mouse.move(grabX + ((wantX + offset - grabX) * i) / 8, grabY)
  await page.waitForTimeout(30)
  if (!sawGuide) {
    sawGuide = await page.evaluate(() => !!document.querySelector('.snap-guide'))
  }
}
const during = await page.evaluate(() => ({
  guide: !!document.querySelector('.snap-guide'),
  at: window.__pfState().snapAt,
  start: window.__pfState().doc.layers.find((l) => l.clip && (l.track || 0) === 1)?.clip.start,
}))
await page.mouse.up()
await page.waitForTimeout(250)
const landed = await page.evaluate(() => ({
  start: window.__pfState().doc.layers.find((l) => l.clip && (l.track || 0) === 1)?.clip.start,
  guide: !!document.querySelector('.snap-guide'),
  at: window.__pfState().snapAt,
}))
console.log('while dragging:', JSON.stringify(during), 'after:', JSON.stringify(landed))
check('dragging near another clip shows a guide', sawGuide || during.guide)
check('and the guide is at the edge it caught', during.at === snap.firstEnd,
  `guide at ${during.at}, edge at ${snap.firstEnd}`)
// The point of the whole thing: a few pixels off by hand lands exactly on.
check('the clip lands exactly on that edge', landed.start === snap.firstEnd,
  `${landed.start} against ${snap.firstEnd}`)
check('and the guide goes away when the drag ends', landed.guide === false && landed.at === null)

console.log(errors.length ? 'CONSOLE ERRORS: ' + errors.slice(0, 5).join(' | ') : 'no console errors')
await browser.close()
process.exit(checks.some(([, ok]) => !ok) ? 1 : 0)
