// Per-property keyframe animation.
//
// A layer holds `tracks: { <prop>: [{ t, v, ease }] }`. Each animatable property
// owns its own track, so position and opacity can be keyed independently and
// show as separate lanes in the timeline. Anything without a track simply uses
// the layer's base value.
//
// Properties are grouped for the UI (position = x+y, size = w+h) because that is
// how people think about them: one "Position" lane, not an X lane and a Y lane.

export const TRACK_GROUPS = [
  { id: 'position', label: 'Position', props: ['x', 'y'] },
  { id: 'size', label: 'Size', props: ['w', 'h'] },
  { id: 'rotation', label: 'Rotation', props: ['rotation'] },
  { id: 'opacity', label: 'Opacity', props: ['opacity'] },
  { id: 'pixelSize', label: 'Pixel size', props: ['pixelSize'] },
  { id: 'blurRadius', label: 'Blur', props: ['blurRadius'] },
  { id: 'feather', label: 'Feather', props: ['feather'] },
  { id: 'amount', label: 'Amount', props: ['amount'] },
  { id: 'radius', label: 'Corner', props: ['radius'] },
  { id: 'crop', label: 'Crop', props: ['cropT', 'cropR', 'cropB', 'cropL'] },
  { id: 'zoom', label: 'Zoom', props: ['zoom'] },
  { id: 'pan', label: 'Pan', props: ['panX', 'panY'] },
  // Volume is keyed like anything else, so a point dragged on an audio lane is
  // an ordinary keyframe: it undoes, eases, copies with the layer, saves into
  // the project and shows in the Keyframes tab beside position and opacity. A
  // second, parallel system for "audio points" would have been none of that.
  { id: 'volume', label: 'Volume', props: ['volume'] },
  // A shape's fill angle and a text layer's colour angle, in one group: a layer
  // has one or the other, never both, and `enableGroup` skips a property the
  // layer has no number for. Animating it sweeps the gradient across the thing,
  // which is most of what anyone wants a gradient to do that a flat colour
  // cannot.
  { id: 'gradient', label: 'Gradient', props: [
    'fillAngle', 'colorAngle', 'fillStop', 'fillStop2', 'colorStop', 'colorStop2',
  ] },
]

export const GROUP_BY_ID = Object.fromEntries(TRACK_GROUPS.map((g) => [g.id, g]))
export const GROUP_OF = {}
for (const g of TRACK_GROUPS) for (const p of g.props) GROUP_OF[p] = g.id

export const ANIMATABLE = TRACK_GROUPS.flatMap((g) => g.props)
export const isAnimatable = (p) => Object.hasOwn(GROUP_OF, p)

export const EASINGS = {
  linear: (t) => t,
  'ease-in': (t) => t * t,
  'ease-out': (t) => 1 - (1 - t) * (1 - t),
  'ease-in-out': (t) => (t < 0.5 ? 2 * t * t : 1 - ((-2 * t + 2) ** 2) / 2),
  hold: () => 0,
}
export const EASING_OPTIONS = Object.keys(EASINGS).map((k) => ({ value: k, label: k }))

export const KEY_SNAP = 8 // ms tolerance when matching a key to the playhead

// ---------------------------------------------------------------- inspection

export const hasTracks = (l) =>
  !!l?.tracks && Object.values(l.tracks).some((k) => k?.length)

export const trackOf = (l, prop) => l?.tracks?.[prop] || []

export const groupHasTrack = (l, groupId) =>
  (GROUP_BY_ID[groupId]?.props || []).some((p) => trackOf(l, p).length > 0)

export const activeGroups = (l) =>
  TRACK_GROUPS.filter((g) => g.props.some((p) => trackOf(l, p).length > 0))

/** Sorted, de-duplicated key times across every property in a group. */
export function groupKeyTimes(l, groupId) {
  const props = GROUP_BY_ID[groupId]?.props || []
  const set = new Set()
  for (const p of props) for (const k of trackOf(l, p)) set.add(k.t)
  return [...set].sort((a, b) => a - b)
}

export function allKeyTimes(l) {
  const set = new Set()
  for (const keys of Object.values(l?.tracks || {})) {
    for (const k of keys || []) set.add(k.t)
  }
  return [...set].sort((a, b) => a - b)
}

export function keyExtent(l) {
  const t = allKeyTimes(l)
  return t.length ? t[t.length - 1] : 0
}

export function keyTimeNear(times, t) {
  for (const x of times) if (Math.abs(x - t) <= KEY_SNAP) return x
  return null
}

/** The easing of the group's key at `t` (properties in a group share easing). */
export function groupEaseAt(l, groupId, t) {
  for (const p of GROUP_BY_ID[groupId]?.props || []) {
    const k = trackOf(l, p).find((x) => Math.abs(x.t - t) <= KEY_SNAP)
    if (k) return k.ease || 'linear'
  }
  return 'linear'
}

// ---------------------------------------------------------------- resolution

export function sampleTrack(keys, t, fallback) {
  if (!keys?.length) return fallback
  if (keys.length === 1) return keys[0].v
  if (t <= keys[0].t) return keys[0].v
  const last = keys[keys.length - 1]
  if (t >= last.t) return last.v
  let i = 0
  while (i < keys.length - 1 && keys[i + 1].t <= t) i++
  const a = keys[i]
  const b = keys[i + 1]
  const span = b.t - a.t
  const u = span > 0 ? (t - a.t) / span : 0
  return a.v + (b.v - a.v) * (EASINGS[a.ease] || EASINGS.linear)(u)
}

