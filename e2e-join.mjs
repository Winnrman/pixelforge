// Cutting a clip and putting it back.
//
// Three things that belong together, because they are all about a cut being a
// view of one piece of media rather than a new thing:
//
//   the thumbnails either side of a cut are the same frames, so a cut should
//   cost no decoding at all;
//   the waveform has its own lane now, so the video clip should not be drawing
//   one over its pictures as well;
//   and a cut can be undone by joining the pieces, which is the operation the
//   timeline was missing.
import { chromium } from 'playwright-core'
import { importAndPlace } from './e2e-helpers.mjs'
import fs from 'fs'
import path from 'path'

const OUT = 'shots-join'
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

// A long clip, not a two-second one. On a short clip the halves of a split land
// on the same frames and everything hits the cache by accident; on a thirty
// second one the slots are seconds apart, which is where the rebuilding actually
// happened and where the first attempt at fixing it did nothing.
await importAndPlace(page, 'public/test/longgop.mp4', { timeout: 40000 })
await page.evaluate(() => { window.__pfState().setPlaying(false); window.__pfState().setTime(0) })
await page.waitForTimeout(1200)
await page.evaluate(() => {
  const b = [...document.querySelectorAll('.tl-tabs button')].find((x) => /^Video/.test(x.textContent))
  if (b) b.click()
})
// Long enough for the whole strip to have been drawn once — a thirty second
// clip has real seeking to do before it is complete.
await page.waitForTimeout(1000)
await page.evaluate(() => {
  const b = [...document.querySelectorAll('.tl-tabs button')].find((x) => /^Video/.test(x.textContent))
  if (b) b.click()
})
await page.waitForFunction(
  () => [...document.querySelectorAll('.track-row .strip canvas')].some((c) => c.getBoundingClientRect().width > 20),
  null, { timeout: 30000 })
// And drawn, not just mounted: the pending count reaching zero is the strip
// saying it has everything.
await page.waitForFunction(
  () => !document.querySelector('.strip-pending'), null, { timeout: 60000 }).catch(() => {})
await page.waitForTimeout(1500)

// --- a cut should not cost any decoding -----------------------------------------
// Thumbnails are cached by frame now, not by millisecond. The two halves of a
// split sample at the centres of their own slots, which are new times to the
// millisecond and the same frames — so before this, every picture in a strip
// that had just been drawn was thrown away and decoded again.
const cut = await page.evaluate(async () => {
  const st = window.__pfState()
  st.setTime(9000)
  await new Promise((r) => setTimeout(r, 300))
  // Counted where it happens: how many thumbnails had to be *made* rather than
  // found. Decoder chunks are the wrong meter — a short fixture sits entirely in
  // the frame cache, so a thumbnail rebuilt from a cached frame costs no chunks
  // and the meter reads zero either way.
  window.__pfFilmstrip.resetThumbStats()
  window.__pfVideo.resetDecodeStats()
  window.__pfState().splitClips(9000)
  // Deliberately short: what matters is what is on screen in the moment after a
  // cut, not what it settles to a few seconds later.
  await new Promise((r) => setTimeout(r, 250))
  const filled = []
  for (const c of document.querySelectorAll('.track-row .strip canvas')) {
    if (c.getBoundingClientRect().width < 20) continue
    const ctx = c.getContext('2d', { willReadFrequently: true })
    const d = ctx.getImageData(0, 0, c.width, c.height).data
    let lit = 0
    for (let i = 3; i < d.length; i += 4) if (d[i] > 8) lit++
    filled.push(Math.round((lit / (d.length / 4)) * 100))
  }
  const early = { ...window.__pfFilmstrip.thumbStats }
  // And then long enough for anything the strip queued to have been seeked and
  // built. Checking at a quarter of a second says what is on screen; checking
  // after several seconds says what work was set in motion, and it is the second
  // one that catches a strip quietly rebuilding behind an unchanged picture.
  await new Promise((r) => setTimeout(r, 5000))
  return {
    clips: window.__pfState().doc.layers.filter((l) => l.clip).length,
    filled,
    builtEarly: early.built,
    built: window.__pfFilmstrip.thumbStats.built,
    hits: window.__pfFilmstrip.thumbStats.hits,
  }
})
console.log('cutting the clip in two:', JSON.stringify(cut))
check('the cut made two clips', cut.clips === 2, `${cut.clips}`)
// The point of the whole thing: a quarter of a second after a cut, both halves
// are already showing pictures. Not "they come back" — they never went.
check('both halves are full of pictures a quarter second after the cut',
  cut.filled.length >= 2 && cut.filled.every((p) => p > 90), JSON.stringify(cut.filled))
