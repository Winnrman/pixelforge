// Fixture for loop repair: a clip that deliberately does NOT loop.
//
// A disc travels left to right in a straight line, so the last frame is nowhere
// near the first. That is what makes the seam measurable, the crossfade visibly
// blend two separated discs, and a "this already loops" verdict provably wrong.
import pkg from 'gifenc'
import fs from 'fs'

const { GIFEncoder, quantize, applyPalette } = pkg

const W = 320
const H = 200
const N = 20
const DELAY = 60

const gif = GIFEncoder()
for (let f = 0; f < N; f++) {
  const data = new Uint8ClampedArray(W * H * 4)
  const bx = 40 + (f / (N - 1)) * 240
  const by = 100
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4
      data[i] = 30
      data[i + 1] = 34
      data[i + 2] = 44
      data[i + 3] = 255
      if (Math.hypot(x - bx, y - by) < 26) {
        data[i] = 240
        data[i + 1] = 80
        data[i + 2] = 60
      }
    }
  }
  const palette = quantize(data, 32)
  gif.writeFrame(applyPalette(data, palette), W, H, { palette, delay: DELAY })
}
gif.finish()
fs.mkdirSync('public/test', { recursive: true })
fs.writeFileSync('public/test/badloop.gif', Buffer.from(gif.bytes()))
console.log('wrote public/test/badloop.gif', fs.statSync('public/test/badloop.gif').size, 'bytes')
