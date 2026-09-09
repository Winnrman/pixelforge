import { getAsset } from './assets.js'
import { applyEffectLayer } from './effects.js'
import { pairsIn, stateAt, drawFor, revealRect, veilBox, orderForTransitions, fadeAlphaAt, hasFade }
  from './transitions.js'
import {
  addShapePath, addMaskPath, hasMask, cropInsets, rad, toLocal, fromLocal, layerCenter,
} from './shapes.js'
import { paintFor, gradientOf, placeIn, gradientBox, withAlpha } from './gradient.js'
import { resolveLayer, keyExtent, allKeyTimes } from './keyframes.js'
import { resolveGroups, isGroup, descendantIds } from './groups.js'
import { segments, hasRuns } from './richtext.js'
import { keyedFrame } from './matte.js'
import { keyedFrameAI } from './aiMatte.js'
import { frameAt as videoFrameAt, ensureDecoded, exactFrame, indexAt } from './video.js'
import { subjectFrame, stickerFrame, isCutOut } from './subject.js'
import {
  assetTimeFor, visibleAt as clipVisibleAt, clipRange,
} from './clips.js'
import { applyRetro } from './retro.js'
import { hasErase, hasRestore, paintStrokes } from './erase.js'
import { hasClone, paintClone } from './clone.js'
import { loopPlan, pingPongTime } from './loop.js'

export function filterCSS(a) {
  if (!a) return 'none'
  const p = []
  if (a.brightness !== 100) p.push(`brightness(${a.brightness}%)`)
  if (a.contrast !== 100) p.push(`contrast(${a.contrast}%)`)
  if (a.saturate !== 100) p.push(`saturate(${a.saturate}%)`)
  if (a.hue) p.push(`hue-rotate(${a.hue}deg)`)
  if (a.blur) p.push(`blur(${a.blur}px)`)
  if (a.grayscale) p.push(`grayscale(${a.grayscale}%)`)
  if (a.sepia) p.push(`sepia(${a.sepia}%)`)
  if (a.invert) p.push(`invert(${a.invert}%)`)
  return p.length ? p.join(' ') : 'none'
}

export function frameIndexAt(asset, t) {
  const n = asset.frames.length
  if (n <= 1) return 0
  const d = asset.duration
  if (!d) return 0
  let tt = ((t % d) + d) % d
  const cum = asset.cum
  let lo = 0
  let hi = n - 1
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (tt < cum[mid]) hi = mid
    else lo = mid + 1
  }
  return lo
}

/** Time inside an asset's own timeline, given the layer's speed and offset. */
export function assetTime(layer, time) {
  if (layer.clip) return assetTimeFor(layer, time, getAsset(layer.assetId))
  return (time - (layer.timeOffset || 0)) * (layer.speed || 1)
}

/**
 * Whether a layer is on screen at `time`.
 *
 * A clip is bounded in time; everything else is visible throughout, which is
 * what an overlay on a looping GIF wants and what every project made before
 * clips existed assumes.
 */
// No transitions anywhere is the common case, so the per-frame map is skipped
// entirely rather than rebuilt empty.
const EMPTY_MIX = new Map()

export function onScreen(layer, time) {
  return !layer.clip || clipVisibleAt(layer, time, getAsset(layer.assetId))
}

// Loop plans are pure and cheap to build, but rebuilding one per frame would
// allocate a closure on every render, so they are memoised per asset+settings.
const loopPlans = new Map()
function planFor(asset, lp) {
  const key = asset.id + '|' + lp.mode + '|' + (lp.crossfadeMs || 0) + '|' + (lp.trimEndMs || 0)
  let plan = loopPlans.get(key)
  if (!plan) {
    plan = loopPlan(asset, lp)
    loopPlans.set(key, plan)
    // The map is keyed on settings, so a user dragging a slider would grow it
    // without bound. A handful of recent plans is all anything needs.
    if (loopPlans.size > 24) loopPlans.delete(loopPlans.keys().next().value)
  }
  return plan
}

let blendCanvas = null
function blendFrames(a, b, mix) {
  const w = a.width, h = a.height
  if (!blendCanvas) blendCanvas = document.createElement('canvas')
  if (blendCanvas.width !== w || blendCanvas.height !== h) {
    blendCanvas.width = w
    blendCanvas.height = h
  }
  const c = blendCanvas.getContext('2d')
  c.setTransform(1, 0, 0, 1, 0, 0)
  c.globalAlpha = 1
  c.clearRect(0, 0, w, h)
  c.drawImage(a, 0, 0)
  c.globalAlpha = mix
  c.drawImage(b, 0, 0)
  c.globalAlpha = 1
  return blendCanvas
}

/** How long this layer's asset runs once loop repair is applied. */
export function loopDuration(layer, asset) {
  const lp = layer.loop
  if (!lp?.on || !asset?.animated || asset.isVideo) return asset?.duration || 0
  return planFor(asset, lp).duration
}

export function sourceFor(layer, time) {
  const asset = getAsset(layer.assetId)
  if (!asset) return null
  if (asset.live) return asset.el
  const t = assetTime(layer, time)
  // A clip plays the piece between its in and out points, once. Wrapping it
  // would make trimming meaningless — the frames you trimmed off would come back
  // around. Only an unclipped layer loops.
  const wrap = (x) => (layer.clip ? x : ((x % asset.duration) + asset.duration) % asset.duration)
  // Video returns whatever is decoded; a neighbouring frame for a moment during
  // a scrub beats a blank canvas.
  if (asset.isVideo) return videoFrameAt(asset, wrap(t))
  if (!asset.frames.length) return null

  // Loop repair is a remap, not a re-encode: nothing is baked into the asset,
  // so turning it off restores the original clip exactly.
  const lp = layer.loop
  if (lp?.on && lp.mode && lp.mode !== 'none') {
    const plan = planFor(asset, lp)
    const d = plan.duration || asset.duration
    const { a, b, mix } = plan.sample(((t % d) + d) % d)
    const fa = asset.frames[Math.min(asset.frames.length - 1, Math.max(0, a))]
    if (!fa) return null
    if (!(mix > 0.001) || a === b) return fa.bitmap
    const fb = asset.frames[Math.min(asset.frames.length - 1, Math.max(0, b))]
    return fb ? blendFrames(fa.bitmap, fb.bitmap, mix) : fa.bitmap
  }
  return asset.frames[frameIndexAt(asset, t)].bitmap
}

/**
 * Asks every visible video layer to decode around `time`. Fire and forget.
 *
 * Grouped by *asset*, which matters the moment two clips of one video overlap.
 * A transition between two halves of the same clip needs two different frames of
 * it at the same instant, and there is one decoder run per asset — a run that
 * only goes forwards. Asking for each position in turn made them tear that run
 * down and rebuild it by turns, every frame: hundreds of chunks decoded a second
 * and nothing delivered, the picture black, the thumbnails starved, and the
 * sound — which comes from somewhere else entirely — carrying on fine.
 *
 * So the positions wanted from one asset are collected first, and the run is
 * started at the earliest and fed far enough forward to reach the latest. For a
 * crossfade the two are adjacent in the source, so that span is the length of
 * the overlap and sits inside the cache with room to spare.
 */
export function primeVideo(doc, time) {
  const wants = new Map()
  for (const l of doc.layers) {
    if (l.type !== 'image' || l.visible === false) continue
    const a = getAsset(l.assetId)
    if (!a?.isVideo) continue
    if (!onScreen(l, time)) continue
    const t0 = assetTime(l, time)
    const t = l.clip ? t0 : ((t0 % a.duration) + a.duration) % a.duration
    const at = wants.get(a)
    if (!at) wants.set(a, { lo: t, hi: t })
    else {
      if (t < at.lo) at.lo = t
      if (t > at.hi) at.hi = t
    }
  }
  for (const [a, { lo, hi }] of wants) {
    // One position: leave the lookahead alone, so ordinary playback keeps the
    // generous prefetch it was tuned with.
    if (hi === lo) { ensureDecoded(a, lo); continue }
    // Two: reach far enough to cover both, but never ask for more than the
    // cache can hold — past that the far frames would evict the near ones as
    // they arrive, and both clips would be served nothing instead of one being
    // served its nearest.
    const span = indexAt(a, hi) - indexAt(a, lo)
    ensureDecoded(a, lo, Math.min(Math.max(8, a.cache.limit - 4), span + 8))
  }
}

/** Waits for the exact frame of every video layer. Used before an export pass. */
export async function awaitVideo(doc, time) {
  const jobs = []
  for (const l of doc.layers) {
    if (l.type !== 'image' || l.visible === false) continue
    const a = getAsset(l.assetId)
    if (!a?.isVideo) continue
    // Nothing to wait for on a clip that is not on screen at this time — and
    // waiting anyway would make an export as slow as the number of clips.
    if (!onScreen(l, time)) continue
    const t = assetTime(l, time)
    jobs.push(exactFrame(a, l.clip ? t : ((t % a.duration) + a.duration) % a.duration))
  }
  if (jobs.length) await Promise.all(jobs)
}

