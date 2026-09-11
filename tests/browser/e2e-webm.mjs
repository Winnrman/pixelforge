// WebM import, with a file the browser itself recorded.
//
// A canvas is recorded with MediaRecorder — VP9 or VP8 video with Opus sound,
// the way screen recorders and the web's own tools make WebM — so the file has
// everything a real one has: a live-stream layout with no index and no
// duration, real-time frame timing, and a sound track. Each frame carries its
// own number as a white bar along the top, so a decoded frame can be read off
// rather than guessed at.
import { chromium } from 'playwright-core'
import fs from 'fs'

const OUT = 'shots/webm'
fs.mkdirSync(OUT, { recursive: true })

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

// --- record a WebM ----------------------------------------------------------------------
const made = await page.evaluate(async () => {
  const mime = ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus'].find((m) => MediaRecorder.isTypeSupported(m))
  if (!mime) return { error: 'this browser cannot record WebM' }
  const c = document.createElement('canvas')
  c.width = 320
  c.height = 200
  const g = c.getContext('2d')
  const stream = c.captureStream(0)
  const track = stream.getVideoTracks()[0]
  const ac = new AudioContext()
  await ac.resume()
  const osc = ac.createOscillator()
  osc.frequency.value = 440
  const dest = ac.createMediaStreamDestination()
  osc.connect(dest)
  osc.start()
  stream.addTrack(dest.stream.getAudioTracks()[0])
  const rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 2_000_000 })
  const parts = []
  rec.ondataavailable = (e) => { if (e.data.size) parts.push(e.data) }
  const done = new Promise((r) => { rec.onstop = r })
  rec.start()
  const FRAMES = 50
  for (let i = 0; i < FRAMES; i++) {
    g.fillStyle = `hsl(${(i * 7) % 360} 60% 35%)`
    g.fillRect(0, 0, 320, 200)
    g.fillStyle = '#fff'
    g.fillRect(0, 0, (i + 1) * 6, 12)
    track.requestFrame()
    await new Promise((r) => setTimeout(r, 40))
  }
  await new Promise((r) => setTimeout(r, 120))
  rec.stop()
  await done
  osc.stop()
  const blob = new Blob(parts, { type: 'video/webm' })
  window.__recorded = blob
  const head = new Uint8Array(await blob.slice(0, 4).arrayBuffer())
  return { mime, bytes: blob.size, head: [...head], frames: FRAMES }
})
console.log('recorded:', JSON.stringify(made))
check('the browser recorded a WebM to try', !made.error && made.head[0] === 0x1a && made.head[1] === 0x45, made.error || made.mime)

// --- import it ------------------------------------------------------------------------------
const meta = await page.evaluate(async () => {
  const file = new File([window.__recorded], 'recording.webm', { type: 'video/webm' })
  const a = await window.__pfAssets.loadImageFile(file)
  const st = window.__pfState()
  st.placeMedia([a.id], { resizeDocToFirst: true })
  await new Promise((r) => setTimeout(r, 600))
  window.__pfState().setPlaying(false)
  window.__pfState().setTime(0)
  return {
    isVideo: !!a.isVideo, w: a.width, h: a.height, frames: a.frames.length,
    duration: Math.round(a.duration), codec: a.config.codec, type: a.type,
    docW: window.__pfState().doc.width,
  }
})
console.log('imported:', JSON.stringify(meta))
check('a WebM imports as video', meta.isVideo, meta.type)
check('its size is read from the file', meta.w === 320 && meta.h === 200 && meta.docW === 320, `${meta.w}x${meta.h}`)
check('every frame recorded is there', Math.abs(meta.frames - made.frames) <= 2, `${meta.frames} of ${made.frames}`)
check('and it runs as long as it was recorded for', meta.duration > 1500 && meta.duration < 2800, `${meta.duration}ms`)
check('decoded as the codec it was recorded in', /^vp(8|09)/.test(meta.codec), meta.codec)

/** The frame on screen at a time, read off the bar it carries. */
const frameAt = (t) => page.evaluate(async (time) => {
  const s = window.__pfState()
  s.setTime(time)
  await window.__pfRender.awaitVideo(s.doc, time)
  const c = document.createElement('canvas')
  c.width = s.doc.width
  c.height = s.doc.height
  const ctx = c.getContext('2d', { willReadFrequently: true })
  window.__pfRender.renderDocument(ctx, s.doc, time)
  const row = ctx.getImageData(0, 5, c.width, 1).data
  let bar = 0
  for (let x = 0; x < c.width; x++) if (row[x * 4] > 200 && row[x * 4 + 1] > 200 && row[x * 4 + 2] > 200) bar = x + 1
  return Math.round(bar / 6) - 1
}, t)
const seen = []
for (const t of [0, 400, 900, 1400, Math.max(0, meta.duration - 60)]) seen.push(await frameAt(t))
console.log('frames on screen:', seen.join(', '))
check('the first frame is on screen at the start', seen[0] <= 1, String(seen[0]))
check('and later frames at later times, in order', seen.every((f, i) => i === 0 || f > seen[i - 1]), seen.join())
check('through to the end of the recording', seen[seen.length - 1] >= made.frames - 4, String(seen[seen.length - 1]))
// At 40ms a frame, 900ms in is about frame 22.
check('at the right moment, not just in the right order', Math.abs(seen[2] - 22) <= 4, String(seen[2]))

// --- its sound -------------------------------------------------------------------------------
const sound = await page.evaluate(async () => {
  const s = window.__pfState()
  const a = window.__pfAssets.getAsset(s.doc.layers[0].assetId)
  const buf = await window.__pfAudio.ensureAudio(a)
  return buf ? { seconds: +buf.duration.toFixed(2), channels: buf.numberOfChannels } : null
})
console.log('sound:', JSON.stringify(sound))
check('its sound track decodes', !!sound && sound.seconds > 1, JSON.stringify(sound))

// --- the file pickers take it ------------------------------------------------------------
const accepts = await page.evaluate(() => [...document.querySelectorAll('input[type=file]')].map((i) => i.accept).filter(Boolean))
check('the import buttons offer WebM', accepts.some((a) => /\.webm/.test(a)), accepts.join(' | '))

// --- a saved project keeps it --------------------------------------------------------------
const bytes = await page.evaluate(async () => {
  const packed = await window.__pfProject.packProject(window.__pfState().doc, { time: 0, name: 'webm' })
  const b = packed instanceof Blob ? new Uint8Array(await packed.arrayBuffer()) : packed
  return Array.from(b)
})
await page.reload({ waitUntil: 'networkidle' })
const reopened = await page.evaluate(async (arr) => {
  await window.__pfState().openProject(new File([new Uint8Array(arr)], 'webm.pfz'))
  const s = window.__pfState()
  const a = window.__pfAssets.getAsset(s.doc.layers[0].assetId)
  return { isVideo: !!a?.isVideo, frames: a?.frames.length, type: a?.type }
}, bytes)
check('a saved project opens with the WebM still a WebM', reopened.isVideo && reopened.frames === meta.frames && reopened.type === 'video/webm',
  JSON.stringify(reopened))
const again = await frameAt(900)
check('and plays the same frames', Math.abs(again - seen[2]) <= 1, `${again} vs ${seen[2]}`)

if (errors.length) console.log('errors:', errors)
check('no errors on the page', errors.length === 0, errors.slice(0, 3).join(' | '))
await browser.close()
const failed = checks.filter(([, ok]) => !ok)
console.log(`\n${checks.length - failed.length}/${checks.length} passed`)
process.exit(failed.length ? 1 : 0)
