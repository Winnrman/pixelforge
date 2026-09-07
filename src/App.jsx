import { useEffect, useRef, useState } from 'react'
import { useStore } from './state/store.js'
import { uiFlags } from './state/uiFlags.js'
import {
  autosaveAvailable, readSnapshot, restoreSnapshot, saveSnapshot, clearSnapshot,
} from './engine/autosave.js'
import { isDesktop, windowControls } from './engine/desktop.js'
import TopBar from './components/TopBar.jsx'
import ToolRail from './components/ToolRail.jsx'
import CanvasStage from './components/CanvasStage.jsx'
import LayersPanel from './components/LayersPanel.jsx'
import Inspector from './components/Inspector.jsx'
import Timeline from './components/Timeline.jsx'
import ExportDialog from './components/ExportDialog.jsx'
import LassoBar from './components/LassoBar.jsx'
import MediaView from './components/MediaView.jsx'
import LayerContextMenu from './components/LayerContextMenu.jsx'
import OpenDialog from './components/OpenDialog.jsx'

const TOOL_KEYS = {
  v: 'move', c: 'crop', p: 'effect', l: 'lasso', s: 'shape', t: 'text', h: 'hand', e: 'erase',
}

export default function App() {
  const workspace = useStore((st) => st.workspace)
  const tool = useStore((st) => st.tool)
  const [dragOver, setDragOver] = useState(false)
  const [exporting, setExporting] = useState(false)
  const [opening, setOpening] = useState(false)
  // Layers rarely needs the height it was given; let it be dragged and remember.
  const [layersH, setLayersH] = useState(() => {
    const saved = Number(localStorage.getItem('pf-layers-h'))
    return Number.isFinite(saved) && saved > 72 ? saved : 220
  })
  const layersHRef = useRef(layersH)
  layersHRef.current = layersH
  const sideRef = useRef(null)
  const [recovery, setRecovery] = useState(null)
  const autosaveTimer = useRef(null)
  const addImages = useStore((s) => s.addImages)
  const busy = useStore((s) => s.busy)
  const notice = useStore((s) => s.notice)
  const setNotice = useStore((s) => s.setNotice)
  const layerCount = useStore((s) => s.doc.layers.length)

  // ---- crash recovery ----------------------------------------------------
  // Offer the previous session rather than restoring silently: reopening to
  // someone else's half-finished document would be worse than an empty canvas.
  useEffect(() => {
    if (!autosaveAvailable()) return
    let cancelled = false
    readSnapshot().then((snap) => {
      if (cancelled || !snap) return
      if (useStore.getState().doc.layers.length) return
      setRecovery(snap)
    })
    return () => { cancelled = true }
  }, [])

  // Debounced autosave of whatever is on the canvas.
  useEffect(() => {
    if (!autosaveAvailable()) return
    const unsub = useStore.subscribe((state, prev) => {
      if (state.doc === prev.doc) return
      clearTimeout(autosaveTimer.current)
      autosaveTimer.current = setTimeout(() => {
        const s = useStore.getState()
        // Media counts as work. Skipping the save when the canvas is empty meant
        // a bin full of imports was never written at all, and deleting the last
        // layer left the newest state unrecorded — so a reload came back to an
        // older snapshot instead of what was on screen.
        if (!s.doc.layers.length && !s.doc.media.length) return
        saveSnapshot(s.doc, s.time).catch((err) =>
          console.warn('[pixelforge] autosave failed', err))
      }, 1200)
    })
    return () => { unsub(); clearTimeout(autosaveTimer.current) }
  }, [])

  // ---- global drag & drop -----------------------------------------------
  useEffect(() => {
    // Only a drag carrying files is an import. Reordering a layer is an HTML5
    // drag too, and it used to raise the "drop to add" veil over the whole app —
    // then leave it there, because dragleave only fired with a null
    // relatedTarget, which an in-app drag never produces.
    const carriesFiles = (e) => {
      const t = e.dataTransfer?.types
      return t ? Array.from(t).includes('Files') : false
    }
    const over = (e) => {
      if (!carriesFiles(e)) return
      e.preventDefault()
      setDragOver(true)
    }
    const leave = (e) => { if (e.relatedTarget === null) setDragOver(false) }
    const drop = (e) => {
      setDragOver(false)
      if (!carriesFiles(e)) return
      e.preventDefault()
      const files = e.dataTransfer?.files
      if (files?.length) addImages(files)
    }
    // A belt-and-braces clear: whatever the drag was, it is over now.
    const end = () => setDragOver(false)
    window.addEventListener('dragover', over)
    window.addEventListener('dragleave', leave)
    window.addEventListener('drop', drop)
    window.addEventListener('dragend', end)
    return () => {
      window.removeEventListener('dragover', over)
      window.removeEventListener('dragleave', leave)
      window.removeEventListener('drop', drop)
      window.removeEventListener('dragend', end)
    }
  }, [addImages])

  useEffect(() => {
    // On the desktop the unsaved-changes guard lives in the main process, which
    // can show a real dialog. A `beforeunload` here would cancel the window
    // close and display nothing at all, which is how the X button ended up
    // doing nothing once anything had been edited.
    if (isDesktop()) {
      const sync = (d) => windowControls?.setDirty(d)
      sync(useStore.getState().dirty)
      return useStore.subscribe((st, prev) => {
        if (st.dirty !== prev.dirty) sync(st.dirty)
      })
    }
    const onBeforeUnload = (e) => {
      if (!useStore.getState().dirty) return
      e.preventDefault()
      e.returnValue = ''
    }
    window.addEventListener('beforeunload', onBeforeUnload)
    return () => window.removeEventListener('beforeunload', onBeforeUnload)
  }, [])

  // ---- paste from clipboard ---------------------------------------------
  useEffect(() => {
    const onPaste = (e) => {
      const t = e.target
      if (t instanceof HTMLElement &&
        (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return
      const files = [...(e.clipboardData?.items || [])]
        .filter((i) => i.kind === 'file')
        .map((i) => i.getAsFile())
        .filter(Boolean)
      if (files.length) {
        e.preventDefault()
        addImages(files)
        return
      }
      // Nothing pasteable from the system: fall back to layers copied in-app.
      const s = useStore.getState()
      if (s.clipboard.length) {
        e.preventDefault()
        const n = s.pasteLayers()
        s.setNotice({ kind: 'ok', text: `Pasted ${n} layer${n === 1 ? '' : 's'}` })
      }
    }
    window.addEventListener('paste', onPaste)
    return () => window.removeEventListener('paste', onPaste)
  }, [addImages])

  useEffect(() => {
    if (!notice) return
    const t = setTimeout(() => setNotice(null), 5000)
    return () => clearTimeout(t)
  }, [notice, setNotice])

  // ---- keyboard ----------------------------------------------------------
  useEffect(() => {
    const onKey = (e) => {
      const t = e.target
      const typing = t instanceof HTMLElement &&
        (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)
      const s = useStore.getState()
      const mod = e.ctrlKey || e.metaKey

      if (mod && e.key.toLowerCase() === 'z') {
        e.preventDefault()
        e.shiftKey ? s.redo() : s.undo()
        return
      }
      if (mod && e.key.toLowerCase() === 'y') { e.preventDefault(); s.redo(); return }
      if (mod && e.key.toLowerCase() === 's') { e.preventDefault(); s.saveProject(); return }
      // Cut every clip the playhead is inside. Ctrl+K because a bare S is already
      // the shape tool, and because it is the key every other editor uses.
      if (mod && e.key.toLowerCase() === 'k' && !typing) {
        e.preventDefault()
        s.splitClips()
        return
      }
      if (mod && e.key.toLowerCase() === 'o') {
        e.preventDefault()
        setOpening(true)
        return
      }
      if (mod && e.key.toLowerCase() === 'c' && !typing) {
        if (s.selectedIds.length) {
          e.preventDefault()
          const n = s.copyLayers(s.selectedIds)
          s.setNotice({ kind: 'ok', text: `Copied ${n} layer${n === 1 ? '' : 's'}` })
        }
        return
      }
      if (mod && e.key.toLowerCase() === 'x' && !typing) {
        if (s.selectedIds.length) {
          e.preventDefault()
          const n = s.cutLayers(s.selectedIds)
          s.setNotice({ kind: 'ok', text: `Cut ${n} layer${n === 1 ? '' : 's'}` })
        }
        return
      }
      if (mod && e.key.toLowerCase() === 'g') {
        e.preventDefault()
        if (e.shiftKey) s.ungroupLayers(s.selectedIds)
        else if (s.selectedIds.length) s.groupLayers(s.selectedIds)
        return
      }
      if (mod && e.key.toLowerCase() === 'd') {
        e.preventDefault()
        if (s.selectedIds.length) s.duplicateLayers(s.selectedIds)
        return
      }
      if (mod && e.key.toLowerCase() === 'a') {
        if (typing) return
        e.preventDefault()
        s.select(s.doc.layers.filter((l) => !l.locked).map((l) => l.id))
        return
      }
      if (typing) return

      if (e.key === 'Delete' || e.key === 'Backspace') {
        if (s.selectedIds.length) { e.preventDefault(); s.removeLayers(s.selectedIds) }
        return
      }
      if (e.key === 'Escape') { s.select([]); return }
      if (e.code === 'Space') { e.preventDefault(); return }
      if (e.key === ' ') return

      if (e.key === '[' && s.selectedIds.length === 1) { s.reorderLayer(s.selectedIds[0], -1); return }
      if (e.key === ']' && s.selectedIds.length === 1) { s.reorderLayer(s.selectedIds[0], 1); return }

      if (e.key.startsWith('Arrow') && s.selectedIds.length) {
        e.preventDefault()
        const step = e.shiftKey ? 10 : 1
        const dx = e.key === 'ArrowLeft' ? -step : e.key === 'ArrowRight' ? step : 0
        const dy = e.key === 'ArrowUp' ? -step : e.key === 'ArrowDown' ? step : 0
        s.pushHistory()
        for (const id of s.selectedIds) {
          const l = s.doc.layers.find((x) => x.id === id)
          if (l) s.updateLayer(id, { x: l.x + dx, y: l.y + dy })
        }
        return
      }

      // M toggles the bin. Placed before the tool keys so it cannot be shadowed
      // by one later.
      if (e.key.toLowerCase() === 'm' && !e.ctrlKey && !e.metaKey && !e.altKey) {
        e.preventDefault()
        s.setWorkspace(s.workspace === 'media' ? 'editor' : 'media')
        return
      }

      const tool = TOOL_KEYS[e.key.toLowerCase()]
      if (tool) s.setTool(tool)
    }

    const onKeyUp = (e) => {
      const t = e.target
      const typing = t instanceof HTMLElement &&
        (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)
      if (typing) return
      if (e.code === 'Space') {
        // A space-drag pan already used this key press.
        if (uiFlags.panned) { uiFlags.panned = false; return }
        const s = useStore.getState()
        s.setPlaying(!s.playing)
      }
    }

    window.addEventListener('keydown', onKey)
    window.addEventListener('keyup', onKeyUp)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('keyup', onKeyUp)
    }
  }, [])

  return (
    <div className={'app' + (dragOver ? ' dragging' : '')}>
      <TopBar onExport={() => setExporting(true)} onOpen={() => setOpening(true)} />

      {workspace === 'media' && <MediaView />}

      <div className="workspace" hidden={workspace !== 'editor'}>
        <ToolRail />
        <div className="center">
          <CanvasStage />
          <LassoBar />
          <Timeline />
          {!layerCount && (
            <div
              // Only the move tool lets the hero catch clicks. With a drawing
              // tool selected the canvas has to stay reachable — adding text or
              // a shape to an empty document is a real thing to want.
              className={'hero' + (tool === 'move' ? ' clickable' : '')}
              role="button"
              tabIndex={0}
              title="Click to choose files"
              onClick={() => document.querySelector('.pf-media-input')?.click()}
              onKeyDown={(e) => {
                if (e.key === 'Enter') document.querySelector('.pf-media-input')?.click()
              }}
            >
              <div className="hero-card">
                <div className="hero-icon">
                  <svg viewBox="0 0 64 64" width="56" height="56">
                    <rect x="4" y="10" width="56" height="44" rx="5" fill="none"
                      stroke="currentColor" strokeWidth="2.5" />
                    <path d="M4 42 L20 28 L32 38 L44 24 L60 40" fill="none"
                      stroke="currentColor" strokeWidth="2.5" strokeLinejoin="round" />
                    <circle cx="22" cy="21" r="4" fill="currentColor" />
                  </svg>
                </div>
                <h1>Drop an image, GIF or video to start</h1>
                <p>
                  GIFs and MP4s are decoded frame by frame, so pixelate and blur overlays
                  track the motion underneath them.
                </p>
                <p>
                  Work is autosaved {isDesktop() ? 'on this machine' : 'in this browser'}, so
                  closing the app does not lose it. <b>Export → Project</b> writes a .pfz
                  holding every layer, keyframe and your original media, to reopen anywhere.
                </p>
                {/* Each hint is one unbreakable unit — otherwise the label wraps away
                    from the key it belongs to, and "Space" ends a line with "play/pause"
                    orphaned onto the next. */}
                <p className="media-cue">Click anywhere to choose files</p>
                <p className="keys">
                  <span><kbd>V</kbd> move</span>
                  <span><kbd>P</kbd> pixel overlay</span>
                  <span><kbd>L</kbd> lasso</span>
                  <span><kbd>C</kbd> crop</span>
                  <span><kbd>T</kbd> text</span>
                  <span><kbd>Space</kbd> play/pause</span>
                </p>
              </div>
            </div>
          )}
        </div>
        <aside className="side" ref={sideRef}>
          <div className="side-top" style={{ height: layersH }}>
            <LayersPanel />
          </div>
          <div
            className="side-split"
            title="Drag to resize"
            onPointerDown={(e) => {
              e.currentTarget.setPointerCapture(e.pointerId)
              const box = sideRef.current.getBoundingClientRect()
              const move = (ev) => {
                const next = Math.max(72, Math.min(box.height - 150, ev.clientY - box.top))
                setLayersH(next)
              }
              const up = () => {
                window.removeEventListener('pointermove', move)
                window.removeEventListener('pointerup', up)
                try { localStorage.setItem('pf-layers-h', String(layersHRef.current)) } catch {}
              }
              window.addEventListener('pointermove', move)
              window.addEventListener('pointerup', up)
            }}
          />
          <Inspector />
        </aside>
      </div>

      {recovery && (
        <div className="recovery">
          <span>
            Recovered an unsaved session from{' '}
            {new Date(recovery.savedAt).toLocaleString()} ·{' '}
            {recovery.doc.layers.length} layer{recovery.doc.layers.length === 1 ? '' : 's'}
          </span>
          <span className="recovery-actions">
            <button
              className="btn primary"
              onClick={async () => {
                const snap = recovery
                setRecovery(null)
                const { doc, time } = await restoreSnapshot(snap)
                useStore.getState().loadDocument(doc, time, 'Recovered session')
              }}
            >Restore</button>
            <button
              className="btn ghost"
              onClick={() => { setRecovery(null); clearSnapshot() }}
            >Discard</button>
          </span>
        </div>
      )}

      {notice && (
        <div className={'notice ' + (notice.kind || 'ok')} onClick={() => setNotice(null)}>
          {notice.text}
        </div>
      )}

      {busy && <div className="busy">{busy}</div>}
      {dragOver && <div className="drop-veil"><span>Drop to add layers</span></div>}
      <LayerContextMenu />
      {exporting && <ExportDialog onClose={() => setExporting(false)} />}
      {opening && <OpenDialog onClose={() => setOpening(false)} />}
    </div>
  )
}
