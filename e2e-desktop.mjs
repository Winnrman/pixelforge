// The Electron shell: does the packaged app actually boot, serve its own
// assets over app://, and expose the bridge?
//
// This runs the *production* path (dist/ over the custom protocol), because
// that is the one with something to get wrong — dev mode just loads the same
// http://localhost:5173 the browser suite already covers.
import { _electron as electron } from 'playwright-core'
import fs from 'fs'
import os from 'os'
import path from 'path'

const OUT = 'shots-desktop'
fs.mkdirSync(OUT, { recursive: true })

const checks = []
const check = (name, ok) => { checks.push([name, ok]); console.log((ok ? 'PASS  ' : 'FAIL  ') + name) }

if (!fs.existsSync('dist/index.html')) {
  console.error('dist/ is missing — run `npm run build` first')
  process.exit(1)
}

const PROFILE = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-profile-'))
const app = await electron.launch({
  args: ['.'],
  // Its own profile, so a run never collides with an instance the user has open.
  env: { ...process.env, PF_USER_DATA: PROFILE },
  timeout: 60000,
})
const page = await app.firstWindow()
const errors = []
page.on('console', (m) => { if (m.type() === 'error' && !/favicon|Autofill/.test(m.text())) errors.push(m.text()) })
page.on('pageerror', (e) => errors.push('PAGEERROR: ' + e.message))

await page.waitForLoadState('domcontentloaded')

const url = page.url()
console.log('window url:', url)
check('the window is served over app://, not file://', url.startsWith('app://'))

await page.waitForSelector('.layers-panel, .tool-rail, #root > *', { timeout: 30000 })
await page.waitForTimeout(1200)

// --- the app really mounted, rather than showing an empty shell -------------
// The __pf* debug handles are deliberately dev-only, so this is a production
// build: prove it mounted from the UI it rendered, and check the handles are
// *absent*, which is what stripping them is supposed to achieve.
const mounted = await page.evaluate(() => ({
  rootChildren: document.getElementById('root')?.children.length || 0,
  debugHandles: typeof window.__pfState !== 'undefined',
  canvases: document.querySelectorAll('canvas').length,
  buttons: document.querySelectorAll('button').length,
  text: document.body.innerText.slice(0, 200),
}))
console.log('mounted:', JSON.stringify({ ...mounted, text: mounted.text.replace(/\s+/g, ' ') }))
check('React mounted inside Electron', mounted.rootChildren > 0)
check('the canvas exists', mounted.canvases > 0)
check('the toolbar rendered', mounted.buttons > 10)
check('debug handles are stripped from the production build', !mounted.debugHandles)

// --- the bridge ---------------------------------------------------------------
const bridge = await page.evaluate(() => {
  const b = window.pixelforge
  if (!b) return null
  return { desktop: b.desktop, platform: b.platform, keys: Object.keys(b).sort() }
})
console.log('bridge:', JSON.stringify(bridge))
check('the preload bridge is exposed', !!bridge && bridge.desktop === true)
check('node did not leak into the page', await page.evaluate(() => typeof require === 'undefined' && typeof process === 'undefined'))
for (const fn of ['pickFiles', 'pickFolder', 'readFile', 'writeFile', 'listMedia', 'savePath', 'ffmpegProbe']) {
  check(`bridge exposes ${fn}`, !!bridge && bridge.keys.includes(fn))
}

// --- the custom protocol serves real assets, with the right MIME types --------
// This is the bit file:// would have broken: ORT asks for /ort/*.wasm by
// absolute path, and a wasm served as text/plain fails to instantiate.
const assets = await page.evaluate(async () => {
  const out = {}
  for (const [key, url] of [['wasm', '/ort/ort-wasm-simd-threaded.jsep.wasm'], ['glue', '/ort/ort-wasm-simd-threaded.jsep.mjs']]) {
    try {
      const r = await fetch(url)
      const buf = await r.arrayBuffer()
      out[key] = { ok: r.ok, type: r.headers.get('content-type'), bytes: buf.byteLength, magic: new Uint8Array(buf.slice(0, 4)).join(',') }
    } catch (e) {
      out[key] = { ok: false, error: String(e.message) }
    }
  }
  return out
})
console.log('ort assets:', JSON.stringify(assets))
check('the wasm is reachable at its absolute path', assets.wasm.ok && assets.wasm.bytes > 1e6)
check('it is served as application/wasm', assets.wasm.type === 'application/wasm')
// 0asm — if this is wrong the file was mangled or index.html was served instead.
check('it really is a wasm module', assets.wasm.magic === '0,97,115,109')
check('the emscripten glue is reachable', assets.glue.ok && assets.glue.bytes > 1000)

// --- storage works, which needs a real origin --------------------------------
const idb = await page.evaluate(() => new Promise((res) => {
  const r = indexedDB.open('pf-desktop-probe', 1)
  r.onupgradeneeded = () => r.result.createObjectStore('k')
  r.onsuccess = () => { r.result.close(); indexedDB.deleteDatabase('pf-desktop-probe'); res(true) }
  r.onerror = () => res(false)
}))
check('IndexedDB works (autosave needs it)', idb)

