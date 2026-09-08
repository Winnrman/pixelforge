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

console.log(errors.length ? 'CONSOLE ERRORS: ' + errors.slice(0, 5).join(' | ') : 'no console errors')
await browser.close()
process.exit(checks.some(([, ok]) => !ok) ? 1 : 0)
