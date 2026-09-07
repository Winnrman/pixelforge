import React from 'react'
import { createRoot } from 'react-dom/client'
import App from './App.jsx'
import './styles.css'
import * as storeApi from './state/store.js'
import { useStore } from './state/store.js'
import * as renderApi from './engine/render.js'
import * as assetApi from './engine/assets.js'
import * as keyApi from './engine/keyframes.js'
import * as trackerApi from './engine/tracker.js'
import * as matteApi from './engine/matte.js'
import * as aiApi from './engine/aiMatte.js'
import * as videoApi from './engine/video.js'
import * as retroApi from './engine/retro.js'
import * as batchApi from './engine/batch.js'
import * as loopApi from './engine/loop.js'
import * as exportApi from './engine/exporters.js'
import * as desktopApi from './engine/desktop.js'
import * as filmApi from './engine/filmstrip.js'
import * as projectApi from './engine/project.js'
import * as fontApi from './engine/fonts.js'
import * as shapeApi from './engine/shapes.js'
import * as cursorApi from './engine/cursor.js'
import * as subjectApi from './engine/subject.js'
import * as backupApi from './engine/backup.js'
import * as dpiApi from './engine/dpi.js'
import * as audioApi from './engine/audio.js'
import * as waveApi from './engine/waveform.js'
import * as edgeApi from './engine/edges.js'
import * as clipApi from './engine/clips.js'

// Dev-only handles so the browser smoke test (e2e.mjs) can inspect state and
// re-render the document off-screen.
if (import.meta.env.DEV) {
  window.__pfState = useStore.getState
  window.__pfRender = renderApi
  window.__pfAssets = assetApi
  window.__pfKeys = keyApi
  window.__pfStore = storeApi
  window.__pfTracker = trackerApi
  window.__pfMatte = matteApi
  window.__pfAi = aiApi
  window.__pfVideo = videoApi
  window.__pfRetro = retroApi
  window.__pfBatch = batchApi
  window.__pfLoop = loopApi
  window.__pfExport = exportApi
  window.__pfDesktop = desktopApi
  window.__pfFilmstrip = filmApi
  window.__pfProject = projectApi
  window.__pfFonts = fontApi
  window.__pfShapes = shapeApi
  window.__pfCursor = cursorApi
  window.__pfSubject = subjectApi
  window.__pfBackup = backupApi
  window.__pfDpi = dpiApi
  window.__pfAudio = audioApi
  window.__pfWave = waveApi
  window.__pfEdges = edgeApi
  window.__pfClips = clipApi
}

createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)
