// Smoke test for the built application, not the source tree.
//
// "It compiled" is not the same claim as "it runs". Packaging changes how files
// are reached — the renderer is served out of an asar over the app:// protocol
// rather than off disk — so the failures that only appear here are missing
// assets and wrong paths, which no test against the dev server can see.
//
// Skips cleanly when nothing has been built, so it can sit in the suite.
import { _electron as electron } from 'playwright-core'
import fs from 'fs'
import os from 'os'
import path from 'path'

const EXE = path.resolve('release/win-unpacked/PixelForge.exe')
if (!fs.existsSync(EXE)) {
  console.log('SKIP  no packaged build at ' + EXE + ' — run `npm run desktop:build` first')
  process.exit(0)
}

const checks = []
const check = (name, ok, detail = '') => {
  checks.push([name, ok])
  console.log((ok ? 'PASS  ' : 'FAIL  ') + name + (detail ? '  — ' + detail : ''))
}

// Its own profile: this is the real application, and a smoke test has no
// business writing into the settings and backups of an actual install.

// Scratch, and swept up afterwards. Each of these is a full Electron user-data
// directory — several megabytes — and a run that leaves one behind every time
// turns a temp folder into a graveyard. Thirty runs is a gigabyte, which is
// exactly what happened before this was here.
const scrubDirs = []
const scrub = () => {
  for (const d of scrubDirs) {
    try { fs.rmSync(d, { recursive: true, force: true, maxRetries: 3 }) } catch { /* held open */ }
  }
}
process.on('exit', scrub)
process.on('SIGINT', () => { scrub(); process.exit(130) })

const PROFILE = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-pkg-'))
scrubDirs.push(PROFILE)
const app = await electron.launch({
  executablePath: EXE,
  args: [],
  env: { ...process.env, PF_USER_DATA: PROFILE, PF_NO_CONFIRM: '1' },
  timeout: 60000,
})
const page = await app.firstWindow()
const errors = []
page.on('console', (m) => { if (m.type() === 'error' && !/favicon|Autofill/.test(m.text())) errors.push(m.text()) })
page.on('pageerror', (e) => errors.push('PAGEERROR: ' + e.message))
await page.waitForLoadState('domcontentloaded')

const url = page.url()
console.log('packaged window url:', url)
check('the packaged app opens a window', !!url)
check('served over app://, not file://', url.startsWith('app://'))

await page.waitForSelector('canvas', { timeout: 20000 })
const ui = await page.evaluate(() => ({
  canvas: !!document.querySelector('canvas'),
  buttons: document.querySelectorAll('button').length,
  title: document.title,
}))
console.log('ui:', JSON.stringify(ui))
check('the interface rendered', ui.canvas && ui.buttons > 5, `${ui.buttons} buttons`)

// The dev-only test handles must NOT be in a shipped build.
const handles = await page.evaluate(() => typeof window.__pfState)
check('and the dev test handles are stripped', handles === 'undefined', handles)

// The ONNX runtime asks for these by absolute path at load time — the one thing
// most likely to be missing from a package, and it fails silently until someone
// clicks Remove background.
const ort = await page.evaluate(async () => {
  const out = {}
  for (const f of ['ort-wasm-simd-threaded.jsep.wasm', 'ort-wasm-simd-threaded.jsep.mjs']) {
    try {
      const r = await fetch('/ort/' + f)
      out[f] = r.status + ':' + (r.headers.get('content-type') || '?')
    } catch (err) {
      out[f] = 'threw ' + err.message
    }
  }
  return out
})
console.log('ort assets:', JSON.stringify(ort))
check('the ONNX runtime files are in the package',
  Object.values(ort).every((v) => v.startsWith('200')), JSON.stringify(ort))

// The bridge the renderer depends on for files, encoding and window controls.
const bridge = await page.evaluate(() => {
  const b = window.pixelforge
  return b ? { win: !!b.win, backup: !!b.backup, tempFile: typeof b.tempFile } : null
})
console.log('bridge:', JSON.stringify(bridge))
check('the preload bridge is wired up',
  bridge && bridge.win && bridge.backup && bridge.tempFile === 'function')

// Backups have to land in the packaged app's own data folder.
const wrote = await page.evaluate(async () => {
  try {
    return await window.pixelforge.backup.write(new Uint8Array(32), 'Packaged', 'save')
  } catch (err) {
    return 'ERROR ' + err.message
  }
})
console.log('backup written to:', wrote)
check('and backups write into the user data folder',
  typeof wrote === 'string' && wrote.startsWith(path.join(PROFILE, 'backups')), String(wrote))

// Test fixtures have no business in a shipped installer. The status alone
// cannot answer this: the app:// handler falls back to index.html for anything
// missing, so a fixture that is absent still answers 200 — with HTML. What
// settles it is whether the bytes are actually a GIF.
const fixtures = await page.evaluate(async () => {
  const r = await fetch('/test/motion.gif')
  const head = new Uint8Array((await r.arrayBuffer()).slice(0, 3))
  return { status: r.status, gif: String.fromCharCode(...head) === 'GIF' }
})
console.log('fixture probe:', JSON.stringify(fixtures))
check('test fixtures were left out of the package', fixtures.gif === false,
  JSON.stringify(fixtures))

await page.screenshot({ path: 'shots-desktop/02-packaged.png' }).catch(() => {})
console.log(errors.length ? 'CONSOLE ERRORS: ' + errors.slice(0, 5).join(' | ') : 'no console errors')
check('no console errors on startup', errors.length === 0, errors.slice(0, 2).join(' | '))

await app.close()
process.exit(checks.some(([, ok]) => !ok) ? 1 : 0)
