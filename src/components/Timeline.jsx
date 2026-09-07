import { useEffect, useRef, useState } from 'react'
import { useStore } from '../state/store.js'
import { getAsset } from '../engine/assets.js'
import { hasTracks, activeGroups, groupKeyTimes, keyTimeNear } from '../engine/keyframes.js'
import { stripLayers } from '../engine/filmstrip.js'
import Filmstrip from './Filmstrip.jsx'
import { clipRange } from '../engine/clips.js'

/**
 * One property's keyframes, as diamonds on a track.
 *
 * Dragging a diamond retimes it. Dragging one that is part of a multi-selection
 * moves the whole selection by the same offset, so a run of keys keeps its
 * spacing instead of collapsing onto a single time.
 */
function KeyLane({ layer, group, duration, time }) {
  const select = useStore((s) => s.select)
  const setTime = useStore((s) => s.setTime)
  const setPlaying = useStore((s) => s.setPlaying)
  const selectKey = useStore((s) => s.selectKey)
  const addKeyframe = useStore((s) => s.addKeyframe)
  const removeKeyframe = useStore((s) => s.removeKeyframe)
  const moveKeyframe = useStore((s) => s.moveKeyframe)
  const disableTrack = useStore((s) => s.disableTrack)
  const keySelection = useStore((s) => s.keySelection)
  const moveSelectedKeys = useStore((s) => s.moveSelectedKeys)
  const selectKeys = useStore((s) => s.selectKeys)
  const dragRef = useRef(null)
  const laneRef = useRef(null)

  const times = groupKeyTimes(layer, group.id)
  const atPlayhead = keyTimeNear(times, time)

  const timeAt = (e) => {
    const r = laneRef.current.getBoundingClientRect()
    return Math.max(0, Math.min(duration, ((e.clientX - r.left) / r.width) * duration))
  }

  useEffect(() => {
    const move = (e) => {
      const d = dragRef.current
      if (!d) return
      const t = timeAt(e)
      if (!d.moved && Math.abs(t - d.from) < 4) return
      if (d.many) {
        // A whole selection slides together, by the offset the grabbed key
        // moved — so their spacing is kept rather than collapsed onto one time.
        moveSelectedKeys(t - d.from, { commit: !d.moved })
      } else {
        moveKeyframe(layer.id, group.id, d.from, t, { commit: !d.moved })
      }
      d.from = Math.max(0, Math.round(t))
      d.moved = true
      setTime(d.from)
    }
    const up = () => { dragRef.current = null }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    window.addEventListener('pointercancel', up)
    return () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      window.removeEventListener('pointercancel', up)
    }
  }, [layer.id, group.id, duration, moveKeyframe, moveSelectedKeys, setTime])

  return (
    <div className="key-lane">
      <span className="lane-name">{group.label}</span>

      <div
        className="lane-track"
        ref={laneRef}
        data-layer={layer.id}
        data-group={group.id}
        title="Drag to scrub · double-click to add a key"
        onDoubleClick={(e) => { setPlaying(false); addKeyframe(layer.id, group.id, timeAt(e)) }}
        onPointerDown={(e) => {
          if (e.button !== 0 || e.target.classList.contains('kf')) return
          setPlaying(false)
          select([layer.id])
        }}
      >
        <div className="lane-line" />
        {times.map((t) => {
          const isSel = keySelection.some((k) => k.layerId === layer.id
            && k.groupId === group.id && k.t === t)
          return (
            <button
              key={t}
              className={'kf' + (Math.abs(t - time) <= 8 ? ' current' : '') + (isSel ? ' sel' : '')}
              style={{ left: `${duration ? (t / duration) * 100 : 0}%` }}
              title={`${(t / 1000).toFixed(2)}s — drag to retime, right-click to delete`}
              onContextMenu={(e) => { e.preventDefault(); removeKeyframe(layer.id, group.id, t) }}
              onPointerDown={(e) => {
                if (e.button !== 0) return
                e.stopPropagation()
                setPlaying(false)
                select([layer.id])
                const me = { layerId: layer.id, groupId: group.id, t }
                const already = keySelection.some((k) => k.layerId === layer.id
                  && k.groupId === group.id && k.t === t)
                if (e.shiftKey || e.ctrlKey || e.metaKey) {
                  selectKeys(already
                    ? keySelection.filter((k) => !(k.layerId === layer.id
                      && k.groupId === group.id && k.t === t))
                    : [...keySelection, me])
                } else if (!already) {
                  // Grabbing a key outside the selection starts a new one;
                  // grabbing one inside it keeps the group so it can be dragged.
                  selectKey(me)
                }
                setTime(t)
                dragRef.current = {
                  mode: 'key',
                  from: t,
                  moved: false,
                  many: already || e.shiftKey || e.ctrlKey || e.metaKey,
                }
              }}
            />
          )
        })}
        <div className="lane-playhead" style={{ left: `${duration ? (time / duration) * 100 : 0}%` }} />
      </div>

      <div className="lane-actions">
        <button
          title={atPlayhead !== null ? 'Update key at playhead' : 'Add key at playhead'}
          className={atPlayhead !== null ? 'on' : ''}
          onClick={() => addKeyframe(layer.id, group.id, time)}
        >◆</button>
        <button
          title="Delete key at playhead"
          disabled={atPlayhead === null}
          onClick={() => atPlayhead !== null && removeKeyframe(layer.id, group.id, atPlayhead)}
        >−</button>
        <button
          title={`Stop animating ${group.label.toLowerCase()}`}
          onClick={() => disableTrack(layer.id, group.id)}
        >✕</button>
      </div>
    </div>
  )
}

