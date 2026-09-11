import { useEffect, useRef, useState } from 'react'
import { useStore } from '../state/store.js'
import { Info } from './ui.jsx'
import { getAsset } from '../engine/assets.js'
import { thumbAt, posterHeight } from '../engine/filmstrip.js'
import CollageDialog from './CollageDialog.jsx'

const POSTER_H = 132

/**
 * One card. The poster is drawn onto a canvas rather than set as an <img>,
 * because the frame it shows comes from the same decode path everything else
 * uses — a video has no still to point an <img> at.
 */
function MediaCard({ asset, selected, onSelect, onOpen }) {
  const ref = useRef(null)

  useEffect(() => {
    let cancelled = false
    const canvas = ref.current
    if (!canvas) return undefined
    ;(async () => {
      // A quarter in rather than frame zero: clips often open on black or a fade,
      // which makes for a poster that identifies nothing.
      const at = asset.animated ? asset.duration * 0.25 : 0
      const dpr = Math.min(2, window.devicePixelRatio || 1)
      const box = ref.current.getBoundingClientRect()
      const w = Math.max(1, Math.round(box.width))
      let thumb = null
      try {
        // Asked for by what the poster will actually need, not by the box's
        // height: a poster covers and crops, so a tall picture is scaled by its
        // width and a thumbnail sized by height comes back far too narrow.
        thumb = await thumbAt(asset, at, posterHeight(asset, w, POSTER_H, dpr))
      } catch {
        thumb = null
      }
      if (cancelled || !thumb || !ref.current) return
      ref.current.width = Math.round(w * dpr)
      ref.current.height = Math.round(POSTER_H * dpr)
      const ctx = ref.current.getContext('2d')
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      ctx.imageSmoothingQuality = 'high'
      ctx.clearRect(0, 0, w, POSTER_H)
      // Cover. The argument for contain was that a bin should show the whole
      // frame — but a portrait clip in a wide tile then becomes a sliver between
      // two black margins, and a picture too small to recognise shows nothing at
      // all. Filling the tile and cropping the edges is the trade every bin
      // makes, and it is the right one.
      const k = Math.max(w / thumb.width, POSTER_H / thumb.height)
      const dw = thumb.width * k
      const dh = thumb.height * k
      ctx.drawImage(thumb, (w - dw) / 2, (POSTER_H - dh) / 2, dw, dh)
    })()
    return () => { cancelled = true }
  }, [asset])

  const kind = asset.isVideo ? 'VID' : asset.animated ? 'GIF' : 'IMG'
  const secs = asset.duration ? (asset.duration / 1000).toFixed(1) + 's' : null

  return (
    <button
      className={'media-card' + (selected ? ' sel' : '')}
      onClick={(e) => onSelect(e)}
      onDoubleClick={onOpen}
      title={`${asset.name}\n${asset.width} × ${asset.height}${secs ? ` · ${secs}` : ''}\nDouble-click to add to the canvas`}
    >
      <span className="media-poster">
        <canvas ref={ref} style={{ width: '100%', height: POSTER_H }} />
        <span className={'media-kind ' + kind.toLowerCase()}>{kind}</span>
        {secs && <span className="media-dur">{secs}</span>}
      </span>
      <span className="media-name">{asset.name}</span>
      <span className="media-dim">
        {asset.width} × {asset.height}
        {asset.animated && <span className="dim"> · {asset.frames.length}f</span>}
      </span>
    </button>
  )
}

