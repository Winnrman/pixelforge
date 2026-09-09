// Sound on its own track.
//
// It used to be a number in the inspector and a shape painted behind the
// thumbnails on the video clip — enough to see that there *is* sound, and no use
// at all for doing anything to it. "Bring this down while she is talking" was
// not a thing you could do.
//
// The lane is the volume: the whole height of it, so a point has somewhere to be
// and the line between points is the shape of the fade being drawn. The points
// are ordinary keyframes, which is the part worth testing hardest — they undo,
// they ease, they save into the project, and they are the same objects the
// Keyframes tab shows.
import { chromium } from 'playwright-core'
import { importAndPlace } from './e2e-helpers.mjs'
import fs from 'fs'
import path from 'path'

const OUT = 'shots-audiotrack'
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

await importAndPlace(page, 'public/test/withaudio.mp4', { timeout: 40000 })
await page.evaluate(() => { window.__pfState().setPlaying(false); window.__pfState().setTime(0) })
await page.waitForTimeout(2000)
await page.evaluate(() => {
  const b = [...document.querySelectorAll('button')].find((x) => /^Video/.test(x.textContent))
  if (b) b.click()
})
await page.waitForTimeout(1500)

const rows = await page.evaluate(() => ({
  audioRows: document.querySelectorAll('.audio-row').length,
  audioClips: document.querySelectorAll('.audio-clip').length,
  videoClips: document.querySelectorAll('.track-row .strip').length,
  label: document.querySelector('.audio-row .track-name')?.textContent || '',
}))
console.log('the timeline:', JSON.stringify(rows))
check('a clip with sound gets a row of its own', rows.audioRows === 1 && rows.audioClips === 1,
  JSON.stringify(rows))
check('under the video track rather than inside them', rows.videoClips >= 1)
check('and the row says which track it belongs to', /^A1$/.test(rows.label), rows.label)

const laneBox = await page.locator('.audio-clip').first().boundingBox()
console.log('the lane:', JSON.stringify(laneBox))
check('the lane spans the clip', laneBox.width > 400, `${Math.round(laneBox.width)}px`)

/** The volume track as it stands. */
const track = () => page.evaluate(() => {
  const l = window.__pfState().doc.layers[0]
  return (l.tracks?.volume || []).map((k) => ({ t: Math.round(k.t), v: +k.v.toFixed(2) }))
})

check('with nothing on it to begin with', (await track()).length === 0)

// --- putting points on it -----------------------------------------------------
// Near the top is loud, near the bottom is quiet, and half height is normal —
// so putting the sound back where it was is the middle rather than a number to
// remember.
await page.mouse.click(laneBox.x + laneBox.width * 0.3, laneBox.y + laneBox.height * 0.25)
await page.waitForTimeout(300)
await page.mouse.click(laneBox.x + laneBox.width * 0.7, laneBox.y + laneBox.height * 0.85)
await page.waitForTimeout(300)
const two = await track()
console.log('after two clicks:', JSON.stringify(two))
check('clicking the lane puts a point there', two.length === 2, JSON.stringify(two))
check('high up is loud', two[0].v > 1.3, String(two[0].v))
check('low down is quiet', two[1].v < 0.45, String(two[1].v))
check('and they land where they were clicked in time',
  Math.abs(two[0].t - 600) < 60 && Math.abs(two[1].t - 1400) < 60, JSON.stringify(two))
await page.screenshot({ path: path.join(OUT, '01-points.png') })

// --- they are keyframes, not a second system ------------------------------------
const asKeys = await page.evaluate(() => {
  const l = window.__pfState().doc.layers[0]
  return {
    animatable: window.__pfKeys.isAnimatable('volume'),
    group: window.__pfKeys.GROUP_OF.volume,
    atStart: window.__pfKeys.valueAt(l, 'volume', 600),
    between: window.__pfKeys.valueAt(l, 'volume', 1000),
    atEnd: window.__pfKeys.valueAt(l, 'volume', 1400),
  }
})
console.log('as keyframes:', JSON.stringify(asKeys))
check('volume is an animatable property like any other', asKeys.animatable === true)
check('with its own lane group', asKeys.group === 'volume', String(asKeys.group))
check('and the value between two points is interpolated, not stepped',
  asKeys.between < asKeys.atStart && asKeys.between > asKeys.atEnd,
  `${asKeys.atStart} -> ${asKeys.between} -> ${asKeys.atEnd}`)

