// Capability layer between the editor and the Electron shell.
//
// Every function here works in a plain browser too, just less well: saving
// falls back to a download, opening falls back to a file input, batch export
// falls back to a zip. Nothing in the app branches on "are we in Electron" —
// it calls these and gets the best available behaviour.
const bridge = typeof window !== 'undefined' ? window.pixelforge : null

export const isDesktop = () => !!bridge?.desktop

/**
 * True where the app supplies its own minimise/maximise/close.
 *
 * macOS keeps its traffic lights — replacing them looks wrong and breaks muscle
 * memory — so only the other platforms get custom buttons, though every
 * platform gets the draggable title bar.
 */
export const hasCustomChrome = () => !!bridge?.desktop && bridge.platform !== 'darwin'
export const isMac = () => bridge?.platform === 'darwin'

export const windowControls = bridge?.win || null
export const desktopInfo = () => (bridge ? { platform: bridge.platform, ...bridge.versions } : null)

/** The real path behind a dropped File, when there is one. */
export function pathOf(file) {
  return bridge ? bridge.pathForFile(file) : null
}

/** Opens a file picker and returns real Files. Browser callers use an <input>. */
export async function openFiles({ multi = true, filters } = {}) {
  if (!bridge) return null // caller falls back to its own <input type=file>
  const paths = await bridge.pickFiles({ multi, filters })
  return Promise.all(paths.map(readPath))
}

/** Reads a path into a File, so the existing import path is unchanged. */
export async function readPath(p) {
  const { name, bytes } = await bridge.readFile(p)
  const file = new File([bytes], name)
  // Kept so a later "export next to the original" knows where it came from.
  Object.defineProperty(file, 'pfPath', { value: p })
  return file
}

export async function listFolder(dir) {
  return bridge ? bridge.listMedia(dir) : []
}

export async function pickFolder() {
  return bridge ? bridge.pickFolder() : null
}

/**
 * Writes a blob. On the desktop this is a real Save dialog and a real file; in
 * the browser it is a download. Returns the path written, or null in browser.
 */
export async function saveBlob(blob, filename, { dir = null, silent = false } = {}) {
  // `silent` means the caller is collecting the bytes itself (batch export
  // zips them). Without this a thirty-file batch would fire thirty downloads.
  if (silent && !dir) return null
  if (!bridge) {
    downloadBlob(blob, filename)
    return null
  }
  let target = dir ? joinPath(dir, filename) : null
  if (!target && !silent) {
    target = await bridge.savePath({ defaultPath: filename, filters: filtersFor(filename) })
  }
  if (!target) return null
  await bridge.writeFile(target, await blob.arrayBuffer())
  return target
}

/** A Save dialog that returns a path rather than writing — ffmpeg writes it. */
export async function pickSavePath(filename) {
  if (!bridge) return null
  return bridge.savePath({ defaultPath: filename, filters: filtersFor(filename) })
}

export function revealItem(p) {
  if (bridge && p) bridge.showItem(p)
}

const joinPath = (dir, name) => dir.replace(/[\\/]+$/, '') + (dir.includes('\\') ? '\\' : '/') + name

function filtersFor(filename) {
  const ext = (filename.split('.').pop() || '').toLowerCase()
  const names = { gif: 'GIF', png: 'PNG', webm: 'WebM video', mp4: 'MP4 video', pfz: 'PixelForge project', zip: 'ZIP archive' }
  return [{ name: names[ext] || ext.toUpperCase(), extensions: [ext] }]
}

export function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 5000)
}

// --- ffmpeg ------------------------------------------------------------------
// Probed once and cached. `null` means "not asked yet", `{ok:false}` means asked
// and absent — the difference matters so the UI does not re-probe on every open.
let ffmpeg = null

export async function ffmpegStatus() {
  if (!bridge) return { ok: false, reason: 'browser' }
  if (!ffmpeg) ffmpeg = await bridge.ffmpegProbe().catch(() => ({ ok: false }))
  return ffmpeg
}

export async function ffmpegRun(args) {
  const s = await ffmpegStatus()
  if (!s.ok) throw new Error('ffmpeg is not available')
  return bridge.ffmpegRun(args)
}

/**
 * A streaming encode. `write` takes one compressed frame and resolves once
 * ffmpeg has accepted it, so awaiting it paces the render loop to the encoder.
 */
export async function encoder(args, onFrame) {
  const s = await ffmpegStatus()
  if (!s.ok) throw new Error('ffmpeg is not available')
  const { id } = await bridge.encodeStart(args)
  const off = onFrame ? bridge.onEncodeProgress((p) => p.id === id && onFrame(p.frame)) : null
  return {
    id,
    write: (bytes) => bridge.encodeWrite(id, bytes),
    finish: async () => {
      try {
        return await bridge.encodeFinish(id)
      } finally {
        if (off) off()
      }
    },
    abort: async () => {
      if (off) off()
      return bridge.encodeAbort(id)
    },
  }
}

/** Parks bytes on disk so ffmpeg can seek them — used for the audio input. */
export async function tempFile(bytes, ext) {
  if (!bridge) throw new Error('no filesystem in the browser')
  return bridge.tempFile(bytes, ext)
}

export const removeFile = (p) => (bridge && p ? bridge.removeFile(p) : Promise.resolve(false))
export const probeStreams = (p) => (bridge ? bridge.probeStreams(p) : Promise.resolve({ audio: false, video: false }))
