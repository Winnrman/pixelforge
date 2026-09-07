// The only surface the renderer sees. Node stays out of the page entirely —
// everything crosses as structured-cloneable data through these calls, so a
// bug in the editor cannot reach the filesystem by accident.
const { contextBridge, ipcRenderer, webUtils } = require('electron')

const call = (ch, arg) => ipcRenderer.invoke(ch, arg)

contextBridge.exposeInMainWorld('pixelforge', {
  desktop: true,
  platform: process.platform,
  versions: { electron: process.versions.electron, chrome: process.versions.chrome },

  // Window controls, because the frame is gone and the app draws its own.
  win: {
    minimize: () => call('pf:winMinimize'),
    toggleMaximize: () => call('pf:winMaximize'),
    close: () => call('pf:winClose'),
    setDirty: (value) => call('pf:winDirty', value),
    isMaximized: () => call('pf:winIsMaximized'),
    onState: (fn) => {
      const h = (_e, state) => fn(state)
      ipcRenderer.on('pf:winState', h)
      return () => ipcRenderer.removeListener('pf:winState', h)
    },
  },

  pickFiles: (opts) => call('pf:pickFiles', opts),
  pickFolder: () => call('pf:pickFolder'),
  savePath: (opts) => call('pf:savePath', opts),

  readFile: (p) => call('pf:readFile', p),
  writeFile: (p, bytes) => call('pf:writeFile', { path: p, bytes }),
  listMedia: (dir) => call('pf:listMedia', dir),
  showItem: (p) => call('pf:showItem', p),

  // A dropped File carries no path in a sandboxed renderer; webUtils is the
  // supported way to recover one, and it is what makes "drop a folder of
  // photos and batch them" work without a second dialog.
  pathForFile: (file) => {
    try {
      return webUtils.getPathForFile(file)
    } catch {
      return null
    }
  },

  ffmpegProbe: () => call('pf:ffmpegProbe'),
  ffmpegRun: (args) => call('pf:ffmpegRun', args),

  // Streaming encode. The renderer pushes one compressed frame at a time and
  // awaits each write, so ffmpeg's backpressure reaches all the way back to the
  // render loop instead of memory growing until something gives.
  encodeStart: (args) => call('pf:encodeStart', args),
  encodeWrite: (id, bytes) => call('pf:encodeWrite', { id, bytes }),
  encodeFinish: (id) => call('pf:encodeFinish', id),
  encodeAbort: (id) => call('pf:encodeAbort', id),
  onEncodeProgress: (fn) => {
    const h = (_e, payload) => fn(payload)
    ipcRenderer.on('pf:encodeProgress', h)
    return () => ipcRenderer.removeListener('pf:encodeProgress', h)
  },

  tempFile: (bytes, ext) => call('pf:tempFile', { bytes, ext }),
  removeFile: (p) => call('pf:removeFile', p),
  backup: {
    dir: () => call('pf:backupDir'),
    write: (bytes, name, reason) => call('pf:backupWrite', { bytes, name, reason }),
    list: () => call('pf:backupList'),
    read: (file) => call('pf:backupRead', file),
  },
  probeStreams: (p) => call('pf:probeStreams', p),
})
