// Smoke test: drives the running dev server in real Chrome, drops in the test
// GIF, adds a pixelate overlay, and asserts the overlay actually pixelates the
// animating frames underneath it. Run with: node e2e.mjs
import { chromium } from 'playwright-core'
import { importAndPlace } from './e2e-helpers.mjs'
import fs from 'fs'
import path from 'path'

const OUT = process.env.PF_OUT || 'shots'
fs.mkdirSync(OUT, { recursive: true })

const browser = await chromium.launch({
  executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  headless: true,
})
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })

const errors = []
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()) })
page.on('pageerror', (e) => errors.push('PAGEERROR: ' + e.message))

// `checks` is populated further down; this just records and prints as we go.
const check = (name, ok) => {
  checks.push([name, ok])
  console.log((ok ? 'PASS  ' : 'FAIL  ') + name)
}

await page.goto('http://localhost:5173/', { waitUntil: 'networkidle' })
await page.waitForTimeout(500)
await page.screenshot({ path: path.join(OUT, '01-empty.png') })

// Load the test GIF through the real file input.
await importAndPlace(page, 'public/test/motion.gif', { timeout: 10000 })
  .catch(() => {})
await page.waitForTimeout(1200)
await page.screenshot({ path: path.join(OUT, '02-gif-loaded.png') })

const info = await page.evaluate(() => {
  const s = window.__pfState()
  return { layers: s.doc.layers.length, w: s.doc.width, h: s.doc.height, duration: s.duration }
})
console.log('after import:', JSON.stringify(info))

// Pick the pixel-overlay tool and drag a circle over the canvas.
await page.keyboard.press('p')
await page.waitForTimeout(400) // tool rail width transition
const box = await page.locator('.stage canvas').boundingBox()
const cx = box.x + box.width / 2
const cy = box.y + box.height / 2
await page.mouse.move(cx - 180, cy - 110)
await page.mouse.down()
await page.mouse.move(cx + 180, cy + 110, { steps: 16 })
await page.mouse.up()
await page.waitForTimeout(600)
await page.screenshot({ path: path.join(OUT, '03-overlay.png') })

const layerInfo = await page.evaluate(() => {
  const s = window.__pfState()
  const fx = s.doc.layers.find((l) => l.type === 'effect')
  return fx && { shape: fx.shape, effect: fx.effect, w: Math.round(fx.w), h: Math.round(fx.h),
    pixelSize: fx.pixelSize }
})
console.log('effect layer:', JSON.stringify(layerInfo))

// The real assertion: sample the composited document canvas inside the overlay
// at two different playback times. The pixels must (a) be blocky and (b) change
// between frames, proving the effect re-runs per GIF frame.
const probe = await page.evaluate(async () => {
  const s = window.__pfState()
  const { renderDocument } = window.__pfRender
  const fx = s.doc.layers.find((l) => l.type === 'effect')
  const c = document.createElement('canvas')
  c.width = s.doc.width
  c.height = s.doc.height
  const ctx = c.getContext('2d', { willReadFrequently: true })

  const sampleAt = (t) => {
    renderDocument(ctx, s.doc, t)
    const x = Math.round(fx.x + fx.w / 2)
    const y = Math.round(fx.y + fx.h / 2)
    const px = Math.max(1, Math.round(fx.pixelSize))
    // Two points inside the same pixel block, and one in the next block over.
    const gx = Math.floor(x / px) * px
    const gy = Math.floor(y / px) * px
    const at = (ax, ay) => [...ctx.getImageData(ax, ay, 1, 1).data].slice(0, 3)
    return {
      inBlockA: at(gx + 1, gy + 1),
      inBlockB: at(gx + px - 2, gy + px - 2),
      nextBlock: at(gx + px + 1, gy + 1),
      outside: at(Math.round(fx.x) - 6, y),
    }
  }
  const total = s.duration
  const shots = [0, 0.15, 0.3, 0.45, 0.6, 0.75].map((f) => sampleAt(total * f))
  return { shots, duration: total, box: { x: fx.x, y: fx.y, w: fx.w, h: fx.h } }
})

const same = (a, b) => a.every((v, i) => Math.abs(v - b[i]) <= 1)
probe.shots.forEach((s, i) => console.log(`probe #${i}:`, JSON.stringify(s)))

const first = probe.shots[0]
const distinctInside = new Set(probe.shots.map((s) => s.inBlockA.join(','))).size
const checks = [
  ['pixel block is flat (two points in one block match)', probe.shots.every((s) => same(s.inBlockA, s.inBlockB))],
  ['neighbouring block differs (real pixelation, not a flat fill)', !same(first.inBlockA, first.nextBlock)],
  ['overlay content changes across GIF frames', distinctInside > 1],
]
for (const [name, ok] of checks) console.log((ok ? 'PASS  ' : 'FAIL  ') + name)