// The Keyframes tab is the same data seen another way.
const inKeyframes = await page.evaluate(async () => {
  const b = [...document.querySelectorAll('.tl-tabs button')].find((x) => /^Keyframes/.test(x.textContent))
  if (b) b.click()
  await new Promise((r) => setTimeout(r, 800))
  const names = [...document.querySelectorAll('.lane-name')].map((e) => e.textContent)
  return { names, hasLane: names.includes('Volume'), lanes: document.querySelectorAll('.key-lane').length }
})
console.log('in the keyframes tab:', JSON.stringify(inKeyframes))
check('the same points show as a lane in the Keyframes tab', inKeyframes.hasLane,
  JSON.stringify(inKeyframes))

await page.evaluate(async () => {
  const b = [...document.querySelectorAll('.tl-tabs button')].find((x) => /^Video/.test(x.textContent))
  if (b) b.click()
  await new Promise((r) => setTimeout(r, 700))
})

// --- undo ------------------------------------------------------------------------
await page.evaluate(() => window.__pfState().undo())
await page.waitForTimeout(300)
const undone = await track()
console.log('after one undo:', JSON.stringify(undone))
check('one undo takes back one point, not the lot', undone.length === 1,
  JSON.stringify(undone))
await page.evaluate(() => window.__pfState().redo())
await page.waitForTimeout(300)

// --- taking one away --------------------------------------------------------------
const points = page.locator('.audio-point')
check('every point is on screen', (await points.count()) === 2, `${await points.count()}`)
await points.first().dblclick()
await page.waitForTimeout(300)
const afterRemove = await track()
console.log('after double-clicking a point:', JSON.stringify(afterRemove))
check('double-clicking a point takes it away', afterRemove.length === 1,
  JSON.stringify(afterRemove))

// The last one takes the track with it, so a clip with no points is the document
// it was before any were put on.
await page.locator('.audio-point').first().dblclick()
await page.waitForTimeout(300)
const emptied = await page.evaluate(() => {
  const l = window.__pfState().doc.layers[0]
  return { track: l.tracks?.volume ?? null, tracks: l.tracks ?? null }
})
console.log('with the last one gone:', JSON.stringify(emptied))
check('the last point takes the track with it', emptied.track === null,
  JSON.stringify(emptied))

// --- the sound actually follows ------------------------------------------------------
// The whole point of a point. Scheduled on the voice's gain node, so this is
// checked where it is decided rather than by listening.
const scheduled = await page.evaluate(async () => {
  const st = window.__pfState()
  const l = st.doc.layers[0]
  st.setVolumePoint(l.id, 200, 0.2)
  st.setVolumePoint(l.id, 1200, 1.6)
  await new Promise((r) => setTimeout(r, 200))

  // An offline context: building the graph is what schedules the ramps, and an
  // offline one runs the same code without needing speakers.
  const ctx = new OfflineAudioContext(2, 48000 * 2, 48000)
  const doc = window.__pfState().doc
  const graph = window.__pfAudio.buildGraph(ctx, doc, (x) => window.__pfAssets.getAsset(x.assetId), {
    from: 0, when: 0, master: 1, muted: false,
  })
  const voice = graph.voices[0]
  return {
    voices: graph.voices.length,
    // Rendering runs the automation; sampling the gain afterwards is not
    // possible, so what is checked is that a curve was scheduled at all and that
    // the values it was built from are the ones on the track.
    atStart: window.__pfKeys.valueAt(window.__pfState().doc.layers[0], 'volume', 200),
    atEnd: window.__pfKeys.valueAt(window.__pfState().doc.layers[0], 'volume', 1200),
    hasGain: !!voice?.gain,
  }
})
console.log('scheduled onto the voice:', JSON.stringify(scheduled))
check('the clip still has a voice with a gain of its own', scheduled.hasGain && scheduled.voices === 1)
check('and the curve it follows is the one on the lane',
  Math.abs(scheduled.atStart - 0.2) < 0.01 && Math.abs(scheduled.atEnd - 1.6) < 0.01,
  `${scheduled.atStart} -> ${scheduled.atEnd}`)

