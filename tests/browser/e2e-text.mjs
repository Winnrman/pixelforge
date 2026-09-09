// Text: fonts, a box that fits what is in it, editing in place, and keeping the
// outline visible where something covers the letters.
import { chromium } from 'playwright-core'
import { importAndPlace } from '../e2e-helpers.mjs'
import fs from 'fs'
import path from 'path'

const OUT = 'shots/text'
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

await importAndPlace(page, 'public/test/greenscreen.gif', { timeout: 20000 })
await page.evaluate(() => { window.__pfState().setPlaying(false); window.__pfState().setTime(0) })
await page.waitForTimeout(400)

// --- fonts -----------------------------------------------------------------------
const fonts = await page.evaluate(() => {
  const F = window.__pfFonts
  return {
    all: F.FONT_CHOICES.length,
    available: F.availableFonts().length,
    labels: F.availableFonts().map((f) => f.label),
    // Availability is measured, not assumed: a family nobody has must be absent.
    bogus: F.isInstalled('NoSuchFontFamilyAnywhere12345'),
    real: F.isInstalled('Arial'),
  }
})
console.log('fonts:', JSON.stringify({ ...fonts, labels: fonts.labels.slice(0, 8) }))
check('a font list is offered', fonts.available >= 8, `${fonts.available} of ${fonts.all}`)
check('and only fonts that are actually installed', fonts.bogus === false && fonts.real === true,
  `bogus ${fonts.bogus}, Arial ${fonts.real}`)
check('including the heavy poster faces', fonts.labels.some((l) => /Impact|Arial Black/.test(l)),
  fonts.labels.join(', '))

// Choosing one must change what is drawn, not just what is stored.
const textId = await page.evaluate(() => {
  const st = window.__pfState()
  const { makeTextLayer } = window.__pfStore
  const l = st.addLayer(makeTextLayer({ text: 'HELLO', size: 48, x: 20, y: 20, color: '#ffffff' }))
  return l.id
})
await page.waitForTimeout(250)
const fontEffect = await page.evaluate((id) => {
  const st = window.__pfState()
  const widths = {}
  for (const f of ['Arial, system-ui, sans-serif', '"Courier New", Consolas, monospace']) {
    st.setText(id, { font: f })
    widths[f] = Math.round(window.__pfState().doc.layers.find((l) => l.id === id).w)
  }
  return widths
}, textId)
console.log('measured width per font:', JSON.stringify(fontEffect))
check('changing the font changes the measured text',
  new Set(Object.values(fontEffect)).size === 2, JSON.stringify(fontEffect))

// The menu has to be a specimen sheet: reading the word "Consolas" set in the UI
// font tells you nothing about what you are choosing.
await page.evaluate((id) => window.__pfState().select([id]), textId)
await page.waitForTimeout(300)
const specimen = await page.evaluate(() => {
  const rows = [...document.querySelectorAll('.inspector select')]
  const fontSel = rows.find((sel) => [...sel.options].some((o) => /Arial Black|Impact/.test(o.textContent)))
  if (!fontSel) return null
  const opts = [...fontSel.options].slice(0, 6).map((o) => ({
    label: o.textContent,
    family: o.style.fontFamily,
  }))
  return {
    opts,
    // The closed control shows the selected family too, so the current font is
    // visible without opening the menu.
    selectFamily: fontSel.style.fontFamily,
    distinct: new Set([...fontSel.options].map((o) => o.style.fontFamily)).size,
    count: fontSel.options.length,
  }
})
console.log('font menu:', JSON.stringify(specimen))
check('the font menu exists', !!specimen && specimen.count >= 8, String(specimen?.count))
check('every entry is set in its own family',
  specimen.opts.every((o) => o.family && o.family.length > 2),
  specimen.opts.map((o) => `${o.label}=${o.family.split(',')[0]}`).join(' '))
check('and they are genuinely different families',
  specimen.distinct === specimen.count, `${specimen.distinct} of ${specimen.count}`)
check('the closed control shows the chosen one', !!specimen.selectFamily, specimen.selectFamily)

