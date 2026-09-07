// MP4 export through a local ffmpeg.
//
// Runs inside Electron, because that is the only place the encoder exists — and
// in dev mode against the Vite server, so the __pf* handles are present. Every
// claim is checked by probing the file that came out, not by trusting the
// exporter's own return value.
import { _electron as electron } from 'playwright-core'
import { importAndPlace } from './e2e-helpers.mjs'
import { spawnSync } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'

const OUT = 'shots-mp4'
fs.mkdirSync(OUT, { recursive: true })
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-mp4-'))

const checks = []
const check = (name, ok, detail = '') => {
  checks.push([name, ok])
  console.log((ok ? 'PASS  ' : 'FAIL  ') + name + (detail ? '  — ' + detail : ''))
}

const FF = process.env.PF_FFMPEG || 'ffmpeg'
const haveFfmpeg = spawnSync(FF, ['-version']).status === 0
if (!haveFfmpeg) {
  console.log('ffmpeg is not on PATH — MP4 export cannot be tested here.')
  process.exit(0)
}

/** What is actually in the file, straight from ffprobe. */
function probe(file) {
  const r = spawnSync('ffprobe', [
    '-v', 'error', '-show_format', '-show_streams', '-of', 'json', file,
  ], { encoding: 'utf8', maxBuffer: 8 << 20 })
  if (r.status !== 0) return null
  const j = JSON.parse(r.stdout)
  const v = j.streams.find((s) => s.codec_type === 'video')
  const a = j.streams.find((s) => s.codec_type === 'audio')
  const [num, den] = (v?.avg_frame_rate || '0/1').split('/').map(Number)
  return {
    video: v?.codec_name || null,
    pixFmt: v?.pix_fmt || null,
    width: v?.width,
    height: v?.height,
    fps: den ? num / den : 0,
    frames: Number(v?.nb_frames || 0),
    audio: a?.codec_name || null,
    duration: Number(j.format?.duration || 0),
    bytes: Number(j.format?.size || 0),
  }
}

/** Pulls one frame out as a PNG, so the pixels can be checked rather than assumed. */
function frameBytes(file, at) {
  const out = path.join(TMP, `f-${Math.random().toString(36).slice(2, 7)}.png`)
  const r = spawnSync(FF, ['-y', '-v', 'error', '-ss', String(at), '-i', file, '-frames:v', '1', out])
  if (r.status !== 0 || !fs.existsSync(out)) return null
  return fs.readFileSync(out)
}

const PROFILE = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-profile-'))
const app = await electron.launch({
  args: ['.'],
  env: { ...process.env, PF_DEV: '1', PF_USER_DATA: PROFILE },
  timeout: 60000,
})
const page = await app.firstWindow()
const errors = []
page.on('console', (m) => { if (m.type() === 'error' && !/favicon|WebSocket/.test(m.text())) errors.push(m.text()) })
page.on('pageerror', (e) => errors.push('PAGEERROR: ' + e.message))
// An unsaved-changes prompt on teardown would otherwise race the close and
// surface as a protocol error rather than a test result.
page.on('dialog', (d) => d.dismiss().catch(() => {}))
await page.waitForLoadState('domcontentloaded')
await page.waitForFunction(() => typeof window.__pfState === 'function', { timeout: 30000 })
await page.evaluate(() => indexedDB.deleteDatabase('pixelforge'))
await page.reload({ waitUntil: 'domcontentloaded' })
await page.waitForFunction(() => typeof window.__pfState === 'function', { timeout: 30000 })
await page.waitForTimeout(600)

const ff = await page.evaluate(() => window.pixelforge.ffmpegProbe())
check('the renderer can see ffmpeg', ff.ok, ff.version || '')

