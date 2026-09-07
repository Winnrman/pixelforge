// Clips: a layer as a piece of media placed on a timeline.
//
// Until now a layer *was* its asset, shown for the whole document and looping
// forever. That is right for an overlay on a GIF and wrong for editing: cutting,
// trimming and arranging all need a layer to say *which part* of its source it
// plays and *when* it plays there.
//
// A clip is three numbers:
//
//   start   where it begins on the document timeline
//   in      how far into the source it starts playing
//   out     where in the source it stops
//
// Everything else follows. Its length on the timeline is `(out - in) / speed`.
// Trimming moves `in` or `out`. Sliding moves `start`. Splitting is one clip
// becoming two that share a boundary. None of it touches the asset, so it is as
// non-destructive as the rest of the editor and undo is ordinary undo.
//
// A layer with no `clip` behaves exactly as before — visible throughout, looping
// — because that is what an overlay on a looping GIF wants, and because it keeps
// every existing project working untouched.

/** The smallest clip worth having. Below this a drag has effectively deleted it,
 *  and a zero-length clip is a thing that cannot be grabbed to fix. */
export const MIN_CLIP_MS = 40

export const hasClip = (l) => !!l?.clip

/** How long the source runs, for anything a clip can be made from. */
export function sourceDuration(layer, asset) {
  if (asset?.duration > 0) return asset.duration
  // A still, a title, a shape: no inherent length, so a clip over one is
  // whatever length it was given.
  return layer?.clip ? Math.max(MIN_CLIP_MS, layer.clip.out - layer.clip.in) : 0
}

/** The clip's in/out resolved against the source, both clamped and ordered. */
export function sourceRange(layer, asset) {
  const total = sourceDuration(layer, asset)
  const c = layer.clip
  if (!c) return { in: 0, out: total }
  const lo = Math.max(0, Math.min(c.in ?? 0, total || Infinity))
  const hi = c.out == null ? (total || lo + MIN_CLIP_MS) : c.out
  return { in: lo, out: Math.max(lo + MIN_CLIP_MS, hi) }
}

/**
 * Where the clip sits on the document timeline: `[start, end)`.
 *
 * Speed divides, because playing at 2x makes the same source span half the
 * timeline — the clip gets shorter, not the media.
 */
export function clipRange(layer, asset) {
  const { in: i, out: o } = sourceRange(layer, asset)
  const speed = Math.abs(layer.speed || 1) || 1
  const start = layer.clip ? (layer.clip.start || 0) : 0
  const length = Math.max(MIN_CLIP_MS, (o - i) / speed)
  return { start, end: start + length, length }
}

/**
 * Whether the layer is on screen at `time`.
 *
 * The end is exclusive so two clips butted together do not both draw on the
 * single frame where they meet — which reads as a flash on every cut.
 */
export function visibleAt(layer, time, asset) {
  if (!layer.clip) return true
  const { start, end } = clipRange(layer, asset)
  return time >= start && time < end
}

/**
 * Document time to source time.
 *
 * Without a clip this is the old behaviour: an offset and a speed, looping.
 * With one, the playhead is measured from the clip's start and lands `in` frames
 * into the source, and there is no looping — a clip plays its own piece once,
 * which is what makes trimming mean anything.
 */
export function assetTimeFor(layer, time, asset) {
  if (!layer.clip) return (time - (layer.timeOffset || 0)) * (layer.speed || 1)
  const { in: i, out: o } = sourceRange(layer, asset)
  const speed = layer.speed || 1
  const t = i + (time - (layer.clip.start || 0)) * speed
  return Math.max(i, Math.min(o - 0.001, t))
}

/** A clip covering the whole source, placed at `at` on the timeline. */
export function wholeClip(layer, asset, at = 0) {
  const total = sourceDuration(layer, asset) || 1000
  return { start: Math.max(0, Math.round(at)), in: 0, out: Math.round(total) }
}

/**
 * Moves a clip along the timeline without changing what it plays.
 *
 * Clamped at zero rather than allowed negative: a clip starting before the
 * document does is content that silently cannot be reached.
 */
export function slideTo(layer, start) {
  return { ...layer.clip, start: Math.max(0, Math.round(start)) }
}

/**
 * Drags one end of a clip to a document time.
 *
 * The two ends are not symmetric. Dragging the *right* edge only changes how
 * much of the source plays. Dragging the *left* edge changes that too, but has
 * to move `start` by the same amount — otherwise the rest of the clip slides
 * along the timeline as you trim, which feels like the clip is running away.
 */
export function trimTo(layer, edge, time, asset) {
  const c = layer.clip
  if (!c) return null
  const speed = Math.abs(layer.speed || 1) || 1
  const { in: i, out: o } = sourceRange(layer, asset)
  const total = sourceDuration(layer, asset)
  const at = Math.max(0, Math.round(time))

  if (edge === 'end') {
    const maxLen = total ? (total - i) : Infinity
    const len = Math.max(MIN_CLIP_MS, Math.min(at - (c.start || 0), maxLen / speed * speed))
    const out = Math.min(total || Infinity, i + len * speed)
    return { ...c, in: i, out: Math.max(i + MIN_CLIP_MS, Math.round(out)) }
  }

  // Left edge: how far it moved, in source time.
  const delta = (at - (c.start || 0)) * speed
  const nextIn = Math.max(0, Math.min(o - MIN_CLIP_MS, i + delta))
  // Only the part of the drag that the source could absorb actually happened.
  const applied = (nextIn - i) / speed
  return { ...c, start: Math.max(0, Math.round((c.start || 0) + applied)), in: Math.round(nextIn) }
}

/**
 * Splits a clip at a document time, returning the two halves' clip objects.
 *
 * Returns null when the cut is not strictly inside the clip — splitting at the
 * very edge produces a zero-length piece, which is a way of losing footage while
 * appearing to have done something.
 */
export function splitAt(layer, time, asset) {
  const c = layer.clip
  if (!c) return null
  const { start, end } = clipRange(layer, asset)
  const at = Math.round(time)
  if (at <= start + MIN_CLIP_MS || at >= end - MIN_CLIP_MS) return null

  const speed = layer.speed || 1
  const { in: i, out: o } = sourceRange(layer, asset)
  const cut = Math.round(i + (at - start) * speed)
  return [
    { ...c, start, in: i, out: cut },
    { ...c, start: at, in: cut, out: o },
  ]
}

/** The end of the last clip, for working out how long the timeline is. */
export function clipsEnd(layers, assetOf) {
  let end = 0
  for (const l of layers) {
    if (!l.clip) continue
    end = Math.max(end, clipRange(l, assetOf(l)).end)
  }
  return end
}

/**
 * Lays clips end to end in their current order, closing every gap.
 *
 * The one arrangement operation worth having built in: after cutting pieces out,
 * what you almost always want is the remainder joined up.
 */
export function closeGaps(layers, assetOf, startAt = 0) {
  const clipped = layers.filter((l) => l.clip)
  const order = [...clipped].sort((a, b) => (a.clip.start || 0) - (b.clip.start || 0))
  let at = startAt
  const out = new Map()
  for (const l of order) {
    const { length } = clipRange(l, assetOf(l))
    out.set(l.id, { ...l.clip, start: Math.round(at) })
    at += length
  }
  return out
}
