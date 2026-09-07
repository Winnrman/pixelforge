// A real project file, for testing that double-clicking one opens it.
//
// Built by the app's own packer rather than assembled by hand here: a fixture
// written to a second implementation of the format would keep passing after the
// real one changed, which is the opposite of what a fixture is for.
//
// Needs the dev server running (`npm run dev`).
import { chromium } from 'playwright-core'
import fs from 'fs'

const OUT = 'public/test/sample.pfz'
const NAME = 'Sample Project'

const browser = await chromium.launch({
  executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  headless: true,
})
const page = await browser.newPage()
page.on('pageerror', (e) => console.error('PAGEERROR', e.message))
await page.goto('http://localhost:5173/', { waitUntil: 'networkidle' })

const bytes = await page.evaluate(async (name) => {
  const st = window.__pfState()
  st.resetDoc()
  // An image and a title, so opening it can be told apart from opening nothing.
  const blob = await (await fetch('/test/room.png')).blob()
  const asset = await window.__pfAssets.loadImageFile(
    new File([blob], 'room.png', { type: 'image/png' }))
  window.__pfState().placeMedia([asset.id], { resizeDocToFirst: true })
  const { makeTextLayer } = window.__pfStore
  window.__pfState().addLayer(makeTextLayer({
    text: 'OPENED FROM DISK', size: 28, x: 12, y: 12, color: '#ffffff',
  }))
  window.__pfState().setProjectName(name)
  const doc = window.__pfState().doc
  const packed = await window.__pfProject.packProject(doc, { time: 0, name })
  return [...new Uint8Array(await packed.arrayBuffer())]
}, NAME)

fs.writeFileSync(OUT, Buffer.from(bytes))
console.log(`wrote ${OUT}  ${(bytes.length / 1024).toFixed(1)} KB`)
await browser.close()
