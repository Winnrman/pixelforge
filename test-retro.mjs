// Retro preset engine tests. Runs in plain Node - no browser, no canvas -
// which is also the point: src/engine/retro.js must stay DOM-free so the video
// export worker can call it.
import { RETRO_PRESETS, applyRetro, retroDefaults } from './src/engine/retro.js'

const checks = []
const check = (name, ok) => { checks.push([name, ok]); console.log((ok ? 'PASS  ' : 'FAIL  ') + name) }
const r3 = (v) => Math.round(v * 1000) / 1000

const img = (w, h, fn) => {
  const data = new Uint8ClampedArray(w * h * 4)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4
      const [r, g, b, a] = fn(x, y)
      data[i] = r
      data[i + 1] = g
      data[i + 2] = b
      data[i + 3] = a
    }
  }
  return { data, width: w, height: h }
}
const clone = (im) => ({ data: Uint8ClampedArray.from(im.data), width: im.width, height: im.height })

// Grey ramp with a deliberately patterned alpha, so any preset that scribbles
// on the alpha channel shows up immediately.
const gradient = () => img(64, 64, (x, y) => {
  const v = Math.round(((x + y) / 126) * 255)
  return [v, v, v, (x * 7 + y * 13) % 256]
})
// Colour ramp for the chroma tests.
const colour = (w = 64, h = 64) => img(w, h, (x, y) => [
  Math.round((x / (w - 1)) * 255),
  Math.round((y / (h - 1)) * 255),
  Math.round(255 - (x / (w - 1)) * 255),
  255,
])

const luma = (r, g, b) => 0.299 * r + 0.587 * g + 0.114 * b
const meanLuma = (im) => {
  let s = 0
  for (let i = 0; i < im.data.length; i += 4) s += luma(im.data[i], im.data[i + 1], im.data[i + 2])
  return s / (im.data.length / 4)
}
const colours = (im) => {
  const set = new Set()
  for (let i = 0; i < im.data.length; i += 4) set.add((im.data[i] << 16) | (im.data[i + 1] << 8) | im.data[i + 2])
  return set
}
const hexKey = (h) => parseInt(h.replace('#', ''), 16)
const alphaEqual = (a, b) => {
  for (let i = 3; i < a.data.length; i += 4) if (a.data[i] !== b.data[i]) return false
  return true
}

console.log('--- presets run clean, alpha survives ---')
for (const p of RETRO_PRESETS) {
  const src = gradient()
  const out = clone(src)
  let threw = null
  try {
    const ret = applyRetro(out, p.id)
    if (ret !== out) threw = 'did not return the buffer it was handed'
  } catch (e) { threw = e.message }
  const changed = out.data.some((v, i) => i % 4 !== 3 && v !== src.data[i])
  check(`${p.id}: runs without throwing`, !threw)
  if (threw) console.log('      ' + threw)
  check(`${p.id}: leaves alpha untouched`, alphaEqual(src, out))
  check(`${p.id}: actually changes the pixels`, changed)
  check(`${p.id}: exposes defaults`, !!retroDefaults(p.id) && Object.keys(p.defaults).length > 0)
}
check('all six required ids are present',
  ['dither1bit', 'gameboy', 'vhs', 'halftone', 'c64', 'nes'].every((id) => RETRO_PRESETS.some((p) => p.id === id)))
check('an unknown id is a no-op, not a throw', (() => {
  const a = gradient()
  const b = clone(a)
  applyRetro(b, 'nope')
  return b.data.every((v, i) => v === a.data[i])
})())

console.log('\n--- dither1bit: two colours, mean brightness preserved ---')
{
  const src = gradient()
  const out = applyRetro(clone(src), 'dither1bit')
  const set = colours(out)
  check('output holds exactly two distinct RGB triples', set.size === 2)
  check('and they are the configured ink and paper',
    set.has(hexKey('#000000')) && set.has(hexKey('#ffffff')))
  const mi = meanLuma(src)
  const mo = meanLuma(out)
  console.log(`      input mean luma ${r3(mi)}  output mean luma ${r3(mo)}  drift ${r3(Math.abs(mo - mi))}`)
  check('mean luma drifts under 6/255 (error diffusion, not a plain threshold)', Math.abs(mo - mi) < 6)

  // The control: the same image thresholded flat. On a ramp this drifts far
  // more, which is what makes the check above meaningful rather than lucky.
  const flat = clone(src)
  for (let i = 0; i < flat.data.length; i += 4) {
    const v = luma(flat.data[i], flat.data[i + 1], flat.data[i + 2]) < 128 ? 0 : 255
    flat.data[i] = flat.data[i + 1] = flat.data[i + 2] = v
  }
  const mf = meanLuma(flat)
  console.log(`      plain-threshold control mean luma ${r3(mf)}  drift ${r3(Math.abs(mf - mi))}`)
  check('the plain-threshold control drifts further than the dither', Math.abs(mf - mi) > Math.abs(mo - mi))

  const tinted = applyRetro(clone(src), 'dither1bit', { ink: '#1a1a40', paper: '#f0e6c8' })
  const ts = colours(tinted)
  check('custom ink/paper are honoured and still only two colours',
    ts.size === 2 && ts.has(hexKey('#1a1a40')) && ts.has(hexKey('#f0e6c8')))
  const mt = meanLuma(tinted)
  console.log(`      tinted mean luma ${r3(mt)} vs input ${r3(mi)}  drift ${r3(Math.abs(mt - mi))}`)
  check('tinted ink/paper still preserves mean luma under 6/255', Math.abs(mt - mi) < 6)
}

