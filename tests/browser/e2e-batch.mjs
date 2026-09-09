// Batch apply: one document, a folder of images, a folder of results.
//
// The thing worth proving is that only the nominated slot changes — the whole
// point is that thirty photos come back with the *same* treatment — and that
// each output really is built from its own input rather than from whatever was
// loaded first.
import { chromium } from 'playwright-core'
import { importAndPlace } from '../e2e-helpers.mjs'
import { unzipSync } from 'fflate'
import fs from 'fs'
import path from 'path'

const OUT = 'shots-batch'
fs.mkdirSync(OUT, { recursive: true })

const browser = await chromium.launch({
  executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  headless: true,
})
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
const errors = []
page.on('console', (m) => { // 'broken.png' is the deliberately corrupt file the resilience check feeds in.
  if (m.type() === 'error' && !/favicon|broken\.png/.test(m.text())) errors.push(m.text()) })
page.on('pageerror', (e) => errors.push('PAGEERROR: ' + e.message))

const checks = []
const check = (name, ok, detail = '') => {
  checks.push([name, ok])
  console.log((ok ? 'PASS  ' : 'FAIL  ') + name + (detail ? '  — ' + detail : ''))
}

await page.goto('http://localhost:5173/', { waitUntil: 'networkidle' })
await page.evaluate(() => indexedDB.deleteDatabase('pixelforge'))
await page.reload({ waitUntil: 'networkidle' })

// A recipe: a photo slot, a pixelate overlay over it, and a caption.
await importAndPlace(page, 'public/test/room.png', { timeout: 20000 })
await page.waitForTimeout(300)

const recipe = await page.evaluate(() => {
  const s = window.__pfState()
  const { makeEffectLayer, makeTextLayer } = window.__pfStore
  s.setPlaying(false)
  s.setTime(0)
  s.addLayer(makeEffectLayer({ name: 'Blur', shape: 'ellipse', x: 40, y: 40, w: 120, h: 120, pixelSize: 16 }))
  s.addLayer(makeTextLayer({ name: 'Caption', text: 'BATCHED', x: 20, y: 20, w: 260, size: 40, color: '#ff0000' }))
  const d = window.__pfState().doc
  return {
    slotId: d.layers[0].id,
    layers: d.layers.length,
    w: d.width,
    h: d.height,
  }
})
console.log('recipe:', JSON.stringify(recipe))
check('the recipe has a slot plus two overlays', recipe.layers === 3)

// Real Files, fetched in the page so they are genuine media rather than stubs.
const inputs = ['/test/greenscreen.gif', '/test/badloop.gif', '/test/room.png']
const prepared = await page.evaluate(async (urls) => {
  window.__batchFiles = []
  for (const u of urls) {
    const r = await fetch(u)
    const b = await r.blob()
    window.__batchFiles.push(new File([b], u.split('/').pop(), { type: b.type }))
  }
  return window.__batchFiles.map((f) => ({ name: f.name, size: f.size }))
}, inputs)
console.log('inputs:', JSON.stringify(prepared))
check('three real input files were prepared', prepared.length === 3 && prepared.every((f) => f.size > 100))

// --- docForAsset: only the slot moves ----------------------------------------
const swap = await page.evaluate(async ({ slotId }) => {
  const s = window.__pfState()
  const { docForAsset } = window.__pfBatch
  const asset = await window.__pfAssets.loadImageFile(window.__batchFiles[0])
  const before = s.doc
  const after = docForAsset(before, slotId, asset, 'cover')
  const overlayBefore = before.layers.filter((l) => l.id !== slotId)
  const overlayAfter = after.layers.filter((l) => l.id !== slotId)
  const slotAfter = after.layers.find((l) => l.id === slotId)
  return {
    docSize: [after.width, after.height],
    overlaysUnchanged: JSON.stringify(overlayBefore) === JSON.stringify(overlayAfter),
    slotAsset: slotAfter.assetId === asset.id,
    slotSrcCleared: !slotAfter.src,
    layerCount: after.layers.length,
    assetSize: [asset.width, asset.height],
    slotBox: [Math.round(slotAfter.w), Math.round(slotAfter.h)],
    originalIntact: s.doc === before,
  }
}, { slotId: recipe.slotId })
console.log('cover swap:', JSON.stringify(swap))
check('every overlay survives the swap byte for byte', swap.overlaysUnchanged)
check('the slot points at the new image', swap.slotAsset)
check('an inherited crop is cleared with the old image', swap.slotSrcCleared)
check('the canvas size is kept, so overlays stay put', swap.docSize[0] === recipe.w && swap.docSize[1] === recipe.h,
  swap.docSize.join('x'))
check('the batch never mutates the open document', swap.originalIntact)

// 'cover' must fill the slot box: the shorter side matches, the longer overflows.
const covered = await page.evaluate(async ({ slotId }) => {
  const s = window.__pfState()
  const { docForAsset } = window.__pfBatch
  const slot = s.doc.layers.find((l) => l.id === slotId)
  const asset = await window.__pfAssets.loadImageFile(window.__batchFiles[0])
  const cover = docForAsset(s.doc, slotId, asset, 'cover').layers.find((l) => l.id === slotId)
  const contain = docForAsset(s.doc, slotId, asset, 'contain').layers.find((l) => l.id === slotId)
  const ar = asset.width / asset.height
  return {
    slot: [slot.w, slot.h],
    cover: [cover.w, cover.h],
    contain: [contain.w, contain.h],
    coverAr: cover.w / cover.h,
    containAr: contain.w / contain.h,
    sourceAr: ar,
  }
}, { slotId: recipe.slotId })
console.log('fit modes:', JSON.stringify(covered))
check('cover fills the slot on both axes',
  covered.cover[0] >= covered.slot[0] - 0.5 && covered.cover[1] >= covered.slot[1] - 0.5,
  `${covered.cover.map(Math.round)} into ${covered.slot.map(Math.round)}`)
