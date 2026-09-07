// Exporting at a physical size.
//
// test-dpi.mjs checks the chunk surgery in isolation. This checks the thing that
// actually matters: a PNG that came out of the real render-and-encode path, at a
// size asked for in millimetres, carries the resolution it was asked for.
import { chromium } from 'playwright-core'
import { importAndPlace } from './e2e-helpers.mjs'

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
await importAndPlace(page, 'public/test/room.png', { timeout: 20000 })
await page.evaluate(() => { window.__pfState().setPlaying(false); window.__pfState().setTime(0) })
await page.waitForTimeout(400)

// What is under test is the blob the exporter builds, not the browser's save
// behaviour — the download it also triggers is ignored.

/** Exports a PNG through the real path and reports what the bytes say. */
const shoot = (opts) => page.evaluate(async (o) => {
  const st = window.__pfState()
  const { blob } = await window.__pfExport.exportPNG(st.doc, st.time, {
    ...o, filename: 'print-test.png', silent: true,
  })
  const bytes = new Uint8Array(await blob.arrayBuffer())
  const img = await createImageBitmap(blob)
  return {
    dpi: window.__pfDpi.readDPI(bytes),
    w: img.width,
    h: img.height,
    bytes: bytes.length,
  }
}, opts)

const doc = await page.evaluate(() => ({
  w: window.__pfState().doc.width, h: window.__pfState().doc.height,
}))
console.log('document:', JSON.stringify(doc))

// --- no resolution asked for, none written -----------------------------------------
const plain = await shoot({ scale: 1 })
console.log('plain export:', JSON.stringify(plain))
check('an ordinary export is unchanged', plain.dpi === null, String(plain.dpi))
check('and comes out at the document size', plain.w === doc.w && plain.h === doc.h,
  `${plain.w}x${plain.h}`)

// --- 100mm wide at 300dpi ------------------------------------------------------------
const target = await page.evaluate(() => window.__pfDpi.pxFor(100, 'mm', 300))
const scale = target / doc.w
const printed = await shoot({ scale, dpi: 300 })
console.log('100mm at 300dpi:', JSON.stringify(printed), 'wanted', target, 'px')
check('the pixel count matches the physical size', printed.w === target,
  `${printed.w} vs ${target}`)
check('and the file says 300dpi', printed.dpi === 300, String(printed.dpi))
// The round trip is the real claim: a print pipeline reading this file back has
// to arrive at the 100mm that was asked for.
const backTo = await page.evaluate(([px]) => window.__pfDpi.sizeFor(px, 'mm', 300), [printed.w])
check('so it prints at the size it was asked for', Math.abs(backTo - 100) < 0.2,
  `${backTo.toFixed(2)} mm`)
check('and it is still a readable PNG', printed.h > 0 && printed.bytes > 1000,
  `${printed.w}x${printed.h}, ${printed.bytes} bytes`)

// --- the resolution does not change the pixels, only the claim -------------------------
// Two real exports at 300 and 600 must come out the same size in pixels and each
// read back its own resolution.
const a = await shoot({ scale, dpi: 300 })
const b = await shoot({ scale, dpi: 600 })
check('two resolutions give the same picture at different claims',
  a.w === b.w && a.h === b.h && a.dpi === 300 && b.dpi === 600,
  `${a.w}x${a.h} at ${a.dpi} and ${b.dpi}`)

// That the *bytes* are untouched is asserted on one export stamped twice, not on
// two exports compared to each other. Chrome's rasterisation of a several-times
// upscale is not bit-reproducible — five exports of the same document at the
// same resolution were measured at 1535199, 1535199, 1535195, 1535195, 1535195,
// so comparing two encodes would have been testing the browser's canvas, not
// this. Stamping one array twice isolates the claim exactly.
const stamped = await page.evaluate(async ([sc]) => {
  const st = window.__pfState()
  const { blob } = await window.__pfExport.exportPNG(st.doc, st.time, {
    scale: sc, filename: 'print-test.png', silent: true,
  })
  const raw = new Uint8Array(await blob.arrayBuffer())
  const at300 = window.__pfDpi.withDPI(raw, 300)
  const at600 = window.__pfDpi.withDPI(raw, 600)
  // Everything but the pHYs payload has to be identical, byte for byte.
  let differ = 0
  for (let i = 0; i < Math.min(at300.length, at600.length); i++) {
    if (at300[i] !== at600[i]) differ++
  }
  return {
    same: at300.length === at600.length,
    grew: at300.length - raw.length,
    differ,
    read: [window.__pfDpi.readDPI(at300), window.__pfDpi.readDPI(at600)],
  }
}, [scale])
console.log('one export stamped twice:', JSON.stringify(stamped))
check('stamping a resolution leaves the image data alone',
  stamped.same && stamped.differ <= 12, `${stamped.differ} bytes differ`)
check('and costs one chunk', stamped.grew === 21, `${stamped.grew} bytes`)
check('and each stamp reads back its own resolution',
  stamped.read[0] === 300 && stamped.read[1] === 600, JSON.stringify(stamped.read))

// --- the dialog offers it -------------------------------------------------------------
await page.keyboard.press('Escape')
const opened = await page.evaluate(() => {
  const btn = [...document.querySelectorAll('button')].find((b) => /^Export/.test(b.textContent))
  if (btn) btn.click()
  return !!btn
})
await page.waitForTimeout(400)
check('the export dialog opens', opened && await page.locator('.modal').count() > 0)

const modeBtn = page.locator('.modal .segmented button', { hasText: 'Print size' })
check('and offers sizing by print size', await modeBtn.count() === 1)
await modeBtn.click()
await page.waitForTimeout(250)
const shown = await page.evaluate(() => {
  const read = [...document.querySelectorAll('.modal .readout')].map((e) => e.textContent.trim())
  const selects = [...document.querySelectorAll('.modal select')].map((s) => s.value)
  return { read, selects }
})
console.log('dialog shows:', JSON.stringify(shown))
check('the output pixel size is shown', shown.read.some((t) => /\d+ × \d+ px/.test(t)),
  shown.read.join(' | '))
check('and it defaults to 300dpi', shown.selects.includes('300'), shown.selects.join(','))
// 100mm at 300dpi is 1181px, whatever the document happens to be — the point of
// the mode is that the physical size drives the pixels.
check('the readout reflects the physical size, not the document size',
  shown.read.some((t) => t.includes('1181')), shown.read.join(' | '))

console.log(errors.length ? 'CONSOLE ERRORS: ' + errors.slice(0, 5).join(' | ') : 'no console errors')
await browser.close()
process.exit(checks.some(([, ok]) => !ok) ? 1 : 0)
