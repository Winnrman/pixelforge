import { useLayoutEffect, useRef } from 'react'
import { useStore } from '../state/store.js'
import { polygonBounds } from '../engine/shapes.js'

const ACTIONS = [
  { id: 'copy', label: 'Copy to layer', title: 'Duplicate just this region onto a new layer' },
  { id: 'cut', label: 'Cut to layer', title: 'Move this region onto a new layer, removing it from the original' },
  { id: 'mask', label: 'Mask', title: 'Keep only what is inside the outline' },
  {
    id: 'mask-add',
    label: 'Add to mask',
    title: 'Put this piece back into the mask that is already there',
    // Only where there is a mask to add to. It takes the place of Mask rather
    // than sitting beside it, because on a layer that is already cut out,
    // drawing a second outline nearly always means "and this bit too" — and
    // Clear mask in the inspector is there for the times it does not.
    when: (l) => (l?.mask?.points?.length || 0) >= 3,
    instead: 'mask',
  },
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

  const barRef = useRef(null)

  // Keep the bar on screen.
  //
  // It is anchored under the outline, which is fine until the outline reaches
  // the bottom of the picture — then the actions sit below the stage, half cut
  // off by the window, and a full-height image puts them there every time. So it
  // flips above the outline when there is no room beneath, and slides along
  // rather than hanging off either side. Measured after layout, because the bar
  // is as wide as its longest button label and that is not a number to hardcode.
  //
  // Written straight to the node rather than into state: the value depends on
  // the size of the thing being positioned, and feeding a measurement back into
  // a render that changes the measurement is how a loop starts.
  useLayoutEffect(() => {
    const el = barRef.current
    if (!el) return
    const stage = el.parentElement?.querySelector('.stage')
    if (!stage) return
    const M = 10
    const bw = el.offsetWidth
    const bh = el.offsetHeight
    const sw = stage.clientWidth
    const sh = stage.clientHeight + stage.offsetTop
    const under = Number(el.dataset.under)
    const over = Number(el.dataset.over)

    let t = under
    if (t + bh + M > sh) t = over - bh >= M ? over - bh : Math.max(M, sh - bh - M)
    el.style.top = `${t}px`

    // A bar wider than the stage cannot be fitted, only centred.
    const half = bw / 2
    const x = Number(el.dataset.cx)
    el.style.left = bw + M * 2 > sw
      ? `${sw / 2}px`
      : `${Math.min(Math.max(x, half + M), sw - half - M)}px`
  })

  if (!lasso?.points?.length) return null

  const b = polygonBounds(lasso.points)
  const left = view.panX + (b.x + b.w / 2) * view.zoom
  const top = view.panY + (b.y + b.h) * view.zoom + 12
  const above = view.panY + b.y * view.zoom - 12

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
    <div
      className="lasso-bar"
      ref={barRef}
      style={{ left, top }}
      data-cx={left}
      data-under={top}
      data-over={above}
    >
      <span className="lasso-target" title="Lasso actions apply to this layer">
        {target ? target.name : 'no layer selected'}
      </span>
      {ACTIONS.filter((a) => {
        if (a.when) return a.when(target)
        // A general action steps aside for the specific one that replaces it.
        const taken = ACTIONS.find((b) => b.instead === a.id && b.when?.(target))
        return !taken
      }).map((a) => (
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