/**
 * The part of a layer's own box that still has pixels in it, as 0..1.
 *
 * Rendered rather than derived: a layer's visible extent is the product of its
 * matte, its mask and its erase strokes together, and the only thing that knows
 * how those combine is the compositor. Drawn unrotated into a canvas the size of
 * the box, so the result is directly a fraction of the box.
 */
export function visibleBounds(layer, time = 0, maxSide = 512) {
  const w = Math.abs(layer.w)
  const h = Math.abs(layer.h)
  if (!(w > 0) || !(h > 0)) return null
  const k = Math.min(1, maxSide / Math.max(w, h))
  const cw = Math.max(1, Math.round(w * k))
  const ch = Math.max(1, Math.round(h * k))
  const c = document.createElement('canvas')
  c.width = cw
  c.height = ch
  const ctx = c.getContext('2d', { willReadFrequently: true })
  const flat = {
    ...layer, x: 0, y: 0, w: cw, h: ch, rotation: 0, opacity: 1, blend: 'source-over',
  }
  renderDocument(ctx, { width: cw, height: ch, background: 'transparent', layers: [flat] }, time)

  const d = ctx.getImageData(0, 0, cw, ch).data
  let minX = cw
  let minY = ch
  let maxX = -1
  let maxY = -1
  for (let y = 0; y < ch; y++) {
    for (let x = 0; x < cw; x++) {
      if (d[(y * cw + x) * 4 + 3] < 8) continue
      if (x < minX) minX = x
      if (x > maxX) maxX = x
      if (y < minY) minY = y
      if (y > maxY) maxY = y
    }
  }
  if (maxX < 0) return null
  return {
    x: minX / cw,
    y: minY / ch,
    w: (maxX - minX + 1) / cw,
    h: (maxY - minY + 1) / ch,
  }
}

export function docDuration(doc) {
  // A project with no animated media still needs a timeline to key against,
  // so the document carries its own length.
  let d = doc.duration || 0
  const groups = resolveGroups(doc.layers)
  for (const l of doc.layers) {
    if (!groups.visible.get(l.id)) continue
    d = Math.max(d, keyExtent(l))
    if (l.clip && l.type !== 'image') d = Math.max(d, clipRange(l, null).end)
    if (l.type !== 'image') continue
    const a = getAsset(l.assetId)
    // A clip says exactly how long it is and where it sits, so it answers for
    // itself rather than being inferred from the asset.
    if (l.clip) { d = Math.max(d, clipRange(l, a).end); continue }
    if (a?.animated) d = Math.max(d, loopDuration(l, a) / (l.speed || 1) + (l.timeOffset || 0))
    else if (a?.live) d = Math.max(d, 2000)
  }
  return d
}

function wrapLines(ctx, text, maxWidth) {
  const out = []
  for (const para of String(text).split('\n')) {
    if (!para) { out.push(''); continue }
    let line = ''
    for (const word of para.split(/\s+/)) {
      const test = line ? line + ' ' + word : word
      if (ctx.measureText(test).width > maxWidth && line) {
        out.push(line)
        line = word
      } else {
        line = test
      }
    }
    out.push(line)
  }
  return out
}

/** The font string a text layer draws with, in one place. */
export function fontFor(l) {
  return `${l.italic ? 'italic ' : ''}${l.weight || 700} ${l.size}px ${l.font || 'Inter, sans-serif'}`
}

let measureCtx = null

/**
 * How big a text layer's content actually is.
 *
 * With `autoSize` the box hugs the text and only explicit newlines break a
 * line; otherwise the text wraps at the current width and only the height is
 * measured. Either way the height follows the line count, so a box never
 * clips what is in it.
 */
export function measureText(l) {
  if (!measureCtx) measureCtx = document.createElement('canvas').getContext('2d')
  measureCtx.font = fontFor(l)
  // A layer that styles part of itself is measured piece by piece: a bold word
  // is wider than the same word plain, and a box that ignored that would clip
  // the very word that was made to stand out.
  if (hasRuns(l)) {
    const rows = runLines(measureCtx, l)
    const widths = rows.map((pieces) => pieces.reduce((sum, p) => {
      measureCtx.font = runFont(l, p.style)
      return sum + measureCtx.measureText(p.text).width
    }, 0))
    const lh0 = l.size * (l.lineHeight || 1.2)
    return {
      lines: rows.map((pieces) => pieces.map((p) => p.text).join('')),
      w: Math.ceil(Math.max(1, ...widths) + l.size * 0.12),
      h: Math.ceil(rows.length * lh0),
    }
  }
  const lines = l.autoSize !== false
    ? String(l.text ?? '').split('\n')
    : wrapLines(measureCtx, l.text || '', l.w)
  const width = Math.max(1, ...lines.map((line) => measureCtx.measureText(line).width))
  const lh = l.size * (l.lineHeight || 1.2)
  return {
    lines,
    // A little air on the right: italic and script faces overhang their advance
    // width, and a box measured to the exact advance clips them.
    w: Math.ceil(width + l.size * 0.12),
    h: Math.ceil(lines.length * lh),
  }
}

export const FULL_SRC = { x: 0, y: 0, w: 1, h: 1 }

/**
 * Which part of the asset a layer samples, in 0..1 asset coordinates.
 *
 * `l.src` is the static base set by a document crop. On top of it the animatable
 * crop insets trim the edges, then zoom shrinks the window about its centre and
 * pan slides it — so animating zoom pushes into the image while the layer's box
 * stays exactly where it is.
 */
export function sourceRect(l) {
  const base = l.src || FULL_SRC
  const c = cropInsets(l)
  let sx = base.x + c.cl * base.w
  let sy = base.y + c.ct * base.h
  let sw = base.w * c.kx
  let sh = base.h * c.ky

  const z = Math.max(0.05, l.zoom ?? 1)
  const cx = sx + sw / 2 + (l.panX || 0) * sw
  const cy = sy + sh / 2 + (l.panY || 0) * sh
  sw = Math.min(1, sw / z)
  sh = Math.min(1, sh / z)
  sx = Math.min(Math.max(cx - sw / 2, 0), 1 - sw)
  sy = Math.min(Math.max(cy - sh / 2, 0), 1 - sh)
  return { x: sx, y: sy, w: sw, h: sh }
}

// Retro looks are per-pixel work, so each derived frame is cached against the
// source bitmap and only rebuilt when the settings change. WeakMap so decoded
// video frames are still collectable.
const retroCache = new WeakMap()
function retroFrame(src, retro) {
  if (!retro?.on || !retro.preset) return src
  const key = retro.preset + '|' + JSON.stringify(retro.opts || {})
  const hit = retroCache.get(src)
  if (hit && hit.key === key) return hit.canvas
  const w = src.naturalWidth || src.width
  const h = src.naturalHeight || src.height
  if (!w || !h) return src
  const c = document.createElement('canvas')
  c.width = w
  c.height = h
  const cx = c.getContext('2d', { willReadFrequently: true })
  cx.drawImage(src, 0, 0)
  const img = cx.getImageData(0, 0, w, h)
  applyRetro(img, retro.preset, retro.opts)
  cx.putImageData(img, 0, 0)
  retroCache.set(src, { key, canvas: c })
  return c
}

/**
 * The rectangle a layer's picture is drawn into, in the layer's own centred
 * coordinates. Crop insets shrink it, which is why it is not simply the box.
 */
function destRect(l) {
  const ci = cropInsets(l)
  return {
    x: -l.w / 2 + ci.cl * l.w,
    y: -l.h / 2 + ci.ct * l.h,
    w: l.w * ci.kx,
    h: l.h * ci.ky,
  }
}

/**
 * A point on the canvas, expressed as a fraction of the asset frame.
 *
 * Everything the renderer does to place a picture has to be undone in order:
 * rotation, the crop insets, the flips, and finally the source window. Returns
 * null when the point is outside the drawn area, which is the honest answer for
 * a click that missed.
 */
export function docToAsset(l, px, py) {
  const p = toLocal(l, px, py)
  const d = destRect(l)
  let u = (p.x - d.x) / d.w
  let v = (p.y - d.y) / d.h
  if (u < 0 || u > 1 || v < 0 || v > 1) return null
  if (l.flipX) u = 1 - u
  if (l.flipY) v = 1 - v
  const r = sourceRect(l)
  return { x: r.x + u * r.w, y: r.y + v * r.h }
}

/** The inverse: a fraction of the asset frame, back onto the canvas. */
export function assetToDoc(l, ax, ay) {
  const r = sourceRect(l)
  let u = (ax - r.x) / r.w
  let v = (ay - r.y) / r.h
  if (l.flipX) u = 1 - u
  if (l.flipY) v = 1 - v
  const d = destRect(l)
  return fromLocal(l, d.x + u * d.w, d.y + v * d.h)
}

