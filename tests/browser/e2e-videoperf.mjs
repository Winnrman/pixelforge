// Video decode efficiency, and the seeks that a streaming decoder has to
// survive.
//
// Playing a long clip used to cost several times more decode work than the
// frames it displayed. Reaching a frame means decoding from the keyframe before
// it, and a decoder that restarts on every request repeats that walk over and
// over — then threw away everything it decoded before the frame it was asked
// for. On a 48,000-frame clip with a long GOP that is the difference between
// smooth playback and a stutter.
//
// The fixture has a 250-frame keyframe interval, which is what makes the waste
// measurable at all: with a keyframe every frame there is nothing to repeat.
import { chromium } from 'playwright-core'

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

const loaded = await page.evaluate(async () => {
  const buf = await (await fetch('/test/longgop.mp4')).arrayBuffer()
  window.__asset = window.__pfVideo.prewarm(
    await window.__pfVideo.loadVideo(buf, 'longgop.mp4', 'video/mp4'))
  const a = window.__asset
  // How far apart the keyframes are — the thing that makes this test mean
  // something. A short GOP would pass trivially.
  const syncs = a.video.samples.filter((s) => s.isSync).length
  return {
    frames: a.times.length,
    duration: Math.round(a.duration),
    w: a.width,
    h: a.height,
    limit: a.cache.limit,
    gop: Math.round(a.video.samples.length / Math.max(1, syncs)),
  }
})
console.log('clip:', JSON.stringify(loaded))
check('the clip loaded with its frame timing', loaded.frames > 800, `${loaded.frames} frames`)
check('and it has a long keyframe interval, or this proves nothing',
  loaded.gop >= 100, `GOP ~${loaded.gop}`)
check('the cache holds less than the whole clip', loaded.limit < loaded.frames,
  `${loaded.limit} of ${loaded.frames}`)

/**
 * Plays forward from `startMs` for `n` frames, as the render loop does.
 *
 * Arriving at `startMs` is a seek, and a seek legitimately costs a restart and a
 * keyframe walk. Measuring it as though it were playback would credit steady
 * playback with the cost of getting there, so the counters are reset once the
 * first frame is actually in hand.
 */
const play = (startMs, n) => page.evaluate(async ([from, count]) => {
  const V = window.__pfVideo
  const a = window.__asset
  const step = a.duration / a.times.length

  for (let i = 0; i < 200; i++) {
    V.ensureDecoded(a, from)
    if (a.cache.map.has(V.indexAt(a, from))) break
    await new Promise((r) => setTimeout(r, 8))
  }
  V.resetDecodeStats()

  let missing = 0
  for (let i = 0; i < count; i++) {
    const ms = from + i * step
    V.ensureDecoded(a, ms)
    if (!V.frameAt(a, ms)) missing++
    // Faster than the 33ms a real player has, so the decoder is under more
    // pressure here than in use, not less.
    await new Promise((r) => setTimeout(r, 4))
  }
  await new Promise((r) => setTimeout(r, 300))
  return { ...V.decodeStats, missing, shown: count }
}, [startMs, n])

// --- playing forward ---------------------------------------------------------------
const run = await play(0, 400)
const ratio = run.chunks / run.shown
console.log('400 frames from the start:', JSON.stringify(run), 'ratio', ratio.toFixed(2))
// The honest statement is not "chunks ≈ frames shown" — a decoder that reads
// ahead is *supposed* to be ahead, and counting its lookahead as waste would
// argue for a worse decoder. What it must not do is decode anything it does not
// keep. Before the fix, 80% of decode work was discarded.
check('nothing decoded is thrown away', run.kept / run.chunks > 0.9,
  `${((run.kept / run.chunks) * 100).toFixed(0)}% kept`)
const budget = run.shown + loaded.limit + 24
check('and it decodes what it shows plus its read-ahead, no more',
  run.chunks <= budget, `${run.chunks} chunks against a budget of ${budget}`)