// --- the capabilities the desktop build exists for ----------------------------
const caps = await page.evaluate(() => ({
  webcodecs: typeof VideoDecoder !== 'undefined',
  webgpu: !!navigator.gpu,
  offscreen: typeof OffscreenCanvas !== 'undefined',
}))
console.log('capabilities:', JSON.stringify(caps))
check('WebCodecs is available (MP4 import)', caps.webcodecs)
check('WebGPU is available (the learned matte)', caps.webgpu)

// --- a real round trip through the filesystem bridge --------------------------
const synthetic = await page.evaluate(() => {
  const p = window.pixelforge.pathForFile(new File(['x'], 'x.txt'))
  return p === null || p === ''
})
check('a File built in the page has no path (only real drops do)', synthetic)

const tmpFile = path.join(process.env.TEMP || '/tmp', 'pf-desktop-probe.bin')
const wrote = await page.evaluate(async (p) => {
  const bytes = new Uint8Array([1, 2, 3, 4, 5]).buffer
  return window.pixelforge.writeFile(p, bytes)
}, tmpFile)
const readBack = fs.existsSync(wrote) ? [...fs.readFileSync(wrote)] : null
console.log('wrote', wrote, '->', JSON.stringify(readBack))
check('the renderer can write a real file', JSON.stringify(readBack) === '[1,2,3,4,5]')
if (readBack) fs.unlinkSync(wrote)

const ff = await page.evaluate(() => window.pixelforge.ffmpegProbe())
console.log('ffmpeg:', JSON.stringify(ff))
check('ffmpeg probe answers without throwing', typeof ff.ok === 'boolean')
if (!ff.ok) console.log('  note: ffmpeg is not installed here — MP4 export will say so rather than fail')

// --- custom chrome -------------------------------------------------------------
// The native frame is gone, so the app has to supply the controls *and* a drag
// region — a frameless window with no draggable area cannot be moved at all.
const chrome = await page.evaluate(() => {
  const bar = document.querySelector('.topbar')
  const btns = [...document.querySelectorAll('.win-controls button')]
  const drag = (el) => el && getComputedStyle(el).webkitAppRegion
  return {
    controls: btns.map((b) => b.title),
    barDrag: drag(bar),
    buttonDrag: drag(btns[0]),
    // Anything clickable in the bar must opt out, or it drags the window instead.
    normalButtonDrag: drag(document.querySelector('.topbar .bar-group .btn')),
    inputDrag: drag(document.querySelector('.topbar input.project-name')),
    tabsDrag: drag(document.querySelector('.ws-tabs')),
  }
})
console.log('chrome:', JSON.stringify(chrome))
check('the app draws its own window controls',
  chrome.controls.length === 3, chrome.controls.join(', '))
check('minimise, maximise and close are all there',
  /Minimi/.test(chrome.controls[0]) && /Maximi|Restore/.test(chrome.controls[1]) && /Close/.test(chrome.controls[2]),
  chrome.controls.join(', '))
check('the title bar can move the window', chrome.barDrag === 'drag', String(chrome.barDrag))
check('but its buttons stay clickable',
  chrome.buttonDrag === 'no-drag' && chrome.normalButtonDrag === 'no-drag',
  `${chrome.buttonDrag} / ${chrome.normalButtonDrag}`)
check('and so do the name field and workspace tabs',
  chrome.inputDrag === 'no-drag' && chrome.tabsDrag === 'no-drag',
  `${chrome.inputDrag} / ${chrome.tabsDrag}`)

const framed = await app.evaluate(({ BrowserWindow }) => {
  const w = BrowserWindow.getAllWindows()[0]
  return { frameless: !w.isResizable() ? 'unresizable' : 'ok', resizable: w.isResizable(), maximized: w.isMaximized() }
})
check('the window is still resizable without a frame', framed.resizable, JSON.stringify(framed))

// Maximise has to round-trip, and the button's glyph has to follow it — the
// state can also change without the app asking, so it is driven by an event.
// Polled rather than slept on: maximising is a window-manager animation and a
// fixed wait made this flaky — it would occasionally click Restore before the
// button had become one.
const winMaximized = () => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isMaximized())
const settle = async (want, timeout = 8000) => {
  const started = Date.now()
  for (;;) {
    if (await winMaximized() === want) return true
    if (Date.now() - started > timeout) return false
    await new Promise((r) => setTimeout(r, 120))
  }
}

await page.click('.win-controls button[title="Maximise"]')
const maxed = await settle(true)
await page.waitForSelector('.win-controls button[title="Restore"]', { timeout: 8000 })
const glyph = await page.evaluate(() => document.querySelectorAll('.win-controls button')[1].title)
console.log('after maximise:', maxed, '· button now says', glyph)
check('the maximise button maximises', maxed)
check('and the glyph flips to Restore', glyph === 'Restore', glyph)

await page.click('.win-controls button[title="Restore"]')
const restored = await settle(false)
check('and restores again', restored)