/**
 * A layer-box fraction (0..1, the convention masks and erase strokes use),
 * expressed as a fraction of the asset frame.
 *
 * This is `docToAsset` without the rotation step, because the asset frame is
 * never rotated — the rotation happens when the finished picture is placed.
 */
function layerFracToAsset(l, u, v) {
  const d = destRect(l)
  let a = ((u - 0.5) * l.w - d.x) / d.w
  let b = ((v - 0.5) * l.h - d.y) / d.h
  if (l.flipX) a = 1 - a
  if (l.flipY) b = 1 - b
  const r = sourceRect(l)
  return { x: r.x + a * r.w, y: r.y + b * r.h }
}

/**
 * Whether a sticker builds its own cutout rather than borrowing the background
 * key. True whenever anything at all decides the layer's alpha, so it stays in
 * lockstep with `stickerCut` — `withMask` reads this to know the mask and the
 * erase strokes have already been accounted for.
 */
const stickerBakes = (l) => !!l?.sticker?.on && isCutOut(l)

// One cutout per layer, rebuilt only when something that shapes it changes. The
// canvas identity is the cache key `stickerFrame` uses for the dilated border,
// so a *new* canvas on every change is deliberate: it invalidates that border
// too, and the WeakMap lets the old pair go.
const cutCache = new Map()
let rawSeq = 0
const rawIds = new WeakMap()
function rawId(x) {
  let i = rawIds.get(x)
  if (i === undefined) { i = ++rawSeq; rawIds.set(x, i) }
  return i
}

function cutSignature(l, raw) {
  const mask = hasMask(l)
    ? `${l.mask.points.length}/${l.mask.invert ? 1 : 0}/${l.mask.feather || 0}/`
      + `${l.mask.points[0]}/${l.mask.points[l.mask.points.length - 1]}`
    : ''
  const erase = hasErase(l)
    ? l.erase.strokes.map((k) => `${k.mode}${k.size}${k.hardness}${k.pts?.length || 0}`).join(',')
    : ''
  return [
    rawId(raw), JSON.stringify(l.bgRemove || 0), mask, erase,
    l.w, l.h, l.flipX ? 1 : 0, l.flipY ? 1 : 0,
    JSON.stringify(sourceRect(l)), JSON.stringify(destRect(l)),
  ].join('|')
}

/**
 * The shape a sticker border is grown around.
 *
 * It has to be everything that decides the layer's alpha — the background key,
 * the lasso mask *and* the erase strokes — because the border is a dilation of
 * whatever is left. Reading only the background key is what made an erased
 * region keep its border: the pixels were gone from the picture but still
 * present in the shape the border was traced from.
 *
 * Baked in asset space rather than doc space so the result can be handed
 * straight to `stickerFrame`, which works on the source frame.
 */
function stickerCut(raw, l) {
  if (!stickerBakes(l)) return null
  const sig = cutSignature(l, raw)
  const hit = cutCache.get(l.id)
  if (hit && hit.sig === sig) return hit.canvas

  const keyed = l.bgRemove?.on ? (subjectFrame(raw, l.bgRemove) || raw) : raw
  const aw = keyed.naturalWidth || keyed.width
  const ah = keyed.naturalHeight || keyed.height
  if (!aw || !ah) return null

  const cut = document.createElement('canvas')
  cut.width = aw
  cut.height = ah
  const cx = cut.getContext('2d')
  cx.drawImage(keyed, 0, 0)

  // Asset pixels per doc pixel — the erase brush and the mask feather are both
  // authored in doc space and have to be rescaled to land the same width here.
  const d = destRect(l)
  const r = sourceRect(l)
  const scale = Math.abs(d.w) > 0.0001 ? (r.w * aw) / Math.abs(d.w) : 1
  const map = (pt) => {
    const a = layerFracToAsset(l, pt[0], pt[1])
    return { x: a.x * aw, y: a.y * ah }
  }

  if (hasMask(l)) {
    const feather = (l.mask.feather || 0) * scale
    const stencil = document.createElement('canvas')
    stencil.width = aw
    stencil.height = ah
    const sx = stencil.getContext('2d')
    if (feather > 0.4) sx.filter = `blur(${feather.toFixed(2)}px)`
    sx.fillStyle = '#fff'
    sx.beginPath()
    const pts = l.mask.points
    for (let i = 0; i < pts.length; i++) {
      const q = map(pts[i])
      i === 0 ? sx.moveTo(q.x, q.y) : sx.lineTo(q.x, q.y)
    }
    sx.closePath()
    if (l.mask.invert) {
      sx.rect(0, 0, aw, ah)
      sx.fill('evenodd')
    } else {
      sx.fill()
    }
    cx.globalCompositeOperation = 'destination-in'
    cx.drawImage(stencil, 0, 0)
    cx.globalCompositeOperation = 'source-over'
  }

  if (hasErase(l)) {
    // A copy taken before the holes are punched, so restore strokes have
    // something to stencil back out of.
    let back = null
    if (hasRestore(l)) {
      back = document.createElement('canvas')
      back.width = aw
      back.height = ah
      back.getContext('2d').drawImage(cut, 0, 0)
    }
    cx.save()
    cx.globalCompositeOperation = 'destination-out'
    paintStrokes(cx, l, l.erase.strokes, { restore: false, map, scale })
    cx.restore()
    if (back) {
      const bx = back.getContext('2d')
      bx.save()
      bx.globalCompositeOperation = 'destination-in'
      paintStrokes(bx, l, l.erase.strokes, { restore: true, map, scale })
      bx.restore()
      cx.drawImage(back, 0, 0)
    }
  }

  cutCache.set(l.id, { sig, canvas: cut })
  return cut
}

function drawImageLayer(ctx, l, time) {
  const raw = sourceFor(l, time)
  if (!raw) return
  // Background removal is a render-time key on the decoded frame, so an animated
  // GIF re-keys itself as it plays and nothing is baked into the document. The
  // learned matte cannot run inside a synchronous render, so it uses whatever
  // mask has already been computed and falls back to the plain frame.
  let src = raw
  if (l.bgRemove?.on) {
    src = l.bgRemove.mode === 'ai'
      ? (keyedFrameAI(raw, l.bgRemove) || raw)
      : keyedFrame(raw, l.bgRemove)
  }
  const r = sourceRect(l)
  const aw = src.naturalWidth || src.width
  const ah = src.naturalHeight || src.height
  let sx = r.x * aw
  let sy = r.y * ah
  let sw = Math.max(1, r.w * aw)
  let sh = Math.max(1, r.h * ah)
  // Crop insets shrink the drawn rect too, so trimming reveals less of the
  // image instead of squashing what is left.
  const ci = cropInsets(l)
  let dx = -l.w / 2 + ci.cl * l.w
  let dy = -l.h / 2 + ci.ct * l.h
  let dw = l.w * ci.kx
  let dh = l.h * ci.ky

  // The sticker border lives outside the artwork, so both rects grow by the
  // padding it added. Growing the source rect by 2*pad while leaving its origin
  // alone is what keeps the subject registered exactly where it was — the
  // sticker canvas already holds the original at offset (pad, pad).
  if (l.sticker?.on) {
    const cut = stickerCut(raw, l)
    const st = cut && stickerFrame(cut, l.sticker)
    if (st && st.pad > 0) {
      const k = dw / sw
      src = st.canvas
      dx -= st.pad * k
      dy -= st.pad * k
      dw += st.pad * 2 * k
      dh += st.pad * 2 * k
      sw += st.pad * 2
      sh += st.pad * 2
    } else if (st) {
      src = st.canvas
    }
  }
  // Last, so the palette applies to whatever is actually being drawn — the
  // cutout and its sticker border included.
  src = retroFrame(src, l.retro)
  ctx.save()
  ctx.globalAlpha = l.opacity ?? 1
  ctx.globalCompositeOperation = l.blend || 'source-over'
  const f = filterCSS(l.adjust)
  if (f !== 'none') ctx.filter = f
  ctx.translate(l.x + l.w / 2, l.y + l.h / 2)
  if (l.rotation) ctx.rotate(rad(l.rotation))

  // A photo mount: the layer box is the whole card, and the picture sits inside
  // it. Drawn here rather than as a separate shape layer underneath so it
  // inherits the rotation, scale and opacity for free — a collage of thirty
  // tilted Polaroids is thirty layers, not sixty that have to be kept in step.
  if (l.frame?.on) {
    const ins = l.frame.insets || { l: 0, r: 0, t: 0, b: 0 }
    ctx.save()
    if (l.frame.shadow > 0) {
      ctx.shadowColor = l.frame.shadowColor || 'rgba(0,0,0,0.45)'
      ctx.shadowBlur = l.frame.shadow
      ctx.shadowOffsetY = l.frame.shadowY ?? Math.round(l.frame.shadow * 0.4)
    }
    ctx.fillStyle = l.frame.color || '#ffffff'
    const r = Math.max(0, Math.min(l.frame.radius || 0, dw / 2, dh / 2))
    ctx.beginPath()
    if (r > 0 && ctx.roundRect) ctx.roundRect(dx, dy, dw, dh, r)
    else ctx.rect(dx, dy, dw, dh)
    ctx.fill()
    ctx.restore()

    const il = ins.l * dw
    const ir = ins.r * dw
    const it = ins.t * dh
    const ib = ins.b * dh
    dx += il
    dy += it
    dw -= il + ir
    dh -= it + ib
  }

  if (l.radius > 0) {
    ctx.beginPath()
    if (ctx.roundRect) ctx.roundRect(dx, dy, dw, dh, Math.min(l.radius, dw / 2, dh / 2))
    else ctx.rect(dx, dy, dw, dh)
    ctx.clip()
  }
  ctx.scale(l.flipX ? -1 : 1, l.flipY ? -1 : 1)
  ctx.drawImage(src, sx, sy, sw, sh, l.flipX ? -dx - dw : dx, l.flipY ? -dy - dh : dy, dw, dh)
  ctx.restore()
}

