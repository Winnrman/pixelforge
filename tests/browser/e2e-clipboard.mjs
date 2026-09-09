// Copy and paste, with two clipboards in play.
//
// Layers copied in the app go into the store; the operating system has its own
// clipboard, and pasting a screenshot straight onto the canvas is a real feature
// that reads from it. The bug was the order between them: a file on the system
// clipboard always won, so a screenshot taken an hour ago beat a layer copied a
// second ago and went on beating it for as long as it sat there. Ctrl+C then
// Ctrl+V quietly added the old picture to Media instead of duplicating the
// layer, which reads exactly like copy and paste not working at all.
//
// So the fixture is the state a real machine is usually in: something already on
// the system clipboard.
import { chromium } from 'playwright-core'
import fs from 'fs'
import path from 'path'

const OUT = 'shots-clipboard'
fs.mkdirSync(OUT, { recursive: true })

const browser = await chromium.launch({
  executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  headless: true,
})
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } })
// Reading and writing the clipboard from the page is how the fixture is built.
await ctx.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: 'http://localhost:5173' })
const page = await ctx.newPage()
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

/** Puts a picture on the system clipboard, the way any screenshot tool would. */
const putImageOnClipboard = () => page.evaluate(async () => {
  const c = document.createElement('canvas')
  c.width = 64
  c.height = 48
  const x = c.getContext('2d')
  x.fillStyle = '#d94f4f'
  x.fillRect(0, 0, 64, 48)
  const blob = await new Promise((r) => c.toBlob(r, 'image/png'))
  await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })])
  return true
})

const clipboardText = () => page.evaluate(() => navigator.clipboard.readText().catch(() => null))

const state = () => page.evaluate(() => {
  const s = window.__pfState()
  return {
    layers: s.doc.layers.length,
    names: s.doc.layers.map((l) => `${l.type}:${l.name}`),
    assets: Object.keys(s.assets || {}).length,
    clip: s.clipboard.length,
    owned: s.clipboardOwned,
    notice: s.notice?.text || '',
  }
})

// A picture on the canvas, and an effect layer over it — the two kinds named in
// the report.
const setup = await page.evaluate(async () => {
  const c = document.createElement('canvas')
  c.width = 200
  c.height = 140
  const x = c.getContext('2d')
  x.fillStyle = '#3a6ea5'
  x.fillRect(0, 0, 200, 140)
  const blob = await new Promise((r) => c.toBlob(r, 'image/png'))
  const a = await window.__pfAssets.loadImageFile(
    new File([blob], 'shot.png', { type: 'image/png' }))
  const st = window.__pfState()
  st.placeMedia([a.id], { resizeDocToFirst: true })
  await new Promise((r) => setTimeout(r, 400))
  st.setPlaying(false)
  const { makeEffectLayer } = window.__pfStore
  window.__pfState().addLayer(makeEffectLayer({
    name: 'Pixelate ellipse', shape: 'ellipse', effect: 'pixelate', pixelSize: 12,
    x: 40, y: 30, w: 80, h: 60,
  }))
  await new Promise((r) => setTimeout(r, 300))
  const s = window.__pfState()
  return { image: s.doc.layers[0].id, effect: s.doc.layers.find((l) => l.type === 'effect').id }
})

await putImageOnClipboard()
const before = await state()
console.log('to begin with:', JSON.stringify(before))
check('a picture and an effect layer to work with', before.layers === 2, JSON.stringify(before.names))

// --- copying a layer with something already on the system clipboard ----------
await page.evaluate((id) => window.__pfState().select([id]), setup.image)
await page.keyboard.press('Control+c')
await page.waitForTimeout(400)
const copied = await state()
console.log('after Ctrl+C:', JSON.stringify(copied))
check('the layer is copied', copied.clip === 1, `${copied.clip} in the clipboard`)
// Taking the system clipboard over is what makes "whatever you copied last"
// answerable at all: there is no way to ask the system when its clipboard was
// filled, so an in-app copy has to become its contents.
check('and the copy takes over the system clipboard', copied.owned === true)
const text = await clipboardText()
console.log('the system clipboard now reads:', JSON.stringify(text))
check('with something a person could read if they pasted it elsewhere',
  /PixelForge/.test(text || ''), String(text))

