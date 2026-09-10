import { useEffect, useRef, useState } from 'react'
import { useStore } from '../state/store.js'
import { getAsset } from '../engine/assets.js'
import { drawLayerThumb, thumbSignature } from '../engine/render.js'
import { buildTree, isGroup, resolveGroups } from '../engine/groups.js'

const TYPE_BADGE = {
  image: 'IMG',
  effect: 'FX',
  shape: 'SHP',
  text: 'TXT',
  group: 'GRP',
}

/**
 * The layer itself, small.
 *
 * A row that says IMG names the type of a thing whose type you already know.
 * Which *picture* it is was the only question a list of eleven of them was ever
 * being asked, and a coloured square could not answer it.
 *
 * Redrawn only when the layer would look different — never as it is dragged
 * about, which would be a render per pointer move per row.
 */
function PictureThumb({ layer, time }) {
  const ref = useRef(null)
  const sig = thumbSignature(layer)
  const asset = getAsset(layer.assetId)
  // Frames arrive after the layer does, so the picture has to be part of what
  // says this is stale — otherwise the first draw finds nothing and, having no
  // reason to run again, keeps the blank.
  const ready = asset ? (asset.el ? 'el' : `f${asset.frames?.length || 0}`) : 'none'

  useEffect(() => {
    const c = ref.current
    if (!c) return undefined
    const dpr = Math.min(2, window.devicePixelRatio || 1)
    c.width = Math.round(22 * dpr)
    c.height = Math.round(22 * dpr)
    try {
      drawLayerThumb(c, layer, time)
    } catch { /* an asset still decoding draws nothing, and will be asked again */ }
    return undefined
  }, [sig, ready, time, asset, layer])

  return <span className="thumb pic"><canvas ref={ref} /></span>
}

/** A padlock, drawn rather than typed: the rail is icons, so this is too. */
function LockIcon({ locked }) {
  return (
    <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
      <rect x="3.2" y="7" width="9.6" height="7" rx="1.4" fill="currentColor" />
      {/* Open, the shackle lifts off one shoulder and stands away from the body,
          which reads at twelve pixels where a smaller difference does not. */}
      <path
        d={locked ? 'M5.4 7 V4.8 a2.6 2.6 0 0 1 5.2 0 V7' : 'M5.4 7 V4.4 a2.6 2.6 0 0 1 5.2 -0.4'}
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
    </svg>
  )
}

function LayerThumb({ layer, time }) {
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
  // Every picture is its own picture now, cut-outs included — drawn on a checker
  // ground, so a subject standing free of its background still reads as one
  // without needing a silhouette to stand in for it. The badge beside the name
  // still says CUT, VID or GIF.
  if (layer.type === 'image') {
    // Video keeps its chip. A frame of it is not lying around at this size, so
    // drawing one means a seek per row — and a seek fills the playback cache
    // with frames the picture then has to evict, which is the cost the
    // filmstrip was rebuilt to stop paying. A GIF is already decoded, so it
    // costs nothing and gets a real picture.
    if (getAsset(layer.assetId)?.isVideo) return <span className="thumb vid">MP4</span>
    return <PictureThumb layer={layer} time={time} />
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
  if (layer.type === 'shape') return <PictureThumb layer={layer} time={time} />
  return <span className="thumb txt">T</span>
}

export default function LayersPanel() {
  const layers = useStore((s) => s.doc.layers)
  // Rounded, so a playing document does not redraw every row on every frame —
  // a thumbnail a third of a second stale is a thumbnail nobody notices.
  const time = useStore((s) => Math.round(s.time / 300) * 300)
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

              <LayerThumb layer={l} time={time} />

              {renaming === l.id ? (
                <input
                  className="rename"
                  autoFocus
                  defaultValue={l.name}
                  onBlur={(e) => {
                    // `renamed` stops a text layer's name following what it says:
                    // a name given by hand is a decision, and typing into the
                    // layer afterwards must not quietly undo it.
                    updateLayer(l.id, { name: e.target.value || l.name, renamed: true })
                    setRenaming(null)
                  }}
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
              ><LockIcon locked={l.locked} /></button>
            </div>
          )
        })}
      </div>
    </div>
  )
}