console.log('\n--- gameboy: only the four DMG greens ---')
{
  const dmg = ['#0f380f', '#306230', '#8bac0f', '#9bbc0f'].map(hexKey)
  for (const mode of ['none', 'bayer', 'fs']) {
    const out = applyRetro(gradient(), 'gameboy', { dither: mode })
    const set = colours(out)
    const only = [...set].every((c) => dmg.includes(c))
    console.log(`      dither=${mode} -> ${set.size} distinct colours`)
    check(`gameboy dither=${mode} uses only DMG greens`, only && set.size <= 4)
  }
  const bayer = applyRetro(gradient(), 'gameboy', { dither: 'bayer' })
  const none = applyRetro(gradient(), 'gameboy', { dither: 'none' })
  let diff = 0
  for (let i = 0; i < bayer.data.length; i += 4) if (bayer.data[i] !== none.data[i]) diff++
  console.log(`      bayer differs from undithered on ${diff} of ${bayer.data.length / 4} pixels`)
  check('bayer dithering actually perturbs the quantisation', diff > 200)
}

console.log('\n--- c64 / nes: palette confinement ---')
{
  // Palettes retyped here on purpose: the test should not read them back out
  // of the module it is testing.
  const C64 = ['#000000', '#ffffff', '#880000', '#aaffee', '#cc44cc', '#00cc55', '#0000aa', '#eeee77',
    '#dd8855', '#664400', '#ff7777', '#333333', '#777777', '#aaff66', '#0088ff', '#bbbbbb'].map(hexKey)
  const NES = [
    [124, 124, 124], [0, 0, 252], [0, 0, 188], [68, 40, 188], [148, 0, 132], [168, 0, 32], [168, 16, 0],
    [136, 20, 0], [80, 48, 0], [0, 120, 0], [0, 104, 0], [0, 88, 0], [0, 64, 88],
    [188, 188, 188], [0, 120, 248], [0, 88, 248], [104, 68, 252], [216, 0, 204], [228, 0, 88], [248, 56, 0],
    [228, 92, 16], [172, 124, 0], [0, 184, 0], [0, 168, 0], [0, 168, 68], [0, 136, 136],
    [248, 248, 248], [60, 188, 252], [104, 136, 252], [152, 120, 248], [248, 120, 248], [248, 88, 152],
    [248, 120, 88], [252, 160, 68], [248, 184, 0], [184, 248, 24], [88, 216, 84], [88, 248, 152], [0, 232, 216],
    [252, 252, 252], [164, 228, 252], [184, 184, 248], [216, 184, 248], [248, 184, 248], [248, 164, 192],
    [240, 208, 176], [252, 224, 168], [248, 216, 120], [216, 248, 120], [184, 248, 184], [184, 248, 216],
    [0, 252, 252], [120, 120, 120], [0, 0, 0],
  ].map(([r, g, b]) => (r << 16) | (g << 8) | b)
  check('the NES table under test is 54 colours', NES.length === 54)

  for (const [id, pal] of [['c64', C64], ['nes', NES]]) {
    for (const mode of ['none', 'bayer', 'fs']) {
      const out = applyRetro(colour(), id, { dither: mode })
      const set = colours(out)
      const stray = [...set].filter((c) => !pal.includes(c))
      console.log(`      ${id} dither=${mode} -> ${set.size} distinct colours, ${stray.length} off-palette`)
      check(`${id} dither=${mode} emits only palette colours`, stray.length === 0)
    }
  }
}