export default function MediaView() {
  const media = useStore((s) => s.doc.media)
  const layers = useStore((s) => s.doc.layers)
  const addImages = useStore((s) => s.addImages)
  const placeMedia = useStore((s) => s.placeMedia)
  const placeMounted = useStore((s) => s.placeMounted)
  const removeMedia = useStore((s) => s.removeMedia)
  const setWorkspace = useStore((s) => s.setWorkspace)
  const [picked, setPicked] = useState([])
  const [collaging, setCollaging] = useState(false)
  const [anchor, setAnchor] = useState(null)
  const inputRef = useRef(null)

  const items = media.map(getAsset).filter(Boolean)
  const onCanvas = new Set(layers.filter((l) => l.type === 'image').map((l) => l.assetId))

  // A selection referring to media that has since gone would silently act on
  // nothing, so it is pruned whenever the bin changes.
  useEffect(() => {
    setPicked((p) => p.filter((id) => media.includes(id)))
  }, [media])

  const select = (e, id, index) => {
    if (e.shiftKey && anchor !== null) {
      const [a, b] = [anchor, index].sort((x, y) => x - y)
      setPicked(items.slice(a, b + 1).map((m) => m.id))
      return
    }
    setAnchor(index)
    if (e.ctrlKey || e.metaKey) {
      setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]))
    } else {
      setPicked([id])
    }
  }

  useEffect(() => {
    const onKey = (e) => {
      if (e.target.matches('input, textarea')) return
      if ((e.key === 'Delete' || e.key === 'Backspace') && picked.length) {
        e.preventDefault()
        removeMedia(picked)
      }
      if (e.key === 'a' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault()
        setPicked(items.map((m) => m.id))
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [picked, items, removeMedia])

  return (
    <div className="media-view">
      <div className="media-head">
        <span className="media-count">
          {items.length ? `${items.length} item${items.length === 1 ? '' : 's'}` : 'Nothing imported yet'}
          {picked.length > 0 && <span className="dim"> · {picked.length} selected</span>}
        </span>
        <span className="spacer" />
        <button className="btn ghost" onClick={() => inputRef.current.click()}>Import…</button>
        <input
          ref={inputRef}
          className="pf-media-input-2"
          type="file"
          accept="image/*,video/mp4,video/quicktime,video/webm,.mp4,.m4v,.mov,.webm,.mkv"
          multiple
          hidden
          onChange={(e) => { addImages(e.target.files, { place: false }); e.target.value = '' }}
        />
        <button
          className="btn ghost"
          disabled={items.length < 2}
          title={items.length < 2
            ? 'Needs at least two items'
            : 'Arrange these into a grid of tilted photo mounts'}
          onClick={() => setCollaging(true)}
        >Collage{picked.length > 1 ? ` (${picked.length})` : ''}…</button>
        <button
          className="btn ghost"
          disabled={!picked.length}
          title={picked.length
            ? 'Add these to the canvas as photo mounts — white border, soft shadow, slight tilt'
            : 'Pick something first'}
          onClick={() => placeMounted(picked, 'polaroid')}
        >Polaroid{picked.length > 1 ? ` (${picked.length})` : ''}</button>
        <button
          className="btn ghost"
          disabled={!picked.length}
          onClick={() => removeMedia(picked)}
        >Remove</button>
        <button
          className="btn primary"
          disabled={!picked.length}
          onClick={() => placeMedia(picked, { resizeDocToFirst: layers.length === 0 })}
        >Add to canvas</button>
      </div>

      {items.length === 0 ? (
        <div
          className="media-empty clickable"
          role="button"
          tabIndex={0}
          title="Click to choose files"
          onClick={() => inputRef.current.click()}
          onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') inputRef.current.click() }}
        >
          <h2>
            Drop your footage here
            <Info>
              Images, GIFs and MP4s land in this bin instead of going straight onto the
              canvas — so importing ten photos gives you ten things to choose from rather
              than ten layers stacked on top of each other. Everything here is saved with
              the project whether it is on the canvas or not.
            </Info>
          </h2>
          <p>Pick what you want and press <b>Add to canvas</b>, or double-click one.</p>
          <p className="media-cue">Click anywhere here to choose files</p>
        </div>
      ) : (
        <div
          className="media-grid"
          title={picked.length ? 'Click here to deselect' : 'Click here to import more'}
          // Blank space does double duty. With something selected the obvious
          // meaning is "deselect", so that wins; with nothing selected there is
          // nothing to deselect and the useful thing is to import more. So the
          // first click clears the selection and the second opens the picker.
          onPointerDown={(e) => {
            if (e.target !== e.currentTarget) return
            if (picked.length) setPicked([])
            else inputRef.current.click()
          }}
        >
          {items.map((asset, i) => (
            <div
              className="media-slot"
              key={asset.id}
              draggable
              onDragStart={(e) => {
                // The payload is the asset id; the timeline turns it into a clip
                // wherever it lands. Dragging is the whole gesture — there is no
                // button to press first, because the drop says where it goes.
                e.dataTransfer.setData('application/x-pixelforge-asset', asset.id)
                e.dataTransfer.effectAllowed = 'copy'
              }}
              title="Drag onto the timeline to add it as a clip"
            >
              <MediaCard
                asset={asset}
                selected={picked.includes(asset.id)}
                onSelect={(e) => select(e, asset.id, i)}
                onOpen={() => placeMedia([asset.id], { resizeDocToFirst: layers.length === 0 })}
              />
              {onCanvas.has(asset.id) && (
                <span className="media-used" title="Already on the canvas">on canvas</span>
              )}
            </div>
          ))}
        </div>
      )}

      {collaging && (
        <CollageDialog
          // A selection of one is not a collage, so a lone pick falls back to
          // everything in the bin rather than refusing.
          assetIds={picked.length > 1 ? picked : items.map((m) => m.id)}
          onClose={() => setCollaging(false)}
        />
      )}

      {items.length > 0 && (
        <div className="media-foot">
          <button className="btn ghost" onClick={() => setWorkspace('editor')}>
            Back to the editor
          </button>
        </div>
      )}
    </div>
  )
}