// --- the box fits the text ---------------------------------------------------------
const fit = await page.evaluate((id) => {
  const st = window.__pfState()
  st.setText(id, { font: 'Arial, system-ui, sans-serif', text: 'HI', size: 48, align: 'left' })
  const short = { ...window.__pfState().doc.layers.find((l) => l.id === id) }
  st.setText(id, { text: 'A MUCH LONGER LINE OF TEXT' })
  const long = { ...window.__pfState().doc.layers.find((l) => l.id === id) }
  st.setText(id, { text: 'one\ntwo\nthree' })
  const multi = { ...window.__pfState().doc.layers.find((l) => l.id === id) }
  st.setText(id, { text: 'HI' })
  const back = { ...window.__pfState().doc.layers.find((l) => l.id === id) }
  return {
    short: [Math.round(short.w), Math.round(short.h)],
    long: [Math.round(long.w), Math.round(long.h)],
    multi: [Math.round(multi.w), Math.round(multi.h)],
    back: [Math.round(back.w), Math.round(back.h)],
    lineHeight: short.size * (short.lineHeight || 1.2),
  }
}, textId)
console.log('box sizes:', JSON.stringify(fit))
check('the box grows with the text', fit.long[0] > fit.short[0] * 3,
  `${fit.short[0]} -> ${fit.long[0]}`)
check('and shrinks back when text is removed', fit.back[0] === fit.short[0],
  `${fit.long[0]} -> ${fit.back[0]}`)
check('three lines make the box three lines tall',
  Math.abs(fit.multi[1] - fit.lineHeight * 3) < 2,
  `${fit.multi[1]} against ${(fit.lineHeight * 3).toFixed(0)}`)
check('one line is one line tall', Math.abs(fit.short[1] - fit.lineHeight) < 2,
  `${fit.short[1]} against ${fit.lineHeight.toFixed(0)}`)

// Size changes have to re-fit too, or big text spills out of a small box.
const grown = await page.evaluate((id) => {
  const st = window.__pfState()
  const before = { ...st.doc.layers.find((l) => l.id === id) }
  st.setText(id, { size: 96 })
  const after = { ...window.__pfState().doc.layers.find((l) => l.id === id) }
  return { before: [Math.round(before.w), Math.round(before.h)], after: [Math.round(after.w), Math.round(after.h)] }
}, textId)
console.log('after doubling the size:', JSON.stringify(grown))
check('doubling the size roughly doubles the box',
  Math.abs(grown.after[0] / grown.before[0] - 2) < 0.15
  && Math.abs(grown.after[1] / grown.before[1] - 2) < 0.15,
  `${grown.before} -> ${grown.after}`)

// The anchor must hold: a centred box grows from its middle, not its left edge.
const anchored = await page.evaluate((id) => {
  const st = window.__pfState()
  st.setText(id, { size: 40, align: 'center', text: 'MID' })
  const a = window.__pfState().doc.layers.find((l) => l.id === id)
  const centreBefore = a.x + a.w / 2
  st.setText(id, { text: 'MIDDLE OF THE ROAD' })
  const b = window.__pfState().doc.layers.find((l) => l.id === id)
  return { before: Math.round(centreBefore), after: Math.round(b.x + b.w / 2) }
}, textId)
console.log('centre before and after:', JSON.stringify(anchored))
check('a centred box grows from its centre', Math.abs(anchored.after - anchored.before) <= 1,
  `${anchored.before} -> ${anchored.after}`)

// Resizing by hand switches to a fixed width that wraps.
const wrapped = await page.evaluate((id) => {
  const st = window.__pfState()
  st.updateLayer(id, { autoSize: false, w: 160 })
  st.setText(id, { text: 'this is a long sentence that has to wrap onto several lines' })
  const l = window.__pfState().doc.layers.find((x) => x.id === id)
  return { w: Math.round(l.w), h: Math.round(l.h), lineHeight: l.size * (l.lineHeight || 1.2) }
}, textId)
console.log('with a fixed width:', JSON.stringify(wrapped))
check('a fixed-width box keeps its width', wrapped.w === 160, String(wrapped.w))
check('but still grows tall enough for the wrapped lines',
  wrapped.h > wrapped.lineHeight * 2, `${wrapped.h} tall, line ${wrapped.lineHeight.toFixed(0)}`)