// --- drawing must never grab the selected layer's transform handles --------
// Regression: with the GIF selected, arming the pixelate tool and dragging from
// one of its handles used to resize the GIF instead of drawing an overlay.
await page.evaluate(() => {
  const s = window.__pfState()
  s.setPlaying(false)
  s.setTime(0)
  s.select([s.doc.layers[0].id]) // the GIF
})
await page.waitForTimeout(200)

const geo = await page.evaluate(() => {
  const s = window.__pfState()
  const l = s.doc.layers[0]
  const r = document.querySelector('.stage canvas').getBoundingClientRect()
  return { cx: r.x, cy: r.y, view: s.view, layer: { x: l.x, y: l.y, w: l.w, h: l.h },
    before: { w: Math.round(l.w), h: Math.round(l.h), x: Math.round(l.x), y: Math.round(l.y) },
    count: s.doc.layers.length }
})
// Read the geometry *now*, not from the snapshot taken earlier.
//
// Arming a tool that has options widens the rail from 52px to 210px, which moves
// everything to the right of it — the canvas included — by 158 pixels. Cached
// coordinates are therefore stale the moment a tool is picked. This used to pass
// anyway, because the stale point still landed somewhere on a canvas that ran to
// the window edge; it just drew in the wrong place, and a test that counts layers
// cannot tell. With the media bin now occupying that strip, the same stale point
// lands on the bin and the drag is swallowed.
const onScreen = async (dx, dy) => {
  const now = await page.evaluate(() => {
    const r = document.querySelector('.stage canvas').getBoundingClientRect()
    return { x: r.x, y: r.y, view: window.__pfState().view }
  })
  return [
    now.x + now.view.panX + dx * now.view.zoom,
    now.y + now.view.panY + dy * now.view.zoom,
  ]
}

await page.keyboard.press('p')
await page.waitForTimeout(450)

// Hovering a handle position with a drawing tool must show the draw cursor.
const [ehx, ehy] = await onScreen(geo.layer.x + geo.layer.w, geo.layer.y + geo.layer.h / 2)
await page.mouse.move(ehx, ehy)
await page.waitForTimeout(120)
const cursor = await page.evaluate(() => document.querySelector('.stage canvas').style.cursor)
console.log('cursor over a handle while armed to draw:', cursor)
check('a drawing tool shows the draw cursor over handles', cursor === 'crosshair')

await page.mouse.down()
await page.mouse.move(ehx + 150, ehy + 45, { steps: 10 })
await page.mouse.up()
await page.waitForTimeout(300)

const afterDraw = await page.evaluate(() => {
  const s = window.__pfState()
  const l = s.doc.layers[0]
  return {
    gif: { w: Math.round(l.w), h: Math.round(l.h), x: Math.round(l.x), y: Math.round(l.y) },
    count: s.doc.layers.length,
    selected: s.selectedIds.length,
    tool: s.tool,
  }
})
console.log('gif before/after draw:', JSON.stringify(geo.before), JSON.stringify(afterDraw.gif))
check('drawing over a selected layer leaves that layer untouched',
  JSON.stringify(afterDraw.gif) === JSON.stringify(geo.before))
check('drawing over a selected layer creates exactly one overlay',
  afterDraw.count === geo.count + 1)
check('the new overlay is the only thing selected', afterDraw.selected === 1)
check('the tool returns to move after drawing', afterDraw.tool === 'move')

// Repeated draws must not stack up duplicates.
const startCount = afterDraw.count
for (let i = 0; i < 3; i++) {
  await page.keyboard.press('p')
  await page.waitForTimeout(420)
  const [sx, sy] = await onScreen(40 + i * 30, 40)
  await page.mouse.move(sx, sy)
  await page.mouse.down()
  await page.mouse.move(sx + 90, sy + 70, { steps: 8 })
  await page.mouse.up()
  await page.waitForTimeout(220)
}
const afterThree = await page.evaluate(() => ({
  count: window.__pfState().doc.layers.length,
  selected: window.__pfState().selectedIds.length,
}))
console.log('layers after 3 more draws:', afterThree.count, '(expected', startCount + 3, ')')
check('each draw creates exactly one layer', afterThree.count === startCount + 3)
check('selection stays on the newest layer only', afterThree.selected === 1)

// Clean up so the export step below stays quick.
await page.evaluate(() => {
  const s = window.__pfState()
  const extra = s.doc.layers.filter((l) => l.type === 'effect').slice(1).map((l) => l.id)
  if (extra.length) s.removeLayers(extra)
  s.select([])
})
await page.waitForTimeout(200)