/** How close to an edge counts as grabbing it rather than the clip body. */
const EDGE_PX = 9

/**
 * One clip on the timeline: a bar you can slide, and whose ends you can drag.
 *
 * The whole gesture is decided at pointerdown — body or which edge — and held
 * for the duration of the drag. Deciding per move instead would let a fast drag
 * that leaves the edge zone silently turn a trim into a slide.
 */
function ClipBar({ layer, asset, duration, selected }) {
  const slideClip = useStore((s) => s.slideClip)
  const trimClip = useStore((s) => s.trimClip)
  const select = useStore((s) => s.select)
  const setPlaying = useStore((s) => s.setPlaying)
  const trackRef = useRef(null)
  const [drag, setDrag] = useState(null)

  const range = clipRange(layer, asset)
  const left = duration ? (range.start / duration) * 100 : 0
  const width = duration ? Math.max(0.4, (range.length / duration) * 100) : 0

  const begin = (e) => {
    if (e.button !== 0) return
    e.stopPropagation()
    e.preventDefault()
    setPlaying(false)
    select([layer.id])

    const bar = e.currentTarget.getBoundingClientRect()
    // The *track*, not the row: the row includes the name column, and measuring
    // that puts every computed time out by its width.
    const row = trackRef.current.getBoundingClientRect()
    const near = e.clientX - bar.left
    const mode = near <= EDGE_PX ? 'start'
      : near >= bar.width - EDGE_PX ? 'end'
        : 'move'
    // For a slide, remember where in the bar it was grabbed — otherwise the clip
    // jumps so its start lands under the cursor on the first move.
    const grabOffset = (near / row.width) * duration
    setDrag(mode)

    const timeAt = (ev) =>
      Math.max(0, ((ev.clientX - row.left) / row.width) * duration)

    let moved = false
    const move = (ev) => {
      const t = timeAt(ev)
      if (mode === 'move') slideClip(layer.id, t - grabOffset, { commit: !moved })
      else trimClip(layer.id, mode, t, { commit: !moved })
      moved = true
    }
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      setDrag(null)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  return (
    <div className="clip-row">
      <span className="clip-name">{layer.name}</span>
      <div className="clip-track" ref={trackRef}>
        <div
          className={'clip' + (selected ? ' sel' : '') + (drag ? ' dragging' : '')}
          style={{ left: left + '%', width: width + '%' }}
          onPointerDown={begin}
          title={`${(range.start / 1000).toFixed(2)}s to ${(range.end / 1000).toFixed(2)}s`}
        >
          <span className="clip-grip start" />
          <span className="clip-label">{(range.length / 1000).toFixed(2)}s</span>
          <span className="clip-grip end" />
        </div>
      </div>
    </div>
  )
}

export default function Timeline() {
  const [tab, setTab] = useState('keys')
  const duration = useStore((s) => s.duration)
  const time = useStore((s) => s.time)
  const playing = useStore((s) => s.playing)
  const setPlaying = useStore((s) => s.setPlaying)
  const setTime = useStore((s) => s.setTime)
  const layers = useStore((s) => s.doc.layers)
  const trackRef = useRef(null)

  const lanesRef = useRef(null)
  const [marquee, setMarquee] = useState(null)
  const keysInRange = useStore((s) => s.keysInRange)
  const selectKeys = useStore((s) => s.selectKeys)
  const clearKeySelection = useStore((s) => s.clearKeySelection)
  const removeSelectedKeys = useStore((s) => s.removeSelectedKeys)
  const keyCount = useStore((s) => s.keySelection.length)

  /**
   * Rubber-band selection across the lanes.
   *
   * Dragging selects; a click without movement still moves the playhead, which
   * is what a lane click did before. Scrubbing by dragging lives on the bar at
   * the top, where a time ruler belongs — a lane that both scrubs and selects
   * on the same gesture can only guess which was meant.
   */
  const startMarquee = (e) => {
    if (e.button !== 0) return
    // Anything with its own handler — a keyframe, a lane button — deals with it.
    if (e.target.closest('.kf, .lane-actions, .lane-name')) return
    // Without this the drag also selects the lane labels as text, and the *next*
    // drag then starts on top of that selection — which Chrome reads as a native
    // text drag and answers with pointercancel, killing the band mid-gesture.
    e.preventDefault()
    const host = lanesRef.current
    const box = host.getBoundingClientRect()
    const start = {
      x0: e.clientX - box.left + host.scrollLeft,
      y0: e.clientY - box.top + host.scrollTop,
    }
    let live = null
    const additive = e.shiftKey || e.ctrlKey || e.metaKey
    const before = useStore.getState().keySelection

    const move = (ev) => {
      const x1 = ev.clientX - box.left + host.scrollLeft
      const y1 = ev.clientY - box.top + host.scrollTop
      if (!live && Math.hypot(x1 - start.x0, y1 - start.y0) < 4) return
      live = { ...start, x1, y1 }
      setMarquee(live)

      // Which lanes the band touches, and the time span it covers in each. Every
      // lane shares the same time axis, so one span answers for all of them.
      const lanes = []
      let from = 0
      let to = 0
      for (const el of host.querySelectorAll('.lane-track')) {
        const r = el.getBoundingClientRect()
        const top = r.top - box.top + host.scrollTop
        const bottom = top + r.height
        if (bottom < Math.min(live.y0, live.y1) || top > Math.max(live.y0, live.y1)) continue
        lanes.push({ layerId: el.dataset.layer, groupId: el.dataset.group })
        const left = r.left - box.left + host.scrollLeft
        const span = (x) => ((x - left) / r.width) * duration
        from = span(Math.min(live.x0, live.x1))
        to = span(Math.max(live.x0, live.x1))
      }
      const hits = lanes.length ? keysInRange(from, to, lanes) : []
      selectKeys(additive ? [...before, ...hits.filter((h) => !before.some((b) => b.layerId === h.layerId
        && b.groupId === h.groupId && b.t === h.t))] : hits)
    }

    const up = (ev) => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      window.removeEventListener('pointercancel', up)
      setMarquee(null)
      if (!live) {
        // A click, not a drag: clear the selection and move the playhead, which
        // is what clicking empty lane space used to do.
        if (!additive) clearKeySelection()
        const track = ev.target.closest('.lane-track')
        if (track) {
          const r = track.getBoundingClientRect()
          setTime(Math.max(0, Math.min(duration, ((ev.clientX - r.left) / r.width) * duration)))
        }
      }
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    // A cancelled pointer never sends `up`. Ending on it keeps whatever the band
    // had reached rather than leaving the marquee painted on screen forever.
    window.addEventListener('pointercancel', up)
    setPlaying(false)
  }

  // Delete removes the whole selection, so a run of keys goes in one step.
  useEffect(() => {
    const onKey = (e) => {
      if (e.key !== 'Delete' && e.key !== 'Backspace') return
      if (e.target.matches('input, textarea')) return
      if (!useStore.getState().keySelection.length) return
      e.preventDefault()
      removeSelectedKeys()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [removeSelectedKeys])

  const keyed = layers.filter(hasTracks)
  const strips = stripLayers({ layers })
  const selectedIds = useStore((s) => s.selectedIds)
  const makeClip = useStore((s) => s.makeClip)
  const splitClips = useStore((s) => s.splitClips)
  const closeClipGaps = useStore((s) => s.closeClipGaps)
  const clipped = layers.filter((l) => l.clip)
  // Anything with media behind it can become a clip. Layers are not clipped on
  // import: an overlay on a looping GIF wants to be visible throughout, and that
  // is what every project made before clips existed assumes.
  const clippable = layers.filter((l) => !l.clip && l.type === 'image' && getAsset(l.assetId))

  const volume = useStore((s) => s.volume)
  const muted = useStore((s) => s.muted)
  const setVolume = useStore((s) => s.setVolume)
  const toggleMuted = useStore((s) => s.toggleMuted)
  // Shown only when the project could actually make a sound — a volume slider
  // over a project of GIFs is a control that does nothing. `undefined` means the
  // soundtrack has not been decoded yet, which is not the same as "no sound".
  const soundy = layers.some((l) => {
    const a = getAsset(l.assetId)
    return a?.isVideo && (a.audio || a.audio === undefined)
  })

  if (duration <= 0 && !keyed.length) return null

  const animated = layers.filter((l) => l.type === 'image' && getAsset(l.assetId)?.animated)
  const frames = animated.reduce((n, l) => n + (getAsset(l.assetId)?.frames.length || 0), 0)
  const pct = duration ? Math.min(100, (time / duration) * 100) : 0

  // Scrubbing is driven from the whole row, not just the 26px bar — a thin
  // target right next to the canvas is easy to miss.
  const scrub = (e) => {
    const r = trackRef.current.getBoundingClientRect()
    const t = ((e.clientX - r.left) / r.width) * duration
    setTime(Math.max(0, Math.min(duration, t)))
  }

  return (
    <div className="timeline">
      <div
        className="tl-main"
        onPointerDown={(e) => {
          if (e.button !== 0 || e.target.closest('.play')) return
          e.currentTarget.setPointerCapture(e.pointerId)
          setPlaying(false)
          scrub(e)
        }}
        onPointerMove={(e) => { if (e.buttons === 1 && !e.target.closest('.play')) scrub(e) }}
      >
        <button className="play" onClick={() => setPlaying(!playing)} title="Play / pause (Space)">
          {playing ? '❚❚' : '▶'}
        </button>
        <div className="track" ref={trackRef}>
          {animated.map((l) => {
            const a = getAsset(l.assetId)
            const sp = l.speed || 1
            return (
              <div key={l.id} className="ticks">
                {a.cum.map((c, i) => {
                  const t = (l.timeOffset || 0) + (i ? a.cum[i - 1] : 0) / sp
                  if (t > duration) return null
                  return <i key={i} style={{ left: `${(t / duration) * 100}%` }} />
                })}
              </div>
            )
          })}
          <div className="played" style={{ width: `${pct}%` }} />
          <div className="playhead" style={{ left: `${pct}%` }} />
        </div>
        {soundy && (
          <div className="tl-audio">
            <button
              className={'mute' + (muted ? ' on' : '')}
              onClick={toggleMuted}
              title={muted ? 'Unmute' : 'Mute'}
            >
              {muted ? '🔇' : '🔊'}
            </button>
            <input
              className="vol"
              type="range"
              min="0"
              max="100"
              value={Math.round(volume * 100)}
              onChange={(e) => setVolume(Number(e.target.value) / 100)}
              title="Volume"
            />
          </div>
        )}
        <div className="tl-readout">
          {(time / 1000).toFixed(2)}s / {(duration / 1000).toFixed(2)}s
          {frames > 0 && <span className="dim"> · {frames} frames</span>}
        </div>
      </div>

      {(keyed.length > 0 || strips.length > 0) && (
        <div className="tl-tabs">
          <button
            className={tab === 'keys' ? 'on' : ''}
            onClick={() => setTab('keys')}
          >
            Keyframes{keyed.length > 0 && <span className="dim"> {keyed.length}</span>}
            {keyCount > 1 && <span className="dim"> · {keyCount} selected</span>}
          </button>
          <button
            className={tab === 'video' ? 'on' : ''}
            disabled={!strips.length}
            onClick={() => setTab('video')}
            title={strips.length ? 'Thumbnails for every clip on the timeline' : 'No clips on the timeline'}
          >
            Video{strips.length > 0 && <span className="dim"> {strips.length}</span>}
          </button>
        </div>
      )}

      {tab === 'keys' && keyed.length > 0 && (
        <div className="lanes" ref={lanesRef} onPointerDown={startMarquee}>
          {marquee && (
            <div
              className="key-marquee"
              style={{
                left: Math.min(marquee.x0, marquee.x1),
                top: Math.min(marquee.y0, marquee.y1),
                width: Math.abs(marquee.x1 - marquee.x0),
                height: Math.abs(marquee.y1 - marquee.y0),
              }}
            />
          )}
          {keyed.map((l) => (
            <div className="lane-group" key={l.id}>
              <div className="lane-layer">{l.name}</div>
              {activeGroups(l).map((g) => (
                <KeyLane key={g.id} layer={l} group={g} duration={duration} time={time} />
              ))}
            </div>
          ))}
        </div>
      )}

      {tab === 'keys' && !keyed.length && strips.length > 0 && (
        <p className="tl-empty">
          Nothing is animated yet. Turn on animation for a property in the inspector,
          or switch to Video to see the clips.
        </p>
      )}

      {tab === 'video' && (
        <div className="strips">
          <div className="clip-bar-tools">
            <button
              className="btn ghost"
              disabled={!clippable.length}
              onClick={() => clippable.forEach((l) => makeClip(l.id, 0))}
              title="Turn these layers into clips that can be cut and trimmed"
            >
              {clippable.length > 1 ? `Make ${clippable.length} clips` : 'Make a clip'}
            </button>
            <button
              className="btn ghost"
              disabled={!clipped.length}
              onClick={() => splitClips()}
              title="Cut every clip the playhead is inside (Ctrl+K)"
            >
              Cut at playhead
            </button>
            <button
              className="btn ghost"
              disabled={clipped.length < 2}
              onClick={() => closeClipGaps()}
              title="Lay the clips end to end, closing the gaps between them"
            >
              Close gaps
            </button>
          </div>
          {clipped.map((l) => (
            <ClipBar
              key={'clip-' + l.id}
              layer={l}
              asset={getAsset(l.assetId)}
              duration={duration}
              selected={selectedIds.includes(l.id)}
            />
          ))}
          {strips.map(({ layer, asset }) => (
            <Filmstrip
              key={layer.id}
              layer={layer}
              asset={asset}
              duration={duration}
              time={time}
            />
          ))}
        </div>
      )}
    </div>
  )
}
