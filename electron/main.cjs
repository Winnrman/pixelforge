// Electron main process.
//
// The renderer is the *same* Vite app the browser build serves — nothing in
// src/ knows it is running in Electron except through the narrow bridge in
// preload.cjs. That keeps the web build a first-class target rather than a
// stale fork.
const { app, BrowserWindow, Menu, protocol, net, ipcMain, dialog, shell } = require('electron')
const path = require('path')
const fs = require('fs/promises')
const { spawn } = require('child_process')

// A second instance sharing the default profile fights the first for the
// IndexedDB lock, so the test runs point somewhere of their own rather than
// depending on the user not having the app open.
if (process.env.PF_USER_DATA) app.setPath('userData', process.env.PF_USER_DATA)

const DEV_URL = process.env.PF_DEV_URL || 'http://localhost:5173'
const isDev = !!process.env.PF_DEV
const DIST = path.join(__dirname, '..', 'dist')

// The app is served over app:// rather than file:// so that absolute URLs keep
// resolving. ONNX Runtime asks for /ort/*.wasm by absolute path, and under
// file:// that resolves to the drive root and 404s. A custom scheme also gives
// the renderer a real origin, which IndexedDB (autosave) requires.
protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
])

const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.css': 'text/css', '.json': 'application/json', '.wasm': 'application/wasm',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.gif': 'image/gif', '.mp4': 'video/mp4', '.webm': 'video/webm',
  '.woff2': 'font/woff2', '.onnx': 'application/octet-stream',
}

function serveDist() {
  protocol.handle('app', async (req) => {
    const url = new URL(req.url)
    // Anything that is not a real file falls back to index.html, so a reload
    // never lands on a 404.
    let rel = decodeURIComponent(url.pathname).replace(/^\/+/, '') || 'index.html'
    let file = path.join(DIST, rel)
    if (!file.startsWith(DIST)) return new Response('forbidden', { status: 403 })
    try {
      if ((await fs.stat(file)).isDirectory()) file = path.join(file, 'index.html')
    } catch {
      file = path.join(DIST, 'index.html')
    }
    const res = await net.fetch('file:///' + file.replace(/\\/g, '/'))
    const headers = new Headers(res.headers)
    headers.set('Content-Type', MIME[path.extname(file).toLowerCase()] || 'application/octet-stream')
    return new Response(res.body, { status: res.status, headers })
  })
}

let win = null
// Mirrors the renderer's unsaved-changes flag, so the main process can decide
// whether closing needs a prompt.
let dirty = false
let forceClose = false

function createWindow() {
  win = new BrowserWindow({
    width: 1600,
    height: 1000,
    // Packaged builds take their icon from the executable, but a `npm run
    // desktop` window would otherwise show the stock Electron atom.
    icon: path.join(__dirname, '..', 'build', 'icon.ico'),
    minWidth: 1100,
    minHeight: 700,
    backgroundColor: '#12141a',
    show: false,
    autoHideMenuBar: true,
    // The app draws its own title bar. On macOS the traffic lights are kept and
    // inset, because replacing them looks wrong and breaks muscle memory; on
    // Windows and Linux the frame goes entirely and the top bar supplies its own
    // minimise/maximise/close.
    ...(process.platform === 'darwin'
      ? { titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 14, y: 14 } }
      : { frame: false }),
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  })
  win.once('ready-to-show', () => win.show())

  // Closing a frameless window.
  //
  // The renderer used to guard unsaved work with `beforeunload`. In a browser
  // that raises the "leave site?" prompt; in Electron it cancels the close and
  // shows *nothing*, so the X button silently did nothing the moment anything
  // was edited. The renderer no longer registers that handler on the desktop,
  // and the decision is made here where a real dialog can be shown.
  win.on('close', (e) => {
    if (!dirty || forceClose || process.env.PF_NO_CONFIRM) return
    e.preventDefault()
    dialog.showMessageBox(win, {
      type: 'warning',
      buttons: ['Discard and close', 'Cancel'],
      defaultId: 1,
      cancelId: 1,
      title: 'Unsaved changes',
      message: 'This project has changes that are not saved.',
      detail: 'Save keeps it on this machine; Export → Project writes a .pfz file.',
    }).then(({ response }) => {
      if (response !== 0) return
      forceClose = true
      // destroy() rather than close(), so this handler cannot run a second time.
      win.destroy()
    })
  })

  // The maximise button has to reflect reality, including changes the app never
  // initiated — a double-click on the drag region, or Win+Up.
  const tellState = () => {
    if (!win || win.isDestroyed() || win.webContents.isDestroyed()) return
    win.webContents.send('pf:winState', { maximized: win.isMaximized(), fullScreen: win.isFullScreen() })
  }
  for (const ev of ['maximize', 'unmaximize', 'enter-full-screen', 'leave-full-screen', 'restore']) {
    win.on(ev, tellState)
  }
  // External links open in the real browser; the app window never navigates.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url)
    return { action: 'deny' }
  })
  if (isDev) {
    win.loadURL(DEV_URL)
  } else {
    win.loadURL('app://pixelforge/index.html')
  }
}

