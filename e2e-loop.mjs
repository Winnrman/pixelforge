// Loop repair, cinemagraph freeze, and cursor-following zoom, wired end to end.
//
// The unit suites (test-loop.mjs, test-cursor.mjs) already prove the maths.
// What this checks is the part they cannot: that the editor actually samples
// the repaired timeline, that a freeze really only lets the mask through, and
// that the cursor pass writes editable keyframes onto the layer.
import { chromium } from 'playwright-core'
import { importAndPlace } from './e2e-helpers.mjs'
import fs from 'fs'
import path from 'path'

const OUT = 'shots-loop'
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

const fresh = async (fixture) => {
  await page.evaluate(() => window.__pfState().resetDoc())
  await page.waitForTimeout(150)
  await importAndPlace(page, fixture, { timeout: 20000 })
  await page.evaluate(() => { window.__pfState().setPlaying(false); window.__pfState().setTime(0) })
  await page.waitForTimeout(350)
  return page.evaluate(() => window.__pfState().doc.layers[0].id)
}

/** Which fixture frame is on screen, read from the disc's known position. */
const discCentre = (t) => page.evaluate((t) => {
  const s = window.__pfState()
  const c = document.createElement('canvas')
  c.width = s.doc.width
  c.height = s.doc.height
  const ctx = c.getContext('2d', { willReadFrequently: true })
  window.__pfRender.renderDocument(ctx, s.doc, t)
  const d = ctx.getImageData(0, 0, c.width, c.height).data
  let sx = 0, sy = 0, n = 0
  for (let y = 0; y < c.height; y++) {
    for (let x = 0; x < c.width; x++) {
      const i = (y * c.width + x) * 4
      if (d[i] > 170 && d[i + 1] < 140) { sx += x; sy += y; n++ }
    }
  }
  return n ? { x: sx / n, y: sy / n, n } : null
}, t)

// ---------------------------------------------------------------- loop repair
const id = await fresh('public/test/greenscreen.gif')
const base = await page.evaluate(() => {
  const s = window.__pfState()
  const a = window.__pfAssets.getAsset(s.doc.layers[0].assetId)
  return { frames: a.frames.length, duration: Math.round(a.duration), docDuration: Math.round(s.duration) }
})
console.log('fixture:', JSON.stringify(base))

// The green-screen disc travels a full circle, so it already loops perfectly.
// A recommendation that admits this is the honest answer.
const rec = await page.evaluate((id) => window.__pfState().analyzeLoop(id), id)
console.log('recommendation:', JSON.stringify(rec))
check('analyse returns a recommendation with a reason', !!rec && typeof rec.note === 'string', rec?.note)
check('it does not invent a repair for a clip that already loops',
  rec.mode === 'none' && rec.crossfadeMs === 0, `mode=${rec.mode} crossfade=${rec.crossfadeMs}`)

// Ping-pong must double the timeline and retrace the outward path.
await page.evaluate((id) => window.__pfState().setLoop(id, { on: true, mode: 'pingpong' }), id)
await page.waitForTimeout(300)
const pp = await page.evaluate(() => Math.round(window.__pfState().duration))
console.log('ping-pong document duration:', pp, 'vs', base.docDuration)
check('ping-pong roughly doubles the timeline', pp > base.docDuration * 1.8 && pp < base.docDuration * 2.1,
  `${base.docDuration}ms -> ${pp}ms`)

// Same position on the way out and on the way back.
const outbound = await discCentre(300)
const ret = await discCentre(pp - 300)
console.log('outbound', JSON.stringify(outbound), 'return', JSON.stringify(ret))
const mirrored = outbound && ret && Math.hypot(outbound.x - ret.x, outbound.y - ret.y)
// The remap lands on frame boundaries, so the mirrored sample can be one frame
// off. On this fixture the disc travels about 24px per frame, so the tolerance
// is one frame of travel rather than an arbitrary number.
check('the return pass retraces the outward path', mirrored !== null && mirrored < 30,
  `centres ${mirrored?.toFixed(1)}px apart, one frame of travel is ~24px`)

// Switching it off restores the original exactly — it is a remap, not a bake.
await page.evaluate((id) => window.__pfState().setLoop(id, { on: false, mode: 'none', crossfadeMs: 0, trimEndMs: 0 }), id)
await page.waitForTimeout(250)
const restored = await page.evaluate(() => Math.round(window.__pfState().duration))
check('turning it off restores the original clip', restored === base.docDuration,
  `${restored}ms vs ${base.docDuration}ms`)
