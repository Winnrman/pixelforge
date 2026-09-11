// Removing a watermark, through the real button.
//
// The fixture is what the feature is for: a photograph-like picture with a
// mark stamped over it the way proofs are marked — a word, tilted, faint
// white, on a slanted grid right across it. The mark is also drawn on its own,
// so the result is judged against the picture without it, pixel by pixel.
import { chromium } from 'playwright-core'
import fs from 'fs'

const OUT = 'shots/watermark'
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

const helpers = () => {
  const W = 900
  const H = 600
  const V1 = [240, 0]
  const V2 = [120, 150]
  const O = [70, 40]
  window.__wm = { W, H }
  // A photograph, near enough: a gradient, soft shapes, grain — from a seed.
  window.__photo = () => {
    const c = document.createElement('canvas')
    c.width = W
    c.height = H
    const g = c.getContext('2d', { willReadFrequently: true })
    const bg = g.createLinearGradient(0, 0, W, H)
    bg.addColorStop(0, '#2d4a6b')
    bg.addColorStop(0.5, '#8a6f4d')
    bg.addColorStop(1, '#3c5a3a')
    g.fillStyle = bg
    g.fillRect(0, 0, W, H)
    let s = 99
    const r = () => ((s = (Math.imul(s, 1103515245) + 12345) >>> 0) / 4294967296)
    g.filter = 'blur(18px)'
    for (let i = 0; i < 40; i++) {
      g.fillStyle = `hsl(${Math.floor(r() * 360)} ${40 + Math.floor(r() * 40)}% ${25 + Math.floor(r() * 50)}%)`
      g.beginPath()
      g.ellipse(r() * W, r() * H, 20 + r() * 110, 20 + r() * 80, r() * 3, 0, Math.PI * 2)
      g.fill()
    }
    g.filter = 'none'
    const img = g.getImageData(0, 0, W, H)
    for (let i = 0; i < img.data.length; i += 4) {
      const n = (r() - 0.5) * 18
      img.data[i] += n
      img.data[i + 1] += n
      img.data[i + 2] += n
    }
    g.putImageData(img, 0, 0)
    return c
  }
  // The mark, stamped on its grid: once over the photograph, once alone.
  window.__stamp = (g, alpha = 0.35) => {
    let placed = 0
    for (let n = -6; n <= 6; n++) {
      for (let m = -6; m <= 6; m++) {
        const x = O[0] + m * V1[0] + n * V2[0]
        const y = O[1] + m * V1[1] + n * V2[1]
        if (x < -200 || y < -100 || x > W + 200 || y > H + 100) continue
        if (x >= 0 && x < W && y >= 0 && y < H) placed++
        g.save()
        g.translate(x, y)
        g.rotate((-30 * Math.PI) / 180)
        g.globalAlpha = alpha
        g.fillStyle = '#ffffff'
        g.font = 'bold 30px Arial'
        g.textAlign = 'center'
        g.textBaseline = 'middle'
        g.fillText('© PIXELFORGE', 0, 0)
        g.restore()
      }
    }
    return placed
  }
  window.__marked = () => {
    const c = window.__photo()
    const placed = window.__stamp(c.getContext('2d'))
    return { canvas: c, placed }
  }
  window.__markOnly = () => {
    const c = document.createElement('canvas')
    c.width = W
    c.height = H
    window.__stamp(c.getContext('2d'), 1)
    return c.getContext('2d').getImageData(0, 0, W, H).data
  }
  window.__render = () => {
    const st = window.__pfState()
    const c = document.createElement('canvas')
    c.width = st.doc.width
    c.height = st.doc.height
    window.__pfRender.renderDocument(c.getContext('2d', { willReadFrequently: true }), st.doc, 0)
    return c.getContext('2d').getImageData(0, 0, c.width, c.height).data
  }
  /** Error against the clean photograph under the mark and away from it. */
  window.__score = () => {
    const got = window.__render()
    const want = window.__photo().getContext('2d').getImageData(0, 0, W, H).data
    const mark = window.__markOnly()
    let on = 0
    let onN = 0
    let visible = 0
    let off = 0
    let offN = 0
    for (let i = 0; i < got.length; i += 4) {
      const e = (Math.abs(got[i] - want[i]) + Math.abs(got[i + 1] - want[i + 1]) + Math.abs(got[i + 2] - want[i + 2])) / 3
      if (mark[i + 3] > 20) {
        on += e
        onN++
        if (e > 24) visible++
      } else if (mark[i + 3] === 0) {
        off += e
        offN++
      }
    }
    return { under: +(on / onN).toFixed(2), visible, away: +(off / offN).toFixed(3) }
  }
  window.__place = async (canvas, name) => {
    const blob = await new Promise((r) => canvas.toBlob(r, 'image/png'))
    const a = await window.__pfAssets.loadImageFile(new File([blob], name, { type: 'image/png' }))
    window.__pfState().resetDoc?.()
    window.__pfState().placeMedia([a.id], { resizeDocToFirst: true })
    await new Promise((r) => setTimeout(r, 400))
    window.__pfState().setPlaying(false)
    window.__pfState().setTime(0)
    return window.__pfState().doc.layers[window.__pfState().doc.layers.length - 1].id
  }
}
await page.evaluate(helpers)

