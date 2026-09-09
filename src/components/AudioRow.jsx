import { useEffect, useRef, useState } from 'react'
import { useStore } from '../state/store.js'
import { getAsset } from '../engine/assets.js'
import { clipRange, assetTimeFor, sourceRange, audioRange } from '../engine/clips.js'
import { columnsFor, hasPeaks } from '../engine/waveform.js'
import { ensureAudio } from '../engine/audio.js'
import { trackOf, valueAt } from '../engine/keyframes.js'

export const AUDIO_H = 56

/** The loudest a point may be dragged: a little above normal, not enough to
 *  clip everything to mush. */
const MAX_VOL = 2

/** Volume to a height in the lane, and back. Half height is normal, so "put it
 *  back where it was" is the middle rather than a number to remember. */
const yFor = (v, h) => h - (Math.max(0, Math.min(MAX_VOL, v)) / MAX_VOL) * h
const volFor = (y, h) => Math.max(0, Math.min(MAX_VOL, ((h - y) / h) * MAX_VOL))

/** Somewhere along a lane, as a document time. */
function scrubTo(e, duration, setTime) {
  const r = e.currentTarget.getBoundingClientRect()
  const t = ((e.clientX - r.left) / Math.max(1, r.width)) * duration
  setTime(Math.max(0, Math.min(duration, t)))
}

/**
 * One clip's sound, on its own lane.
 *
 * The waveform was drawn inside the video clip, behind the thumbnails, which is
 * enough to see that there *is* sound and no use for doing anything to it: there
 * is nowhere to put a point, and anything drawn over the pictures fights them.
 * On its own lane the whole height is the volume, so a point has somewhere to be
 * and the line between points is the shape of the fade you are drawing.
 */
