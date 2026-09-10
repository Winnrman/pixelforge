import { useRef } from 'react'
import { useStore } from '../state/store.js'

/**
 * Where you are, when you cannot see the whole picture.
 *
 * Zoomed in past the frame there is nothing on screen that says which part of
 * the document you are looking at — the canvas fills the view and every corner
 * looks like the middle. This is the frame, small, with the visible part marked
 * on it.
 *
 * It appears only when it has something to say. Zoomed out far enough to see
 * everything, the mark would be the whole rectangle and the panel would be a
 * picture of nothing.
 */
export default function Minimap() {
  const view = useStore((s) => s.view)
  const stage = useStore((s) => s.stage)
  const docW = useStore((s) => s.doc.width)
  const docH = useStore((s) => s.doc.height)
  const setView = useStore((s) => s.setView)
  const ref = useRef(null)
  const drag = useRef(false)

  const zoom = view.zoom || 1
  // What is on screen, in document coordinates.
  const seen = { w: (stage.w || 0) / zoom, h: (stage.h || 0) / zoom }
  const hiddenX = seen.w < docW - 1
  const hiddenY = seen.h < docH - 1
  if (!stage.w || !docW || !docH || (!hiddenX && !hiddenY)) return null

  // The document, fitted into the widget.
  const box = { w: 176, h: 108 }
  const k = Math.min(box.w / docW, box.h / docH)
  const mw = docW * k
  const mh = docH * k

  const left = -view.panX / zoom
  const top = -view.panY / zoom
  // Clipped to the document: the part of the *picture* you can see is what this
  // is about, and a mark hanging off the edge would be describing the desk.
  const vx = Math.max(0, left)
  const vy = Math.max(0, top)
  const vw = Math.min(docW, left + seen.w) - vx
  const vh = Math.min(docH, top + seen.h) - vy

  /** Centres the view on the document point under the pointer. */
  const goTo = (e) => {
    const r = ref.current?.getBoundingClientRect()
    if (!r) return
    const dx = ((e.clientX - r.left) - (r.width - mw) / 2) / k
    const dy = ((e.clientY - r.top) - (r.height - mh) / 2) / k
    setView({
      panX: stage.w / 2 - dx * zoom,
      panY: stage.h / 2 - dy * zoom,
      fitted: false,
    })
  }

  return (
    <div className="minimap" title="Where you are in the picture — click to go somewhere else">
      <div
        className="minimap-frame"
        ref={ref}
        onPointerDown={(e) => {
          drag.current = true
          e.currentTarget.setPointerCapture(e.pointerId)
          goTo(e)
        }}
        onPointerMove={(e) => { if (drag.current) goTo(e) }}
        onPointerUp={(e) => {
          drag.current = false
          try { e.currentTarget.releasePointerCapture(e.pointerId) } catch { /* gone already */ }
        }}
      >
        <div className="minimap-doc" style={{ width: mw, height: mh }}>
          <div
            className="minimap-view"
            style={{
              left: `${(vx / docW) * 100}%`,
              top: `${(vy / docH) * 100}%`,
              width: `${(vw / docW) * 100}%`,
              height: `${(vh / docH) * 100}%`,
            }}
          />
        </div>
      </div>
      <span className="minimap-zoom">{Math.round(zoom * 100)}%</span>
    </div>
  )
}
