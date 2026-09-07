// Standalone checks for src/engine/cursor.js — `node test-cursor.mjs`.
//
// There is no real screen recording to test against, so this synthesises one:
// a fixed-seed noisy "desktop" with a couple of UI panels, a blinking text
// caret as a distractor, a 12x18 white-with-black-outline arrow walked along a
// KNOWN path (dwell, fast flick, dwell), plus two window repaints and a frame
// where nothing moves at all. Every number printed below is measured, not
// asserted into existence.

import { findCursor, cursorPath, smoothPath, autoZoomTracks } from './src/engine/cursor.js'
import { sampleTrack } from './src/engine/keyframes.js'

const W = 960
const H = 540
const COUNT = 80
const FPS = 25 // 40ms/frame — integer key times, so rounding never muddies the tolerances

let failures = 0
let total = 0
const num = (v, d = 2) => (Math.round(v * 10 ** d) / 10 ** d).toFixed(d)
function check(ok, label, detail) {
  total++
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  —  ${detail}` : ''}`)
}

// ------------------------------------------------------------------ fixtures

function mulberry32(a) {
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// '.' = leave background, 'W' = white, 'K' = black outline. Tip is (0, 0).
const ARROW = [
  'K...........',
  'KK..........',
  'KWK.........',
  'KWWK........',
  'KWWWK.......',
  'KWWWWK......',
  'KWWWWWK.....',
  'KWWWWWWK....',
  'KWWWWWWWK...',
  'KWWWWWWWWK..',
  'KWWWWWWWWWK.',
  'KWWWWWKKKKKK',
  'KWWKWWK.....',
  'KWK.KWWK....',
  'KK..KWWK....',
  'K....KWWK...',
  '.....KWWK...',
  '......KK....',
]
const ARROW_W = 12
const ARROW_H = 18

const BG_GRAY = 110

// findCursor reports the centroid of the changed blob, not the pointer hotspot
// (the tip). A real app subtracts the OS hotspot offset; here the ground truth
// is shifted by the same amount so the comparison is apples to apples. The
// weighting mirrors the detector: diff magnitude against the base background,
// scaled by the luma bias toward the light part of the pointer.
const HOTSPOT = (() => {
  let sw = 0
  let sx = 0
  let sy = 0
  for (let r = 0; r < ARROW_H; r++) {
    for (let c = 0; c < ARROW_W; c++) {
      const ch = ARROW[r][c]
      if (ch === '.') continue
      const v = ch === 'W' ? 255 : 0
      const w = Math.abs(v - BG_GRAY) * (0.4 + (0.6 * v) / 255)
      sw += w
      sx += w * c
      sy += w * r
    }
  }
  return { x: sx / sw, y: sy / sw }
})()

// Ground-truth pointer tip per frame.
const TRUTH = (() => {
  const A = { x: 200, y: 150 }
  const B = { x: 700, y: 500 }
  const p = []
  for (let i = 0; i < COUNT; i++) {
    const jx = Math.round(3 * Math.sin(i * 0.9))
    const jy = Math.round(3 * Math.cos(i * 0.7))
    if (i < 30) p.push({ x: A.x + jx, y: A.y + jy })
    else if (i < 42) {
      const u = (i - 29) / 12
      p.push({ x: Math.round(A.x + (B.x - A.x) * u), y: Math.round(A.y + (B.y - A.y) * u) })
    } else p.push({ x: B.x + jx, y: B.y + jy })
  }
  p[60] = { ...p[59] } // a frame where the pointer does not move at all
  p[65] = { ...p[64] } // ...and one where only a window repaints
  return p
})()

const centroidOf = (i) => ({ x: TRUTH[i].x + HOTSPOT.x, y: TRUTH[i].y + HOTSPOT.y })
const moved = (i) => i > 0 && (TRUTH[i].x !== TRUTH[i - 1].x || TRUTH[i].y !== TRUTH[i - 1].y)

const REPAINTS = [
  { from: 65, x: 60, y: 300, w: 300, h: 180, v: 232 },
  { from: 70, x: 100, y: 60, w: 320, h: 180, v: 244 },
]

const fill = (buf, x, y, w, h, v) => {
  for (let r = y; r < y + h; r++) {
    let p = (r * W + x) * 4
    for (let c = 0; c < w; c++, p += 4) {
      buf[p] = v
      buf[p + 1] = v
      buf[p + 2] = v
    }
  }
}

// Static desktop: mid-gray with fixed-seed noise, a light window panel and a
// dark dock strip. Built once so every frame differs only where it should.
const BASE = (() => {
  const buf = new Uint8ClampedArray(W * H * 4)
  const rnd = mulberry32(0xc0ffee)
  for (let i = 0, p = 0; i < W * H; i++, p += 4) {
    const v = BG_GRAY + Math.round((rnd() - 0.5) * 36)
    buf[p] = v
    buf[p + 1] = v
    buf[p + 2] = v
    buf[p + 3] = 255
  }
  fill(buf, 500, 40, 380, 260, 200) // a window, well clear of the pointer path
  fill(buf, 0, 520, W, 20, 45) // dock
  return buf
})()

const cache = new Map()
function frameAt(i) {
  if (cache.has(i)) return cache.get(i)
  const data = new Uint8ClampedArray(BASE)
  for (const r of REPAINTS) if (i >= r.from) fill(data, r.x, r.y, r.w, r.h, r.v)
  // Blinking text caret: small and high-contrast, i.e. exactly the kind of
  // thing a motion detector is entitled to mistake for a pointer.
  if (Math.floor(i / 8) % 2 === 0) fill(data, 450, 330, 3, 16, 20)
  // Per-frame capture noise, well under the detector's threshold.
  const rnd = mulberry32(0x9e3779b9 ^ (i * 2654435761))
  for (let p = 0; p < data.length; p += 4) {
    const n = Math.round((rnd() - 0.5) * 6)
    data[p] += n
    data[p + 1] += n
    data[p + 2] += n
  }
  const { x, y } = TRUTH[i]
  for (let r = 0; r < ARROW_H; r++) {
    for (let c = 0; c < ARROW_W; c++) {
      const ch = ARROW[r][c]
      if (ch === '.') continue
      const p = ((y + r) * W + (x + c)) * 4
      const v = ch === 'W' ? 255 : 0
      data[p] = v
      data[p + 1] = v
      data[p + 2] = v
    }
  }
  const f = { data, width: W, height: H }
  if (cache.size > 6) cache.clear()
  cache.set(i, f)
  return f
}

// --------------------------------------------------------------------- tests

console.log(`fixture: ${COUNT} frames of ${W}x${H} at ${FPS}fps, arrow ${ARROW_W}x${ARROW_H}`)
console.log(`pointer centroid sits (${num(HOTSPOT.x)}, ${num(HOTSPOT.y)}) from the tip\n`)
const t0 = Date.now()

// 1. findCursor accuracy on frames where the pointer actually moved.
{
  const errs = []
  for (let i = 1; i < COUNT; i++) {
    if (!moved(i)) continue
    const hit = findCursor(frameAt(i), frameAt(i - 1), centroidOf(i - 1))
    if (!hit) {
      errs.push(Infinity)
      continue
    }
    const g = centroidOf(i)
    errs.push(Math.hypot(hit.x - g.x, hit.y - g.y))
  }
  const misses = errs.filter((e) => !Number.isFinite(e)).length
  const finite = errs.filter(Number.isFinite)
  const mean = finite.reduce((a, b) => a + b, 0) / finite.length
  const worst = Math.max(...finite)
  check(misses === 0, 'findCursor finds the pointer on every moving frame',
    `${errs.length - misses}/${errs.length} frames`)
  check(mean <= 3, 'findCursor mean error within 3px', `mean ${num(mean)}px over ${finite.length} frames`)
  check(worst <= 8, 'findCursor worst error within 8px', `worst ${num(worst)}px`)
}

// 2. Honest nulls: a still pointer, and a window repaint that must be rejected.
{
  const still = findCursor(frameAt(60), frameAt(59), centroidOf(59))
  check(still === null || still.score < 0.1, 'findCursor returns null when nothing moved',
    still ? `score ${num(still.score, 3)}` : 'null')

  const repaintHinted = findCursor(frameAt(65), frameAt(64), centroidOf(64))
  const repaintBlind = findCursor(frameAt(65), frameAt(64), null)
  const r = REPAINTS[0]
  check(repaintHinted === null && repaintBlind === null,
    'findCursor rejects a 300x180 window repaint (with and without a hint)',
    `changed region ${r.w}x${r.h} = ${num((r.w * r.h * 100) / (W * H), 1)}% of frame; ` +
    `hinted ${repaintHinted ? `(${num(repaintHinted.x)},${num(repaintHinted.y)})` : 'null'}, ` +
    `blind ${repaintBlind ? `(${num(repaintBlind.x)},${num(repaintBlind.y)})` : 'null'}`)

  // Frame 70 repaints AND moves the pointer: the repaint must be discarded
  // while the pointer is still found.
  const both = findCursor(frameAt(70), frameAt(69), centroidOf(69))
  const g = centroidOf(70)
  const e = both ? Math.hypot(both.x - g.x, both.y - g.y) : Infinity
  check(e <= 8, 'findCursor keeps the pointer on a frame that also repaints a 320x180 window',
    both ? `error ${num(e)}px at (${num(both.x)}, ${num(both.y)})` : 'null')
}

// 3. cursorPath over the whole sequence, using the (i) => frame form.
const path = cursorPath(frameAt, { count: COUNT, fps: FPS })
{
  check(path.length === COUNT, 'cursorPath returns one entry per frame', `${path.length} entries`)
  const arrayForm = cursorPath([frameAt(42), frameAt(43), frameAt(44)], { fps: FPS })
  check(arrayForm.length === 3 && arrayForm[2].moving,
    'cursorPath accepts an array of frames as well as a function', `${arrayForm.length} entries`)

  const errs = path.map((p, i) => Math.hypot(p.x - centroidOf(i).x, p.y - centroidOf(i).y))
  const mean = errs.reduce((a, b) => a + b, 0) / errs.length
  const worst = Math.max(...errs)
  const held = path.filter((p) => !p.moving).length
  check(mean <= 3, 'cursorPath mean error within 3px', `mean ${num(mean)}px`)
  check(worst <= 8, 'cursorPath worst error within 8px',
    `worst ${num(worst)}px at frame ${errs.indexOf(worst)}`)
  console.log(`      ${held} of ${COUNT} frames held a previous position (no motion to see)`)
}

// 4. smoothPath: less jitter, still on target.
const LAG = 140
const DEAD = 26
const smooth = smoothPath(path, { lag: LAG, deadZone: DEAD })
{
  const len = (p, from = 1, to = p.length - 1) => {
    let a = 0
    for (let i = from; i <= to; i++) a += Math.hypot(p[i].x - p[i - 1].x, p[i].y - p[i - 1].y)
    return a
  }
  const raw = len(path)
  const sm = len(smooth)
  check(sm < raw, 'smoothPath reduces total path length (jitter)',
    `${num(raw, 1)}px raw -> ${num(sm, 1)}px smoothed (${num((100 * (raw - sm)) / raw, 1)}% less travel)`)

  // The dwells are where jitter lives — the flick is real travel that has to
  // survive, and the first stretch of dwell B is the camera still settling out
  // of it. Isolating the settled stretches shows what the dead zone buys.
  const dwellRaw = len(path, 1, 29) + len(path, 60, COUNT - 1)
  const dwellSm = len(smooth, 1, 29) + len(smooth, 60, COUNT - 1)
  check(dwellSm < dwellRaw * 0.05, 'smoothPath all but eliminates travel during the settled dwells',
    `${num(dwellRaw, 1)}px raw -> ${num(dwellSm, 3)}px smoothed across both dwells`)

  const dev = smooth.map((p, i) => Math.hypot(p.x - centroidOf(i).x, p.y - centroidOf(i).y))
  const worst = Math.max(...dev)
  check(worst <= 200, 'smoothPath never slings the camera off target (<= 200px, flick lag included)',
    `worst ${num(worst, 1)}px at frame ${dev.indexOf(worst)}`)
  const settled = Math.max(dev[29], dev[COUNT - 1])
  check(settled <= DEAD + 12, `smoothPath settles inside the dead zone + 12px at the end of each dwell`,
    `dwell A ${num(dev[29], 1)}px, dwell B ${num(dev[COUNT - 1], 1)}px, dead zone ${DEAD}px`)
}

// 5. autoZoomTracks: in on the dwells, out on the flick.
const OPTS = { width: W, height: H, zoom: 2, dwellMs: 400 }
const tracks = autoZoomTracks(smooth, OPTS)
{
  const tAt = (i) => path[i].t
  const zA = sampleTrack(tracks.zoom, tAt(29), 1)
  const zFlick = sampleTrack(tracks.zoom, tAt(36), 1)
  const zB = sampleTrack(tracks.zoom, tAt(COUNT - 1), 1)
  check(zFlick < zA - 0.25 && zFlick < zB - 0.25,
    'autoZoomTracks pushes in on both dwells and pulls out for the flick',
    `dwell A ${num(zA, 3)}, flick mid ${num(zFlick, 3)}, dwell B ${num(zB, 3)}`)

  // Pan must keep the zoom window inside the frame. Checked on the replayed
  // curve, so the thinning tolerance (0.004 of the frame) is the bound rather
  // than zero — every emitted key is clamped exactly, but a lerp between two
  // clamped keys can cut a corner off the curved limit by up to that much.
  let worstOver = -1
  for (const t of tracks.panX.map((k) => k.t).concat(tracks.panY.map((k) => k.t))) {
    const z = Math.max(1, sampleTrack(tracks.zoom, t, 1))
    const limit = 0.5 - 1 / (2 * z)
    worstOver = Math.max(worstOver,
      Math.abs(sampleTrack(tracks.panX, t, 0)) - limit,
      Math.abs(sampleTrack(tracks.panY, t, 0)) - limit)
  }
  check(worstOver <= 0.004, 'autoZoomTracks clamps pan so the zoom window stays inside the frame',
    `worst overshoot ${num(worstOver, 5)} of frame = ${num(worstOver * W, 2)}px`)

  const panPx = sampleTrack(tracks.panX, tAt(COUNT - 1), 0) * W + W / 2
  check(Math.abs(panPx - smooth[COUNT - 1].x) < 1, 'panX follows the sourceRect() convention',
    `panX ${num(sampleTrack(tracks.panX, tAt(COUNT - 1), 0), 4)} -> x ${num(panPx, 1)}px vs camera ${num(smooth[COUNT - 1].x, 1)}px`)
}

// 6. Thinning: sparse tracks that still replay the dense curve.
{
  const dense = autoZoomTracks(smooth, { ...OPTS, zoomTol: 0, panTol: 0 })
  const total = tracks.zoom.length + tracks.panX.length + tracks.panY.length
  const longest = Math.max(tracks.zoom.length, tracks.panX.length, tracks.panY.length)
  check(longest <= COUNT / 3, 'every emitted track is at least 3x sparser than one key per frame',
    `zoom ${tracks.zoom.length}, panX ${tracks.panX.length}, panY ${tracks.panY.length} ` +
    `(${total} keys total vs ${COUNT} frames x 3 tracks = ${COUNT * 3} dense samples)`)

  const worstOf = (thinned, denseKeys, scale) => {
    let worst = 0
    for (const k of denseKeys) {
      worst = Math.max(worst, Math.abs(sampleTrack(thinned, k.t, k.v) - k.v) * scale)
    }
    return worst
  }
  const ez = worstOf(tracks.zoom, dense.zoom, 1)
  const ex = worstOf(tracks.panX, dense.panX, 1)
  const ey = worstOf(tracks.panY, dense.panY, 1)
  check(ez <= 0.01, 'thinned zoom track replays the dense one within the 0.01 tolerance',
    `worst ${num(ez, 5)} zoom units`)
  check(ex <= 0.004 && ey <= 0.004, 'thinned pan tracks replay the dense ones within the 0.004 tolerance',
    `worst panX ${num(ex, 5)} (${num(ex * W, 2)}px), panY ${num(ey, 5)} (${num(ey * H, 2)}px)`)
}

console.log(`\n${total - failures}/${total} checks passed in ${Date.now() - t0}ms`)
process.exit(failures ? 1 : 0)
