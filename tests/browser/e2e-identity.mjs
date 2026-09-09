// Layer identity and deselection.
//
// Regression: the id counter restarted on page load while a restored session
// kept the ids it was saved with, so the next import re-issued one. Two layers
// then shared an identity and behaved as one — selecting, dragging, editing or
// deleting either hit both.
import { chromium } from 'playwright-core'
import fs from 'fs'
import path from 'path'

const OUT = 'shots/identity'
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
const check = (name, ok) => { checks.push([name, ok]); console.log((ok ? 'PASS  ' : 'FAIL  ') + name) }

const snapshot = () => page.evaluate(() => {
  const s = window.__pfState()
  const ids = s.doc.layers.map((l) => l.id)
  return {
    ids,
    duplicates: ids.filter((v, i) => ids.indexOf(v) !== i),
    selectedIds: s.selectedIds,
    matched: s.doc.layers.filter((l) => s.selectedIds.includes(l.id)).length,
    highlighted: document.querySelectorAll('.layer.on').length,
    inspector: document.querySelector('.inspector .panel-head span')?.textContent,
  }
})

await page.goto('http://localhost:5173/', { waitUntil: 'networkidle' })
await page.evaluate(() => indexedDB.deleteDatabase('pixelforge'))
await page.reload({ waitUntil: 'networkidle' })

// Importing several files fills the media bin rather than the canvas, so the
// two layers this test needs are placed from there. The identity bug being
// guarded here is in layer creation, which is the same code either way.
await page.setInputFiles('.pf-media-input', ['public/test/motion.gif', 'public/test/room.png'])
await page.waitForFunction(() => window.__pfState().doc.media.length > 1, { timeout: 15000 })
await page.evaluate(() => {
  const s = window.__pfState()
  s.placeMedia(s.doc.media, { resizeDocToFirst: true })
})
await page.waitForFunction(() => window.__pfState().doc.layers.length > 1, { timeout: 15000 })
await page.waitForTimeout(1800) // let autosave land

// Reload and restore, then import — the exact path that broke.
await page.reload({ waitUntil: 'networkidle' })
await page.waitForTimeout(1200)
await page.click('.recovery .btn.primary')
await page.waitForFunction(() => window.__pfState().doc.layers.length > 0, { timeout: 25000 })
await page.waitForTimeout(700)

// A single file into a document that already has layers also goes to the bin,
// so it is placed explicitly — this is the exact path that used to hand the new
// layer an id a restored layer already held.
await page.setInputFiles('.pf-media-input', 'public/test/greenscreen.gif')
await page.waitForFunction(() => window.__pfState().doc.media.length > 2, { timeout: 20000 })
await page.evaluate(() => {
  const s = window.__pfState()
  s.placeMedia([s.doc.media[s.doc.media.length - 1]])
})
await page.waitForFunction(() => window.__pfState().doc.layers.length > 2, { timeout: 20000 })
await page.waitForTimeout(700)

const after = await snapshot()
console.log('after restore + import:', JSON.stringify(after))
check('importing after a restored session issues a fresh id',
  after.duplicates.length === 0)
check('the selection matches exactly one layer', after.matched === 1)
check('only one row is highlighted', after.highlighted === 1)
check('the inspector shows that single layer',
  after.inspector !== 'Document' && !/layers$/.test(after.inspector || ''))
await page.screenshot({ path: path.join(OUT, '01-after-import.png') })

// Editing one layer must not touch its neighbour.
const isolation = await page.evaluate(() => {
  const s = window.__pfState()
  const [a, b] = s.doc.layers
  s.updateLayer(a.id, { x: 123 })
  const st = window.__pfState()
  return {
    a: st.doc.layers[0].x,
    b: st.doc.layers[1].x,
    differentIds: st.doc.layers[0].id !== st.doc.layers[1].id,
  }
})
console.log('isolation:', JSON.stringify(isolation))
check('editing one layer leaves the others alone',
  isolation.a === 123 && isolation.b !== 123 && isolation.differentIds)

// Deleting one must not take another with it.
const before = await page.evaluate(() => window.__pfState().doc.layers.length)
await page.evaluate(() => {
  const s = window.__pfState()
  s.removeLayers([s.doc.layers[0].id])
})
await page.waitForTimeout(300)
const remaining = await page.evaluate(() => window.__pfState().doc.layers.length)
console.log('layers before/after delete:', before, remaining)
check('deleting one layer removes exactly one', remaining === before - 1)

// --- deselection -------------------------------------------------------------
// A layer covering the whole canvas leaves no empty canvas to click, so the
// layers panel has to offer the way out.
await page.evaluate(() => {
  const s = window.__pfState()
  s.select([s.doc.layers[0].id])
})
await page.waitForTimeout(200)
check('a layer is selected to begin with',
  (await page.evaluate(() => window.__pfState().selectedIds.length)) === 1)

const list = await page.locator('.layer-list').boundingBox()
await page.mouse.click(list.x + list.width / 2, list.y + list.height - 10)
await page.waitForTimeout(300)
const cleared = await snapshot()
console.log('after clicking blank list space:', JSON.stringify(cleared.selectedIds))
check('clicking empty space in the layers panel deselects',
  cleared.selectedIds.length === 0 && cleared.highlighted === 0)
check('the inspector falls back to the document', cleared.inspector === 'Document')

// Clicking a row still selects it.
await page.locator('.layer').first().click()
await page.waitForTimeout(250)
check('clicking a row still selects it',
  (await page.evaluate(() => window.__pfState().selectedIds.length)) === 1)

// Escape clears too.
await page.keyboard.press('Escape')
await page.waitForTimeout(250)
check('Escape clears the selection',
  (await page.evaluate(() => window.__pfState().selectedIds.length)) === 0)
await page.screenshot({ path: path.join(OUT, '02-deselected.png') })

console.log(errors.length ? 'CONSOLE ERRORS: ' + errors.slice(0, 5).join(' | ') : 'no console errors')
await browser.close()
process.exit(checks.some(([, ok]) => !ok) ? 1 : 0)
