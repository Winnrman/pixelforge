// Three ways the editor was making you pay for things you did not ask for.
//
// Turning the sound down moved the picture. The transport bar scrubs wherever
// you press it, which is right for the bar and wrong for the controls sitting on
// it — only the play button was excluded, so dragging the volume slider scrubbed
// the playhead to wherever the pointer was along the window. The slider lives at
// the right-hand end, so turning the volume down jumped the video to near the
// end of the timeline. Changing the volume must not move the picture.
//
// The media bin appeared before there was any media in it, so its Import button
// was a second door to the one place media comes in — a button press to arrive
// where the other button already goes.
//
// And two paragraphs of explanation sat open in the Subject panel, pushing the
// controls off the bottom of a panel whose whole job is controls.
import { chromium } from 'playwright-core'
import { importAndPlace } from './e2e-helpers.mjs'
import fs from 'fs'
import path from 'path'

const OUT = 'shots-transport'
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

// --- the bin does not exist until there is something in it ------------------------
const empty = await page.evaluate(() => ({
  pool: document.querySelectorAll('.pool').length,
  media: window.__pfState().doc.media.length,
}))
console.log('with nothing imported:', JSON.stringify(empty))
check('no media bin before there is any media', empty.pool === 0 && empty.media === 0,
  JSON.stringify(empty))

await importAndPlace(page, 'public/test/beeps.mp4', { timeout: 40000 })
await page.waitForTimeout(1200)
const filled = await page.evaluate(() => ({
  pool: document.querySelectorAll('.pool').length,
  cards: document.querySelectorAll('.pool-card').length,
}))
console.log('once there is:', JSON.stringify(filled))
check('and a bin the moment there is', filled.pool === 1 && filled.cards === 1,
  JSON.stringify(filled))
await page.screenshot({ path: path.join(OUT, '01-bin.png') })

// --- turning the volume down must not move the picture ------------------------------
await page.evaluate(() => {
  const s = window.__pfState()
  s.updateLayer(s.doc.layers[0].id, { clip: { start: 0, in: 0, out: 4000 } })
  s.setTime(300)
  s.setPlaying(true)
})
await page.waitForTimeout(900)
const before = await page.evaluate(() => ({
  t: window.__pfState().time, playing: window.__pfState().playing, v: window.__pfState().volume,
}))
console.log('playing:', JSON.stringify({ ...before, t: Math.round(before.t) }))
check('the clip is running', before.playing === true && before.t > 400, `${Math.round(before.t)}ms`)

const box = await page.locator('input.vol').boundingBox()
await page.mouse.move(box.x + box.width * 0.9, box.y + box.height / 2)
await page.mouse.down()
await page.mouse.move(box.x + box.width * 0.3, box.y + box.height / 2, { steps: 6 })
await page.mouse.up()
await page.waitForTimeout(120)
const after = await page.evaluate(() => ({
  t: window.__pfState().time, playing: window.__pfState().playing, v: window.__pfState().volume,
}))
console.log('after dragging the volume down:', JSON.stringify({ ...after, t: Math.round(after.t) }))
check('the volume actually changed', after.v < before.v - 0.2, `${before.v} -> ${after.v}`)
// Measured before the fix: 1022ms -> 4067ms and stopped, because the drag was
// read as a scrub to wherever the slider happens to sit along the window.
check('and the picture did not jump', Math.abs(after.t - before.t) < 700,
  `${Math.round(before.t)}ms -> ${Math.round(after.t)}ms`)
check('nor did playback stop', after.playing === true)

// The mute button and the readout are controls too, not places to scrub.
await page.evaluate(() => window.__pfState().setPlaying(false))
await page.evaluate(() => window.__pfState().setTime(1500))
await page.waitForTimeout(200)
const muteJump = await page.evaluate(async () => {
  const t0 = window.__pfState().time
  document.querySelector('.tl-audio .mute')?.click()
  await new Promise((r) => setTimeout(r, 250))
  return { t0: Math.round(t0), t1: Math.round(window.__pfState().time) }
})
console.log('pressing mute:', JSON.stringify(muteJump))
check('muting does not move the playhead either', muteJump.t0 === muteJump.t1,
  JSON.stringify(muteJump))

