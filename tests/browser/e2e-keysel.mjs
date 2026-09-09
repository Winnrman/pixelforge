// Selecting several keyframes at once, and the cursor-follow camera style.
import { chromium } from 'playwright-core'
import { importAndPlace } from '../e2e-helpers.mjs'
import fs from 'fs'
import path from 'path'

const OUT = 'shots/keysel'
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

await importAndPlace(page, 'public/test/motion.gif', { timeout: 20000 })
await page.evaluate(() => { window.__pfState().setPlaying(false); window.__pfState().setTime(0) })
await page.waitForTimeout(400)

// Two tracks with keys spread across the clip, so a band can catch some of them
// in both lanes and leave the rest alone.
const built = await page.evaluate(() => {
  const st = window.__pfState()
  const id = st.doc.layers[0].id
  st.select([id])
  st.enableTrack(id, 'position')
  st.enableTrack(id, 'opacity')
  const times = [0, 200, 400, 600, 800, 1000, 1200]
  for (const t of times) {
    st.setTime(t)
    st.addKeyframe(id, 'position', t)
    st.addKeyframe(id, 'opacity', t)
  }
  st.setTime(0)
  const l = window.__pfState().doc.layers.find((x) => x.id === id)
  return {
    id,
    position: window.__pfKeys.groupKeyTimes(l, 'position'),
    opacity: window.__pfKeys.groupKeyTimes(l, 'opacity'),
  }
})
console.log('tracks:', JSON.stringify(built))
check('two tracks with several keys each', built.position.length >= 6 && built.opacity.length >= 6,
  `${built.position.length} / ${built.opacity.length}`)
await page.waitForSelector('.lane-track', { timeout: 10000 })

/** Screen point at a fraction along a lane, and a fraction down its height. */
const lanePoint = (laneIndex, frac, vy = 0.5) => page.evaluate(([i, f, v]) => {
  const el = document.querySelectorAll('.lane-track')[i]
  const r = el.getBoundingClientRect()
  return [r.left + r.width * f, r.top + r.height * v]
}, [laneIndex, frac, vy])

// --- a band across one lane ---------------------------------------------------
const a = await lanePoint(0, 0.1, 0.15)
const b = await lanePoint(0, 0.55, 0.85)
await page.mouse.move(a[0], a[1])
await page.mouse.down()
await page.mouse.move((a[0] + b[0]) / 2, b[1], { steps: 6 })
await page.mouse.move(b[0], b[1], { steps: 6 })
const during = await page.evaluate(() => !!document.querySelector('.key-marquee'))
await page.mouse.up()
await page.waitForTimeout(250)
const oneLane = await page.evaluate(() => ({
  count: window.__pfState().keySelection.length,
  groups: [...new Set(window.__pfState().keySelection.map((k) => k.groupId))],
  times: window.__pfState().keySelection.map((k) => k.t).sort((x, y) => x - y),
  marquee: !!document.querySelector('.key-marquee'),
}))
console.log('band across one lane:', JSON.stringify(oneLane))
check('dragging draws a selection band', during)
check('and it disappears when the drag ends', oneLane.marquee === false)
check('keys inside the band are selected', oneLane.count > 1 && oneLane.count < 7,
  `${oneLane.count} of 7`)
check('and only from the lane it covered', oneLane.groups.length === 1, oneLane.groups.join(','))
check('the ones outside it are left alone',
  oneLane.times.every((t) => t <= 800), oneLane.times.join(','))

const marked = await page.evaluate(() => document.querySelectorAll('.kf.sel').length)
check('selected keys are marked in the lane', marked === oneLane.count, `${marked} marked`)

// --- a band across both lanes ---------------------------------------------------
const c = await lanePoint(0, 0.05, 0.2)
const d = await lanePoint(1, 0.95, 0.8)
await page.mouse.move(c[0], c[1])
await page.mouse.down()
// A *second* band, deliberately: the first one used to leave the lane labels
// selected as text, and starting a drag on top of a text selection makes Chrome
// begin a native text drag and cancel the pointer stream mid-gesture.
await page.mouse.move((c[0] + d[0]) / 2, (c[1] + d[1]) / 2, { steps: 6 })
await page.mouse.move(d[0], d[1], { steps: 6 })
const cancelled = await page.evaluate(() => !!document.querySelector('.key-marquee'))
await page.mouse.up()
await page.waitForTimeout(250)
const bothLanes = await page.evaluate(() => ({
  count: window.__pfState().keySelection.length,
  groups: [...new Set(window.__pfState().keySelection.map((k) => k.groupId))].sort(),
}))
console.log('band across both lanes:', JSON.stringify(bothLanes))
check('a second band survives the drag', cancelled)
check('a band can span tracks', bothLanes.groups.length === 2, bothLanes.groups.join(','))
check('and takes the keys from both', bothLanes.count >= 12, `${bothLanes.count}`)
await page.screenshot({ path: path.join(OUT, '01-marquee.png') })