function drawShapeLayer(ctx, l) {
  ctx.save()
  ctx.globalAlpha = l.opacity ?? 1
  ctx.globalCompositeOperation = l.blend || 'source-over'
  ctx.beginPath()
  addShapePath(ctx, l)
  if (l.fill && l.fill !== 'none') {
    // The path built its own transform and put it back, so the context here is
    // the document — the gradient has to be placed on the shape rather than
    // around the origin, and turned with it.
    const g = gradientOf(l)
    ctx.fillStyle = paintFor(ctx, {
      from: l.fill, to: l.fill2, angle: l.fillAngle, stop: g?.stop, stop2: g?.stop2,
      alpha: g?.alpha, alpha2: g?.alpha2,
      // The path built its own transform and put it back, so the context here is
      // the document — which is also the frame `gradBox` is measured in.
      ...placeIn(l, l.gradBox),
    })
    ctx.fill()
  }
  if (l.strokeWidth > 0) {
    // The border's own opacity, separate from the layer's: a solid shape behind
    // a half-there outline is a thing to want, and one number for the whole
    // layer cannot say it.
    ctx.strokeStyle = withAlpha(l.stroke || '#fff', l.strokeOpacity ?? 1)
    ctx.lineWidth = l.strokeWidth
    ctx.lineJoin = 'round'
    ctx.stroke()
  }
  ctx.restore()
}

/**
 * Every glyph in a text layer, with its box in the layer's own centred
 * coordinates.
 *
 * Positions come from measuring progressive substrings rather than each
 * character alone, so kerning is preserved — measuring 'A' and 'V' separately
 * and adding the widths would space them differently from how they draw.
 */
function glyphBoxes(ctx, l, lines) {
  const lh = l.size * (l.lineHeight || 1.2)
  const startY = -l.h / 2
  const out = []
  for (let li = 0; li < lines.length; li++) {
    const line = lines[li]
    const full = ctx.measureText(line).width
    // textAlign moves the whole line, so the left edge is worked out once.
    const originX = l.align === 'center'
      ? -full / 2
      : l.align === 'right' ? l.w / 2 - full : -l.w / 2
    for (let ci = 0; ci < line.length; ci++) {
      if (line[ci] === ' ') continue
      const x0 = ci === 0 ? 0 : ctx.measureText(line.slice(0, ci)).width
      const x1 = ctx.measureText(line.slice(0, ci + 1)).width
      out.push({
        line: li,
        index: ci,
        char: line[ci],
        x: originX + x0,
        y: startY + li * lh,
        w: Math.max(1, x1 - x0),
        h: l.size,
        drawX: originX + x0,
      })
    }
  }
  return out
}

/**
 * Which glyphs are mostly hidden by something in front of them.
 *
 * Without this the switch from solid to outline happens *within* a letter —
 * wherever the subject's edge crosses it — and an A comes out as a solid wedge
 * next to an outlined one, which reads as broken rather than deliberate. Judged
 * per glyph, a letter is either whole and solid or whole and outlined.
 */
function coveredGlyphs(ctx, doc, l, time, targetId, threshold = 0.35) {
  const cover = coverageCanvas(doc, l, time, targetId)
  if (!cover) return null
  const { canvas, scale } = cover
  const cctx = canvas.getContext('2d', { willReadFrequently: true })
  const data = cctx.getImageData(0, 0, canvas.width, canvas.height).data

  const a = rad(l.rotation || 0)
  const cos = Math.cos(a)
  const sin = Math.sin(a)
  const cx = l.x + l.w / 2
  const cy = l.y + l.h / 2
  const toDoc = (px, py) => ({
    x: cx + px * cos - py * sin,
    y: cy + px * sin + py * cos,
  })

  const lines = l.autoSize !== false
    ? String(l.text ?? '').split('\n')
    : wrapLines(ctx, l.text || '', l.w)
  const boxes = glyphBoxes(ctx, l, lines)
  const hidden = new Set()
  for (const g of boxes) {
    // A coarse grid is plenty: the question is "most of it or not", not an
    // exact area, and a 6x6 sample is 36 reads instead of thousands.
    let covered = 0
    let total = 0
    for (let sy = 0; sy < 6; sy++) {
      for (let sx = 0; sx < 6; sx++) {
        const p = toDoc(g.x + ((sx + 0.5) / 6) * g.w, g.y + ((sy + 0.5) / 6) * g.h)
        const px = Math.round(p.x * scale)
        const py = Math.round(p.y * scale)
        if (px < 0 || py < 0 || px >= canvas.width || py >= canvas.height) continue
        total++
        if (data[(py * canvas.width + px) * 4 + 3] > 80) covered++
      }
    }
    if (total && covered / total >= threshold) hidden.add(`${g.line}:${g.index}`)
  }
  return hidden
}

/** The alpha of whatever sits in front of a text layer, at document scale. */
function coverageCanvas(doc, textLayer, time, targetId) {
  const idx = doc.layers.findIndex((x) => x.id === textLayer.id)
  const above = targetId === 'all' || targetId === true
    ? doc.layers.slice(idx + 1).filter((x) => x.type !== 'group')
    : doc.layers.filter((x) => x.id === targetId)
  if (!above.length) return null
  // Half resolution: this decides a yes/no per letter, not an edge.
  const scale = Math.min(1, 640 / Math.max(doc.width, doc.height))
  const w = Math.max(1, Math.round(doc.width * scale))
  const h = Math.max(1, Math.round(doc.height * scale))
  const c = coverScratch(w, h)
  const ctx = c.getContext('2d', { willReadFrequently: true })
  ctx.setTransform(1, 0, 0, 1, 0, 0)
  ctx.clearRect(0, 0, w, h)
  ctx.save()
  ctx.scale(scale, scale)
  renderDocument(ctx, {
    width: doc.width, height: doc.height, background: 'transparent', layers: above,
  }, time)
  ctx.restore()
  return { canvas: c, scale }
}

let coverCanvas = null
function coverScratch(w, h) {
  if (!coverCanvas) coverCanvas = document.createElement('canvas')
  if (coverCanvas.width !== w || coverCanvas.height !== h) {
    coverCanvas.width = w
    coverCanvas.height = h
  }
  return coverCanvas
}

/**
 * Draws a text layer.
 *
 * `outlineOnly` skips the fill, which is what makes the outline pass work: the
 * same letters stroked over the top read as an outline where something covers
 * them and vanish where the solid text is already showing, because they are
 * drawn in the same colour.
 */
/** The font one piece of styled text draws with. */
const runFont = (l, st) =>
  `${st.italic ? 'italic ' : ''}${st.weight || 700} ${l.size}px ${l.font || 'Inter, sans-serif'}`

/**
 * A text layer's lines, each cut into pieces that draw with one style.
 *
 * Wrapping has to measure as it goes here, because a bold word is wider than the
 * same word plain and a line that fitted before it was emboldened does not fit
 * after. Whitespace is kept rather than collapsed to single spaces, which is a
 * small difference from the plain path and the more honest one.
 */
export function runLines(ctx, l) {
  const base = { color: l.color || '#fff', weight: l.weight || 700, italic: !!l.italic }
  const paras = [[]]
  for (const seg of segments(l.text || '', l.runs, base)) {
    const parts = seg.text.split('\n')
    parts.forEach((t, i) => {
      if (i > 0) paras.push([])
      if (t) paras[paras.length - 1].push({ text: t, style: seg.style })
    })
  }
  // An auto-sized box already fits its content and must not re-wrap.
  if (l.autoSize !== false) return paras

  const out = []
  for (const para of paras) {
    const words = []
    for (const piece of para) {
      for (const w of piece.text.split(/(\s+)/)) if (w) words.push({ text: w, style: piece.style })
    }
    let line = []
    let width = 0
    for (const w of words) {
      ctx.font = runFont(l, w.style)
      const ww = ctx.measureText(w.text).width
      if (width + ww > l.w && line.length && w.text.trim()) {
        out.push(line)
        line = []
        width = 0
      }
      // A space that only exists because a line broke is not drawn at the start
      // of the next one.
      if (!line.length && !w.text.trim()) continue
      line.push(w)
      width += ww
    }
    out.push(line)
  }
  return out
}

