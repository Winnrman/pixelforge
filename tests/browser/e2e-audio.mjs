// Audio playback.
//
// You cannot listen to a test, so this renders the same graph the player builds
// through an OfflineAudioContext and measures the samples that come out. That is
// the only way to establish the claims that matter — that a mute is actually
// silent, that a trimmed clip's sound really starts where the picture does, and
// that a clip stops when it ends rather than running on.
import { chromium } from 'playwright-core'
import { importAndPlace } from '../e2e-helpers.mjs'

const browser = await chromium.launch({
  executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  headless: true,
  args: ['--autoplay-policy=no-user-gesture-required'],
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
await importAndPlace(page, 'public/test/withaudio.mp4', { timeout: 30000 })
await page.evaluate(() => { window.__pfState().setPlaying(false); window.__pfState().setTime(0) })
await page.waitForTimeout(600)

// --- the soundtrack decodes ---------------------------------------------------
const decoded = await page.evaluate(async () => {
  const st = window.__pfState()
  const any = await st.loadSound()
  const a = window.__pfAssets.getAsset(st.doc.layers[0].assetId)
  const buf = a.audio
  if (!buf) return { any, buf: null }
  // Is there actually a signal, or a buffer full of zeroes?
  const d = buf.getChannelData(0)
  let peak = 0
  for (let i = 0; i < d.length; i += 37) peak = Math.max(peak, Math.abs(d[i]))
  return {
    any,
    channels: buf.numberOfChannels,
    rate: buf.sampleRate,
    seconds: +buf.duration.toFixed(2),
    peak: +peak.toFixed(3),
  }
})
console.log('decoded:', JSON.stringify(decoded))
check('the video has a soundtrack, and it decodes', decoded.any === true)
check('with real samples in it, not silence', decoded.peak > 0.05, `peak ${decoded.peak}`)
check('at a sensible rate and channel count',
  decoded.rate >= 8000 && decoded.channels >= 1, `${decoded.rate}Hz x${decoded.channels}`)
check('and about as long as the clip', decoded.seconds > 0.5, `${decoded.seconds}s`)

/**
 * Renders the player's own graph offline and reports loudness per 100ms.
 *
 * Rendering the real `buildGraph` rather than a stand-in is the point: a test
 * that built its own graph would prove nothing about the one that plays.
 */
const render = (opts) => page.evaluate(async (o) => {
  const st = window.__pfState()
  const doc = o.doc ? { ...st.doc, layers: o.doc } : st.doc
  const rate = 44100
  const ctx = new OfflineAudioContext(2, Math.ceil(rate * o.seconds), rate)
  window.__pfAudio.buildGraph(ctx, doc, (l) => window.__pfAssets.getAsset(l.assetId), {
    from: o.from || 0,
    when: 0,
    master: o.master == null ? 1 : o.master,
    muted: !!o.muted,
  })
  const out = await ctx.startRendering()
  const d = out.getChannelData(0)
  const per = Math.floor(rate / 10)
  const bins = []
  for (let i = 0; i + per <= d.length; i += per) {
    let sum = 0
    for (let j = 0; j < per; j += 7) sum += d[i + j] * d[i + j]
    bins.push(+Math.sqrt(sum / (per / 7)).toFixed(4))
  }
  const loud = Math.max(...bins)
  return { bins, loud, rms: +(bins.reduce((a, b) => a + b, 0) / bins.length).toFixed(4) }
}, opts)

// --- it makes a sound ------------------------------------------------------------
const plain = await render({ seconds: 1.5 })
console.log('plain:', JSON.stringify(plain.bins.slice(0, 8)), 'loudest', plain.loud)
check('playing produces sound', plain.loud > 0.02, `loudest bin ${plain.loud}`)
check('and it is sound throughout, not one click',
  plain.bins.filter((b) => b > 0.01).length > plain.bins.length * 0.7,
  `${plain.bins.filter((b) => b > 0.01).length} of ${plain.bins.length} bins`)

// --- mute is silence, not quiet ------------------------------------------------------
const silent = await render({ seconds: 1, muted: true })
console.log('muted:', JSON.stringify(silent))
check('mute is actually silent', silent.loud === 0, `loudest bin ${silent.loud}`)

const half = await render({ seconds: 1, master: 0.5 })
const ratio = half.rms / plain.rms
console.log('at half volume:', half.rms, 'against', plain.rms, 'ratio', ratio.toFixed(2))
check('the volume control scales the signal', ratio > 0.35 && ratio < 0.65,
  `${ratio.toFixed(2)}x`)

// --- a clip's sound follows its clip ---------------------------------------------------
// The claim: give the layer a clip starting at 500ms and the first half second
// must be silent, because the picture is not there either.
const clipped = await page.evaluate(() => {
  const st = window.__pfState()
  const l = st.doc.layers[0]
  // Video arrives already clipped, so this places the clip rather than creating
  // one — `makeClip` would see the clip that is already there and do nothing.
  if (l.clip) st.slideClip(l.id, 500)
  else st.makeClip(l.id, 500)
  const after = window.__pfState().doc.layers.find((x) => x.id === l.id)
  return { clip: after.clip, layers: window.__pfState().doc.layers }
})
console.log('clip:', JSON.stringify(clipped.clip))
const delayed = await render({ seconds: 1.6 })
const head = delayed.bins.slice(0, 4)
const body = delayed.bins.slice(6, 12)
console.log('with a clip at 500ms:', JSON.stringify(delayed.bins.slice(0, 14)))
check('nothing is heard before the clip starts',
  Math.max(...head) < 0.005, `loudest of the first 400ms: ${Math.max(...head)}`)
check('and it is heard once the clip has started',
  Math.max(...body) > 0.02, `loudest after it: ${Math.max(...body)}`)

// --- and it stops when the clip ends ------------------------------------------------------
const shortened = await page.evaluate(() => {
  const st = window.__pfState()
  const l = st.doc.layers.find((x) => x.clip)
  st.slideClip(l.id, 0)
  st.trimClip(l.id, 'end', 400)
  return window.__pfState().doc.layers.find((x) => x.id === l.id).clip
})
console.log('trimmed to 400ms:', JSON.stringify(shortened))
const stops = await render({ seconds: 1.2 })
console.log('after trimming:', JSON.stringify(stops.bins.slice(0, 10)))
check('the sound stops when the clip ends',
  Math.max(...stops.bins.slice(6)) < 0.005,
  `loudest after 600ms: ${Math.max(...stops.bins.slice(6))}`)
check('but it played while the clip lasted',
  Math.max(...stops.bins.slice(0, 3)) > 0.02,
  `loudest in the first 300ms: ${Math.max(...stops.bins.slice(0, 3))}`)

// --- starting partway in plays from partway in ----------------------------------------------
// Not from the beginning: scrubbing to the middle and pressing play has to pick
// up where the picture is.
const fromMid = await page.evaluate(() => {
  const st = window.__pfState()
  const id = st.doc.layers.find((x) => x.clip).id
  st.clearClip(id)
  // Re-read: the layer captured a moment ago still carries the clip that was
  // just removed, and would answer for the wrong thing.
  const l = window.__pfState().doc.layers.find((x) => x.id === id)
  const a = window.__pfAssets.getAsset(l.assetId)
  const v = window.__pfAudio.voiceFor(l, a, 700)
  const atZero = window.__pfAudio.voiceFor(l, a, 0)
  return { clip: l.clip || null, v, atZero, dur: a.audio.duration }
})
console.log('voice from 700ms:', JSON.stringify(fromMid))
check('the clip is gone before this is measured', fromMid.clip === null)
check('starting at 700ms reads 700ms into the sound',
  Math.abs(fromMid.v.offset - 0.7) < 0.05, `offset ${fromMid.v.offset}`)
check('and starting at zero reads from the beginning',
  Math.abs(fromMid.atZero.offset) < 0.01, `offset ${fromMid.atZero.offset}`)

// --- the transport drives it --------------------------------------------------------------------
const transport = await page.evaluate(async () => {
  const st = window.__pfState()
  st.setTime(0)
  st.setPlaying(true)
  await new Promise((r) => setTimeout(r, 700))
  const playing = window.__pfAudio.isPlaying()
  const clock = window.__pfAudio.currentTime()
  const docTime = window.__pfState().time
  window.__pfState().setPlaying(false)
  await new Promise((r) => setTimeout(r, 150))
  return { playing, clock: Math.round(clock || -1), docTime: Math.round(docTime), stopped: !window.__pfAudio.isPlaying() }
})
console.log('transport:', JSON.stringify(transport))
check('pressing play starts the sound', transport.playing === true)
// Playback has to advance, whichever clock is driving it. In a headless browser
// with no output device the audio context sometimes barely ticks — which is
// exactly the case the renderer has to survive, so the test allows it rather
// than pretending it cannot happen.
check('and the playhead advances while playing', transport.docTime > 200,
  `${transport.docTime}ms after 700ms`)
const audioDriving = transport.clock > 200
console.log(audioDriving ? 'audio clock drove playback' : 'audio clock stalled, frames drove it')
if (audioDriving) {
  // Audio is the clock when it is running: the picture follows it rather than
  // counting frames of its own, or the two drift and speech slides out of sync.
  check('the document follows the audio clock',
    Math.abs(transport.docTime - transport.clock) < 120,
    `document ${transport.docTime}ms against audio ${transport.clock}ms`)
} else {
  // The guard that makes that safe: a clock that stops moving must not hold the
  // playhead still, or playback freezes while claiming to play.
  check('a stalled audio clock does not freeze the playhead',
    transport.docTime > 200, `${transport.docTime}ms`)
}
check('pausing stops it', transport.stopped === true)

// --- the waveform ---------------------------------------------------------------------
// Drawing sound is for finding a moment by eye, so what matters is that the
// picture has shape: loud where the sound is loud, and not a flat line.
const peaks = await page.evaluate(async () => {
  const st = window.__pfState()
  await st.loadSound()
  const a = window.__pfAssets.getAsset(st.doc.layers[0].assetId)
  const W = window.__pfWave
  const all = W.peaksFor(a)
  const cols = W.columnsFor(a, 0, a.audio.duration * 1000, 200)
  let loud = 0
  let quiet = 1
  for (const v of cols) { if (v > loud) loud = v; if (v < quiet) quiet = v }
  return {
    buckets: all.length,
    cols: cols.length,
    loud: +loud.toFixed(3),
    quiet: +quiet.toFixed(3),
    cached: W.hasPeaks(a),
  }
})
console.log('peaks:', JSON.stringify(peaks))
check('a soundtrack reduces to a summary', peaks.buckets > 1000, `${peaks.buckets} buckets`)
check('and resamples to whatever width is asked for', peaks.cols === 200)
check('the picture has real amplitude in it', peaks.loud > 0.05, `loudest ${peaks.loud}`)
// Peaks, not averages: averaging a loud symmetric waveform tends to zero, which
// would draw silence over the loudest passage.
check('measured as peaks, so loud passages read as loud', peaks.loud > peaks.quiet,
  `${peaks.quiet} to ${peaks.loud}`)
check('and the summary is kept rather than recomputed', peaks.cached)

// A span with no sound in it says so, instead of drawing a flat line that reads
// as silence when it might mean "not decoded yet".
const beyond = await page.evaluate(() => {
  const st = window.__pfState()
  const a = window.__pfAssets.getAsset(st.doc.layers[0].assetId)
  return window.__pfWave.columnsFor(a, 1e7, 1.1e7, 50)
})
check('a span with nothing in it draws nothing', beyond === null, String(beyond))

// --- the picture matches where the sound actually is ------------------------------------
// The real claim. `beeps.mp4` is 400ms of tone then 600ms of silence, over and
// over — so the columns must be tall in the first four tenths of each second and
// flat in the rest. A waveform that is merely *present* proves nothing; one that
// lines up with the file proves it is reading the right samples.
const shape = await page.evaluate(async () => {
  const blob = await (await fetch('/test/beeps.mp4')).blob()
  const a = await window.__pfAssets.loadImageFile(
    new File([blob], 'beeps.mp4', { type: 'video/mp4' }))
  await window.__pfAudio.ensureAudio(a)
  // Ten columns per second, so each column is one tenth: four loud, six silent.
  const cols = [...window.__pfWave.columnsFor(a, 0, 4000, 40)]
  const loudIdx = []
  const quietIdx = []
  cols.forEach((v, i) => {
    const tenth = i % 10
    // The column spanning 400-500ms straddles the moment the tone stops, and a
    // column reports the loudest thing in it — so it is legitimately loud and
    // says nothing either way. Judging it would be testing the rounding.
    if (tenth < 4) loudIdx.push(v)
    else if (tenth > 4) quietIdx.push(v)
  })
  return {
    cols: cols.map((v) => +v.toFixed(2)),
    loudMin: +Math.min(...loudIdx).toFixed(2),
    quietMax: +Math.max(...quietIdx).toFixed(2),
  }
})
console.log('beeps:', JSON.stringify(shape.cols))
check('the tone shows up where the tone is', shape.loudMin > 0.5,
  `quietest loud column ${shape.loudMin}`)
check('and the gaps read as silent', shape.quietMax < 0.05,
  `loudest silent column ${shape.quietMax}`)

// And it reaches the canvas: the clip is drawn with pictures on top and sound
// along the bottom, in one row.
const drawn = await page.evaluate(async () => {
  const btn = [...document.querySelectorAll('button')].find((b) => /^Video/.test(b.textContent))
  if (btn) btn.click()
  await new Promise((r) => setTimeout(r, 1200))
  const c = document.querySelector('.strip canvas')
  if (!c) return null
  const ctx = c.getContext('2d', { willReadFrequently: true })
  const d = ctx.getImageData(0, 0, c.width, c.height).data
  // The waveform is drawn on a dark scrim along the bottom, in pale blue.
  let wave = 0
  const from = Math.floor(c.height * 0.7)
  for (let y = from; y < c.height; y++) {
    for (let x = 0; x < c.width; x++) {
      const i = (y * c.width + x) * 4
      if (d[i + 2] > 170 && d[i + 2] > d[i] + 40) wave++
    }
  }
  return { wave, w: c.width, h: c.height }
})
console.log('waveform pixels on the clip:', JSON.stringify(drawn))
check('the waveform is drawn on the clip', drawn && drawn.wave > 100,
  `${drawn?.wave} pale pixels along the bottom`)

console.log(errors.length ? 'CONSOLE ERRORS: ' + errors.slice(0, 5).join(' | ') : 'no console errors')
await browser.close()
process.exit(checks.some(([, ok]) => !ok) ? 1 : 0)