// One decoder, fed forward — not one per handful of frames.
check('it does not restart the decoder as it goes', run.passes <= 3, `${run.passes} passes`)
check('and the sample table is not rescanned', run.scans === 0, `${run.scans} scans`)
check('no frame is ever blank once playing', run.missing === 0, `${run.missing} blank`)

// --- crossing a keyframe boundary ----------------------------------------------------
// A GOP boundary mid-run must not force a restart: the decoder simply keeps
// being fed, and the next keyframe arrives as an ordinary sample.
const across = await play(7000, 300)
const acrossRatio = across.chunks / across.shown
console.log('across a GOP boundary:', JSON.stringify(across), 'ratio', acrossRatio.toFixed(2))
check('crossing a keyframe boundary needs no restart', across.passes === 0,
  `${across.passes} restarts, ${acrossRatio.toFixed(2)}x`)
check('and shows every frame across it', across.missing === 0, `${across.missing} blank`)

// --- seeking ---------------------------------------------------------------------------
// A run only goes forwards, so these are the two cases that must start a new
// one, and the frame that comes back has to be the right one.
const seeks = await page.evaluate(async () => {
  const V = window.__pfVideo
  const a = window.__asset
  const at = async (ms) => {
    V.ensureDecoded(a, ms)
    for (let i = 0; i < 120; i++) {
      if (a.cache.map.has(V.indexAt(a, ms))) break
      V.ensureDecoded(a, ms)
      await new Promise((r) => setTimeout(r, 8))
    }
    return {
      want: V.indexAt(a, ms),
      got: a.cache.map.has(V.indexAt(a, ms)),
      exact: await V.exactFrame(a, ms).then((f) => !!f),
    }
  }
  const far = await at(25000)
  const back = await at(2000)
  const near = await at(2400)
  return { far, back, near }
})
console.log('seeks:', JSON.stringify(seeks))
check('a seek far forward lands on the right frame', seeks.far.got && seeks.far.exact,
  JSON.stringify(seeks.far))
check('and seeking backwards restarts cleanly', seeks.back.got && seeks.back.exact,
  JSON.stringify(seeks.back))
check('a small step forward after that still works', seeks.near.got && seeks.near.exact,
  JSON.stringify(seeks.near))

// --- the exact path still gives exact frames ---------------------------------------------
// Export depends on this: the nearest frame is fine for a scrub and wrong for a
// render. Two different times must give two different pictures.
const exact = await page.evaluate(async () => {
  const V = window.__pfVideo
  const a = window.__asset
  const shot = async (ms) => {
    const bmp = await V.exactFrame(a, ms)
    const c = new OffscreenCanvas(bmp.width, bmp.height)
    const x = c.getContext('2d', { willReadFrequently: true })
    x.drawImage(bmp, 0, 0)
    const d = x.getImageData(0, 0, bmp.width, bmp.height).data
    let sum = 0
    for (let i = 0; i < d.length; i += 4000) sum += d[i] + d[i + 1] * 3 + d[i + 2] * 7
    return { idx: V.indexAt(a, ms), sum }
  }
  return { a: await shot(1000), b: await shot(20000), again: await shot(1000) }
})
console.log('exact frames:', JSON.stringify(exact))
check('two times give two different frames', exact.a.sum !== exact.b.sum,
  `${exact.a.sum} vs ${exact.b.sum}`)
check('and asking twice gives the same frame', exact.a.sum === exact.again.sum,
  `${exact.a.sum} vs ${exact.again.sum}`)

// --- the cache stays bounded ----------------------------------------------------------
const bounded = await page.evaluate(() => ({
  size: window.__asset.cache.map.size,
  limit: window.__asset.cache.limit,
}))
console.log('cache:', JSON.stringify(bounded))
check('the cache never outgrows its budget', bounded.size <= bounded.limit,
  `${bounded.size} of ${bounded.limit}`)

console.log(errors.length ? 'CONSOLE ERRORS: ' + errors.slice(0, 5).join(' | ') : 'no console errors')
await browser.close()
process.exit(checks.some(([, ok]) => !ok) ? 1 : 0)
