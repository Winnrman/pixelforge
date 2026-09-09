import { useEffect, useRef, useState } from 'react'
import { useStore } from './state/store.js'
import { uiFlags } from './state/uiFlags.js'
import {
  autosaveAvailable, readSnapshot, restoreSnapshot, saveSnapshot, clearSnapshot,
} from './engine/autosave.js'
import { isDesktop, windowControls, onOpenPath, readPath } from './engine/desktop.js'
import TopBar from './components/TopBar.jsx'
import ToolRail from './components/ToolRail.jsx'
import CanvasStage from './components/CanvasStage.jsx'
import LayersPanel from './components/LayersPanel.jsx'
import Inspector from './components/Inspector.jsx'
import Timeline from './components/Timeline.jsx'
import { Info } from './components/ui.jsx'
import ExportDialog from './components/ExportDialog.jsx'
import LassoBar from './components/LassoBar.jsx'
import MediaPool from './components/MediaPool.jsx'
import MediaView from './components/MediaView.jsx'
import LayerContextMenu from './components/LayerContextMenu.jsx'
import OpenDialog from './components/OpenDialog.jsx'
import { toolForKey } from './engine/tools.js'

/**
 * The picture the palette is read from: the biggest image on the canvas, else
 * the first thing in the bin. Returned as an id rather than a layer so this can
 * run on every store change and only wake the effect when the picture itself
 * changes.
 */
function paletteSource(s) {
  const images = s.doc.layers
    .filter((l) => l.type === 'image' && l.visible !== false && l.assetId)
    .sort((a, b) => Math.abs(b.w * b.h) - Math.abs(a.w * a.h))
  return images[0]?.assetId || s.doc.media?.[0] || null
}