await page.keyboard.press('Control+v')
await page.waitForTimeout(600)
const pasted = await state()
console.log('after Ctrl+V:', JSON.stringify(pasted))
// The bug: this added the 64x48 red picture to Media and left the canvas alone.
check('pasting duplicates the layer', pasted.layers === before.layers + 1,
  `${before.layers} -> ${pasted.layers}`)
check('and it is the layer that was copied', /shot\.png copy/.test(pasted.names.join('|')),
  JSON.stringify(pasted.names))
check('rather than the picture that was already on the system clipboard',
  pasted.assets === before.assets, `${before.assets} -> ${pasted.assets} assets`)
await page.screenshot({ path: path.join(OUT, '01-pasted.png') })

// Pressing it again gives another one, rather than one and then nothing.
await page.keyboard.press('Control+v')
await page.waitForTimeout(500)
const twice = await state()
console.log('after a second Ctrl+V:', JSON.stringify(twice))
check('and pasting again gives another', twice.layers === before.layers + 2,
  `${twice.layers} layers`)

// --- effect layers copy too ---------------------------------------------------
await page.evaluate((id) => window.__pfState().select([id]), setup.effect)
await page.keyboard.press('Control+c')
await page.waitForTimeout(400)
await page.keyboard.press('Control+v')
await page.waitForTimeout(600)
const fx = await page.evaluate(() => ({
  effects: window.__pfState().doc.layers.filter((l) => l.type === 'effect').length,
  names: window.__pfState().doc.layers.filter((l) => l.type === 'effect').map((l) => l.name),
}))
console.log('effect layers:', JSON.stringify(fx))
check('an effect layer copies and pastes like anything else', fx.effects === 2,
  JSON.stringify(fx.names))

// --- cut ----------------------------------------------------------------------
const beforeCut = (await state()).layers
const cut = await page.evaluate(() => {
  const s = window.__pfState()
  const fxs = s.doc.layers.filter((l) => l.type === 'effect')
  s.select([fxs[fxs.length - 1].id])
  return true
})
await page.keyboard.press('Control+x')
await page.waitForTimeout(400)
const afterCut = await state()
check('cut takes the layer away', afterCut.layers === beforeCut - 1,
  `${beforeCut} -> ${afterCut.layers}`)
await page.keyboard.press('Control+v')
await page.waitForTimeout(600)
const afterCutPaste = await state()
check('and pasting brings it back', afterCutPaste.layers === beforeCut,
  `${afterCutPaste.layers} layers`)

// --- and a picture copied afterwards takes the lead back ------------------------
// The other half of the trade, and the half a blunt "layers always win" would
// have broken: pasting a screenshot straight in is a real feature. Copying
// outside replaces the text the in-app copy left on the system clipboard, so a
// file being there again is proof it is the newer of the two — which is the
// whole reason the copy bothers to claim it.
const beforeOutside = await state()
check('layers are still sitting in the in-app clipboard', beforeOutside.clip > 0)
await putImageOnClipboard()
await page.keyboard.press('Control+v')
await page.waitForTimeout(900)
const afterOutside = await state()
console.log('pasting a picture copied after the layer:', JSON.stringify(afterOutside))
check('a picture copied after the layer wins, and comes in as media',
  /Media/.test(afterOutside.notice) && afterOutside.layers === beforeOutside.layers,
  `notice ${JSON.stringify(afterOutside.notice)}, ${beforeOutside.layers} -> ${afterOutside.layers} layers`)

console.log(errors.length ? 'CONSOLE ERRORS: ' + errors.slice(0, 5).join(' | ') : 'no console errors')
await browser.close()
process.exit(checks.some(([, ok]) => !ok) ? 1 : 0)
