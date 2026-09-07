import { useEffect, useRef, useState } from 'react'
import { useStore, makeEffectLayer, makeShapeLayer, makeTextLayer } from '../state/store.js'
import { uiFlags } from '../state/uiFlags.js'
import { renderDocument, primeVideo } from '../engine/render.js'
import { docToLayer } from '../engine/erase.js'
import { deliverPick, pickRestore, cancelPick } from '../state/picker.js'
import {
  currentTime as audioTime, play as playAudio, stop as stopAudio, isPlaying as audioPlaying,
} from '../engine/audio.js'
import { getAsset } from '../engine/assets.js'
import { fontFor } from '../engine/render.js'
import {
  addShapePath, corners, hitTest, layerCenter, toLocal, fromLocal, visibleBox, isCropped,
} from '../engine/shapes.js'
import { resolveLayer, hasTracks, trackOf, groupKeyTimes, valueAt } from '../engine/keyframes.js'
import { resolveGroups, isGroup } from '../engine/groups.js'
import { snapRect, unionBox, SNAP_TOLERANCE } from '../engine/snap.js'

const HANDLES = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w']

// The eyedropper's loupe: how big the glass is on screen, and how many document
// pixels across it shows. Odd, so there is a true centre pixel to outline.
const LOUPE_R = 62
const LOUPE_N = 15

// Transform handles belong to the move tool. While a drawing tool is armed a
// press must start a new shape, even on top of a selected layer's handle —
// otherwise picking the pixelate tool and dragging silently resizes whatever
// happened to be selected.
const DRAWS_ON_DRAG = new Set(['effect', 'shape', 'lasso', 'text', 'erase'])
const usesHandles = (tool) => !DRAWS_ON_DRAG.has(tool)
const HANDLE_SIZE = 9
const MIN_SIZE = 8

const CURSORS = {
  nw: 'nwse-resize', se: 'nwse-resize',
  ne: 'nesw-resize', sw: 'nesw-resize',
  n: 'ns-resize', s: 'ns-resize',
  e: 'ew-resize', w: 'ew-resize',
  rot: 'grab',
}

let checkerPattern = null
function getChecker(ctx) {
  if (checkerPattern) return checkerPattern
  const c = document.createElement('canvas')
  c.width = c.height = 16
  const g = c.getContext('2d')
  g.fillStyle = '#2a2a31'
  g.fillRect(0, 0, 16, 16)
  g.fillStyle = '#232329'
  g.fillRect(0, 0, 8, 8)
  g.fillRect(8, 8, 8, 8)
  checkerPattern = ctx.createPattern(c, 'repeat')
  return checkerPattern
}

function handlePoints(l) {
  const c = corners(l)
  const mid = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 })
  return {
    nw: c[0], ne: c[1], se: c[2], sw: c[3],
    n: mid(c[0], c[1]), e: mid(c[1], c[2]), s: mid(c[2], c[3]), w: mid(c[3], c[0]),
  }
}

function resizeBox(l0, key, p, { shift, alt }) {
  let left = -l0.w / 2
  let right = l0.w / 2
  let top = -l0.h / 2
  let bottom = l0.h / 2

  if (key.includes('w')) left = p.x
  if (key.includes('e')) right = p.x
  if (key.includes('n')) top = p.y
  if (key.includes('s')) bottom = p.y

  const isCorner = key.length === 2
  if (shift && isCorner && l0.h !== 0) {
    const aspect = Math.abs(l0.w / l0.h)
    let w = right - left
    let h = bottom - top
    if (Math.abs(w) / Math.max(1e-6, Math.abs(h)) > aspect) {
      h = Math.sign(h || 1) * (Math.abs(w) / aspect)
      if (key.includes('n')) top = bottom - h
      else bottom = top + h
    } else {
      w = Math.sign(w || 1) * Math.abs(h) * aspect
      if (key.includes('w')) left = right - w
      else right = left + w
    }
  }

  if (alt) {
    if (key.includes('w')) right = -left
    if (key.includes('e')) left = -right
    if (key.includes('n')) bottom = -top
    if (key.includes('s')) top = -bottom
  }

  let w = right - left
  let h = bottom - top
  if (Math.abs(w) < MIN_SIZE) { w = MIN_SIZE; right = left + w }
  if (Math.abs(h) < MIN_SIZE) { h = MIN_SIZE; bottom = top + h }

  const c = fromLocal(l0, (left + right) / 2, (top + bottom) / 2)
  return { x: c.x - Math.abs(w) / 2, y: c.y - Math.abs(h) / 2, w: Math.abs(w), h: Math.abs(h) }
}