// --- moving them together -----------------------------------------------------
const moved = await page.evaluate((id) => {
  const st = window.__pfState()
  st.selectKeys(st.keySelection.filter((k) => k.groupId === 'position' && k.t >= 400))
  // Re-read: `st` is the snapshot from before selectKeys, so its keySelection
  // is still the whole band.
  const before = window.__pfState().keySelection.map((k) => k.t).sort((a2, b2) => a2 - b2)
  st.moveSelectedKeys(150)
  const l = window.__pfState().doc.layers.find((x) => x.id === id)
  return {
    before,
    after: window.__pfState().keySelection.map((k) => k.t).sort((a2, b2) => a2 - b2),
    track: window.__pfKeys.groupKeyTimes(l, 'position'),
  }
}, built.id)
console.log('moved by 150ms:', JSON.stringify(moved))
check('the whole selection slides together',
  moved.after.every((t, i) => t === moved.before[i] + 150),
  `${moved.before.join(',')} -> ${moved.after.join(',')}`)
// Spacing has to survive: moving them one at a time in the wrong order collapses
// an earlier key onto a later one that has not moved yet.
check('and keeps its spacing rather than collapsing',
  new Set(moved.after).size === moved.after.length, moved.after.join(','))
check('the keys that were not selected stayed put',
  moved.track.includes(0) && moved.track.includes(200), moved.track.join(','))

// --- deleting them together ----------------------------------------------------
const deleted = await page.evaluate((id) => {
  const st = window.__pfState()
  const before = window.__pfKeys.groupKeyTimes(
    st.doc.layers.find((x) => x.id === id), 'position').length
  const n = st.removeSelectedKeys()
  const l = window.__pfState().doc.layers.find((x) => x.id === id)
  return {
    removed: n,
    before,
    after: window.__pfKeys.groupKeyTimes(l, 'position').length,
    selection: window.__pfState().keySelection.length,
  }
}, built.id)
console.log('deleted:', JSON.stringify(deleted))
check('deleting removes every selected key', deleted.after === deleted.before - deleted.removed,
  `${deleted.before} -> ${deleted.after}, removed ${deleted.removed}`)
check('and clears the selection', deleted.selection === 0)

await page.evaluate(() => window.__pfState().undo())
await page.waitForTimeout(250)
const undone = await page.evaluate((id) => window.__pfKeys.groupKeyTimes(
  window.__pfState().doc.layers.find((x) => x.id === id), 'position').length, built.id)
check('one undo brings them all back', undone === deleted.before, `${undone} keys`)

// A click on empty lane space still moves the playhead and clears the selection.
await page.evaluate(() => window.__pfState().selectKeys([{ layerId: 'x', groupId: 'position', t: 0 }]))
const mid = await lanePoint(0, 0.5)
await page.mouse.click(mid[0], mid[1])
await page.waitForTimeout(250)
const clicked = await page.evaluate(() => ({
  time: Math.round(window.__pfState().time),
  duration: Math.round(window.__pfState().duration),
  selection: window.__pfState().keySelection.length,
}))
console.log('click on empty lane space:', JSON.stringify(clicked))
check('a plain click still moves the playhead',
  Math.abs(clicked.time / clicked.duration - 0.5) < 0.08,
  `${(clicked.time / clicked.duration * 100).toFixed(0)}%`)
check('and clears the selection', clicked.selection === 0)

// --- the cursor camera stays zoomed in -------------------------------------------
const camera = await page.evaluate(() => {
  const path2 = []
  for (let i = 0; i < 60; i++) {
    const t = i * 40
    let x
    let y
    if (i < 25) { x = 200 + i * 2; y = 150 + Math.sin(i * 0.4) * 4 }
    else if (i < 32) { x = 250 + (i - 25) * 90; y = 150 + (i - 25) * 50 }
    else { x = 880 + (i - 32) * 2; y = 500 + Math.cos(i * 0.3) * 4 }
    path2.push({ t, x, y, moving: true, confidence: 1 })
  }
  const at = (track, t) => {
    let v = track[0].v
    for (const k of track) if (k.t <= t) v = k.v
    return v
  }
  const out = {}
  for (const mode of ['follow', 'dwell']) {
    const r = window.__pfCursor.autoZoomTracks(path2, { mode, width: 1280, height: 720, zoom: 2 })
    out[mode] = {
      start: +at(r.zoom, 0).toFixed(2),
      drift: +at(r.zoom, 600).toFixed(2),
      flick: +at(r.zoom, 1120).toFixed(2),
      keys: r.zoom.length,
    }
  }
  return out
})
console.log('camera:', JSON.stringify(camera))
check('follow opens already zoomed in', camera.follow.start >= 1.9, String(camera.follow.start))
check('and stays there while the pointer drifts', camera.follow.drift >= 1.9,
  String(camera.follow.drift))
check('pulling out only to cross the screen', camera.follow.flick < 1.4,
  String(camera.follow.flick))
check('the dwell style is still the cautious opposite',
  camera.dwell.start <= 1.05 && camera.dwell.drift < camera.follow.drift,
  `start ${camera.dwell.start}, drift ${camera.dwell.drift}`)

console.log(errors.length ? 'CONSOLE ERRORS: ' + errors.slice(0, 5).join(' | ') : 'no console errors')
await browser.close()
process.exit(checks.some(([, ok]) => !ok) ? 1 : 0)
