// A dozen distinct "photos" for the collage tests.
//
// Deliberately mixed aspect ratios — tall, wide and square — because the thing
// worth checking is that each one is cropped to fill its mount rather than
// squashed into it. Each carries a flat colour band top-left so a test can tell
// which photo landed where.
import { spawnSync } from 'child_process'
import fs from 'fs'

const bin = process.env.PF_FFMPEG || 'ffmpeg'
const DIR = 'public/test/photos'

const SIZES = [
  [640, 480], [480, 640], [800, 450], [500, 500], [720, 405], [400, 700],
  [900, 600], [600, 900], [640, 640], [1024, 576], [560, 840], [768, 432],
]

fs.mkdirSync(DIR, { recursive: true })
let made = 0
for (let i = 0; i < SIZES.length; i++) {
  const [w, h] = SIZES[i]
  const hue = Math.round((i / SIZES.length) * 360)
  const out = `${DIR}/photo-${String(i + 1).padStart(2, '0')}.png`
  const r = spawnSync(bin, [
    '-y', '-v', 'error',
    '-f', 'lavfi', '-i', `testsrc2=size=${w}x${h}:rate=1`,
    '-vf', `hue=h=${hue}:s=1.4,drawbox=x=0:y=0:w=${Math.round(w / 3)}:h=${Math.round(h / 6)}:color=black@0.85:t=fill`,
    '-frames:v', '1',
    out,
  ])
  if (r.status === 0) made++
}

if (!made) {
  console.error('ffmpeg not available — skipping the photo set (collage tests will skip too)')
  process.exit(0)
}
const bytes = fs.readdirSync(DIR).reduce((n, f) => n + fs.statSync(`${DIR}/${f}`).size, 0)
console.log(`wrote ${made} photos to ${DIR} (${(bytes / 1024).toFixed(0)}KB, mixed aspect ratios)`)
