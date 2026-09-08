// Transitions between clips.
//
// Every editor makes this a thing you go and fetch: a bin of effects, a drag
// onto a cut, a dialog with a duration in it, and a separate object living at
// the join that you then have to select, trim and delete on its own terms. That
// is four concepts for something a person describes in one sentence — "fade this
// one into that one".
//
// Here the overlap *is* the transition. Drag a clip so it laps over its
// neighbour on the same track and the region where they cover each other is
// where one becomes the other. Longer overlap, longer transition. Pull them
// apart and there is no transition, because there is no overlap. There is
// nothing to select, nothing to delete, and no duration field: the picture on the
// timeline already shows exactly how long it takes.
//
// The kind is stored on the *incoming* clip — the one arriving — because that is
// the clip the transition belongs to in every sense that matters: move it and
// the transition goes with it, delete it and the transition goes too.

import { clipRange } from './clips.js'
import { layerAABB } from './shapes.js'

/** The kinds, in the order they are offered. Crossfade first: it is the one. */
export const TRANSITIONS = [
  { id: 'crossfade', label: 'Crossfade' },
  { id: 'black', label: 'Dip to black' },
  { id: 'white', label: 'Dip to white' },
  { id: 'wipe', label: 'Wipe →' },
  { id: 'wipe-back', label: 'Wipe ←' },
]

export const DEFAULT_KIND = 'crossfade'

/** The shortest overlap worth treating as a transition rather than a sloppy cut. */
export const MIN_OVERLAP_MS = 60

export const kindOf = (l) => l?.transition?.kind || DEFAULT_KIND

/**
 * Every pair of clips that lap over each other, in timeline order.
 *
 * Only *neighbouring* clips on one track: three clips in a heap is not three
 * transitions, it is a mess, and pretending otherwise would put the same frame
 * through two dissolves at once.
 */
export function pairsIn(layers, assetOf) {
  const byTrack = new Map()
  for (const l of layers) {
    if (!l.clip || l.visible === false) continue
    const t = l.track || 0
    if (!byTrack.has(t)) byTrack.set(t, [])
    byTrack.get(t).push(l)
  }

  const out = []
  for (const clips of byTrack.values()) {
    const sorted = clips
      .map((l) => ({ l, r: clipRange(l, assetOf(l)) }))
      .sort((a, b) => a.r.start - b.r.start)
    for (let i = 0; i + 1 < sorted.length; i++) {
      const a = sorted[i]
      const b = sorted[i + 1]
      const start = b.r.start
      const end = Math.min(a.r.end, b.r.end)
      if (end - start < MIN_OVERLAP_MS) continue
      // A transition goes *from* one clip *to* the next, so the arriving clip has
      // to both begin later and end later. Anything else is two clips stacked on
      // one row — starting together, or one sitting entirely inside the other —
      // which is a thing people do by accident and which has always simply drawn
      // one in front of the other. Dissolving into a clip that ends at the same
      // moment, or that started at the same moment, is a dissolve into nothing.
      if (b.r.start <= a.r.start || b.r.end <= a.r.end) continue
      out.push({
        out: a.l,
        in: b.l,
        outId: a.l.id,
        inId: b.l.id,
        start,
        end,
        length: end - start,
        kind: kindOf(b.l),
      })
    }
  }
  return out
}

/**
 * What each clip is doing at `time`, keyed by layer id.
 *
 * One pass per frame rather than a search per layer, because the renderer walks
 * every layer and asking this question inside that walk would make it quadratic
 * on a timeline with a lot of clips.
 */
export function stateAt(layers, assetOf, time) {
  const map = new Map()
  for (const p of pairsIn(layers, assetOf)) {
    if (time < p.start || time >= p.end) continue
    const t = p.length > 0 ? (time - p.start) / p.length : 1
    map.set(p.outId, { role: 'out', p: t, kind: p.kind, pair: p })
    map.set(p.inId, { role: 'in', p: t, kind: p.kind, pair: p })
  }
  return map
}

/**
 * How to draw one clip mid-transition: an alpha, an optional veil over its own
 * box, and an optional reveal.
 *
 * The crossfade numbers look lopsided and are not. Drawing the outgoing at
 * `1 - p` and the incoming at `p` is the obvious thing and it is wrong: the
 * second draw lands *over* the first, so what comes out is `B*p + A*(1-p)*(1-p)`
 * — the two never sum to one and the picture sags dark through the middle of
 * every dissolve. Leaving the outgoing solid and bringing the incoming up at `p`
 * gives `A*(1-p) + B*p` exactly, which is what a dissolve is. It only works if
 * the incoming is drawn second, which is why the renderer orders the pair.
 */