// The default menu binds Ctrl+C/Ctrl+V to native copy/paste roles, which would
// shadow the editor's own layer copy/paste. Chromium still handles clipboard
// shortcuts inside text inputs without a menu entry, so those are left out
// rather than fought with.
function buildMenu() {
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    {
      label: 'File',
      submenu: [
        { label: 'Reload', accelerator: 'CmdOrCtrl+R', click: () => win && win.webContents.reload() },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    {
      label: 'View',
      submenu: [
        { role: 'togglefullscreen' },
        { label: 'Developer Tools', accelerator: 'F12', click: () => win && win.webContents.toggleDevTools() },
      ],
    },
  ]))
}

// --- opening a .pfz from the shell ---------------------------------------------
//
// Double-clicking a project used to launch the app and then sit there empty: the
// path arrives as a command-line argument, and nothing was reading it. The
// renderer already knows how to open one, so all this does is find the path and
// hand it over once there is a window to hand it to.

/** The project file in a set of launch arguments, if there is one. */
function projectArg(argv) {
  // Skip the executable, and in development the script path as well. Flags are
  // skipped by the extension test — Electron adds several of its own.
  return argv.slice(1).find((a) => /\.pfz$/i.test(a) && !a.startsWith('-')) || null
}

// Held until the renderer says it is listening. A path found at launch arrives
// long before the window exists, and sending into a window that is still loading
// simply loses it.
let pendingOpen = projectArg(process.argv)
let rendererReady = false

function flushOpen() {
  if (!rendererReady || !pendingOpen || !win) return
  win.webContents.send('pf:openPath', pendingOpen)
  pendingOpen = null
}

ipcMain.handle('pf:ready', () => {
  rendererReady = true
  flushOpen()
  return true
})

// A second launch — double-clicking another project while this one is open —
// is handed to the window already running rather than starting a second app.
/**
 * Brings a window to the front, and means it.
 *
 * Windows refuses focus to a process that is not the one the user is already
 * working in, which is the right rule almost everywhere and exactly wrong here:
 * launching the app *is* the user asking for it. A bare `focus()` from the
 * background flashes the taskbar button and does nothing else, so double-clicking
 * the shortcut while a copy is already running looks like the app failing to
 * start — no window, no error, nothing.
 *
 * Briefly claiming always-on-top is the way past it: the window is raised as a
 * property of itself rather than by asking for focus, and the claim is dropped
 * again immediately so it does not sit over everything else afterwards.
 */
function surface(w) {
  if (!w || w.isDestroyed()) return
  if (w.isMinimized()) w.restore()
  if (!w.isVisible()) w.show()
  const wasOnTop = w.isAlwaysOnTop()
  w.setAlwaysOnTop(true)
  w.show()
  w.setAlwaysOnTop(wasOnTop)
  w.focus()
}

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', (_e, argv) => {
    const file = projectArg(argv)
    if (file) { pendingOpen = file; flushOpen() }
    surface(win)
  })
}

