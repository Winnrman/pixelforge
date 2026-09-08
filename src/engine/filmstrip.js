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
import { exactFrame, frameAt, indexAt, decodeThumbs, decodeKeyframes } from './video.js'

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
/**
 * Thumbnails are cached by *frame*, not by millisecond.
 *
 * Both branches of `thumbAt` resolve a time to a frame and draw that — so two
 * requests a millisecond apart usually produce the identical picture, and keying
 * by the millisecond stored it twice and made it twice.
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

/** How the cache is doing. A cut should be all hits: it is the same frames, in
 *  two boxes instead of one. */
export const thumbStats = { hits: 0, built: 0 }
export const resetThumbStats = () => { thumbStats.hits = 0; thumbStats.built = 0 }

/** Throws away an asset's thumbnails. Only the suite needs this — the cache is
 *  meant to be permanent, because it costs almost nothing to hold. */
export const thumbCount = (asset) => (cache.get(asset)?.size ?? -1)

export function forgetThumbs(asset) {
  const b = cache.get(asset)
  if (!b) return
  for (const v of b.values()) v?.c?.close?.()
  b.clear()
}

export function cachedThumb(asset, ms, h = THUMB_H) {
  const hit = bucketFor(asset).get(key(asset, ms, h)) || null
  if (hit) thumbStats.hits++
  return hit ? hit.c : null
}

/**
 * The nearest thumbnail already in hand, and how far off it is.
 *
 * Keying by frame stops the rebuilding on a short clip, where the halves of a
 * split land on the same frames. It does nothing on a long one: a 90-second clip
 * gets a thumbnail every six seconds, so the halves sample instants that are
 * genuinely seconds apart and every slot is a fresh seek.
 *
 * What matters is not the frame index but how far off in *time* the nearest
 * picture is, measured against how much time a slot covers. A thumbnail is one
 * frame standing for the whole span it is drawn over, so a cached frame less
 * than half a slot away is not an approximation of the right picture — it is a
 * picture that was already standing for that span a moment ago, at almost the
 * same place on screen. Searching by index instead is what made the first
 * version useless here: twelve frames is four tenths of a second, and the slots
 * were six seconds apart.
 *
 * Unbounded by default, and the caller decides what is close enough, because
 * "close enough" is a property of the strip's scale rather than of the cache.
 */
export function nearestThumb(asset, ms, h = THUMB_H, within = Infinity) {
  let best = null
  let bestDelta = Infinity
  for (const v of bucketFor(asset).values()) {
    if (v.h !== h) continue
    const d = Math.abs(v.ms - ms)
    if (d < bestDelta) { bestDelta = d; best = v }
  }
  return best && bestDelta <= within ? { thumb: best.c, delta: bestDelta } : null
}

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
  if (hit) return hit.c

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
  bucket.set(k, { c: thumb, ms, h })
  thumbStats.built++
  return thumb
}

/**
 * Every thumbnail a strip is missing, in one pass.
 *
 * `thumbAt` is right for one picture and wrong for forty: each call seeks, so a
 * strip built that way pays a keyframe walk per slot. This asks the decoder for
 * the whole run at once and downscales each wanted frame as it arrives, which is
 * one walk for the lot.
 *
 * `onThumb` is called as they land so the strip fills in from the left rather
 * than appearing all at once at the end — the work is the same either way, and
 * watching it arrive is much better than watching nothing.
 */
// One pass per asset at a time. Four clips of one video each start their own,
// and four decoders on one file do not go four times as fast — they fight over
// the same small pool of hardware frames and each other's cache. Queued, the
// later ones find most of their pictures already made.
const passes = new WeakMap()

/** Stores a decoded frame as a thumbnail, downscaled on the spot. */
function keepThumb(asset, bucket, ms, h, frame, onThumb) {
  const k = key(asset, ms, h)
  if (bucket.has(k)) return
  const w = Math.max(1, Math.round((frame.displayWidth / frame.displayHeight) * h))
  const scratch = typeof OffscreenCanvas !== 'undefined'
    ? new OffscreenCanvas(w, h)
    : Object.assign(document.createElement('canvas'), { width: w, height: h })
  const ctx = scratch.getContext('2d')
  ctx.drawImage(frame, 0, 0, w, h)
  const thumb = scratch.transferToImageBitmap ? scratch.transferToImageBitmap() : scratch
  bucket.set(k, { c: thumb, ms, h })
  thumbStats.built++
  if (onThumb) onThumb(ms, thumb)
}