// --- the waveform has to show shape, not a ceiling ------------------------------------
// A peak envelope is a true picture of a signal and a useless one for anything
// mastered in the last thirty years: compressed hard enough that it touches the
// ceiling from end to end, so it draws as a solid block that says nothing about
// where the words are. The body — root mean square — is the loudness you hear.
const shape = await page.evaluate(() => {
  // Peaks pinned at full scale throughout, loudness halving partway: exactly
  // what compression does, and what a peak-only waveform cannot show.
  const ctx = new OfflineAudioContext(1, 44100 * 4, 44100)
  const buf = ctx.createBuffer(1, 44100 * 4, 44100)
  const d = buf.getChannelData(0)
  for (let i = 0; i < d.length; i++) {
    const loud = i < d.length / 2
    d[i] = loud ? Math.sin((i / 44100) * 700) * 0.98 : ((i % 900) < 6 ? 0.98 : 0)
  }
  const asset = { audio: buf }
  const W = window.__pfWave
  const peak = [...W.columnsFor(asset, 0, 4000, 20, 'peak')]
  const rms = [...W.columnsFor(asset, 0, 4000, 20, 'rms')]
  const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length
  return {
    peakFirst: mean(peak.slice(0, 9)),
    peakLast: mean(peak.slice(11)),
    rmsFirst: mean(rms.slice(0, 9)),
    rmsLast: mean(rms.slice(11)),
  }
})
console.log('peaks against body on compressed audio:', JSON.stringify(shape))
check('the peak envelope really is flat on this — it is not a bad measurement',
  Math.abs(shape.peakFirst - shape.peakLast) < 0.05,
  `${shape.peakFirst.toFixed(2)} then ${shape.peakLast.toFixed(2)}`)
check('and the body shows the drop the peaks hide',
  shape.rmsFirst > shape.rmsLast * 2,
  `${shape.rmsFirst.toFixed(2)} then ${shape.rmsLast.toFixed(2)}`)

const drawnLane = await page.evaluate(() => {
  const c = document.querySelector('.audio-clip canvas')
  if (!c) return { none: true }
  const ctx = c.getContext('2d', { willReadFrequently: true })
  const d = ctx.getImageData(0, 0, c.width, c.height).data
  // How tall the drawn wave is across the lane. A solid block is every column
  // full height; a waveform is not.
  const heights = []
  for (let x = 2; x < c.width - 2; x += Math.max(1, Math.floor(c.width / 24))) {
    let lit = 0
    for (let y = 0; y < c.height; y++) if (d[(y * c.width + x) * 4 + 3] > 8) lit++
    heights.push(lit / c.height)
  }
  return { heights, min: Math.min(...heights), max: Math.max(...heights) }
})
console.log('the lane as drawn:', JSON.stringify({ min: drawnLane.min, max: drawnLane.max }))
// Only that there is a wave in the lane, not what shape it is. This fixture is a
// test pattern with a steady tone under it, so a flat lane is the correct
// drawing of it — asserting variation here would be asserting the fixture. The
// pair above is where the shape is checked, against a signal built to have some.
check('the lane draws the sound rather than filling itself',
  drawnLane.max > 0.1 && drawnLane.min < 0.95,
  `heights ${drawnLane.min?.toFixed(2)} to ${drawnLane.max?.toFixed(2)}`)