// macOS does not use argv for this; it sends an event, possibly before ready.
app.on('open-file', (e, path) => {
  e.preventDefault()
  pendingOpen = path
  flushOpen()
})

app.whenReady().then(() => {
  if (!isDev) serveDist()
  buildMenu()
  createWindow()
  app.on('activate', () => BrowserWindow.getAllWindows().length === 0 && createWindow())
})
app.on('window-all-closed', () => process.platform !== 'darwin' && app.quit())

// --- window controls ----------------------------------------------------------

const focused = () => BrowserWindow.getFocusedWindow() || win

ipcMain.handle('pf:winMinimize', () => { focused()?.minimize(); return true })
ipcMain.handle('pf:winMaximize', () => {
  const w = focused()
  if (!w) return false
  if (w.isMaximized()) w.unmaximize()
  else w.maximize()
  return w.isMaximized()
})
ipcMain.handle('pf:winClose', () => { focused()?.close(); return true })
ipcMain.handle('pf:winDirty', (_e, value) => { dirty = !!value; return dirty })
ipcMain.handle('pf:winIsMaximized', () => !!focused()?.isMaximized())

// --- bridge ------------------------------------------------------------------

const MEDIA_EXT = /\.(png|jpe?g|gif|webp|bmp|avif|mp4|mov|webm|mkv|m4v)$/i

ipcMain.handle('pf:pickFiles', async (_e, opts) => {
  const o = opts || {}
  const r = await dialog.showOpenDialog(win, {
    properties: o.multi ? ['openFile', 'multiSelections'] : ['openFile'],
    filters: o.filters || [
      { name: 'Media', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'mp4', 'mov', 'webm', 'pfz'] },
    ],
  })
  return r.canceled ? [] : r.filePaths
})

ipcMain.handle('pf:pickFolder', async () => {
  const r = await dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory'] })
  return r.canceled ? null : r.filePaths[0]
})

ipcMain.handle('pf:savePath', async (_e, opts) => {
  const o = opts || {}
  const r = await dialog.showSaveDialog(win, { defaultPath: o.defaultPath, filters: o.filters })
  return r.canceled ? null : r.filePath
})

ipcMain.handle('pf:readFile', async (_e, p) => {
  const buf = await fs.readFile(p)
  // Handed over as a plain ArrayBuffer; the renderer wraps it back into a File.
  return {
    name: path.basename(p),
    bytes: buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
  }
})

ipcMain.handle('pf:writeFile', async (_e, { path: p, bytes }) => {
  await fs.mkdir(path.dirname(p), { recursive: true })
  await fs.writeFile(p, Buffer.from(bytes))
  return p
})

ipcMain.handle('pf:listMedia', async (_e, dir) => {
  const entries = await fs.readdir(dir, { withFileTypes: true })
  return entries
    .filter((d) => d.isFile() && MEDIA_EXT.test(d.name))
    .map((d) => path.join(dir, d.name))
    .sort()
})

ipcMain.handle('pf:showItem', async (_e, p) => shell.showItemInFolder(p))

// ffmpeg is detected, not bundled: shipping it would add ~80MB and drag in
// licensing questions. Anything that needs it degrades to a clear message.
let ffmpegPath = null
ipcMain.handle('pf:ffmpegProbe', async () => {
  for (const bin of [process.env.PF_FFMPEG, 'ffmpeg'].filter(Boolean)) {
    const line = await new Promise((res) => {
      const p = spawn(bin, ['-version'])
      let out = ''
      p.stdout.on('data', (d) => (out += d))
      p.on('error', () => res(null))
      p.on('close', (code) => res(code === 0 ? out.split('\n')[0] : null))
    })
    if (line) {
      ffmpegPath = bin
      return { ok: true, path: bin, version: line }
    }
  }
  return { ok: false }
})

