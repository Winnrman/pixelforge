// Everything that hangs off a subject cutout: text behind the subject, sticker
// borders, motion trails, and the retro palettes.
//
// The fixture is the green-screen GIF — a warm disc travelling a known circular
// path over a noisy green field — so every claim here is checked against pixels
// at coordinates the fixture guarantees, not by eyeballing a screenshot.
import { chromium } from 'playwright-core'
import { importAndPlace } from '../e2e-helpers.mjs'
import fs from 'fs'
import path from 'path'

const OUT = 'shots/subject'
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

// The fixture's own geometry, so expectations are derived rather than guessed.
const disc = (t) => {
  const u = ((t / 1440) % 1 + 1) % 1
  return { x: 160 + Math.cos(u * Math.PI * 2) * 90, y: 100 + Math.sin(u * Math.PI * 2) * 55, r: 34 }
}

await importAndPlace(page, 'public/test/greenscreen.gif', { timeout: 20000 })
await page.evaluate(() => { window.__pfState().setPlaying(false); window.__pfState().setTime(0) })
await page.waitForTimeout(400)

/** Renders the document off-screen and reads one pixel. */
const px = (x, y, t = 0) => page.evaluate(([x, y, t]) => {
  const s = window.__pfState()
  const c = document.createElement('canvas')
  c.width = s.doc.width
  c.height = s.doc.height
  const ctx = c.getContext('2d', { willReadFrequently: true })
  window.__pfRender.renderDocument(ctx, s.doc, t)
  const d = ctx.getImageData(Math.round(x), Math.round(y), 1, 1).data
  return [d[0], d[1], d[2], d[3]]
}, [x, y, t])

/** Renders once and reduces the whole frame with a function evaluated in-page. */
const reduce = (t, fnBody) => page.evaluate(([t, body]) => {
  const s = window.__pfState()
  const c = document.createElement('canvas')
  c.width = s.doc.width
  c.height = s.doc.height
  const ctx = c.getContext('2d', { willReadFrequently: true })
  window.__pfRender.renderDocument(ctx, s.doc, t)
  const img = ctx.getImageData(0, 0, c.width, c.height)
  // eslint-disable-next-line no-new-func
  return new Function('img', body)(img)
}, [t, fnBody])

const layerId = await page.evaluate(() => window.__pfState().doc.layers[0].id)

// --- the cutout itself --------------------------------------------------------
await page.evaluate((id) => {
  const s = window.__pfState()
  s.updateLayer(id, {
    bgRemove: { ...window.__pfMatte.defaultBgRemove(), on: true, mode: 'auto', tolerance: 40 },
  })
  s.setDoc({ background: 'transparent' })
}, layerId)
await page.waitForTimeout(300)

const d0 = disc(0)
const onSubject = await px(d0.x, d0.y, 0)
const onBackdrop = await px(20, 20, 0)
console.log('subject px', JSON.stringify(onSubject), 'backdrop px', JSON.stringify(onBackdrop))
check('the colour key keeps the subject', onSubject[3] > 200 && onSubject[0] > 150, `alpha ${onSubject[3]}, red ${onSubject[0]}`)
check('and clears the background to transparent', onBackdrop[3] < 40, `alpha ${onBackdrop[3]}`)

// --- text behind the subject ---------------------------------------------------
// The whole trick is occlusion: a band of text across the disc must be hidden
// where the disc is and visible where it is not.
const before = await page.evaluate(() => window.__pfState().doc.layers.length)
const textId = await page.evaluate((id) => window.__pfState().textBehindSubject(id), layerId)
check('text-behind refuses nothing and returns a text layer', !!textId)