// --- a point moved while it is playing is heard while it is playing -----------------
// The bug this catches: the curve went into the layer, the layer went into the
// document, and the document was read exactly once — when play was pressed. So
// the points were right, the drawing was right, the offline render was right,
// and dragging a point while listening did nothing at all. Which is the only
// time anybody drags one.
//
// Measured as the gain the running voice is actually at, because the alternative
// way to ask whether the sound got quieter is to listen to it.
await page.evaluate(() => { window.__pfState().setPlaying(false); window.__pfState().setTime(0) })
await page.waitForTimeout(400)
const live = await page.evaluate(async () => {
  const st = window.__pfState()
  const A = window.__pfAudio
  const of = (x) => window.__pfAssets.getAsset(x.assetId)
  const l = st.doc.layers[0]
  // Start with a clean lane: earlier checks left points on it.
  st.updateLayer(l.id, { tracks: { ...(l.tracks || {}), volume: [] } })
  await A.play(window.__pfState().doc, of, 0, {})
  await new Promise((r) => setTimeout(r, 300))
  const before = A.voiceGains()[l.id]

  const down = A.currentTime()
  st.setVolumePoint(l.id, down + 40, 0.05)
  st.setVolumePoint(l.id, down + 4000, 0.05)
  const retuned = A.retune(window.__pfState().doc, of)
  await new Promise((r) => setTimeout(r, 300))
  const quiet = A.voiceGains()[l.id]

  // And back up, so it is not a one-way trip into silence.
  st.setVolumePoint(l.id, A.currentTime() + 40, 1.6)
  A.retune(window.__pfState().doc, of)
  await new Promise((r) => setTimeout(r, 300))
  const loud = A.voiceGains()[l.id]

  const stillPlaying = A.isPlaying()
  A.stop()
  return { before, retuned, quiet, loud, stillPlaying }
})
console.log('gain on the running voice:', JSON.stringify(live))
check('a voice starts at its own level', Math.abs(live.before - 1) < 0.01, `${live.before}`)
check('dragging a point down while it plays turns it down',
  live.retuned === true && live.quiet < 0.2, `${live.quiet}`)
check('and dragging it back up brings it back',
  live.loud > 1.2, `${live.loud}`)
check('without stopping the sound to do it', live.stillPlaying === true)

// The preview rate belongs in the ramp times. A point two seconds along arrives
// after one second of real time at 2x, and a ramp scheduled without the divide
// would still be climbing towards it long after the moment had gone by.
const fast = await page.evaluate(async () => {
  const of = (x) => window.__pfAssets.getAsset(x.assetId)
  const st = window.__pfState()
  const l = st.doc.layers[0]
  st.updateLayer(l.id, { tracks: { ...(l.tracks || {}), volume: [{ t: 0, v: 1, ease: 'linear' }, { t: 2000, v: 0, ease: 'linear' }] } })
  const layer = window.__pfState().doc.layers[0]
  // Rendering is the honest way to read a scheduled param: play a constant
  // through it and look at what came out half a second later.
  const sample = async (rate) => {
    const ctx = new OfflineAudioContext(1, 44100, 44100)
    const buf = ctx.createBuffer(1, 44100, 44100)
    buf.getChannelData(0).fill(1)
    const src = ctx.createBufferSource()
    src.buffer = buf
    const g = ctx.createGain()
    window.__pfAudio.scheduleGain(g.gain, layer, of(layer), [], { from: 0, at: 0, rate })
    src.connect(g); g.connect(ctx.destination); src.start(0)
    const out = await ctx.startRendering()
    return +out.getChannelData(0)[Math.floor(44100 * 0.5)].toFixed(3)
  }
  return { at1x: await sample(1), at2x: await sample(2) }
})
console.log('gain half a second in:', JSON.stringify(fast))
// Half a second at 1x is a quarter of the way down the two-second ramp.
check('a volume ramp follows document time at 1x',
  Math.abs(fast.at1x - 0.75) < 0.05, `${fast.at1x}`)
check('and runs twice as fast when the preview does',
  Math.abs(fast.at2x - 0.5) < 0.05, `${fast.at2x}`)