export function resolveLayer(l, time) {
  const tracks = l.tracks
  if (!tracks) return l
  let out = null
  for (const prop in tracks) {
    const keys = tracks[prop]
    if (!keys?.length) continue
    if (!out) out = { ...l }
    out[prop] = sampleTrack(keys, time, l[prop])
  }
  return out || l
}

/** Value of one property at a time, whether or not it is animated. */
export function valueAt(l, prop, time) {
  const keys = trackOf(l, prop)
  return keys.length ? sampleTrack(keys, time, l[prop]) : l[prop]
}

// -------------------------------------------------------------------- edits
// All of these are pure: they take a layer and return a new `tracks` object.

const sorted = (keys) => [...keys].sort((a, b) => a.t - b.t)

export function setTrackKey(l, prop, t, v) {
  const keys = [...trackOf(l, prop)]
  const time = Math.max(0, Math.round(t))
  const i = keys.findIndex((k) => Math.abs(k.t - time) <= KEY_SNAP)
  if (i >= 0) keys[i] = { ...keys[i], v }
  else keys.push({ t: time, v, ease: 'linear' })
  return { ...l.tracks, [prop]: sorted(keys) }
}

/** Starts tracks for every property in a group, seeded at `t` with its current value. */
export function enableGroup(l, groupId, t) {
  const props = GROUP_BY_ID[groupId]?.props || []
  const tracks = { ...l.tracks }
  for (const p of props) {
    if (typeof l[p] !== 'number') continue
    if (trackOf(l, p).length) continue
    tracks[p] = [{ t: Math.max(0, Math.round(t)), v: valueAt(l, p, t), ease: 'linear' }]
  }
  return tracks
}

/** Drops a group's tracks, baking the pose at `t` into the base layer. */
export function disableGroup(l, groupId, t) {
  const props = GROUP_BY_ID[groupId]?.props || []
  const tracks = { ...l.tracks }
  const base = {}
  for (const p of props) {
    if (trackOf(l, p).length) base[p] = valueAt(l, p, t)
    delete tracks[p]
  }
  return { tracks: Object.keys(tracks).length ? tracks : undefined, base }
}

export function addGroupKey(l, groupId, t) {
  const props = GROUP_BY_ID[groupId]?.props || []
  let tracks = l.tracks
  for (const p of props) {
    if (!trackOf(l, p).length) continue
    tracks = setTrackKey({ ...l, tracks }, p, t, valueAt(l, p, t))
  }
  return tracks
}

export function removeGroupKey(l, groupId, t) {
  const props = GROUP_BY_ID[groupId]?.props || []
  const tracks = { ...l.tracks }
  const base = {}
  for (const p of props) {
    const keys = trackOf(l, p)
    if (!keys.length) continue
    const left = keys.filter((k) => Math.abs(k.t - t) > KEY_SNAP)
    if (left.length) {
      tracks[p] = left
    } else {
      // Last key gone: keep the pose it was holding as the static value.
      base[p] = valueAt(l, p, t)
      delete tracks[p]
    }
  }
  return { tracks: Object.keys(tracks).length ? tracks : undefined, base }
}

export function moveGroupKey(l, groupId, from, to) {
  const props = GROUP_BY_ID[groupId]?.props || []
  const target = Math.max(0, Math.round(to))
  const tracks = { ...l.tracks }
  for (const p of props) {
    const keys = trackOf(l, p)
    if (!keys.length) continue
    const moved = keys.map((k) => (Math.abs(k.t - from) <= KEY_SNAP ? { ...k, t: target } : k))
    // Collapse any key the move landed on top of.
    const byTime = new Map()
    for (const k of sorted(moved)) byTime.set(k.t, k)
    tracks[p] = sorted([...byTime.values()])
  }
  return tracks
}

export function setGroupEase(l, groupId, t, ease) {
  const props = GROUP_BY_ID[groupId]?.props || []
  const tracks = { ...l.tracks }
  for (const p of props) {
    const keys = trackOf(l, p)
    if (!keys.length) continue
    tracks[p] = keys.map((k) => (Math.abs(k.t - t) <= KEY_SNAP ? { ...k, ease } : k))
  }
  return tracks
}

/**
 * Starts a track for a property that is changing for the first time.
 *
 * The old value is pinned at t=0 and the new one at the playhead, so a single
 * edit produces actual motion rather than a constant one-key track. Editing at
 * t=0 just yields that one key.
 */
export function seedTrack(oldValue, newValue, t) {
  const time = Math.max(0, Math.round(t))
  if (time <= 0) return [{ t: 0, v: newValue, ease: 'linear' }]
  return [
    { t: 0, v: oldValue, ease: 'linear' },
    { t: time, v: newValue, ease: 'linear' },
  ]
}

/**
 * Applies one property value across every key in its track.
 * `mode: 'set'` overwrites each key (use for absolute controls like a slider);
 * `mode: 'offset'` shifts each key by the delta, preserving the animation's
 * shape (use for relative gestures like dragging on canvas).
 */
export function applyToAllKeys(l, prop, v, time, mode = 'set') {
  const keys = trackOf(l, prop)
  if (!keys.length) return l.tracks
  if (mode === 'offset') {
    const d = v - valueAt(l, prop, time)
    return { ...l.tracks, [prop]: keys.map((k) => ({ ...k, v: k.v + d })) }
  }
  return { ...l.tracks, [prop]: keys.map((k) => ({ ...k, v })) }
}
