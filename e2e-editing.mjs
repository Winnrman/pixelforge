// The things that decide whether this is a video editor or a canvas with a
// timeline attached.
//
// A title you can put on screen for three seconds. Deleting a clip without
// leaving a hole. Marking a stretch and exporting only that. Stepping one frame
// at a time. Watching it back at half speed or on the whole display.
//
// None of these are effects. They are the operations you reach for between
// effects, and their absence is what made the timeline something to look at
// rather than something to work in.
import { chromium } from 'playwright-core'
import { importAndPlace } from './e2e-helpers.mjs'
import fs from 'fs'
import path from 'path'

const OUT = 'shots-editing'
fs.mkdirSync(OUT, { recursive: true })

const browser = await chromium.launch({
  executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  headless: true,
})
const page = await browser.newPage({ viewport: { width: 1600, height: 950 } })
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

await importAndPlace(page, 'public/test/longgop.mp4', { timeout: 60000 })
await page.evaluate(() => { window.__pfState().setPlaying(false); window.__pfState().setTime(0) })
await page.waitForTimeout(1500)
await page.evaluate(async () => {
  const b = [...document.querySelectorAll('.tl-tabs button')].find((x) => /^Video/.test(x.textContent))
  if (b) b.click()
  await new Promise((r) => setTimeout(r, 800))
})

// --- a title is a clip -------------------------------------------------------------
// Text used to span the whole document, so a title was either on for the entire
// video or not at all. Everything else in the timeline already worked on clips;
// text simply never had one.
const title = await page.evaluate(async () => {
  const st = window.__pfState()
  st.setTime(4000)
  const { makeTextLayer } = window.__pfStore
  const l = st.addLayer(makeTextLayer({ text: 'Adventure Trips', x: 40, y: 60, w: 240, h: 60 }))
  await new Promise((r) => setTimeout(r, 700))
  const now = window.__pfState().doc.layers.find((x) => x.id === l.id)
  return {
    hasClip: !!now.clip,
    start: now.clip?.start,
    length: now.clip ? now.clip.out - now.clip.in : 0,
    track: now.track,
    onAt4200: window.__pfRender.onScreen(now, 4200),
    onAt9000: window.__pfRender.onScreen(now, 9000),
    drawn: document.querySelectorAll('.strip.titleclip').length,
  }
})
console.log('a title added at four seconds:', JSON.stringify(title))
check('a title lands on the timeline as a clip', title.hasClip, JSON.stringify(title))
check('starting where the playhead is', Math.abs(title.start - 4000) < 40, `${title.start}ms`)
check('with a length you can read and trim', title.length >= 2000 && title.length <= 5000,
  `${title.length}ms`)
check('on a track above the picture', title.track >= 1, `track ${title.track}`)
check('and it is on screen only while its clip is', title.onAt4200 && !title.onAt9000,
  `${title.onAt4200} then ${title.onAt9000}`)
check('drawn as a clip, not as film it does not have', title.drawn === 1, `${title.drawn}`)
await page.screenshot({ path: path.join(OUT, '01-title.png') })

// Trimmable and draggable like anything else, because it *is* anything else.
const trimmed = await page.evaluate(async () => {
  const st = window.__pfState()
  const l = st.doc.layers.find((x) => x.type === 'text')
  st.trimClip(l.id, 'end', 5500)
  await new Promise((r) => setTimeout(r, 250))
  const a = window.__pfState().doc.layers.find((x) => x.id === l.id)
  window.__pfState().slideClip(l.id, 8000)
  await new Promise((r) => setTimeout(r, 250))
  const b = window.__pfState().doc.layers.find((x) => x.id === l.id)
  return { after: a.clip.out - a.clip.in, moved: b.clip.start }
})
console.log('trimmed and moved:', JSON.stringify(trimmed))
check('a title trims like a clip', trimmed.after < 2000, `${trimmed.after}ms`)
check('and slides like one', Math.abs(trimmed.moved - 8000) < 40, `${trimmed.moved}ms`)

