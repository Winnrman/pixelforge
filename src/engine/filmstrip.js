// Low-resolution thumbnails for the timeline.
//
// The point of a filmstrip is to find a moment by eye, which needs far less
// than full resolution — these are 44px tall, a few kilobytes each. That matters
// more than it sounds: the video decoder keeps a *pixel-budgeted* LRU of full
// frames for playback, and pulling twenty spread-out full frames out of a 90s
// clip would evict everything the playhead needs. Thumbnails are downscaled the
// moment they arrive and kept in their own cache, which never expires because
// it costs so little to hold.
import { getAsset } from './assets.js'
import { assetTimeFor, clipRange } from './clips.js'
import { frameIndexAt } from './render.js'
import { exactFrame, frameAt, indexAt } from './video.js'

export const THUMB_H = 60

// asset -> Map(rounded ms -> canvas). Weak on the asset so closing a project
// lets the whole strip go.
const cache = new WeakMap()

function bucketFor(asset) {
  let m = cache.get(asset)
  if (!m) {
    m = new Map()
    cache.set(asset, m)
  }
  return m
}

export function thumbWidth(asset, h = THUMB_H) {
  if (!asset?.height) return h
  return Math.max(1, Math.round((asset.width / asset.height) * h))
}

function downscale(src, h) {
  const w = Math.max(1, Math.round(((src.width || src.naturalWidth) / (src.height || src.naturalHeight)) * h))
  const c = document.createElement('canvas')
  c.width = w
  c.height = h
  const ctx = c.getContext('2d')
  ctx.imageSmoothingEnabled = true
  ctx.imageSmoothingQuality = 'low'
  ctx.drawImage(src, 0, 0, w, h)
  return c
}

/** A thumbnail already in hand, or null. Never decodes. */
/** How the cache is doing. A cut should be all hits: it is the same frames, in
 *  two boxes instead of one. */
export const thumbStats = { hits: 0, built: 0 }
export const resetThumbStats = () => { thumbStats.hits = 0; thumbStats.built = 0 }

export function cachedThumb(asset, ms, h = THUMB_H) {
  const hit = bucketFor(asset).get(key(asset, ms, h)) || null
  if (hit) thumbStats.hits++
  return hit
}

/**
 * The nearest thumbnail already in hand, for painting *now*.
 *
 * Keying by frame stops most of the rebuilding across a cut, but not all of it:
 * the two halves of a split get their own slot counts across their own widths,
 * so some centres land a frame or two off the ones the whole clip sampled. Those
 * are genuinely different pictures and have to be made — but there is no reason
 * to show a hole while they are.
 *
 * So a strip paints the closest frame it already has and replaces it when the
 * real one arrives. A cut then looks like what it is, one clip in two boxes,
 * rather than two strips rebuilding from nothing. The bound keeps it honest: a
 * frame from somewhere else entirely is worse than a gap.
 */
export function nearestThumb(asset, ms, h = THUMB_H, within = 12) {
  const bucket = bucketFor(asset)
  const want = frameKey(asset, ms)
  const kind = want[0]
  const idx = Number(want.slice(1))
  if (!Number.isFinite(idx)) return bucket.get(`${want}|${h}`) || null
  for (let d = 1; d <= within; d++) {
    const a = bucket.get(`${kind}${idx - d}|${h}`)
    if (a) return a
    const b = bucket.get(`${kind}${idx + d}|${h}`)
    if (b) return b
  }
  return null
}

/**
 * Thumbnails are cached by *frame*, not by millisecond.
 *
 * Both branches below resolve a time to a frame and draw that — so two requests
 * a millisecond apart usually produce the identical picture, and keying by the
 * millisecond stored it twice and decoded it twice. It showed up on a cut: the
 * two halves of a split clip sample at the centres of their own slots, which are
 * new times to the millisecond, so every thumbnail in a strip that had just been
 * drawn was thrown away and decoded again. Keyed by the frame they land on, a cut
 * costs nothing — the pictures are already there.
 */
