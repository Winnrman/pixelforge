// Builds the application icons from logo.png.
//
// Windows wants a single .ico carrying several sizes: the shell picks 16px for a
// tree view, 32px for the taskbar, 256px for large tiles, and picks badly if the
// one it wants is missing and has to be resampled. Vista and later accept
// PNG-compressed entries inside an .ico, which is what this writes — far smaller
// than the old BMP-with-AND-mask form and lossless at every size.
import { spawnSync } from 'child_process'
import fs from 'fs'
import path from 'path'

const ff = process.env.PF_FFMPEG || 'ffmpeg'
const SRC = 'logo.png'
const OUT = 'build'
const SIZES = [256, 128, 64, 48, 32, 16]

if (!fs.existsSync(SRC)) {
  console.error(`${SRC} is missing — put the logo there first`)
  process.exit(1)
}
fs.mkdirSync(OUT, { recursive: true })

/** One square PNG at `size`, with the alpha channel preserved. */
function png(size, dest) {
  // `lanczos` for the big steps down; the default bilinear turns the fine
  // sprocket holes into mush at 32px and below.
  const r = spawnSync(ff, [
    '-v', 'error', '-y', '-i', SRC,
    '-vf', `scale=${size}:${size}:flags=lanczos`,
    '-pix_fmt', 'rgba', dest,
  ], { stdio: 'inherit' })
  if (r.error || r.status !== 0) {
    console.error('ffmpeg failed — is it on PATH, or set PF_FFMPEG?')
    process.exit(1)
  }
  return fs.readFileSync(dest)
}

const parts = SIZES.map((s) => ({ size: s, data: png(s, path.join(OUT, `icon-${s}.png`)) }))

// ICONDIR, then one 16-byte ICONDIRENTRY each, then the PNGs.
const header = Buffer.alloc(6)
header.writeUInt16LE(0, 0)             // reserved
header.writeUInt16LE(1, 2)             // 1 = icon
header.writeUInt16LE(parts.length, 4)

let offset = 6 + parts.length * 16
const dir = []
for (const p of parts) {
  const e = Buffer.alloc(16)
  // 256 does not fit in a byte and is written as 0, which is the convention.
  e.writeUInt8(p.size >= 256 ? 0 : p.size, 0)
  e.writeUInt8(p.size >= 256 ? 0 : p.size, 1)
  e.writeUInt8(0, 2)                   // palette size: none, it is truecolour
  e.writeUInt8(0, 3)                   // reserved
  e.writeUInt16LE(1, 4)                // colour planes
  e.writeUInt16LE(32, 6)               // bits per pixel
  e.writeUInt32LE(p.data.length, 8)
  e.writeUInt32LE(offset, 12)
  offset += p.data.length
  dir.push(e)
}

fs.writeFileSync(path.join(OUT, 'icon.ico'),
  Buffer.concat([header, ...dir, ...parts.map((p) => p.data)]))

// electron-builder looks for build/icon.png for the platforms that want one
// file rather than an .ico, and 512 is the size it asks for.
png(512, path.join(OUT, 'icon.png'))
// The browser tab, and the dev server.
png(64, 'public/favicon.png')

// Leave only the sizes something actually reads.
for (const s of SIZES) fs.rmSync(path.join(OUT, `icon-${s}.png`), { force: true })

const ico = fs.statSync(path.join(OUT, 'icon.ico'))
console.log(`build/icon.ico  ${SIZES.join(', ')}  ${(ico.size / 1024).toFixed(1)} KB`)
console.log('build/icon.png  512')
console.log('public/favicon.png  64')
