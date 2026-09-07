// Fixture for background removal and subject-weighted tracking.
//
// A disc travels a known path across a near-flat green field. Two deliberate
// traps: the green is slightly noisy (so exact-colour matching is not enough),
// and the disc carries a green dot of the *same* colour as the background, so a
// connectivity-aware key must keep it while a global key must remove it.
import pkg from 'gifenc'
import fs from 'fs'

const { GIFEncoder, quantize, applyPalette } = pkg

const W = 320
const H = 200
const N = 24
const BG = [64, 176, 96]

const gif = GIFEncoder()
for (let f = 0; f < N; f++) {
  const data = new Uint8ClampedArray(W * H * 4)
  const u = f / N
  const bx = W / 2 + Math.cos(u * Math.PI * 2) * 90
  const by = H / 2 + Math.sin(u * Math.PI * 2) * 55

  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4
      // Near-flat green, with gentle shading and a little grain.
      const shade = Math.sin((x + y) * 0.03) * 5
      const grain = ((x * 7 + y * 13 + f) % 5) - 2
      data[i] = BG[0] + shade + grain
      data[i + 1] = BG[1] + shade + grain
      data[i + 2] = BG[2] + shade + grain
      data[i + 3] = 255

      const d = Math.hypot(x - bx, y - by)
      if (d < 34) {
        // Subject: a warm disc with internal structure so it is trackable.
        const r = d / 34
        data[i] = 235 - r * 40
        data[i + 1] = 70 + Math.sin(d * 0.6) * 30
        data[i + 2] = 110 + r * 60
        // A patch of pure background colour *inside* the subject.
        if (Math.hypot(x - bx + 12, y - by + 8) < 7) {
          data[i] = BG[0]
          data[i + 1] = BG[1]
          data[i + 2] = BG[2]
        }
      }
    }
  }
  const palette = quantize(data, 256)
  gif.writeFrame(applyPalette(data, palette), W, H, { palette, delay: 60 })
}
gif.finish()
fs.mkdirSync('public/test', { recursive: true })
fs.writeFileSync('public/test/greenscreen.gif', Buffer.from(gif.bytes()))
console.log('wrote public/test/greenscreen.gif',
  fs.statSync('public/test/greenscreen.gif').size, 'bytes')
