import { useEffect, useRef, useState } from 'react'
import { useStore } from '../state/store.js'
import { copyPNGToClipboard } from '../engine/exporters.js'
import { hasCustomChrome, isMac, windowControls } from '../engine/desktop.js'

/**
 * Minimise / maximise / close, drawn by the app because the native frame is
 * gone. The maximise glyph follows the real window state, which can change
 * without the app asking — a double-click on the drag region, or Win+Up.
 */
function WindowButtons() {
  const [max, setMax] = useState(false)
  useEffect(() => {
    let live = true
    windowControls.isMaximized().then((v) => live && setMax(v))
    const off = windowControls.onState(({ maximized }) => setMax(maximized))
    return () => { live = false; off() }
  }, [])

  return (
    <div className="win-controls">
      <button title="Minimise" onClick={() => windowControls.minimize()}>
        <svg viewBox="0 0 10 10" width="10" height="10" aria-hidden="true">
          <path d="M0 5 H10" stroke="currentColor" strokeWidth="1" fill="none" />
        </svg>
      </button>
      <button
        title={max ? 'Restore' : 'Maximise'}
        onClick={() => windowControls.toggleMaximize().then(setMax)}
      >
        <svg viewBox="0 0 10 10" width="10" height="10" aria-hidden="true">
          {max ? (
            <>
              <rect x="0.5" y="2.5" width="6" height="6" fill="none" stroke="currentColor" strokeWidth="1" />
              <path d="M2.5 2.5 V0.5 H8.5 V6.5 H6.5" fill="none" stroke="currentColor" strokeWidth="1" />
            </>
          ) : (
            <rect x="0.5" y="0.5" width="9" height="9" fill="none" stroke="currentColor" strokeWidth="1" />
          )}
        </svg>
      </button>
      <button className="close" title="Close" onClick={() => windowControls.close()}>
        <svg viewBox="0 0 10 10" width="10" height="10" aria-hidden="true">
          <path d="M0 0 L10 10 M10 0 L0 10" stroke="currentColor" strokeWidth="1" fill="none" />
        </svg>
      </button>
    </div>
  )
}

export default function TopBar({ onExport, onOpen }) {
  const mediaRef = useRef(null)
  const addImages = useStore((s) => s.addImages)
  const saveProject = useStore((s) => s.saveProject)
  const projectName = useStore((s) => s.projectName)
  const setProjectName = useStore((s) => s.setProjectName)
  const dirty = useStore((s) => s.dirty)
  const undo = useStore((s) => s.undo)
  const redo = useStore((s) => s.redo)
  const canUndo = useStore((s) => s.past.length > 0)
  const canRedo = useStore((s) => s.future.length > 0)
  const zoom = useStore((s) => s.view.zoom)
  const setView = useStore((s) => s.setView)
  const resetDoc = useStore((s) => s.resetDoc)
  const doc = useStore((s) => s.doc)
  const workspace = useStore((s) => s.workspace)
  const setWorkspace = useStore((s) => s.setWorkspace)
  const mediaCount = useStore((s) => s.doc.media.length)

  const confirmDiscard = () =>
    !dirty || confirm('You have unsaved changes. Discard them?')

  return (
    <header className={'topbar' + (isMac() ? ' mac' : '')}>
      <div className="brand">
        <span className="mark" />
        <span className="name">PixelForge</span>
      </div>

      <div className="ws-tabs">
        <button
          className={workspace === 'editor' ? 'on' : ''}
          onClick={() => setWorkspace('editor')}
          title="The canvas, layers and timeline"
        >Editor</button>
        <button
          className={workspace === 'media' ? 'on' : ''}
          onClick={() => setWorkspace('media')}
          title="Everything you have imported (M)"
        >Media{mediaCount > 0 && <span className="dim"> {mediaCount}</span>}</button>
      </div>

      <div className="bar-group">
        <button className="btn" onClick={() => mediaRef.current.click()}>Import Media…</button>
        <input
          ref={mediaRef}
          className="pf-media-input"
          type="file"
          accept="image/*,video/mp4,video/quicktime,.mp4,.m4v,.mov"
          multiple
          hidden
          onChange={(e) => { addImages(e.target.files); e.target.value = '' }}
        />

        <button
          className="btn ghost"
          title="Open a saved project (Ctrl+O)"
          onClick={onOpen}
        >Open Existing…</button>

        <button
          className={'btn ghost' + (dirty ? ' attention' : '')}
          title="Save into this browser (Ctrl+S). Use Export to write a file."
          onClick={saveProject}
        >Save{dirty ? ' •' : ''}</button>

        <button className="btn ghost" title="Undo (Ctrl+Z)" disabled={!canUndo} onClick={undo}>↺</button>
        <button className="btn ghost" title="Redo (Ctrl+Shift+Z)" disabled={!canRedo} onClick={redo}>↻</button>
      </div>

      <input
        className="project-name"
        value={projectName}
        title="Project name — used for the saved filename"
        onChange={(e) => setProjectName(e.target.value)}
        onFocus={(e) => e.target.select()}
      />

      <div className="bar-group">
        <button className="btn ghost" onClick={() => setView({ fitRequest: Date.now() })}>Fit</button>
        <button className="btn ghost" onClick={() => setView({ zoom: 1, fitted: false })}>100%</button>
        <span className="zoom-readout">{Math.round(zoom * 100)}%</span>
      </div>

      <div className="spacer" />

      <div className="doc-readout">{doc.width} × {doc.height}</div>

      <div className="bar-group">
        <button
          className="btn ghost"
          title="Copy current frame as PNG"
          onClick={() => copyPNGToClipboard(doc, useStore.getState().time).catch(() => {})}
        >Copy</button>
        <button
          className="btn ghost"
          onClick={() => { if (confirmDiscard()) resetDoc() }}
        >New</button>
        <button className="btn primary" onClick={onExport}>Export</button>
      </div>

      {hasCustomChrome() && <WindowButtons />}
    </header>
  )
}