// --- streaming encode ---------------------------------------------------------
// Frames are pushed into ffmpeg's stdin one encoded image at a time rather than
// staged as files. A 90s 1080p export is a few thousand frames; as PNGs on disk
// that is several gigabytes of intermediate, and as raw RGBA over IPC it is
// 8MB per frame. Compressed frames through a pipe are neither.
const jobs = new Map()
let jobSeq = 0

ipcMain.handle('pf:encodeStart', async (e, args) => {
  if (!ffmpegPath) throw new Error('ffmpeg not found — install it on PATH or set PF_FFMPEG')
  const id = 'enc' + ++jobSeq
  const proc = spawn(ffmpegPath, args)
  const job = { proc, err: '', done: null, failed: null }
  jobs.set(id, job)

  proc.stderr.on('data', (d) => {
    job.err += d
    if (job.err.length > 200000) job.err = job.err.slice(-40000)
    // ffmpeg reports its own progress; passing it through lets the dialog show
    // encoding separately from rendering instead of appearing to hang.
    const re = /frame=\s*(\d+)/g
    let last = null
    let hit
    while ((hit = re.exec(String(d))) !== null) last = hit[1]
    if (last && !e.sender.isDestroyed()) e.sender.send('pf:encodeProgress', { id, frame: Number(last) })
  })
  // stdin closing early (a killed ffmpeg) would otherwise throw EPIPE at us.
  proc.stdin.on('error', () => {})
  job.done = new Promise((res) => {
    proc.on('error', (err) => { job.failed = err; res(-1) })
    proc.on('close', (code) => res(code))
  })
  return { id }
})

ipcMain.handle('pf:encodeWrite', async (_e, { id, bytes }) => {
  const job = jobs.get(id)
  if (!job) throw new Error('no such encode job')
  if (job.failed) throw job.failed
  // Respect backpressure, or a fast renderer buries ffmpeg and memory climbs.
  if (!job.proc.stdin.write(Buffer.from(bytes))) {
    await new Promise((res) => job.proc.stdin.once('drain', res))
  }
  return true
})

ipcMain.handle('pf:encodeFinish', async (_e, id) => {
  const job = jobs.get(id)
  if (!job) throw new Error('no such encode job')
  try {
    job.proc.stdin.end()
    const code = await job.done
    if (job.failed) throw job.failed
    if (code !== 0) throw new Error('ffmpeg exited ' + (code | 0) + '\n' + job.err.slice(-2000))
    return { ok: true, log: job.err.slice(-4000) }
  } finally {
    jobs.delete(id)
  }
})

ipcMain.handle('pf:encodeAbort', async (_e, id) => {
  const job = jobs.get(id)
  if (!job) return false
  try { job.proc.kill() } catch { /* already gone */ }
  jobs.delete(id)
  return true
})

