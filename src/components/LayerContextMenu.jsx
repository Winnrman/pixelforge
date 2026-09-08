import { useEffect, useRef } from 'react'
import { useStore } from '../state/store.js'
import { isGroup } from '../engine/groups.js'

export default function LayerContextMenu() {
  const menu = useStore((s) => s.contextMenu)
  const close = useStore((s) => s.setContextMenu)
  const layers = useStore((s) => s.doc.layers)
  const selectedIds = useStore((s) => s.selectedIds)
  const clipboardCount = useStore((s) => s.clipboard.length)
  const ref = useRef(null)

  useEffect(() => {
    if (!menu) return
    const onDown = (e) => { if (!ref.current?.contains(e.target)) close(null) }
    const onKey = (e) => { if (e.key === 'Escape') close(null) }
    window.addEventListener('pointerdown', onDown, true)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('pointerdown', onDown, true)
      window.removeEventListener('keydown', onKey)
    }
  }, [menu, close])

  if (!menu) return null
  const layer = layers.find((l) => l.id === menu.layerId)
  if (!layer) return null

  const s = useStore.getState()
  // Act on the whole selection when the clicked layer is part of it.
  const ids = selectedIds.includes(layer.id) ? selectedIds : [layer.id]
  const many = ids.length > 1
  const idx = layers.indexOf(layer)

  const run = (fn) => () => { fn(); close(null) }

  const items = [
    { label: many ? `Duplicate ${ids.length} layers` : 'Duplicate', hint: 'Ctrl+D',
      act: () => s.duplicateLayers(ids) },
    { label: 'Copy', hint: 'Ctrl+C', act: () => s.copyLayers(ids) },
    { label: 'Cut', hint: 'Ctrl+X', act: () => s.cutLayers(ids) },
    { label: 'Paste', hint: 'Ctrl+V', disabled: !clipboardCount, act: () => s.pasteLayers() },
    { sep: true },
    { label: many ? `Group ${ids.length} layers` : 'Group', hint: 'Ctrl+G',
      act: () => s.groupLayers(ids) },
    ...(isGroup(layer)
      ? [{ label: 'Ungroup', hint: 'Ctrl+Shift+G', act: () => s.ungroupLayers([layer.id]) }]
      : []),
    ...(layer.parentId
      ? [{ label: 'Move out of group', act: () => s.moveToGroup(ids, null) }]
      : []),
    { sep: true },
    { label: 'Bring to front', disabled: idx === layers.length - 1,
      act: () => s.moveLayerTo(layer.id, layers.length - 1) },
    { label: 'Bring forward', hint: ']', disabled: idx === layers.length - 1,
      act: () => s.reorderLayer(layer.id, 1) },
    { label: 'Send backward', hint: '[', disabled: idx === 0,
      act: () => s.reorderLayer(layer.id, -1) },
    { label: 'Send to back', disabled: idx === 0, act: () => s.moveLayerTo(layer.id, 0) },
    { sep: true },
    { label: layer.visible ? 'Hide' : 'Show',
      act: () => { s.pushHistory(); s.updateLayer(layer.id, { visible: !layer.visible }); s.recomputeDuration() } },
    { label: layer.locked ? 'Unlock' : 'Lock',
      act: () => s.updateLayer(layer.id, { locked: !layer.locked }) },
    { label: 'Rename…', act: () => window.dispatchEvent(
      new CustomEvent('pf-rename-layer', { detail: layer.id })) },
    ...(layer.mask ? [{ label: 'Remove mask', act: () => s.clearMask(layer.id) }] : []),
    // What a clip can do that a layer cannot. Only shown on clips, because a
    // menu that lists things which do not apply is a menu you have to read.
    ...(layer.clip ? [
      { sep: true },
      { label: 'Cut at playhead', hint: 'Ctrl+K', act: () => s.splitClips(null, ids) },
      ...(many ? [{
        label: `Join ${ids.length} clips`,
        act: () => {
          const r = s.joinClips(ids)
          s.setNotice(r.ok ? { kind: 'ok', text: r.text } : { kind: 'warn', text: r.reason })
        },
      }] : []),
      { label: layer.muted ? 'Unmute' : 'Mute',
        act: () => { s.pushHistory(); s.updateLayer(layer.id, { muted: !layer.muted }) } },
    ] : []),
    { sep: true },
    { label: many ? `Delete ${ids.length} layers` : 'Delete', hint: 'Del', danger: true,
      act: () => s.removeLayers(ids) },
  ]

  // Keep the menu on screen.
  const H = items.length * 24 + 16
  const top = Math.min(menu.y, window.innerHeight - H - 8)
  const left = Math.min(menu.x, window.innerWidth - 200)

  return (
    <div className="ctx-menu" ref={ref} style={{ top, left }}>
      {items.map((it, i) => (
        it.sep
          ? <div className="ctx-sep" key={'s' + i} />
          : (
            <button
              key={it.label}
              className={'ctx-item' + (it.danger ? ' danger' : '')}
              disabled={it.disabled}
              onClick={run(it.act)}
            >
              <span>{it.label}</span>
              {it.hint && <kbd>{it.hint}</kbd>}
            </button>
          )
      ))}
    </div>
  )
}