check('contain fits inside it',
  covered.contain[0] <= covered.slot[0] + 0.5 && covered.contain[1] <= covered.slot[1] + 0.5,
  `${covered.contain.map(Math.round)} into ${covered.slot.map(Math.round)}`)
check('neither mode distorts the image',
  Math.abs(covered.coverAr - covered.sourceAr) < 0.01 && Math.abs(covered.containAr - covered.sourceAr) < 0.01,
  `${covered.coverAr.toFixed(3)} / ${covered.containAr.toFixed(3)} vs ${covered.sourceAr.toFixed(3)}`)

// 'native' resizes the canvas per image and scales the overlays with it.
const nat = await page.evaluate(async ({ slotId }) => {
  const s = window.__pfState()
  const { docForAsset } = window.__pfBatch
  const asset = await window.__pfAssets.loadImageFile(window.__batchFiles[0])
  const before = s.doc.layers.find((l) => l.type === 'effect')
  const after = docForAsset(s.doc, slotId, asset, 'native')
  const ov = after.layers.find((l) => l.id === before.id)
  return {
    doc: [after.width, after.height],
    asset: [asset.width, asset.height],
    overlayBefore: [before.x, before.y, before.w],
    overlayAfter: [Math.round(ov.x), Math.round(ov.y), Math.round(ov.w)],
    kx: after.width / s.doc.width,
  }
}, { slotId: recipe.slotId })
console.log('native fit:', JSON.stringify(nat))
check('native resizes the canvas to the image', nat.doc[0] === nat.asset[0] && nat.doc[1] === nat.asset[1],
  nat.doc.join('x'))
check('and moves the overlay by the same factor',
  Math.abs(nat.overlayAfter[0] - nat.overlayBefore[0] * nat.kx) < 1.5,
  `x ${nat.overlayBefore[0]} -> ${nat.overlayAfter[0]} at ${nat.kx.toFixed(2)}x`)

// --- each output really comes from its own input -----------------------------
const distinct = await page.evaluate(async ({ slotId }) => {
  const s = window.__pfState()
  const { docForAsset } = window.__pfBatch
  const sigs = []
  for (const f of window.__batchFiles) {
    const asset = await window.__pfAssets.loadImageFile(f)
    const d = docForAsset(s.doc, slotId, asset, 'cover')
    const c = document.createElement('canvas')
    c.width = d.width
    c.height = d.height
    const ctx = c.getContext('2d', { willReadFrequently: true })
    window.__pfRender.renderDocument(ctx, d, 0)
    const px = ctx.getImageData(0, 0, c.width, c.height).data
    let h = 0
    for (let i = 0; i < px.length; i += 997) h = (h * 31 + px[i]) >>> 0
    sigs.push(h)
  }
  return sigs
}, { slotId: recipe.slotId })
console.log('render signatures:', JSON.stringify(distinct))
check('every input produces a different render', new Set(distinct).size === 3, distinct.join(', '))

// --- the whole run, delivered as a zip in the browser -------------------------
const dl = page.waitForEvent('download', { timeout: 120000 })
const summary = await page.evaluate(async ({ slotId }) => {
  const s = window.__pfState()
  const out = await window.__pfBatch.runBatch({
    doc: s.doc,
    slotId,
    files: window.__batchFiles,
    fit: 'cover',
    format: 'png',
    scale: 1,
  })
  return { results: out.results.map((r) => r.name), failures: out.failures, zipPath: out.zipPath }
}, { slotId: recipe.slotId })
console.log('batch summary:', JSON.stringify(summary))

const file = path.join(OUT, 'batch.zip')
await (await dl).saveAs(file)
const entries = unzipSync(new Uint8Array(fs.readFileSync(file)))
const names = Object.keys(entries).sort()
console.log('zip entries:', JSON.stringify(names.map((n) => [n, entries[n].length])))
check('the browser gets one zip rather than three downloads', fs.existsSync(file))
check('it holds one output per input', names.length === 3, names.join(', '))
check('outputs are named after their inputs, with the new extension',
  names.join(',') === 'badloop.png,greenscreen.png,room.png', names.join(','))
check('every output is a real PNG',
  names.every((n) => entries[n].length > 1000 && entries[n][1] === 0x50 && entries[n][2] === 0x4e),
  names.map((n) => `${n} ${entries[n].length}B`).join(', '))
check('nothing failed', summary.failures.length === 0, JSON.stringify(summary.failures))

// A file that is not decodable must be reported, not silently dropped and not
// allowed to abandon the rest of the run.
const resilient = await page.evaluate(async ({ slotId }) => {
  const s = window.__pfState()
  const junk = new File([new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8])], 'broken.png', { type: 'image/png' })
  const out = await window.__pfBatch.runBatch({
    doc: s.doc,
    slotId,
    files: [junk, window.__batchFiles[2]],
    fit: 'cover',
    format: 'png',
    scale: 1,
  })
  return { ok: out.results.length, failed: out.failures.map((f) => f.name) }
}, { slotId: recipe.slotId })
console.log('with one bad file:', JSON.stringify(resilient))
check('one bad file does not abandon the run', resilient.ok === 1, `${resilient.ok} succeeded`)
check('and the failure is reported by name', resilient.failed.includes('broken.png'), resilient.failed.join(', '))

await page.screenshot({ path: path.join(OUT, '01-batch.png') })
console.log(errors.length ? 'CONSOLE ERRORS: ' + errors.slice(0, 5).join(' | ') : 'no console errors')
await browser.close()
process.exit(checks.some(([, ok]) => !ok) ? 1 : 0)
