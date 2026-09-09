#!/usr/bin/env node
// PixelForge from the command line.
//
//   node pf.mjs render card.json --out card.png
//   node pf.mjs render card.json --out card.gif --fps 24
//   node pf.mjs render card.json --out frames/ --frames
//
// A spec is a plain description of a document: a size, a background, and a list
// of layers. Every field a layer does not mention takes the same default the
// interface would have given it, so the smallest useful spec is a handful of
// lines and nothing has to be said twice.
//
// It runs the real engine in a headless browser rather than reimplementing it
// against a node canvas. The renderer *is* canvas code — filters, gradients,
// text metrics, font fallback — and a second renderer is a second set of
// answers to keep in step with the first. Headless here means no interface and
// no person, not no browser.
import { chromium } from 'playwright-core'
import { build } from 'esbuild'
import http from 'http'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const CHROME = process.env.PF_CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe'

const HELP = `PixelForge — render a document without opening the editor

  node pf.mjs render <spec.json> --out <file>

Options
  --out <path>     .png, .gif, or a directory with --frames
  --time <ms>      which instant to draw for a still            (default 0)
  --fps <n>        frames a second for a gif                    (default 20)
  --duration <ms>  how long to run; defaults to the document's
  --frames         write a numbered png per frame instead of a gif
  --scale <n>      multiply the output size                     (default 1)

A spec is a document: { width, height, background, duration, layers: [...] }.
Layers are the same objects the editor uses, with every default filled in, so
{ "type": "text", "text": "Hello", "x": 40, "y": 40, "size": 64 } is enough.
Media is listed alongside and referred to by name:
  "media": [{ "id": "hero", "file": "photo.jpg" }],
  "layers": [{ "type": "image", "asset": "hero", "x": 0, "y": 0, "w": 800, "h": 600 }]
`

const args = process.argv.slice(2)
const flag = (name, fallback = null) => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : fallback
}
const has = (name) => args.includes(`--${name}`)

if (!args.length || has('help') || args[0] === 'help') {
  console.log(HELP)
  process.exit(0)
}
if (args[0] !== 'render') {
  console.error(`Unknown command "${args[0]}". Try: node pf.mjs --help`)
  process.exit(1)
}

const specPath = args[1]
if (!specPath || specPath.startsWith('--')) {
  console.error('Which spec? node pf.mjs render <spec.json> --out <file>')
  process.exit(1)
}
if (!fs.existsSync(specPath)) {
  console.error(`No such spec: ${specPath}`)
  process.exit(1)
}

const out = flag('out')
if (!out) {
  console.error('Where to? Pass --out <file.png|file.gif|directory>')
  process.exit(1)
}

const spec = JSON.parse(fs.readFileSync(specPath, 'utf8'))
const specDir = path.dirname(path.resolve(specPath))

// Media is read here rather than in the browser: the page has no filesystem,
// and a spec that names a photo beside itself is the obvious thing to write.
const media = (spec.media || []).map((m) => {
  const file = path.resolve(specDir, m.file)
  if (!fs.existsSync(file)) {
    console.error(`Media not found: ${m.file} (looked in ${specDir})`)
    process.exit(1)
  }
  return {
    id: m.id,
    name: m.name || path.basename(file),
    type: m.type || guessType(file),
    bytes: fs.readFileSync(file).toString('base64'),
  }
})

function guessType(file) {
  const ext = path.extname(file).toLowerCase()
  return {
    '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
    '.gif': 'image/gif', '.webp': 'image/webp', '.mp4': 'video/mp4',
  }[ext] || 'application/octet-stream'
}

// --- the engine, bundled for a blank page -------------------------------------
const bundle = await build({
  entryPoints: [path.join(HERE, 'scripts', 'headless-entry.js')],
  bundle: true,
  format: 'iife',
  write: false,
  platform: 'browser',
  logLevel: 'silent',
  define: { 'import.meta.env.DEV': 'false', 'import.meta.env.PROD': 'true' },
})
const engineJs = bundle.outputFiles[0].text