await page.screenshot({ path: path.join(OUT, '01-loop.png') })

// --- a clip that genuinely does not loop --------------------------------------
// The green-screen disc travels a full circle, so its first and last frames very
// nearly coincide: a crossfade there blends two almost identical images and has
// nothing measurable to show. badloop.gif walks a disc left to right instead, so
// the seam is a real jump and the blend is two clearly separated discs.
const idBad = await fresh('public/test/badloop.gif')
const badBase = await page.evaluate(() => {
  const a = window.__pfAssets.getAsset(window.__pfState().doc.layers[0].assetId)
  return { duration: Math.round(a.duration), frames: a.frames.length }
})
const badRec = await page.evaluate((id) => window.__pfState().analyzeLoop(id), idBad)
console.log('bad-loop recommendation:', JSON.stringify(badRec))
check('a broken loop is called broken', badRec.mode !== 'none' || badRec.trimEndMs > 0, badRec.note)

await page.evaluate((id) => window.__pfState().setLoop(id, { on: true, mode: 'crossfade', crossfadeMs: 300 }), idBad)
await page.waitForTimeout(300)
const cf = await page.evaluate(() => Math.round(window.__pfState().duration))
console.log('crossfade duration:', cf, 'source', badBase.duration)
check('a crossfade consumes its own tail', Math.abs(cf - (badBase.duration - 300)) < 40,
  `${cf}ms, expected about ${badBase.duration - 300}ms`)

// Mid-blend, both the tail disc and the head disc are on screen at once.
const blobs = await page.evaluate((t) => {
  const s = window.__pfState()
  const c = document.createElement('canvas')
  c.width = s.doc.width
  c.height = s.doc.height
  const ctx = c.getContext('2d', { willReadFrequently: true })
  window.__pfRender.renderDocument(ctx, s.doc, t)
  const d = ctx.getImageData(0, 0, c.width, c.height).data
  const cols = new Set()
  for (let y = 0; y < c.height; y++) {
    for (let x = 0; x < c.width; x++) {
      const i = (y * c.width + x) * 4
      if (d[i] > 120 && d[i + 1] < 140 && d[i + 2] < 120) cols.add(x >> 3)
    }
  }
  const runs = []
  let prev = -99
  for (const v of [...cols].sort((a, b) => a - b)) {
    if (v - prev > 1) runs.push([v, v])
    else runs[runs.length - 1][1] = v
    prev = v
  }
  return { runs: runs.length, spans: runs }
}, cf - 150)
console.log('separate subject blobs near the seam:', JSON.stringify(blobs))
check('the crossfade really blends two frames', blobs.runs >= 2, `${blobs.runs} blobs`)

// ---------------------------------------------------------------- cinemagraph
const id2 = await fresh('public/test/greenscreen.gif')

// Refuses without a mask, rather than silently freezing everything.
await page.evaluate((id) => window.__pfState().setFreeze(id, true), id2)
const refused = await page.evaluate(() => ({
  on: !!window.__pfState().doc.layers[0].freeze?.on,
  notice: window.__pfState().notice?.text,
}))
console.log('without a mask:', JSON.stringify(refused))
check('freeze refuses without a mask and says why', !refused.on && /lasso/i.test(refused.notice || ''),
  refused.notice)

// A mask over the left half: the right half must stop moving, the left must not.
await page.evaluate((id) => {
  const s = window.__pfState()
  // setMask only patches an existing mask, so the mask is written directly.
  // Mask points are [x, y] pairs normalised to the layer box, not document
  // pixels — this is the left half of the layer.
  s.updateLayer(id, {
    mask: { points: [[0, 0], [0.5, 0], [0.5, 1], [0, 1]], feather: 0, invert: false },
  })
  s.setFreeze(id, true)
}, id2)
await page.waitForTimeout(300)

