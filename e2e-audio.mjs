// Audio playback.
//
// You cannot listen to a test, so this renders the same graph the player builds
// through an OfflineAudioContext and measures the samples that come out. That is
// the only way to establish the claims that matter — that a mute is actually
// silent, that a trimmed clip's sound really starts where the picture does, and
// that a clip stops when it ends rather than running on.
import { chromium } from 'playwright-core'
import { importAndPlace } from './e2e-helpers.mjs'

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
check('the audio clock is running', transport.clock > 200, `${transport.clock}ms`)
// Audio is the clock: the picture follows it rather than counting frames of its
// own, or the two drift and speech slides out of sync with the mouth.
check('and the document time follows the audio clock',
  Math.abs(transport.docTime - transport.clock) < 120,
  `document ${transport.docTime}ms against audio ${transport.clock}ms`)
check('pausing stops it', transport.stopped === true)

console.log(errors.length ? 'CONSOLE ERRORS: ' + errors.slice(0, 5).join(' | ') : 'no console errors')
await browser.close()
process.exit(checks.some(([, ok]) => !ok) ? 1 : 0)
