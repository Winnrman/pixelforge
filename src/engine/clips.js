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
  // A still, a title, a pixelate: no inherent length at all. Zero means
  // unbounded here, and every caller already reads it that way.
  //
  // It used to report the clip's *current* length, which sounds harmless and is
  // not: trimming clamps the new length to the source length, so a thing with no
  // source could be shortened and then never lengthened again. A censor placed
  // over three seconds of a shot could not be dragged to cover the rest of it,
  // which is a bad way to find out.
  return 0
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

  // Nothing underneath to run out of: the edges simply go where they are put,
  // and the length follows. A title or an overlay is as long as you want it.
  if (!total) {
    const end = (c.start || 0) + Math.max(MIN_CLIP_MS, (o - i) / speed)
    if (edge === 'end') {
      const len = Math.max(MIN_CLIP_MS, at - (c.start || 0))
      return { ...c, in: 0, out: Math.round(len * speed) }
    }
    const start = Math.max(0, Math.min(at, end - MIN_CLIP_MS))
    return { ...c, start: Math.round(start), in: 0, out: Math.round((end - start) * speed) }
  }

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
  const out = new Map()
  // Per track, not across all of them. Clips on different rows are meant to run
  // at the same time as each other — pulling them into one queue would destroy
  // the arrangement rather than tidy it.
  const tracks = new Set(layers.filter((l) => l.clip).map((l) => l.track || 0))
  for (const t of tracks) {
    const order = layers
      .filter((l) => l.clip && (l.track || 0) === t)
      .sort((a, b) => (a.clip.start || 0) - (b.clip.start || 0))
    let at = startAt
    for (const l of order) {
      const { length } = clipRange(l, assetOf(l))
      out.set(l.id, { ...l.clip, start: Math.round(at) })
      at += length
    }
  }
  return out
}

// ------------------------------------------------------------------- tracks
//
// A track is one integer on a layer, not a collection of its own.
//
// The document's layer array already *is* stacking order, and a second ordering
// living beside it would be two sources of truth that can disagree — the kind of
// thing that makes an editor need a manual. So moving a clip between tracks
// re-sorts the array to match, and the renderer never learns that tracks exist.
//
// Higher track number means further forward, matching the way a timeline is
// drawn: the top row is the one in front.

// ------------------------------------------------------- overlays and hosts

/** An overlay: a clip with no media of its own — a censor, a title, a shape. */
export const isOverlay = (l) => !!l?.clip && !l.assetId

/**
 * The media clip an overlay is riding on.
 *
 * A blur over somebody's face is not a thing that lives at 4.2 seconds. It is a
 * thing that lives on *that shot*, and when the shot moves it has to move with
 * it — otherwise sliding the clip along slides the face out from under its own
 * censor, which is the one failure this feature cannot have.
 *
 * The bond is worked out from where things are rather than stored on the layer.
 * Nothing to attach, nothing to detach, nothing to go stale: drag an overlay
 * somewhere else and it belongs to whatever is under it now. What pins it is its
 * first frame — so an overlay deliberately run past the end of its shot is still
 * that shot's, which is exactly what somebody does when a censor has to outlast
 * the cut.
 */
export function hostOf(layers, overlay, assetOf) {
  if (!isOverlay(overlay)) return null
  const o = clipRange(overlay, assetOf(overlay))
  let best = null
  let bestScore = -1
  for (const l of layers) {
    if (!l.clip || !l.assetId || l.id === overlay.id) continue
    const r = clipRange(l, assetOf(l))
    if (o.start < r.start || o.start >= r.end) continue
    // Two clips can cover the same instant — that overlap is a transition. The
    // one the overlay covers more of is the one it is about.
    const shared = Math.min(o.end, r.end) - Math.max(o.start, r.start)
    // Ties go to whichever starts later: at a dissolve, an overlay placed on the
    // join belongs to the shot coming in.
    const score = shared * 1e6 + r.start
    if (score > bestScore) { bestScore = score; best = l }
  }
  return best
}

/** The overlays riding on a clip. */
export function ridersOf(layers, host, assetOf) {
  if (!host?.clip || !host.assetId) return []
  return layers.filter((l) => isOverlay(l) && hostOf(layers, l, assetOf)?.id === host.id)
}

export const trackOf = (l) => (l?.clip ? (l.track || 0) : null)