function AudioClip({ layer, duration }) {
  const canvasRef = useRef(null)
  const boxRef = useRef(null)
  const asset = getAsset(layer.assetId)
  // Decoding sound is asynchronous and finishing it is not a store change, so
  // without this the lane renders once, finds no peaks, and never looks again.
  const [ready, setReady] = useState(() => !!asset?.audio)
  const time = useStore((s) => s.time)
  const select = useStore((s) => s.select)
  const selected = useStore((s) => s.selectedIds.includes(layer.id))
  const setPoint = useStore((s) => s.setVolumePoint)
  const removePoint = useStore((s) => s.removeVolumePoint)
  const setAudioEdge = useStore((s) => s.setAudioEdge)
  const setContextMenu = useStore((s) => s.setContextMenu)
  // Subscribed as a string so the lane repaints when a point moves: an array
  // would be a new reference every render and never compare equal.
  const keySig = useStore((s) => {
    const l = s.doc.layers.find((x) => x.id === layer.id)
    return (trackOf(l, 'volume') || []).map((k) => `${Math.round(k.t)}:${k.v.toFixed(3)}`).join(',')
  })

  // The sound's own span, which reaches past the picture wherever a J or an L
  // cut has been made.
  const range = audioRange(layer, asset)
  const pic = clipRange(layer, asset)
  const left = duration ? (range.start / duration) * 100 : 0
  const width = duration ? (range.length / duration) * 100 : 0
  // Where the picture sits inside it, so the part that is sound-only is visible
  // as such rather than looking like the clip is simply longer.
  const picLeft = range.length ? ((pic.start - range.start) / range.length) * 100 : 0
  const picRight = range.length ? ((range.end - pic.end) / range.length) * 100 : 0
  const keys = trackOf(useStore.getState().doc.layers.find((x) => x.id === layer.id), 'volume')

  // The waveform.
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      if (!asset?.audio) { try { await ensureAudio(asset) } catch { /* no sound */ } }
      if (cancelled) return
      // `hasPeaks` only answers once the peaks have actually been built, and
      // building them is what `columnsFor` does. What decides whether there is a
      // lane at all is whether there is a buffer.
      setReady(!!asset?.audio)
      const canvas = canvasRef.current
      if (!canvas) return
      const box = canvas.getBoundingClientRect()
      const w = Math.max(1, Math.round(box.width))
      const dpr = Math.min(2, window.devicePixelRatio || 1)
      canvas.width = Math.round(w * dpr)
      canvas.height = Math.round(AUDIO_H * dpr)
      const ctx = canvas.getContext('2d')
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      ctx.clearRect(0, 0, w, AUDIO_H)
      // The clip's own span in source time, the same window the filmstrip uses,
      // so the wave under the pictures and the wave on the lane are the same
      // sound at the same place.
      // Measured from the picture's own mapping and then pushed out by the
      // lead and trail: `assetTimeFor` answers for times inside the clip, and
      // these are the times outside it.
      const speed = Math.abs(layer.speed || 1) || 1
      const from = assetTimeFor(layer, pic.start, asset) - range.lead * speed
      const to = assetTimeFor(layer, pic.end, asset) + range.trail * speed
      const peak = columnsFor(asset, from, to, w, 'peak')
      const body = columnsFor(asset, from, to, w, 'rms')
      if (!peak) return

      // Two shapes, not one. The peak envelope alone is what everything mastered
      // in the last thirty years looks like: compressed hard enough that it
      // touches the ceiling from end to end, so it draws as a solid block that
      // says nothing about where the words are. The body — root mean square — is
      // the loudness you actually hear, and drawn solid inside the faint outline
      // of the peaks it gives both the reach of the sound and the weight of it.
      ctx.fillStyle = 'rgba(150, 232, 255, 0.28)'
      for (let i = 0; i < peak.length; i++) {
        const h = Math.max(1, peak[i] * (AUDIO_H - 8))
        ctx.fillRect(i, (AUDIO_H - h) / 2, 1, h)
      }
      if (body) {
        ctx.fillStyle = 'rgba(150, 232, 255, 0.95)'
        for (let i = 0; i < body.length; i++) {
          const h = Math.max(1, body[i] * (AUDIO_H - 8))
          ctx.fillRect(i, (AUDIO_H - h) / 2, 1, h)
        }
      }
    })()
    return () => { cancelled = true }
  }, [asset, layer.clip?.in, layer.clip?.out, layer.speed, width, ready,
    layer.audio?.lead, layer.audio?.trail])

  // A clip whose media turned out to have no sound at all keeps no lane: an
  // empty row of nothing is worse than no row.
  if (!ready) return null

  /** A pointer position inside the lane, as a document time and a volume. */
  const readPoint = (e) => {
    const box = boxRef.current.getBoundingClientRect()
    const x = Math.max(0, Math.min(box.width, e.clientX - box.left))
    const y = Math.max(0, Math.min(box.height, e.clientY - box.top))
    return {
      t: range.start + (x / Math.max(1, box.width)) * range.length,
      v: volFor(y, box.height),
    }
  }

  const dragKey = (e, at, { committed = false } = {}) => {
    e.preventDefault()
    e.stopPropagation()
    select([layer.id])
    let from = at
    let first = !committed
    const move = (ev) => {
      const p = readPoint(ev)
      // One action per move rather than a remove and an add, so the whole drag
      // is one entry in the history instead of one per pointer event.
      setPoint(layer.id, p.t, p.v, { from, commit: first })
      first = false
      from = p.t
    }
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  const dragEdge = (e, edge) => {
    if (e.button !== 0) return
    e.preventDefault()
    e.stopPropagation()
    select([layer.id])
    // Measured against the lane rather than the clip, because the clip is the
    // thing being resized and its own box moves as the drag goes on.
    const lane = boxRef.current.parentElement.getBoundingClientRect()
    let first = true
    const move = (ev) => {
      const t = ((ev.clientX - lane.left) / Math.max(1, lane.width)) * duration
      setAudioEdge(layer.id, edge, t, { commit: first })
      first = false
    }
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  const level = keys.length ? valueAt(layer, 'volume', time) : (layer.volume ?? 1)

  return (
    <div
      className={'audio-clip' + (selected ? ' sel' : '') + (layer.muted ? ' muted' : '')}
      ref={boxRef}
      style={{ left: `${left}%`, width: `${width}%` }}
      title={`${layer.name} — click the line to add a volume point, drag one to move it,`
        + ' double-click one to take it away'}
      onContextMenu={(e) => {
        e.preventDefault()
        e.stopPropagation()
        if (!selected) select([layer.id])
        setContextMenu({ x: e.clientX, y: e.clientY, layerId: layer.id })
      }}
      onPointerDown={(e) => {
        if (e.button !== 0) return
        // Anywhere on the lane that is not already a point adds one there. No
        // mode, no modifier: the line is the control.
        e.stopPropagation()
        const p = readPoint(e)
        select([layer.id])
        setPoint(layer.id, p.t, p.v)
        dragKey(e, p.t, { committed: true })
      }}
    >
      <canvas ref={canvasRef} style={{ width: '100%', height: AUDIO_H }} />
      {/* The stretch of sound with no picture over it, shaded — otherwise a J
          cut just looks like a clip that is longer than the one above it. */}
      {picLeft > 0.05 && <span className="audio-only" style={{ left: 0, width: `${picLeft}%` }} />}
      {picRight > 0.05 && <span className="audio-only" style={{ right: 0, width: `${picRight}%` }} />}
      <span className="audio-name">{layer.name}</span>
      {/* Drag either end past the picture and you have made the cut. No mode to
          enter, nothing to detach first: the sound already has two ends and this
          is what moving them means. */}
      <span
        className={'audio-grip start' + (range.lead > 0 ? ' out' : '')}
        title={range.lead > 0
          ? `Sound starts ${(range.lead / 1000).toFixed(2)}s before the picture — a J cut.`
            + ' Drag back to line them up.'
          : 'Drag left to start the sound before the picture — a J cut'}
        onPointerDown={(e) => dragEdge(e, 'lead')}
      />
      <span
        className={'audio-grip end' + (range.trail > 0 ? ' out' : '')}
        title={range.trail > 0
          ? `Sound runs ${(range.trail / 1000).toFixed(2)}s past the picture — an L cut.`
            + ' Drag back to line them up.'
          : 'Drag right to carry the sound past the picture — an L cut'}
        onPointerDown={(e) => dragEdge(e, 'trail')}
      />

      {/* The line, and the points on it. Drawn over the waveform rather than
          beside it, because what you are shaping is that sound. */}
      <svg className="audio-curve" viewBox={`0 0 100 ${AUDIO_H}`} preserveAspectRatio="none">
        <polyline
          points={(() => {
            // No points yet: a flat line at whatever the layer's volume is, so
            // there is always something to click on.
            if (!keys.length) {
              const y = yFor(layer.volume ?? 1, AUDIO_H)
              return `0,${y} 100,${y}`
            }
            const at = (k) => (range.length ? ((k.t - range.start) / range.length) * 100 : 0)
            const first = keys[0]
            const last = keys[keys.length - 1]
            // Held flat out to both edges, because that is what the sound
            // actually does — a line that starts at the first point suggests the
            // clip is silent before it, and it is not.
            return [
              `0,${yFor(first.v, AUDIO_H)}`,
              ...keys.map((k) => `${at(k)},${yFor(k.v, AUDIO_H)}`),
              `100,${yFor(last.v, AUDIO_H)}`,
            ].join(' ')
          })()}
        />
      </svg>
      {keys.map((k) => {
        const x = range.length ? ((k.t - range.start) / range.length) * 100 : 0
        return (
          <span
            key={k.t}
            className="audio-point"
            style={{ left: `${x}%`, top: yFor(k.v, AUDIO_H) }}
            title={`${(k.v * 100).toFixed(0)}% at ${(k.t / 1000).toFixed(2)}s`}
            onPointerDown={(e) => dragKey(e, k.t)}
            onDoubleClick={(e) => {
              e.stopPropagation()
              removePoint(layer.id, k.t)
            }}
          />
        )
      })}
      <span className="audio-level" title="Volume at the playhead">
        {Math.round((level ?? 1) * 100)}%
      </span>
      <span hidden data-keysig={keySig} />
    </div>
  )
}

/**
 * The audio rows, under the video ones.
 *
 * Sound used to be a number in the inspector and a shape drawn behind the
 * pictures on the video track, which makes "bring this down while she is
 * talking" a thing you cannot do at all. One row per video track, so the lanes
 * line up with the clips they belong to.
 */
export default function AudioRows({ duration }) {
  const layers = useStore((s) => s.doc.layers)
  const setTime = useStore((s) => s.setTime)
  const setPlaying = useStore((s) => s.setPlaying)
  // Whether the press that began this drag landed on empty lane, rather than on
  // a clip whose volume line is being dragged along it.
  const scrubbing = useRef(false)
  // Whether a clip has sound is not known until its soundtrack has been looked
  // at, and looking is asynchronous and not a store change. Without this a
  // silent video keeps an empty lane for ever, because nothing ever re-renders
  // to notice the answer came back "none".
  const [, settled] = useState(0)
  useEffect(() => {
    let live = true
    for (const l of layers) {
      const a = getAsset(l.assetId)
      if (!l.clip || !a?.isVideo || a.audio !== undefined) continue
      ensureAudio(a).then(() => { if (live) settled((n) => n + 1) })
    }
    return () => { live = false }
  }, [layers])
  // Being a video is not the same as having sound in it. `audio === undefined`
  // means nobody has looked yet, which is worth a lane because one is probably
  // coming; `audio === null` means it was looked at and there is none, and a
  // permanently empty row for a silent clip is a row of nothing.
  const withSound = layers.filter((l) => {
    if (!l.clip) return false
    const a = getAsset(l.assetId)
    if (!a?.isVideo) return false
    return a.audio !== null && a.audio !== false
  })
  if (!withSound.length) return null

  const tracks = [...new Set(withSound.map((l) => l.track || 0))].sort((a, b) => a - b)

  return (
    <>
      {tracks.map((t) => (
        <div className="audio-row" key={t} data-audio-track={t}>
          <span className="track-name">A{t + 1}</span>
          <div
            className="audio-lane"
            style={{ height: AUDIO_H }}
            // Empty lane is a spot in time, the same as an empty stretch of
            // video track. A clip's own lane is its volume line and deals with
            // its own presses.
            onPointerDown={(e) => {
              if (e.button !== 0 || e.target.closest('.audio-clip')) return
              e.currentTarget.setPointerCapture(e.pointerId)
              scrubbing.current = true
              setPlaying(false)
              scrubTo(e, duration, setTime)
            }}
            onPointerMove={(e) => {
              if (e.buttons === 1 && scrubbing.current) scrubTo(e, duration, setTime)
            }}
            onPointerUp={() => { scrubbing.current = false }}
            onPointerCancel={() => { scrubbing.current = false }}
          >
            {withSound.filter((l) => (l.track || 0) === t).map((l) => (
              <AudioClip key={l.id} layer={l} duration={duration} />
            ))}
          </div>
        </div>
      ))}
    </>
  )
}