const load = async (fixture) => {
  await page.evaluate(() => window.__pfState().resetDoc())
  await page.waitForTimeout(150)
  await importAndPlace(page, fixture, { timeout: 30000 })
  await page.evaluate(() => { window.__pfState().setPlaying(false); window.__pfState().setTime(0) })
  await page.waitForTimeout(700)
  return page.evaluate(() => window.__pfState().doc.layers[0].id)
}

// --- a GIF out as H.264 --------------------------------------------------------
await load('public/test/motion.gif')
const meta = await page.evaluate(() => {
  const s = window.__pfState()
  return { w: s.doc.width, h: s.doc.height, duration: Math.round(s.duration) }
})
console.log('document:', JSON.stringify(meta))

const t0 = Date.now()
const res = await page.evaluate(async (dir) => {
  const s = window.__pfState()
  return window.__pfExport.exportMP4(s.doc, { fps: 30, scale: 1, crf: 20, dir, filename: 'basic.mp4' })
}, TMP)
const took = Date.now() - t0
console.log('export returned:', JSON.stringify({ ...res, log: undefined }), `in ${took}ms`)

const basic = path.join(TMP, 'basic.mp4')
check('an MP4 was actually written', fs.existsSync(basic), basic)
const p1 = probe(basic)
console.log('probe:', JSON.stringify(p1))
check('it is H.264', p1?.video === 'h264', p1?.video)
check('in the pixel format every player can decode', p1?.pixFmt === 'yuv420p', p1?.pixFmt)
check('at the document size', p1?.width === meta.w && p1?.height === meta.h, `${p1?.width}x${p1?.height}`)
check('at the frame rate that was asked for', Math.abs(p1.fps - 30) < 0.6, p1?.fps.toFixed(2))
// 1440ms of GIF at 30fps is 43 frames; the duration must follow the source.
check('and the source duration is preserved', Math.abs(p1.duration * 1000 - meta.duration) < 120,
  `${(p1.duration * 1000).toFixed(0)}ms vs ${meta.duration}ms`)
check('the frame count matches the rate and length',
  Math.abs(p1.frames - Math.round((meta.duration / 1000) * 30)) <= 2,
  `${p1.frames} frames`)

// The picture has to be the document, not a blank canvas — the fixture's disc
// moves, so two frames a second apart must differ.
const fa = frameBytes(basic, 0.05)
const fb = frameBytes(basic, 0.9)
check('the frames have real content', fa && fa.length > 800, fa ? `${fa.length}B` : 'none')
check('and the animation is in there (two frames differ)',
  fa && fb && !fa.equals(fb), fa && fb ? `${fa.length}B vs ${fb.length}B` : 'missing')

// --- quality actually does something -------------------------------------------
await page.evaluate(async (dir) => {
  const s = window.__pfState()
  await window.__pfExport.exportMP4(s.doc, { fps: 30, crf: 14, dir, filename: 'fine.mp4' })
  await window.__pfExport.exportMP4(s.doc, { fps: 30, crf: 32, dir, filename: 'coarse.mp4' })
}, TMP)
const fine = fs.statSync(path.join(TMP, 'fine.mp4')).size
const coarse = fs.statSync(path.join(TMP, 'coarse.mp4')).size
console.log('crf 14:', fine, 'bytes · crf 32:', coarse, 'bytes')
check('a lower CRF really does produce a bigger file', fine > coarse * 1.5,
  `${fine}B vs ${coarse}B (${(fine / coarse).toFixed(1)}x)`)

// --- scale, and the even-dimension trap ----------------------------------------
// yuv420p needs even width and height. A 33% scale of 320x200 is 105.6x66 —
// odd once rounded, and ffmpeg refuses it without the trunc filter.
await page.evaluate(async (dir) => {
  const s = window.__pfState()
  await window.__pfExport.exportMP4(s.doc, { fps: 24, scale: 0.33, dir, filename: 'odd.mp4' })
}, TMP)
const podd = probe(path.join(TMP, 'odd.mp4'))
console.log('scaled:', JSON.stringify(podd))
check('an odd scale still encodes', !!podd && podd.video === 'h264')
check('by rounding to even dimensions', podd && podd.width % 2 === 0 && podd.height % 2 === 0,
  `${podd?.width}x${podd?.height}`)