const structure = await page.evaluate(() => {
  const ls = window.__pfState().doc.layers
  return {
    count: ls.length,
    types: ls.map((l) => l.type),
    bg: ls.filter((l) => l.type === 'image').map((l) => !!l.bgRemove?.on),
    grouped: ls.filter((l) => l.type !== 'group').every((l) => !!l.parentId),
  }
})
console.log('structure:', JSON.stringify(structure))
check('it builds group + backdrop + text + cutout', structure.count === before + 3, `${before} -> ${structure.count}`)
check('the lower copy keeps its background, the upper one is cut out',
  JSON.stringify(structure.bg) === '[false,true]', JSON.stringify(structure.bg))
check('all three are grouped so they move together', structure.grouped)

// Put the text in a known band, in a colour nothing else in the frame uses.
await page.evaluate(([id]) => {
  const s = window.__pfState()
  s.updateLayer(id, {
    text: 'BEHIND THE SUBJECT NOW', x: 0, y: 84, w: 320, h: 40,
    size: 34, align: 'center', color: '#0000ff', strokeWidth: 0,
    // The show-through outline is on by default now and deliberately draws the
    // letters' edges over the subject. This check is about the fill being
    // hidden; the outline has its own coverage in e2e-text.
    outlineAbove: false,
  })
  s.setDoc({ background: '#ffffff' })
}, [textId])
await page.waitForTimeout(300)

// A ring of samples around the disc centre: inside must never be blue.
const occl = await reduce(0, `
  const d = img.data, W = img.width
  let blueInside = 0, blueOutside = 0
  const cx = 250, cy = 100, r = 34
  for (let y = 84; y < 124; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4
      const isBlue = d[i] < 90 && d[i + 1] < 90 && d[i + 2] > 150
      if (!isBlue) continue
      if (Math.hypot(x - cx, y - cy) < r - 4) blueInside++
      else blueOutside++
    }
  }
  return { blueInside, blueOutside }
`)
console.log('text pixels:', JSON.stringify(occl))
check('the text is visible outside the subject', occl.blueOutside > 200, `${occl.blueOutside} px`)
check('and completely hidden behind the subject', occl.blueInside === 0, `${occl.blueInside} px inside the disc`)
await page.screenshot({ path: path.join(OUT, '01-text-behind.png') })

// --- a cut-out must be identifiable in the layer list ----------------------------
// Two copies of one photo, one masked, previously produced two identical rows
// with identical names — the whole point of text-behind is that they differ.
const rows = await page.evaluate(() => {
  // Each row's thumbnail is a picture of the layer now, so the two copies are
  // told apart by what they *draw* rather than by which icon they were handed.
  // A stronger claim than the one this used to make: the cut-out row has to
  // actually show the cut-out.
  const opaque = (cv) => {
    if (!cv) return null
    const g = cv.getContext('2d', { willReadFrequently: true })
    const d = g.getImageData(0, 0, cv.width, cv.height).data
    let n = 0
    for (let i = 3; i < d.length; i += 4) if (d[i] > 128) n++
    return n / (cv.width * cv.height)
  }
  return [...document.querySelectorAll('.layer-list .layer')].map((row) => ({
    name: row.querySelector('.layer-name')?.textContent || row.textContent.trim().slice(0, 40),
    badge: row.querySelector('.badge')?.textContent.trim(),
    filled: opaque(row.querySelector('.thumb.pic canvas')),
  }))
})
console.log('layer rows:', JSON.stringify(rows))
const cutRows = rows.filter((r) => r.badge === 'CUT')
const plainRows = rows.filter((r) => r.badge === 'IMG')
check('the badge says CUT rather than IMG', cutRows.length === 1, JSON.stringify(rows))
check('and the untouched copy still says IMG', plainRows.length === 1,
  JSON.stringify(rows.map((r) => r.badge)))
check('both rows draw their own picture',
  cutRows[0]?.filled > 0 && plainRows[0]?.filled > 0,
  `${cutRows[0]?.filled} vs ${plainRows[0]?.filled}`)
// The whole point of text-behind is that the two copies differ, and here that is
// visible: one is the photograph, the other is what survived the key.
check('and the cut-out one is visibly less of a picture than the whole frame',
  cutRows[0]?.filled < plainRows[0]?.filled * 0.9,
  `${cutRows[0]?.filled} vs ${plainRows[0]?.filled}`)