const readBox = await page.locator('.tl-readout').boundingBox()
const r0 = await page.evaluate(() => Math.round(window.__pfState().time))
await page.mouse.click(readBox.x + 6, readBox.y + readBox.height / 2)
await page.waitForTimeout(250)
const r1 = await page.evaluate(() => Math.round(window.__pfState().time))
console.log('pressing the time readout:', JSON.stringify({ r0, r1 }))
check('and neither does pressing the clock', r0 === r1, `${r0} -> ${r1}`)

// The bar itself still scrubs — that is the point of it. A real press, not a
// synthesised one: the handler takes a pointer capture, and a dispatched event
// has no pointer to capture.
const trackBox = await page.locator('.tl-main .track').boundingBox()
const t0 = await page.evaluate(() => Math.round(window.__pfState().time))
await page.mouse.click(trackBox.x + trackBox.width * 0.75, trackBox.y + trackBox.height / 2)
await page.waitForTimeout(250)
const t1 = await page.evaluate(() => Math.round(window.__pfState().time))
console.log('pressing the track:', JSON.stringify({ t0, t1 }))
check('pressing the bar itself still scrubs', Math.abs(t1 - t0) > 500, `${t0} -> ${t1}`)

// --- the Subject panel is controls, not an essay ---------------------------------------
const subject = await page.evaluate(async () => {
  const st = window.__pfState()
  st.select([st.doc.layers[0].id])
  await new Promise((r) => setTimeout(r, 500))
  const sections = [...document.querySelectorAll('.section')]
  const sec = sections.find((s) => /^Subject/.test(s.querySelector('.section-title')?.textContent || ''))
  if (!sec) return { found: false }
  return {
    found: true,
    hints: sec.querySelectorAll('.hint').length,
    infos: sec.querySelectorAll('.info .info-dot').length,
    height: Math.round(sec.getBoundingClientRect().height),
  }
})
console.log('the Subject panel:', JSON.stringify(subject))
if (subject.found) {
  // Two paragraphs of a hundred-odd words each were open in the panel. What is
  // left is the one that only appears when there is nothing cut out yet, which
  // is a state, not an explanation.
  check('the essays are behind an (i)', subject.hints <= 1, `${subject.hints} paragraphs left`)
  check('and there are (i) marks to open', subject.infos >= 2, `${subject.infos} info marks`)
}
await page.screenshot({ path: path.join(OUT, '02-subject.png') })

// --- the bin's poster is a picture, not a sliver ------------------------------------
// The poster is drawn at the canvas's measured width, and the canvas measures
// zero while the editor is hidden — which is exactly when a card first appears,
// because importing takes you to the Media tab. It drew a one-pixel-wide poster
// and, having no reason to run again, kept it: a thin white line where the
// picture should be.
const poster = await page.evaluate(async () => {
  window.__pfState().setWorkspace('editor')
  await new Promise((r) => setTimeout(r, 1200))
  const c = document.querySelector('.pool-card canvas')
  if (!c) return { found: false }
  const ctx = c.getContext('2d', { willReadFrequently: true })
  const d = ctx.getImageData(0, 0, c.width, c.height).data
  let lit = 0
  for (let i = 3; i < d.length; i += 4) if (d[i] > 8) lit++
  return {
    found: true,
    w: c.width,
    h: c.height,
    lit: Math.round((lit / (d.length / 4)) * 100),
  }
})
console.log('the poster in the bin:', JSON.stringify(poster))
check('the bin draws a poster wider than a line', poster.found && poster.w > 40,
  `${poster.w}px wide`)
check('and there is a picture in it', poster.lit > 50, `${poster.lit}% covered`)

// --- resizing the viewer must not move the picture ------------------------------------
// The bar scrubs on any held-button move that passes over it, and dragging the
// split handle downwards sweeps the pointer straight across the transport.
//
// The handle only exists when the panel has something to expand into, so the
// Video tab comes first.
await page.evaluate(async () => {
  const b = [...document.querySelectorAll('.tl-tabs button')].find((x) => /^Video/.test(x.textContent))
  if (b) b.click()
  await new Promise((r) => setTimeout(r, 900))
  window.__pfState().setPlaying(false)
  window.__pfState().setTime(1500)
})
await page.waitForTimeout(300)
const split = await page.locator('.tl-split').boundingBox()
const beforeResize = await page.evaluate(() => Math.round(window.__pfState().time))
await page.mouse.move(split.x + split.width / 2, split.y + split.height / 2)
await page.mouse.down()
await page.mouse.move(split.x + split.width / 2, split.y + 120, { steps: 8 })
await page.mouse.up()
await page.waitForTimeout(250)
const afterResize = await page.evaluate(() => Math.round(window.__pfState().time))
console.log('dragging the viewer taller:', JSON.stringify({ beforeResize, afterResize }))
check('resizing the viewer leaves the playhead alone', beforeResize === afterResize,
  `${beforeResize} -> ${afterResize}`)

