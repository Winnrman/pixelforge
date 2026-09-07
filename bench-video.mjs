// How much decode work one second of playback actually costs.
//
// Simulates the playhead advancing through a clip exactly as the render loop
// does — ensureDecoded then frameAt, one call per displayed frame — and reports
// how many encoded samples the decoder was handed to produce them. Anything far
// above 1:1 is work being thrown away, which is what a long video feels like as
// stutter.
import { chromium } from 'playwright-core'

const FIXTURE = process.argv[2] || 'public/test/long.mp4'
const SECONDS = Number(process.argv[3] || 20)

const browser = await chromium.launch({
  executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  headless: true,
})
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
page.on('pageerror', (e) => console.log('PAGEERROR', e.message))
await page.goto('http://localhost:5173/', { waitUntil: 'networkidle' })

const out = await page.evaluate(async ([file, seconds]) => {
  const buf = await (await fetch('/' + file.replace(/^public\//, ''))).arrayBuffer()
  const V = window.__pfVideo
  const asset = await V.loadVideo(buf, 'bench.mp4', 'video/mp4')
  V.resetDecodeStats()

  const fps = asset.times.length / (asset.duration / 1000)
  const step = 1000 / fps
  const frames = Math.min(asset.times.length, Math.round(seconds * fps))

  const t0 = performance.now()
  let missed = 0
  let waited = 0
  for (let i = 0; i < frames; i++) {
    const ms = i * step
    // Exactly what the renderer does: ask for the frame, take whatever is there.
    V.ensureDecoded(asset, ms)
    const got = V.frameAt(asset, ms)
    if (!got) missed++
    // A real player cannot run ahead of the decoder for ever; wait when the
    // frame it wants is genuinely absent, which is what a stall looks like.
    if (!asset.cache.map.has(V.indexAt(asset, ms))) {
      waited++
      // Give the decoder a turn; it fills the cache from its own callbacks.
      await new Promise((r) => setTimeout(r, 2))
    }
  }
  const ms = performance.now() - t0
  const st = V.decodeStats
  return {
    frames,
    fps: Math.round(fps),
    width: asset.width,
    height: asset.height,
    total: asset.times.length,
    durationS: Math.round(asset.duration / 1000),
    cacheLimit: asset.cache.limit,
    chunks: st.chunks,
    kept: st.kept,
    passes: st.passes,
    scans: st.scans,
    missed,
    waited,
    ms: Math.round(ms),
  }
}, [FIXTURE, SECONDS])

const ratio = (out.chunks / out.frames).toFixed(1)
console.log(JSON.stringify(out, null, 2))
console.log('')
console.log(`clip          ${out.width}x${out.height}, ${out.total} frames, ${out.durationS}s @ ${out.fps}fps`)
console.log(`cache holds   ${out.cacheLimit} frames`)
console.log(`played        ${out.frames} frames in ${out.ms}ms (${(out.frames / (out.ms / 1000)).toFixed(1)} fps)`)
console.log(`decoded       ${out.chunks} samples  ->  ${ratio}x more work than frames shown`)
console.log(`kept          ${out.kept} of them (${((out.kept / Math.max(1, out.chunks)) * 100).toFixed(0)}% of decode work reused)`)
console.log(`decode passes ${out.passes}, sample-table scans ${out.scans.toLocaleString()}`)
console.log(`stalls        ${out.waited} frames waited, ${out.missed} shown as nothing`)

await browser.close()
