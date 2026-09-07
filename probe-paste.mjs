import { chromium } from 'playwright-core'
const browser = await chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true })
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
page.on('pageerror', (e) => console.log('PAGEERROR:', e.message))
await page.goto('http://localhost:5173/', { waitUntil: 'networkidle' })
await page.evaluate(() => indexedDB.deleteDatabase('pixelforge'))
await page.reload({ waitUntil: 'networkidle' })

// Watch whether the events even arrive.
await page.evaluate(() => {
  window.__seen = { paste: 0, copy: 0, keyv: 0, keyc: 0 }
  window.addEventListener('paste', () => { window.__seen.paste++ }, true)
  window.addEventListener('copy', () => { window.__seen.copy++ }, true)
  window.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'v') window.__seen.keyv++
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'c') window.__seen.keyc++
  }, true)
})

await page.evaluate(async () => {
  const c = document.createElement('canvas')
  c.width = 200; c.height = 140
  const x = c.getContext('2d'); x.fillStyle = '#3a6ea5'; x.fillRect(0, 0, 200, 140)
  const blob = await new Promise((r) => c.toBlob(r, 'image/png'))
  const a = await window.__pfAssets.loadImageFile(new File([blob], 'p.png', { type: 'image/png' }))
  window.__pfState().placeMedia([a.id], { resizeDocToFirst: true })
  await new Promise((r) => setTimeout(r, 500))
  window.__pfState().setPlaying(false)
  // And an effect layer, since that is the other half of the report.
  const { makeEffectLayer } = window.__pfStore
  window.__pfState().addLayer(makeEffectLayer({
    name: 'Pixelate ellipse', shape: 'ellipse', effect: 'pixelate', pixelSize: 12,
    x: 40, y: 30, w: 80, h: 60,
  }))
  await new Promise((r) => setTimeout(r, 300))
})

const start = await page.evaluate(() => ({
  layers: window.__pfState().doc.layers.length,
  ids: window.__pfState().doc.layers.map((l) => `${l.type}:${l.name}`),
  focus: document.activeElement?.tagName,
}))
console.log('start:', JSON.stringify(start))

// Select the image layer and copy/paste with real keys.
await page.evaluate(() => {
  const st = window.__pfState()
  st.select([st.doc.layers[0].id])
})
await page.keyboard.press('Control+c')
await page.waitForTimeout(200)
const copied = await page.evaluate(() => ({
  clipboard: window.__pfState().clipboard.length,
  notice: window.__pfState().notice?.text,
  seen: window.__seen,
}))
console.log('after Ctrl+C:', JSON.stringify(copied))

await page.keyboard.press('Control+v')
await page.waitForTimeout(400)
const pasted = await page.evaluate(() => ({
  layers: window.__pfState().doc.layers.length,
  names: window.__pfState().doc.layers.map((l) => `${l.type}:${l.name}`),
  notice: window.__pfState().notice?.text,
  seen: window.__seen,
}))
console.log('after Ctrl+V:', JSON.stringify(pasted))

// Now the effect layer.
await page.evaluate(() => {
  const st = window.__pfState()
  const fx = st.doc.layers.find((l) => l.type === 'effect')
  st.select([fx.id])
})
await page.keyboard.press('Control+c')
await page.waitForTimeout(150)
await page.keyboard.press('Control+v')
await page.waitForTimeout(400)
const fx = await page.evaluate(() => ({
  layers: window.__pfState().doc.layers.length,
  effects: window.__pfState().doc.layers.filter((l) => l.type === 'effect').length,
  seen: window.__seen,
}))
console.log('effect copy/paste:', JSON.stringify(fx))

// And the store action directly, to separate wiring from logic.
const direct = await page.evaluate(() => {
  const st = window.__pfState()
  st.select([st.doc.layers[0].id])
  st.copyLayers(st.selectedIds)
  const n = st.pasteLayers()
  return { n, layers: window.__pfState().doc.layers.length }
})
console.log('calling the actions directly:', JSON.stringify(direct))
await browser.close()
