import { useStore } from '../state/store.js'
import { polygonBounds } from '../engine/shapes.js'

const ACTIONS = [
  { id: 'copy', label: 'Copy to layer', title: 'Duplicate just this region onto a new layer' },
  { id: 'cut', label: 'Cut to layer', title: 'Move this region onto a new layer, removing it from the original' },
  { id: 'mask', label: 'Mask', title: 'Keep only what is inside the outline' },
  { id: 'erase', label: 'Erase', title: 'Remove what is inside the outline' },
  { id: 'effect', label: 'Pixelate', title: 'Add an overlay shaped like the outline' },
]

/** Floating actions for a closed lasso outline, anchored under its bounds. */
export default function LassoBar() {
  const lasso = useStore((s) => s.lasso)
  const view = useStore((s) => s.view)
  const applyLasso = useStore((s) => s.applyLasso)
  const clearLasso = useStore((s) => s.clearLasso)
  const textBehindSubject = useStore((s) => s.textBehindSubject)
  const setTool = useStore((s) => s.setTool)
  const setNotice = useStore((s) => s.setNotice)
  const target = useStore((s) => {
    const sel = s.doc.layers.filter((l) => s.selectedIds.includes(l.id) && !l.locked)
    if (sel.length) return sel[sel.length - 1]
    for (let i = s.doc.layers.length - 1; i >= 0; i--) {
      const l = s.doc.layers[i]
      if (l.visible && !l.locked && l.type !== 'effect') return l
    }
    return null
  })

  if (!lasso?.points?.length) return null

  const b = polygonBounds(lasso.points)
  const left = view.panX + (b.x + b.w / 2) * view.zoom
  const top = view.panY + (b.y + b.h) * view.zoom + 12

  const run = (mode) => {
    const res = applyLasso(mode)
    setNotice(res.ok ? { kind: 'ok', text: res.text } : { kind: 'warn', text: res.reason })
  }

  // Mask, then text behind, in one step. Reaching for the lasso and expecting to
  // put something behind what you just outlined is the natural order; making it
  // two separate hunts through two different panels was not.
  const textBehind = () => {
    // No trim here: the sandwich needs the whole photograph underneath, and the
    // cut-out copy on top is shrink-wrapped afterwards instead.
    const res = applyLasso('mask', { trim: false })
    if (!res.ok) {
      setNotice({ kind: 'warn', text: res.reason })
      return
    }
    const id = useStore.getState().selectedIds[0] || target?.id
    if (id) textBehindSubject(id)
    // Back to the move tool: this ends with a text layer selected and waiting to
    // be typed into or dragged, and staying in the lasso means the next click
    // starts plotting points on top of it instead.
    setTool('move')
  }

  return (
    <div className="lasso-bar" style={{ left, top }}>
      <span className="lasso-target" title="Lasso actions apply to this layer">
        {target ? target.name : 'no layer selected'}
      </span>
      {ACTIONS.map((a) => (
        <button key={a.id} title={a.title} onClick={() => run(a.id)}>{a.label}</button>
      ))}
      <button
        title="Mask to this outline, then drop a text layer behind the subject"
        onClick={textBehind}
      >Text behind</button>
      <button className="x" title="Discard the outline (Esc)" onClick={clearLasso}>✕</button>
    </div>
  )
}