function frameKey(asset, ms) {
  if (asset.isVideo) {
    const d = asset.duration || 1
    return 'v' + indexAt(asset, ((ms % d) + d) % d)
  }
  if (asset.frames?.length) return 'f' + frameIndexAt(asset, ms)
  return 's'
}

const key = (asset, ms, h) => `${frameKey(asset, ms)}|${h}`

/**
 * One thumbnail, decoding if it has to.
 *
 * GIF frames are already in memory so this resolves immediately; video has to
 * seek, which is why callers walk the strip one frame at a time rather than
 * asking for twenty at once.
 */
export async function thumbAt(asset, ms, h = THUMB_H) {
  const bucket = bucketFor(asset)
  const k = key(asset, ms, h)
  const hit = bucket.get(k)
  if (hit) return hit

  let src = null
  if (asset.isVideo) {
    const d = asset.duration || 1
    src = await exactFrame(asset, ((ms % d) + d) % d)
    // A seek can miss on a clip whose tail is unreadable; a neighbouring frame
    // is a better filmstrip than a gap.
    if (!src) src = frameAt(asset, ((ms % d) + d) % d)
  } else if (asset.frames?.length) {
    src = asset.frames[frameIndexAt(asset, ms)]?.bitmap
  } else if (asset.el) {
    src = asset.el
  }
  if (!src) return null

  const thumb = downscale(src, h)
  bucket.set(k, thumb)
  thumbStats.built++
  return thumb
}

/**
 * The times a strip should show for one layer, in *document* time.
 *
 * Spacing is driven by how many thumbnails fit across the lane, not by the
 * clip's frame count — a 2000-frame video and a 12-frame GIF both want about
 * one thumbnail per thumbnail-width of screen.
 */
export function stripTimes(layer, asset, elWidth, duration, h = THUMB_H, window = null) {
  if (!asset || !(duration > 0) || !(elWidth > 0)) return []
  // The span of document time the strip covers. For a clip that is the clip's
  // own range, not the whole document — the strip *is* the clip, so it shows
  // what the clip plays and nothing else. Trimming re-slices it, which is what
  // lets you see where a trim is landing instead of guessing.
  const from = window ? window.from : 0
  const to = window ? window.to : duration
  const span = Math.max(1, to - from)
  const tw = thumbWidth(asset, h)
  const n = Math.max(1, Math.min(60, Math.ceil(elWidth / tw)))
  const out = []
  for (let i = 0; i < n; i++) {
    // Sampled at the centre of each slot, so a thumbnail represents the span it
    // is drawn over rather than its leading edge.
    const docT = from + ((i + 0.5) / n) * span
    out.push({
      i,
      x: (i / n) * elWidth,
      w: elWidth / n,
      docT,
      assetT: assetTimeFor(layer, docT, asset),
    })
  }
  return out
}

/** Everything with a filmstrip worth drawing, innermost layer first. */
export function stripLayers(doc) {
  const out = []
  for (const l of doc.layers) {
    if (l.type !== 'image') continue
    const a = getAsset(l.assetId)
    if (!a?.animated) continue
    out.push({ layer: l, asset: a })
  }
  return out
}

/**
 * Where a strip sits on the document timeline, as a fraction of it.
 *
 * A clip occupies its own span; anything unclipped fills the whole width,
 * because that is genuinely how long it is on screen.
 */
export function stripWindow(layer, asset, duration) {
  const d = Math.max(1, duration)
  if (!layer.clip) return { from: 0, to: d, left: 0, width: 1, clipped: false }
  const r = clipRange(layer, asset)
  return {
    from: r.start,
    to: r.end,
    left: Math.max(0, Math.min(1, r.start / d)),
    // A floor, so a very short clip in a long project is still big enough to grab.
    width: Math.max(0.004, Math.min(1, r.length / d)),
    clipped: true,
  }
}