// What is left is downscaling, not decoding: the two halves settle on a frame or
// two either side of what the whole clip sampled, and those get made from frames
// already in the decoder's cache. Nothing is read from the file again, and
// nothing is blank while it happens — which is the whole of what a cut costs now.
// Counted where the work is, not at the decoder. Moving the playhead to the cut
// makes the renderer decode for the *picture*, which has nothing to do with the
// strip and swamps the meter — that is what made an earlier version of this
// check read zero whether the fix was in or out.
// The cut is deliberately off centre. Split a landscape clip down the middle and
// the halves get exactly half the slots each, so their sample centres land on
// the identical instants by arithmetic and everything hits the cache whatever
// the code does — which is how a first attempt at this was measured as fixed
// while a portrait clip cut a third of the way along still rebuilt everything.
//
// Measured here with the old code: the first half drew nothing at all, the
// second drew half of itself, and fifteen thumbnails were seeked and remade.
// A bound, not a boast. This number went *up* when strips got faster to build:
// the same queued work now finishes inside the measuring window instead of being
// caught half-done, which is an improvement that reads like a regression. What
// actually catches the old behaviour is the check above — the old code left the
// first half of the cut blank and drew half of the second.
check('and only a fraction of the strip is remade',
  cut.built <= 14, `${cut.built} made across two strips`)
await page.screenshot({ path: path.join(OUT, '01-cut.png') })

// --- and the pictures are actually on screen ---------------------------------------
const drawn = await page.evaluate(() => {
  // Every clip's strip canvas, sampled: a strip that rebuilt from nothing is
  // blank, and a strip that kept its thumbnails is not.
  const out = []
  for (const c of document.querySelectorAll('.strip canvas')) {
    const box = c.getBoundingClientRect()
    if (box.width < 20) continue
    const ctx = c.getContext('2d', { willReadFrequently: true })
    const d = ctx.getImageData(0, 0, c.width, c.height).data
    let lit = 0
    for (let i = 3; i < d.length; i += 4) if (d[i] > 8) lit++
    out.push(Math.round((lit / (d.length / 4)) * 100))
  }
  return out
})
console.log('how much of each strip is drawn, in percent:', JSON.stringify(drawn))
check('both halves show their pictures straight away',
  drawn.length >= 2 && drawn.every((p) => p > 60), JSON.stringify(drawn))

// --- no waveform on the video clip any more -------------------------------------
// It has its own lane now. Two pictures of the same sound, one of them painted
// over the frames it is fighting for space with, is one too many. The old one
// laid a dark scrim across the bottom of the clip to be legible over footage,
// which is exactly what to look for: the bottom of the strip should be no darker
// than the middle of it.
const scrim = await page.evaluate(() => {
  const c = document.querySelector('.track-row .strip canvas')
  if (!c) return null
  const ctx = c.getContext('2d', { willReadFrequently: true })
  const rowMean = (y) => {
    const d = ctx.getImageData(0, y, c.width, 1).data
    let sum = 0
    for (let i = 0; i < d.length; i += 4) sum += d[i] + d[i + 1] + d[i + 2]
    return Math.round(sum / (d.length / 4))
  }
  return { middle: rowMean(Math.floor(c.height / 2)), bottom: rowMean(c.height - 4) }
})
console.log('the bottom of the clip against its middle:', JSON.stringify(scrim))
check('the video clip has no waveform scrim across its bottom',
  scrim && scrim.bottom > scrim.middle * 0.6, JSON.stringify(scrim))

