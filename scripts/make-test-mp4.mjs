// Test MP4: a disc on the same known path as the GIF fixture, so tracking and
// frame accuracy can be checked against ground truth. Needs ffmpeg on PATH.
import { execFileSync } from 'child_process'
import fs from 'fs'
import path from 'path'
import zlib from 'zlib'

const W = 320, H = 200, N = 48, FPS = 24
const tmp = fs.mkdtempSync(path.join(process.cwd(), '.mp4frames-'))

function crc32(buf) {
  const t = []
  for (let n = 0; n < 256; n++) { let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0 }
  let c = 0xffffffff
  for (const b of buf) c = t[(c ^ b) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}
const chunk = (type, data) => {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length)
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td))
  return Buffer.concat([len, td, crc])
}

for (let f = 0; f < N; f++) {
  const u = f / N
  const bx = W / 2 + Math.cos(u * Math.PI * 2) * 90
  const by = H / 2 + Math.sin(u * Math.PI * 2) * 55
  const raw = Buffer.alloc(H * (W * 3 + 1))
  let p = 0
  for (let y = 0; y < H; y++) {
    raw[p++] = 0
    for (let x = 0; x < W; x++) {
      const chk = ((x >> 4) + (y >> 4)) % 2
      let r = chk ? 40 : 22, g = chk ? 44 : 26, b = chk ? 60 : 38
      if (Math.hypot(x - bx, y - by) < 34) { r = 255; g = 60; b = 120 }
      // A per-frame marker stripe: frame index encoded as a bar width, so a
      // decoded frame can be identified without guessing.
      if (y < 8 && x < (f + 1) * 4) { r = 255; g = 255; b = 255 }
      raw[p++] = r; raw[p++] = g; raw[p++] = b
    }
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4); ihdr[8] = 8; ihdr[9] = 2
  fs.writeFileSync(path.join(tmp, String(f).padStart(4, '0') + '.png'), Buffer.concat([
    Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0)),
  ]))
}

fs.mkdirSync('public/test', { recursive: true })
const out = 'public/test/motion.mp4'
execFileSync('ffmpeg', ['-y', '-framerate', String(FPS), '-i', path.join(tmp, '%04d.png'),
  '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-g', '12', '-crf', '18', out], { stdio: 'ignore' })
fs.rmSync(tmp, { recursive: true, force: true })
console.log('wrote', out, fs.statSync(out).size, 'bytes,', N, 'frames @', FPS, 'fps')

// A 1080p clip with a single keyframe. Decoding its last frame means holding a
// long run of frames at once, which is exactly what exhausted the WebCodecs
// frame pool and hung the import. Small on disk, but the right shape.
execFileSync('ffmpeg', ['-y', '-f', 'lavfi', '-i', 'testsrc2=size=1920x1080:rate=24:duration=2',
  '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
  '-g', '250', '-bf', '3', '-crf', '34', 'public/test/hd.mp4'], { stdio: 'ignore' })
console.log('wrote public/test/hd.mp4', fs.statSync('public/test/hd.mp4').size, 'bytes')
