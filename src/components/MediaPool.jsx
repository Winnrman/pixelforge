import { useEffect, useRef, useState } from 'react'
import { useStore } from '../state/store.js'
import { getAsset } from '../engine/assets.js'
import { thumbAt, posterHeight } from '../engine/filmstrip.js'

const POSTER_H = 46

/**
 * A poster for one piece of media, small.
 *
 * Its own component rather than the Media tab's card because the two want
 * different things: that one is a browser, where the frame matters and there is
 * room for it, and this is a bin you drag out of, where what matters is telling
 * six clips apart in a column two hundred pixels wide.
 */
function PoolCard({ asset, used, onOpen }) {
  const ref = useRef(null)
  // The poster is drawn at the canvas's measured width, and the canvas measures
  // zero while the editor is hidden — which is exactly when a card first
  // appears, because importing takes you to the Media tab. It drew a
  // one-pixel-wide poster and, having no reason to run again, kept it: a thin
  // white line where the picture should be. Watching the box means it is drawn
  // when there is something to draw it into, and redrawn if the bin is resized.
  const [w, setW] = useState(0)

  useEffect(() => {
    const canvas = ref.current
    if (!canvas || typeof ResizeObserver === 'undefined') return undefined
    const ro = new ResizeObserver(([entry]) => {
      setW(Math.round(entry.contentRect.width))
    })
    ro.observe(canvas)
    return () => ro.disconnect()
  }, [])

  useEffect(() => {
    let cancelled = false
    const canvas = ref.current
    if (!canvas || w < 8) return undefined
    ;(async () => {
      // A quarter in, like the Media tab: clips that open on black or a fade
      // make a poster that identifies nothing.
      const at = asset.animated ? asset.duration * 0.25 : 0
      const dpr = Math.min(2, window.devicePixelRatio || 1)
      let thumb = null
      try {
        // By what covering the card needs rather than by its height — see
        // `posterHeight`. A portrait clip asked for by height came back
        // twenty-one pixels wide and was stretched across the whole tile.
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
      // Cover, not contain: the poster fills the card and is cropped to fit.
      // A portrait clip letterboxed into a wide tile is a sliver between two
      // black margins — most of the tile spent on nothing, and the picture too
      // small to tell one shot from another, which is the only thing a bin is
      // for.
      const k = Math.max(w / thumb.width, POSTER_H / thumb.height)
      const dw = thumb.width * k
      const dh = thumb.height * k
      ctx.drawImage(thumb, (w - dw) / 2, (POSTER_H - dh) / 2, dw, dh)
    })()
    return () => { cancelled = true }
  }, [asset, w])

  return (
    <div
      className={'pool-card' + (used ? ' used' : '')}
      draggable
      title={`${asset.name} — drag onto a track, or double-click to put it on the canvas`}
      onDragStart={(e) => {
        // The same payload the Media tab sends, so the timeline has one thing to
        // understand however the media reached it.
        e.dataTransfer.setData('application/x-pixelforge-asset', asset.id)
        e.dataTransfer.effectAllowed = 'copy'
      }}
      onDoubleClick={onOpen}
    >
      <canvas ref={ref} style={{ width: '100%', height: POSTER_H }} />
      <span className="pool-name">{asset.name}</span>
      {asset.animated && (
        <span className="pool-badge">{(asset.duration / 1000).toFixed(1)}s</span>
      )}
    </div>
  )
}

/**
 * The bin, beside the picture rather than behind a tab.
 *
 * Editing is a loop of look at the shot, drag it onto a track, look again — and
 * the Media tab put a whole screen change in the middle of that loop. The tab
 * stays, because browsing a bin of a hundred photographs and picking one to work
 * on is a different job that deserves the whole window. This is the same media,
 * to hand.
 */
export default function MediaPool() {
  const media = useStore((s) => s.doc.media)
  const layers = useStore((s) => s.doc.layers)
  const placeMedia = useStore((s) => s.placeMedia)
  const setWorkspace = useStore((s) => s.setWorkspace)
  const inputRef = useRef(null)
  const addImages = useStore((s) => s.addImages)

  const items = media.map((id) => getAsset(id)).filter(Boolean)
  const onCanvas = new Set(layers.map((l) => l.assetId).filter(Boolean))

  // Nothing imported: no bin. An empty bin is a place to grab from with nothing
  // to grab, and its Import button led to the Media tab anyway — a second way to
  // reach the one door, which is a button press to arrive where the other button
  // already goes. The bin earns its column the moment there is something in it.
  if (!items.length) return null

  return (
    <div className="pool">
      <div className="pool-head">
        <span className="pool-title">Media</span>
        <span className="pool-count">{items.length}</span>
        <button
          className="mini"
          title="Import files"
          onClick={() => inputRef.current?.click()}
        >Import</button>
        <button
          className="mini"
          title="Open the Media tab, where there is room to sort and pick"
          onClick={() => setWorkspace('media')}
        >All</button>
      </div>

      <input
        ref={inputRef}
        className="pf-pool-input"
        type="file"
        multiple
        hidden
        accept="image/*,video/mp4,video/quicktime,.mp4,.m4v,.mov"
        onChange={(e) => { addImages(e.target.files, { place: false }); e.target.value = '' }}
      />

      <div className="pool-grid">
        {items.map((asset) => (
          <PoolCard
            key={asset.id}
            asset={asset}
            used={onCanvas.has(asset.id)}
            onOpen={() => placeMedia([asset.id], { resizeDocToFirst: layers.length === 0 })}
          />
        ))}
      </div>
    </div>
  )
}