/** Mean absolute difference between two rendered times, per half of the frame. */
const halves = await page.evaluate(([t1, t2]) => {
  const s = window.__pfState()
  const grab = (t) => {
    const c = document.createElement('canvas')
    c.width = s.doc.width
    c.height = s.doc.height
    const ctx = c.getContext('2d', { willReadFrequently: true })
    window.__pfRender.renderDocument(ctx, s.doc, t)
    return ctx.getImageData(0, 0, c.width, c.height)
  }
  const a = grab(t1)
  const b = grab(t2)
  const W = a.width
  let leftSum = 0, leftN = 0, rightSum = 0, rightN = 0
  for (let y = 0; y < a.height; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4
      const diff = Math.abs(a.data[i] - b.data[i]) + Math.abs(a.data[i + 1] - b.data[i + 1])
      if (x < 160) { leftSum += diff; leftN++ } else { rightSum += diff; rightN++ }
    }
  }
  return { left: leftSum / leftN, right: rightSum / rightN }
}, [200, 900])
console.log('change between t=200 and t=900:', JSON.stringify(halves))
check('the masked half keeps moving', halves.left > 4, `mean change ${halves.left.toFixed(2)}`)
check('everything outside the mask is frozen still', halves.right < 0.5, `mean change ${halves.right.toFixed(3)}`)
await page.screenshot({ path: path.join(OUT, '02-cinemagraph.png') })

// -------------------------------------------------------------- cursor zoom
const id3 = await fresh('public/test/screencast.gif')
const t0 = Date.now()
await page.evaluate((id) => window.__pfState().autoCursorZoom(id, { fps: 25 }), id3)
const took = Date.now() - t0
const cz = await page.evaluate(() => {
  const s = window.__pfState()
  const l = s.doc.layers[0]
  const tr = l.tracks || {}
  // valueAt takes the layer, not a bare track.
  const at = (name, t) => window.__pfKeys.valueAt(l, name, t)
  return {
    notice: s.notice?.text,
    zoomKeys: tr.zoom?.length || 0,
    panKeys: tr.panX?.length || 0,
    // 84 frames at 40ms: dwell to 1360ms, a 160ms flick, then dwell again.
    // Sampled at the END of each dwell, because the zoom ramps in over ~450ms
    // and the middle of a dwell is still mid-move.
    dwellA: at('zoom', 1320),
    flick: at('zoom', 1560),
    dwellB: at('zoom', 3200),
    panSpan: tr.panX ? Math.max(...tr.panX.map((k) => k.v)) - Math.min(...tr.panX.map((k) => k.v)) : 0,
  }
})
console.log('cursor zoom (' + took + 'ms):', JSON.stringify(cz))
check('it reports what it found', !!cz.notice, cz.notice)
check('it writes zoom and pan keyframes', cz.zoomKeys > 2 && cz.panKeys > 2,
  `${cz.zoomKeys} zoom, ${cz.panKeys} pan`)
check('the keyframes are sparse, not one per frame', cz.zoomKeys < 45, `${cz.zoomKeys} keys for 84 frames`)
check('it zooms in while the pointer dwells', cz.dwellA > 1.2 && cz.dwellB > 1.2,
  `${cz.dwellA?.toFixed(2)} and ${cz.dwellB?.toFixed(2)}`)
check('and pulls out for the fast flick', cz.flick < cz.dwellA - 0.15 && cz.flick < cz.dwellB - 0.15,
  `flick ${cz.flick?.toFixed(2)} vs dwells ${cz.dwellA?.toFixed(2)}/${cz.dwellB?.toFixed(2)}`)
check('the camera actually travels across the frame', cz.panSpan > 0.1, `pan span ${cz.panSpan?.toFixed(3)}`)

// Nothing to follow: it must decline rather than invent a camera move.
const id4 = await fresh('public/test/motion.gif')
await page.evaluate((id) => window.__pfState().autoCursorZoom(id, { fps: 20 }), id4)
const declined = await page.evaluate(() => ({
  notice: window.__pfState().notice?.text,
  zoomKeys: window.__pfState().doc.layers[0].tracks?.zoom?.length || 0,
}))
console.log('on footage with no cursor:', JSON.stringify(declined))
check('it declines footage that has no cursor in it', declined.zoomKeys === 0, declined.notice)
await page.screenshot({ path: path.join(OUT, '03-cursor.png') })

console.log(errors.length ? 'CONSOLE ERRORS: ' + errors.slice(0, 5).join(' | ') : 'no console errors')
await browser.close()
process.exit(checks.some(([, ok]) => !ok) ? 1 : 0)
