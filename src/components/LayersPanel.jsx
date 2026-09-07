import { useEffect, useRef, useState } from 'react'
import { useStore } from '../state/store.js'
import { getAsset } from '../engine/assets.js'
import { buildTree, isGroup, resolveGroups } from '../engine/groups.js'

const TYPE_BADGE = {
  image: 'IMG',
  effect: 'FX',
  shape: 'SHP',
  text: 'TXT',
  group: 'GRP',
}

function LayerThumb({ layer }) {
  if (layer.type === 'group') {
    return (
      <span className="thumb grp">
        <svg viewBox="0 0 20 20" width="15" height="15">
          <path d="M2 6 h5 l1.5 2 H18 v9 H2 Z" fill="none" stroke="currentColor" strokeWidth="1.6"
            strokeLinejoin="round" />
        </svg>
      </span>
    )
  }
  if (layer.type === 'image') {
    const a = getAsset(layer.assetId)
    // A cut-out looks nothing like the layer it came from, so it should not
    // look like it in the list either. Two copies of the same photo, one
    // masked, were previously identical rows with identical names.
    if (layer.bgRemove?.on) {
      return (
        <span className="thumb cut" title="Background removed">
          <svg viewBox="0 0 20 20" width="17" height="17">
            {/* A bust on a checker ground: the checkers say "transparent", the
                silhouette says "this is the subject only". */}
            <circle cx="10" cy="6.4" r="3.1" fill="currentColor" />
            <path d="M3.4 18 a6.6 6.6 0 0 1 13.2 0 Z" fill="currentColor" />
          </svg>
        </span>
      )
    }
    if (a?.isVideo) return <span className="thumb vid">MP4</span>
    if (a?.animated) return <span className="thumb gif">GIF</span>
    return <span className="thumb img" />
  }
  if (layer.type === 'effect') {
    return (
      <span className="thumb fx">
        <svg viewBox="0 0 20 20" width="18" height="18">
          {[0, 1, 2, 3].map((r) => [0, 1, 2, 3].map((c) => (
            <rect key={`${r}${c}`} x={c * 5} y={r * 5} width="5" height="5" fill="currentColor"
              opacity={0.15 + ((r * 5 + c * 3) % 4) * 0.2} />
          )))}
        </svg>
      </span>
    )
  }
  if (layer.type === 'shape') {
    return <span className="thumb shp" style={{ background: layer.fill }} />
  }
  return <span className="thumb txt">T</span>
}