// --- audio ----------------------------------------------------------------------
const vid = await load('public/test/withaudio.mp4')
const cands = await page.evaluate(() => window.__pfExport.audioCandidates(window.__pfState().doc))
console.log('audio candidates:', JSON.stringify(cands))
check('the video layer is offered as an audio source', cands.length === 1, JSON.stringify(cands))
check('and it is not flagged as retimed', cands[0] && cands[0].retimed === false)

await page.evaluate(async ({ dir, assetId }) => {
  const s = window.__pfState()
  await window.__pfExport.exportMP4(s.doc, { fps: 24, crf: 22, dir, filename: 'silent.mp4' })
  await window.__pfExport.exportMP4(s.doc, {
    fps: 24, crf: 22, dir, filename: 'sound.mp4', audioAssetId: assetId,
  })
}, { dir: TMP, assetId: cands[0].assetId })

const silent = probe(path.join(TMP, 'silent.mp4'))
const sound = probe(path.join(TMP, 'sound.mp4'))
console.log('silent:', JSON.stringify(silent))
console.log('with audio:', JSON.stringify(sound))
check('exporting without audio gives a silent file', silent && silent.audio === null, String(silent?.audio))
check('exporting with audio muxes a real audio stream', sound && sound.audio === 'aac', String(sound?.audio))
check('and the video is still there alongside it', sound?.video === 'h264', String(sound?.video))
check('the two are the same length',
  sound && Math.abs(sound.duration - silent.duration) < 0.25,
  `${sound?.duration.toFixed(2)}s vs ${silent?.duration.toFixed(2)}s`)

// A retimed layer must be flagged, because its original sound would drift.
const retimed = await page.evaluate((id) => {
  const s = window.__pfState()
  s.updateLayer(id, { speed: 2 })
  return window.__pfExport.audioCandidates(window.__pfState().doc)
}, vid)
console.log('after retiming:', JSON.stringify(retimed))
check('retiming a layer flags its audio as unusable', retimed[0]?.retimed === true)

// --- a failing encode must surface ffmpeg's reason, not hang ---------------------
// The streaming path is the risky one: if a spawn dies the renderer is sitting
// on an awaited write, and a lost rejection would look exactly like a freeze.
const failure = await page.evaluate(async () => {
  const started = performance.now()
  try {
    const enc = await window.__pfDesktop.encoder(['-y', '-f', 'image2pipe', '-i', '-', '-c:v', 'no_such_codec', 'x.mp4'])
    await enc.write(new Uint8Array([1, 2, 3, 4]).buffer).catch(() => {})
    await enc.finish()
    return { threw: false, ms: Math.round(performance.now() - started) }
  } catch (err) {
    return { threw: true, message: String(err.message).slice(0, 160), ms: Math.round(performance.now() - started) }
  }
})
console.log('bad encode:', JSON.stringify(failure))
check('a broken encode rejects instead of hanging', failure.threw && failure.ms < 15000, `${failure.ms}ms`)
check('and the message says what ffmpeg complained about',
  /codec|ffmpeg|exited/i.test(failure.message || ''), failure.message)

await page.screenshot({ path: path.join(OUT, '01-mp4.png') })
console.log(errors.length ? 'CONSOLE ERRORS: ' + errors.slice(0, 5).join(' | ') : 'no console errors')
// The document is dirty, and an unsaved-changes prompt on teardown races the
// close and surfaces as a protocol error rather than a test failure.
await page.evaluate(() => window.__pfStore.useStore.setState({ dirty: false }))
await app.close().catch(() => {})
fs.rmSync(TMP, { recursive: true, force: true })
process.exit(checks.some(([, ok]) => !ok) ? 1 : 0)