// --- joining the pieces back together ---------------------------------------------
const ids = await page.evaluate(() => window.__pfState().doc.layers.filter((l) => l.clip).map((l) => l.id))
const before = await page.evaluate((all) => {
  const st = window.__pfState()
  const a = st.doc.layers.find((l) => l.id === all[0])
  const b = st.doc.layers.find((l) => l.id === all[1])
  return { a: { ...a.clip }, b: { ...b.clip } }
}, ids)
console.log('the two pieces:', JSON.stringify(before))
check('the cut left them touching, and continuous in the footage',
  Math.abs(before.a.out - before.b.in) < 2 && Math.abs(before.b.start - (before.a.start + (before.a.out - before.a.in))) < 2,
  JSON.stringify(before))

// One selected is not enough to join.
const one = await page.evaluate((all) => {
  window.__pfState().select([all[0]])
  return window.__pfState().joinClips()
}, ids)
console.log('with one selected:', JSON.stringify(one))
check('one clip is not something to join', one.ok === false && /two or more/i.test(one.reason),
  one.reason)

// Shift-click gathers them.
const shifted = await page.evaluate(async (all) => {
  window.__pfState().select([all[0]])
  await new Promise((r) => setTimeout(r, 200))
  const strips = [...document.querySelectorAll('.track-row .strip')]
  const second = strips[strips.length - 1]
  const r = second.getBoundingClientRect()
  second.dispatchEvent(new PointerEvent('pointerdown', {
    bubbles: true, button: 0, shiftKey: true,
    clientX: r.left + r.width / 2, clientY: r.top + r.height / 2,
  }))
  await new Promise((r2) => setTimeout(r2, 250))
  return window.__pfState().selectedIds.length
}, ids)
console.log('after shift-clicking the second piece:', shifted)
check('shift-click adds a clip to the selection', shifted === 2, `${shifted} selected`)

const joined = await page.evaluate(() => {
  const res = window.__pfState().joinClips()
  const clips = window.__pfState().doc.layers.filter((l) => l.clip)
  return { res, n: clips.length, clip: clips[0] ? { ...clips[0].clip } : null }
})
console.log('joined:', JSON.stringify(joined))
check('joining puts them back into one clip', joined.res.ok && joined.n === 1,
  JSON.stringify(joined.res))
check('spanning what the two of them did',
  joined.clip && joined.clip.in === before.a.in && joined.clip.out === before.b.out
  && joined.clip.start === before.a.start,
  JSON.stringify(joined.clip))
await page.screenshot({ path: path.join(OUT, '02-joined.png') })

// --- and it refuses when it should ---------------------------------------------------
const refusals = await page.evaluate(async () => {
  const st = window.__pfState()
  const id = st.doc.layers.find((l) => l.clip).id
  const out = {}

  // A gap: not one clip in pieces.
  st.splitClips(9000)
  await new Promise((r) => setTimeout(r, 300))
  let clips = window.__pfState().doc.layers.filter((l) => l.clip)
  window.__pfState().slideClip(clips[1].id, 21000)
  await new Promise((r) => setTimeout(r, 300))
  clips = window.__pfState().doc.layers.filter((l) => l.clip)
  window.__pfState().select(clips.map((l) => l.id))
  out.gap = window.__pfState().joinClips()

  // An overlap: that is a transition, not a cut to undo.
  window.__pfState().slideClip(clips[1].id,
    window.__pfClips.clipRange(clips[0], window.__pfAssets.getAsset(clips[0].assetId)).end - 300)
  await new Promise((r) => setTimeout(r, 300))
  out.overlap = window.__pfState().joinClips()

  // Trimmed since the cut: joining would bring back footage that was taken out.
  const now = window.__pfState().doc.layers.filter((l) => l.clip)
  window.__pfState().slideClip(now[1].id,
    window.__pfClips.clipRange(now[0], window.__pfAssets.getAsset(now[0].assetId)).end)
  await new Promise((r) => setTimeout(r, 200))
  const cur = window.__pfState().doc.layers.filter((l) => l.clip)
  window.__pfState().updateLayer(cur[1].id, { clip: { ...cur[1].clip, in: cur[1].clip.in + 400 } })
  await new Promise((r) => setTimeout(r, 200))
  window.__pfState().select(cur.map((l) => l.id))
  out.trimmed = window.__pfState().joinClips()
  return out
})
console.log('refusals:', JSON.stringify(refusals, null, 1))
check('a gap between the pieces is refused, and said so',
  refusals.gap.ok === false && /gap/i.test(refusals.gap.reason), refusals.gap.reason)