/**
 * Draws a text layer that styles part of itself differently from the whole.
 *
 * Kept apart from the plain path rather than folded into it. Every piece needs
 * its own font set and its own x worked out, so alignment stops being something
 * the canvas does for us and becomes a sum over the line — and none of that is
 * worth imposing on the ordinary case, which is most text and all of the text
 * everything else here was tested against.
 */
function drawRunText(ctx, l, fill, { outlineOnly = false } = {}) {
  const lines = runLines(ctx, l)
  const lh = l.size * (l.lineHeight || 1.2)
  const startY = -l.h / 2
  const prevAlign = ctx.textAlign
  ctx.textAlign = 'left'

  lines.forEach((pieces, i) => {
    const widths = pieces.map((p) => {
      ctx.font = runFont(l, p.style)
      return ctx.measureText(p.text).width
    })
    const total = widths.reduce((a, b) => a + b, 0)
    // Alignment is a sum over the line now, the canvas having no idea the line
    // is made of several drawings.
    let x = l.align === 'center' ? -total / 2
      : l.align === 'right' ? l.w / 2 - total
        : -l.w / 2
    const y = startY + i * lh
    pieces.forEach((p, j) => {
      ctx.font = runFont(l, p.style)
      if (outlineOnly) {
        ctx.strokeStyle = l.outlineColor || p.style.color || l.color || '#fff'
        ctx.lineWidth = Math.max(0.5, l.outlineWidth ?? 2)
        ctx.lineJoin = 'round'
        ctx.strokeText(p.text, x, y)
      } else {
        if (l.strokeWidth > 0) {
          ctx.strokeStyle = withAlpha(l.stroke || '#000', l.strokeOpacity ?? 1)
          ctx.lineWidth = l.strokeWidth
          ctx.lineJoin = 'round'
          ctx.strokeText(p.text, x, y)
        }
        // A run that names no colour keeps the layer's, gradient and all — so a
        // gradient across a title still crosses the words that were left alone.
        ctx.fillStyle = p.style.color || fill
        ctx.fillText(p.text, x, y)
      }
      x += widths[j]
    })
  })
  ctx.textAlign = prevAlign
}

function drawTextLayer(ctx, l, { outlineOnly = false, only = null, skip = null } = {}) {
  ctx.save()
  ctx.globalAlpha = l.opacity ?? 1
  ctx.globalCompositeOperation = l.blend || 'source-over'
  ctx.translate(l.x + l.w / 2, l.y + l.h / 2)
  if (l.rotation) ctx.rotate(rad(l.rotation))
  ctx.font = fontFor(l)
  ctx.textBaseline = 'top'
  ctx.textAlign = l.align || 'left'
  // An auto-sized box already fits its content, so it must not re-wrap: the
  // measured width and the wrap width are the same number, and floating point
  // would drop the last word onto its own line.
  const lines = l.autoSize !== false
    ? String(l.text ?? '').split('\n')
    : wrapLines(ctx, l.text || '', l.w)
  const lh = l.size * (l.lineHeight || 1.2)
  const startY = -l.h / 2
  const ax = l.align === 'center' ? 0 : l.align === 'right' ? l.w / 2 : -l.w / 2

  // Worked out once for the whole layer rather than per line or per glyph: the
  // gradient runs across the text box, so a letter that happens to be drawn on
  // its own still takes the colour that belongs to where it sits. The context is
  // already centred and rotated on the box, so the line goes about the origin.
  const grad = gradientOf(l)
  const fill = paintFor(ctx, {
    from: l.color || '#fff', to: l.color2, angle: l.colorAngle,
    stop: grad?.stop, stop2: grad?.stop2, alpha: grad?.alpha, alpha2: grad?.alpha2,
    // Local: the context is already centred and turned on this layer's box.
    ...placeIn(l, l.gradBox, { local: true }),
  })

  // Styled in parts: a different loop entirely, and only for the layers that
  // ask for it.
  if (hasRuns(l)) {
    drawRunText(ctx, l, fill, { outlineOnly })
    ctx.restore()
    return
  }

  const paint = (text, x, y) => {
    if (outlineOnly) {
      ctx.strokeStyle = l.outlineColor || l.color || '#fff'
      ctx.lineWidth = Math.max(0.5, l.outlineWidth ?? 2)
      ctx.lineJoin = 'round'
      ctx.strokeText(text, x, y)
      return
    }
    if (l.strokeWidth > 0) {
      ctx.strokeStyle = withAlpha(l.stroke || '#000', l.strokeOpacity ?? 1)
      ctx.lineWidth = l.strokeWidth
      ctx.lineJoin = 'round'
      ctx.strokeText(text, x, y)
    }
    ctx.fillStyle = fill
    ctx.fillText(text, x, y)
  }

  // Whole-letter mode draws glyph by glyph so a covered letter can be left out
  // of one pass entirely and taken up by the other. Every other case draws the
  // line in one call, which keeps kerning and shaping exactly as the font
  // intends.
  if (only || skip) {
    const wanted = glyphBoxes(ctx, l, lines)
    const prevAlign = ctx.textAlign
    ctx.textAlign = 'left'
    for (const g of wanted) {
      const key = `${g.line}:${g.index}`
      if (only && !only.has(key)) continue
      if (skip && skip.has(key)) continue
      paint(g.char, g.drawX, g.y)
    }
    ctx.textAlign = prevAlign
    ctx.restore()
    return
  }

  lines.forEach((line, i) => paint(line, ax, startY + i * lh))
  ctx.restore()
}

let maskScratch = null
function scratchFor(w, h) {
  if (!maskScratch) maskScratch = document.createElement('canvas')
  if (maskScratch.width !== w || maskScratch.height !== h) {
    maskScratch.width = w
    maskScratch.height = h
  }
  return maskScratch
}

/**
 * Runs `draw` clipped to the layer's mask.
 *
 * With no feather this is a plain clip, which is exact and cheap. Feathered
 * masks need a soft alpha edge, so the layer is drawn to a scratch surface and
 * punched through with a blurred mask before being composited back.
 */
/**
 * Punches painted erase strokes out of whatever `draw` produced.
 *
 * Two passes, because "put back what an earlier stroke removed" cannot be
 * expressed in one: the erase strokes are subtracted, then the restore strokes
 * are used to stencil the original back in over the holes.
 */
function applyErase(ctx, l, draw, w, h) {
  const sc = eraseScratch('paint', w, h)
  const sctx = sc.getContext('2d')
  sctx.setTransform(1, 0, 0, 1, 0, 0)
  sctx.globalAlpha = 1
  sctx.globalCompositeOperation = 'source-over'
  sctx.filter = 'none'
  sctx.clearRect(0, 0, w, h)
  draw(sctx)

  sctx.save()
  sctx.globalCompositeOperation = 'destination-out'
  paintStrokes(sctx, l, l.erase.strokes, { restore: false })
  sctx.restore()

  if (hasRestore(l)) {
    // The restore pass needs a clean copy of the layer to stencil from, so it
    // is drawn again into a second surface and masked down to the strokes.
    const back = eraseScratch('restore', w, h)
    const bctx = back.getContext('2d')
    bctx.setTransform(1, 0, 0, 1, 0, 0)
    bctx.globalAlpha = 1
    bctx.globalCompositeOperation = 'source-over'
    bctx.filter = 'none'
    bctx.clearRect(0, 0, w, h)
    draw(bctx)
    bctx.save()
    bctx.globalCompositeOperation = 'destination-in'
    paintStrokes(bctx, l, l.erase.strokes, { restore: true })
    bctx.restore()
    sctx.drawImage(back, 0, 0)
  }

  ctx.drawImage(sc, 0, 0)
}

// Erasing needs its own surfaces, not the mask's. A feathered mask inside an
// erased layer would otherwise draw into the very canvas being composited from.
const erasePool = new Map()
function eraseScratch(key, w, h) {
  let c = erasePool.get(key)
  if (!c) {
    c = document.createElement('canvas')
    erasePool.set(key, c)
  }
  if (c.width !== w || c.height !== h) {
    c.width = w
    c.height = h
  }
  return c
}

/**
 * Draws the layer with its clone strokes stamped over it.
 *
 * The picture has to be built once before anything is cloned, because a stroke
 * samples it: painting straight onto the destination would let a later stroke
 * pick up an earlier one and smear the copy along itself.
 */
/** Whether a layer is being recoloured at all. */
export const hasTint = (l) => !!l?.tint?.on && (l.tint.amount ?? 1) > 0.001

