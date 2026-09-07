// A clip with a long GOP, for the video decode-efficiency test.
//
// The keyframe interval is the point: reaching an arbitrary frame means decoding
// from the keyframe before it, so a 250-frame GOP is what makes wasted decode
// work visible. Deliberately small in resolution — the pathology is about the
// sample table and the GOP, not the pixels.
import { spawnSync } from 'child_process'

const ff = process.env.PF_FFMPEG || 'ffmpeg'
const out = 'public/test/longgop.mp4'
const args = [
  '-y',
  '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=30:duration=30',
  '-c:v', 'libx264', '-preset', 'veryfast',
  '-g', '250', '-keyint_min', '250', '-sc_threshold', '0',
  '-pix_fmt', 'yuv420p',
  out,
]
const r = spawnSync(ff, args, { stdio: 'inherit' })
if (r.error || r.status !== 0) {
  console.error('ffmpeg failed — is it on PATH, or set PF_FFMPEG?')
  process.exit(1)
}
console.log('wrote ' + out)