export function drawFor(kind, role, p) {
  const q = Math.max(0, Math.min(1, p))
  switch (kind) {
    case 'black':
    case 'white': {
      // A dip is two halves, not a blend: out fades into the colour, then in
      // comes out of it. Both are never up at once, so neither has to know
      // about the other.
      const colour = kind === 'black' ? '#000000' : '#ffffff'
      if (role === 'out') {
        return q >= 0.5
          ? { alpha: 0 }
          : { alpha: 1, veil: { colour, alpha: q * 2 } }
      }
      return q < 0.5
        ? { alpha: 0 }
        : { alpha: 1, veil: { colour, alpha: (1 - q) * 2 } }
    }
    case 'wipe':
    case 'wipe-back': {
      // The outgoing stays whole underneath and the incoming is uncovered across
      // it, which is what makes a wipe read as an edge travelling rather than as
      // two pictures fighting.
      if (role === 'out') return { alpha: 1 }
      return { alpha: 1, reveal: { from: kind === 'wipe' ? 'left' : 'right', at: q } }
    }
    default:
      return role === 'out' ? { alpha: 1 } : { alpha: q }
  }
}

/** The part of the canvas an incoming clip has uncovered so far. */
export function revealRect(reveal, width, height) {
  const at = Math.max(0, Math.min(1, reveal.at))
  const w = width * at
  return reveal.from === 'left'
    ? { x: 0, y: 0, w, h: height }
    : { x: width - w, y: 0, w, h: height }
}

/** The box a veil covers: the clip's own, so a dip does not black out the titles
 *  over it or whatever else is on another track. */
export const veilBox = (layer) => layerAABB(layer)

/**
 * The pair order the renderer needs: outgoing first.
 *
 * The alpha maths above only produces a dissolve if the incoming lands on top of
 * the outgoing, and stacking order is the user's business, not the transition's.
 * Both clips are on the same track and overlap in time, so nothing else can be
 * between them — swapping the two is invisible except for the thing it fixes.
 */
export function orderForTransitions(layers, pairs) {
  if (!pairs.length) return layers
  const out = layers.slice()
  for (const p of pairs) {
    const i = out.findIndex((l) => l.id === p.outId)
    const j = out.findIndex((l) => l.id === p.inId)
    if (i < 0 || j < 0 || i < j) continue
    const [moved] = out.splice(j, 1)
    out.splice(i, 0, moved)
  }
  return out
}

/**
 * A gain curve for one clip's audio through a transition, as points in document
 * time. Silence is dropped in rather than crossfaded for the dips, because a
 * picture that has gone to black with the sound still running is a mistake, not
 * a style.
 */
export function audioRamp(kind, role, start, end) {
  const mid = start + (end - start) / 2
  if (kind === 'black' || kind === 'white') {
    return role === 'out'
      ? [[start, 1], [mid, 0], [end, 0]]
      : [[start, 0], [mid, 0], [end, 1]]
  }
  // Everything else, wipes included, fades the sound across the whole overlap:
  // a hard audio cut under a moving picture is the thing that sounds broken.
  return role === 'out' ? [[start, 1], [end, 0]] : [[start, 0], [end, 1]]
}

/**
 * The whole gain curve for one clip's sound, as `[documentTime, multiplier]`
 * points in order.
 *
 * A clip in the middle of a run is the outgoing half of one transition and the
 * incoming half of another, so this is a list rather than a single ramp — a map
 * keyed by layer would quietly drop one of the two and leave a clip fading in
 * and then never fading out.
 */
export function gainPointsFor(layerId, pairs) {
  const pts = []
  for (const p of pairs) {
    if (p.outId === layerId) pts.push(...audioRamp(p.kind, 'out', p.start, p.end))
    if (p.inId === layerId) pts.push(...audioRamp(p.kind, 'in', p.start, p.end))
  }
  return pts.sort((a, b) => a[0] - b[0])
}

/**
 * The multiplier at one moment. Full before the first point — a clip is at its
 * own volume until a transition starts — and holding the last value after, which
 * is what keeps a faded-out clip silent for the frames it has left.
 */
export function gainAt(points, t) {
  if (!points.length) return 1
  // Exactly on the first point is *on* the curve, not before it: dropping the
  // playhead on the frame a transition starts must give the incoming clip the
  // silence its curve asks for, not full volume.
  if (t <= points[0][0]) return t === points[0][0] ? points[0][1] : 1
  const last = points[points.length - 1]
  if (t >= last[0]) return last[1]
  for (let i = 1; i < points.length; i++) {
    const [t0, v0] = points[i - 1]
    const [t1, v1] = points[i]
    if (t > t1) continue
    const span = t1 - t0
    return span > 0 ? v0 + ((v1 - v0) * (t - t0)) / span : v1
  }
  return last[1]
}