export default function LayersPanel() {
  const layers = useStore((s) => s.doc.layers)
  const selectedIds = useStore((s) => s.selectedIds)
  const select = useStore((s) => s.select)
  const updateLayer = useStore((s) => s.updateLayer)
  const removeLayers = useStore((s) => s.removeLayers)
  const groupLayers = useStore((s) => s.groupLayers)
  const moveLayerTo = useStore((s) => s.moveLayerTo)
  const moveToGroup = useStore((s) => s.moveToGroup)
  const toggleCollapse = useStore((s) => s.toggleCollapse)
  const pushHistory = useStore((s) => s.pushHistory)
  const setContextMenu = useStore((s) => s.setContextMenu)
  const [renaming, setRenaming] = useState(null)
  const [dropTarget, setDropTarget] = useState(null)
  const dragId = useRef(null)

  // The context menu lives outside this tree, so it asks for a rename by event.
  useEffect(() => {
    const onRename = (e) => setRenaming(e.detail)
    window.addEventListener('pf-rename-layer', onRename)
    return () => window.removeEventListener('pf-rename-layer', onRename)
  }, [])

  const rows = buildTree(layers)
  const effective = resolveGroups(layers)

  return (
    <div className="layers">
      <div className="panel-head">
        <span>Layers</span>
        <span className="panel-actions">
          <button
            title="Group selected layers (Ctrl+G)"
            disabled={!selectedIds.length}
            onClick={() => groupLayers(selectedIds)}
          >🗀</button>
          <button
            title="Delete"
            disabled={!selectedIds.length}
            onClick={() => removeLayers(selectedIds)}
          >🗑</button>
        </span>
      </div>

      <div
        className="layer-list"
        // With a layer covering the whole canvas there is no empty canvas left
        // to click, so the panel has to offer a way out of a selection.
        onClick={(e) => { if (e.target.classList?.contains('layer-list')) select([]) }}
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => {
          // Dropping on empty space lifts a layer back out to the top level.
          if (e.target.classList?.contains('layer-list') && dragId.current) {
            moveToGroup([dragId.current], null)
          }
          dragId.current = null
          setDropTarget(null)
        }}
      >
        {!rows.length && (
          <div className="empty-note">
            No layers yet. Imports land in <b>Media</b> — pick something there and add it.
          </div>
        )}
        {rows.map(({ layer: l, depth }) => {
          const idx = layers.indexOf(l)
          const on = selectedIds.includes(l.id)
          const group = isGroup(l)
          const dimmed = !effective.visible.get(l.id)
          return (
            <div
              key={l.id}
              className={'layer' + (on ? ' on' : '') + (dimmed ? ' hidden' : '') +
                (group ? ' is-group' : '') + (dropTarget === l.id ? ' drop-into' : '')}
              style={{ paddingLeft: 6 + depth * 14 }}
              draggable
              onDragStart={() => { dragId.current = l.id }}
              onDragOver={(e) => {
                e.preventDefault()
                if (group && dragId.current && dragId.current !== l.id) setDropTarget(l.id)
              }}
              onDragLeave={() => setDropTarget((t) => (t === l.id ? null : t))}
              onDrop={(e) => {
                e.preventDefault()
                e.stopPropagation()
                const from = dragId.current
                dragId.current = null
                setDropTarget(null)
                if (!from || from === l.id) return
                // Onto a group row: move inside it. Onto a layer: restack beside it.
                if (group) moveToGroup([from], l.id)
                else {
                  moveToGroup([from], l.parentId || null)
                  moveLayerTo(from, idx)
                }
              }}
              onClick={(e) => {
                if (e.shiftKey) {
                  select(on ? selectedIds.filter((id) => id !== l.id) : [...selectedIds, l.id])
                } else select([l.id])
              }}
              onContextMenu={(e) => {
                e.preventDefault()
                if (!on) select([l.id])
                setContextMenu({ x: e.clientX, y: e.clientY, layerId: l.id })
              }}
            >
              {group ? (
                <button
                  className="twisty"
                  title={l.collapsed ? 'Expand' : 'Collapse'}
                  onClick={(e) => { e.stopPropagation(); toggleCollapse(l.id) }}
                >{l.collapsed ? '▸' : '▾'}</button>
              ) : <span className="twisty spacer" />}

              <button
                className="eye"
                title={l.visible ? 'Hide' : 'Show'}
                onClick={(e) => {
                  e.stopPropagation()
                  pushHistory()
                  updateLayer(l.id, { visible: !l.visible })
                  useStore.getState().recomputeDuration()
                }}
              >{l.visible ? '◉' : '○'}</button>

              <LayerThumb layer={l} />

              {renaming === l.id ? (
                <input
                  className="rename"
                  autoFocus
                  defaultValue={l.name}
                  onBlur={(e) => { updateLayer(l.id, { name: e.target.value || l.name }); setRenaming(null) }}
                  onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur() }}
                  onClick={(e) => e.stopPropagation()}
                />
              ) : (
                <span className="layer-name" onDoubleClick={() => setRenaming(l.id)}>{l.name}</span>
              )}

              <span className="badge">
                {l.type === 'image' && l.bgRemove?.on
                  ? 'CUT'
                  : l.type === 'image' && getAsset(l.assetId)?.isVideo
                    ? 'VID'
                    : TYPE_BADGE[l.type]}
              </span>
              <button
                className="lock"
                title={l.locked ? 'Unlock' : 'Lock'}
                onClick={(e) => { e.stopPropagation(); updateLayer(l.id, { locked: !l.locked }) }}
              >{l.locked ? '🔒' : '🔓'}</button>
            </div>
          )
        })}
      </div>
    </div>
  )
}