// It has to follow the layer's state, not be drawn once and kept.
const follows = await page.evaluate(async () => {
  const s = window.__pfState()
  const cut = s.doc.layers.find((l) => l.type === 'image' && l.bgRemove?.on)
  const row = () => {
    const r = [...document.querySelectorAll('.layer-list .layer')]
      // The bracketed word, not the loose one: the group above is called "Text
      // behind subject" and would be found first.
      .find((n) => /\(subject\)/.test(n.querySelector('.layer-name')?.textContent || ''))
    const cv = r?.querySelector('.thumb.pic canvas')
    if (!cv) return { badge: null, filled: null }
    const g = cv.getContext('2d', { willReadFrequently: true })
    const d = g.getImageData(0, 0, cv.width, cv.height).data
    let n = 0
    for (let i = 3; i < d.length; i += 4) if (d[i] > 128) n++
    return {
      badge: r.querySelector('.badge')?.textContent.trim(),
      filled: n / (cv.width * cv.height),
    }
  }
  const on = row()
  s.updateLayer(cut.id, { bgRemove: { ...cut.bgRemove, on: false } })
  await new Promise((r) => setTimeout(r, 400))
  const off = row()
  window.__pfState().updateLayer(cut.id, { bgRemove: { ...cut.bgRemove, on: true } })
  await new Promise((r) => setTimeout(r, 400))
  return {
    on,
    off,
    back: row(),
  }
})
console.log('the row follows the matte:', JSON.stringify(follows))
check('turning the matte off puts the whole picture back in the row',
  follows.off.badge === 'IMG' && follows.off.filled > follows.on.filled * 2,
  JSON.stringify(follows))
check('and turning it back on cuts it out again',
  follows.back.badge === 'CUT' && follows.back.filled < follows.off.filled * 0.9,
  JSON.stringify(follows))

// --- trim to the subject --------------------------------------------------------
// The whole point is that the layer box shrinks to the matte while the subject
// stays exactly where it was on screen. So the check is a pixel comparison of
// the rendered document before and after: identical output, smaller layer.
const trimmed = await page.evaluate(() => {
  const s = window.__pfState()
  const id = s.doc.layers.find((l) => l.type === 'image' && l.bgRemove?.on).id
  const shoot = () => {
    const st = window.__pfState()
    const c = document.createElement('canvas')
    c.width = st.doc.width
    c.height = st.doc.height
    const ctx = c.getContext('2d', { willReadFrequently: true })
    window.__pfRender.renderDocument(ctx, st.doc, 0)
    return ctx.getImageData(0, 0, c.width, c.height)
  }
  const before = shoot()
  const l0 = window.__pfState().doc.layers.find((l) => l.id === id)
  const box0 = { x: l0.x, y: l0.y, w: l0.w, h: l0.h }
  window.__pfState().trimToSubject(id)
  const after = shoot()
  const l1 = window.__pfState().doc.layers.find((l) => l.id === id)

  let diff = 0
  let subjectPixels = 0
  for (let i = 0; i < before.data.length; i += 4) {
    if (before.data[i + 3] > 20) subjectPixels++
    for (let k = 0; k < 4; k++) {
      if (Math.abs(before.data[i + k] - after.data[i + k]) > 2) { diff++; break }
    }
  }
  return {
    box0: [Math.round(box0.x), Math.round(box0.y), Math.round(box0.w), Math.round(box0.h)],
    box1: [Math.round(l1.x), Math.round(l1.y), Math.round(l1.w), Math.round(l1.h)],
    src: l1.src,
    diff,
    subjectPixels,
    total: before.data.length / 4,
  }
})
console.log('trim:', JSON.stringify(trimmed))
check('the layer box shrinks', trimmed.box1[2] < trimmed.box0[2] && trimmed.box1[3] < trimmed.box0[3],
  `${trimmed.box0.join(',')} -> ${trimmed.box1.join(',')}`)
