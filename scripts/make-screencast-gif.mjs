// Fixture for cursor-following zoom: a fake screen recording.
//
// A static "desktop" (fixed-seed noise plus some window chrome) with a small
// arrow pointer travelling a path the test can recompute exactly: dwell near
// the top left, a fast flick across, then a dwell at the bottom right. The
// dwells are what should zoom in and the flick is what should zoom out, so the
// path is chosen to make that distinction unambiguous.
import pkg from 'gifenc'
import fs from 'fs'

const { GIFEncoder, quantize, applyPalette } = pkg

const W = 480
const H = 300
const N = 84
const DELAY = 40

// Deterministic noise so the fixture is byte-identical between runs.
let seed = 12345
const rnd = () => {
  seed = (seed * 1664525 + 1013904223) >>> 0
  return seed / 4294967296
}

// Blocky rather than per-pixel: the texture is static, so frame differencing
// ignores it either way, and 4px blocks keep the fixture small enough to live
// in the repo instead of ballooning to megabytes of incompressible grain.
const desktop = new Uint8ClampedArray(W * H * 4)
const blocks = new Float32Array(Math.ceil(W / 4) * Math.ceil(H / 4))
for (let i = 0; i < blocks.length; i++) blocks[i] = rnd() * 10
for (let y = 0; y < H; y++) {
  for (let x = 0; x < W; x++) {
    const i = (y * W + x) * 4
    const base = 34 + blocks[(y >> 2) * Math.ceil(W / 4) + (x >> 2)]
    desktop[i] = base
    desktop[i + 1] = base + 4
    desktop[i + 2] = base + 12
    desktop[i + 3] = 255
  }
}
// Two window panels, so the frame is not uniformly flat.
const panel = (px, py, pw, ph, v) => {
  for (let y = py; y < py + ph; y++) {
    for (let x = px; x < px + pw; x++) {
      const i = (y * W + x) * 4
      desktop[i] = v
      desktop[i + 1] = v + 3
      desktop[i + 2] = v + 8
    }
  }
}
panel(24, 24, 200, 120, 70)
panel(260, 150, 190, 120, 58)

/** Ground truth. Exported so the test recomputes it rather than hard-coding. */
export function cursorAt(f) {
  // The dwells have to outlast the detector's dwell threshold *and* its zoom-in
  // time constant, or the camera never finishes moving in and the flick has
  // nothing to pull back from.
  const dwellA = 34
  const flick = 38
  if (f < dwellA) {
    // Small drift, so the detector has motion to find without leaving the area.
    return { x: 110 + Math.sin(f * 0.7) * 6, y: 80 + Math.cos(f * 0.5) * 5 }
  }
  if (f < flick) {
    const u = (f - dwellA) / (flick - dwellA)
    return { x: 110 + u * 240, y: 80 + u * 140 }
  }
  return { x: 350 + Math.sin((f - flick) * 0.6) * 6, y: 220 + Math.cos((f - flick) * 0.4) * 5 }
}

function drawArrow(data, cx, cy) {
  // A 12x18 white arrow with a dark outline — light on dark, which is the case
  // the detector's luma bias is tuned for.
  const px = Math.round(cx)
  const py = Math.round(cy)
  for (let y = 0; y < 18; y++) {
    for (let x = 0; x < 12; x++) {
      const inside = x <= y * 0.6 && y < 16 && !(y > 11 && x < y * 0.6 - 4)
      if (!inside) continue
      const X = px + x
      const Y = py + y
      if (X < 0 || Y < 0 || X >= W || Y >= H) continue
      const i = (Y * W + X) * 4
      const edge = x === 0 || y === 0 || x >= y * 0.6 - 1
      const v = edge ? 20 : 245
      data[i] = v
      data[i + 1] = v
      data[i + 2] = v
    }
  }
}

const gif = GIFEncoder()
for (let f = 0; f < N; f++) {
  const data = new Uint8ClampedArray(desktop)
  const c = cursorAt(f)
  drawArrow(data, c.x, c.y)
  // A blinking caret, the classic false positive for motion-based detection.
  if (f % 8 < 4) {
    for (let y = 60; y < 76; y++) {
      const i = (y * W + 180) * 4
      data[i] = 230
      data[i + 1] = 230
      data[i + 2] = 230
    }
  }
  const palette = quantize(data, 128)
  gif.writeFrame(applyPalette(data, palette), W, H, { palette, delay: DELAY })
}
gif.finish()
fs.mkdirSync('public/test', { recursive: true })
fs.writeFileSync('public/test/screencast.gif', Buffer.from(gif.bytes()))
console.log('wrote public/test/screencast.gif',
  fs.statSync('public/test/screencast.gif').size, 'bytes',
  `(${W}x${H}, ${N} frames, ${DELAY}ms)`)