// A scratch file, for the one thing a pipe cannot carry: a second input.
// Muxing the original soundtrack back in needs ffmpeg to seek it, so it has to
// be a real file rather than a stream.
ipcMain.handle('pf:tempFile', async (_e, { bytes, ext }) => {
  const dir = path.join(app.getPath('temp'), 'pixelforge')
  await fs.mkdir(dir, { recursive: true })
  const file = path.join(dir, 'src-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7) + '.' + (ext || 'bin'))
  await fs.writeFile(file, Buffer.from(bytes))
  return file
})

// --- automatic project backups ------------------------------------------------
//
// Exporting a PNG throws the editable document away. These are the safety net:
// a real .pfz written beside the app's own data every time the project is saved
// or exported, kept as a ring of the most recent so the folder cannot grow
// without limit. They live on disk rather than in IndexedDB so they survive the
// browser profile being cleared and can be found in a file manager.
const BACKUP_KEEP = 30
const backupDir = () => path.join(app.getPath('userData'), 'backups')

ipcMain.handle('pf:backupDir', () => backupDir())

// Two backups can easily land inside the same second — a save and an export
// moments apart — and a second-resolution name makes the ring prune whichever
// one sorted first rather than the oldest. Milliseconds plus a counter that
// only ever goes up give a total order.
let backupSeq = 0

/** Legal in a filename and still readable. Only the characters Windows and
 *  POSIX actually reject are replaced, so a name with spaces survives the round
 *  trip; `__` is collapsed because it separates the fields. */
const safeName = (name) => String(name || 'Untitled')
  .replace(/[<>:"/\|?*\x00-\x1f]+/g, '-')
  .replace(/__+/g, '-')
  .trim()
  .slice(0, 60) || 'Untitled'

ipcMain.handle('pf:backupWrite', async (_e, { bytes, name, reason }) => {
  const dir = backupDir()
  await fs.mkdir(dir, { recursive: true })
  // Sortable timestamp first, so the ring prunes by filename alone and the
  // folder reads chronologically in any file manager.
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    + '-' + String(backupSeq++ % 1000).padStart(3, '0')
  const safe = safeName(name)
  const file = path.join(dir, `${stamp}__${safe}__${reason || 'save'}.pfz`)
  await fs.writeFile(file, Buffer.from(bytes))

  const all = (await fs.readdir(dir)).filter((f) => f.endsWith('.pfz')).sort()
  for (const old of all.slice(0, Math.max(0, all.length - BACKUP_KEEP))) {
    await fs.unlink(path.join(dir, old)).catch(() => {})
  }
  return file
})

ipcMain.handle('pf:backupList', async () => {
  const dir = backupDir()
  let names = []
  try {
    names = (await fs.readdir(dir)).filter((f) => f.endsWith('.pfz'))
  } catch {
    return []
  }
  const out = []
  for (const f of names) {
    const full = path.join(dir, f)
    try {
      const st = await fs.stat(full)
      // Timestamp first, reason last, name whatever is in between — so a name
      // that itself contains a separator cannot shift the other fields.
      const parts = f.replace(/\.pfz$/, '').split('__')
      const reason = parts.length > 2 ? parts.pop() : 'save'
      parts.shift()
      out.push({
        id: full,
        file: f,
        name: parts.join('__') || 'Untitled',
        reason,
        size: st.size,
        at: st.mtimeMs,
      })
    } catch { /* vanished between readdir and stat */ }
  }
  return out.sort((a, b) => b.at - a.at)
})

ipcMain.handle('pf:backupRead', async (_e, file) => {
  const dir = backupDir()
  // Only ever read out of the backup folder, whatever the renderer asks for.
  const full = path.resolve(file)
  if (path.dirname(full) !== path.resolve(dir)) throw new Error('Not a backup')
  return new Uint8Array(await fs.readFile(full))
})

ipcMain.handle('pf:removeFile', async (_e, target) => {
  try {
    await fs.unlink(target)
    return true
  } catch {
    return false
  }
})

// Which streams a file actually has, so audio is only offered when it exists.
ipcMain.handle('pf:probeStreams', async (_e, file) => {
  if (!ffmpegPath) return { audio: false, video: false }
  const log = await new Promise((res) => {
    const p = spawn(ffmpegPath, ['-hide_banner', '-i', file])
    let out = ''
    p.stderr.on('data', (d) => (out += d))
    p.on('error', () => res(''))
    p.on('close', () => res(out))
  })
  return {
    audio: /Stream #\d+:\d+.*: Audio:/.test(log),
    video: /Stream #\d+:\d+.*: Video:/.test(log),
  }
})

ipcMain.handle('pf:ffmpegRun', async (_e, args) => {
  if (!ffmpegPath) throw new Error('ffmpeg not found — install it on PATH or set PF_FFMPEG')
  return new Promise((res, rej) => {
    const p = spawn(ffmpegPath, args)
    let err = ''
    p.stderr.on('data', (d) => (err += d))
    p.on('error', rej)
    p.on('close', (code) => (code === 0
      ? res({ ok: true, log: err.slice(-4000) })
      : rej(new Error('ffmpeg exited ' + code + '\n' + err.slice(-2000)))))
  })
})
