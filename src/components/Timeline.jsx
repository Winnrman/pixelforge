import { useCallback, useEffect, useRef, useState } from 'react'
import { useStore } from '../state/store.js'
import { getAsset } from '../engine/assets.js'
import { hasTracks, activeGroups, groupKeyTimes, keyTimeNear } from '../engine/keyframes.js'
import { stripLayers } from '../engine/filmstrip.js'
import Filmstrip from './Filmstrip.jsx'
import AudioRows from './AudioRow.jsx'
import { byTrack, trackCount } from '../engine/clips.js'

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

/** How tall the timeline opens at, as a fraction of the editor column. Editing
 *  is what the panel is for, so it gets the room; the canvas is a preview of the
 *  thing being edited, not the thing itself. */
const DEFAULT_SHARE = 0.52
const MIN_H = 120

/** Things on the transport bar that are controls in their own right, and must
 *  not be read as "scrub to here". */
const CONTROLS = '.play, .tl-audio, .tl-readout'

export default function Timeline() {
  const [tab, setTab] = useState('keys')
  // Remembered across sessions, because how much room you want depends on what
  // you are doing and it is annoying to set twice.
  const [height, setHeight] = useState(() => {
    const saved = Number(localStorage.getItem('pf-timeline-h'))
    return Number.isFinite(saved) && saved >= MIN_H ? saved : 0
  })
  const heightRef = useRef(height)
  heightRef.current = height
  const rootRef = useRef(null)
  const obsRef = useRef(null)
  // The column's height, measured rather than read off a ref during render.
  //
  // A callback ref rather than a mount effect, because this component returns
  // null until the document has something worth showing — so on mount there is
  // no node, an effect with an empty dependency list finds nothing, and it never
  // runs again once content does arrive.
  const [colH, setColH] = useState(0)
  const attachRoot = useCallback((node) => {
    rootRef.current = node
    obsRef.current?.disconnect()
    obsRef.current = null
    const parent = node?.parentElement
    if (!parent) return
    const ro = new ResizeObserver(([e]) => setColH(Math.round(e.contentRect.height)))
    ro.observe(parent)
    obsRef.current = ro
    setColH(Math.round(parent.getBoundingClientRect().height))
  }, [])
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
  const splitClips = useStore((s) => s.splitClips)
  const closeClipGaps = useStore((s) => s.closeClipGaps)
  const joinClips = useStore((s) => s.joinClips)
  const setNotice = useStore((s) => s.setNotice)
  const clipped = layers.filter((l) => l.clip)
  const insertClip = useStore((s) => s.insertClip)
  const [dropTrack, setDropTrack] = useState(null)
  const snapAt = useStore((s) => s.snapAt)
  // One row per track, front-most first, plus one empty row above the top so a
  // new track is made by using it rather than by pressing anything.
  const used = clipped.length ? byTrack(layers) : []
  // With nothing on the timeline at all, one empty row is the invitation. Two —
  // a drop row and an empty track under it — is just a confusing gap.
  const dropRow = { track: clipped.length ? trackCount(layers) : 0, clips: [], empty: true }
  // Animated media that is not a clip still gets its old full-width strip: an
  // overlay on a looping GIF is not on a track and should not pretend to be.
  const loose = strips.filter(({ layer }) => !layer.clip)

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

  // Only the editing panes are worth giving height to. With neither open the
  // timeline is just the transport bar and should stay out of the way.
  const expandable = (tab === 'keys' && keyed.length > 0)
    || (tab === 'video' && strips.length > 0)
  // A dragged height wins; otherwise a share of the column. Undefined until the
  // column has been measured, so the panel opens at its natural size rather
  // than flashing a guessed one.
  const shown = expandable && (height || colH)
    ? Math.max(MIN_H, Math.min(height || Math.round(colH * DEFAULT_SHARE), colH - 140))
    : undefined

  const startResize = (e) => {
    if (e.button !== 0) return
    e.preventDefault()
    const parent = rootRef.current.parentElement
    const box = parent.getBoundingClientRect()
    const move = (ev) => {
      // Leave room for the canvas: a timeline that can swallow the whole
      // viewport is a timeline you cannot drag back.
      const next = Math.max(MIN_H, Math.min(box.height - 140, box.bottom - ev.clientY))
      setHeight(next)
    }
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      window.removeEventListener('pointercancel', up)
      try { localStorage.setItem('pf-timeline-h', String(heightRef.current)) } catch { /* private mode */ }
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    window.addEventListener('pointercancel', up)
  }

  /** One track row: its label, its lane, and the clips that live on it. */
  const renderRow = (row) => (
    <div
      className={'track-row' + (row.empty ? ' empty' : '') + (dropTrack === row.track ? ' over' : '')}
      key={row.track}
      data-track={row.track}
      onDragOver={(e) => { e.preventDefault(); setDropTrack(row.track) }}
      onDragLeave={() => setDropTrack((t) => (t === row.track ? null : t))}
      onDrop={(e) => {
        e.preventDefault()
        setDropTrack(null)
        const assetId = e.dataTransfer.getData('application/x-pixelforge-asset')
        if (!assetId) return
        // Dropped where the pointer is, so the gesture places it.
        const lane = e.currentTarget.querySelector('.track-lane')
        const r = lane.getBoundingClientRect()
        const at = Math.max(0, ((e.clientX - r.left) / r.width) * duration)
        insertClip(assetId, { track: row.track, at })
      }}
    >
      <span className="track-name">
        {row.empty ? '' : `Track ${row.track + 1}`}
      </span>
      <div className="track-lane">
        {row.clips.map((l) => (
          <Filmstrip
            key={l.id}
            layer={l}
            asset={getAsset(l.assetId)}
            duration={duration}
            time={time}
            selected={selectedIds.includes(l.id)}
            onTrack
          />
        ))}
        {row.empty && (
          <span className="track-hint">Drag media here to add a clip</span>
        )}
        {/* No playhead on the empty row: there is nothing there for it
            to be the position of, and a line across a drop target reads
            as something already in it. */}
        {!row.empty && <div className="track-playhead" style={{ left: `${pct}%` }} />}
      </div>
    </div>
  )

  return (
    <div
      className={'timeline' + (expandable ? ' tall' : '')}
      ref={attachRoot}
      style={shown ? { height: shown } : undefined}
    >
      {expandable && (
        <div className="tl-split" title="Drag to resize" onPointerDown={startResize} />
      )}
      <div
        className="tl-main"
        // The whole bar scrubs, so that clicking the space around the track
        // works as well as the track itself — but the *controls* on that bar are
        // not the bar. Only the play button was excluded, which meant dragging
        // the volume slider also scrubbed the playhead to wherever the pointer
        // happened to be along the window: turning the sound down jumped the
        // video, usually to the end, because the slider lives at the right-hand
        // side. Changing the volume must not move the picture, ever.
        onPointerDown={(e) => {
          if (e.button !== 0 || e.target.closest(CONTROLS)) return
          e.currentTarget.setPointerCapture(e.pointerId)
          setPlaying(false)
          scrub(e)
        }}
        onPointerMove={(e) => {
          if (e.buttons === 1 && !e.target.closest(CONTROLS)) scrub(e)
        }}
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
        <div className="strips tracks">
          <div className="clip-bar-tools">
            <button
              className="btn ghost"
              disabled={!clipped.length}
              onClick={() => splitClips()}
              title="Cut every clip the playhead is inside (Ctrl+K)"
            >
              Cut at playhead
            </button>
            {/* The inverse of Cut. Shift-click the pieces on the timeline, then
                this — there is nothing else to learn, and it refuses out loud
                when what is selected is not one clip in pieces. */}
            <button
              className="btn ghost"
              disabled={selectedIds.length < 2}
              onClick={() => {
                const res = joinClips()
                setNotice(res.ok
                  ? { kind: 'ok', text: res.text }
                  : { kind: 'warn', text: res.reason })
              }}
              title={selectedIds.length < 2
                ? 'Shift-click two or more pieces of one clip to join them'
                : 'Put the selected pieces back together as one clip'}
            >
              Join
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
          {renderRow(dropRow)}
          <div className="track-rows">
            {snapAt != null && duration > 0 && (
              <div
                className="snap-guide"
                style={{
                  left: `calc(var(--track-label) + (100% - var(--track-label)) * ${snapAt / duration})`,
                }}
              />
            )}
            {used.map((row) => renderRow(row))}
            {/* Sound gets its own rows under the pictures. It used to be a
                number in the inspector and a shape drawn behind the thumbnails,
                which makes "bring this down while she is talking" a thing you
                cannot do at all. */}
            <AudioRows duration={duration} />
          </div>
          {loose.length > 0 && (
            <p className="tl-note">
              Not on a track — these play for the whole project and loop.
              Drag one onto a track to cut it.
            </p>
          )}
          {loose.map(({ layer, asset }) => (
            <Filmstrip
              key={layer.id}
              layer={layer}
              asset={asset}
              duration={duration}
              time={time}
              selected={selectedIds.includes(layer.id)}
            />
          ))}
        </div>
      )}
    </div>
  )
}