/**
 * Runs `draw`, then recolours what it drew.
 *
 * The case this is for: a logo that arrives black and has to be white. Invert
 * would do it and flips every other colour on the way past; a hue rotation
 * cannot reach white from black at all, because black has no hue to turn. What
 * you want is to keep the shape exactly — every soft edge, every bit of
 * anti-aliasing — and say what colour it is.
 *
 * So the layer is drawn to a scratch surface and the colour is painted over it
 * through `source-atop`, which paints only where something was already drawn and
 * leaves the alpha alone. At full strength that is a flat recolour; below it,
 * the original shows through and the effect is a wash rather than a replacement.
 */
function withTint(ctx, l, draw) {
  if (!hasTint(l)) { draw(ctx); return }
  const w = ctx.canvas.width
  const h = ctx.canvas.height
  const sc = eraseScratch('tint', w, h)
  const sx = sc.getContext('2d')
  sx.setTransform(1, 0, 0, 1, 0, 0)
  sx.globalAlpha = 1
  sx.globalCompositeOperation = 'source-over'
  sx.filter = 'none'
  sx.clearRect(0, 0, w, h)
  draw(sx)

  sx.save()
  sx.setTransform(1, 0, 0, 1, 0, 0)
  // Only where the layer already put something, and without touching how much
  // of it there is: the letter keeps its soft edge and simply changes colour.
  sx.globalCompositeOperation = 'source-atop'
  sx.globalAlpha = Math.max(0, Math.min(1, l.tint.amount ?? 1))
  sx.fillStyle = l.tint.color || '#ffffff'
  sx.fillRect(0, 0, w, h)
  sx.restore()

  ctx.save()
  ctx.setTransform(1, 0, 0, 1, 0, 0)
  ctx.drawImage(sc, 0, 0)
  ctx.restore()
}

function withClone(ctx, l, draw) {
  if (!hasClone(l)) { draw(ctx); return }
  const w = ctx.canvas.width
  const h = ctx.canvas.height
  const base = eraseScratch('clone-base', w, h)
  const bx = base.getContext('2d')
  bx.setTransform(1, 0, 0, 1, 0, 0)
  bx.globalAlpha = 1
  bx.globalCompositeOperation = 'source-over'
  bx.filter = 'none'
  bx.clearRect(0, 0, w, h)
  draw(bx)

  const out = eraseScratch('clone-out', w, h)
  const ox = out.getContext('2d')
  ox.setTransform(1, 0, 0, 1, 0, 0)
  ox.globalAlpha = 1
  ox.globalCompositeOperation = 'source-over'
  ox.filter = 'none'
  ox.clearRect(0, 0, w, h)
  ox.drawImage(base, 0, 0)
  // A pool of its own: the stroke stencil cannot share a surface with the
  // picture it is sampling from.
  paintClone(ox, l, base, l.clone.strokes, (cw, ch) => eraseScratch('clone-mask', cw, ch))
  ctx.drawImage(out, 0, 0)
}

/**
 * Draws a clip on its way in or out of black.
 *
 * A fade dims the picture *to black*, which is not the same as making it
 * transparent: transparent shows whatever is behind, and at the start of a video
 * that is usually nothing at all, so it happened to look right — but a clip over
 * other footage faded into the footage rather than to black, which is not what
 * "fade to black" means anywhere else.
 *
 * The black lands only where the clip has pixels. It is composited `source-atop`
 * inside a scratch surface holding the clip alone, so a cutout fades to black
 * without a black rectangle appearing around it, and nothing under the clip is
 * touched. Painting the layer's box would have been three lines and wrong for
 * every layer that is not a full rectangle.
 */
function withDim(ctx, l, k, draw) {
  if (k <= 0) { draw(ctx); return }
  const w = ctx.canvas.width
  const h = ctx.canvas.height
  const sc = eraseScratch('dim', w, h)
  const sx = sc.getContext('2d')
  sx.setTransform(1, 0, 0, 1, 0, 0)
  sx.globalAlpha = 1
  sx.globalCompositeOperation = 'source-over'
  sx.filter = 'none'
  sx.clearRect(0, 0, w, h)

  draw(sx)

  sx.save()
  sx.globalCompositeOperation = 'source-atop'
  sx.globalAlpha = Math.min(1, k)
  sx.fillStyle = '#000000'
  sx.fillRect(0, 0, w, h)
  sx.restore()

  ctx.drawImage(sc, 0, 0)
}

function withMask(ctx, l, draw) {
  // A sticker has already folded the mask and the erase strokes into the shape
  // it grew its border from. Applying them a second time here would cut that
  // border back off again, since it deliberately extends beyond the artwork.
  if (stickerBakes(l)) { withClone(ctx, l, draw); return }
  // Erasing wraps the mask rather than the other way round: the mask decides
  // the shape, the eraser then takes bites out of what is left. Cloning is
  // innermost of all: it repairs the picture, and the mask and the eraser then
  // decide how much of the repaired picture is kept.
  const cloned = (c) => withClone(c, l, draw)
  if (hasErase(l)) {
    const inner = (c) => withMaskOnly(c, l, cloned)
    applyErase(ctx, l, inner, ctx.canvas.width, ctx.canvas.height)
    return
  }
  withMaskOnly(ctx, l, cloned)
}

function withMaskOnly(ctx, l, draw) {
  if (!hasMask(l)) { draw(ctx); return }
  const feather = l.mask.feather || 0

  if (feather <= 0) {
    ctx.save()
    ctx.beginPath()
    if (l.mask.invert) {
      ctx.rect(0, 0, ctx.canvas.width, ctx.canvas.height)
      addMaskPath(ctx, l)
      ctx.clip('evenodd')
    } else {
      addMaskPath(ctx, l)
      ctx.clip()
    }
    draw(ctx)
    ctx.restore()
    return
  }

  const w = ctx.canvas.width
  const h = ctx.canvas.height
  const sc = scratchFor(w, h)
  const sctx = sc.getContext('2d')
  sctx.setTransform(1, 0, 0, 1, 0, 0)
  sctx.globalAlpha = 1
  sctx.globalCompositeOperation = 'source-over'
  sctx.filter = 'none'
  sctx.clearRect(0, 0, w, h)
  draw(sctx)

  sctx.save()
  sctx.globalCompositeOperation = 'destination-in'
  sctx.filter = `blur(${feather}px)`
  sctx.fillStyle = '#fff'
  sctx.beginPath()
  if (l.mask.invert) {
    sctx.rect(-feather * 4, -feather * 4, w + feather * 8, h + feather * 8)
    addMaskPath(sctx, l)
    sctx.fill('evenodd')
  } else {
    addMaskPath(sctx, l)
    sctx.fill()
  }
  sctx.restore()

  ctx.drawImage(sc, 0, 0)
}

/**
 * The box each group-spanning gradient measures itself against, by parent.
 *
 * Null when nothing asks for one, so the ordinary case costs a filter over the
 * layer list and nothing else. Members are resolved at the current time because
 * the box has to follow animation: a word that slides across the frame drags the
 * shared ramp with it, which is what makes a gradient sweeping over a title read
 * as one gradient rather than as each word doing its own thing.
 */
function spansFor(layers, time, groups) {
  const want = layers.filter((l) => l.gradientSpan === 'group' && l.parentId)
  if (!want.length) return null
  const out = new Map()
  for (const parent of new Set(want.map((l) => l.parentId))) {
    const ids = new Set(descendantIds(layers, parent))
    const members = layers
      .filter((l) => ids.has(l.id) && !isGroup(l) && groups.visible.get(l.id))
      .map((l) => resolveLayer(l, time))
    const box = gradientBox({ gradientSpan: 'group' }, members)
    if (box) out.set(parent, box)
  }
  return out.size ? out : null
}

function paintLayer(ctx, l, time) {
  if (l.type === 'image') drawImageLayer(ctx, l, time)
  else if (l.type === 'shape') drawShapeLayer(ctx, l)
  else if (l.type === 'text') drawTextLayer(ctx, l)
}

/**
 * Stamps the layer as it was a few moments ago, at decaying opacity.
 *
 * The echoes are resolved from the *unresolved* layer, so they follow the real
 * keyframed motion rather than a guessed offset — which is why this works
 * equally on a tracked cutout, a moving shape and an animated GIF. Echoes are
 * painted oldest first so newer ones sit on top, and they are drawn through
 * `paintLayer` rather than the main loop so a trail can never spawn its own.
 */
function drawTrails(ctx, raw, l, time, groupAlpha) {
  const tr = l.trails
  const count = Math.max(0, Math.min(24, Math.round(tr.count || 0)))
  const gap = Math.max(1, tr.gapMs || 60)
  const fade = Math.min(0.99, Math.max(0.05, tr.fade ?? 0.6))
  const shrink = tr.scale ?? 1

  for (let i = count; i >= 1; i--) {
    const t = time - gap * i
    // Before the start of the timeline nothing has happened yet, so the trail
    // builds up rather than wrapping round to the end.
    if (t < 0) continue
    const past = resolveLayer(raw, t)
    const alpha = (past.opacity ?? 1) * groupAlpha * Math.pow(fade, i)
    if (alpha < 0.012) continue

    const e = { ...past, opacity: alpha, trails: null, sticker: past.sticker }
    if (shrink !== 1) {
      const k = Math.pow(shrink, i)
      const cx = past.x + past.w / 2
      const cy = past.y + past.h / 2
      e.w = past.w * k
      e.h = past.h * k
      e.x = cx - e.w / 2
      e.y = cy - e.h / 2
      if (typeof past.size === 'number') e.size = past.size * k
    }
    withMask(ctx, e, (c) => paintLayer(c, e, t))
    ctx.filter = 'none'
    ctx.globalAlpha = 1
    ctx.globalCompositeOperation = 'source-over'
  }
}