// And there is a way back for the things that really do run the whole video.
const spanning = await page.evaluate(async () => {
  const st = window.__pfState()
  const l = st.doc.layers.find((x) => x.type === 'text')
  st.toggleClip(l.id)
  await new Promise((r) => setTimeout(r, 250))
  const now = window.__pfState().doc.layers.find((x) => x.id === l.id)
  return { clip: now.clip ?? null, onLate: window.__pfRender.onScreen(now, 25000) }
})
console.log('sent back to the whole video:', JSON.stringify(spanning))
check('a watermark can still span everything', spanning.clip === null && spanning.onLate === true,
  JSON.stringify(spanning))

// --- ripple delete -------------------------------------------------------------------
const ripple = await page.evaluate(async () => {
  const st = window.__pfState()
  // Three clips in a row, so there is something after the hole to close over it.
  st.doc.layers.filter((l) => l.type === 'text').forEach((l) => st.removeLayers([l.id]))
  await new Promise((r) => setTimeout(r, 200))
  window.__pfState().splitClips(10000)
  await new Promise((r) => setTimeout(r, 250))
  window.__pfState().splitClips(20000)
  await new Promise((r) => setTimeout(r, 400))
  const clips = () => window.__pfState().doc.layers.filter((l) => l.clip)
    .map((l) => Math.round(l.clip.start)).sort((a, b) => a - b)
  const before = clips()
  const mid = window.__pfState().doc.layers.filter((l) => l.clip)
    .sort((a, b) => a.clip.start - b.clip.start)[1]
  window.__pfState().select([mid.id])
  const res = window.__pfState().rippleDelete()
  await new Promise((r) => setTimeout(r, 300))
  return { before, after: clips(), res, duration: Math.round(window.__pfState().duration) }
})
console.log('rippling the middle clip out:', JSON.stringify(ripple))
check('three clips before', ripple.before.length === 3, JSON.stringify(ripple.before))
check('two after, and no hole where the third was',
  ripple.after.length === 2 && ripple.after[1] === ripple.before[1],
  `${JSON.stringify(ripple.before)} -> ${JSON.stringify(ripple.after)}`)
check('and it says what it did', ripple.res.ok === true, JSON.stringify(ripple.res))

// Plain delete still leaves the gap, because sometimes the gap is the point.
const plain = await page.evaluate(async () => {
  const st = window.__pfState()
  st.splitClips(6000)
  await new Promise((r) => setTimeout(r, 300))
  const sorted = () => window.__pfState().doc.layers.filter((l) => l.clip)
    .sort((a, b) => a.clip.start - b.clip.start)
  const before = sorted().map((l) => Math.round(l.clip.start))
  const first = sorted()[0]
  window.__pfState().removeLayers([first.id])
  await new Promise((r) => setTimeout(r, 250))
  return { before, after: sorted().map((l) => Math.round(l.clip.start)) }
})
console.log('plain delete:', JSON.stringify(plain))
check('an ordinary delete leaves the gap alone',
  plain.after[0] === plain.before[1], JSON.stringify(plain))

// --- marking a range ------------------------------------------------------------------
const marks = await page.evaluate(async () => {
  const st = window.__pfState()
  st.setTime(3000)
  st.setMark('in', 3000)
  st.setTime(9000)
  st.setMark('out', 9000)
  await new Promise((r) => setTimeout(r, 300))
  const s = window.__pfState()
  return {
    in: s.markIn,
    out: s.markOut,
    span: document.querySelectorAll('.tl-mark-span').length,
    handles: document.querySelectorAll('.tl-mark').length,
    // The top bar has a .mark of its own — the unsaved-changes dot. A generic
    // name here restyled it, which is why these are timeline-scoped.
    topbarUntouched: document.querySelectorAll('.topbar .mark, header .mark').length,
  }
})
console.log('marked:', JSON.stringify(marks))
check('a range can be marked', marks.in === 3000 && marks.out === 9000, JSON.stringify(marks))
check('and it is drawn on the bar it refers to', marks.span === 1 && marks.handles === 2,
  JSON.stringify(marks))

// An in-point past the out-point is not a range, and the control should not get
// stuck arguing about it.
const crossed = await page.evaluate(async () => {
  window.__pfState().setMark('in', 12000)
  await new Promise((r) => setTimeout(r, 150))
  const s = window.__pfState()
  return { in: s.markIn, out: s.markOut }
})
console.log('in-point dragged past the out-point:', JSON.stringify(crossed))
check('crossing the marks drops the one that no longer makes sense',
  crossed.in === 12000 && crossed.out === null, JSON.stringify(crossed))

