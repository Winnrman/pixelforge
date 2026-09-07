// Fixture for MP4 export with sound.
//
// Built by the same ffmpeg the export uses, because the point is to prove the
// muxing path end to end: a colour-cycling video the test can identify by pixel
// plus a 440Hz tone it can find as an audio stream.
import { spawn } from 'child_process'
import fs from 'fs'

const OUT = 'public/test/withaudio.mp4'
const bin = process.env.PF_FFMPEG || 'ffmpeg'

const args = [
  '-y',
  '-f', 'lavfi', '-i', 'testsrc=size=320x200:rate=24:duration=2',
  '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2',
  '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
  '-c:a', 'aac', '-b:a', '96k',
  '-shortest',
  OUT,
]

fs.mkdirSync('public/test', { recursive: true })
const code = await new Promise((res) => {
  const p = spawn(bin, args, { stdio: ['ignore', 'ignore', 'inherit'] })
  p.on('error', () => res(-1))
  p.on('close', res)
})

if (code !== 0) {
  console.error('ffmpeg not available — skipping withaudio.mp4 (MP4 export tests will skip too)')
  process.exit(0)
}
console.log('wrote', OUT, fs.statSync(OUT).size, 'bytes (320x200, 2s, H.264 + AAC 440Hz)')