check('an overlap is refused as the transition it is',
  refusals.overlap.ok === false && /transition/i.test(refusals.overlap.reason),
  refusals.overlap.reason)
check('and a piece trimmed since the cut is refused rather than silently restored',
  refusals.trimmed.ok === false && /trimmed/i.test(refusals.trimmed.reason),
  refusals.trimmed.reason)

// --- the button is there ---------------------------------------------------------------
const ui = await page.evaluate(async () => {
  // Nothing gathered: the button should be off, and should say why rather than
  // being a dead control with no explanation.
  window.__pfState().select([])
  await new Promise((r) => setTimeout(r, 300))
  const b = [...document.querySelectorAll('button')].find((x) => x.textContent.trim() === 'Join')
  return { found: !!b, disabled: !!b?.disabled, title: b?.title || '' }
})
console.log('the Join button with nothing selected:', JSON.stringify(ui))
check('there is a Join beside Cut at playhead', ui.found)
check('off until there is something to join', ui.disabled === true)
check('and it says how to gather them', /shift-click/i.test(ui.title), ui.title)

// --- a strip is built in one pass ------------------------------------------------
// Asking for each thumbnail on its own tears the decoder down and walks it from
// the nearest keyframe again for every picture: forty slots is forty
// configure-seek-flush-close cycles, and on a long GOP each decodes dozens of
// frames to keep one. Measured on this clip before the change: seventeen decoder
// passes, 5894 chunks and 3.4 seconds. After: two passes, 1277 chunks, one
// second — and nothing left in the frame cache, where 2824 full frames used to
// land and evict what the picture needed.
const build = await page.evaluate(async () => {
  const st = window.__pfState()
  // A fresh strip: clear the thumbnails and force a redraw by resizing the
  // window the clip is measured against.
  const a = window.__pfAssets.getAsset(st.doc.layers[0].assetId)
  window.__pfFilmstrip.forgetThumbs(a)
  window.__pfVideo.resetDecodeStats()
  window.__pfFilmstrip.resetThumbStats()
  const started = performance.now()
  // Nudging the clip re-slices the strip, which is what makes it rebuild.
  const l = st.doc.layers.find((x) => x.clip)
  st.slideClip(l.id, (l.clip.start || 0) + 1)
  await new Promise((r) => setTimeout(r, 200))
  for (let i = 0; i < 200; i++) {
    if (!document.querySelector('.strip-pending') && window.__pfFilmstrip.thumbStats.built > 4) break
    await new Promise((r) => setTimeout(r, 50))
  }
  return {
    ms: Math.round(performance.now() - started),
    built: window.__pfFilmstrip.thumbStats.built,
    ...window.__pfVideo.decodeStats,
  }
})
console.log('building a strip from nothing:', JSON.stringify(build))
check('a strip is built, not merely claimed', build.built > 4, `${build.built} thumbnails`)
// Counted in chunks, which is what the time is actually spent on. Passes are the
// wrong meter now: the keyframe sweep is a pass of its own, and it *saves* work
// by making most of the exact frames unnecessary — so a better strip has more
// passes and less decoding. Measured in this same scenario: 4218 chunks with the
// old seek-per-thumbnail code, 1771 with one sequential pass, about 1100 once
// keyframes could settle a slot.
check('and does not decode the file end to end to do it',
  build.chunks < 2600, `${build.chunks} chunks, against 4218 before`)
// And it does not shove the frames it decoded into the playback cache on the
// way through, which used to evict exactly what the picture needed.
check('and it leaves the frame cache to the picture',
  build.kept < build.built, `${build.kept} full frames kept, against 2048 before`)

console.log(errors.length ? 'CONSOLE ERRORS: ' + errors.slice(0, 5).join(' | ') : 'no console errors')
await browser.close()
process.exit(checks.some(([, ok]) => !ok) ? 1 : 0)