/**
 * Every thumbnail a strip is missing.
 *
 * Two passes, in this order on purpose. The keyframes first, because they cost
 * one decode each and give the strip real coverage in a moment; then the exact
 * frames, which on a long clip means decoding everything in between and is the
 * part that takes time. A coarse strip immediately and a fine one shortly after
 * is the right way round — a filmstrip is for finding roughly where something
 * is, and you cannot do that with an empty one.
 */
export async function thumbsFor(asset, msList, h = THUMB_H, onThumb = null, tolerance = 0) {
  if (!asset?.isVideo || !msList.length) return
  // Wait for whatever is already decoding this asset, then take what is left.
  const running = passes.get(asset)
  if (running) await running.catch(() => {})

  const run = (async () => {
    const bucket = bucketFor(asset)
    const d = asset.duration || 1
    const wrap = (ms) => ((ms % d) + d) % d

    const byIndex = new Map()
    for (const ms of msList) {
      if (bucket.has(key(asset, ms, h))) continue
      // A thumbnail stands for the span it is drawn over, so a picture already
      // in hand from inside that span *is* the picture. Without this the strip
      // asks for its exact frames even when the ones built ahead of time sit a
      // fraction of a slot away — which is the whole saving thrown away, and on
      // a long clip the difference between reading the file again and not.
      if (tolerance > 0 && nearestThumb(asset, ms, h, tolerance)) continue
      const i = indexAt(asset, wrap(ms))
      if (!byIndex.has(i)) byIndex.set(i, ms)
    }
    if (!byIndex.size) return

    const indices = [...byIndex.keys()]
    const lo = Math.min(...indices)
    const hi = Math.max(...indices)

    // Coverage first. A keyframe's picture is filed under the *slot* nearest to
    // it, so it stands where it belongs rather than at a time nothing asked for.
    try {
      await decodeKeyframes(asset, lo, hi, (i, frame) => {
        let best = null
        let bestD = Infinity
        for (const [wantIdx, ms] of byIndex) {
          const dist = Math.abs(wantIdx - i)
          if (dist < bestD) { bestD = dist; best = ms }
        }
        if (best != null) keepThumb(asset, bucket, best, h, frame, onThumb)
      })
    } catch { /* a file with no readable keyframes still gets the pass below */ }

    // Then the exact ones — but only where the keyframes did not already put a
    // picture inside the slot's own span.
    //
    // This is the decision that makes a long clip usable. Reaching an arbitrary
    // frame means decoding everything since the last keyframe, so exact
    // thumbnails for a ninety-second clip is thousands of frames; keyframes are
    // one decode each. Where they land close enough to stand for the slot, they
    // are the picture and nothing more is read.
    //
    // Zooming in asks for precision and gets it, for free: a stretched strip
    // covers less time per slot, so the tolerance shrinks *and* the range to
    // decode shrinks with it.
    const left = [...byIndex.keys()].filter((i) => {
      const ms = byIndex.get(i)
      if (bucket.has(key(asset, ms, h))) return false
      return !(tolerance > 0 && nearestThumb(asset, ms, h, tolerance))
    })
    if (!left.length) return
    await decodeThumbs(asset, left, (i, frame) => {
      const ms = byIndex.get(i)
      if (ms != null) keepThumb(asset, bucket, ms, h, frame, onThumb)
    })
  })()

  passes.set(asset, run)
  try {
    await run
  } finally {
    if (passes.get(asset) === run) passes.delete(asset)
  }
}

/**
 * Builds a clip's filmstrip pictures ahead of being asked, at import.
 *
 * "I should not have to wait for the frames to generate at all" is the right
 * expectation, and the only way to meet it is to have generated them before the
 * timeline is looked at. Everything here is idempotent and cached, so this is
 * the same work moved earlier rather than extra work.
 */
export function primeThumbs(asset, count = 120) {
  if (!asset?.isVideo || !(asset.duration > 0)) return
  if (asset.thumbsPrimed) return
  asset.thumbsPrimed = true
  // Finer than any strip is likely to want. A lane is at most a couple of
  // thousand pixels and a thumbnail is tens of pixels wide, so sixty-odd slots
  // is the practical ceiling; priming past that means every slot finds a picture
  // inside its own span and nothing is decoded again.
  const n = Math.min(count, Math.max(12, Math.round(asset.duration / 500)))
  const times = []
  for (let i = 0; i < n; i++) times.push(((i + 0.5) / n) * asset.duration)
  // Fire and forget: nothing waits on it, and a failure just means the strip
  // builds them the usual way when it is looked at.
  thumbsFor(asset, times).catch(() => {})
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
      // How much of the source this slot stands for. A cached picture closer
      // than half of this was already standing for the same span.
      slotMs: (span / n) * Math.abs(layer.speed || 1),
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