// --- scrolling scales the tracks ---------------------------------------------------------
const lane = () => page.evaluate(() => {
  const clip = document.querySelector('.track-row:not(.empty) .strip')
  const rows = document.querySelector('.track-rows')
  return {
    clip: Math.round(clip?.getBoundingClientRect().width || 0),
    scrollW: Math.round(rows?.scrollWidth || 0),
    left: Math.round(rows?.scrollLeft || 0),
  }
})
const rest = await lane()
console.log('tracks at rest:', JSON.stringify(rest))
check('there is a clip on the timeline', rest.clip > 100, `${rest.clip}px`)

const rowsBox = await page.locator('.track-rows').boundingBox()
await page.mouse.move(rowsBox.x + rowsBox.width * 0.5, rowsBox.y + rowsBox.height * 0.5)
for (let i = 0; i < 5; i++) { await page.mouse.wheel(0, -120); await page.waitForTimeout(140) }
const zoomed = await lane()
console.log('after scrolling up:', JSON.stringify(zoomed))
// A second of a long clip is four pixels at rest, which is not a thing you can
// cut on. Scrolling up makes it wider.
check('scrolling up makes the tracks longer', zoomed.clip > rest.clip * 1.8,
  `${rest.clip}px -> ${zoomed.clip}px`)
check('and they scroll sideways once they are wider than the window',
  zoomed.scrollW > rest.scrollW, `${rest.scrollW} -> ${zoomed.scrollW}`)
check('keeping what was under the pointer near it', zoomed.left > 0, `scrolled ${zoomed.left}px`)
await page.screenshot({ path: path.join(OUT, '03-zoom.png') })

for (let i = 0; i < 9; i++) { await page.mouse.wheel(0, 120); await page.waitForTimeout(140) }
const back = await lane()
console.log('after scrolling back down:', JSON.stringify(back))
check('scrolling down brings them back', Math.abs(back.clip - rest.clip) < 40,
  `${back.clip}px against ${rest.clip}px`)
check('and no further than the window, which is the whole timeline',
  Math.abs(back.scrollW - rest.scrollW) < 40, `${back.scrollW} against ${rest.scrollW}`)

// --- right-clicking a clip ------------------------------------------------------------------
const menu = await page.evaluate(async () => {
  const strip = document.querySelector('.track-row:not(.empty) .strip')
  const r = strip.getBoundingClientRect()
  strip.dispatchEvent(new MouseEvent('contextmenu', {
    bubbles: true, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2,
  }))
  await new Promise((x) => setTimeout(x, 300))
  const el = document.querySelector('.ctx-menu')
  return {
    open: !!el,
    items: el ? [...el.querySelectorAll('.ctx-item')].map((b) => b.textContent.replace(/\s+/g, ' ').trim()) : [],
  }
})
console.log('right-clicking a clip:', JSON.stringify(menu.items))
check('right-clicking a clip opens a menu', menu.open)
for (const want of ['Duplicate', 'Hide', 'Delete', 'Cut at playhead', 'Mute']) {
  check(`with ${want} on it`, menu.items.some((t) => t.startsWith(want)),
    menu.items.join(' | ').slice(0, 90))
}
await page.screenshot({ path: path.join(OUT, '04-menu.png') })

const acted = await page.evaluate(async () => {
  const before = window.__pfState().doc.layers.length
  const b = [...document.querySelectorAll('.ctx-item')].find((x) => x.textContent.startsWith('Duplicate'))
  b?.click()
  await new Promise((x) => setTimeout(x, 400))
  return { before, after: window.__pfState().doc.layers.length, closed: !document.querySelector('.ctx-menu') }
})
console.log('using it:', JSON.stringify(acted))
check('and the items do what they say', acted.after === acted.before + 1,
  `${acted.before} -> ${acted.after} layers`)
check('closing the menu afterwards', acted.closed)

console.log(errors.length ? 'CONSOLE ERRORS: ' + errors.slice(0, 5).join(' | ') : 'no console errors')
await browser.close()
process.exit(checks.some(([, ok]) => !ok) ? 1 : 0)
