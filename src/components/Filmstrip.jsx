import { useEffect, useRef, useState } from 'react'
import { useStore } from '../state/store.js'
import { THUMB_H, cachedThumb, thumbAt, stripTimes } from '../engine/filmstrip.js'

/**
 * A row of thumbnails across the timeline for one layer.
 *
 * Everything lands on a single canvas rather than N <img> elements: a strip is
 * redrawn on every resize, and swapping fifty DOM nodes each time a panel moves
 * is far more work than one drawImage loop.
 *
 * Thumbnails arrive in two passes. Anything already cached is painted
 * immediately so a strip that has been seen before appears whole, then the gaps
 * are filled one at a time. Video decoding is deliberately not started while
 * the clip is playing — the decoder's frame budget belongs to the playhead, and
 * a strip that fills in a moment later costs nothing.
 */
export default function Filmstrip({ layer, asset, duration, time }) {
  const canvasRef = useRef(null)
  const boxRef = useRef(null)
  const [width, setWidth] = useState(0)
  const [pending, setPending] = useState(0)
  const playing = useStore((s) => s.playing)
  const setTime = useStore((s) => s.setTime)
  const setPlaying = useStore((s) => s.setPlaying)
  const select = useStore((s) => s.select)

  useEffect(() => {
    const box = boxRef.current
    if (!box) return undefined
    const ro = new ResizeObserver(([e]) => setWidth(Math.floor(e.contentRect.width)))
    ro.observe(box)
    setWidth(Math.floor(box.getBoundingClientRect().width))
    return () => ro.disconnect()
  }, [])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || width <= 0 || !(duration > 0)) return undefined

    const dpr = Math.min(2, window.devicePixelRatio || 1)
    canvas.width = Math.round(width * dpr)
    canvas.height = Math.round(THUMB_H * dpr)
    const ctx = canvas.getContext('2d')
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, width, THUMB_H)

    const slots = stripTimes(layer, asset, width, duration)

    // Cover-fit, so a slot narrower than a frame crops rather than squashing it.
    const draw = (slot, thumb) => {
      const k = Math.max(slot.w / thumb.width, THUMB_H / thumb.height)
      const dw = thumb.width * k
      const dh = thumb.height * k
      ctx.save()
      ctx.beginPath()
      ctx.rect(slot.x, 0, slot.w, THUMB_H)
      ctx.clip()
      ctx.imageSmoothingQuality = 'low'
      ctx.drawImage(thumb, slot.x + (slot.w - dw) / 2, (THUMB_H - dh) / 2, dw, dh)
      ctx.restore()
    }

    const missing = []
    for (const slot of slots) {
      const hit = cachedThumb(asset, slot.assetT)
      if (hit) draw(slot, hit)
      else missing.push(slot)
    }

    // A GIF's frames are already decoded, so filling in is instant and there is
    // no reason to wait for playback to stop.
    if (!missing.length || (playing && asset.isVideo)) {
      setPending(missing.length)
      return undefined
    }

    let cancelled = false
    setPending(missing.length)
    ;(async () => {
      let left = missing.length
      for (const slot of missing) {
        if (cancelled) return
        let thumb = null
        try {
          thumb = await thumbAt(asset, slot.assetT)
        } catch {
          thumb = null // an unreadable frame leaves a gap rather than a broken strip
        }
        if (cancelled) return
        if (thumb) draw(slot, thumb)
        setPending(--left)
      }
    })()
    return () => { cancelled = true }
  }, [width, duration, playing, asset, layer.id, layer.speed, layer.timeOffset])

  const scrub = (e) => {
    const r = boxRef.current.getBoundingClientRect()
    setTime(Math.max(0, Math.min(duration, ((e.clientX - r.left) / r.width) * duration)))
  }

  const pct = duration ? Math.min(100, (time / duration) * 100) : 0

  return (
    <div className="strip-row">
      <span className="strip-name" title={layer.name}>{layer.name}</span>
      <div
        className="strip"
        ref={boxRef}
        title="Drag to scrub"
        onPointerDown={(e) => {
          if (e.button !== 0) return
          e.currentTarget.setPointerCapture(e.pointerId)
          setPlaying(false)
          select([layer.id])
          scrub(e)
        }}
        onPointerMove={(e) => { if (e.buttons === 1) scrub(e) }}
      >
        <canvas ref={canvasRef} style={{ width: '100%', height: THUMB_H }} />
        <div className="strip-playhead" style={{ left: `${pct}%` }} />
        {pending > 0 && <span className="strip-pending">{pending} left</span>}
      </div>
      <span className="strip-meta">
        {asset.isVideo ? 'MP4' : 'GIF'} · {asset.frames.length}f · {(asset.duration / 1000).toFixed(1)}s
      </span>
    </div>
  )
}