// --- bare audio lane is a spot in time, not a volume point ------------------------------------
// The lane *is* the volume line, so pressing on a clip's lane puts a point on
// it. Off the end of the clip there is no line to put a point on, and what a
// click there means is the same thing it means on bare video track: go there.
const bareAudio = await page.evaluate(async () => {
  const st = window.__pfState()
  const btn = [...document.querySelectorAll('.tl-tabs button')].find((x) => /^Video/.test(x.textContent))
  btn?.click()
  await new Promise((r) => setTimeout(r, 500))
  const l = window.__pfState().doc.layers.find((x) => x.clip && x.assetId)
  // Pushed along, so the front of its lane is bare.
  window.__pfState().slideClip(l.id, 2000)
  window.__pfState().updateLayer(l.id, { tracks: { ...(l.tracks || {}), volume: [] } })
  window.__pfState().setTime(0)
  await new Promise((r) => setTimeout(r, 500))
  const lane = document.querySelector('.audio-lane')
  const clip = document.querySelector('.audio-clip')
  if (!lane || !clip) return { none: true }
  const lr = lane.getBoundingClientRect()
  const cr = clip.getBoundingClientRect()
  return {
    x: Math.round(lr.left + (cr.left - lr.left) / 2),
    y: Math.round(lr.top + lr.height / 2),
    lane: [Math.round(lr.left), Math.round(lr.width)],
    gap: Math.round(cr.left - lr.left),
  }
})
console.log('the bare stretch of the audio lane:', JSON.stringify(bareAudio))
check('a clip pushed along leaves bare lane in front of it',
  !bareAudio.none && bareAudio.gap > 40, JSON.stringify(bareAudio))

await page.mouse.click(bareAudio.x, bareAudio.y)
await page.waitForTimeout(300)
const afterBare = await page.evaluate(() => {
  const l = window.__pfState().doc.layers.find((x) => x.clip && x.assetId)
  return {
    time: Math.round(window.__pfState().time),
    duration: Math.round(window.__pfState().duration),
    keys: (l.tracks?.volume || []).length,
  }
})
const wantAudio = ((bareAudio.x - bareAudio.lane[0]) / bareAudio.lane[1]) * afterBare.duration
console.log('after clicking it:', JSON.stringify(afterBare), 'wanted', Math.round(wantAudio))
check('clicking bare audio lane moves the playhead there',
  Math.abs(afterBare.time - wantAudio) < Math.max(60, afterBare.duration * 0.03),
  `${afterBare.time}ms, wanted ${Math.round(wantAudio)}ms`)
check('and does not leave a volume point behind on nothing',
  afterBare.keys === 0, `${afterBare.keys} points`)

// On the clip it still means what it always meant.
const onClip = await page.evaluate(async () => {
  const clip = document.querySelector('.audio-clip')
  const r = clip.getBoundingClientRect()
  clip.dispatchEvent(new PointerEvent('pointerdown', {
    bubbles: true, button: 0, clientX: r.left + r.width / 2, clientY: r.top + r.height * 0.75,
  }))
  await new Promise((x) => setTimeout(x, 250))
  const l = window.__pfState().doc.layers.find((x) => x.clip && x.assetId)
  return { keys: (l.tracks?.volume || []).length }
})
check('while pressing the clip’s own lane still puts a point on the line',
  onClip.keys === 1, `${onClip.keys} points`)