const cleared = await page.evaluate(async () => {
  const st = window.__pfState()
  st.setMark('in', 3000)
  st.setMark('out', 9000)
  await new Promise((r) => setTimeout(r, 200))
  const before = { in: window.__pfState().markIn, out: window.__pfState().markOut }
  window.__pfState().clearMarks()
  await new Promise((r) => setTimeout(r, 200))
  return { before, after: { in: window.__pfState().markIn, out: window.__pfState().markOut } }
})
check('and they can be cleared', cleared.after.in === null && cleared.after.out === null,
  JSON.stringify(cleared))

// --- export knows about the range ---------------------------------------------------
const exportRange = await page.evaluate(async () => {
  const st = window.__pfState()
  st.setMark('in', 3000)
  st.setMark('out', 9000)
  await new Promise((r) => setTimeout(r, 200))
  const btn = [...document.querySelectorAll('button')].find((b) => /^Export/.test(b.textContent))
  btn?.click()
  await new Promise((r) => setTimeout(r, 700))
  const text = document.body.textContent || ''
  return {
    open: !!document.querySelector('.dialog, .export'),
    offersRange: /Marked/.test(text),
    saysLength: /6\.00s/.test(text),
  }
})
console.log('the export dialog:', JSON.stringify(exportRange))
check('export offers the marked range', exportRange.offersRange, JSON.stringify(exportRange))
check('and says how long it is', exportRange.saysLength, JSON.stringify(exportRange))
await page.screenshot({ path: path.join(OUT, '02-export-range.png') })
await page.keyboard.press('Escape')
await page.waitForTimeout(300)

// --- moving through the video --------------------------------------------------------
// The way a video player does it: arrows skip, comma and full stop step a frame.
// A thirtieth of a second at a time is for landing a cut, not for getting to
// roughly the right place, which is the far more common thing to want.
const stepping = await page.evaluate(async () => {
  const st = window.__pfState()
  st.select([])
  st.setPlaying(false)
  st.setTime(15000)
  await new Promise((r) => setTimeout(r, 200))
  return {
    fps: st.doc.fps || 30,
    at: window.__pfState().time,
    duration: window.__pfState().duration,
  }
})
const frame = 1000 / stepping.fps
const skip = Math.min(5000, Math.max(frame, stepping.duration / 10))

await page.keyboard.press('ArrowRight')
await page.waitForTimeout(150)
const skipped = await page.evaluate(() => Math.round(window.__pfState().time))
console.log('one press of the right arrow:', JSON.stringify({ from: stepping.at, skipped, skip: Math.round(skip) }))
check('an arrow skips ahead by seconds, not by a frame',
  Math.abs(skipped - (stepping.at + skip)) < 30, `${stepping.at} -> ${skipped}, expected +${Math.round(skip)}ms`)

await page.keyboard.press('ArrowLeft')
await page.waitForTimeout(150)
const backAgain = await page.evaluate(() => Math.round(window.__pfState().time))
check('and back the same distance', Math.abs(backAgain - stepping.at) < 30,
  `${skipped} -> ${backAgain}`)

await page.keyboard.press('.')
await page.waitForTimeout(150)
const oneFrame = await page.evaluate(() => Math.round(window.__pfState().time))
await page.keyboard.press(',')
await page.keyboard.press(',')
await page.waitForTimeout(150)
const twoBack = await page.evaluate(() => Math.round(window.__pfState().time))
console.log('comma and full stop:', JSON.stringify({ oneFrame, twoBack, frame: Math.round(frame) }))
check('a full stop steps one frame on', Math.abs(oneFrame - (backAgain + frame)) < 2,
  `${backAgain} -> ${oneFrame}`)
check('and a comma steps one back', Math.abs(twoBack - (oneFrame - 2 * frame)) < 2,
  `${oneFrame} -> ${twoBack}`)

await page.keyboard.press('Shift+ArrowRight')
await page.waitForTimeout(150)
const fine = await page.evaluate(() => Math.round(window.__pfState().time))
check('shift makes the arrow fine, for when you are nearly there',
  Math.abs(fine - (twoBack + frame)) < 2, `${twoBack} -> ${fine}`)