check('it moves off the origin to follow the subject',
  trimmed.box1[0] > 0 || trimmed.box1[1] > 0, trimmed.box1.slice(0, 2).join(','))
check('a source window is set rather than pixels being baked', !!trimmed.src && trimmed.src.w < 1)
// A handful of pixels can differ from resampling at a new scale; anything more
// means the subject moved.
check('and the subject does not move on screen',
  trimmed.diff < trimmed.total * 0.005,
  `${trimmed.diff} of ${trimmed.total} pixels differ (${(trimmed.diff / trimmed.total * 100).toFixed(2)}%)`)

// Undo has to bring the whole frame back — the trim is a crop, not a bake.
// Checked immediately, before anything else touches the history.
const undone = await page.evaluate(() => {
  const s = window.__pfState()
  s.undo()
  const l = window.__pfState().doc.layers.find((x) => x.type === 'image' && x.bgRemove?.on)
  return { w: Math.round(l.w), h: Math.round(l.h), x: Math.round(l.x), src: l.src || null }
})
console.log('after undo:', JSON.stringify(undone))
check('undo restores the full frame', undone.w === 320 && undone.h === 200 && undone.x === 0,
  `${undone.w}x${undone.h} at ${undone.x}`)
check('and clears the source window with it', !undone.src || undone.src.w === 1,
  JSON.stringify(undone.src))

// An image layer with no matte must be refused, not silently mangled. The
// backdrop copy from text-behind is exactly that: an image with bgRemove off.
const refusedTrim = await page.evaluate(() => {
  const s = window.__pfState()
  const plain = s.doc.layers.find((l) => l.type === 'image' && !l.bgRemove?.on)
  if (!plain) return 'no unmatted image layer to test with'
  const before = { w: plain.w, h: plain.h }
  s.trimToSubject(plain.id)
  const after = window.__pfState().doc.layers.find((l) => l.id === plain.id)
  return {
    notice: window.__pfState().notice?.text,
    unchanged: after.w === before.w && after.h === before.h,
  }
})
console.log('trim without a matte:', JSON.stringify(refusedTrim))
// The message names both routes now, since a lasso mask trims just as well as
// a removed background does.
check('trimming an image with nothing cut out explains both ways to fix it',
  /remove the background/i.test(refusedTrim.notice || '')
  && /lasso/i.test(refusedTrim.notice || ''), refusedTrim.notice)
check('and leaves the layer untouched', refusedTrim.unchanged === true)
await page.screenshot({ path: path.join(OUT, '05-trim.png') })

// --- sticker ------------------------------------------------------------------
// Reset to a single plain layer so the sticker is measured on its own.
await page.evaluate(() => window.__pfState().resetDoc())
await page.waitForTimeout(200)
await importAndPlace(page, 'public/test/greenscreen.gif', { timeout: 20000 })
const id2 = await page.evaluate(() => {
  const s = window.__pfState()
  const id = s.doc.layers[0].id
  s.setPlaying(false)
  s.setTime(0)
  s.setDoc({ background: '#ffffff' })
  s.updateLayer(id, {
    bgRemove: { ...window.__pfMatte.defaultBgRemove(), on: true, mode: 'auto', tolerance: 40 },
  })
  return id
})
await page.waitForTimeout(300)

await page.evaluate((id) => {
  const s = window.__pfState()
  s.toggleSticker(id, true)
  // `s` is a snapshot taken before the toggle, so `on` is set explicitly here
  // rather than spread from a stale layer.
  s.updateLayer(id, { sticker: { on: true, outline: 10, color: '#ff00ff', shadow: 0, shadowY: 0 } })
}, id2)
await page.waitForTimeout(300)