const setup = await page.evaluate(async () => {
  const { canvas, placed } = window.__marked()
  const id = await window.__place(canvas, 'proof.png')
  return { id, placed, before: window.__score() }
})
console.log('before:', JSON.stringify(setup))
check('the mark is there to remove', setup.before.visible > 5000, `${setup.before.visible} pixels`)

// --- one button -------------------------------------------------------------------------
await page.keyboard.press('j')
await page.waitForTimeout(200)
const button = page.locator('.rail-options button', { hasText: 'Remove watermarks' })
check('the magic eraser has the button', (await button.count()) === 1)
const t0 = Date.now()
await button.click()
await page.waitForFunction(() => !window.__pfState().healWork && !!window.__pfState().notice, null, { timeout: 90000 })
const seconds = ((Date.now() - t0) / 1000).toFixed(1)
const result = await page.evaluate((id) => {
  const st = window.__pfState()
  const l = st.doc.layers.find((x) => x.id === id)
  return { notice: st.notice, dewater: l.dewater ? { ...l.dewater, alpha: l.dewater.alpha.length } : null, after: window.__score() }
}, setup.id)
console.log(`after ${seconds}s:`, JSON.stringify(result))
await page.screenshot({ path: `${OUT}/removed.png` })
check('one click finds it and says so', result.notice?.kind === 'ok' && /Removed \d+ watermarks/.test(result.notice.text),
  result.notice?.text)
check('and keeps a note of where and how it was turned',
  !!result.dewater && Math.abs(result.dewater.angle + 30) < 4, `${result.dewater?.angle}°`)
check('counting every copy on the picture', Math.abs((result.dewater?.count || 0) - setup.placed) <= 2,
  `${result.dewater?.count} found, ${setup.placed} placed`)
check('the mark is gone', result.after.visible < setup.before.visible * 0.03,
  `${setup.before.visible} -> ${result.after.visible} visibly-off pixels`)
check('and what is under it is the picture, not a guess at it', result.after.under < setup.before.under * 0.25,
  `${setup.before.under} -> ${result.after.under}`)
check('and nothing else in the picture moved', result.after.away < 1, String(result.after.away))

// --- the inspector ---------------------------------------------------------------------
const insp = await page.evaluate(async (id) => {
  window.__pfState().select([id])
  await new Promise((r) => setTimeout(r, 300))
  const sec = [...document.querySelectorAll('.inspector .section')]
    .find((n) => /^Watermark/.test(n.querySelector('.section-title')?.textContent || ''))
  return sec ? sec.textContent.replace(/\s+/g, ' ') : ''
}, setup.id)
check('the layer shows what was found', /\d+ marks/.test(insp) && /rotated -?\d+°/.test(insp), insp.slice(0, 120))

// Switched off, the picture is exactly as it arrived; on again, clean again.
const toggled = await page.evaluate(async (id) => {
  window.__pfState().setWatermarkOn(id, false)
  await new Promise((r) => setTimeout(r, 200))
  const off = window.__score()
  window.__pfState().setWatermarkOn(id, true)
  await new Promise((r) => setTimeout(r, 200))
  return { off, on: window.__score() }
}, setup.id)
check('switched off, the picture is exactly as it arrived', toggled.off.visible === setup.before.visible,
  `${toggled.off.visible} vs ${setup.before.visible}`)