export default function App() {
  const workspace = useStore((st) => st.workspace)
  const paletteKey = useStore(paletteSource)
  const refreshPalette = useStore((st) => st.refreshPalette)
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
  const setWorkspace = useStore((s) => s.setWorkspace)
  const busy = useStore((s) => s.busy)
  const notice = useStore((s) => s.notice)
  const setNotice = useStore((s) => s.setNotice)
  const layerCount = useStore((s) => s.doc.layers.length)

  // ---- crash recovery ----------------------------------------------------
  // Offer the previous session rather than restoring silently: reopening to
  // someone else's half-finished document would be worse than an empty canvas.
  // The colours under every colour control, read back off the artwork. Keyed on
  // which picture it is rather than on the document, so moving a layer around
  // does not re-count a million pixels.
  useEffect(() => { refreshPalette() }, [paletteKey, refreshPalette])

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
    // Media is added in the Media tab and nowhere else. The editor used to take
    // a drop too, but importing has always put files in the bin and switched you
    // there — so the editor's version was a longer route to the same place while
    // looking like a shortcut.
    const inBin = () => useStore.getState().workspace === 'media'
    const over = (e) => {
      if (!carriesFiles(e) || !inBin()) return
      e.preventDefault()
      setDragOver(true)
    }
    const leave = (e) => { if (e.relatedTarget === null) setDragOver(false) }
    const drop = (e) => {
      setDragOver(false)
      if (!carriesFiles(e) || !inBin()) return
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
      const s = useStore.getState()

      // Two clipboards, and the rule is whatever was copied last.
      //
      // A file on the system clipboard is only newer than the layers copied in
      // here if the in-app copy took the system clipboard over and something
      // has replaced it since — which is exactly what `clipboardOwned` records.
      // Without that test a screenshot from an hour ago beat a layer copied a
      // second ago and went on beating it, so Ctrl+C then Ctrl+V quietly added
      // the old picture to Media instead of duplicating the layer.
      if (files.length && (!s.clipboard.length || s.clipboardOwned)) {
        e.preventDefault()
        addImages(files)
        return
      }
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

  // A project double-clicked in the file manager. The path arrives from the
  // shell; opening it is the same code path as Open Existing, so a file opened
  // this way is in no way a special case once it is loaded.
  useEffect(() => {
    // The unsubscribe is wrapped rather than returned straight out: off the
    // desktop there is no bridge and `onOpenPath` answers null, and an effect
    // that returns a non-function has that value called as its cleanup — which
    // takes the whole app down with "destroy is not a function".
    const off = onOpenPath(async (path) => {
      const st = useStore.getState()
      if (st.dirty && !confirm('You have unsaved changes. Discard them and open this project?')) {
        return
      }
      try {
        // `openProject` manages its own busy state and clears it in a finally.
        await st.openProject(await readPath(path))
      } catch (err) {
        console.error('[pixelforge] could not open', path, err)
        useStore.getState().setNotice({
          kind: 'warn', text: 'Could not open that project: ' + err.message,
        })
      }
    })
    return () => off?.()
  }, [])

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
        // A run of outline points picked out has first claim on Delete: it is
        // the smaller, nearer thing, and losing the whole layer instead of a
        // stretch of a mask is not a mistake anyone would forgive.
        if (s.tool === 'lasso' && s.lassoPick?.length) return
        if (!s.selectedIds.length) return
        e.preventDefault()
        // Shift closes the hole behind it. Plain delete leaves the gap, because
        // sometimes the gap is the point — a beat of black, or room for
        // something going in later.
        if (e.shiftKey) {
          const r = s.rippleDelete(s.selectedIds)
          s.setNotice(r.ok ? { kind: 'ok', text: r.text } : { kind: 'warn', text: r.reason })
        } else {
          s.removeLayers(s.selectedIds)
        }
        return
      }
      if (e.key === 'Escape') {
        // Out of the group first, then out of the selection: one step back per
        // press, which is what Escape means everywhere else.
        if (s.enteredGroup) { s.enterGroup(null); s.select([s.enteredGroup]); return }
        s.select([])
        return
      }
      if (e.code === 'Space') { e.preventDefault(); return }
      if (e.key === ' ') return

      if (e.key === '[' && s.selectedIds.length === 1) { s.reorderLayer(s.selectedIds[0], -1); return }
      if (e.key === ']' && s.selectedIds.length === 1) { s.reorderLayer(s.selectedIds[0], 1); return }

      // Marking a range, and stepping through it. I and O are what every editor
      // uses and what the fingers already know; the eyedropper keeps I as well,
      // because it only answers while its own tool is up and these only answer
      // when it is not.
      if (!typing && !mod && (e.key === 'i' || e.key === 'I') && s.tool !== 'eyedrop') {
        e.preventDefault()
        s.setMark('in', s.time)
        return
      }
      if (!typing && !mod && (e.key === 'o' || e.key === 'O')) {
        e.preventDefault()
        s.setMark('out', s.time)
        return
      }
      if (!typing && !mod && (e.key === 'f' || e.key === 'F')) {
        e.preventDefault()
        const el = document.querySelector('.stage')
        if (document.fullscreenElement) document.exitFullscreen()
        else el?.requestFullscreen?.().catch(() => {})
        return
      }

      // Moving through the video, the way a video player does it.
      //
      // Arrows skip, comma and full stop step a frame — which is what YouTube
      // does and therefore what the fingers already expect. A frame at a time is
      // for landing a cut; getting to roughly the right place first is a
      // different job and much more common, and doing it a thirtieth of a second
      // at a time is not doing it.
      //
      // Five seconds, or a tenth of the timeline when that is less: five seconds
      // through a two-second GIF is not a skip, it is the end of it.
      const seek = (ms) => {
        s.setPlaying(false)
        s.setTime(Math.max(0, Math.min(s.duration, s.time + ms)))
      }
      const frameMs = 1000 / (s.doc.fps || 30)
      if (!typing && !mod && s.duration > 0 && (e.key === ',' || e.key === '.')) {
        e.preventDefault()
        seek(e.key === ',' ? -frameMs : frameMs)
        return
      }
      if (!typing && !mod && s.duration > 0 && (e.key === 'Home' || e.key === 'End')) {
        e.preventDefault()
        s.setPlaying(false)
        s.setTime(e.key === 'Home' ? 0 : s.duration)
        return
      }
      if (!typing && e.key.startsWith('Arrow') && !s.selectedIds.length && s.duration > 0) {
        const dir = e.key === 'ArrowLeft' ? -1 : e.key === 'ArrowRight' ? 1 : 0
        if (dir) {
          e.preventDefault()
          // Shift is the fine one, for when you are nearly there.
          const skip = Math.min(5000, Math.max(frameMs, s.duration / 10))
          seek(dir * (e.shiftKey ? frameMs : skip))
        }
        return
      }

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

      // Both keys arm a tool: the letter every editor uses, and the digit for
      // its place in the rail. `1` is the selector, which is the one everybody
      // wants a way back to.
      const tool = toolForKey(e.key)
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

      {/* The editor is one room: the bin to hand on the left, the picture beside
          it, the tracks along the bottom under both, the inspector on the right.
          It used to be a canvas with a timeline tucked under it and the media
          behind a tab, which is an image editor with a video editor bolted on
          rather than one tool. */}
      <div className="workspace" hidden={workspace !== 'editor'}>
        <ToolRail />
        <MediaPool />
        <div className="center">
          <CanvasStage />
          <LassoBar />
          {!layerCount && (
            <div
              // Only the move tool lets the hero catch clicks. With a drawing
              // tool selected the canvas has to stay reachable — adding text or
              // a shape to an empty document is a real thing to want.
              className={'hero' + (tool === 'move' ? ' clickable' : '')}
              role="button"
              tabIndex={0}
              title="Open your media"
              onClick={() => setWorkspace('media')}
              onKeyDown={(e) => { if (e.key === 'Enter') setWorkspace('media') }}
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
                <h1>
                  Nothing on the canvas yet
                  <Info>
                    GIFs and MP4s are decoded frame by frame, so pixelate and blur overlays
                    track the motion underneath them.
                  </Info>
                </h1>

                <p>
                  Work is autosaved {isDesktop() ? 'on this machine' : 'in this browser'}.
                  <Info>
                    So closing the app does not lose it. Export → Project writes a .pfz
                    holding every layer, keyframe and your original media, to reopen
                    anywhere.
                  </Info>
                </p>
                {/* Each hint is one unbreakable unit — otherwise the label wraps away
                    from the key it belongs to, and "Space" ends a line with "play/pause"
                    orphaned onto the next. */}
                <p className="media-cue">
                  Images, GIFs and video live in <b>Media</b>. Click here or press
                  <kbd>M</kbd> to open it, then send what you want to the canvas.
                </p>
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

        {/* Under all three, not tucked inside the canvas column: the tracks are
            where the editing happens, so they get the width of the window. */}
        <Timeline />
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
      {dragOver && <div className="drop-veil"><span>Drop to add to your media</span></div>}
      <LayerContextMenu />
      {exporting && <ExportDialog onClose={() => setExporting(false)} />}
      {opening && <OpenDialog onClose={() => setOpening(false)} />}
    </div>
  )
}