const band = await reduce(0, `
  const d = img.data, W = img.width
  const cx = 250, cy = 100
  const at = (rad) => {
    let hits = 0, n = 0
    for (let a = 0; a < 360; a += 3) {
      const x = Math.round(cx + Math.cos(a * Math.PI / 180) * rad)
      const y = Math.round(cy + Math.sin(a * Math.PI / 180) * rad)
      if (x < 0 || y < 0 || x >= W || y >= img.height) continue
      const i = (y * W + x) * 4
      n++
      if (d[i] > 200 && d[i + 1] < 90 && d[i + 2] > 200) hits++
    }
    return n ? hits / n : 0
  }
  return { inside: at(20), ring: at(38), outside: at(52) }
`)
console.log('magenta coverage by radius:', JSON.stringify(band))
check('the sticker border rings the subject', band.ring > 0.85, `${(band.ring * 100).toFixed(0)}% of the ring at r=38`)
check('it does not bleed over the artwork', band.inside === 0, `${(band.inside * 100).toFixed(0)}% at r=20`)
check('and it stops at the border width', band.outside < 0.05, `${(band.outside * 100).toFixed(0)}% at r=52`)

// Registration: growing the canvas for the border must not shift the subject.
const centre = await px(250, 100, 0)
check('the subject stays exactly where it was', centre[0] > 150 && centre[1] < 130, JSON.stringify(centre))
await page.screenshot({ path: path.join(OUT, '02-sticker.png') })

// --- motion trails --------------------------------------------------------------
await page.evaluate((id) => {
  const s = window.__pfState()
  s.toggleSticker(id, false)
  s.toggleTrails(id, true)
  s.updateLayer(id, { trails: { on: true, count: 4, gapMs: 120, fade: 0.65, scale: 1 } })
}, id2)
await page.waitForTimeout(300)

const T = 600
const withTrails = await reduce(T, `
  const d = img.data
  let subject = 0
  for (let i = 0; i < d.length; i += 4) if (d[i] > 150 && d[i + 1] < 140 && d[i + 3] > 20) subject++
  return subject
`)
await page.evaluate((id) => window.__pfState().toggleTrails(id, false), id2)
await page.waitForTimeout(250)
const withoutTrails = await reduce(T, `
  const d = img.data
  let subject = 0
  for (let i = 0; i < d.length; i += 4) if (d[i] > 150 && d[i + 1] < 140 && d[i + 3] > 20) subject++
  return subject
`)
console.log('subject-coloured pixels — trails on:', withTrails, 'off:', withoutTrails)
// 4 echoes at 65% fade are 0.65 / 0.42 / 0.27 / 0.18 opacity, and the faintest
// two blend far enough toward the white backdrop to fall out of this predicate,
// so the measured gain is ~1.6x rather than 4x. The per-pixel probe below is
// the exact check; this one only asserts the echoes are substantial.
check('trails add echoes of the subject', withTrails > withoutTrails * 1.4,
  `${withoutTrails} -> ${withTrails} px (${(withTrails / withoutTrails).toFixed(2)}x)`)

// The echoes must sit at *earlier* positions on the known path, and be fainter.
await page.evaluate((id) => window.__pfState().toggleTrails(id, true), id2)
await page.waitForTimeout(250)
const echoPos = disc(T - 120)
const nowPos = disc(T)
const echo = await px(echoPos.x, echoPos.y, T)
const now = await px(nowPos.x, nowPos.y, T)
console.log('echo at', [Math.round(echoPos.x), Math.round(echoPos.y)], JSON.stringify(echo),
  'current at', [Math.round(nowPos.x), Math.round(nowPos.y)], JSON.stringify(now))
check('an echo is drawn at the position one gap ago', echo[0] > 150 && echo[1] < 150, JSON.stringify(echo))
// Against white, a faded echo reads lighter than the solid subject.
check('the echo is fainter than the subject', echo[1] > now[1] + 20, `green ${echo[1]} vs ${now[1]}`)

