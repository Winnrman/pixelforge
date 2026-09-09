// Automatic backups.
//
// The failure this exists to prevent: you export a PNG, close the app, and the
// editable document is gone — you have the picture and no way back to the
// layers that made it. So a save and an export both quietly write a real .pfz,
// and the test that matters is that one of them can be loaded back into a
// document with its layers intact.
import { chromium } from 'playwright-core'
import { importAndPlace } from '../e2e-helpers.mjs'
import fs from 'fs'

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

check('backups are available at all', await page.evaluate(() => window.__pfState().backupsAvailable))

// Something identifiable to look for after the round trip.
const built = await page.evaluate(() => {
  const st = window.__pfState()
  st.setProjectName('Backup Test')
  const { makeTextLayer } = window.__pfStore
  st.addLayer(makeTextLayer({ text: 'RECOVER ME', size: 40, x: 20, y: 20, color: '#ffffff' }))
  return {
    layers: window.__pfState().doc.layers.length,
    text: window.__pfState().doc.layers.filter((l) => l.type === 'text').length,
  }
})
console.log('document:', JSON.stringify(built))
check('a document to back up', built.layers >= 2 && built.text === 1)

// --- a save writes one ----------------------------------------------------------
const saved = await page.evaluate(async () => {
  const r = await window.__pfState().backupNow('save')
  await window.__pfState().refreshBackups()
  return { r, list: window.__pfState().backups }
})
console.log('after a save:', JSON.stringify(saved.r), saved.list.length, 'stored')
check('saving writes a backup', saved.r.ok, JSON.stringify(saved.r))
check('and it turns up in the list', saved.list.length === 1, `${saved.list.length}`)
check('tagged with why it was written', saved.list[0]?.reason === 'save', saved.list[0]?.reason)
check('and with the project name', saved.list[0]?.name === 'Backup Test', saved.list[0]?.name)
check('and it is a real archive, not an empty file', saved.list[0]?.size > 1000,
  `${saved.list[0]?.size} bytes`)

// --- an unchanged document is not backed up again --------------------------------
// Otherwise the ring fills with identical copies and pushes out the older,
// genuinely different ones — which is the opposite of a safety net.
const again = await page.evaluate(async () => {
  const r = await window.__pfState().backupNow('save')
  await window.__pfState().refreshBackups()
  return { r, n: window.__pfState().backups.length }
})
console.log('backing up again unchanged:', JSON.stringify(again))
check('an unchanged document is not written twice', again.n === 1 && !again.r.ok,
  `${again.n} stored, skipped: ${again.r.skipped}`)

// --- an export writes one --------------------------------------------------------
const exported = await page.evaluate(async () => {
  const st = window.__pfState()
  st.updateLayer(st.doc.layers.find((l) => l.type === 'text').id, { text: 'CHANGED' })
  const r = await window.__pfState().backupNow('export')
  await window.__pfState().refreshBackups()
  return { r, list: window.__pfState().backups }
})
console.log('after an export:', exported.list.length, 'stored')
check('exporting writes one too', exported.r.ok && exported.list.length === 2,
  `${exported.list.length} stored`)
check('the newest is first', exported.list[0].reason === 'export', exported.list[0].reason)

// --- and it can actually be recovered ---------------------------------------------
// The whole point. Throw the document away, then bring it back from the backup
// taken before the change and check the older text is what returns.
const recovered = await page.evaluate(async () => {
  const st = window.__pfState()
  const older = st.backups.find((b) => b.reason === 'save')
  st.resetDoc()
  const before = window.__pfState().doc.layers.length
  const ok = await window.__pfState().restoreBackup(older)
  const doc = window.__pfState().doc
  return {
    ok,
    before,
    layers: doc.layers.length,
    text: doc.layers.filter((l) => l.type === 'text').map((l) => l.text),
    images: doc.layers.filter((l) => l.type === 'image').length,
    name: window.__pfState().projectName,
  }
})
console.log('recovered:', JSON.stringify(recovered))
check('the document was really cleared first', recovered.before === 0, `${recovered.before} left`)
check('a backup opens back into a document', recovered.ok)
check('with its layers', recovered.layers === built.layers, `${recovered.layers} layers`)
check('the text it had at the time', recovered.text.join() === 'RECOVER ME', recovered.text.join())
check('and its image assets, not just the JSON', recovered.images >= 1, `${recovered.images} images`)

// --- the assets really came back, not just references ------------------------------
// A .pfz that referenced assets it did not carry would restore a document full
// of blank layers, which looks like success until you look at the canvas.
const drew = await page.evaluate(() => {
  const st = window.__pfState()
  const c = document.createElement('canvas')
  c.width = st.doc.width
  c.height = st.doc.height
  const ctx = c.getContext('2d', { willReadFrequently: true })
  window.__pfRender.renderDocument(ctx, st.doc, 0)
  const d = ctx.getImageData(0, 0, c.width, c.height).data
  let opaque = 0
  for (let i = 3; i < d.length; i += 4) if (d[i] > 128) opaque++
  return opaque
})
console.log('opaque pixels after recovery:', drew)
check('and the recovered document actually draws', drew > 5000, `${drew} opaque px`)

console.log(errors.length ? 'CONSOLE ERRORS: ' + errors.slice(0, 5).join(' | ') : 'no console errors')
await browser.close()
process.exit(checks.some(([, ok]) => !ok) ? 1 : 0)