await page.keyboard.press('Home')
await page.waitForTimeout(150)
const home = await page.evaluate(() => Math.round(window.__pfState().time))
await page.keyboard.press('End')
await page.waitForTimeout(150)
const end = await page.evaluate(() => Math.round(window.__pfState().time))
console.log('home and end:', JSON.stringify({ home, end, duration: Math.round(stepping.duration) }))
check('home goes to the start and end to the end',
  home === 0 && Math.abs(end - stepping.duration) < 2, `${home} and ${end}`)

// With a layer selected the arrows still nudge it, because that is what they are
// for when there is something to nudge.
const nudges = await page.evaluate(async () => {
  const st = window.__pfState()
  const l = st.doc.layers.find((x) => x.clip)
  st.select([l.id])
  await new Promise((r) => setTimeout(r, 200))
  return { x: window.__pfState().doc.layers.find((z) => z.id === l.id).x, t: window.__pfState().time }
})
await page.keyboard.press('ArrowRight')
await page.waitForTimeout(200)
const nudged = await page.evaluate(() => {
  const st = window.__pfState()
  const l = st.doc.layers.find((x) => x.clip)
  return { x: l.x, t: st.time }
})
console.log('with a layer selected:', JSON.stringify({ nudges, nudged }))
check('a selected layer still moves instead', nudged.x > nudges.x && nudged.t === nudges.t,
  `${nudges.x} -> ${nudged.x}, time ${nudges.t} -> ${nudged.t}`)

// --- playback speed ----------------------------------------------------------------------
const speed = await page.evaluate(async () => {
  const sel = document.querySelector('.tl-rate')
  const options = sel ? [...sel.options].map((o) => o.value) : []
  window.__pfState().setRate(0.5)
  await new Promise((r) => setTimeout(r, 200))
  return { options, rate: window.__pfState().rate }
})
console.log('speed:', JSON.stringify(speed))
check('the preview has a speed control', speed.options.includes('0.5') && speed.options.includes('2'),
  speed.options.join(', '))
check('and setting it takes', speed.rate === 0.5, String(speed.rate))

// Half speed means the playhead moves at half the rate. Measured, not assumed.
const ran = await page.evaluate(async () => {
  const st = window.__pfState()
  st.select([])
  st.clearMarks()
  const at = (rate) => new Promise(async (res) => {
    window.__pfState().setRate(rate)
    window.__pfState().setTime(1000)
    window.__pfState().setPlaying(true)
    const t0 = performance.now()
    await new Promise((r) => setTimeout(r, 1200))
    const moved = window.__pfState().time - 1000
    window.__pfState().setPlaying(false)
    res({ moved, wall: performance.now() - t0 })
  })
  const slow = await at(0.5)
  await new Promise((r) => setTimeout(r, 300))
  const fast = await at(2)
  window.__pfState().setRate(1)
  return { slow, fast }
})
console.log('how far the playhead ran:', JSON.stringify({
  slow: Math.round(ran.slow.moved), fast: Math.round(ran.fast.moved),
}))
check('half speed covers less ground than double',
  ran.fast.moved > ran.slow.moved * 2.5,
  `${Math.round(ran.slow.moved)}ms against ${Math.round(ran.fast.moved)}ms in the same wall time`)

// --- full screen ---------------------------------------------------------------------------
const full = await page.evaluate(() => {
  const btn = [...document.querySelectorAll('button')].find((b) => b.title?.startsWith('Full screen'))
  return { found: !!btn, title: btn?.title || '' }
})
console.log('full screen:', JSON.stringify(full))
check('there is a way into full screen', full.found, full.title)
check('and it says how to get out again', /Escape/i.test(full.title), full.title)