/**
 * The other effect layers standing at this time — what an inverted effect has
 * to keep its hands off. Resolved at `time`, because a shape that is being
 * keyframed across the frame protects where it is now, not where it started.
 */
function otherEffects(doc, self, time, groups) {
  const out = []
  for (const raw of doc.layers) {
    if (raw.id === self.id || raw.type !== 'effect') continue
    if (groups && !groups.visible.get(raw.id)) continue
    if (!onScreen(raw, time)) continue
    out.push(resolveLayer(raw, time))
  }
  return out
}

export function renderDocument(ctx, doc, time) {
  const { width, height } = doc
  // The covered-glyph memo is per render. Nested renders (the coverage probe
  // calls back into here) must not clobber the outer one's cache.
  const outerHidden = hiddenCache
  hiddenCache = new Map()
  try {
    renderDocumentInner(ctx, doc, time)
  } finally {
    hiddenCache = outerHidden
  }
}

function renderDocumentInner(ctx, doc, time) {
  const { width, height } = doc
  ctx.setTransform(1, 0, 0, 1, 0, 0)
  ctx.globalAlpha = 1
  ctx.globalCompositeOperation = 'source-over'
  ctx.filter = 'none'
  ctx.clearRect(0, 0, width, height)

  if (doc.background && doc.background !== 'transparent') {
    ctx.fillStyle = doc.background
    ctx.fillRect(0, 0, width, height)
  }

  const groups = resolveGroups(doc.layers)

  // Text that names a layer it should show through is drawn *around* that
  // layer, wherever the layer happens to sit. If the named layer is stacked
  // below the text, the text's fill is brought down to just before it — being
  // covered is the whole point, and demanding the user reorder their layers
  // first would make the setting a lie for half the list.
  const pulledDown = new Map()
  for (let i = 0; i < doc.layers.length; i++) {
    const t = doc.layers[i]
    if (t.type !== 'text' || !t.outlineAbove || t.outlineAbove === 'all' || t.outlineAbove === true) continue
    const j = doc.layers.findIndex((x) => x.id === t.outlineAbove)
    if (j < 0 || j > i) continue        // already below it; nothing to move
    if (!pulledDown.has(t.outlineAbove)) pulledDown.set(t.outlineAbove, [])
    pulledDown.get(t.outlineAbove).push(t.id)
  }
  const drawnEarly = new Set()

  // Where a gradient set to span its group measures itself. Worked out once for
  // the whole frame rather than per layer, because every member of a group has
  // to be handed the same box or the ramp steps between them — which is the
  // thing spanning a group is for.
  const spans = spansFor(doc.layers, time, groups)

  // Transitions. The overlap between two clips on one track is the transition,
  // so the plan is read off the arrangement rather than stored anywhere: there
  // is no object at the join to keep in step with the clips either side of it.
  const assetFor = (l) => getAsset(l.assetId)
  const pairs = pairsIn(doc.layers, assetFor)
  const mixing = pairs.length ? stateAt(doc.layers, assetFor, time) : EMPTY_MIX
  // Outgoing first: the dissolve maths needs the incoming clip to land on top.
  const order = pairs.length ? orderForTransitions(doc.layers, pairs) : doc.layers

  for (const raw of order) {
    if (isGroup(raw)) continue          // groups paint nothing of their own
    if (!groups.visible.get(raw.id)) continue
    // A clip is only on screen for its own span. This is the cut.
    if (!onScreen(raw, time)) continue

    for (const id of pulledDown.get(raw.id) || []) {
      const t = doc.layers.find((x) => x.id === id)
      if (!t || !groups.visible.get(t.id) || !onScreen(t, time)) continue
      drawnEarly.add(t.id)
      drawTextInPlace(ctx, doc, t, time, groups)
    }
    if (drawnEarly.has(raw.id) && raw.type === 'text') {
      // Already drawn, lower down; only its outline is still to come.
      for (const t of doc.layers) {
        if (t.type !== 'text' || t.outlineAbove !== raw.id) continue
        if (!groups.visible.get(t.id)) continue
        drawOutlinePass(ctx, t, time, groups, doc)
      }
      continue
    }
    const groupAlpha = groups.opacity.get(raw.id) ?? 1
    const resolved = resolveLayer(raw, time)
    const mix = mixing.get(raw.id)
    const draw = mix ? drawFor(mix.kind, mix.role, mix.p) : null
    // A clip that has faded all the way out is not drawn at all rather than
    // drawn at zero: an invisible layer still costs a video frame decode.
    if (draw && draw.alpha <= 0) continue
    // A clip's own fade at its ends — but not where a transition is already
    // doing that job. Both attenuate the same clip over the same instants, and
    // applying both does not fade harder, it breaks the frame: the dissolve
    // holds together only because the outgoing clip stays solid, so dimming it
    // as well leaves the pair summing to less than one and the picture goes
    // translucent. Fading a clip and then dragging its neighbour over it is an
    // ordinary way to arrive there.
    //
    // `dim` rather than alpha: this is a fade to black, and the difference shows
    // the moment there is anything underneath.
    const dim = mix || !hasFade(raw)
      ? 0
      : 1 - fadeAlphaAt(resolved, time, getAsset(raw.assetId))
    const alpha = (resolved.opacity ?? 1) * groupAlpha * (draw ? draw.alpha : 1)
    let l = alpha === (resolved.opacity ?? 1)
      ? resolved
      : { ...resolved, opacity: alpha }
    const span = spans?.get(raw.parentId || null)
    if (span) l = { ...l, gradBox: span }
    // A wipe uncovers the incoming clip across the frame, so it is drawn whole
    // and shown through a growing window rather than faded.
    if (draw?.reveal) {
      const r = revealRect(draw.reveal, width, height)
      ctx.save()
      ctx.beginPath()
      ctx.rect(r.x, r.y, r.w, r.h)
      ctx.clip()
    }

    if (l.type === 'effect') {
      // Effect layers read the canvas beneath them, so they cannot be drawn
      // into a detached scratch surface; their shape already does the masking.
      // An inverted one is handed the other effect layers on screen so it can
      // leave their territory alone — see applyEffectLayer.
      applyEffectLayer(ctx, ctx.canvas, l, l.invert ? otherEffects(doc, l, time, groups) : [])
    } else if (l.freeze?.on && l.type === 'image' && hasMask(l)) {
      // Cinemagraph: the whole layer is painted at one frozen instant, then the
      // masked region alone is repainted live on top. Two ordinary draws — the
      // mask machinery and the frame sampling both already exist.
      withDim(ctx, l, dim, (c) => {
        paintLayer(c, { ...l, mask: null }, l.freeze.time || 0)
        c.filter = 'none'
        c.globalAlpha = 1
        c.globalCompositeOperation = 'source-over'
        withMask(c, l, (cc) => paintLayer(cc, l, time))
      })
    } else if (l.type === 'text' && l.outlineAbove && l.outlineWhole) {
      // Letters that something in front will hide are left out here and drawn
      // as complete outlines in the second pass, so a letter is never half
      // solid and half outline.
      const skip = hiddenSetFor(ctx, doc, l, time)
      withDim(ctx, l, dim, (c) => withMask(c, l, (cc) => drawTextLayer(cc, l, { skip })))
    } else {
      if (l.trails?.on) drawTrails(ctx, raw, l, time, groupAlpha)
      withDim(ctx, l, dim, (c) => withMask(c, l, (cc) => withTint(cc, l, (c3) => paintLayer(c3, l, time))))
    }
    if (draw?.reveal) ctx.restore()
    ctx.filter = 'none'
    ctx.globalAlpha = 1
    ctx.globalCompositeOperation = 'source-over'

    // A dip goes through a colour, and the colour is laid over the clip's own
    // box rather than the whole canvas: dipping one track to black should not
    // black out a title sitting on another one.
    if (draw?.veil && draw.veil.alpha > 0) {
      const b = veilBox(l)
      ctx.save()
      ctx.globalAlpha = Math.min(1, draw.veil.alpha)
      ctx.fillStyle = draw.veil.colour
      ctx.fillRect(b.x, b.y, b.w, b.h)
      ctx.restore()
      ctx.globalAlpha = 1
    }

    // Any text aimed at *this* layer gets its outline now, immediately on top
    // of it — which is what "outline above the woman" has to mean if anything
    // drawn later is still allowed to cover both.
    for (const t of doc.layers) {
      if (t.type !== 'text' || t.outlineAbove !== raw.id) continue
      if (!groups.visible.get(t.id)) continue
      drawOutlinePass(ctx, t, time, groups, doc)
    }
  }

  // Text set to keep its outline visible, drawn stroke-only over the top. Only
  // the ones aimed at everything are left for here; the rest were drawn during
  // the loop, right after the layer they are meant to show through.
  for (const raw of doc.layers) {
    // `true` is the older spelling of "above everything" and still means it:
    // a project saved before the target dropdown existed must not silently
    // lose its outline.
    if (raw.type !== 'text') continue
    if (raw.outlineAbove !== 'all' && raw.outlineAbove !== true) continue
    if (!groups.visible.get(raw.id)) continue
    if (!onScreen(raw, time)) continue
    drawOutlinePass(ctx, raw, time, groups, doc)
  }
}