check('and on again, clean again', toggled.on.visible === result.after.visible)

// --- undo, and a project that opens clean --------------------------------------------
const undone = await page.evaluate(async (id) => {
  const st = window.__pfState()
  // Off then on were two steps; the removal itself is the third back.
  st.undo(); st.undo(); st.undo()
  await new Promise((r) => setTimeout(r, 200))
  const gone = !window.__pfState().doc.layers.find((x) => x.id === id).dewater
  const s = window.__score()
  window.__pfState().redo(); window.__pfState().redo(); window.__pfState().redo()
  await new Promise((r) => setTimeout(r, 200))
  return { gone, visible: s.visible, back: window.__score().visible }
}, setup.id)
check('one undo takes the removal back', undone.gone && undone.visible === setup.before.visible, JSON.stringify(undone))
check('and redo puts it back', undone.back === result.after.visible)

const bytes = await page.evaluate(async () => {
  const st = window.__pfState()
  const packed = await window.__pfProject.packProject(st.doc, { time: 0, name: 'proof' })
  const b = packed instanceof Blob ? new Uint8Array(await packed.arrayBuffer()) : packed
  return Array.from(b)
})
await page.reload({ waitUntil: 'networkidle' })
await page.evaluate(helpers)
const reopened = await page.evaluate(async (arr) => {
  await window.__pfState().openProject(new File([new Uint8Array(arr)], 'proof.pfz'))
  return window.__score()
}, bytes)
check('a saved project opens with the mark still off', reopened.visible === result.after.visible,
  `${reopened.visible} vs ${result.after.visible}`)

// --- the magic eraser still works over it ---------------------------------------------
const healed = await page.evaluate(async () => {
  const st = window.__pfState()
  const l = st.doc.layers[0]
  st.setToolOptions({ heal: { size: 0.04 } })
  st.beginHeal(l.id, [300, 300])
  window.__pfState().extendHeal([340, 300])
  const res = window.__pfState().endHeal()
  return { ok: res?.ok, strokes: window.__pfState().doc.layers[0].heal?.strokes?.length || 0 }
})
check('the magic eraser paints on the unmarked picture', healed.ok && healed.strokes === 1, JSON.stringify(healed))

// --- where there is nothing to remove -------------------------------------------------
const plain = await page.evaluate(async () => {
  const id = await window.__place(window.__photo(), 'plain.png')
  const res = await window.__pfState().removeWatermark(id)
  const l = window.__pfState().doc.layers.find((x) => x.id === id)
  return { res, notice: window.__pfState().notice?.text, dewater: !!l.dewater }
})
check('a picture with no repeated mark is left alone', !plain.res.ok && !plain.dewater, plain.notice)
check('and it says what to do for a single mark', /magic eraser/.test(plain.notice || ''), plain.notice)

const floor = await page.evaluate(async () => {
  const c = document.createElement('canvas')
  c.width = 600
  c.height = 400
  const g = c.getContext('2d')
  g.fillStyle = '#c9b89a'
  g.fillRect(0, 0, 600, 400)
  g.fillStyle = '#5a4a3a'
  for (let x = 0; x < 600; x += 50) g.fillRect(x, 0, 4, 400)
  for (let y = 0; y < 400; y += 50) g.fillRect(0, y, 600, 4)
  const id = await window.__place(c, 'floor.png')
  const res = await window.__pfState().removeWatermark(id)
  const l = window.__pfState().doc.layers.find((x) => x.id === id)
  return { res, notice: window.__pfState().notice?.text, dewater: !!l.dewater }
})
check('a tiled floor is part of the picture, and is left alone', !floor.res.ok && !floor.dewater, floor.notice)

if (errors.length) console.log('errors:', errors)
check('no errors on the page', errors.length === 0, errors.slice(0, 3).join(' | '))
await browser.close()
const failed = checks.filter(([, ok]) => !ok)
console.log(`\n${checks.length - failed.length}/${checks.length} passed`)
process.exit(failed.length ? 1 : 0)