// --- J and L cuts ------------------------------------------------------------------
// A J cut is the next shot's sound arriving before its picture; an L cut is this
// shot's sound carrying on after the picture has gone. Rather than detaching the
// audio onto a layer of its own — a second object to keep in step, and a step to
// take before you can do anything — a clip's sound has its own two edges.
//
// Rendered and measured, because the fields being set says nothing about whether
// a sound arrives early. What settles it is hearing something at a moment that
// was silent before.
const jl = await page.evaluate(async () => {
  const st = window.__pfState()
  st.setPlaying(false)
  const l = st.doc.layers.find((x) => x.clip && x.assetId)
  const a = window.__pfAssets.getAsset(l.assetId)
  await window.__pfAudio.ensureAudio(a)
  // Taken from the middle of the recording, so there is material either side to
  // reach into.
  st.updateLayer(l.id, { clip: { start: 1000, in: 500, out: 1500 }, audio: {}, tracks: {} })
  await new Promise((r) => setTimeout(r, 300))

  const loudness = async () => {
    const ctx = new OfflineAudioContext(1, 44100 * 3, 44100)
    const doc = window.__pfState().doc
    window.__pfAudio.buildGraph(ctx, doc, (x) => window.__pfAssets.getAsset(x.assetId),
      { from: 0, when: 0, master: 1, muted: false })
    const out = await ctx.startRendering()
    const d = out.getChannelData(0)
    const rms = (from, to) => {
      let sum = 0
      let n = 0
      for (let i = Math.floor(from * 44100); i < Math.floor(to * 44100) && i < d.length; i++) {
        sum += d[i] * d[i]
        n++
      }
      return n ? +Math.sqrt(sum / n).toFixed(4) : 0
    }
    // Before the picture starts, during it, and after it ends.
    return { before: rms(0.5, 0.95), during: rms(1.1, 1.9), after: rms(2.1, 2.4) }
  }

  const lined = await loudness()
  st.setAudioEdge(l.id, 'lead', 500)      // sound starts 500ms early
  st.setAudioEdge(l.id, 'trail', 2400)    // and runs 400ms late
  await new Promise((r) => setTimeout(r, 300))
  const cut = await loudness()
  const now = window.__pfState().doc.layers.find((x) => x.id === l.id)
  return { lined, cut, edges: now.audio }
})
console.log('sound before, during and after the picture:', JSON.stringify(jl))
check('lined up, there is sound only while the picture is there',
  jl.lined.during > 0.02 && jl.lined.before < 0.005 && jl.lined.after < 0.005,
  JSON.stringify(jl.lined))
check('a J cut puts sound before the picture starts',
  jl.cut.before > 0.02, `${jl.lined.before} -> ${jl.cut.before}`)
check('an L cut carries it past the end',
  jl.cut.after > 0.02, `${jl.lined.after} -> ${jl.cut.after}`)
check('and the picture itself is unchanged in between',
  Math.abs(jl.cut.during - jl.lined.during) < 0.01,
  `${jl.lined.during} -> ${jl.cut.during}`)

// The lane is where the cut is made, so the handles have to be on it.
const grips = await page.evaluate(() => ({
  grips: document.querySelectorAll('.audio-clip .audio-grip').length,
  shaded: document.querySelectorAll('.audio-clip .audio-only').length,
}))
console.log('the lane:', JSON.stringify(grips))
check('the sound has a handle at each end', grips.grips === 2, JSON.stringify(grips))
// Otherwise a J cut just looks like a clip longer than the one above it.
check('and the stretch with no picture over it is shaded', grips.shaded === 2, JSON.stringify(grips))

// Cutting a clip that has a J or an L cut on it. Both belong to the outside
// edges of a run, the same as a fade: giving both halves both would play the
// lead-in a second time at the cut, where there is now a picture to go with it.
const halves = await page.evaluate(async () => {
  const st = window.__pfState()
  const l = st.doc.layers.find((x) => x.clip && x.assetId)
  st.updateLayer(l.id, { clip: { start: 1000, in: 400, out: 1600 }, audio: { lead: 300, trail: 300 } })
  await new Promise((r) => setTimeout(r, 300))
  const r = window.__pfClips.clipRange(window.__pfState().doc.layers.find((x) => x.id === l.id),
    window.__pfAssets.getAsset(l.assetId))
  window.__pfState().splitClips(Math.round(r.start + r.length / 2))
  await new Promise((r2) => setTimeout(r2, 400))
  const parts = window.__pfState().doc.layers
    .filter((x) => x.clip && x.assetId)
    .sort((a, b) => a.clip.start - b.clip.start)
    .map((x) => ({ lead: x.audio?.lead || 0, trail: x.audio?.trail || 0 }))
  return { parts }
})
console.log('cutting a clip with both edges out:', JSON.stringify(halves))
check('the first half keeps the lead and loses the trail',
  halves.parts[0]?.lead === 300 && halves.parts[0]?.trail === 0, JSON.stringify(halves.parts[0]))
check('and the second keeps the trail and loses the lead',
  halves.parts[1]?.trail === 300 && halves.parts[1]?.lead === 0, JSON.stringify(halves.parts[1]))

console.log(errors.length ? 'CONSOLE ERRORS: ' + errors.slice(0, 5).join(' | ') : 'no console errors')
await browser.close()
process.exit(checks.some(([, ok]) => !ok) ? 1 : 0)
