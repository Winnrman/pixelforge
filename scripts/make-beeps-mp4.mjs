// A clip whose sound has obvious shape: 400ms of tone, 600ms of silence, over
// and over.
//
// A constant tone tells you nothing about whether a waveform is being drawn
// correctly — it looks like a solid block whether the peaks are right, wrong, or
// smeared from a neighbouring bucket. Alternating loud and silent makes the
// picture testable: the loud stretches must be tall and the gaps must be flat,
// and they must line up with where they actually are in the file.
import { spawnSync } from 'child_process'

const ff = process.env.PF_FFMPEG || 'ffmpeg'
const out = 'public/test/beeps.mp4'
// Gating a plain sine with a volume expression rather than building the wave in
// `aevalsrc`: the commas an aevalsrc expression needs have to be escaped past
// both the shell and ffmpeg's own parser, and getting that wrong fails with
// "Invalid argument" and no clue which argument.
const r = spawnSync(ff, [
  '-y',
  '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=15:duration=4',
  '-f', 'lavfi', '-i', 'sine=frequency=440:duration=4:sample_rate=44100',
  // The trailing `volume=5` is not decoration: gating a sine with an expression
  // comes out around -16dB, and a fixture that quiet would pass a waveform test
  // only because the drawing scales quiet material up.
  '-filter_complex', "[1:a]volume='lt(mod(t,1),0.4)':eval=frame,volume=5[a]",
  '-map', '0:v', '-map', '[a]',
  '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p',
  '-c:a', 'aac', '-b:a', '128k', '-shortest',
  out,
], { stdio: 'inherit' })
if (r.error || r.status !== 0) {
  console.error('ffmpeg failed — is it on PATH, or set PF_FFMPEG?')
  process.exit(1)
}
console.log('wrote ' + out)