// Trails must not run before the timeline starts.
const atZero = await reduce(0, `
  const d = img.data
  let subject = 0
  for (let i = 0; i < d.length; i += 4) if (d[i] > 150 && d[i + 1] < 140 && d[i + 3] > 20) subject++
  return subject
`)
check('no echoes exist before the clip starts', Math.abs(atZero - withoutTrails) < withoutTrails * 0.25,
  `${atZero} at t=0 vs ${withoutTrails} with trails off`)
await page.screenshot({ path: path.join(OUT, '03-trails.png') })

// --- retro palettes ---------------------------------------------------------------
await page.evaluate((id) => {
  const s = window.__pfState()
  s.toggleTrails(id, false)
  s.updateLayer(id, {
    bgRemove: { ...window.__pfMatte.defaultBgRemove(), on: false },
    retro: { on: true, preset: 'gameboy', opts: window.__pfRetro.retroDefaults('gameboy') },
  })
}, id2)
await page.waitForTimeout(400)

const gb = await reduce(0, `
  const d = img.data, W = img.width
  const DMG = ['15,56,15', '48,98,48', '139,172,15', '155,188,15']
  const seen = new Set()
  let off = 0, n = 0
  for (let y = 10; y < img.height - 10; y++) {
    for (let x = 10; x < W - 10; x++) {
      const i = (y * W + x) * 4
      if (d[i + 3] < 250) continue
      n++
      const k = d[i] + ',' + d[i + 1] + ',' + d[i + 2]
      seen.add(k)
      if (!DMG.includes(k)) off++
    }
  }
  return { distinct: seen.size, off, n, sample: [...seen].slice(0, 6) }
`)
console.log('Game Boy:', JSON.stringify(gb))
// Four is the ceiling, not the floor: this fixture is a flat green field and one
// warm disc, so its luminance range only reaches a couple of the DMG steps.
// What matters is that nothing lands off-palette.
check('the Game Boy look uses at most the four DMG greens',
  gb.distinct >= 2 && gb.distinct <= 4, `${gb.distinct} distinct: ${gb.sample.join(' / ')}`)
check('and every pixel is a DMG green', gb.off === 0, `${gb.off} off-palette of ${gb.n}`)

await page.evaluate((id) => window.__pfState().updateLayer(id, {
  retro: { on: true, preset: 'dither1bit', opts: window.__pfRetro.retroDefaults('dither1bit') },
}), id2)
await page.waitForTimeout(300)
const bw = await reduce(0, `
  const d = img.data, W = img.width
  const seen = new Set()
  for (let y = 10; y < img.height - 10; y++) {
    for (let x = 10; x < W - 10; x++) {
      const i = (y * W + x) * 4
      if (d[i + 3] < 250) continue
      seen.add(d[i] + ',' + d[i + 1] + ',' + d[i + 2])
    }
  }
  return [...seen]
`)
console.log('1-bit distinct colours:', JSON.stringify(bw))
check('1-bit dither leaves exactly two colours', bw.length === 2, bw.join(' / '))

// The look must survive a render at a different time, i.e. the cache is keyed
// on the frame and not simply held from the first render.
await page.evaluate(() => window.__pfState().setTime(720))
await page.waitForTimeout(250)
const bw2 = await reduce(720, `
  const d = img.data, W = img.width
  const seen = new Set()
  for (let y = 10; y < img.height - 10; y++) {
    for (let x = 10; x < W - 10; x++) {
      const i = (y * W + x) * 4
      if (d[i + 3] < 250) continue
      seen.add(d[i] + ',' + d[i + 1] + ',' + d[i + 2])
    }
  }
  return [...seen]
`)
check('and on a later frame too', bw2.length === 2, bw2.join(' / '))
await page.screenshot({ path: path.join(OUT, '04-retro.png') })

console.log(errors.length ? 'CONSOLE ERRORS: ' + errors.slice(0, 5).join(' | ') : 'no console errors')
await browser.close()
process.exit(checks.some(([, ok]) => !ok) ? 1 : 0)