// Exercise the GIF export end to end.
let exportOk = false
try {
  const dl = page.waitForEvent('download', { timeout: 45000 })
  await page.click('header button.btn.primary')
  await page.waitForTimeout(500)
  await page.screenshot({ path: path.join(OUT, '04-export-dialog.png') })

  // --- the file name field ---------------------------------------------------
  // Exports used to be written as 'pixelforge.gif' whatever the project was
  // called, and a project nobody renamed went out as Untitled with no chance to
  // fix it. The name is now decided here, in front of you, before it is written.
  const seeded = await page.evaluate(() => ({
    value: document.querySelector('.modal .filename')?.value,
    ext: document.querySelector('.modal .filename-ext')?.textContent,
    project: window.__pfState().projectName,
    warned: [...document.querySelectorAll('.modal .hint.warn')]
      .some((el) => /saved as/i.test(el.textContent)),
  }))
  console.log('name field:', JSON.stringify(seeded))
  check('the export dialog has a file name field', typeof seeded.value === 'string')
  check('seeded from the project name', seeded.value === seeded.project,
    `${seeded.value} vs ${seeded.project}`)
  check('with the extension shown alongside', seeded.ext === '.gif', seeded.ext)
  check('and an unnamed project is called out rather than exported quietly',
    seeded.warned === true)

  // The extension has to follow the format, or the name lies about the file.
  const exts = await page.evaluate(async () => {
    const out = {}
    for (const fmt of ['png', 'gif', 'webm', 'mp4', 'project']) {
      const btn = [...document.querySelectorAll('.modal .segmented button')]
        .find((b) => b.textContent.trim().toLowerCase() === (fmt === 'project' ? 'project' : fmt))
      if (!btn) continue
      btn.click()
      await new Promise((r) => setTimeout(r, 60))
      out[fmt] = document.querySelector('.modal .filename-ext')?.textContent
    }
    // Back to GIF for the actual export below.
    ;[...document.querySelectorAll('.modal .segmented button')]
      .find((b) => b.textContent.trim().toLowerCase() === 'gif').click()
    await new Promise((r) => setTimeout(r, 60))
    return out
  })
  console.log('extension per format:', JSON.stringify(exts))
  check('the extension follows the chosen format',
    exts.png === '.png' && exts.gif === '.gif' && exts.webm === '.webm'
      && exts.mp4 === '.mp4' && exts.project === '.pfz',
    JSON.stringify(exts))

  // Characters a filesystem will not take must be replaced, not dropped: a name
  // that silently loses letters is harder to recognise than one with dashes.
  const cleaned = await page.evaluate(async () => {
    const input = document.querySelector('.modal .filename')
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
    setter.call(input, 'my/report:v2*final?')
    input.dispatchEvent(new Event('input', { bubbles: true }))
    await new Promise((r) => setTimeout(r, 120))
    return input.value
  })
  console.log('illegal characters ->', JSON.stringify(cleaned))
  check('illegal filename characters are replaced', !/[\\/:*?"<>|]/.test(cleaned), cleaned)
  check('and the rest of the name survives', /my/.test(cleaned) && /final/.test(cleaned), cleaned)

  const typed = 'beach-trip'
  await page.evaluate(async (name) => {
    const input = document.querySelector('.modal .filename')
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
    setter.call(input, name)
    input.dispatchEvent(new Event('input', { bubbles: true }))
    await new Promise((r) => setTimeout(r, 120))
  }, typed)
  const buttonSays = await page.evaluate(() =>
    document.querySelector('.modal-foot .btn.primary')?.textContent.trim())
  console.log('export button:', JSON.stringify(buttonSays))
  check('the button names the file it will write', buttonSays === `Export ${typed}.gif`, buttonSays)
  const stillWarned = await page.evaluate(() => [...document.querySelectorAll('.modal .hint.warn')]
    .some((el) => /saved as/i.test(el.textContent)))
  check('and the unnamed warning goes away once it has a name', stillWarned === false)

  await page.click('.modal-foot .btn.primary')
  const download = await dl
  console.log('suggested filename:', download.suggestedFilename())
  check('the export is written under the name that was typed',
    download.suggestedFilename() === `${typed}.gif`, download.suggestedFilename())
  await page.waitForTimeout(400)
  const renamed = await page.evaluate(() => window.__pfState().projectName)
  check('and the project is renamed to match, so the next export is not Untitled either',
    renamed === typed, renamed)
  const gifPath = path.join(OUT, 'export.gif')
  await download.saveAs(gifPath)
  console.log('exported GIF:', fs.statSync(gifPath).size, 'bytes')
  exportOk = true
} catch (err) {
  console.log('EXPORT FAILED:', String(err.message).slice(0, 140))
  await page.screenshot({ path: path.join(OUT, '04-export-failed.png') })
  const msg = await page.locator('.modal .hint.warn').allTextContents().catch(() => [])
  console.log('dialog messages:', JSON.stringify(msg))
}
checks.push(['GIF export produced a file', exportOk])

await page.screenshot({ path: path.join(OUT, '05-after-export.png') })

if (errors.length) {
  console.log('\nCONSOLE ERRORS:')
  for (const e of errors.slice(0, 20)) console.log('  ' + e)
} else {
  console.log('\nno console errors')
}

await browser.close()
const failed = checks.filter(([, ok]) => !ok).length
process.exit(failed ? 1 : 0)