export default function CanvasStage() {
  const [editing, setEditing] = useState(null)
  // The render loop runs outside React, so it reads the id from a ref.
  const editingRef = useRef(null)
  const wrapRef = useRef(null)
  const canvasRef = useRef(null)
  const docCanvasRef = useRef(null)
  const drag = useRef(null)
  const cropRef = useRef(null)
  const hoverRef = useRef(null)
  const spaceRef = useRef(false)
  const rectRef = useRef(null)
  const fitRef = useRef(null)
  // In-progress lasso lives in a ref so plotting points does not re-render the
  // app 60 times a second; it is committed to the store once the outline closes.
  const lassoRef = useRef(null)
  const guidesRef = useRef([])
  // Exposed so the snapping test can read the guides mid-drag.
  if (import.meta.env.DEV) window.__pfSnapGuides = () => guidesRef.current
  const cursorRef = useRef(null)
  const loupeRef = useRef(null)

  if (!docCanvasRef.current) docCanvasRef.current = document.createElement('canvas')

  const tool = useStore((s) => s.tool)
  const view = useStore((s) => s.view)
  const docSize = useStore((s) => `${s.doc.width}x${s.doc.height}`)

  // ---- sizing -----------------------------------------------------------
  useEffect(() => {
    const wrap = wrapRef.current
    const canvas = canvasRef.current
    const resize = () => {
      const dpr = Math.min(2, window.devicePixelRatio || 1)
      const r = wrap.getBoundingClientRect()
      canvas.width = Math.max(1, Math.round(r.width * dpr))
      canvas.height = Math.max(1, Math.round(r.height * dpr))
      canvas.style.width = r.width + 'px'
      canvas.style.height = r.height + 'px'
      canvas._dpr = dpr
      canvas._css = { w: r.width, h: r.height }
    }
    resize()
    const ro = new ResizeObserver(() => {
      resize()
      // The timeline grows as keyframe lanes appear. Re-fit so the document is
      // never left clipped underneath it — unless the user has taken manual
      // control of the view, in which case leave their framing alone.
      if (useStore.getState().view.fitted) fitRef.current?.()
    })
    ro.observe(wrap)
    return () => ro.disconnect()
  }, [])

  // ---- fit to view ------------------------------------------------------
  const fit = () => {
    const wrap = wrapRef.current
    if (!wrap) return
    const { doc } = useStore.getState()
    const r = wrap.getBoundingClientRect()
    const pad = 64
    const zoom = Math.min(
      (r.width - pad) / doc.width,
      (r.height - pad) / doc.height,
      4,
    )
    useStore.getState().setView({
      zoom: Math.max(0.02, zoom),
      panX: (r.width - doc.width * zoom) / 2,
      panY: (r.height - doc.height * zoom) / 2,
      fitted: true,
    })
  }
  fitRef.current = fit

  useEffect(() => { fit() }, [docSize, view.fitRequest])

  const seekRef = useRef(0)
  // Watches whether the audio clock is actually moving.
  // Watches whether the audio clock is actually moving. `last` starts null
  // rather than 0, because 0 is also a perfectly good reading at the start of
  // playback and the two must not be confused.
  const audioStallRef = useRef({ last: null, since: 0, gaveUp: false })

  /**
   * Starts the sound from a document time, if there is any.
   *
   * Fire and forget: decoding happens on the first press, and a project with no
   * sound simply carries on with the render loop keeping its own time.
   */
  const startAudio = (fromMs) => {
    // Record where we cued to, so the seek watcher below does not read the jump
    // it just caused as a scrub and re-cue on top of it.
    seekRef.current = fromMs
    // A new cue gets a clean slate: the previous run giving up says nothing
    // about this one.
    audioStallRef.current = { last: null, since: 0, gaveUp: false }
    const st = useStore.getState()
    st.loadSound().then((any) => {
      if (!any) return
      const now = useStore.getState()
      if (!now.playing) return
      playAudio(now.doc, (l) => getAsset(l.assetId), fromMs, {
        master: now.volume, muted: now.muted,
      })
    })
  }

  // Sound follows the transport. Scrubbing while paused is silent on purpose —
  // scrub audio is a different feature and a bad default.
  const playing = useStore((s) => s.playing)
  const time = useStore((s) => s.time)
  const timeRef = useRef(time)
  timeRef.current = time
  useEffect(() => {
    if (playing) startAudio(timeRef.current)
    else stopAudio()
    return () => stopAudio()
  }, [playing])

  // Seeking while playing has to re-cue the sound: its sources were scheduled
  // from where playback began and cannot simply be moved.
  useEffect(() => {
    if (!playing || !audioPlaying()) { seekRef.current = time; return }
    if (Math.abs(time - seekRef.current) > 250) startAudio(time)
    seekRef.current = time
  }, [time, playing])

  // ---- render loop ------------------------------------------------------
  useEffect(() => {
    let raf = 0
    let last = performance.now()

    const loop = (now) => {
      raf = requestAnimationFrame(loop)
      const dt = now - last
      last = now
      const st = useStore.getState()
      const { doc } = st

      if (st.playing && st.duration > 0) {
        // While sound is playing, the audio clock decides where we are. Adding
        // up animation-frame deltas separately drifts against it, and a picture
        // sliding out of sync with speech is worse than a dropped frame — which
        // nobody can see anyway.
        // An audio clock that is not advancing must not be allowed to hold the
        // playhead still. A context can fail to start on a machine with no
        // output device, or sit suspended, and "audio is the clock" then means
        // playback silently freezes while claiming to play.
        //
        // Giving up is permanent for the rest of this run, deliberately. An
        // unreliable clock that recovers for a moment is worse than one that
        // never worked: it is behind by then, and following it again drags the
        // playhead backwards, so the two clocks fight and time crawls.
        const stall = audioStallRef.current
        const rawAudio = stall.gaveUp ? null : audioTime()
        if (rawAudio == null) {
          stall.last = null
        } else if (stall.last == null || Math.abs(rawAudio - stall.last) > 0.5) {
          stall.last = rawAudio
          stall.since = now
        } else if (now - stall.since > 300) {
          stall.gaveUp = true
        }
        const fromAudio = stall.gaveUp ? null : rawAudio
        if (fromAudio != null) {
          if (fromAudio >= st.duration) {
            // Round the loop: the audio has to be restarted, not merely rewound,
            // because its sources were scheduled for one pass.
            st.setTime(0)
            startAudio(0)
          } else {
            st.setTime(fromAudio)
          }
        } else {
          st.setTime((st.time + dt) % st.duration)
        }
      }
      const time = useStore.getState().time

      const dc = docCanvasRef.current
      if (dc.width !== doc.width || dc.height !== doc.height) {
        dc.width = doc.width
        dc.height = doc.height
      }
      primeVideo(doc, time)
      // While a text layer is being edited in place the textarea *is* the text.
      // Drawing the layer as well shows it twice, a pixel or two apart, which
      // reads as a duplicate layer. Only the preview is affected — an export
      // renders the document as it really is.
      const shown = editingRef.current
        ? { ...doc, layers: doc.layers.map((l) => (l.id === editingRef.current ? { ...l, visible: false } : l)) }
        : doc
      renderDocument(dc.getContext('2d'), shown, time)

      const canvas = canvasRef.current
      if (!canvas) return
      const ctx = canvas.getContext('2d')
      const dpr = canvas._dpr || 1
      const css = canvas._css || { w: 0, h: 0 }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      ctx.clearRect(0, 0, css.w, css.h)

      const { zoom, panX, panY } = st.view
      const sw = doc.width * zoom
      const sh = doc.height * zoom

      // Document surface
      ctx.save()
      ctx.beginPath()
      ctx.rect(panX, panY, sw, sh)
      ctx.clip()
      ctx.fillStyle = getChecker(ctx)
      ctx.fillRect(panX, panY, sw, sh)
      ctx.imageSmoothingEnabled = zoom < 2
      ctx.drawImage(dc, panX, panY, sw, sh)
      ctx.restore()

      ctx.strokeStyle = 'rgba(255,255,255,0.16)'
      ctx.lineWidth = 1
      ctx.strokeRect(panX - 0.5, panY - 0.5, sw + 1, sh + 1)

      drawOverlay(ctx, st, { zoom, panX, panY, sw, sh })
    }

    raf = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(raf)
  }, [])

  /**
   * The brush ring.
   *
   * Erasing without one is guesswork — the brush is a fraction of the *layer*
   * width, so the same setting is a different number of pixels on every layer
   * and there is no way to know what you are about to remove. The ring is sized
   * against whichever layer the stroke would land on.
   */
  function drawBrush(ctx, st, v) {
    const p = cursorRef.current
    if (!p) return
    const target = st.eraseTarget(p[0], p[1])
    const brush = st.toolOptions.brush || {}
    const layer = target ? resolveLayer(target, st.time) : null
    // With no layer under the cursor there is nothing to erase, so the ring is
    // shown hollow and dim rather than hidden — a disappearing cursor is worse
    // than one that says "not here".
    const r = layer
      ? (Math.max(0.002, brush.size ?? 0.06) * Math.abs(layer.w) * v.zoom) / 2
      : 12
    const x = v.panX + p[0] * v.zoom
    const y = v.panY + p[1] * v.zoom
    const restore = brush.mode === 'restore'

    ctx.save()
    ctx.beginPath()
    ctx.arc(x, y, Math.max(2, r), 0, Math.PI * 2)
    // Dark under light, so it reads on any image.
    ctx.lineWidth = 3
    ctx.strokeStyle = 'rgba(0,0,0,0.55)'
    ctx.stroke()
    ctx.lineWidth = 1.5
    ctx.setLineDash(layer ? [] : [4, 4])
    ctx.strokeStyle = restore ? '#4ade80' : '#fff'
    ctx.globalAlpha = layer ? 1 : 0.5
    ctx.stroke()
    ctx.setLineDash([])
    // A centre dot, because a large soft brush has no obvious middle.
    if (r > 14) {
      ctx.globalAlpha = layer ? 0.8 : 0.4
      ctx.beginPath()
      ctx.arc(x, y, 1.5, 0, Math.PI * 2)
      ctx.fillStyle = restore ? '#4ade80' : '#fff'
      ctx.fill()
    }
    ctx.restore()
  }

  /**
   * The eyedropper's loupe.
   *
   * Sampling is per-pixel but the cursor is not: at anything under a 4x zoom a
   * single document pixel is smaller than the crosshair sitting on top of it, so
   * picking the exact pixel you mean is guesswork — you find out what you got
   * only after you have got it. The loupe shows the neighbourhood magnified with
   * the pixel that would be taken outlined in the middle, which turns the pick
   * from a guess into a read.
   *
   * The block is pulled straight from the composited document canvas, the same
   * surface and the same rounding a click samples, so what the loupe shows and
   * what lands in the swatch cannot disagree.
   */
  function drawLoupe(ctx, st, v) {
    const p = cursorRef.current
    const dc = docCanvasRef.current
    if (!p || !dc) return
    const cx = Math.round(p[0])
    const cy = Math.round(p[1])
    const half = (LOUPE_N - 1) / 2

    let block
    try {
      block = dc.getContext('2d', { willReadFrequently: true })
        .getImageData(cx - half, cy - half, LOUPE_N, LOUPE_N)
    } catch { return }

    // Out of bounds reads back transparent, which is the truth — there is
    // nothing there to pick — so the loupe stays up and shows the edge of the
    // picture rather than blinking out at the border.
    const inside = cx >= 0 && cy >= 0 && cx < dc.width && cy < dc.height
    const at = (half * LOUPE_N + half) * 4
    const hex = '#' + [block.data[at], block.data[at + 1], block.data[at + 2]]
      .map((n) => n.toString(16).padStart(2, '0')).join('')

    let sc = loupeRef.current
    if (!sc) {
      sc = document.createElement('canvas')
      sc.width = LOUPE_N
      sc.height = LOUPE_N
      loupeRef.current = sc
    }
    sc.getContext('2d').putImageData(block, 0, 0)

    const x = v.panX + p[0] * v.zoom
    const y = v.panY + p[1] * v.zoom
    const css = canvasRef.current?._css || { w: 0, h: 0 }
    // Up and to the right, flipping at the edges rather than sliding off them.
    const gap = 18 + LOUPE_R
    let lx = x + gap
    let ly = y - gap
    if (lx + LOUPE_R + 8 > css.w) lx = x - gap
    if (ly - LOUPE_R - 8 < 0) ly = y + gap
    if (ly + LOUPE_R + 30 > css.h) ly = y - gap

    const cell = (LOUPE_R * 2) / LOUPE_N

    ctx.save()
    ctx.beginPath()
    ctx.arc(lx, ly, LOUPE_R, 0, Math.PI * 2)
    ctx.save()
    ctx.clip()
    ctx.fillStyle = getChecker(ctx)
    ctx.fillRect(lx - LOUPE_R, ly - LOUPE_R, LOUPE_R * 2, LOUPE_R * 2)
    // Nearest-neighbour, because a smoothed magnifier would invent colours that
    // are not in the picture and cannot be picked.
    ctx.imageSmoothingEnabled = false
    ctx.drawImage(sc, lx - LOUPE_R, ly - LOUPE_R, LOUPE_R * 2, LOUPE_R * 2)

    // A grid, so the pixels read as pixels rather than as a blurry patch.
    ctx.strokeStyle = 'rgba(0,0,0,0.16)'
    ctx.lineWidth = 1
    ctx.beginPath()
    for (let i = 1; i < LOUPE_N; i++) {
      const o = Math.round(i * cell) + 0.5
      ctx.moveTo(lx - LOUPE_R + o, ly - LOUPE_R)
      ctx.lineTo(lx - LOUPE_R + o, ly + LOUPE_R)
      ctx.moveTo(lx - LOUPE_R, ly - LOUPE_R + o)
      ctx.lineTo(lx + LOUPE_R, ly - LOUPE_R + o)
    }
    ctx.stroke()

    // The pixel that would be taken. Dark under light, like the brush ring, so
    // it stays visible whatever colour it is sitting on.
    const bx = lx - LOUPE_R + half * cell
    const by = ly - LOUPE_R + half * cell
    ctx.lineWidth = 3
    ctx.strokeStyle = 'rgba(0,0,0,0.7)'
    ctx.strokeRect(bx - 0.5, by - 0.5, cell + 1, cell + 1)
    ctx.lineWidth = 1.5
    ctx.strokeStyle = '#fff'
    ctx.strokeRect(bx - 0.5, by - 0.5, cell + 1, cell + 1)
    ctx.restore()

    ctx.lineWidth = 3
    ctx.strokeStyle = 'rgba(0,0,0,0.5)'
    ctx.stroke()
    ctx.lineWidth = 1.5
    ctx.strokeStyle = 'rgba(255,255,255,0.85)'
    ctx.stroke()

    // The hex, on a pill under the glass — the number is the thing being chosen,
    // and reading it off the swatch afterwards is a step too late.
    if (inside) {
      const label = hex.toUpperCase()
      ctx.font = '600 12px ui-monospace, SFMono-Regular, Menlo, monospace'
      const tw = ctx.measureText(label).width
      const pw = tw + 34
      const px0 = lx - pw / 2
      const py0 = ly + LOUPE_R + 6
      ctx.fillStyle = 'rgba(12,12,14,0.86)'
      ctx.beginPath()
      ctx.roundRect(px0, py0, pw, 22, 11)
      ctx.fill()
      ctx.fillStyle = hex
      ctx.beginPath()
      ctx.roundRect(px0 + 5, py0 + 5, 12, 12, 3)
      ctx.fill()
      ctx.strokeStyle = 'rgba(255,255,255,0.35)'
      ctx.lineWidth = 1
      ctx.stroke()
      ctx.fillStyle = '#fff'
      ctx.textBaseline = 'middle'
      ctx.fillText(label, px0 + 23, py0 + 12)
    }
    ctx.restore()
  }

  function drawOverlay(ctx, st, v) {
    const { doc, selectedIds, tool } = st
    if (tool === 'erase') {
      drawBrush(ctx, st, v)
      return
    }
    if (tool === 'eyedrop') {
      drawLoupe(ctx, st, v)
      return
    }
    const sel = doc.layers
      .filter((l) => selectedIds.includes(l.id) && !isGroup(l))
      .map((l) => resolveLayer(l, st.time))

    if (tool === 'crop' && cropRef.current) {
      const c = cropRef.current
      const x = v.panX + c.x * v.zoom
      const y = v.panY + c.y * v.zoom
      const w = c.w * v.zoom
      const h = c.h * v.zoom
      ctx.save()
      ctx.fillStyle = 'rgba(8,8,10,0.62)'
      ctx.beginPath()
      ctx.rect(v.panX, v.panY, v.sw, v.sh)
      ctx.rect(x, y, w, h)
      ctx.fill('evenodd')
      ctx.strokeStyle = '#fff'
      ctx.lineWidth = 1.5
      ctx.strokeRect(x, y, w, h)
      ctx.strokeStyle = 'rgba(255,255,255,0.4)'
      ctx.lineWidth = 1
      for (let i = 1; i < 3; i++) {
        ctx.beginPath()
        ctx.moveTo(x + (w * i) / 3, y)
        ctx.lineTo(x + (w * i) / 3, y + h)
        ctx.moveTo(x, y + (h * i) / 3)
        ctx.lineTo(x + w, y + (h * i) / 3)
        ctx.stroke()
      }
      ctx.fillStyle = '#fff'
      for (const k of HANDLES) {
        const p = { nw: [x, y], n: [x + w / 2, y], ne: [x + w, y], e: [x + w, y + h / 2],
          se: [x + w, y + h], s: [x + w / 2, y + h], sw: [x, y + h], w: [x, y + h / 2] }[k]
        ctx.fillRect(p[0] - 4, p[1] - 4, 8, 8)
      }
      ctx.restore()
      return
    }

    drawGuides(ctx, v)
    drawLasso(ctx, st, v)

    if (!sel.length) return

    // Motion path: the trajectory of a keyframed layer's centre, with a dot per key.
    for (const raw of doc.layers) {
      if (!selectedIds.includes(raw.id) || !hasTracks(raw)) continue
      const times = [...new Set([
        ...groupKeyTimes(raw, 'position'),
        ...groupKeyTimes(raw, 'size'),
      ])].sort((a, b) => a - b)
      if (times.length < 2) continue
      const pts = times.map((t) => ({
        x: v.panX + (valueAt(raw, 'x', t) + valueAt(raw, 'w', t) / 2) * v.zoom,
        y: v.panY + (valueAt(raw, 'y', t) + valueAt(raw, 'h', t) / 2) * v.zoom,
      }))
      ctx.beginPath()
      ctx.moveTo(pts[0].x, pts[0].y)
      for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y)
      ctx.strokeStyle = 'rgba(255,204,51,0.55)'
      ctx.lineWidth = 1.5
      ctx.setLineDash([3, 4])
      ctx.stroke()
      ctx.setLineDash([])
      for (const q of pts) {
        ctx.beginPath()
        ctx.arc(q.x, q.y, 3.5, 0, Math.PI * 2)
        ctx.fillStyle = '#ffcc33'
        ctx.fill()
      }
    }

    for (const l of sel) {
      ctx.save()
      ctx.translate(v.panX, v.panY)
      ctx.scale(v.zoom, v.zoom)
      ctx.beginPath()
      if (l.type === 'effect' || l.type === 'shape') addShapePath(ctx, l)
      else {
        const c = corners(l)
        ctx.moveTo(c[0].x, c[0].y)
        for (let i = 1; i < 4; i++) ctx.lineTo(c[i].x, c[i].y)
        ctx.closePath()
      }
      ctx.restore()
      ctx.lineWidth = 1.5
      ctx.strokeStyle = l.type === 'effect' ? '#ffcc33' : '#4ea1ff'
      ctx.setLineDash(l.type === 'effect' ? [6, 4] : [])
      ctx.stroke()
      ctx.setLineDash([])

      // Crop insets shrink what is painted while the box stays put, so show the
      // visible region separately rather than letting the outline lie.
      if (l.type === 'image' && isCropped(l)) {
        const b = visibleBox(l)
        ctx.save()
        ctx.translate(v.panX, v.panY)
        ctx.scale(v.zoom, v.zoom)
        ctx.translate(layerCenter(l).x, layerCenter(l).y)
        if (l.rotation) ctx.rotate((l.rotation * Math.PI) / 180)
        ctx.beginPath()
        ctx.rect(b.x - layerCenter(l).x, b.y - layerCenter(l).y, b.w, b.h)
        ctx.restore()
        ctx.strokeStyle = 'rgba(78,161,255,0.95)'
        ctx.lineWidth = 1.5
        ctx.stroke()
      }

      // Bounding box for non-rect shapes so the handles read clearly.
      if (l.shape && l.shape !== 'rect') {
        const c = corners(l).map((p) => ({ x: v.panX + p.x * v.zoom, y: v.panY + p.y * v.zoom }))
        ctx.beginPath()
        ctx.moveTo(c[0].x, c[0].y)
        for (let i = 1; i < 4; i++) ctx.lineTo(c[i].x, c[i].y)
        ctx.closePath()
        ctx.strokeStyle = 'rgba(255,255,255,0.22)'
        ctx.lineWidth = 1
        ctx.stroke()
      }
    }

    if (sel.length !== 1 || !usesHandles(tool)) return
    const l = sel[0]
    if (l.locked) return
    const hp = handlePoints(l)
    const scr = (p) => ({ x: v.panX + p.x * v.zoom, y: v.panY + p.y * v.zoom })

    // rotation handle
    const n = scr(hp.n)
    const c = scr(layerCenter(l))
    const len = Math.hypot(n.x - c.x, n.y - c.y) || 1
    const rp = { x: n.x + ((n.x - c.x) / len) * 26, y: n.y + ((n.y - c.y) / len) * 26 }
    ctx.beginPath()
    ctx.moveTo(n.x, n.y)
    ctx.lineTo(rp.x, rp.y)
    ctx.strokeStyle = 'rgba(255,255,255,0.5)'
    ctx.lineWidth = 1
    ctx.stroke()
    ctx.beginPath()
    ctx.arc(rp.x, rp.y, 5, 0, Math.PI * 2)
    ctx.fillStyle = '#fff'
    ctx.fill()

    for (const k of HANDLES) {
      const p = scr(hp[k])
      ctx.fillStyle = '#fff'
      ctx.strokeStyle = 'rgba(0,0,0,0.55)'
      ctx.lineWidth = 1
      ctx.fillRect(p.x - HANDLE_SIZE / 2, p.y - HANDLE_SIZE / 2, HANDLE_SIZE, HANDLE_SIZE)
      ctx.strokeRect(p.x - HANDLE_SIZE / 2, p.y - HANDLE_SIZE / 2, HANDLE_SIZE, HANDLE_SIZE)
    }
  }

  function drawGuides(ctx, v) {
    const guides = guidesRef.current
    if (!guides.length) return
    ctx.save()
    ctx.lineWidth = 1
    for (const g of guides) {
      // Centre lines read differently from edge lines so it is obvious which
      // one a layer has landed on.
      ctx.strokeStyle = g.kind === 'center' ? '#ff2d78' : '#4ea1ff'
      ctx.setLineDash(g.kind === 'center' ? [] : [5, 4])
      ctx.beginPath()
      if (g.axis === 'x') {
        const x = Math.round(v.panX + g.at * v.zoom) + 0.5
        ctx.moveTo(x, v.panY - 16)
        ctx.lineTo(x, v.panY + v.sh + 16)
      } else {
        const y = Math.round(v.panY + g.at * v.zoom) + 0.5
        ctx.moveTo(v.panX - 16, y)
        ctx.lineTo(v.panX + v.sw + 16, y)
      }
      ctx.stroke()
    }
    ctx.restore()
    ctx.setLineDash([])
  }

  function drawLasso(ctx, st, v) {
    const live = lassoRef.current
    const committed = st.lasso
    const pts = live?.points?.length ? live.points : committed?.points
    if (!pts?.length) return

    const scr = (q) => ({ x: v.panX + q[0] * v.zoom, y: v.panY + q[1] * v.zoom })
    const a = scr(pts[0])

    ctx.beginPath()
    ctx.moveTo(a.x, a.y)
    for (let i = 1; i < pts.length; i++) {
      const q = scr(pts[i])
      ctx.lineTo(q.x, q.y)
    }
    if (live && cursorRef.current && !live.freehand) {
      const c = scr(cursorRef.current)
      ctx.lineTo(c.x, c.y)
    }
    if (!live) ctx.closePath()

    // Marching ants: a dark underlay with a moving light dash on top reads on
    // any image.
    ctx.lineWidth = 1.5
    ctx.setLineDash([])
    ctx.strokeStyle = 'rgba(0,0,0,0.75)'
    ctx.stroke()
    ctx.setLineDash([6, 6])
    ctx.lineDashOffset = live ? 0 : -(performance.now() / 60) % 12
    ctx.strokeStyle = '#fff'
    ctx.stroke()
    ctx.setLineDash([])
    ctx.lineDashOffset = 0

    if (!live) {
      // A closed outline is editable: solid dots move a point, hollow midpoints
      // insert one.
      if (st.tool !== 'lasso') return
      for (let i = 0; i < pts.length; i++) {
        const a2 = scr(pts[i])
        const b2 = scr(pts[(i + 1) % pts.length])
        const m = { x: (a2.x + b2.x) / 2, y: (a2.y + b2.y) / 2 }
        ctx.beginPath()
        ctx.arc(m.x, m.y, 3.5, 0, Math.PI * 2)
        ctx.fillStyle = 'rgba(12,12,16,0.85)'
        ctx.strokeStyle = 'rgba(255,255,255,0.75)'
        ctx.lineWidth = 1.2
        ctx.fill()
        ctx.stroke()
      }
      for (const q0 of pts) {
        const q = scr(q0)
        ctx.beginPath()
        ctx.arc(q.x, q.y, 4.5, 0, Math.PI * 2)
        ctx.fillStyle = '#fff'
        ctx.strokeStyle = 'rgba(0,0,0,0.65)'
        ctx.lineWidth = 1.2
        ctx.fill()
        ctx.stroke()
      }
      return
    }
    // Vertices, with the first one enlarged as the close target.
    for (let i = 0; i < pts.length; i++) {
      const q = scr(pts[i])
      ctx.beginPath()
      ctx.arc(q.x, q.y, i === 0 ? 5 : 3, 0, Math.PI * 2)
      ctx.fillStyle = i === 0 ? '#ffcc33' : '#fff'
      ctx.strokeStyle = 'rgba(0,0,0,0.6)'
      ctx.lineWidth = 1
      ctx.fill()
      ctx.stroke()
    }
  }

  /** Which part of a committed outline is under the pointer. */
  const lassoHandleAt = (p) => {
    const st = useStore.getState()
    const pts = st.lasso?.points
    if (!pts || st.tool !== 'lasso' || lassoRef.current) return null
    const z = st.view.zoom
    for (let i = 0; i < pts.length; i++) {
      if (Math.hypot(p.x - pts[i][0], p.y - pts[i][1]) * z < 8) return { kind: 'vertex', index: i }
    }
    for (let i = 0; i < pts.length; i++) {
      const a2 = pts[i]
      const b2 = pts[(i + 1) % pts.length]
      const mx = (a2[0] + b2[0]) / 2
      const my = (a2[1] + b2[1]) / 2
      if (Math.hypot(p.x - mx, p.y - my) * z < 7) return { kind: 'midpoint', index: i }
    }
    return null
  }

  const closeLasso = () => {
    const live = lassoRef.current
    if (!live || live.points.length < 3) {
      lassoRef.current = null
      return false
    }
    useStore.getState().setLasso({ points: live.points })
    lassoRef.current = null
    return true
  }

  const cancelLasso = () => {
    lassoRef.current = null
    useStore.getState().clearLasso()
  }

  // ---- crop lifecycle ---------------------------------------------------
  useEffect(() => {
    if (tool === 'crop') {
      const st = useStore.getState()
      // With an image selected the crop starts on *that image*, because
      // cropping a picture is what people come to a crop tool for. With nothing
      // selected it starts on the whole document, which is the other thing the
      // tool does. Starting on the thing it will act on is the only signal
      // needed — no mode to choose, nothing to read.
      const one = st.doc.layers.find(
        (l) => st.selectedIds.includes(l.id) && l.type === 'image' && !l.locked,
      )
      cropRef.current = one
        ? { x: one.x, y: one.y, w: Math.abs(one.w), h: Math.abs(one.h) }
        : { x: 0, y: 0, w: st.doc.width, h: st.doc.height }
    } else {
      cropRef.current = null
    }
  }, [tool, docSize])

  useEffect(() => {
    const onKey = (e) => {
      if (e.code === 'Space') spaceRef.current = e.type === 'keydown'
      if (tool === 'lasso' && e.type === 'keydown') {
        if (e.key === 'Enter') closeLasso()
        else if (e.key === 'Escape') cancelLasso()
        else if (e.key === 'Backspace' && lassoRef.current?.points.length) {
          lassoRef.current.points.pop()
        }
      }
      if (tool === 'eyedrop' && e.type === 'keydown' && e.key === 'Escape') {
        cancelPick()
        useStore.getState().setTool('move')
      }
      if (tool === 'crop' && e.type === 'keydown') {
        if (e.key === 'Enter' && cropRef.current) {
          const st = useStore.getState()
          const onLayer = st.doc.layers.some(
            (l) => st.selectedIds.includes(l.id) && l.type === 'image' && !l.locked,
          )
          if (onLayer) st.cropSelectedTo(cropRef.current)
          else st.applyCrop(cropRef.current)
          useStore.getState().setTool('move')
        } else if (e.key === 'Escape') {
          useStore.getState().setTool('move')
        }
      }
    }
    window.addEventListener('keydown', onKey)
    window.addEventListener('keyup', onKey)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('keyup', onKey)
    }
  }, [tool])

  // ---- pointer helpers --------------------------------------------------
  const toDoc = (e) => {
    // Pinned at pointer-down so a layout shift mid-gesture cannot warp the drag.
    const r = drag.current && rectRef.current
      ? rectRef.current
      : canvasRef.current.getBoundingClientRect()
    const { zoom, panX, panY } = useStore.getState().view
    return {
      x: (e.clientX - r.left - panX) / zoom,
      y: (e.clientY - r.top - panY) / zoom,
      sx: e.clientX - r.left,
      sy: e.clientY - r.top,
    }
  }

  const hitHandle = (p) => {
    const st = useStore.getState()
    if (!usesHandles(st.tool)) return null
    if (st.selectedIds.length !== 1) return null
    const base = st.doc.layers.find((x) => x.id === st.selectedIds[0])
    if (!base || base.locked || isGroup(base)) return null
    const l = resolveLayer(base, st.time)
    const v = st.view
    const scr = (q) => ({ x: v.panX + q.x * v.zoom, y: v.panY + q.y * v.zoom })
    const hp = handlePoints(l)
    const n = scr(hp.n)
    const c = scr(layerCenter(l))
    const len = Math.hypot(n.x - c.x, n.y - c.y) || 1
    const rp = { x: n.x + ((n.x - c.x) / len) * 26, y: n.y + ((n.y - c.y) / len) * 26 }
    if (Math.hypot(p.sx - rp.x, p.sy - rp.y) < 10) return { key: 'rot', layer: l }
    const tooNarrow = Math.abs(l.w) * v.zoom < 34
    const tooShort = Math.abs(l.h) * v.zoom < 34
    for (const k of HANDLES) {
      if (tooNarrow && (k === 'n' || k === 's')) continue
      if (tooShort && (k === 'e' || k === 'w')) continue
      if (tooNarrow && tooShort && k.length === 1) continue
      const q = scr(hp[k])
      if (Math.abs(p.sx - q.x) <= 7 && Math.abs(p.sy - q.y) <= 7) return { key: k, layer: l }
    }
    return null
  }

  const cropHandleAt = (p) => {
    const c = cropRef.current
    if (!c) return null
    const v = useStore.getState().view
    const x = v.panX + c.x * v.zoom
    const y = v.panY + c.y * v.zoom
    const w = c.w * v.zoom
    const h = c.h * v.zoom
    const pts = { nw: [x, y], n: [x + w / 2, y], ne: [x + w, y], e: [x + w, y + h / 2],
      se: [x + w, y + h], s: [x + w / 2, y + h], sw: [x, y + h], w: [x, y + h / 2] }
    for (const k of HANDLES) {
      if (Math.abs(p.sx - pts[k][0]) <= 7 && Math.abs(p.sy - pts[k][1]) <= 7) return k
    }
    if (p.sx > x && p.sx < x + w && p.sy > y && p.sy < y + h) return 'move'
    return null
  }

  const topLayerAt = (p) => {
    const st = useStore.getState()
    const groups = resolveGroups(st.doc.layers)
    for (let i = st.doc.layers.length - 1; i >= 0; i--) {
      const raw = st.doc.layers[i]
      if (isGroup(raw)) continue
      if (!groups.visible.get(raw.id) || groups.locked.get(raw.id)) continue
      const resolved = resolveLayer(raw, st.time)
      if (hitTest(resolved, p.x, p.y)) return resolved
    }
    return null
  }

  // ---- pointer events ---------------------------------------------------
  const onPointerDown = (e) => {
    rectRef.current = canvasRef.current.getBoundingClientRect()
    // Panning an empty checkerboard only strands it off-screen; the same reason
    // the wheel does not zoom one.
    if (!useStore.getState().doc.layers.length) {
      if (e.button === 1 || spaceRef.current || useStore.getState().tool === 'hand') return
    }
    if (e.button === 1 || spaceRef.current || useStore.getState().tool === 'hand') {
      const v = useStore.getState().view
      if (spaceRef.current) uiFlags.panned = true
      drag.current = { mode: 'pan', sx: e.clientX, sy: e.clientY, panX: v.panX, panY: v.panY }
      e.currentTarget.setPointerCapture(e.pointerId)
      return
    }
    if (e.button !== 0) return
    const st = useStore.getState()
    const p = toDoc(e)
    e.currentTarget.setPointerCapture(e.pointerId)

    if (st.tool === 'wand') {
      st.wandSelectAt(p.x, p.y)
      return
    }

    if (st.tool === 'eyedrop') {
      // Read from the composited document canvas, not from a layer's source:
      // what you sample should be what you can see, through overlays, masks and
      // adjustments alike.
      const dc = docCanvasRef.current
      const x = Math.round(p.x)
      const y = Math.round(p.y)
      if (dc && x >= 0 && y >= 0 && x < dc.width && y < dc.height) {
        const d = dc.getContext('2d', { willReadFrequently: true })
          .getImageData(x, y, 1, 1).data
        const hex = '#' + [d[0], d[1], d[2]]
          .map((v) => v.toString(16).padStart(2, '0')).join('')
        st.setToolOptions({ sampled: hex })
        // Someone asked for this colour, so hand it over and give the tool back.
        // Nobody asked, so it was the eyedropper being used on its own and the
        // sample stays in the rail to be copied.
        const back = pickRestore()
        if (deliverPick(hex)) st.setTool(back || 'move')
        else st.setNotice({ kind: 'ok', text: `Picked ${hex}` })
      }
      return
    }

    if (st.tool === 'crop') {
      const k = cropHandleAt(p)
      if (k) drag.current = { mode: 'crop', key: k, start: { ...cropRef.current }, p0: p }
      else drag.current = { mode: 'crop-new', p0: p }
      return
    }

    const h = hitHandle(p)
    if (h) {
      st.pushHistory()
      // Dragging a text box by hand means you want that width kept, so the box
      // stops hugging the text and starts wrapping it instead.
      if (h.layer.type === 'text' && h.key !== 'rot' && h.layer.autoSize !== false) {
        st.updateLayer(h.layer.id, { autoSize: false })
      }
      drag.current = {
        mode: h.key === 'rot' ? 'rotate' : 'resize',
        key: h.key,
        l0: { ...h.layer },
        a0: Math.atan2(p.y - layerCenter(h.layer).y, p.x - layerCenter(h.layer).x),
      }
      return
    }

    if (st.tool === 'erase') {
      const target = st.eraseTarget(p.x, p.y)
      if (!target) {
        st.setNotice({ kind: 'warn', text: 'Nothing to erase there — select a layer first.' })
        return
      }
      const r = resolveLayer(target, st.time)
      // Alt flips to restoring, which is how every other editor does it.
      st.beginErase(target.id, docToLayer(r, p.x, p.y),
        e.altKey ? { mode: 'restore' } : {})
      drag.current = { mode: 'erase', id: target.id }
      return
    }

    if (st.tool === 'clone') {
      const target = st.eraseTarget(p.x, p.y)
      if (!target) {
        st.setNotice({ kind: 'warn', text: 'Nothing to clone there — select a layer first.' })
        return
      }
      // Alt sets where the paint comes from. The same modifier every editor
      // uses for this, and the only thing the tool needs told.
      if (e.altKey) {
        st.setCloneSource([p.x, p.y])
        return
      }
      if (st.beginClone(target.id, [p.x, p.y])) {
        drag.current = { mode: 'clone', id: target.id }
      }
      return
    }

    if (st.tool === 'move') {
      // A click inside something already selected keeps that selection. Always
      // taking the topmost layer meant clicking your own selection could hand
      // you whatever happened to overlap it, and you would move that instead —
      // stacking order should be decided in the layers panel, not by accident
      // mid-drag. Shift-click still reaches through to change the selection.
      const top = topLayerAt(p)
      const held = !e.shiftKey && st.selectedIds.length
        ? st.doc.layers.find((x) => st.selectedIds.includes(x.id) && !x.locked
          && hitTest(resolveLayer(x, st.time), p.x, p.y))
        : null
      const l = held ? resolveLayer(held, st.time) : top
      if (!l) {
        st.select([])
        return
      }
      const alreadySelected = st.selectedIds.includes(l.id)
      if (e.shiftKey) {
        st.select(alreadySelected
          ? st.selectedIds.filter((id) => id !== l.id)
          : [...st.selectedIds, l.id])
      } else if (!alreadySelected) {
        st.select([l.id])
      }
      st.pushHistory()
      const ids = useStore.getState().selectedIds
      const now = useStore.getState()
      const picked = now.doc.layers
        .filter((x) => ids.includes(x.id))
        .map((x) => resolveLayer(x, now.time))
      drag.current = {
        mode: 'move',
        p0: p,
        origins: picked.map((r) => ({ id: r.id, x: r.x, y: r.y })),
        // Snapping works on the selection as a whole, so several layers dragged
        // together keep their relative spacing.
        box: unionBox(picked.map((r) => ({ x: r.x, y: r.y, w: r.w, h: r.h }))),
      }
      return
    }

    if (st.tool === 'text') {
      const layer = makeTextLayer({ x: p.x, y: p.y, w: 420, h: 80 })
      st.addLayer(layer)
      st.setTool('move')
      setTimeout(() => document.getElementById('pf-text-input')?.focus(), 0)
      return
    }

    if (st.tool === 'lasso') {
      // AI select replaces plotting: one click asks the model for an outline
      // instead of adding a vertex. Editing an outline it produced still works,
      // because what comes back is an ordinary lasso.
      if (st.toolOptions.aiSelect && !lassoRef.current && !lassoHandleAt(p)) {
        st.aiSelectAt(p.x, p.y)
        return
      }
      const handle = lassoHandleAt(p)
      if (handle) {
        const pts = st.lasso.points.map((q) => [...q])
        let index = handle.index
        if (handle.kind === 'midpoint') {
          // Splitting an edge inserts a point and immediately drags it.
          const a2 = pts[handle.index]
          const b2 = pts[(handle.index + 1) % pts.length]
          index = handle.index + 1
          pts.splice(index, 0, [(a2[0] + b2[0]) / 2, (a2[1] + b2[1]) / 2])
          st.setLasso({ points: pts })
        }
        drag.current = { mode: 'lasso-vertex', index }
        return
      }

      let live = lassoRef.current
      // Clicking the first vertex again closes the outline.
      if (live && live.points.length >= 3) {
        const first = live.points[0]
        if (Math.hypot(p.x - first[0], p.y - first[1]) * st.view.zoom < 10) {
          closeLasso()
          return
        }
      }
      if (!live) {
        if (st.lasso) st.clearLasso()
        live = { points: [], freehand: false }
        lassoRef.current = live
      }
      live.points.push([p.x, p.y])
      // The magnetic lasso needs a layer to read edges from, chosen once when
      // the drag starts. Picking it per move would let the path jump to another
      // layer's edges halfway round a subject.
      const magnetLayer = st.toolOptions.magnet ? topLayerAt(p) : null
      drag.current = {
        mode: 'lasso',
        p0: p,
        moved: false,
        magnet: magnetLayer?.id || null,
        // Where the settled part of the outline ends. Everything after this is
        // provisional and is replaced on every move.
        anchor: live.points.length - 1,
      }
      return
    }

    if (st.tool === 'effect' || st.tool === 'shape') {
      const o = st.toolOptions
      const layer = st.tool === 'effect'
        ? makeEffectLayer({
            name: `${o.effect[0].toUpperCase()}${o.effect.slice(1)} ${o.shape}`,
            shape: o.shape,
            effect: o.effect,
            pixelSize: o.pixelSize,
            blurRadius: o.blurRadius,
            feather: o.feather,
            x: p.x, y: p.y, w: 1, h: 1,
          })
        : makeShapeLayer({ shape: o.shape, x: p.x, y: p.y, w: 1, h: 1 })
      st.addLayer(layer)
      drag.current = { mode: 'draw', id: layer.id, p0: p }
    }
  }

  const onPointerMove = (e) => {
    const d = drag.current
    const p = toDoc(e)

    const activeTool = useStore.getState().tool
    if (activeTool === 'lasso' || activeTool === 'erase' || activeTool === 'eyedrop') cursorRef.current = [p.x, p.y]

    if (d?.mode === 'erase') {
      const st = useStore.getState()
      const target = st.doc.layers.find((x) => x.id === d.id)
      if (target) st.extendErase(d.id, docToLayer(resolveLayer(target, st.time), p.x, p.y))
      return
    }

    if (!d) {
      const st = useStore.getState()
      let cursor = 'default'
      if (spaceRef.current || st.tool === 'hand') cursor = 'grab'
      else if (st.tool === 'crop') cursor = cropHandleAt(p) === 'move' ? 'move' : (cropHandleAt(p) ? CURSORS[cropHandleAt(p)] : 'crosshair')
      else if (st.tool === 'lasso' && lassoHandleAt(p)) cursor = 'grab'
      else {
        const h = hitHandle(p)
        if (h) cursor = CURSORS[h.key]
        else if (st.tool === 'move') cursor = topLayerAt(p) ? 'move' : 'default'
        else if (st.tool === 'erase') cursor = 'crosshair'
        else if (st.tool === 'clone') cursor = 'crosshair'
        else cursor = 'crosshair'
      }
      if (hoverRef.current !== cursor) {
        hoverRef.current = cursor
        canvasRef.current.style.cursor = cursor
      }
      return
    }

    const st = useStore.getState()

    if (d.mode === 'pan') {
      st.setView({
        panX: d.panX + (e.clientX - d.sx),
        panY: d.panY + (e.clientY - d.sy),
        fitted: false,
      })
      return
    }

    if (d.mode === 'crop' || d.mode === 'crop-new') {
      const doc = st.doc
      let c
      if (d.mode === 'crop-new') {
        c = {
          x: Math.min(d.p0.x, p.x), y: Math.min(d.p0.y, p.y),
          w: Math.abs(p.x - d.p0.x), h: Math.abs(p.y - d.p0.y),
        }
      } else if (d.key === 'move') {
        c = { ...d.start, x: d.start.x + (p.x - d.p0.x), y: d.start.y + (p.y - d.p0.y) }
      } else {
        c = { ...d.start }
        let x1 = c.x
        let y1 = c.y
        let x2 = c.x + c.w
        let y2 = c.y + c.h
        if (d.key.includes('w')) x1 = p.x
        if (d.key.includes('e')) x2 = p.x
        if (d.key.includes('n')) y1 = p.y
        if (d.key.includes('s')) y2 = p.y
        c = { x: Math.min(x1, x2), y: Math.min(y1, y2), w: Math.abs(x2 - x1), h: Math.abs(y2 - y1) }
      }
      c.x = Math.max(0, Math.min(doc.width - 1, c.x))
      c.y = Math.max(0, Math.min(doc.height - 1, c.y))
      c.w = Math.max(1, Math.min(doc.width - c.x, c.w))
      c.h = Math.max(1, Math.min(doc.height - c.y, c.h))
      cropRef.current = c
      return
    }

    if (d.mode === 'move') {
      let dx = p.x - d.p0.x
      let dy = p.y - d.p0.y
      if (e.shiftKey) {
        // Shift constrains to one axis, as before.
        if (Math.abs(dx) > Math.abs(dy)) dy = 0
        else dx = 0
      }

      // Alt is the escape hatch when a layer needs to sit just off a guide.
      if (!e.altKey && d.box) {
        const moved = { x: d.box.x + dx, y: d.box.y + dy, w: d.box.w, h: d.box.h }
        const tol = SNAP_TOLERANCE / Math.max(0.0001, st.view.zoom)
        const snapped = snapRect(moved, st.doc, tol)
        if (!e.shiftKey || dx !== 0) dx += snapped.dx
        if (!e.shiftKey || dy !== 0) dy += snapped.dy
        guidesRef.current = snapped.guides
      } else {
        guidesRef.current = []
      }

      for (const o of d.origins) {
        st.setLayerAtTime(o.id, { x: o.x + dx, y: o.y + dy }, { relative: true })
      }
      return
    }

    if (d.mode === 'resize') {
      const local = toLocal(d.l0, p.x, p.y)
      const box = resizeBox(d.l0, d.key, local, { shift: e.shiftKey, alt: e.altKey })
      st.setLayerAtTime(d.l0.id, box, { relative: true })
      return
    }

    if (d.mode === 'rotate') {
      const c = layerCenter(d.l0)
      const a = Math.atan2(p.y - c.y, p.x - c.x)
      let deg = (d.l0.rotation || 0) + ((a - d.a0) * 180) / Math.PI
      if (e.shiftKey) deg = Math.round(deg / 15) * 15
      st.setLayerAtTime(d.l0.id, { rotation: Math.round(deg * 10) / 10 }, { relative: true })
      return
    }

    if (d.mode === 'draw') {
      let x = Math.min(d.p0.x, p.x)
      let y = Math.min(d.p0.y, p.y)
      let w = Math.abs(p.x - d.p0.x)
      let h = Math.abs(p.y - d.p0.y)
      if (e.shiftKey) {
        const s = Math.max(w, h)
        w = s
        h = s
        if (p.x < d.p0.x) x = d.p0.x - s
        if (p.y < d.p0.y) y = d.p0.y - s
      }
      if (e.altKey) {
        x = d.p0.x - w
        y = d.p0.y - h
        w *= 2
        h *= 2
      }
      st.updateLayer(d.id, { x, y, w: Math.max(1, w), h: Math.max(1, h) })
      return
    }

    if (d.mode === 'lasso-vertex') {
      const pts = st.lasso?.points
      if (!pts) return
      const next = pts.map((q, i) => (i === d.index ? [p.x, p.y] : q))
      st.setLasso({ points: next })
      return
    }

    if (d.mode === 'clone') {
      st.extendClone(d.id, [p.x, p.y])
      return
    }

    if (d.mode === 'lasso') {
      const live = lassoRef.current
      if (!live) return
      // A press that travels becomes a freehand trace; a plain click plots a
      // vertex. One tool covers both habits.
      if (!d.moved && Math.hypot(p.x - d.p0.x, p.y - d.p0.y) * st.view.zoom > 5) {
        d.moved = true
        live.freehand = true
      }
      if (!d.moved) return

      if (d.magnet) {
        const from = live.points[d.anchor]
        if (Math.hypot(p.x - from[0], p.y - from[1]) * st.view.zoom < 4) return
        // Everything past the anchor is provisional: recomputed from the anchor
        // to the pointer each move, so the path can change its mind as you go
        // rather than being stuck with the first route it found.
        const path = st.magnetPath(d.magnet, from, [p.x, p.y])
        live.points.length = d.anchor + 1
        for (const q of path.slice(1)) live.points.push(q)
        // Settle it once it has run far enough. Without this the search area
        // grows with every move until it is the whole picture and the lasso
        // stops keeping up.
        const run = Math.hypot(p.x - from[0], p.y - from[1]) * st.view.zoom
        if (run > 90) d.anchor = live.points.length - 1
        return
      }

      const last = live.points[live.points.length - 1]
      if (Math.hypot(p.x - last[0], p.y - last[1]) * st.view.zoom < 3) return
      live.points.push([p.x, p.y])
    }
  }

  const onPointerUp = (e) => {
    // Refit when the stroke ends rather than as it is painted: the box
    // jumping under the brush mid-drag is unusable, and the brush is a
    // fraction of the box width so it would change size as you went.
    if (drag.current?.mode === 'erase') {
      useStore.getState().refitToVisible(drag.current.id)
    }
    const d = drag.current
    drag.current = null
    rectRef.current = null
    guidesRef.current = []
    if (!d) return
    try { e.currentTarget.releasePointerCapture(e.pointerId) } catch { /* already released */ }

    const st = useStore.getState()
    if (d.mode === 'clone') st.endClone()
    if (d.mode === 'draw') {
      const l = st.doc.layers.find((x) => x.id === d.id)
      const tiny = l && (l.w < 10 || l.h < 10)
      const outside = d.p0.x < 0 || d.p0.y < 0 ||
        d.p0.x > st.doc.width || d.p0.y > st.doc.height
      if (tiny && outside) {
        // A stray click on the empty board around the document — usually someone
        // aiming for the timeline just below. Do not leave a layer behind.
        st.discardLayer(d.id)
        st.setTool('move')
        return
      }
      if (tiny) {
        // A click rather than a drag: give it a sensible default size.
        const cx0 = l.x + l.w / 2
        const cy0 = l.y + l.h / 2
        st.updateLayer(d.id, { x: cx0 - 90, y: cy0 - 90, w: 180, h: 180 })
      }
      st.setTool('move')
    }
    if (d.mode === 'clone') {
      st.extendClone(d.id, [p.x, p.y])
      return
    }

    if (d.mode === 'lasso') {
      // A freehand trace finishes on release; a plotted vertex was already
      // added on press, so a plain click needs nothing here.
      if (d.moved) closeLasso()
    }
  }

  const onDoubleClick = (e) => {
    const p = toDoc(e)
    if (useStore.getState().tool === 'lasso') { closeLasso(); return }
    const l = topLayerAt(p)
    if (l?.type === 'text' && !l.locked) {
      useStore.getState().select([l.id])
      useStore.getState().pushHistory()
      setEditing(l.id)
    }
  }

  // Editing text where it sits. A real caret inside a canvas would mean
  // reimplementing selection, IME and accessibility from scratch, so a textarea
  // is placed over the layer instead, matched to its font, size, colour and
  // rotation. It reads as editing in place because it is in the same place.
  const editLayer = useStore((st) => (
    editing ? st.doc.layers.find((x) => x.id === editing) : null))
  const setText = useStore((st) => st.setText)

  useEffect(() => {
    editingRef.current = editing
  }, [editing])

  useEffect(() => {
    if (!editing) return undefined
    const t = setTimeout(() => {
      const el = document.getElementById('pf-inline-text')
      if (el) { el.focus(); el.select() }
    }, 0)
    return () => clearTimeout(t)
  }, [editing])

  const editStyle = () => {
    const l = editLayer
    if (!l) return { display: 'none' }
    const lh = l.size * (l.lineHeight || 1.2)
    return {
      position: 'absolute',
      left: view.panX + l.x * view.zoom,
      top: view.panY + l.y * view.zoom,
      width: Math.max(24, l.w * view.zoom),
      height: Math.max(lh, l.h * view.zoom),
      // The layer rotates about its centre, so the box must too.
      transform: l.rotation ? `rotate(${l.rotation}deg)` : undefined,
      transformOrigin: 'center center',
      font: fontFor({ ...l, size: l.size * view.zoom }),
      lineHeight: `${lh * view.zoom}px`,
      color: l.color || '#fff',
      textAlign: l.align || 'left',
      // Auto-sized text does not wrap, and neither should the editor, or the
      // preview would disagree with the render as you type.
      whiteSpace: l.autoSize !== false ? 'pre' : 'pre-wrap',
      // The dashed border must not push the text off by its own width.
      boxSizing: 'border-box',
      opacity: l.opacity ?? 1,
    }
  }

  const wheelHandler = (e) => {
    e.preventDefault()
    const st = useStore.getState()
    // Nothing on the canvas means nothing to zoom towards — scrolling would just
    // slide an empty checkerboard around and strand the user at some arbitrary
    // magnification. The default view is restored on the first import anyway.
    if (!st.doc.layers.length) return
    const r = canvasRef.current.getBoundingClientRect()
    const mx = e.clientX - r.left
    const my = e.clientY - r.top
    const v = st.view

    if (e.ctrlKey || e.metaKey || !e.shiftKey) {
      const factor = Math.exp(-e.deltaY * 0.0015)
      const zoom = Math.max(0.02, Math.min(32, v.zoom * factor))
      st.setView({
        zoom,
        panX: mx - ((mx - v.panX) / v.zoom) * zoom,
        panY: my - ((my - v.panY) / v.zoom) * zoom,
        fitted: false,
      })
    } else {
      st.setView({ panX: v.panX - e.deltaX, panY: v.panY - e.deltaY, fitted: false })
    }
  }

  useEffect(() => {
    const c = canvasRef.current
    const h = (e) => wheelHandler(e)
    c.addEventListener('wheel', h, { passive: false })
    return () => c.removeEventListener('wheel', h)
  }, [])

  return (
    <div className="stage" ref={wrapRef}>
      <canvas
        ref={canvasRef}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onPointerLeave={() => {
          const t = useStore.getState().tool
          if (t === 'erase' || t === 'eyedrop') cursorRef.current = null
        }}
        onDoubleClick={onDoubleClick}
        onContextMenu={(e) => {
          e.preventDefault()
          const st = useStore.getState()
          if (st.tool !== 'lasso' || !st.lasso) return
          const h = lassoHandleAt(toDoc(e))
          if (h?.kind !== 'vertex') return
          if (st.lasso.points.length <= 3) return  // a polygon needs three
          st.setLasso({ points: st.lasso.points.filter((_, i) => i !== h.index) })
        }}
      />
      {editLayer && (
        <textarea
          id="pf-inline-text"
          className="inline-text"
          style={editStyle()}
          value={editLayer.text}
          spellCheck={false}
          onChange={(ev) => setText(editLayer.id, { text: ev.target.value })}
          onBlur={() => setEditing(null)}
          onKeyDown={(ev) => {
            // Escape leaves it; Enter makes a new line, because multi-line text
            // is the common case and there is a blur to commit with.
            if (ev.key === 'Escape') { ev.preventDefault(); setEditing(null) }
            ev.stopPropagation()
          }}
        />
      )}
    </div>
  )
}