/**
 * The outline pass for one text layer.
 *
 * Stroke-only, so over the solid text it is the same colour and disappears, and
 * over whatever is covering the text it is all you see. One editable text layer
 * does both jobs rather than two copies that have to be kept in step.
 */
/**
 * Outlines the *silhouette* of some text, not its glyph paths.
 *
 * `strokeText` strokes every contour a glyph is built from. Many faces build a
 * letter out of overlapping pieces — an A as two diagonals and a crossbar — so
 * stroking it draws the seams where those pieces meet, and the letter comes out
 * looking like three outlined bars rather than one outlined A.
 *
 * Filling has no such problem: overlapping contours merge into one shape. So
 * the letters are filled into a scratch surface, that silhouette is dilated by
 * stamping it around a circle, and the original is punched back out. What is
 * left is a ring around the merged shape — one clean outline per letter, with
 * no internal seams, whatever the font is made of.
 */
function strokeSilhouette(ctx, l, width, colour, drawFill) {
  const w = ctx.canvas.width
  const h = ctx.canvas.height
  const r = Math.max(0.5, width)

  const solid = outlineScratch('solid', w, h)
  const sctx = solid.getContext('2d')
  sctx.setTransform(1, 0, 0, 1, 0, 0)
  sctx.globalAlpha = 1
  sctx.globalCompositeOperation = 'source-over'
  sctx.filter = 'none'
  sctx.clearRect(0, 0, w, h)
  drawFill(sctx)

  const ring = outlineScratch('ring', w, h)
  const rctx = ring.getContext('2d')
  rctx.setTransform(1, 0, 0, 1, 0, 0)
  rctx.globalAlpha = 1
  rctx.globalCompositeOperation = 'source-over'
  rctx.filter = 'none'
  rctx.clearRect(0, 0, w, h)
  // Enough stamps that the dilation is round rather than polygonal; more for a
  // thicker outline, since the gaps between stamps grow with the radius.
  const steps = Math.max(12, Math.min(64, Math.round(r * 6)))
  for (let i = 0; i < steps; i++) {
    const a = (i / steps) * Math.PI * 2
    rctx.drawImage(solid, Math.cos(a) * r, Math.sin(a) * r)
  }
  // The outline sits outside the letter, so a letter that switches to outline
  // keeps the width it had rather than shrinking inside its own stroke.
  rctx.globalCompositeOperation = 'destination-out'
  rctx.drawImage(solid, 0, 0)
  rctx.globalCompositeOperation = 'source-in'
  rctx.fillStyle = colour
  rctx.fillRect(0, 0, w, h)
  rctx.globalCompositeOperation = 'source-over'

  ctx.save()
  ctx.globalAlpha = l.opacity ?? 1
  ctx.drawImage(ring, 0, 0)
  ctx.restore()
}

const outlinePool = new Map()
function outlineScratch(key, w, h) {
  let c = outlinePool.get(key)
  if (!c) {
    c = document.createElement('canvas')
    outlinePool.set(key, c)
  }
  if (c.width !== w || c.height !== h) {
    c.width = w
    c.height = h
  }
  return c
}

/** A text layer's fill, with covered letters left out in whole-letter mode. */
function drawTextInPlace(ctx, doc, raw, time, groups) {
  const groupAlpha = groups.opacity.get(raw.id) ?? 1
  const resolved = resolveLayer(raw, time)
  const l = groupAlpha === 1
    ? resolved
    : { ...resolved, opacity: (resolved.opacity ?? 1) * groupAlpha }
  const skip = l.outlineAbove && l.outlineWhole ? hiddenSetFor(ctx, doc, l, time) : null
  withMask(ctx, l, (c) => drawTextLayer(c, l, { skip }))
  ctx.filter = 'none'
  ctx.globalAlpha = 1
  ctx.globalCompositeOperation = 'source-over'
}

function drawOutlinePass(ctx, raw, time, groups, doc) {
  const groupAlpha = groups.opacity.get(raw.id) ?? 1
  const resolved = resolveLayer(raw, time)
  const l = groupAlpha === 1
    ? resolved
    : { ...resolved, opacity: (resolved.opacity ?? 1) * groupAlpha }
  // In whole-letter mode only the hidden letters are stroked, because the rest
  // were drawn solid and complete in the main pass.
  const only = l.outlineWhole && doc ? hiddenSetFor(ctx, doc, l, time) : null
  // Filled into a scratch surface and ringed, rather than stroked directly —
  // see strokeSilhouette for why stroking the glyphs themselves is wrong.
  withMask(ctx, l, (c) => strokeSilhouette(
    c,
    l,
    Math.max(0.5, l.outlineWidth ?? 2),
    l.outlineColor || l.color || '#fff',
    (sc) => drawTextLayer(sc, { ...l, opacity: 1, strokeWidth: 0, color: '#fff' }, { only }),
  ))
  ctx.filter = 'none'
  ctx.globalAlpha = 1
  ctx.globalCompositeOperation = 'source-over'
}

/**
 * The covered-glyph set for a layer, computed once per render.
 *
 * Both passes need the same answer and each would otherwise re-render the
 * covering layers to get it, so the result is memoised for the duration of one
 * renderDocument call.
 */
let hiddenCache = null
function hiddenSetFor(ctx, doc, l, time) {
  if (hiddenCache?.has(l.id)) return hiddenCache.get(l.id)
  if (!measureCtx) measureCtx = document.createElement('canvas').getContext('2d')
  measureCtx.font = fontFor(l)
  const set = coveredGlyphs(measureCtx, doc, l, time, l.outlineAbove, l.outlineThreshold ?? 0.35)
  if (hiddenCache) hiddenCache.set(l.id, set)
  return set
}

/**
 * Frame boundaries for export. When every animated source is frame-decoded we
 * emit the exact union of their frame starts, which preserves original GIF
 * timing. Otherwise (or when that gets silly) we fall back to fixed fps.
 */
export function sampleTimes(doc, duration, fps, maxFrames = 400) {
  if (duration <= 0) return { times: [0], exact: true }
  const set = new Set([0])
  let exact = true
  let hasFrames = false
  const groups = resolveGroups(doc.layers)
  for (const l of doc.layers) {
    if (!groups.visible.get(l.id)) continue
    for (const t of allKeyTimes(l)) if (t < duration) set.add(t)
    if (l.type !== 'image') continue
    const a = getAsset(l.assetId)
    if (!a) continue
    if (a.live) { exact = false; continue }
    if (!a.animated) continue
    hasFrames = true
    const sp = l.speed || 1
    const off = l.timeOffset || 0
    // A repaired loop no longer lines up with the source frame boundaries — a
    // ping-pong runs them backwards and a crossfade invents blends between
    // them — so those exports are sampled at a steady rate instead of claiming
    // a frame-exact timeline they do not have.
    if (l.loop?.on && l.loop.mode && l.loop.mode !== 'none') { exact = false; continue }
    const cycle = a.duration / sp
    for (let rep = 0; off + rep * cycle < duration && rep < 500; rep++) {
      for (let k = 0; k < a.frames.length; k++) {
        const start = off + (rep * a.duration + (k ? a.cum[k - 1] : 0)) / sp
        if (start >= 0 && start < duration - 0.5) set.add(Math.round(start * 100) / 100)
      }
    }
  }
  // Keyframe times rarely land on a GIF frame boundary; collapse anything that
  // would produce a sub-20ms gap, since GIF cannot represent those and clamping
  // them would stretch the total duration.
  let times = [...set].sort((a, b) => a - b)
    .reduce((acc, t) => {
      if (!acc.length || t - acc[acc.length - 1] >= 20) acc.push(t)
      return acc
    }, [])
  // Without real media frames, keyframe times alone would export two frames and
  // skip the tween entirely — sample at a steady rate instead.
  if (!hasFrames) exact = false
  if (!exact || times.length > maxFrames || times.length < 2) {
    const step = 1000 / Math.max(1, fps)
    const n = Math.min(maxFrames, Math.max(1, Math.round(duration / step)))
    times = Array.from({ length: n }, (_, i) => (i * duration) / n)
    exact = false
  }
  return { times, exact }
}
