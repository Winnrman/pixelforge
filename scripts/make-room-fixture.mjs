// A deliberately hostile fixture for background removal: a near-monochrome
// scene where subject and background overlap in brightness, with sensor-style
// grain. This is the case that produced a speckled mess, so it belongs in the
// test suite rather than only in a bug report.
import fs from 'fs'
import zlib from 'zlib'

const W = 240
const H = 320

function crc32(buf) {
  let c
  const table = []
  for (let n = 0; n < 256; n++) {
    c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  let crc = 0xffffffff
  for (const b of buf) crc = table[(crc ^ b) & 0xff] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(td))
  return Buffer.concat([len, td, crc])
}

const raw = Buffer.alloc(H * (W * 3 + 1))
let p = 0
for (let y = 0; y < H; y++) {
  raw[p++] = 0
  for (let x = 0; x < W; x++) {
    // Wall: grey, vertically streaked, grainy.
    const streak = Math.sin(x * 0.4) * 9 + Math.sin(x * 0.07) * 18
    const grain = ((x * 31 + y * 17) % 13) - 6
    let r = 128 + streak + grain
    let g = 130 + streak + grain
    let b = 134 + streak + grain

    // Subject: a torso-ish column whose brightness *overlaps* the wall, and
    // which is only faintly warmer — the pathological case for a colour key.
    const cx = W / 2
    const inBody = Math.abs(x - cx) < 34 - Math.abs(y - H / 2) / 9 && y > 60 && y < H - 30
    if (inBody) {
      const shade = Math.sin(y * 0.05) * 22 + Math.sin(x * 0.2) * 8
      r = 150 + shade + grain
      g = 138 + shade + grain
      b = 132 + shade + grain
    }
    // One clearly saturated object, which any working key must keep.
    if (Math.hypot(x - cx, y - (H - 70)) < 26) {
      r = 150; g = 32; b = 140
    }
    raw[p++] = Math.max(0, Math.min(255, r))
    raw[p++] = Math.max(0, Math.min(255, g))
    raw[p++] = Math.max(0, Math.min(255, b))
  }
}

const ihdr = Buffer.alloc(13)
ihdr.writeUInt32BE(W, 0)
ihdr.writeUInt32BE(H, 4)
ihdr[8] = 8
ihdr[9] = 2
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', zlib.deflateSync(raw)),
  chunk('IEND', Buffer.alloc(0)),
])
fs.mkdirSync('public/test', { recursive: true })
fs.writeFileSync('public/test/room.png', png)
console.log('wrote public/test/room.png', png.length, 'bytes')