console.log('\n--- vhs: sharp luma, smeared chroma ---')
{
  const toYcc = (im) => {
    const n = im.data.length / 4
    const Y = new Float64Array(n)
    const C = new Float64Array(n * 2)
    for (let i = 0, j = 0; i < n; i++, j += 4) {
      const r = im.data[j]
      const g = im.data[j + 1]
      const b = im.data[j + 2]
      Y[i] = luma(r, g, b)
      C[i * 2] = -0.168736 * r - 0.331264 * g + 0.5 * b
      C[i * 2 + 1] = 0.5 * r - 0.418688 * g - 0.081312 * b
    }
    return { Y, C }
  }
  const src = colour(128, 128)
  const a = toYcc(src)

  const measure = (opts, rowStep) => {
    const out = applyRetro(clone(src), 'vhs', opts)
    const b = toYcc(out)
    let ly = 0
    let ln = 0
    for (let y = 0; y < 128; y += rowStep) {
      for (let x = 0; x < 128; x++) {
        const i = y * 128 + x
        ly += Math.abs(b.Y[i] - a.Y[i])
        ln++
      }
    }
    let lc = 0
    for (let i = 0; i < a.Y.length; i++) {
      lc += Math.abs(b.C[i * 2] - a.C[i * 2]) + Math.abs(b.C[i * 2 + 1] - a.C[i * 2 + 1])
    }
    return { luma: ly / ln, chroma: lc / (a.Y.length * 2) }
  }

  const iso = measure({ scanline: 0, jitter: 0 }, 1)
  console.log(`      bleed/shift only: mean |dY| ${r3(iso.luma)}  mean |dChroma| ${r3(iso.chroma)}`)
  check('chroma-only pass leaves luma under 0.6/255 (YCbCr round-trip rounding)', iso.luma < 0.6)
  check('...while chroma moves by more than 3/255', iso.chroma > 3)
  check('...so chroma moves at least 10x further than luma', iso.chroma > iso.luma * 10)

  // With the defaults the scanlines darken every odd row on purpose, so luma
  // is only expected to be untouched on the even ones.
  const def = measure({}, 2)
  console.log(`      defaults: mean |dY| on non-scanline rows ${r3(def.luma)}  mean |dChroma| ${r3(def.chroma)}`)
  check('default preset leaves non-scanline rows under 1.0/255 of luma', def.luma < 1.0)
  check('default preset still smears chroma by more than 3/255', def.chroma > 3)

  const all = measure({}, 1)
  console.log(`      defaults over every row (scanlines included): mean |dY| ${r3(all.luma)}`)
  check('scanline darkening is visible across all rows', all.luma > 5)

  const s1 = applyRetro(clone(src), 'vhs', { seed: 1 })
  const s1b = applyRetro(clone(src), 'vhs', { seed: 1 })
  const s2 = applyRetro(clone(src), 'vhs', { seed: 99 })
  check('a seed is deterministic', s1.data.every((v, i) => v === s1b.data[i]))
  check('a different seed moves the dropout rows', s2.data.some((v, i) => v !== s1.data[i]))
}

console.log('\n--- halftone: 50% grey prints ~50% ink ---')
{
  const grey = img(192, 192, () => [128, 128, 128, 255])
  const target = 1 - 128 / 255
  for (const opts of [{}, { mono: true }, { cell: 10 }, { angleOffset: 30 }]) {
    const out = applyRetro(clone(grey), 'halftone', opts)
    let ink = 0
    for (let i = 0; i < out.data.length; i += 4) ink += 1 - out.data[i] / 255
    ink /= out.data.length / 4
    const err = Math.abs(ink - target)
    console.log(`      ${JSON.stringify(opts).padEnd(20)} ink ${r3(ink)} vs ${r3(target)}  err ${r3(err)}`)
    // Measured error is ~0.01-0.03; the slack comes from the one-pixel
    // analytic edge ramp slightly over-covering small dots.
    check(`halftone ${JSON.stringify(opts)} is within 0.04 of 50% ink`, err < 0.04)
  }
  const white = applyRetro(img(64, 64, () => [255, 255, 255, 255]), 'halftone')
  let wink = 0
  for (let i = 0; i < white.data.length; i += 4) wink += 1 - white.data[i] / 255
  wink /= white.data.length / 4
  const black = applyRetro(img(64, 64, () => [0, 0, 0, 255]), 'halftone')
  let bink = 0
  for (let i = 0; i < black.data.length; i += 4) bink += 1 - black.data[i] / 255
  bink /= black.data.length / 4
  console.log(`      paper white -> ink ${r3(wink)}   solid black -> ink ${r3(bink)}`)
  check('white paper stays blank', wink < 0.005)
  check('solid black closes up above 0.97 ink', bink > 0.97)

  // Four screens at four angles must not collapse onto one another.
  const cyan = applyRetro(img(96, 96, () => [0, 200, 255, 255]), 'halftone')
  const set = colours(cyan)
  console.log(`      a cyan patch resolves to ${set.size} distinct colours`)
  check('the CMY screens paint independently', set.size > 3)
}

console.log('\n--- timing: one 640x480 frame ---')
{
  const frame = img(640, 480, (x, y) => [
    (x * 3) & 255,
    (y * 5) & 255,
    (x + y) & 255,
    255,
  ])
  for (const p of RETRO_PRESETS) {
    applyRetro(clone(frame), p.id) // warm the palette caches and the buffer pool
    const runs = 3
    const t0 = performance.now()
    for (let i = 0; i < runs; i++) applyRetro(clone(frame), p.id)
    const ms = (performance.now() - t0) / runs
    console.log(`      ${p.id.padEnd(12)} ${ms.toFixed(1)} ms/frame`)
  }
  const t0 = performance.now()
  applyRetro(clone(frame), 'halftone')
  const slowest = performance.now() - t0
  check('the slowest preset stays under 250 ms for a 640x480 frame', slowest < 250)
}

const failed = checks.filter(([, ok]) => !ok)
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`)
if (failed.length) console.log('FAILED: ' + failed.map(([n]) => n).join(' | '))
process.exit(failed.length ? 1 : 0)