// --- editing in place -----------------------------------------------------------------
await page.evaluate((id) => {
  const st = window.__pfState()
  // setText, not updateLayer: the box is still 432px tall from the wrap test
  // above, and its centre would be off the bottom of a 320x200 canvas — the
  // double-click would land on nothing.
  st.updateLayer(id, { autoSize: true, x: 40, y: 40 })
  st.setText(id, { text: 'EDIT ME', size: 40 })
  st.setTool('move')
  st.select([id])
}, textId)
await page.waitForTimeout(300)
const spot = await page.evaluate((id) => {
  const st = window.__pfState()
  const l = st.doc.layers.find((x) => x.id === id)
  const c = document.querySelector('.stage canvas')
  const r = c.getBoundingClientRect()
  const v = st.view
  return [
    r.left + v.panX + (l.x + l.w / 2) * v.zoom,
    r.top + v.panY + (l.y + l.h / 2) * v.zoom,
  ]
}, textId)
await page.mouse.dblclick(spot[0], spot[1])
await page.waitForTimeout(350)
const editor = await page.evaluate(() => {
  const el = document.getElementById('pf-inline-text')
  if (!el) return null
  const st = window.__pfState()
  const l = st.doc.layers.find((x) => x.type === 'text')
  const cs = getComputedStyle(el)
  return {
    present: true,
    focused: document.activeElement === el,
    value: el.value,
    // It has to sit on the layer and look like it, or it is just a floating box.
    matchesFont: cs.fontFamily.replace(/["']/g, '').startsWith(
      (l.font || '').split(',')[0].replace(/["']/g, '')),
    colour: cs.color,
    transparent: cs.backgroundColor === 'rgba(0, 0, 0, 0)',
  }
})
console.log('inline editor:', JSON.stringify(editor))
check('double-clicking text opens an editor on the canvas', editor?.present === true)
check('with the text already in it and focused', editor?.value === 'EDIT ME' && editor.focused)
check('drawn in the layer own font and colour', editor?.matchesFont === true, editor?.colour)
check('and transparent, so you are editing the artwork not a box over it',
  editor?.transparent === true)

// The canvas must stop drawing the layer while the textarea is drawing it, or
// you see the text twice a pixel or two apart — which reads as a duplicate
// layer, and was reported as one.
// Counted against the same measurement with the editor closed, rather than
// against zero: the preview canvas also carries the selection box and its white
// handles, so a handful of bright pixels is chrome, not the text.
const brightBand = () => page.evaluate(() => {
  const st = window.__pfState()
  const l = st.doc.layers.find((x) => x.type === 'text')
  const c = document.querySelector('.stage canvas')
  const ctx = c.getContext('2d', { willReadFrequently: true })
  const v = st.view
  const box = c.getBoundingClientRect()
  const sx = c.width / box.width
  const sy = c.height / box.height
  const x0 = Math.max(0, Math.round((v.panX + l.x * v.zoom) * sx))
  const y0 = Math.max(0, Math.round((v.panY + l.y * v.zoom) * sy))
  const w = Math.min(Math.round(l.w * v.zoom * sx), c.width - x0)
  const h = Math.min(Math.round(l.h * v.zoom * sy), c.height - y0)
  if (w <= 0 || h <= 0) return 0
  const d = ctx.getImageData(x0, y0, w, h).data
  let bright = 0
  for (let i = 0; i < d.length; i += 4) {
    if (d[i] > 220 && d[i + 1] > 220 && d[i + 2] > 220) bright++
  }
  return bright
})
const whileEditing = await brightBand()
const layerCount = await page.evaluate(() =>
  window.__pfState().doc.layers.filter((x) => x.type === 'text').length)
console.log('bright pixels while editing:', whileEditing, '· text layers:', layerCount)
check('there is still only one text layer', layerCount === 1, `${layerCount}`)

await page.keyboard.press('Control+A')
await page.keyboard.type('TYPED IN PLACE')
await page.waitForTimeout(300)
const typed = await page.evaluate((id) => {
  const l = window.__pfState().doc.layers.find((x) => x.id === id)
  return { text: l.text, w: Math.round(l.w) }
}, textId)
console.log('after typing:', JSON.stringify(typed))
check('typing updates the layer', typed.text === 'TYPED IN PLACE', typed.text)
check('and the box grows as you type', typed.w > 200, `${typed.w}px wide`)

await page.keyboard.press('Escape')
await page.waitForTimeout(250)
check('Escape closes the editor',
  await page.evaluate(() => !document.getElementById('pf-inline-text')))
await page.waitForTimeout(300)
const whileClosed = await brightBand()
console.log('bright pixels with the editor closed:', whileClosed)
check('the canvas stops drawing the text while it is being edited',
  whileEditing < whileClosed * 0.1,
  `${whileEditing} while editing against ${whileClosed} after`)
// ...and the layer comes back on the canvas afterwards.
const restoredDraw = await page.evaluate(() => {
  const st = window.__pfState()
  const c = document.createElement('canvas')
  c.width = st.doc.width
  c.height = st.doc.height
  const ctx = c.getContext('2d', { willReadFrequently: true })
  window.__pfRender.renderDocument(ctx, st.doc, 0)
  const d = ctx.getImageData(0, 0, c.width, c.height).data
  let bright = 0
  for (let i = 0; i < d.length; i += 4) if (d[i] > 220 && d[i + 1] > 220 && d[i + 2] > 220) bright++
  return bright
})
check('and the text is drawn again once editing ends', restoredDraw > 200, `${restoredDraw} px`)
await page.screenshot({ path: path.join(OUT, '01-inline-edit.png') })

// --- the outline shows through -----------------------------------------------------------
// The effect: solid letters where nothing covers them, outline only where the
// cut-out subject does. One text layer, drawn twice.
const outline = await page.evaluate(() => {
  const st = window.__pfState()
  st.doc.layers.filter((l) => l.type === 'text').forEach((l) => st.removeLayers([l.id]))
  const photo = window.__pfState().doc.layers.find((l) => l.type === 'image')
  window.__pfState().updateLayer(photo.id, {
    bgRemove: { ...window.__pfMatte.defaultBgRemove(), on: true, mode: 'auto', tolerance: 40 },
  })
  window.__pfState().setDoc({ background: '#000000' })
  const id = window.__pfState().textBehindSubject(photo.id)
  window.__pfState().setText(id, {
    text: 'OUTLINE', size: 90, align: 'center', autoSize: false,
    x: 0, y: 60, w: 320,
  })
  window.__pfState().updateLayer(id, {
    color: '#ffffff', outlineAbove: true, outlineWidth: 3, outlineColor: '#ffffff',
  })
  return { id, layers: window.__pfState().doc.layers.length }
})
await page.waitForTimeout(400)

const pixels = await page.evaluate(() => {
  const st = window.__pfState()
  const c = document.createElement('canvas')
  c.width = st.doc.width
  c.height = st.doc.height
  const ctx = c.getContext('2d', { willReadFrequently: true })
  window.__pfRender.renderDocument(ctx, st.doc, 0)
  const d = ctx.getImageData(0, 0, c.width, c.height).data
  // The fixture's disc sits at (250, 100) with radius 34 at t=0.
  const inDisc = (x, y) => Math.hypot(x - 250, y - 100) < 30
  let whiteInside = 0
  let whiteOutside = 0
  let insideTotal = 0
  for (let y = 60; y < 160; y++) {
    for (let x = 0; x < c.width; x++) {
      const i = (y * c.width + x) * 4
      const white = d[i] > 225 && d[i + 1] > 225 && d[i + 2] > 225
      if (inDisc(x, y)) {
        insideTotal++
        if (white) whiteInside++
      } else if (white) whiteOutside++
    }
  }
  return { whiteInside, whiteOutside, insideTotal }
})
console.log('white pixels:', JSON.stringify(pixels))
check('the letters are solid where nothing covers them', pixels.whiteOutside > 500,
  `${pixels.whiteOutside} px`)
// Over the subject only the stroke survives: some white, but nothing like a fill.
const frac = pixels.whiteInside / pixels.insideTotal
console.log('white share inside the subject:', (frac * 100).toFixed(1) + '%')
check('the outline still shows over the subject', pixels.whiteInside > 20,
  `${pixels.whiteInside} px`)
check('but only as an outline, not as filled letters', frac < 0.35,
  `${(frac * 100).toFixed(1)}% of the subject is white`)

// Aiming it at one layer must behave the same as aiming it at everything here,
// because in this document only that layer covers the text — and it must be
// possible to say which, since "above everything" is not always what you mean.
const aimed = await page.evaluate((id) => {
  const st = window.__pfState()
  const subject = st.doc.layers.filter((l) => l.type === 'image').pop()
  st.updateLayer(id, { outlineAbove: subject.id })
  const c = document.createElement('canvas')
  c.width = st.doc.width
  c.height = st.doc.height
  const ctx = c.getContext('2d', { willReadFrequently: true })
  window.__pfRender.renderDocument(ctx, window.__pfState().doc, 0)
  const d = ctx.getImageData(0, 0, c.width, c.height).data
  let inside = 0
  for (let y = 60; y < 160; y++) {
    for (let x = 0; x < c.width; x++) {
      const i = (y * c.width + x) * 4
      if (Math.hypot(x - 250, y - 100) >= 30) continue
      if (d[i] > 225 && d[i + 1] > 225 && d[i + 2] > 225) inside++
    }
  }
  return { target: subject.name, inside }
}, outline.id)
console.log('aimed at one layer:', JSON.stringify(aimed))
check('aiming the outline at a specific layer still shows it', aimed.inside > 20,
  `${aimed.inside} px over ${aimed.target}`)

// Aimed at a layer that does not cover the text, it must not appear over the
// subject — that is the difference between "above everything" and "above that".
const aimedElsewhere = await page.evaluate((id) => {
  const st = window.__pfState()
  const back = st.doc.layers.find((l) => l.type === 'image')
  st.updateLayer(id, { outlineAbove: back.id })
  const c = document.createElement('canvas')
  c.width = st.doc.width
  c.height = st.doc.height
  const ctx = c.getContext('2d', { willReadFrequently: true })
  window.__pfRender.renderDocument(ctx, window.__pfState().doc, 0)
  const d = ctx.getImageData(0, 0, c.width, c.height).data
  let inside = 0
  for (let y = 60; y < 160; y++) {
    for (let x = 0; x < c.width; x++) {
      const i = (y * c.width + x) * 4
      if (Math.hypot(x - 250, y - 100) >= 30) continue
      if (d[i] > 225 && d[i + 1] > 225 && d[i + 2] > 225) inside++
    }
  }
  return { target: back.name, inside }
}, outline.id)
console.log('aimed under the subject:', JSON.stringify(aimedElsewhere))
check('aiming it below the covering layer leaves it hidden',
  aimedElsewhere.inside === 0, `${aimedElsewhere.inside} px`)
await page.evaluate((id) => window.__pfState().updateLayer(id, { outlineAbove: 'all' }), outline.id)

// Turning it off must remove exactly that, and nothing else.
const off = await page.evaluate((id) => {
  const st = window.__pfState()
  st.updateLayer(id, { outlineAbove: false })
  const c = document.createElement('canvas')
  c.width = st.doc.width
  c.height = st.doc.height
  const ctx = c.getContext('2d', { willReadFrequently: true })
  window.__pfRender.renderDocument(ctx, window.__pfState().doc, 0)
  const d = ctx.getImageData(0, 0, c.width, c.height).data
  let inside = 0
  let outside = 0
  for (let y = 60; y < 160; y++) {
    for (let x = 0; x < c.width; x++) {
      const i = (y * c.width + x) * 4
      const white = d[i] > 225 && d[i + 1] > 225 && d[i + 2] > 225
      if (Math.hypot(x - 250, y - 100) < 30) { if (white) inside++ } else if (white) outside++
    }
  }
  return { inside, outside }
}, outline.id)
console.log('with the outline off:', JSON.stringify(off))
check('switching it off hides the outline over the subject', off.inside === 0, `${off.inside} px`)
check('and leaves the solid letters where they were',
  off.outside > 2000 && Math.abs(off.outside - pixels.whiteOutside) < pixels.whiteOutside * 0.5,
  `${off.outside} with it off vs ${pixels.whiteOutside} with it on`)
// The default follows the covering edge, so the letters keep their solid parts
// and the outline only adds a rim around them — a few hundred pixels of it.
check('by default the outline only adds a rim to the solid letters',
  pixels.whiteOutside > off.outside,
  `+${pixels.whiteOutside - off.outside} px of rim`)

// Whole-letter mode is the other behaviour, and has to be reachable: a covered
// letter is outlined *entirely*, including the parts of it past the subject, so
// the solid count drops rather than growing.
const whole = await page.evaluate((id) => {
  const st = window.__pfState()
  st.updateLayer(id, { outlineAbove: 'all', outlineWhole: true })
  const c = document.createElement('canvas')
  c.width = st.doc.width
  c.height = st.doc.height
  const ctx = c.getContext('2d', { willReadFrequently: true })
  window.__pfRender.renderDocument(ctx, window.__pfState().doc, 0)
  const d = ctx.getImageData(0, 0, c.width, c.height).data
  let inside = 0
  let outside = 0
  for (let y = 60; y < 160; y++) {
    for (let x = 0; x < c.width; x++) {
      const i = (y * c.width + x) * 4
      const white = d[i] > 225 && d[i + 1] > 225 && d[i + 2] > 225
      if (Math.hypot(x - 250, y - 100) < 30) { if (white) inside++ } else if (white) outside++
    }
  }
  st.updateLayer(id, { outlineWhole: false })
  return { inside, outside }
}, outline.id)
console.log('whole-letter mode:', JSON.stringify(whole))
check('whole-letter mode still shows an outline over the subject', whole.inside > 20,
  `${whole.inside} px`)
check('and outlines those letters entirely, so less of them stays solid',
  whole.outside < pixels.whiteOutside,
  `${whole.outside} whole-letter vs ${pixels.whiteOutside} crossing`)

// A layer stacked *below* the text must work too. The dropdown used to list
// only layers above it, which on a document where the text is on top left
// nothing to pick — so the text's fill is moved behind the named layer instead
// of the setting refusing.
const fromBelow = await page.evaluate(() => {
  const st = window.__pfState()
  st.doc.layers.filter((l) => l.type === 'text').forEach((l) => st.removeLayers([l.id]))
  const photo = window.__pfState().doc.layers.find((l) => l.type === 'image' && l.bgRemove?.on)
  const { makeTextLayer } = window.__pfStore
  // Added last, so it is above the photo in the stack.
  const t = window.__pfState().addLayer(makeTextLayer({
    text: 'ABOVE', size: 62, align: 'center', autoSize: false,
    x: 0, y: 68, w: 320, color: '#ffffff',
    font: '"Arial Black", Arial, system-ui, sans-serif',
  }))
  const measure = () => {
    const s2 = window.__pfState()
    const c = document.createElement('canvas')
    c.width = s2.doc.width
    c.height = s2.doc.height
    const ctx = c.getContext('2d', { willReadFrequently: true })
    window.__pfRender.renderDocument(ctx, s2.doc, 0)
    const d = ctx.getImageData(0, 0, c.width, c.height).data
    let inside = 0
    for (let y = 60; y < 160; y++) {
      for (let x = 0; x < c.width; x++) {
        const i = (y * c.width + x) * 4
        if (Math.hypot(x - 250, y - 100) >= 30) continue
        if (d[i] > 225 && d[i + 1] > 225 && d[i + 2] > 225) inside++
      }
    }
    return inside
  }
  const ls = window.__pfState().doc.layers
  const before = measure()
  window.__pfState().updateLayer(t.id, {
    outlineAbove: photo.id, outlineWidth: 3, outlineColor: '#ffffff',
  })
  return {
    textIsAbove: ls.findIndex((l) => l.id === t.id) > ls.findIndex((l) => l.id === photo.id),
    solidOverSubject: before,
    outlinedOverSubject: measure(),
  }
})
console.log('outlining above a layer below the text:', JSON.stringify(fromBelow))
check('the text really was stacked above the layer it names', fromBelow.textIsAbove)
check('naming a layer below the text moves the text behind it',
  fromBelow.outlinedOverSubject < fromBelow.solidOverSubject * 0.6,
  `${fromBelow.solidOverSubject} solid -> ${fromBelow.outlinedOverSubject} outlined`)
check('and it is outlined there rather than gone', fromBelow.outlinedOverSubject > 40,
  `${fromBelow.outlinedOverSubject} px`)

// The menu has to offer every layer, or the case above is unreachable.
const menu = await page.evaluate(() => {
  const st = window.__pfState()
  const t = st.doc.layers.find((l) => l.type === 'text')
  st.select([t.id])
  return new Promise((res) => setTimeout(() => {
    const sel = [...document.querySelectorAll('.inspector select')]
      .find((x) => [...x.options].some((o) => o.value === 'all'))
    res({
      values: sel ? [...sel.options].map((o) => o.value) : [],
      layers: window.__pfState().doc.layers.filter((l) => l.type !== 'group').length,
      textId: t.id,
    })
  }, 400))
})
console.log('outline-above menu:', JSON.stringify(menu))
check('the menu lists every layer, not only those above the text',
  menu.values.length === menu.layers - 1 + 2,
  `${menu.values.length} entries for ${menu.layers} layers`)
check('and never offers the text itself', !menu.values.includes(menu.textId))

await page.evaluate(() => {
  const st = window.__pfState()
  st.doc.layers.filter((l) => l.type === 'text').forEach((l) => st.removeLayers([l.id]))
})

await page.screenshot({ path: path.join(OUT, '02-outline.png') })

// --- one word styled differently from the rest ------------------------------------
// A layer had one colour, one weight, one slant, which is right for a title and
// wrong for a sentence with a word in it that matters more than the others.
//
// Counted in pixels by colour, because "the run was stored" says nothing about
// whether one word came out purple and the rest did not.
const runs = await page.evaluate(async () => {
  const st = window.__pfState()
  st.setPlaying(false)
  st.doc.layers.filter((l) => l.type === 'text').forEach((l) => st.removeLayers([l.id]))
  await new Promise((r) => setTimeout(r, 250))
  const { makeTextLayer } = window.__pfStore
  // Sized and placed against the document this suite happens to be using, rather
  // than at coordinates that suit one of them: dropped outside the canvas the
  // layer renders nothing and every count below is zero.
  const doc = window.__pfState().doc
  const size = Math.max(24, Math.round(doc.height * 0.18))
  const t = window.__pfState().addLayer(makeTextLayer({
    text: 'hello world',
    x: Math.round(doc.width * 0.04),
    y: Math.round(doc.height * 0.35),
    w: Math.round(doc.width * 0.92),
    h: Math.round(size * 1.3),
    size,
    weight: 700,
    color: '#ffffff', strokeWidth: 0, autoSize: false, align: 'left',
  }))
  window.__pfState().select([t.id])
  await new Promise((r) => setTimeout(r, 350))

  const inks = () => {
    const s2 = window.__pfState()
    const c = document.createElement('canvas')
    c.width = s2.doc.width
    c.height = s2.doc.height
    const ctx = c.getContext('2d', { willReadFrequently: true })
    window.__pfRender.renderDocument(ctx, s2.doc, 0)
    const d = ctx.getImageData(0, 0, c.width, c.height).data
    let white = 0
    let purple = 0
    for (let i = 0; i < d.length; i += 4) {
      if (d[i + 3] < 200) continue
      if (d[i] > 240 && d[i + 1] > 240 && d[i + 2] > 240) white++
      else if (d[i] > 130 && d[i] < 210 && d[i + 1] < 40 && d[i + 2] > 220) purple++
    }
    return { white, purple }
  }
  const before = inks()

  // "world" is characters 6 to 11.
  window.__pfState().setTextSelection({ id: t.id, from: 6, to: 11 })
  const res = window.__pfState().styleText(t.id, { color: '#aa00ff', weight: 900 })
  await new Promise((r) => setTimeout(r, 350))
  const after = inks()
  const l = window.__pfState().doc.layers.find((x) => x.id === t.id)
  return { before, after, res, runs: l.runs, w: Math.round(l.w) }
})
console.log('ink before and after styling one word:', JSON.stringify(runs))
// Counted as a share of the ink that was there to begin with, so the thresholds
// hold whatever size document the suite is using.
check('plain text is all one colour', runs.before.purple === 0 && runs.before.white > 300,
  JSON.stringify(runs.before))
check('styling a selection makes a run of it',
  runs.res.scope === 'selection' && runs.runs.length === 1
  && runs.runs[0].from === 6 && runs.runs[0].to === 11, JSON.stringify(runs.runs))
check('that word comes out in the new colour',
  runs.after.purple > runs.before.white * 0.25, JSON.stringify(runs.after))
// The half that says it is a *run* rather than the layer having changed colour.
check('and the rest of the line does not',
  runs.after.white > runs.before.white * 0.25, JSON.stringify(runs.after))

// Changing the layer afterwards moves the words that were left alone, and only
// those: a run says what it says, and text that never said anything follows.
const layerAfter = await page.evaluate(async () => {
  const st = window.__pfState()
  const t = st.doc.layers.find((l) => l.type === 'text')
  st.setTextSelection(null)
  st.updateLayer(t.id, { color: '#00ff00' })
  await new Promise((r) => setTimeout(r, 350))
  const s2 = window.__pfState()
  const c = document.createElement('canvas')
  c.width = s2.doc.width
  c.height = s2.doc.height
  const ctx = c.getContext('2d', { willReadFrequently: true })
  window.__pfRender.renderDocument(ctx, s2.doc, 0)
  const d = ctx.getImageData(0, 0, c.width, c.height).data
  let green = 0
  let purple = 0
  for (let i = 0; i < d.length; i += 4) {
    if (d[i + 3] < 200) continue
    if (d[i + 1] > 220 && d[i] < 60) green++
    else if (d[i] > 130 && d[i] < 210 && d[i + 2] > 220) purple++
  }
  return { green, purple }
})
console.log('after changing the layer colour:', JSON.stringify(layerAfter))
check('changing the layer moves the words that were left alone',
  layerAfter.green > runs.before.white * 0.25, JSON.stringify(layerAfter))
check('and leaves the styled word saying what it said',
  layerAfter.purple > runs.before.white * 0.25, JSON.stringify(layerAfter))

// Typing in front of a styled word has to carry it along, or the colour ends up
// on whatever letters happen to sit at those offsets afterwards.
const shifted = await page.evaluate(async () => {
  const st = window.__pfState()
  const t = st.doc.layers.find((l) => l.type === 'text')
  const was = st.doc.layers.find((l) => l.id === t.id).runs[0]
  st.setText(t.id, { text: 'oh hello world' }, { from: 0, to: 0, insert: 3 })
  await new Promise((r) => setTimeout(r, 300))
  const now = window.__pfState().doc.layers.find((l) => l.id === t.id)
  return { was, runs: now.runs, text: now.text }
})
console.log('after typing in front of it:', JSON.stringify(shifted))
check('typing before a styled word carries the style along with it',
  shifted.runs[0].from === 9 && shifted.runs[0].to === 14, JSON.stringify(shifted.runs))
check('so it still covers the same word',
  shifted.text.slice(shifted.runs[0].from, shifted.runs[0].to) === 'world',
  shifted.text.slice(shifted.runs[0].from, shifted.runs[0].to))

// --- tracking, and one word set differently from the rest -------------------------------
// A masthead is mostly its tracking, and a cover line is often one word set
// larger or in another face. Both are measured off the rendered pixels rather
// than off the fields, because the arithmetic that lays out a line of mixed
// sizes is the part that can be wrong while the document looks right.
const typo = await page.evaluate(async () => {
  const st = window.__pfState()
  st.resetDoc()
  // Transparent, so measuring the alpha channel measures the letters. On an
  // opaque ground every pixel is opaque and the probe reports the canvas.
  st.setDoc({ width: 900, height: 400, background: 'transparent' })
  await new Promise((r) => setTimeout(r, 250))
  const { makeTextLayer } = window.__pfStore
  const layer = makeTextLayer({
    text: 'AESTHETIC', x: 40, y: 120, size: 80, weight: 800, color: '#ffffff', align: 'left',
  })
  window.__pfState().addLayer(layer)
  await new Promise((r) => setTimeout(r, 300))
  const id = layer.id

  const box = () => {
    const l = window.__pfState().doc.layers.find((x) => x.id === id)
    return { w: Math.round(l.w), h: Math.round(l.h) }
  }
  // What the picture actually contains, so a box that grew without the letters
  // moving cannot pass.
  const ink = () => {
    const s2 = window.__pfState()
    const c = document.createElement('canvas')
    c.width = s2.doc.width
    c.height = s2.doc.height
    const g = c.getContext('2d', { willReadFrequently: true })
    window.__pfRender.renderDocument(g, s2.doc, 0)
    const d = g.getImageData(0, 0, c.width, c.height).data
    let minX = 1e9; let maxX = -1; let minY = 1e9; let maxY = -1
    for (let y = 0; y < c.height; y++) {
      for (let x = 0; x < c.width; x++) {
        if (d[(y * c.width + x) * 4 + 3] > 128) {
          if (x < minX) minX = x
          if (x > maxX) maxX = x
          if (y < minY) minY = y
          if (y > maxY) maxY = y
        }
      }
    }
    return maxX < 0 ? null : { w: maxX - minX + 1, h: maxY - minY + 1, top: minY }
  }

  const plain = { box: box(), ink: ink() }

  window.__pfState().setText(id, { tracking: 0.2 })
  await new Promise((r) => setTimeout(r, 300))
  const tracked = { box: box(), ink: ink() }

  window.__pfState().setText(id, { tracking: -0.05 })
  await new Promise((r) => setTimeout(r, 300))
  const tight = { box: box(), ink: ink() }

  // Back to normal, then style one word of a two-word line much larger.
  window.__pfState().setText(id, { tracking: 0, text: 'THE QUIET' })
  await new Promise((r) => setTimeout(r, 300))
  const before = { box: box(), ink: ink() }
  window.__pfState().setTextSelection({ id, from: 4, to: 9 })
  window.__pfState().styleText(id, { size: 160 })
  await new Promise((r) => setTimeout(r, 400))
  const mixed = { box: box(), ink: ink() }
  const runs = window.__pfState().doc.layers.find((x) => x.id === id).runs
  window.__pfState().setTextSelection(null)
  return { plain, tracked, tight, before, mixed, runs }
})
console.log('typography:', JSON.stringify({
  plain: typo.plain, tracked: typo.tracked, tight: typo.tight,
  before: typo.before, mixed: typo.mixed, runs: typo.runs,
}))

// Nine letters at 20% of 80px is about 144px of extra width, and the letters
// have to actually move — a box that grew on its own would be a box that lies
// about what is in it.
check('tracking widens the text itself, not just the box',
  typo.tracked.ink.w > typo.plain.ink.w + 100,
  `${typo.plain.ink.w} -> ${typo.tracked.ink.w}`)
check('and the box grows with it, so nothing is clipped',
  typo.tracked.box.w > typo.plain.box.w + 100,
  `${typo.plain.box.w} -> ${typo.tracked.box.w}`)
check('negative tracking tightens it', typo.tight.ink.w < typo.plain.ink.w,
  `${typo.plain.ink.w} -> ${typo.tight.ink.w}`)
check('the height is untouched either way',
  Math.abs(typo.tracked.ink.h - typo.plain.ink.h) <= 2,
  `${typo.plain.ink.h} vs ${typo.tracked.ink.h}`)

check('a run can carry its own size', typo.runs?.[0]?.style?.size === 160,
  JSON.stringify(typo.runs))
check('and the word set larger is drawn larger',
  typo.mixed.ink.h > typo.before.ink.h * 1.6,
  `${typo.before.ink.h} -> ${typo.mixed.ink.h}`)
// The line is as tall as the largest thing on it, or the big word overlaps
// whatever is above it and the box clips its own text.
check('the box grows to hold the taller line',
  typo.mixed.box.h > typo.before.box.h * 1.6,
  `${typo.before.box.h} -> ${typo.mixed.box.h}`)
check('and the text still starts inside its own box',
  typo.mixed.ink.top >= 118, String(typo.mixed.ink.top))

console.log(errors.length ? 'CONSOLE ERRORS: ' + errors.slice(0, 5).join(' | ') : 'no console errors')
await browser.close()
process.exit(checks.some(([, ok]) => !ok) ? 1 : 0)
