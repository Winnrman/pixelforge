import { useEffect, useRef, useState } from 'react'
import { useStore } from '../state/store.js'
import { getAsset } from '../engine/assets.js'
import { THUMB_H, cachedThumb, thumbAt, stripTimes, stripWindow } from '../engine/filmstrip.js'
import {
  trackCount, assetTimeFor, snapPoints, snapClip, snapEdge, clipRange, SNAP_PX,
} from '../engine/clips.js'
import { columnsFor, hasPeaks } from '../engine/waveform.js'
import { pairsIn, TRANSITIONS } from '../engine/transitions.js'
import { ensureAudio } from '../engine/audio.js'

/** How close to an edge counts as grabbing it rather than the clip body. */
const EDGE_PX = 9

/**
 * A clip on the timeline: thumbnails of what it plays, over the span it plays.
 *
 * The strip *is* the clip. There used to be two rows for one piece of media — a
 * featureless bar you could drag, and a filmstrip of the same media below it —
 * which is two representations of one object and left trimming blind: the bar
 * showed a duration and no pictures, so you could not see what you were
 * trimming to. Drawing the thumbnails inside the draggable bar answers both.
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
export default function Filmstrip({ layer, asset, duration, time, selected, onTrack = false }) {
  const canvasRef = useRef(null)
  const laneRef = useRef(null)
  const boxRef = useRef(null)
  const [width, setWidth] = useState(0)
  const [pending, setPending] = useState(0)
  const [drag, setDrag] = useState(null)
  // Bumped when a soundtrack finishes decoding, to redraw with its waveform.
  const [sound, setSound] = useState(0)
  const playing = useStore((s) => s.playing)
  const setTime = useStore((s) => s.setTime)
  const setPlaying = useStore((s) => s.setPlaying)
  const select = useStore((s) => s.select)
  const slideClip = useStore((s) => s.slideClip)
  const setClipTrack = useStore((s) => s.setClipTrack)
  const setSnapAt = useStore((s) => s.setSnapAt)
  const trimClip = useStore((s) => s.trimClip)

  const win = stripWindow(layer, asset, duration)

  // The overlap with the clip before this one, if there is one — this clip is
  // the arriving half, which is the half a transition belongs to.
  //
  // Returned as a string rather than an object: this is a zustand selector, and
  // a fresh object every call compares unequal every call, which is a render
  // loop rather than a subscription.
  const lap = useStore((st) => {
    if (!layer.clip) return ''
    const p = pairsIn(st.doc.layers, (l) => getAsset(l.assetId))
      .find((x) => x.inId === layer.id)
    return p ? `${p.kind}|${Math.round(p.length)}` : ''
  })

  // Decoding is normally deferred to the first press of play, but a waveform is
  // wanted before that — it is how you find the moment to cut on. Asked for once
  // per asset; `ensureAudio` is idempotent and answers instantly when it is
  // already done or when the file has no sound at all.
  useEffect(() => {
    if (!asset?.isVideo || asset.audio !== undefined) return
    let live = true
    ensureAudio(asset).then(() => { if (live) setSound((n) => n + 1) })
    return () => { live = false }
  }, [asset])

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

    const slots = stripTimes(layer, asset, width, duration, THUMB_H, win)

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

    // Drawn over the thumbnails rather than in a row of its own: the clip is one
    // object, and a separate lane would put its picture and its sound in two
    // places that have to be kept lined up by eye.
    const drawWave = () => {
      // The clip's own span in source time, not the thumbnail sample centres —
      // those sit half a slot inside each end, which shifts the whole picture.
      const cols = columnsFor(
        asset,
        assetTimeFor(layer, win.from, asset),
        assetTimeFor(layer, win.to, asset),
        Math.max(1, Math.round(width)),
      )
      if (!cols) return
      const h = 16
      const base = THUMB_H - 1
      ctx.save()
      // A solid-enough scrim: footage is often bright and busy, and a pale wave
      // over a test pattern or a snowy landscape is invisible without one.
      ctx.fillStyle = 'rgba(0, 0, 0, 0.62)'
      ctx.fillRect(0, THUMB_H - h - 2, width, h + 2)
      ctx.fillStyle = 'rgba(120, 226, 255, 1)'
      for (let x = 0; x < cols.length; x++) {
        // A floor of one pixel, so a quiet passage reads as quiet rather than as
        // a gap where the file stopped.
        const v = Math.max(1, cols[x] * h)
        ctx.fillRect(x, base - v, 1, v)
      }
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
      drawWave()
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
      // After the pictures, so it is not painted over by the last of them.
      if (!cancelled) drawWave()
    })()
    return () => { cancelled = true }
  }, [
    width, duration, playing, asset, layer.id, layer.speed, layer.timeOffset,
    // Re-slice when the clip moves or is trimmed: the thumbnails are what the
    // clip plays, so they have to follow it.
    win.from, win.to,
    // And redraw once the soundtrack has been decoded.
    sound,
  ])

  /** The lane this clip is measured against — its own when standing alone, the
   *  track's when it shares one with other clips. */
  const laneEl = () => (onTrack ? boxRef.current?.closest('.track-lane') : laneRef.current)

  /**
   * Slide, trim, or move between tracks. Which one is decided at pointerdown
   * and held for the whole gesture.
   *
   * Deciding per move instead would let a fast drag that leaves the edge zone
   * silently turn a trim into a slide.
   */
  const scrub = (e) => {
    const r = (laneEl() || laneRef.current).getBoundingClientRect()
    setTime(Math.max(0, Math.min(duration, ((e.clientX - r.left) / r.width) * duration)))
  }

  const grabClip = (e) => {
    if (e.button !== 0 || !win.clipped) return false
    const bar = boxRef.current.getBoundingClientRect()
    const lane = laneEl().getBoundingClientRect()
    const near = e.clientX - bar.left
    const mode = near <= EDGE_PX ? 'start'
      : near >= bar.width - EDGE_PX ? 'end'
        : 'move'
    e.stopPropagation()
    e.preventDefault()
    setPlaying(false)
    select([layer.id])
    // For a slide, remember where in the bar it was grabbed — otherwise the clip
    // jumps so its start lands under the cursor on the first move.
    const grabOffset = (near / lane.width) * duration
    setDrag(mode)

    // The highest track this drag may reach, fixed now rather than recomputed as
    // it goes. Moving onto the empty row creates that track, which puts a *new*
    // empty row above it — under the pointer, which then creates another. One
    // upward drag could spawn tracks without limit. Capturing the ceiling at the
    // start means a drag can promote a clip by exactly one track, however far
    // the pointer travels.
    const ceiling = trackCount(useStore.getState().doc.layers)

    // Edges to line up with, gathered once: they cannot change during the drag,
    // since the only clip moving is this one.
    const st0 = useStore.getState()
    const points = snapPoints(st0.doc.layers, (x) => getAsset(x.assetId), layer.id, [st0.time])
    // A fixed number of *pixels*, converted to time — so it feels the same
    // whether the project is four seconds or four minutes long.
    const tol = (SNAP_PX / Math.max(1, lane.width)) * duration
    const length = clipRange(layer, asset).length

    let moved = false
    const move = (ev) => {
      const t = Math.max(0, ((ev.clientX - lane.left) / lane.width) * duration)
      if (mode === 'move') {
        const snapped = snapClip(Math.max(0, t - grabOffset), length, points, tol)
        setSnapAt(snapped.at)
        slideClip(layer.id, snapped.start, { commit: !moved })
        // Dragging up or down moves the clip between tracks. No modifier and no
        // mode: the row the pointer is over is the row you meant, which is the
        // whole gesture. Read from the document rather than tracked in state,
        // so it works however the rows happen to be laid out.
        if (onTrack) {
          const row = document.elementFromPoint(ev.clientX, ev.clientY)?.closest('.track-row')
          const to = row ? Number(row.dataset.track) : null
          if (to != null && Number.isFinite(to)) {
            setClipTrack(layer.id, Math.min(to, ceiling), { commit: false })
          }
        }
      } else {
        const snapped = snapEdge(t, points, tol)
        setSnapAt(snapped.at)
        trimClip(layer.id, mode, snapped.value, { commit: !moved })
      }
      moved = true
    }
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      window.removeEventListener('pointercancel', up)
      setDrag(null)
      // The guide belongs to the gesture, not to the arrangement.
      setSnapAt(null)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    window.addEventListener('pointercancel', up)
    return true
  }

  const pct = duration ? Math.min(100, (time / duration) * 100) : 0
  const label = win.clipped
    ? `${layer.name} — ${(win.from / 1000).toFixed(2)}s to ${(win.to / 1000).toFixed(2)}s`
      + ' · drag to move, ends to trim, up or down to change track'
    : 'Drag to scrub'

  const clipEl = (
    <div
      className={'strip' + (win.clipped ? ' clip' : '') + (drag ? ' dragging' : '')
        + (selected ? ' sel' : '')}
      ref={boxRef}
      title={label}
      style={win.clipped
        ? { left: `${win.left * 100}%`, width: `${win.width * 100}%` }
        : undefined}
      onPointerDown={(e) => {
        if (grabClip(e)) return
        if (e.button !== 0) return
        setPlaying(false)
        select([layer.id])
        scrub(e)
      }}
    >
      <canvas ref={canvasRef} style={{ width: '100%', height: THUMB_H }} />
      {/* On a track the row's label names the track, not the clip, so without
          this there is nothing on screen saying which file a clip is. */}
      {win.clipped && <span className="clip-title">{layer.name}</span>}
      {lap && (() => {
        const [kind, ms] = lap.split('|')
        const len = clipRange(layer, asset).length || 1
        const label = TRANSITIONS.find((t) => t.id === kind)?.label || kind
        return (
          <span
            className="clip-transition"
            style={{ width: `${Math.min(100, (Number(ms) / len) * 100)}%` }}
            title={`${label}, ${(Number(ms) / 1000).toFixed(2)}s — drag the clips apart to shorten it`}
          />
        )
      })()}
      {win.clipped && <span className="clip-grip start" />}
      {win.clipped && <span className="clip-grip end" />}
      {pending > 0 && <span className="strip-pending">{pending} left</span>}
    </div>
  )

  // On a track the row supplies the lane, the label and the playhead, because
  // several clips share them. Alone, this component supplies its own.
  if (onTrack) return clipEl

  return (
    <div className={'strip-row' + (selected ? ' sel' : '')}>
      <span className="strip-name" title={layer.name}>{layer.name}</span>
      <div
        className="strip-lane"
        ref={laneRef}
        onPointerDown={(e) => {
          // Empty lane space scrubs; the clip itself is grabbed by its own
          // handler below and never reaches here.
          if (e.button !== 0) return
          e.currentTarget.setPointerCapture(e.pointerId)
          setPlaying(false)
          scrub(e)
        }}
        onPointerMove={(e) => { if (e.buttons === 1 && !drag) scrub(e) }}
      >
        {clipEl}
        <div className="strip-playhead" style={{ left: `${pct}%` }} />
      </div>
      <span className="strip-meta">
        {win.clipped
          ? `${((win.to - win.from) / 1000).toFixed(2)}s`
          : `${asset.isVideo ? 'MP4' : 'GIF'} · ${asset.frames.length}f · ${(asset.duration / 1000).toFixed(1)}s`}
      </span>
    </div>
  )
}