/** How many tracks the document is using. Always at least one. */
export function trackCount(layers) {
  let top = 0
  for (const l of layers) if (l.clip) top = Math.max(top, l.track || 0)
  return top + 1
}

/** The clips on each track, highest track first — the order they are drawn in. */
export function byTrack(layers) {
  const n = trackCount(layers)
  const rows = []
  for (let t = n - 1; t >= 0; t--) {
    rows.push({ track: t, clips: layers.filter((l) => l.clip && (l.track || 0) === t) })
  }
  return rows
}

/**
 * Re-sorts the layer array so array order agrees with track order.
 *
 * Only the clips move, and only among the positions clips already occupy.
 * Everything else — text, shapes, effects — stays exactly where it is, because
 * a title that sat in front of the footage must not fall behind it because a
 * clip was dragged to another row.
 */
export function sortByTrack(layers) {
  const slots = []
  const clips = []
  layers.forEach((l, i) => {
    if (!l.clip) return
    slots.push(i)
    clips.push(l)
  })
  if (clips.length < 2) return layers
  // Stable within a track, so clips that share one keep the order they had.
  const sorted = [...clips].sort((a, b) => (a.track || 0) - (b.track || 0))
  const out = [...layers]
  slots.forEach((slot, i) => { out[slot] = sorted[i] })
  return out
}

/**
 * Whether two clips on the same track overlap in time.
 *
 * Overlap is allowed rather than prevented — refusing a drop, or shoving the
 * neighbour aside, are both surprises. When it happens the clip later in the
 * array draws in front, which is the same rule as everywhere else.
 */
export function overlapsOnTrack(layers, layer, assetOf) {
  if (!layer?.clip) return false
  const mine = clipRange(layer, assetOf(layer))
  return layers.some((l) => l !== layer && l.clip && (l.track || 0) === (layer.track || 0)
    && (() => {
      const r = clipRange(l, assetOf(l))
      return mine.start < r.end && r.start < mine.end
    })())
}

// ------------------------------------------------------------------ snapping
//
// Butting one clip against another by eye is a pixel-hunt, and being one frame
// out shows as a flash of whatever is behind. So a drag looks for edges to line
// up with and reports which one it caught, for the timeline to draw a line at.

/** How close, in pixels, counts as lining up. */
export const SNAP_PX = 8

/**
 * The times a dragged clip should want to line up with: every other clip's two
 * edges, the start of the project, and the playhead.
 *
 * The dragged clip is excluded — a clip that snapped to itself could never be
 * moved. Edges from *every* track, not only its own, because lining a cutaway up
 * with the shot underneath is the usual reason to want this at all.
 */
export function snapPoints(layers, assetOf, exceptId, extra = []) {
  // One id or several. A clip being dragged takes its overlays with it, and an
  // edge that is moving is not an edge to line up against — left in, the shot
  // would snap to where its own censor is and stick there.
  const skip = new Set(Array.isArray(exceptId) ? exceptId : [exceptId])
  const out = [0]
  for (const l of layers) {
    if (!l.clip || skip.has(l.id)) continue
    const r = clipRange(l, assetOf(l))
    out.push(r.start, r.end)
  }
  for (const e of extra) if (Number.isFinite(e)) out.push(e)
  return out
}

/**
 * Nudges a clip so one of its edges lands on a snap point.
 *
 * Both edges are candidates and the nearest wins, so a clip can be dropped
 * against the end of the one before it or the start of the one after without
 * the drag having to know which the person meant.
 *
 * Returns the adjusted start and the time to draw the line at, or `at: null`
 * when nothing was near enough — the line only appears when it is telling the
 * truth.
 */
export function snapClip(start, length, points, tolerance) {
  let best = null
  for (const p of points) {
    for (const edge of [start, start + length]) {
      const d = Math.abs(edge - p)
      if (d > tolerance) continue
      if (!best || d < best.d) best = { d, at: p, start: start + (p - edge) }
    }
  }
  if (!best) return { start, at: null }
  return { start: Math.max(0, Math.round(best.start)), at: best.at }
}

/** The same, for a single edge being trimmed rather than a whole clip moving. */
export function snapEdge(value, points, tolerance) {
  let best = null
  for (const p of points) {
    const d = Math.abs(value - p)
    if (d <= tolerance && (!best || d < best.d)) best = { d, at: p }
  }
  return best ? { value: best.at, at: best.at } : { value, at: null }
}