// --- an overlay is as long as you need it ---------------------------------------------
// A clip with no media underneath has no source to run out of, but the trim
// clamped its new length to the "source length", which for such a clip was
// reported as its *current* length. So it could be shortened and then never
// lengthened again: a pixelate placed over three seconds of a shot could not be
// dragged to cover the rest of it, and the thing being hidden came back into
// view. That is a bad way to find out about a bug.
const overlay = await page.evaluate(async () => {
  const st = window.__pfState()
  st.doc.layers.filter((l) => l.type !== 'image').forEach((l) => st.removeLayers([l.id]))
  await new Promise((r) => setTimeout(r, 200))
  window.__pfState().setTime(8000)
  const { makeEffectLayer } = window.__pfStore
  const fx = window.__pfState().addLayer(makeEffectLayer({
    name: 'Pixelate', shape: 'rect', effect: 'pixelate', pixelSize: 20,
    x: 40, y: 40, w: 120, h: 120,
  }))
  await new Promise((r) => setTimeout(r, 300))
  const now = () => window.__pfState().doc.layers.find((l) => l.id === fx.id)
  const len = () => now().clip.out - now().clip.in
  const under = window.__pfState().doc.layers.find((l) => l.assetId && l.clip)
  const underRange = window.__pfClips.clipRange(under, window.__pfAssets.getAsset(under.assetId))

  const landed = { start: now().clip.start, len: len() }
  window.__pfState().trimClip(fx.id, 'end', 12000)
  await new Promise((r) => setTimeout(r, 150))
  const short = len()
  // The thing that could not be done: make it longer again.
  window.__pfState().trimClip(fx.id, 'end', 26000)
  await new Promise((r) => setTimeout(r, 150))
  const long = len()
  window.__pfState().trimClip(fx.id, 'start', 3000)
  await new Promise((r) => setTimeout(r, 150))
  return {
    landed,
    under: { start: Math.round(underRange.start), len: Math.round(underRange.length) },
    short: Math.round(short),
    long: Math.round(long),
    afterLeft: { start: now().clip.start, len: Math.round(len()) },
  }
})
console.log('a pixelate over a shot:', JSON.stringify(overlay))
// A censor should arrive covering the shot it was put over, not three seconds
// of it — the default is the one that fails safe.
check('an overlay lands covering the clip it was put over',
  Math.abs(overlay.landed.len - overlay.under.len) < 40
  && Math.abs(overlay.landed.start - overlay.under.start) < 40,
  `${JSON.stringify(overlay.landed)} against the shot ${JSON.stringify(overlay.under)}`)
// Trimming puts the *edge* at that document time, so the length that comes out
// is measured from wherever the clip starts — which is not zero here, because
// the shot it landed on does not start the timeline.
check('it can be shortened',
  Math.abs(overlay.short - (12000 - overlay.landed.start)) < 40,
  `${overlay.short}ms from a start of ${overlay.landed.start}`)
check('and lengthened again past where it was',
  Math.abs(overlay.long - (26000 - overlay.landed.start)) < 40 && overlay.long > overlay.short,
  `${overlay.short}ms -> ${overlay.long}ms`)
check('and its left edge can be dragged earlier',
  overlay.afterLeft.start === 3000 && Math.abs(overlay.afterLeft.len - 23000) < 40,
  JSON.stringify(overlay.afterLeft))

// The same for a title, which has no media either.
const stretched = await page.evaluate(async () => {
  const st = window.__pfState()
  st.setTime(2000)
  const { makeTextLayer } = window.__pfStore
  const l = st.addLayer(makeTextLayer({ text: 'A title', x: 10, y: 10, w: 200, h: 50 }))
  await new Promise((r) => setTimeout(r, 300))
  const now = () => window.__pfState().doc.layers.find((x) => x.id === l.id)
  const before = now().clip.out - now().clip.in
  window.__pfState().trimClip(l.id, 'end', 14000)
  await new Promise((r) => setTimeout(r, 150))
  return { before, after: Math.round(now().clip.out - now().clip.in) }
})
console.log('a title stretched:', JSON.stringify(stretched))
check('a title starts at a readable length', stretched.before === 3000, `${stretched.before}ms`)
check('and stretches to however long it is needed for',
  Math.abs(stretched.after - 12000) < 40, `${stretched.before}ms -> ${stretched.after}ms`)

console.log(errors.length ? 'CONSOLE ERRORS: ' + errors.slice(0, 5).join(' | ') : 'no console errors')
await browser.close()
process.exit(checks.some(([, ok]) => !ok) ? 1 : 0)