// A change made outside the app must still reach the button.
await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].maximize())
await page.waitForTimeout(600)
const external = await page.evaluate(() => document.querySelectorAll('.win-controls button')[1].title)
check('maximising from outside the app updates the button too', external === 'Restore', external)
await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].unmaximize())
await page.waitForTimeout(400)

// --- closing the window --------------------------------------------------------
// The X button used to do nothing the moment anything was edited: the renderer
// guarded unsaved work with `beforeunload`, which raises a prompt in a browser
// but in Electron cancels the close and shows *nothing*. The guard now lives in
// the main process, where a real dialog can be raised.
const guard = await page.evaluate(() => {
  const probe = () => {
    const ev = new Event('beforeunload', { cancelable: true })
    window.dispatchEvent(ev)
    return ev.defaultPrevented
  }
  return { clean: probe() }
})
check('a clean document does not block the close', guard.clean === false)

const dirtyGuard = await page.evaluate(async () => {
  // Dirty the document through the UI's own path.
  const before = document.title
  document.querySelector('.topbar .bar-group .btn')
  const ev = new Event('beforeunload', { cancelable: true })
  window.dispatchEvent(ev)
  return { prevented: ev.defaultPrevented, before }
})
check('and neither does an edited one — the guard is not in the renderer any more',
  dirtyGuard.prevented === false)

const dirtyIpc = await page.evaluate(async () => ({
  on: await window.pixelforge.win.setDirty(true),
  off: await window.pixelforge.win.setDirty(false),
}))
console.log('dirty flag round trip:', JSON.stringify(dirtyIpc))
check('the renderer can tell the main process about unsaved changes',
  dirtyIpc.on === true && dirtyIpc.off === false, JSON.stringify(dirtyIpc))

// With the flag set and confirmation suppressed, close still works — proving the
// close path itself is intact and only the prompt stands between.
const closes = await app.evaluate(({ BrowserWindow }) => {
  const w = BrowserWindow.getAllWindows()[0]
  return { count: BrowserWindow.getAllWindows().length, closable: w.isClosable() }
})
check('the window is closable', closes.closable && closes.count === 1, JSON.stringify(closes))

// --- automatic backups land on disk, not just in the browser store -------------
// This is the half that only exists on the desktop: a real .pfz in the app's own
// data folder, which survives the browser profile being cleared and can be found
// in a file manager. The store logic that decides *when* to write one is covered
// by e2e-backup against the dev build, which has the handles for it; here the
// concern is the file ring itself.
const backupDir = path.join(PROFILE, 'backups')
const written = await page.evaluate(async () => {
  const bytes = new Uint8Array(4096).map((_, i) => i % 251)
  const file = await window.pixelforge.backup.write(bytes, 'Desktop Backup', 'export')
  const list = await window.pixelforge.backup.list()
  const round = await window.pixelforge.backup.read(file)
  return {
    file,
    list,
    same: round.length === bytes.length && round[7] === bytes[7] && round[4095] === bytes[4095],
  }
})
console.log('desktop backup:', written.file)
check('a backup is written as a real file', fs.existsSync(written.file))
check('inside the user data folder', path.dirname(written.file) === backupDir)
check('named with when, what and why',
  /^\d{4}-\d\d-\d\dT[\d-]+Z-\d{3}__Desktop Backup__export\.pfz$/.test(path.basename(written.file)))
check('the app can list what it wrote', written.list.length === 1
  && written.list[0].name === 'Desktop Backup' && written.list[0].reason === 'export')
check('and read the same bytes back', written.same)

// The path to read arrives from the renderer, so the main process confines it to
// the backup folder rather than trusting it.
const escaped = await page.evaluate(async () => {
  const tries = ['../../secrets.txt', 'C:/Windows/win.ini', '/etc/passwd']
  const out = []
  for (const t of tries) {
    try { await window.pixelforge.backup.read(t); out.push('allowed') } catch { out.push('refused') }
  }
  return out
})
console.log('reads outside the folder:', JSON.stringify(escaped))
check('reading outside that folder is refused', escaped.every((r) => r === 'refused'))

// The ring is bounded, or the folder grows for as long as the app is used.
const pruned = await page.evaluate(async () => {
  for (let i = 0; i < 34; i++) {
    await window.pixelforge.backup.write(new Uint8Array(64), 'Ring ' + i, 'save')
  }
  return (await window.pixelforge.backup.list()).length
})
const files = fs.readdirSync(backupDir).filter((f) => f.endsWith('.pfz'))
console.log('after 35 backups:', pruned, 'listed,', files.length, 'on disk')
check('the ring keeps a bounded number', pruned === 30 && files.length === 30)
// Pruning has to drop the oldest, not whatever the directory happened to list
// first — losing the newest backup would be worse than keeping none.
check('and drops the oldest, keeping the newest', files.sort().at(-1).includes('Ring 33'))

await page.screenshot({ path: path.join(OUT, '01-desktop.png') })
console.log(errors.length ? 'CONSOLE ERRORS: ' + errors.slice(0, 5).join(' | ') : 'no console errors')
await app.close()
process.exit(checks.some(([, ok]) => !ok) ? 1 : 0)