// Served rather than inlined: an `app://`-like real origin is what canvas needs
// to read its own pixels back without tainting, and a data: URL is not one.
const server = http.createServer((req, res) => {
  if (req.url === '/engine.js') {
    res.writeHead(200, { 'content-type': 'text/javascript' })
    res.end(engineJs)
    return
  }
  res.writeHead(200, { 'content-type': 'text/html' })
  res.end('<!doctype html><meta charset="utf-8"><body><script src="/engine.js"></script></body>')
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const origin = `http://127.0.0.1:${server.address().port}`

const browser = await chromium.launch({ executablePath: CHROME, headless: true })
const page = await browser.newPage()
const problems = []
page.on('pageerror', (e) => problems.push(e.message))
page.on('console', (m) => { if (m.type() === 'error') problems.push(m.text()) })
await page.goto(origin, { waitUntil: 'networkidle' })
await page.waitForFunction(() => !!window.__pfHeadless, { timeout: 20000 })

const scale = Number(flag('scale', '1')) || 1
const ready = await page.evaluate(async ([s, m, k]) => {
  let doc = window.__pfHeadless.buildDoc(s)
  if (m.length) doc = await window.__pfHeadless.loadMedia(doc, m)
  if (k !== 1) {
    doc = {
      ...doc,
      width: Math.round(doc.width * k),
      height: Math.round(doc.height * k),
      layers: doc.layers.map((l) => (l.type === 'group' ? l : {
        ...l,
        x: (l.x ?? 0) * k, y: (l.y ?? 0) * k,
        w: (l.w ?? 0) * k, h: (l.h ?? 0) * k,
        ...(l.size ? { size: l.size * k } : null),
      })),
    }
  }
  window.__pfDoc = doc
  return { layers: doc.layers.length, w: doc.width, h: doc.height }
}, [spec, media, scale])

const write = (file, base64) => {
  fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true })
  fs.writeFileSync(file, Buffer.from(base64, 'base64'))
  return fs.statSync(file).size
}
const strip = (url) => url.slice(url.indexOf(',') + 1)

let wrote = []
if (has('frames')) {
  const fps = Number(flag('fps', '20')) || 20
  const duration = flag('duration') ? Number(flag('duration')) : null
  const times = await page.evaluate(([f, d]) =>
    window.__pfHeadless.frameTimes(window.__pfDoc, { fps: f, duration: d }), [fps, duration])
  fs.mkdirSync(out, { recursive: true })
  for (let i = 0; i < times.length; i++) {
    const url = await page.evaluate((t) => window.__pfHeadless.renderFrame(window.__pfDoc, t), times[i])
    const file = path.join(out, `${String(i).padStart(4, '0')}.png`)
    write(file, strip(url))
    wrote.push(file)
  }
  console.log(`${times.length} frames -> ${out}`)
} else if (out.toLowerCase().endsWith('.gif')) {
  const fps = Number(flag('fps', '20')) || 20
  const duration = flag('duration') ? Number(flag('duration')) : null
  const gif = await page.evaluate(([f, d]) =>
    window.__pfHeadless.renderGif(window.__pfDoc, { fps: f, duration: d }), [fps, duration])
  const size = write(out, gif.base64)
  wrote.push(out)
  console.log(`${gif.frames} frames, ${(size / 1024).toFixed(0)} KB -> ${out}`)
} else {
  const time = Number(flag('time', '0')) || 0
  const url = await page.evaluate((t) => window.__pfHeadless.renderFrame(window.__pfDoc, t), time)
  const size = write(out, strip(url))
  wrote.push(out)
  console.log(`${ready.w}x${ready.h}, ${(size / 1024).toFixed(0)} KB -> ${out}`)
}

await browser.close()
server.close()

if (problems.length) {
  console.error('\nThe page reported problems while rendering:')
  for (const p of problems.slice(0, 5)) console.error('  ' + p)
  process.exit(1)
}
process.exit(wrote.length ? 0 : 1)
