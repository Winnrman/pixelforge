import pkg from 'gifenc'
const { GIFEncoder, quantize, applyPalette } = pkg
import fs from 'fs'

const W = 320, H = 200, N = 24
const gif = GIFEncoder()
for (let f = 0; f < N; f++) {
  const data = new Uint8ClampedArray(W * H * 4)
  const t = f / N
  const bx = W / 2 + Math.cos(t * Math.PI * 2) * 90
  const by = H / 2 + Math.sin(t * Math.PI * 2) * 55
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4
      // checkerboard backdrop so pixelation is obvious
      const chk = ((x >> 4) + (y >> 4)) % 2
      data[i] = chk ? 40 : 22
      data[i + 1] = chk ? 44 : 26
      data[i + 2] = chk ? 60 : 38
      // moving disc
      const d = Math.hypot(x - bx, y - by)
      if (d < 34) {
        data[i] = 255; data[i + 1] = 45 + (x % 40) * 5; data[i + 2] = 120
      }
      // diagonal stripes, animated
      if ((x + y + f * 6) % 24 < 3) { data[i] = 255; data[i + 1] = 204; data[i + 2] = 51 }
      data[i + 3] = 255
    }
  }
  const palette = quantize(data, 256)
  gif.writeFrame(applyPalette(data, palette), W, H, { palette, delay: 60 })
}
gif.finish()
fs.writeFileSync('public/test/motion.gif', Buffer.from(gif.bytes()))
console.log('wrote public/test/motion.gif', fs.statSync('public/test/motion.gif').size, 'bytes')
