import { create } from 'zustand'
import { loadImageFile, getAsset } from '../engine/assets.js'
import {
  polygonBounds, polygonToLayer, cropInsets, isCropped, fromLocal, layerAABB,
  maskPolys, maskBounds, windSame, hasMask,
} from '../engine/shapes.js'
import { isGroup, withDescendants, normalize, resolveGroups } from '../engine/groups.js'
import { trackLayer, trackTimes, simplifyTrack } from '../engine/tracker.js'
import { defaultBgRemove } from '../engine/matte.js'
import {
  sourceFor, docDuration, sourceRect, docToAsset, assetToDoc, measureText, visibleBounds,
} from '../engine/render.js'
import {
  defaultSticker, defaultTrails, subjectFrame, alphaBounds, unionBounds,
} from '../engine/subject.js'
import { suggestLoop } from '../engine/loop.js'
import { cardInsets, layoutCollage, defaultCollage } from '../engine/collage.js'
import { defaultBrush, newStroke, newRegion, docToLayer } from '../engine/erase.js'
import { DEFAULT_KIND as DEFAULT_TRANSITION, maxFade, splitFade } from '../engine/transitions.js'
import { cursorPath, smoothPath, autoZoomTracks } from '../engine/cursor.js'
import { exactFrame } from '../engine/video.js'
import {
  predictMask, rememberMask, currentBackend, currentModel, setModel,
} from '../engine/aiMatte.js'
import { maskToPolygon } from '../engine/trace.js'
import { buildEdgeMap, edgeMapFor, snapToEdges, livewire } from '../engine/edges.js'
import { colorMask, coverage } from '../engine/wand.js'
import { defaultStamp, newStamp, docToLayerPoint } from '../engine/clone.js'
import {
  packProject, unpackProject, isProjectFile, thumbnailBytes, PROJECT_EXT,
} from '../engine/project.js'
import {
  writeProject, readProject, listProjects, deleteProject, restoreSnapshot,
} from '../engine/autosave.js'
import { saveBlob } from '../engine/desktop.js'
import {
  wholeClip, slideTo, trimTo, splitAt, closeGaps, clipRange, sourceRange, MIN_CLIP_MS,
  trackCount, sortByTrack, isOverlay, ridersOf,
} from '../engine/clips.js'
import { ensureAudio, setMaster } from '../engine/audio.js'
import {
  writeBackup, listBackups, openBackup, backupFolder, resetBackupState,
  backupsAvailable,
} from '../engine/backup.js'
import {
  resolveLayer, valueAt, keyExtent, isAnimatable, trackOf, setTrackKey,
  enableGroup, disableGroup, addGroupKey, removeGroupKey, moveGroupKey,
  setGroupEase, applyToAllKeys, seedTrack, groupKeyTimes, GROUP_OF, GROUP_BY_ID,
  KEY_SNAP,
} from '../engine/keyframes.js'

/** How long a title is when it first lands. Long enough to read, short enough
 *  that trimming it down is the common adjustment rather than up. */
const TITLE_MS = 3000

let uid = 0
/**
 * Layer ids.
 *
 * The counter alone was not enough: it restarts on page load, while a restored
 * session or an opened project keeps the ids it was saved with. The next import
 * then re-issued `l1`, two layers ended up sharing an identity, and selecting,
 * dragging, editing or deleting one silently hit both. The random suffix makes
 * that impossible however the document arrived.
 */
const nid = (p) => `${p}${++uid}_${Math.random().toString(36).slice(2, 7)}`
const clone = (o) => structuredClone(o)

/** Offsets positional tracks, e.g. when cropping moves the origin. */
function shiftTracks(tracks, by) {
  if (!tracks) return tracks
  const out = { ...tracks }
  for (const [prop, d] of Object.entries(by)) {
    if (out[prop]?.length) out[prop] = out[prop].map((k) => ({ ...k, v: k.v + d }))
  }
  return out
}

/**
 * Crops one layer to the new canvas.
 *
 * An image layer is trimmed to the part that survives: its box becomes the
 * visible region and its source sub-rect narrows to match, so width/height read
 * true afterwards and corner radius applies to the cropped shape. No pixels are
 * re-encoded, so undo restores the original exactly.
 *
 * Rotated or position/size-animated layers are only translated — the visible
 * region is not an axis-aligned slice of the source for those, so trimming
 * would be wrong rather than merely approximate.
 */
function cropLayer(l, rect, { reorigin = true } = {}) {
  // `reorigin` moves the layer into the rect's coordinate space, which is what
  // a document crop needs. Extracting a piece out of a layer leaves it where it
  // already is, so that pass passes `reorigin: false`.
  const ox = reorigin ? rect.x : 0
  const oy = reorigin ? rect.y : 0
  const moved = {
    ...l,
    x: l.x - ox,
    y: l.y - oy,
    tracks: reorigin ? shiftTracks(l.tracks, { x: -rect.x, y: -rect.y }) : l.tracks,
  }
  if (l.type !== 'image' || l.rotation) return moved
  const t = l.tracks || {}
  if (t.x?.length || t.y?.length || t.w?.length || t.h?.length) return moved
  // Framing (crop insets, zoom, pan) already reshapes what this layer samples,
  // so folding a document crop into its source rect on top would compound two
  // transforms. Translate instead and leave the framing alone.
  if (l.cropL || l.cropR || l.cropT || l.cropB) return moved
  if ((l.zoom ?? 1) !== 1 || l.panX || l.panY) return moved
  if (t.cropT?.length || t.zoom?.length || t.panX?.length) return moved

  const ix = Math.max(l.x, rect.x)
  const iy = Math.max(l.y, rect.y)
  const ix2 = Math.min(l.x + l.w, rect.x + rect.w)
  const iy2 = Math.min(l.y + l.h, rect.y + rect.h)
  // Entirely outside, or nothing to trim: leave it be.
  if (ix2 - ix < 0.5 || iy2 - iy < 0.5) return moved
  if (ix <= l.x && iy <= l.y && ix2 >= l.x + l.w && iy2 >= l.y + l.h) return moved

  const s0 = l.src || { x: 0, y: 0, w: 1, h: 1 }
  let u0 = (ix - l.x) / l.w
  let u1 = (ix2 - l.x) / l.w
  let v0 = (iy - l.y) / l.h
  let v1 = (iy2 - l.y) / l.h
  // A flipped layer shows its source mirrored, so trimming the left of the box
  // trims the right of the source.
  if (l.flipX) { const a = u0; u0 = 1 - u1; u1 = 1 - a }
  if (l.flipY) { const a = v0; v0 = 1 - v1; v1 = 1 - a }

  return {
    ...moved,
    x: ix - ox,
    y: iy - oy,
    w: ix2 - ix,
    h: iy2 - iy,
    src: {
      x: s0.x + u0 * s0.w,
      y: s0.y + v0 * s0.h,
      w: (u1 - u0) * s0.w,
      h: (v1 - v0) * s0.h,
    },
  }
}

/** Scales tracks alongside the layer when the canvas is resized. */
/**
 * Scales keyframed geometry, and moves it.
 *
 * Position needs the offset as well as the factor: scaling a moving layer about
 * the canvas centre has to move its whole path, not just stretch it about the
 * origin, or the animation drifts away from where the layer now sits.
 */
function transformTracks(tracks, kx, ky, dx = 0, dy = 0) {
  if (!tracks) return tracks
  const out = { ...tracks }
  if (out.x?.length) out.x = out.x.map((k) => ({ ...k, v: k.v * kx + dx }))
  if (out.y?.length) out.y = out.y.map((k) => ({ ...k, v: k.v * ky + dy }))
  const factor = { w: kx, h: ky, pixelSize: kx, blurRadius: kx, feather: kx, radius: kx }
  for (const [prop, f] of Object.entries(factor)) {
    if (out[prop]?.length) out[prop] = out[prop].map((k) => ({ ...k, v: k.v * f }))
  }
  return out
}

export const BLEND_MODES = [
  'source-over', 'multiply', 'screen', 'overlay', 'darken', 'lighten',
  'color-dodge', 'color-burn', 'hard-light', 'soft-light', 'difference',
  'exclusion', 'hue', 'saturation', 'color', 'luminosity',
]

export const defaultAdjust = () => ({
  brightness: 100, contrast: 100, saturate: 100, hue: 0,
  blur: 0, grayscale: 0, sepia: 0, invert: 0,
})

export const DEFAULT_STILL_DURATION = 3000

export const emptyDoc = () => ({
  width: 960,
  height: 640,
  background: 'transparent',
  duration: 0,       // 0 = derive from the media; set for still-only projects
  layers: [],
  // Everything that has been imported, whether or not it is on the canvas.
  // Held on the document rather than beside it so it saves, loads and undoes
  // with the project instead of being a separate thing to keep in sync.
  media: [],
})

/** Crop / zoom / pan defaults. Auto-tracking only keys properties that are
 *  already numbers, so every image layer carries these explicitly. */
export const imageFraming = () => ({
  cropT: 0, cropR: 0, cropB: 0, cropL: 0,
  zoom: 1, panX: 0, panY: 0,
})

export { defaultBgRemove }

/**
 * Prepares a document that came from outside this session: fills in framing
 * defaults for image layers, and repairs duplicate ids.
 *
 * The repair matters because documents saved before ids were made collision
 * proof can already contain duplicates. Loading one without fixing it would
 * carry the "two layers behaving as one" bug straight back in.
 */
/**
 * Where a clip dropped at `at` on `track` should actually start.
 *
 * Dropping onto a spot another clip already occupies means the two would sit on
 * top of each other, and one would silently hide the other. Landing after the
 * clip that is in the way is what was meant — it is how a sequence gets built by
 * dragging several things onto one row — and it needs no mode, no modifier and
 * nothing to press.
 */
function freeSpotOn(layers, track, at) {
  let t = Math.max(0, Math.round(at))
  // Repeat, because being pushed past one clip can land inside the next.
  for (let guard = 0; guard < 64; guard++) {
    const hit = layers.find((l) => l.clip && (l.track || 0) === track
      && t >= clipRange(l, getAsset(l.assetId)).start
      && t < clipRange(l, getAsset(l.assetId)).end)
    if (!hit) return t
    t = Math.round(clipRange(hit, getAsset(hit.assetId)).end)
  }
  return t
}

export function normalizeDoc(doc) {
  const seen = new Set()
  const layers = doc.layers.map((l) => {
    const collides = !l.id || seen.has(l.id)
    const id = collides ? nid('l') : l.id
    seen.add(id)
    const withDefaults = l.type === 'image' ? { ...imageFraming(), ...l } : l
    return { ...withDefaults, id }
  })
  // A parent link that no longer resolves to a real group is dropped rather
  // than left dangling; the layer simply returns to the top level.
  const groupIds = new Set(layers.filter((l) => l.type === 'group').map((l) => l.id))
  // Media the layers still reference is kept even if the pool list lost it, so
  // a project saved before the pool existed opens with its media visible.
  const pool = [...new Set([
    ...(doc.media || []),
    ...layers.filter((l) => l.type === 'image' && l.assetId).map((l) => l.assetId),
  ])]
  return {
    ...doc,
    media: pool.filter((id) => !!getAsset(id)),
    layers: layers.map((l) =>
      (l.parentId && !groupIds.has(l.parentId) ? { ...l, parentId: null } : l)),
  }
}

export function makeGroupLayer(partial = {}) {
  return {
    id: nid('g'),
    type: 'group',
    name: 'Group',
    parentId: null,
    collapsed: false,
    opacity: 1,
    visible: true,
    locked: false,
    ...partial,
  }
}

/** Deep-copies a set of layers, giving fresh ids and rewiring parent links. */
function cloneSubtree(layers, ids) {
  const wanted = withDescendants(layers, ids)
  const picked = layers.filter((l) => wanted.includes(l.id))
  const idMap = new Map(picked.map((l) => [l.id, nid('l')]))
  return picked.map((l) => ({
    ...clone(l),
    id: idMap.get(l.id),
    parentId: idMap.has(l.parentId) ? idMap.get(l.parentId) : null,
  }))
}

export function makeEffectLayer(partial = {}) {
  return {
    id: nid('l'),
    type: 'effect',
    name: 'Pixelate',
    shape: 'ellipse',
    points: null,
    x: 0, y: 0, w: 200, h: 200,
    rotation: 0,
    radius: 0,
    effect: 'pixelate',
    pixelSize: 14,
    blurRadius: 10,
    amount: 50,
    color: '#000000',
    feather: 0,
    invert: false,
    opacity: 1,
    visible: true,
    locked: false,
    ...partial,
  }
}

/**
 * Grows a layer's frame, and the window it samples, until its mask fits inside.
 *
 * Masking trims the box down to what was kept, so an outline that cut too tight
 * leaves the true edge just outside the frame. Adding a piece there has to bring
 * the frame back with it or the piece has nothing to be drawn on.
 *
 * Everything is expressed as fractions of the current box, which is also how
 * mask outlines and erase strokes are stored — so the same numbers that size the
 * new box rebase what is already on the old one. Growth stops at the edge of the
 * source picture, because past that there is nothing to show.
 *
 * Returns a patch, or null when the mask already fits.
 */
function growToFitMask(layer) {
  const b = maskBounds(layer)
  if (!b) return null
  const u0 = Math.min(0, b.u0)
  const v0 = Math.min(0, b.v0)
  const u1 = Math.max(1, b.u1)
  const v1 = Math.max(1, b.v1)
  if (u0 > -1e-6 && v0 > -1e-6 && u1 < 1 + 1e-6 && v1 < 1 + 1e-6) return null

  // The window on the picture, and the same growth asked of it. Clamped to the
  // picture, then read back, so the box and the window always describe each
  // other — a box grown further than the source can follow would stretch what
  // is left across it.
  const r = sourceRect(layer)
  const want = {
    x: r.x + u0 * r.w, y: r.y + v0 * r.h, x2: r.x + u1 * r.w, y2: r.y + v1 * r.h,
  }
  const src = {
    x: Math.max(0, want.x),
    y: Math.max(0, want.y),
    w: Math.min(1, want.x2) - Math.max(0, want.x),
    h: Math.min(1, want.y2) - Math.max(0, want.y),
  }
  if (!(src.w > 1e-6 && src.h > 1e-6)) return null
  const gu0 = (src.x - r.x) / r.w
  const gv0 = (src.y - r.y) / r.h
  const gu1 = (src.x + src.w - r.x) / r.w
  const gv1 = (src.y + src.h - r.y) / r.h
  if (Math.abs(gu0) < 1e-6 && Math.abs(gv0) < 1e-6
    && Math.abs(gu1 - 1) < 1e-6 && Math.abs(gv1 - 1) < 1e-6) return null

  // The drawn rectangle is the box minus its crop insets; growth is of the
  // picture, so it is measured against that rather than against the box.
  const ci = cropInsets(layer)
  const dx = layer.x + ci.cl * layer.w
  const dy = layer.y + ci.ct * layer.h
  const dw = layer.w * ci.kx
  const dh = layer.h * ci.ky
  const x = dx + gu0 * dw
  const y = dy + gv0 * dh
  const w = Math.max(1, (gu1 - gu0) * dw)
  const h = Math.max(1, (gv1 - gv0) * dh)

  // Rotation is about the centre, so moving the box moves the pivot. The new
  // centre is carried around the old one by the same angle, which is what keeps
  // a turned subject exactly where it was.
  const oldCx = layer.x + layer.w / 2
  const oldCy = layer.y + layer.h / 2
  const a = ((layer.rotation || 0) * Math.PI) / 180
  const ox = x + w / 2 - oldCx
  const oy = y + h / 2 - oldCy
  const cx = oldCx + ox * Math.cos(a) - oy * Math.sin(a)
  const cy = oldCy + ox * Math.sin(a) + oy * Math.cos(a)

  // Anything stored as a fraction of the old box has to be read against the new
  // one. The mask outlines are the obvious case; erase strokes are the one that
  // is easy to forget and shows up as somebody's rubbings-out sliding across the
  // picture the moment the frame moves.
  const rebase = (pts) => pts.map(([u, v]) => [(u - gu0) / (gu1 - gu0), (v - gv0) / (gv1 - gv0)])
  const polys = maskPolys(layer)
  const strokes = layer.erase?.strokes
  return {
    src,
    cropT: 0, cropR: 0, cropB: 0, cropL: 0, zoom: 1, panX: 0, panY: 0,
    x: cx - w / 2,
    y: cy - h / 2,
    w,
    h,
    mask: { ...layer.mask, points: rebase(polys[0]), plus: polys.slice(1).map(rebase) },
    ...(strokes?.length
      ? { erase: { ...layer.erase, strokes: strokes.map((k) => ({ ...k, pts: rebase(k.pts || []) })) } }
      : null),
  }
}

export function makeShapeLayer(partial = {}) {
  return {
    id: nid('l'),
    type: 'shape',
    name: 'Shape',
    shape: 'rect',
    x: 0, y: 0, w: 200, h: 200,
    rotation: 0,
    radius: 0,
    fill: '#ff2d78',
    // The second stop of the fill. Null is a flat shape — there is no gradient
    // mode to turn on, only a colour that is or is not there.
    fill2: null,
    // Degrees, clockwise from left-to-right, so 90 runs top to bottom. A plain
    // number so it keyframes like rotation does.
    fillAngle: 90,
    // Where along that line each colour sits. 0 and 1 is an even fade across the
    // whole shape; pushing the second along leaves the first solid until it,
    // which is how one colour is given the majority.
    fillStop: 0,
    fillStop2: 1,
    stroke: '#ffffff',
    strokeWidth: 0,
    opacity: 1,
    blend: 'source-over',
    visible: true,
    locked: false,
    ...partial,
  }
}

export function makeTextLayer(partial = {}) {
  return {
    id: nid('l'),
    type: 'text',
    name: 'Text',
    text: 'Your text here',
    x: 0, y: 0, w: 420, h: 80,
    rotation: 0,
    font: 'Inter, system-ui, sans-serif',
    size: 56,
    weight: 800,
    italic: false,
    lineHeight: 1.2,
    align: 'left',
    // The box hugs the text until the layer is resized by hand, at which point
    // the width becomes a wrap width instead.
    autoSize: true,
    outlineAbove: false,
    outlineWidth: 2,
    outlineColor: null,   // null follows the fill colour
    // Off by default: the outline following the covering edge exactly is the
    // classic look. Whole-letter switching is there for when a letter caught
    // half-and-half reads as broken rather than deliberate.
    outlineWhole: false,
    outlineThreshold: 0.35,
    color: '#ffffff',
    // The second stop, and the angle in degrees clockwise from left-to-right.
    // Null is flat text, the same as a shape with one colour.
    color2: null,
    colorAngle: 90,
    colorStop: 0,
    colorStop2: 1,
    stroke: '#000000',
    strokeWidth: 0,
    opacity: 1,
    blend: 'source-over',
    visible: true,
    locked: false,
    ...partial,
  }
}

/**
 * Copying layers in the app takes over the system clipboard too.
 *
 * Paste has to decide between two clipboards — the layers copied in here, and
 * whatever the operating system is holding — and the honest rule is "whatever
 * you copied last". There is no way to ask the system clipboard when it was
 * filled, so the only way to know an in-app copy is the more recent of the two
 * is to make it the system clipboard's contents as well.
 *
 * Without this, a screenshot taken an hour ago beat a layer copied a second ago,
 * every time, for as long as it sat there: Ctrl+C then Ctrl+V added the old
 * screenshot to Media instead of duplicating the layer, and nothing said why.
 *
 * The text is what someone gets if they paste into another app, so it says what
 * happened rather than being a marker only this program can read.
 */
async function claimSystemClipboard(n) {
  try {
    if (!navigator.clipboard?.writeText) return false
    await navigator.clipboard.writeText(
      `PixelForge — ${n} layer${n === 1 ? '' : 's'} copied`)
    return true
  } catch {
    // Blocked, or no permission. Paste falls back to preferring the layers,
    // which is the safer half of the trade: the in-app copy is the one the user
    // definitely just made.
    return false
  }
}

export const useStore = create((set, get) => ({
  // Which half of the app is on screen: the canvas, or the media bin.
  workspace: 'editor',
  setWorkspace: (workspace) => set({ workspace }),

  doc: emptyDoc(),
  selectedIds: [],
  tool: 'move',
  toolOptions: {
    aiSelect: false,
    brush: defaultBrush(),
    shape: 'ellipse',
    effect: 'pixelate',
    pixelSize: 14,
    blurRadius: 10,
    feather: 0,
  },
  view: { zoom: 1, panX: 0, panY: 0, fitted: true },
  time: 0,
  playing: true,
  duration: 0,
  past: [],
  future: [],
  busy: null,
  keyScope: 'key',        // 'key' = edit the key at the playhead, 'all' = every key
  selectedKey: null,      // { layerId, groupId, t } — drives the easing control
  // Several keys at once, for dragging or deleting a run of them together.
  // `selectedKey` stays the *last* one touched, because the easing control edits
  // one key and needs to know which.
  keySelection: [],
  clipboard: [],          // layers copied in-app, cloned on both copy and paste
  // Whether the copy that filled `clipboard` also managed to take over the
  // system clipboard. Paste needs to know: see claimSystemClipboard.
  clipboardOwned: false,
  lasso: null,            // { points: [[x, y], ...] } in doc space, closed
  contextMenu: null,      // { x, y, layerId } for the layers panel
  projectName: 'Untitled',
  projectId: null,
  savedProjects: [],
  dirty: false,           // unsaved changes since the last save/open
  notice: null,           // transient message shown under the toolbar

  // ---- history ----------------------------------------------------------
  pushHistory: () =>
    set((s) => ({ past: [...s.past.slice(-59), clone(s.doc)], future: [] })),

  undo: () =>
    set((s) => {
      if (!s.past.length) return {}
      const prev = s.past[s.past.length - 1]
      const ids = new Set(prev.layers.map((l) => l.id))
      return {
        doc: prev,
        // The timeline length is derived from the document, so restoring one
        // without the other leaves everything drawn against the wrong scale —
        // invisible while a document's length never changed, obvious the moment
        // clips can be trimmed and moved.
        duration: docDuration(prev),
        past: s.past.slice(0, -1),
        future: [clone(s.doc), ...s.future].slice(0, 60),
        selectedIds: s.selectedIds.filter((id) => ids.has(id)),
      }
    }),

  redo: () =>
    set((s) => {
      if (!s.future.length) return {}
      const next = s.future[0]
      const ids = new Set(next.layers.map((l) => l.id))
      return {
        doc: next,
        duration: docDuration(next),
        past: [...s.past, clone(s.doc)],
        future: s.future.slice(1),
        selectedIds: s.selectedIds.filter((id) => ids.has(id)),
      }
    }),

  // ---- document ---------------------------------------------------------
  setDoc: (patch) => set((s) => ({ dirty: true, doc: { ...s.doc, ...patch } })),

  resetDoc: () =>
    set({
      doc: emptyDoc(), selectedIds: [], selectedKey: null, keySelection: [], past: [], future: [],
      workspace: 'editor',
      time: 0, duration: 0, projectName: 'Untitled', projectId: null, dirty: false,
      lasso: null,
    }),

  addLayer: (layer, { select = true } = {}) => {
    const s0 = get()
    s0.pushHistory()
    // In a project that has a timeline, a title is a *clip*. Otherwise it is on
    // for the whole video, which is right for a watermark and wrong for
    // everything anyone actually adds text for. It lands at the playhead on a
    // track of its own above the picture, and can be trimmed and dragged like
    // any other clip — which is the point: the timeline already knew how to do
    // all of this, text simply never had a clip to do it with.
    const timeline = s0.doc.layers.some((l) => l.clip)
    const titleish = layer.type === 'text' || layer.type === 'shape' || layer.type === 'effect'

    // An overlay covers what it was put over. A pixelate is usually there to
    // hide something for as long as that shot is on screen, and a censor that
    // expires three seconds in is worse than no censor at all — you find out by
    // seeing the thing you were hiding. A title is different: three seconds is a
    // title, and trimming it down is the common adjustment.
    const under = s0.doc.layers
      .filter((l) => l.clip && l.assetId)
      .map((l) => ({ l, r: clipRange(l, getAsset(l.assetId)) }))
      .filter(({ r }) => s0.time >= r.start && s0.time < r.end)
      .sort((a, b) => b.r.length - a.r.length)[0]
    const span = layer.type === 'effect' && under
      ? { start: Math.round(under.r.start), out: Math.round(under.r.length) }
      : { start: Math.round(s0.time), out: TITLE_MS }

    // Which track it lands on: one shared with its own kind, if there is room.
    //
    // A track a piece is added to should be the track that kind of thing lives
    // on — all the pixelates on one row, the shapes on another, the titles on a
    // third — because that is how you find them again. A new row per overlay
    // turns ten censors into ten rows, and the timeline stops being readable at
    // about the fourth.
    //
    // Room means not overlapping: two overlays on one row that lap over each
    // other are read as a transition, which is right for two shots and wrong for
    // two censors. When the shared row is busy at that moment, a new one.
    const kindOf = (l) => (l.type === 'effect' ? `effect:${l.effect || 'plain'}` : l.type)
    const wantKind = kindOf(layer)
    const laid = { start: span.start, end: span.start + span.out }
    const assetOf = (l) => getAsset(l.assetId)
    const byTrackKind = new Map()
    for (const l of s0.doc.layers) {
      if (!l.clip) continue
      const t = l.track || 0
      const cur = byTrackKind.get(t) || { kinds: new Set(), spans: [] }
      cur.kinds.add(kindOf(l))
      cur.spans.push(clipRange(l, assetOf(l)))
      byTrackKind.set(t, cur)
    }
    const home = [...byTrackKind.entries()]
      .filter(([, v]) => v.kinds.size === 1 && v.kinds.has(wantKind))
      .filter(([, v]) => !v.spans.some((r) => laid.start < r.end && r.start < laid.end))
      .map(([t]) => t)
      .sort((a, b) => a - b)[0]

    const withClip = timeline && titleish && !layer.clip
      ? {
        ...layer,
        track: home ?? trackCount(s0.doc.layers),
        clip: { start: span.start, in: 0, out: span.out },
      }
      : layer
    set((s) => ({
      dirty: true,
      doc: { ...s.doc, layers: sortByTrack([...s.doc.layers, withClip]) },
      selectedIds: select ? [withClip.id] : s.selectedIds,
    }))
    get().recomputeDuration()
    return withClip
  },

  /**
   * Gives a layer a clip, or takes it away.
   *
   * The way back for anything that should be on for the whole video after all —
   * a watermark, a border — without having to trim it to the exact length of the
   * edit and re-trim it every time the edit changes.
   */
  toggleClip: (id) => {
    const s = get()
    const l = s.doc.layers.find((x) => x.id === id)
    if (!l) return
    s.pushHistory()
    if (l.clip) {
      s.updateLayer(id, { clip: undefined, track: undefined })
    } else {
      s.updateLayer(id, {
        track: trackCount(s.doc.layers),
        clip: { start: Math.round(s.time), in: 0, out: TITLE_MS },
      })
    }
    get().recomputeDuration()
  },

  /**
   * Edits a text layer and re-fits its box.
   *
   * Auto-sized text grows and shrinks with what is in it, anchored so it does
   * not crawl away from where it was put: a left-aligned box keeps its left
   * edge, a centred one keeps its centre, a right-aligned one keeps its right.
   * Height always follows the line count, wrapped or not, so a box can never
   * clip its own text.
   */
  setText: (id, patch) => {
    const s = get()
    const layer = s.doc.layers.find((x) => x.id === id)
    if (!layer || layer.type !== 'text') return
    const next = { ...layer, ...patch }
    const m = measureText(next)
    const out = { ...patch, h: m.h }
    if (next.autoSize !== false) {
      const anchorRight = next.align === 'right'
      const anchorCentre = next.align === 'center'
      out.w = m.w
      if (anchorRight) out.x = layer.x + layer.w - m.w
      else if (anchorCentre) out.x = layer.x + (layer.w - m.w) / 2
    }
    s.updateLayer(id, out)
  },

  /** Re-fits without changing anything, after a font loads or on open. */
  fitText: (id) => get().setText(id, {}),

  updateLayer: (id, patch) =>
    set((s) => ({
      dirty: true,
      doc: {
        ...s.doc,
        layers: s.doc.layers.map((l) => (l.id === id ? { ...l, ...patch } : l)),
      },
    })),

  updateSelected: (patch) =>
    set((s) => ({
      doc: {
        ...s.doc,
        layers: s.doc.layers.map((l) =>
          s.selectedIds.includes(l.id) ? { ...l, ...patch } : l),
      },
    })),

  /** Removes a just-created layer and the history entry that created it. */
  discardLayer: (id) =>
    set((s) => ({
      doc: { ...s.doc, layers: s.doc.layers.filter((l) => l.id !== id) },
      selectedIds: s.selectedIds.filter((x) => x !== id),
      past: s.past.slice(0, -1),
    })),

  removeLayers: (ids) => {
    const s0 = get()
    const all = withDescendants(s0.doc.layers, ids)
    s0.pushHistory()
    set((s) => {
      const layers = s.doc.layers.filter((l) => !all.includes(l.id))
      // An empty document goes back to the default canvas. Keeping the size of
      // media that is no longer there leaves a portrait rectangle floating in
      // the middle of the screen with nothing in it and no way to tell why.
      const base = emptyDoc()
      const doc = layers.length
        ? { ...s.doc, layers }
        : { ...s.doc, layers, width: base.width, height: base.height, duration: 0 }
      return {
        dirty: true,
        doc,
        selectedIds: s.selectedIds.filter((id) => !all.includes(id)),
        view: layers.length ? s.view : { ...s.view, fitRequest: Date.now() },
      }
    })
    get().recomputeDuration()
  },

  duplicateLayers: (ids) => {
    const s0 = get()
    s0.pushHistory()
    const copies = cloneSubtree(s0.doc.layers, ids)
    for (const c of copies) {
      if (typeof c.x === 'number') c.x += 16
      if (typeof c.y === 'number') c.y += 16
      // Only rename what was actually asked for, not a group's contents.
      if (!c.parentId) c.name += ' copy'
    }
    set((s) => ({
      dirty: true,
      doc: { ...s.doc, layers: normalize([...s.doc.layers, ...copies]) },
      selectedIds: copies.filter((c) => !c.parentId).map((c) => c.id),
    }))
    get().recomputeDuration()
  },

  reorderLayer: (id, delta) => {
    get().pushHistory()
    set((s) => {
      const layers = [...s.doc.layers]
      const i = layers.findIndex((l) => l.id === id)
      const j = Math.max(0, Math.min(layers.length - 1, i + delta))
      if (i < 0 || i === j) return {}
      const [item] = layers.splice(i, 1)
      layers.splice(j, 0, item)
      return { doc: { ...s.doc, layers } }
    })
  },

  moveLayerTo: (id, index) => {
    get().pushHistory()
    set((s) => {
      const layers = [...s.doc.layers]
      const i = layers.findIndex((l) => l.id === id)
      if (i < 0) return {}
      const [item] = layers.splice(i, 1)
      layers.splice(Math.max(0, Math.min(layers.length, index)), 0, item)
      return { doc: { ...s.doc, layers } }
    })
  },

  /**
   * Crops the selected image layers to a rectangle, leaving the document alone.
   *
   * This is what "crop this picture" means, and until now nothing did it: the
   * crop tool resized the *document*, and the framing sliders shrank what a
   * layer sampled without shrinking the layer, so the box stayed its old size
   * around a smaller picture with no way to make it fit.
   *
   * The work itself is `cropLayer` with `reorigin: false` — the same code a
   * document crop uses on each layer, minus the part that moves everything into
   * the new document's coordinates.
   */
  cropSelectedTo: (rect) => {
    const s = get()
    const targets = s.doc.layers.filter(
      (l) => s.selectedIds.includes(l.id) && l.type === 'image' && !l.locked,
    )
    if (!targets.length) return 0
    s.pushHistory()
    const ids = new Set(targets.map((l) => l.id))
    set({
      dirty: true,
      doc: {
        ...s.doc,
        layers: s.doc.layers.map((l) => (ids.has(l.id) ? cropLayer(l, rect, { reorigin: false }) : l)),
      },
    })
    set({
      notice: {
        kind: 'ok',
        text: targets.length === 1 ? 'Cropped' : `Cropped ${targets.length} layers`,
      },
    })
    return targets.length
  },

  /**
   * Turns a layer's framing — crop insets, zoom and pan — into a real crop.
   *
   * The insets are a *window* onto the picture, and animatable, which is why
   * they leave the layer box alone: a keyframed crop that resized its layer
   * would move the thing being framed. But that also means a layer cropped with
   * the sliders keeps its full width while showing less of the image, with
   * nothing to press to make that stick. This is that button.
   */
  trimToCrop: (id) => {
    const s = get()
    const l = s.doc.layers.find((x) => x.id === id)
    if (!l || l.type !== 'image') return false
    const framed = isCropped(l) || (l.zoom ?? 1) !== 1 || l.panX || l.panY
    if (!framed) {
      set({ notice: { kind: 'warn', text: 'Nothing to trim — this layer is not cropped.' } })
      return false
    }
    // Animated framing is a moving window by design; freezing one frame of it
    // would silently throw the animation away.
    const t = l.tracks || {}
    if (t.cropT?.length || t.cropB?.length || t.cropL?.length || t.cropR?.length
      || t.zoom?.length || t.panX?.length || t.panY?.length) {
      set({ notice: { kind: 'warn', text: 'That layer has animated framing — trimming would drop it.' } })
      return false
    }

    // The window it currently samples becomes its source; the rectangle it
    // currently draws into becomes its box.
    const src = sourceRect(l)
    const ci = cropInsets(l)
    const w = l.w * ci.kx
    const h = l.h * ci.ky
    // Through fromLocal, so a rotated layer keeps the picture where it was
    // rather than swinging about a centre that just moved.
    const mid = fromLocal(l, -l.w / 2 + ci.cl * l.w + w / 2, -l.h / 2 + ci.ct * l.h + h / 2)

    s.pushHistory()
    get().updateLayer(id, {
      x: mid.x - w / 2,
      y: mid.y - h / 2,
      w,
      h,
      src,
      cropL: 0, cropR: 0, cropT: 0, cropB: 0,
      zoom: 1, panX: 0, panY: 0,
    })
    set({ notice: { kind: 'ok', text: 'Trimmed to the crop' } })
    return true
  },

  applyCrop: (rect) => {
    get().pushHistory()
    set((s) => ({
      doc: {
        ...s.doc,
        width: Math.max(1, Math.round(rect.w)),
        height: Math.max(1, Math.round(rect.h)),
        layers: s.doc.layers.map((l) => cropLayer(l, rect)),
      },
    }))
  },

  /**
   * How the artwork responds when the canvas is resized.
   *
   * `leave` is the default and does nothing to the layers at all — resizing the
   * canvas is changing the frame, not the picture inside it. The old behaviour
   * scaled x and y by the width and height factors *independently*, so changing
   * only the height stretched every layer vertically; asking for a taller canvas
   * is not asking for taller people.
   *
   * The other two scale uniformly about the canvas centre, so nothing is ever
   * distorted: `fit` shrinks the content until all of it is inside the new
   * canvas, `fill` grows it until it covers, cropping the overflow.
   */
  docResize: 'leave',
  setDocResize: (docResize) => set({ docResize }),

  /** Whether editing one canvas dimension carries the other with it. */
  docLinkRatio: false,
  setDocLinkRatio: (docLinkRatio) => set({ docLinkRatio }),

  resizeDoc: (w, h, opts = {}) => {
    const s = get()
    const W = s.doc.width
    const H = s.doc.height
    if (w === W && h === H) return
    const mode = opts.content || s.docResize || 'leave'
    get().pushHistory()

    let layers = s.doc.layers
    if (mode !== 'leave' && W > 0 && H > 0) {
      const k = mode === 'fill' ? Math.max(w / W, h / H) : Math.min(w / W, h / H)
      // About the canvas centre, so content stays where it was composed rather
      // than drifting towards the origin.
      const dx = w / 2 - (W / 2) * k
      const dy = h / 2 - (H / 2) * k
      layers = layers.map((l) => ({
        ...l,
        x: l.x * k + dx,
        y: l.y * k + dy,
        w: l.w * k,
        h: l.h * k,
        pixelSize: l.pixelSize ? Math.max(1, Math.round(l.pixelSize * k)) : l.pixelSize,
        tracks: transformTracks(l.tracks, k, k, dx, dy),
      }))
    }
    set({ doc: { ...s.doc, width: w, height: h, layers } })
  },

  /**
   * Shrinks the canvas to what is actually on it.
   *
   * The counterpart to `fillCanvas`, and the one you want after cropping a
   * layer: crop a picture and the canvas keeps its old size with empty space
   * where the trimmed part used to be. Both existing actions move the *content*
   * — this is the one that moves the frame.
   *
   * It is a document crop to the content's own bounds, so layers keep their
   * positions relative to each other and to the picture; only the origin moves.
   */
  fitCanvasToContent: () => {
    const s = get()
    const ls = s.doc.layers.filter((l) => l.visible !== false && l.type !== 'group')
    if (!ls.length) {
      set({ notice: { kind: 'warn', text: 'Nothing on the canvas to fit to.' } })
      return false
    }
    // Rotation-aware, or a tilted layer would have its corners cut off by a box
    // drawn round the untilted rectangle.
    let x0 = Infinity
    let y0 = Infinity
    let x1 = -Infinity
    let y1 = -Infinity
    for (const l of ls) {
      const b = layerAABB(resolveLayer(l, s.time))
      x0 = Math.min(x0, b.x)
      y0 = Math.min(y0, b.y)
      x1 = Math.max(x1, b.x + b.w)
      y1 = Math.max(y1, b.y + b.h)
    }
    if (!(x1 - x0 > 1) || !(y1 - y0 > 1)) return false

    const rect = {
      x: Math.round(x0),
      y: Math.round(y0),
      w: Math.round(x1 - x0),
      h: Math.round(y1 - y0),
    }
    if (rect.x === 0 && rect.y === 0
      && rect.w === s.doc.width && rect.h === s.doc.height) {
      set({ notice: { kind: 'ok', text: 'The canvas already fits.' } })
      return false
    }
    // `applyCrop` is exactly this: set the size and move everything into the new
    // origin's coordinates. Nothing is trimmed, because the rect contains it all.
    get().applyCrop(rect)
    set({ notice: { kind: 'ok', text: `Canvas fitted to ${rect.w} x ${rect.h}` } })
    return true
  },

  /**
   * Scales the artwork so it covers the whole canvas, cropping whatever falls
   * outside. Unlike the resize modes this works from where the content actually
   * is, so it is useful without changing the canvas at all.
   */
  fillCanvas: () => {
    const s = get()
    const ls = s.doc.layers.filter((l) => l.visible !== false && l.type !== 'effect')
    if (!ls.length) {
      set({ notice: { kind: 'warn', text: 'Nothing to fill the canvas with.' } })
      return
    }
    const x0 = Math.min(...ls.map((l) => Math.min(l.x, l.x + l.w)))
    const y0 = Math.min(...ls.map((l) => Math.min(l.y, l.y + l.h)))
    const x1 = Math.max(...ls.map((l) => Math.max(l.x, l.x + l.w)))
    const y1 = Math.max(...ls.map((l) => Math.max(l.y, l.y + l.h)))
    const cw = x1 - x0
    const ch = y1 - y0
    if (!(cw > 0) || !(ch > 0)) return
    const k = Math.max(s.doc.width / cw, s.doc.height / ch)
    // Centre the content bounds on the canvas as well as scaling them, or a
    // layer sitting off to one side merely gets bigger and stays off to one side.
    const dx = s.doc.width / 2 - (x0 + cw / 2) * k
    const dy = s.doc.height / 2 - (y0 + ch / 2) * k
    if (Math.abs(k - 1) < 0.001 && Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) {
      set({ notice: { kind: 'ok', text: 'Already filling the canvas.' } })
      return
    }
    get().pushHistory()
    set({
      doc: {
        ...s.doc,
        layers: s.doc.layers.map((l) => ({
          ...l,
          x: l.x * k + dx,
          y: l.y * k + dy,
          w: l.w * k,
          h: l.h * k,
          pixelSize: l.pixelSize ? Math.max(1, Math.round(l.pixelSize * k)) : l.pixelSize,
          tracks: transformTracks(l.tracks, k, k, dx, dy),
        })),
      },
      notice: { kind: 'ok', text: 'Content fills the canvas' },
    })
  },

  // ---- audio --------------------------------------------------------------
  volume: 1,
  muted: false,
  /**
   * How fast the preview plays. The clip's own `speed` is a different thing —
   * that retimes the footage and changes how long it occupies the timeline.
   * This changes nothing about the edit, only how you are watching it.
   */
  rate: 1,
  setRate: (rate) => set({ rate }),

  /**
   * The marked range: play it, export it, leave it alone.
   *
   * Null means unmarked, which is not the same as zero — an in-point at the very
   * start is a thing you can set deliberately.
   */
  markIn: null,
  markOut: null,
  setMark: (which, t) => set((s) => {
    const at = t == null ? null : Math.max(0, Math.min(s.duration, Math.round(t)))
    if (which === 'in') {
      // An in-point after the out-point is not a range. Moving one past the
      // other takes the other with it rather than refusing, because refusing
      // mid-drag is how a control feels stuck.
      return { markIn: at, markOut: at != null && s.markOut != null && s.markOut <= at ? null : s.markOut }
    }
    return { markOut: at, markIn: at != null && s.markIn != null && s.markIn >= at ? null : s.markIn }
  }),
  clearMarks: () => set({ markIn: null, markOut: null }),

  setVolume: (volume) => {
    set({ volume })
    setMaster(volume, get().muted)
  },
  toggleMuted: () => {
    const muted = !get().muted
    set({ muted })
    setMaster(get().volume, muted)
    return muted
  },

  /** Whether anything in the document could make a sound. */
  hasSound: () => get().doc.layers.some((l) => getAsset(l.assetId)?.audio),

  /**
   * Decodes the sound for every layer that has any.
   *
   * Done on demand rather than at import: a long soundtrack decoded to PCM is
   * hundreds of megabytes, and most projects are never played with sound.
   */
  loadSound: async () => {
    const s = get()
    const jobs = []
    for (const l of s.doc.layers) {
      const a = getAsset(l.assetId)
      if (a?.isVideo && a.audio === undefined) jobs.push(ensureAudio(a))
    }
    if (jobs.length) await Promise.all(jobs)
    return get().hasSound()
  },

  // ---- photo mounts -------------------------------------------------------

  /**
   * Puts a photo mount around layers — the same card the collage prints, on its
   * own.
   *
   * The box grows rather than the picture shrinking. A mount drawn inside the
   * existing box would make the photo smaller the moment you framed it, which is
   * the opposite of what a frame is for: nothing about the picture should change
   * because something was put around it.
   */
  mountLayers: (ids, style = 'polaroid', opts = {}) => {
    const s = get()
    const targets = s.doc.layers.filter((l) => ids.includes(l.id) && l.type === 'image')
    if (!targets.length) return 0
    s.pushHistory()
    const border = opts.border ?? 0.05

    for (const l of targets) {
      if (style === 'none') {
        get().updateLayer(l.id, { frame: null })
        continue
      }
      const ins = cardInsets(style, border)
      // What the picture currently occupies, so it can occupy exactly that after.
      const prev = l.frame?.on ? (l.frame.insets || { l: 0, r: 0, t: 0, b: 0 }) : { l: 0, r: 0, t: 0, b: 0 }
      const picW = l.w * (1 - prev.l - prev.r)
      const picH = l.h * (1 - prev.t - prev.b)
      const picX = l.x + l.w * prev.l
      const picY = l.y + l.h * prev.t
      const w = picW / Math.max(0.05, 1 - ins.l - ins.r)
      const h = picH / Math.max(0.05, 1 - ins.t - ins.b)

      get().updateLayer(l.id, {
        x: picX - w * ins.l,
        y: picY - h * ins.t,
        w,
        h,
        frame: {
          on: true,
          insets: ins,
          color: opts.color || '#ffffff',
          shadow: opts.shadow ?? 14,
          shadowY: opts.shadowY ?? 6,
          shadowColor: opts.shadowColor || 'rgba(0,0,0,0.45)',
          radius: opts.radius ?? 2,
        },
        ...(opts.tilt ? { rotation: (Math.random() * 2 - 1) * opts.tilt } : null),
      })
    }
    set({ notice: { kind: 'ok', text: targets.length === 1 ? 'Mounted' : `Mounted ${targets.length}` } })
    return targets.length
  },

  /**
   * Places media on the canvas already mounted. One gesture, not two.
   *
   * The card is then fitted to the canvas. `mountLayers` deliberately never
   * changes the photo, which is right when framing something already placed —
   * but a photo that filled the frame would gain a border entirely off-screen,
   * and clicking Polaroid would appear to do nothing at all. Placing is the
   * moment to choose a size, so this is where it is chosen.
   */
  placeMounted: (assetIds, style = 'polaroid', opts = {}) => {
    const made = get().placeMedia(assetIds, { resizeDocToFirst: false })
    if (!made?.length) return []
    get().mountLayers(made, style, { tilt: 4, ...opts })

    const s = get()
    const { width, height } = s.doc
    // A little under the frame, so a tilted card does not clip its own corners.
    const room = 0.92
    set({
      doc: {
        ...s.doc,
        layers: s.doc.layers.map((l) => {
          if (!made.includes(l.id)) return l
          const k = Math.min(1, (width * room) / l.w, (height * room) / l.h)
          if (k >= 1) return l
          const w = l.w * k
          const h = l.h * k
          // About its own centre, so a card placed off to one side stays there.
          return { ...l, w, h, x: l.x + (l.w - w) / 2, y: l.y + (l.h - h) / 2 }
        }),
      },
    })
    return made
  },

  // ---- clips ------------------------------------------------------------
  //
  // A clip turns a layer from "this media, always" into "this piece of this
  // media, here". Everything below is the small set of operations an edit is
  // actually made of: give a layer a clip, slide it, trim an end, cut it in two,
  // and close the gaps afterwards.

  /** How many track rows the document is using. */
  trackCount: () => trackCount(get().doc.layers),

  // The document time a dragging clip has lined up with, for the timeline to
  // draw a guide at. Lives here rather than in the clip because the line is
  // drawn across every track, not inside the one being dragged.
  snapAt: null,
  setSnapAt: (snapAt) => set({ snapAt }),

  /**
   * Moves a clip to another track.
   *
   * The layer array is re-sorted afterwards, because that array *is* stacking
   * order — keeping a separate track order beside it would be two truths that
   * can disagree, and the renderer would have to learn about tracks to resolve
   * them. This way it never does.
   */
  setClipTrack: (id, track, { commit = true } = {}) => {
    const s = get()
    const l = s.doc.layers.find((x) => x.id === id)
    const next = Math.max(0, Math.round(track))
    if (!l?.clip || (l.track || 0) === next) return
    if (commit) s.pushHistory()
    const layers = sortByTrack(
      s.doc.layers.map((x) => (x.id === id ? { ...x, track: next } : x)),
    )
    set({ dirty: true, doc: { ...s.doc, layers } })
  },

  /**
   * Puts media on the timeline as a clip. This is how clips come to exist —
   * the gesture that creates one is the same gesture that says where it goes,
   * so there is nothing to press first.
   */
  insertClip: (assetId, { track = 0, at = 0, select: sel = true } = {}) => {
    const asset = getAsset(assetId)
    if (!asset) return null
    const s = get()
    s.pushHistory()
    const { width, height } = s.doc
    const fit = Math.min(1, width / asset.width, height / asset.height)
    const w = asset.width * fit
    const h = asset.height * fit
    const layer = {
      id: nid('l'),
      type: 'image',
      name: asset.name,
      assetId: asset.id,
      x: (width - w) / 2,
      y: (height - h) / 2,
      w,
      h,
      rotation: 0,
      radius: 0,
      opacity: 1,
      blend: 'source-over',
      visible: true,
      locked: false,
      flipX: false,
      flipY: false,
      speed: 1,
      timeOffset: 0,
      track: Math.max(0, Math.round(track)),
      clip: wholeClip({}, asset, freeSpotOn(s.doc.layers, Math.max(0, Math.round(track)), at)),
      ...imageFraming(),
      adjust: defaultAdjust(),
    }
    const layers = sortByTrack([...s.doc.layers, layer])
    set({
      dirty: true,
      workspace: 'editor',
      doc: { ...s.doc, layers, media: [...new Set([...(s.doc.media || []), assetId])] },
      ...(sel ? { selectedIds: [layer.id] } : null),
      notice: { kind: 'ok', text: `Added ${asset.name}` },
    })
    get().recomputeDuration()
    return layer.id
  },

  /** Gives a layer a clip covering its whole source, placed at `at`. */
  makeClip: (id, at = null) => {
    const s = get()
    const l = s.doc.layers.find((x) => x.id === id)
    if (!l || l.clip) return
    s.pushHistory()
    const clip = wholeClip(l, getAsset(l.assetId), at == null ? s.time : at)
    get().updateLayer(id, { clip })
    get().recomputeDuration()
  },

  /** Takes the clip off, so the layer is simply visible throughout again. */
  clearClip: (id) => {
    const s = get()
    const l = s.doc.layers.find((x) => x.id === id)
    if (!l?.clip) return
    s.pushHistory()
    get().updateLayer(id, { clip: null })
    get().recomputeDuration()
  },

  /**
   * Moves a clip along the timeline. `commit` false while a drag is in flight.
   *
   * Whatever is riding on it comes along. A censor and the shot it covers are on
   * different rows, and a row is not a bond — slide the shot and the face moves
   * out from under its own blur, which is the one way this feature can fail
   * badly rather than merely annoyingly.
   */
  slideClip: (id, start, { commit = true } = {}) => {
    const s = get()
    const l = s.doc.layers.find((x) => x.id === id)
    if (!l?.clip) return
    const assetOf = (x) => getAsset(x.assetId)
    const clip = slideTo(l, start)
    const delta = (clip.start || 0) - (l.clip.start || 0)
    const riders = delta ? ridersOf(s.doc.layers, l, assetOf) : []
    if (commit) s.pushHistory()
    const moved = new Map(riders.map((r) => [r.id, { ...r.clip, start: Math.max(0, (r.clip.start || 0) + delta) }]))
    set({
      dirty: true,
      doc: {
        ...s.doc,
        layers: s.doc.layers.map((x) => {
          if (x.id === id) return { ...x, clip }
          return moved.has(x.id) ? { ...x, clip: moved.get(x.id) } : x
        }),
      },
    })
    get().recomputeDuration()
  },

  /** Drags one end of a clip to a document time. */
  trimClip: (id, edge, time, { commit = true } = {}) => {
    const s = get()
    const l = s.doc.layers.find((x) => x.id === id)
    if (!l?.clip) return
    const clip = trimTo(l, edge, time, getAsset(l.assetId))
    if (!clip) return
    if (commit) s.pushHistory()
    get().updateLayer(id, { clip })
    get().recomputeDuration()
  },

  /**
   * Cuts clips at a time, replacing each with two.
   *
   * With no ids it cuts every clip the playhead is inside, which is what a cut
   * on a timeline usually means. The new half is inserted directly above its
   * original so the stacking order is unchanged — a cut that reshuffles what is
   * in front of what would change the picture, which a cut must never do.
   */
  splitClips: (time = null, ids = null) => {
    const s = get()
    const at = time == null ? s.time : time
    const targets = (ids || s.doc.layers.map((l) => l.id))
      .map((id) => s.doc.layers.find((l) => l.id === id))
      .filter((l) => l?.clip && splitAt(l, at, getAsset(l.assetId)))
    if (!targets.length) {
      set({ notice: { kind: 'warn', text: 'Nothing to cut at the playhead.' } })
      return 0
    }
    s.pushHistory()
    const layers = []
    const made = []
    for (const l of s.doc.layers) {
      const hit = targets.find((t) => t.id === l.id)
      if (!hit) { layers.push(l); continue }
      const [a, b] = splitAt(l, at, getAsset(l.assetId))
      // A fade belongs to the outside edges of a run. Cloning the layer copied
      // the whole thing to both halves, which put a fade to nothing at the cut
      // — the picture dipped in the middle of continuous footage, twice.
      const speed = Math.abs(l.speed || 1) || 1
      const [fa, fb] = splitFade(l.fade, (a.out - a.in) / speed, (b.out - b.in) / speed)
      const right = { ...clone(l), id: nid('l'), clip: b, fade: fb }
      layers.push({ ...l, clip: a, fade: fa })
      layers.push(right)
      made.push(right.id)
    }
    set({
      doc: { ...s.doc, layers },
      selectedIds: made,
      notice: { kind: 'ok', text: `Cut ${targets.length} clip${targets.length === 1 ? '' : 's'}` },
    })
    get().recomputeDuration()
    return targets.length
  },

  /** Lays every clip end to end in its current order, closing the gaps. */
  closeClipGaps: () => {
    const s = get()
    const assetOf = (l) => getAsset(l.assetId)
    const moves = closeGaps(s.doc.layers, assetOf)
    if (!moves.size) return
    s.pushHistory()
    // Overlays are not laid end to end — they sit over shots — so `closeGaps`
    // leaves them alone, and they have to be carried by whatever moved beneath.
    for (const l of s.doc.layers) {
      if (!moves.has(l.id) || !l.assetId) continue
      const delta = (moves.get(l.id).start || 0) - (l.clip.start || 0)
      if (!delta) continue
      for (const r of ridersOf(s.doc.layers, l, assetOf)) {
        moves.set(r.id, { ...r.clip, start: Math.max(0, (r.clip.start || 0) + delta) })
      }
    }
    set({
      doc: {
        ...s.doc,
        layers: s.doc.layers.map((l) => (moves.has(l.id) ? { ...l, clip: moves.get(l.id) } : l)),
      },
      notice: { kind: 'ok', text: 'Gaps closed' },
    })
    get().recomputeDuration()
  },

  /** Every clip, in timeline order, with where it sits. For the timeline UI. */
  clipList: () => {
    const s = get()
    return s.doc.layers
      .filter((l) => l.clip)
      .map((l) => ({ id: l.id, name: l.name, type: l.type, ...clipRange(l, getAsset(l.assetId)) }))
      .sort((a, b) => a.start - b.start)
  },

  // ---- clipboard --------------------------------------------------------
  copyLayers: (ids) => {
    const s = get()
    const all = withDescendants(s.doc.layers, ids)
    const picked = s.doc.layers.filter((l) => all.includes(l.id))
    if (!picked.length) return 0
    set({ clipboard: picked.map(clone), clipboardRoots: ids.length, clipboardOwned: false })
    claimSystemClipboard(ids.length).then((clipboardOwned) => set({ clipboardOwned }))
    return ids.length
  },

  cutLayers: (ids) => {
    const n = get().copyLayers(ids)
    if (n) get().removeLayers(ids)
    return n
  },

  pasteLayers: () => {
    const s = get()
    if (!s.clipboard.length) return 0
    s.pushHistory()
    const roots = s.clipboard.filter((l) => !l.parentId).map((l) => l.id)
    const fresh = cloneSubtree(s.clipboard, roots)
    for (const l of fresh) {
      if (typeof l.x === 'number') l.x += 16
      if (typeof l.y === 'number') l.y += 16
      if (!l.parentId && !/copy$/.test(l.name)) l.name += ' copy'
    }
    set((st) => ({
      dirty: true,
      doc: { ...st.doc, layers: normalize([...st.doc.layers, ...fresh]) },
      selectedIds: fresh.filter((l) => !l.parentId).map((l) => l.id),
    }))
    get().recomputeDuration()
    return fresh.filter((l) => !l.parentId).length
  },

  /**
   * The kind of transition on a clip.
   *
   * There is no action to *create* one and none to delete one, because there is
   * nothing to create: two clips lapping over each other on a track is the
   * transition, and pulling them apart ends it. All that can be stored is which
   * kind it is, and even that is only written once it stops being a crossfade.
   */
  setTransitionKind: (id, kind) => {
    const s = get()
    s.pushHistory()
    s.updateLayer(id, kind === DEFAULT_TRANSITION
      ? { transition: undefined }
      : { transition: { kind } })
  },

  /**
   * How long a clip takes to come up at its start or go away at its end.
   *
   * Capped at half the clip each, so the two can never cross and there is never
   * a moment defined by both. Zero on both ends drops the field rather than
   * leaving `{in: 0, out: 0}` behind, so a clip with no fades is the same
   * document it was before anyone touched the handles.
   */
  setFade: (id, patch, { commit = true } = {}) => {
    const s = get()
    const l = s.doc.layers.find((x) => x.id === id)
    if (!l?.clip) return
    const cap = maxFade(clipRange(l, getAsset(l.assetId)).length)
    const next = {
      in: Math.round(Math.max(0, Math.min(cap, patch.in ?? l.fade?.in ?? 0))),
      out: Math.round(Math.max(0, Math.min(cap, patch.out ?? l.fade?.out ?? 0))),
    }
    if (commit) s.pushHistory()
    get().updateLayer(id, {
      fade: next.in === 0 && next.out === 0 ? undefined : next,
    })
  },

  /**
   * Deletes clips and closes the hole behind them.
   *
   * The ordinary delete leaves a gap, and the only tool for that was Close gaps,
   * which closes *every* gap on the track — including ones put there on purpose.
   * Rippling is the common case: you cut something out because you want it gone,
   * not because you want a silence where it was.
   *
   * Each track closes over its own hole, by the length of what was removed from
   * *that* track. Shifting every track by the same amount would drag clips on a
   * second track out of sync with the picture they were laid against.
   */
  rippleDelete: (ids = null) => {
    const s = get()
    const picked = (ids || s.selectedIds)
      .map((id) => s.doc.layers.find((l) => l.id === id))
      .filter((l) => l?.clip)
    if (!picked.length) {
      return { ok: false, reason: 'Select a clip on the timeline to ripple out.' }
    }

    const assetOf = (l) => getAsset(l.assetId)
    // Where each track's hole starts, and how wide it is.
    const holes = new Map()
    for (const l of picked) {
      const t = l.track || 0
      const r = clipRange(l, assetOf(l))
      const cur = holes.get(t) || { from: Infinity, span: 0 }
      cur.from = Math.min(cur.from, r.start)
      cur.span += r.length
      holes.set(t, cur)
    }

    s.pushHistory()
    const gone = new Set(picked.map((l) => l.id))
    // A censor goes out with the shot it was censoring. Leaving it behind is
    // worse than useless: the shot after slides up underneath it and gets blurred
    // instead.
    for (const l of picked) for (const r of ridersOf(s.doc.layers, l, assetOf)) gone.add(r.id)
    // What each surviving overlay is riding on, worked out before anything moves.
    const hosts = new Map()
    for (const l of s.doc.layers) {
      if (gone.has(l.id) || !l.clip || !l.assetId) continue
      for (const r of ridersOf(s.doc.layers, l, assetOf)) hosts.set(r.id, l)
    }
    const shifted = (l) => {
      const hole = holes.get(l.track || 0)
      if (!hole) return 0
      const start = clipRange(l, assetOf(l)).start
      return start < hole.from ? 0 : hole.span
    }
    const layers = s.doc.layers
      .filter((l) => !gone.has(l.id))
      .map((l) => {
        if (!l.clip) return l
        // An overlay moves by whatever its host moved by, not by what the hole on
        // its own row happens to be — the hole is on the row the shot was on.
        const by = isOverlay(l) ? (hosts.has(l.id) ? shifted(hosts.get(l.id)) : 0) : shifted(l)
        if (!by) return l
        const start = clipRange(l, assetOf(l)).start
        return { ...l, clip: { ...l.clip, start: Math.max(0, start - by) } }
      })
    set({ dirty: true, doc: { ...s.doc, layers }, selectedIds: [] })
    get().recomputeDuration()
    return { ok: true, text: `Rippled out ${picked.length} clip${picked.length === 1 ? '' : 's'}` }
  },

  setContextMenu: (contextMenu) => set({ contextMenu }),

  // ---- motion tracking --------------------------------------------------
  tracking: null,   // { progress } while a track is running
  matting: null,    // { progress, stage } while the learned matte runs

  /**
   * Runs the segmentation model over every frame of a layer's asset and parks
   * the masks for the renderer. Inference cannot happen inside a synchronous
   * render, so it is an explicit action with visible progress.
   */
  runAiMatte: async (id) => {
    const s = get()
    const layer = s.doc.layers.find((x) => x.id === id)
    if (!layer || layer.type !== 'image') {
      set({ notice: { kind: 'warn', text: 'Pick an image layer first.' } })
      return
    }
    const asset = getAsset(layer.assetId)
    if (!asset) return
    // Video frames are not all in memory, so matte the frame in view rather than
    // decoding the whole clip.
    let frames
    if (asset.isVideo) {
      const bmp = sourceFor(layer, s.time)
      if (!bmp) {
        set({ notice: { kind: 'warn', text: 'Let the video decode a frame first.' } })
        return
      }
      frames = [bmp]
    } else {
      frames = asset.live ? [asset.el] : asset.frames.map((f) => f.bitmap)
    }
    setModel(layer.bgRemove?.model || 'modnet')

    set({ matting: { progress: 0, stage: 'Loading model' } })
    try {
      for (let i = 0; i < frames.length; i++) {
        const mask = await predictMask(frames[i], {
          onProgress: (p) => set({ matting: { progress: p, stage: 'Downloading model' } }),
        })
        rememberMask(frames[i], mask)
        set({ matting: { progress: (i + 1) / frames.length, stage: 'Segmenting' } })
      }
      s.pushHistory()
      s.updateLayer(id, {
        bgRemove: {
          ...defaultBgRemove(), ...layer.bgRemove, on: true, mode: 'ai',
          model: layer.bgRemove?.model || 'modnet',
        },
      })
      set({
        notice: {
          kind: 'ok',
          text: `Matted ${frames.length} frame${frames.length === 1 ? '' : 's'} `
            + `with ${currentModel().name} on ${currentBackend() === 'webgpu' ? 'the GPU' : 'the CPU'}`,
        },
      })
    } catch (err) {
      console.error('[pixelforge] matte failed', err)
      set({ notice: { kind: 'warn', text: 'Background model failed: ' + err.message } })
    } finally {
      set({ matting: null })
    }
  },

  /**
   * Text behind the subject.
   *
   * Nothing new is rendered for this: the image is left whole underneath, a
   * text layer goes on top of it, and a second copy of the *same* image sits
   * above the text with the matte switched on. Because both copies share one
   * asset, they share the mask cache too, so the model runs once and the
   * effect costs one extra draw. The three are grouped so they move together.
   */
  textBehindSubject: (id, opts = {}) => {
    const s = get()
    const layer = s.doc.layers.find((x) => x.id === id)
    if (!layer || layer.type !== 'image') {
      set({ notice: { kind: 'warn', text: 'Pick an image or video layer first.' } })
      return
    }
    // Anything that isolates the subject will do. Requiring background removal
    // was too narrow: cutting the subject out with the lasso — including the AI
    // one — is the more natural route, and it already produces exactly the mask
    // this needs.
    const hasKey = !!layer.bgRemove?.on
    const hasLasso = (layer.mask?.points?.length || 0) >= 3
    if (!hasKey && !hasLasso) {
      set({
        notice: {
          kind: 'warn',
          text: 'Isolate the subject first — either remove the background, or draw a lasso '
            + 'around it (AI select does it in one click) and use Mask.',
        },
      })
      return
    }
    s.pushHistory()

    const idx = s.doc.layers.indexOf(layer)
    // The lower copy shows the whole photo, so whichever isolation is in play is
    // switched off there; the upper copy keeps it and becomes the subject.
    const back = {
      ...layer,
      name: layer.name + ' (background)',
      bgRemove: hasKey ? { ...layer.bgRemove, on: false } : layer.bgRemove,
      mask: undefined,
    }
    const front = {
      ...clone(layer),
      id: nid('l'),
      name: layer.name + ' (subject)',
      bgRemove: hasKey ? { ...layer.bgRemove, on: true } : layer.bgRemove,
    }
    const size = Math.round(Math.min(layer.w, layer.h) * 0.28)
    const text = makeTextLayer({
      name: 'Behind text',
      text: 'BEHIND',
      size,
      weight: 900,
      align: 'center',
      // Given a width up front, so it wraps inside the photo rather than
      // growing off the side of it.
      autoSize: false,
      w: layer.w * 0.92,
      h: size * 1.2,
      x: layer.x + layer.w * 0.04,
      y: layer.y + layer.h / 2 - size * 0.6,
      // The outline pass: the letters are stroked again over everything, so
      // where the subject covers them you still see their shape. Over the solid
      // text it is the same colour and invisible, which is why one layer can do
      // both jobs.
      // Aimed at the cut-out copy specifically, so anything added later can
      // still cover both. Set after the copy exists, below.
      outlineAbove: false,
      outlineWidth: Math.max(1.5, size * 0.03),
    })

    const layers = [...s.doc.layers]
    layers[idx] = back
    layers.splice(idx + 1, 0, text, front)

    const group = makeGroupLayer({ name: 'Text behind subject', parentId: layer.parentId || null })
    const members = [back.id, text.id, front.id]
    const placed = layers.filter((l) => !members.includes(l.id))
    const at = layers.slice(0, idx).filter((l) => !members.includes(l.id)).length
    placed.splice(at, 0, group,
      ...[back, text, front].map((l) => ({ ...l, parentId: group.id })))

    set({
      dirty: true,
      doc: { ...s.doc, layers: normalize(placed) },
      selectedIds: [text.id],
      notice: { kind: 'ok', text: 'Type your text — it sits behind the subject.' },
    })
    // Only the cut-out shrink-wraps. The copy underneath is the whole picture
    // and has to stay the whole picture — trimming that too would crop the
    // photograph down to the person standing in it.
    if (opts.outline !== false) get().updateLayer(text.id, { outlineAbove: front.id })
    if (hasLasso) get().trimToSubject(front.id, { quiet: true })
    get().recomputeDuration()
    return text.id
  },

  /**
   * Shrink-wraps a layer to its subject.
   *
   * Removing a background leaves a full-frame layer that is mostly transparent,
   * which is awkward to position, snap or rotate — the handles are nowhere near
   * the thing you can see. This trims the box to what the matte actually keeps,
   * the same shape a lasso cut-out produces, and it does it through the
   * existing non-destructive source window rather than by baking anything, so
   * it is one undo away from the full frame.
   *
   * For an animated layer the box is the union across sampled frames: a subject
   * that walks across the shot must not walk out of its own layer.
   */
  trimToSubject: (id, { quiet = false } = {}) => {
    const s = get()
    const layer = s.doc.layers.find((x) => x.id === id)
    if (!layer || layer.type !== 'image') {
      set({ notice: { kind: 'warn', text: 'Pick an image or video layer first.' } })
      return
    }
    const hasLasso = (layer.mask?.points?.length || 0) >= 3
    if (!layer.bgRemove?.on && !hasLasso) {
      set({
        notice: {
          kind: 'warn',
          text: 'Nothing is cut out yet — remove the background, or lasso the subject and Mask.',
        },
      })
      return
    }
    const asset = getAsset(layer.assetId)
    if (!asset) return

    // Sampled rather than exhaustive: a 2000-frame video does not need every
    // frame measured to find the box its subject stays inside.
    const duration = asset.animated ? asset.duration : 0
    const samples = duration > 0 ? 12 : 1
    const boxes = []
    if (layer.bgRemove?.on) {
      for (let i = 0; i < samples; i++) {
        const t = duration > 0 ? (i / samples) * duration : 0
        const raw = sourceFor({ ...layer, loop: null, timeOffset: 0, speed: 1 }, t)
        const cut = subjectFrame(raw, layer.bgRemove)
        if (cut) boxes.push(alphaBounds(cut))
      }
    }
    // A lasso mask bounds the subject just as well as a matte does, and it is
    // the more natural way to get one — so a masked layer trims too, which is
    // what makes AI select produce a layer the size of the thing it selected.
    if (hasLasso) {
      const r0 = sourceRect(layer)
      // Every outline the mask is made of, not just the one it started as: a
      // mask that has been repaired keeps the repair in a second outline, and
      // measuring only the first would trim the repair straight back off.
      const mb = maskBounds(layer)
      // Mask points are fractions of the layer *box*; the drawn picture is the
      // box minus its crop insets, so they are rebased onto the source window
      // before being compared with anything measured from the pixels.
      const ci = cropInsets(layer)
      const toSrc = (u, lo, keep) => (Math.min(1, Math.max(0, (u - lo) / keep)))
      boxes.push({
        x: r0.x + toSrc(mb.u0, ci.cl, ci.kx) * r0.w,
        y: r0.y + toSrc(mb.v0, ci.ct, ci.ky) * r0.h,
        w: (toSrc(mb.u1, ci.cl, ci.kx) - toSrc(mb.u0, ci.cl, ci.kx)) * r0.w,
        h: (toSrc(mb.v1, ci.ct, ci.ky) - toSrc(mb.v0, ci.ct, ci.ky)) * r0.h,
      })
    }
    const box = unionBounds(boxes)
    if (!box) {
      set({
        notice: {
          kind: 'warn',
          text: layer.bgRemove.mode === 'ai'
            ? 'No mask yet — run the AI matte first, then trim.'
            : 'The matte is empty, so there is nothing to trim to.',
        },
      })
      return
    }
    if (box.w > 0.995 && box.h > 0.995) {
      set({ notice: { kind: 'warn', text: 'The subject already fills the frame — nothing to trim.' } })
      return
    }

    // The visible window before and after, both in 0..1 of the asset. The new
    // box is clamped into the old one so a trim can never reveal something an
    // earlier crop had removed.
    const r = sourceRect(layer)
    const nx = Math.max(r.x, Math.min(box.x, r.x + r.w))
    const ny = Math.max(r.y, Math.min(box.y, r.y + r.h))
    const nx2 = Math.min(r.x + r.w, Math.max(box.x + box.w, r.x))
    const ny2 = Math.min(r.y + r.h, Math.max(box.y + box.h, r.y))
    const clamped = { x: nx, y: ny, w: Math.max(1e-4, nx2 - nx), h: Math.max(1e-4, ny2 - ny) }

    // Where that window sits inside the box being drawn now, so the subject does
    // not jump: the same fractions of the destination rect.
    const ci = cropInsets(layer)
    const dx = layer.x + ci.cl * layer.w
    const dy = layer.y + ci.ct * layer.h
    const dw = layer.w * ci.kx
    const dh = layer.h * ci.ky
    const u = (clamped.x - r.x) / r.w
    const v = (clamped.y - r.y) / r.h
    const w = (clamped.w / r.w) * dw
    const h = (clamped.h / r.h) * dh
    const x = dx + u * dw
    const y = dy + v * dh

    // Rotation is about the layer's centre, so moving the box moves the pivot.
    // The new centre is carried around the old one by the same angle, which is
    // what keeps a rotated subject exactly where it was.
    const oldCx = layer.x + layer.w / 2
    const oldCy = layer.y + layer.h / 2
    const a = ((layer.rotation || 0) * Math.PI) / 180
    const ox = x + w / 2 - oldCx
    const oy = y + h / 2 - oldCy
    const cx = oldCx + ox * Math.cos(a) - oy * Math.sin(a)
    const cy = oldCy + ox * Math.sin(a) + oy * Math.cos(a)

    // Mask points are fractions of the layer box, so shrinking the box without
    // rebasing them would slide the mask across the picture. Both boxes share a
    // rotation, so the conversion is done in the unrotated frame where it is
    // just a change of origin and scale.
    const nx0 = cx - w / 2
    const ny0 = cy - h / 2
    const mask = hasLasso
      ? {
          ...layer.mask,
          points: layer.mask.points.map(([u, v2]) => [
            (layer.x + u * layer.w - x) / Math.max(1e-6, w),
            (layer.y + v2 * layer.h - y) / Math.max(1e-6, h),
          ]),
        }
      : layer.mask

    s.pushHistory()
    s.updateLayer(id, {
      src: clamped,
      // The framing controls described the old window, so they are reset rather
      // than left pointing at a rect that no longer exists.
      cropT: 0, cropR: 0, cropB: 0, cropL: 0, zoom: 1, panX: 0, panY: 0,
      ...(hasLasso ? { mask } : null),
      x: nx0,
      y: ny0,
      w,
      h,
    })
    const pct = Math.round((1 - (clamped.w * clamped.h) / (r.w * r.h)) * 100)
    if (!quiet) {
      set({
        notice: {
          kind: 'ok',
          text: `Trimmed to the subject — ${pct}% of the frame was empty`
            + (samples > 1 && layer.bgRemove?.on ? `, measured across ${samples} frames.` : '.'),
        },
      })
    }
    return { x: cx - w / 2, y: cy - h / 2, w, h }
  },

  /** Turns sticker styling on with sane defaults, or off. */
  toggleSticker: (id, on) => {
    const s = get()
    const layer = s.doc.layers.find((x) => x.id === id)
    if (!layer) return
    if (on && !layer.bgRemove?.on) {
      set({ notice: { kind: 'warn', text: 'A sticker needs a cutout — remove the background first.' } })
      return
    }
    s.pushHistory()
    s.updateLayer(id, { sticker: { ...defaultSticker(), ...layer.sticker, on } })
  },

  toggleTrails: (id, on) => {
    const s = get()
    const layer = s.doc.layers.find((x) => x.id === id)
    if (!layer) return
    s.pushHistory()
    s.updateLayer(id, { trails: { ...defaultTrails(), ...layer.trails, on } })
  },

  // ---- loop repair ------------------------------------------------------
  setLoop: (id, patch) => {
    const s = get()
    const layer = s.doc.layers.find((x) => x.id === id)
    if (!layer) return
    s.pushHistory()
    s.updateLayer(id, { loop: { on: true, mode: 'none', crossfadeMs: 0, trimEndMs: 0, ...layer.loop, ...patch } })
    s.recomputeDuration()
  },

  /**
   * Measures how badly the clip fails to loop and applies the repair it
   * recommends. The measurement is reported verbatim — if it cannot tell, it
   * says so rather than picking something that merely looks decisive.
   */
  analyzeLoop: (id) => {
    const s = get()
    const layer = s.doc.layers.find((x) => x.id === id)
    const asset = layer && getAsset(layer.assetId)
    if (!asset?.animated || asset.isVideo) {
      set({ notice: { kind: 'warn', text: 'Loop repair needs a frame-decoded clip — import a GIF.' } })
      return
    }
    const c = document.createElement('canvas')
    const cx = c.getContext('2d', { willReadFrequently: true })
    const sampleRGBA = (i) => {
      const bmp = asset.frames[i]?.bitmap
      if (!bmp) return null
      const w = bmp.width
      const h = bmp.height
      if (c.width !== w || c.height !== h) { c.width = w; c.height = h }
      cx.clearRect(0, 0, w, h)
      cx.drawImage(bmp, 0, 0)
      return cx.getImageData(0, 0, w, h)
    }
    const rec = suggestLoop(asset, sampleRGBA)
    s.pushHistory()
    s.updateLayer(id, {
      loop: { on: rec.mode !== 'none' || rec.trimEndMs > 0, ...rec },
    })
    s.recomputeDuration()
    set({ notice: { kind: 'ok', text: rec.note } })
    return rec
  },

  /** Cinemagraph: everything freezes except what the layer's mask lets through. */
  setFreeze: (id, on) => {
    const s = get()
    const layer = s.doc.layers.find((x) => x.id === id)
    if (!layer) return
    if (on && !(layer.mask?.points?.length >= 3)) {
      set({ notice: { kind: 'warn', text: 'Draw a lasso mask on this layer first — that is the part that stays alive.' } })
      return
    }
    s.pushHistory()
    s.updateLayer(id, { freeze: { on, time: layer.freeze?.time ?? s.time } })
  },

  /**
   * Finds the mouse in a screen recording and writes camera moves that follow
   * it, as ordinary zoom/pan keyframes.
   *
   * Detection runs on a downscaled copy: it is frame differencing, so the
   * signal survives the resize intact, and full-resolution detection would cost
   * roughly ten times as much for no extra accuracy at this scale.
   */
  autoCursorZoom: async (id, opts = {}) => {
    const s = get()
    const layer = s.doc.layers.find((x) => x.id === id)
    const asset = layer && getAsset(layer.assetId)
    if (!asset?.animated) {
      set({ notice: { kind: 'warn', text: 'Import a screen recording first.' } })
      return
    }
    const fps = opts.fps || 12
    const duration = asset.duration
    const count = Math.min(600, Math.max(4, Math.round((duration / 1000) * fps)))
    const scale = Math.min(1, 960 / asset.width)
    const w = Math.max(2, Math.round(asset.width * scale))
    const h = Math.max(2, Math.round(asset.height * scale))
    const c = document.createElement('canvas')
    c.width = w
    c.height = h
    const cx = c.getContext('2d', { willReadFrequently: true })

    set({ tracking: { progress: 0 } })
    try {
      const frames = []
      const times = []
      for (let i = 0; i < count; i++) {
        const t = (i / count) * duration
        times.push(t)
        const bmp = asset.isVideo ? await exactFrame(asset, t) : sourceFor({ ...layer, loop: null }, t)
        if (!bmp) continue
        cx.clearRect(0, 0, w, h)
        cx.drawImage(bmp, 0, 0, w, h)
        frames.push(cx.getImageData(0, 0, w, h))
        if (i % 8 === 0) set({ tracking: { progress: (i / count) * 0.7 } })
      }
      if (frames.length < 4) {
        set({ notice: { kind: 'warn', text: 'Could not read enough frames to look for a cursor.' } })
        return
      }
      set({ tracking: { progress: 0.75 } })
      const raw = cursorPath(frames, { times: times.slice(0, frames.length) })
      const found = raw.filter((p) => p.confidence > 0.35).length
      if (found < frames.length * 0.15) {
        set({
          notice: {
            kind: 'warn',
            text: `Found a moving cursor in only ${found} of ${frames.length} frames — this may not be a screen recording, `
              + 'or the pointer barely moves. Nothing was changed.',
          },
        })
        return
      }
      const smooth = smoothPath(raw, { lag: opts.lag ?? 140, deadZone: opts.deadZone ?? 26 })
      const tracks = autoZoomTracks(smooth, {
        width: w, height: h,
        zoom: opts.zoom ?? s.cursorZoom.zoom,
        mode: opts.mode ?? s.cursorZoom.mode,
        dwellMs: opts.dwellMs ?? 600,
      })
      s.pushHistory()
      s.updateLayer(id, { tracks: { ...(layer.tracks || {}), ...tracks } })
      s.recomputeDuration()
      set({
        notice: {
          kind: 'ok',
          text: `Followed the cursor across ${found} of ${frames.length} frames — `
            + `${tracks.zoom.length} zoom and ${tracks.panX.length} pan keyframes, all editable.`,
        },
      })
    } catch (err) {
      console.error('[pixelforge] cursor zoom failed', err)
      set({ notice: { kind: 'warn', text: 'Cursor tracking failed: ' + err.message } })
    } finally {
      set({ tracking: null })
    }
  },

  cursorZoom: { zoom: 2, mode: 'follow' },
  setCursorZoom: (patch) => set((st) => ({ cursorZoom: { ...st.cursorZoom, ...patch } })),

  trackOpts: { direction: 'forward', radius: 28, trackScale: false, simplify: true },
  setTrackOpts: (patch) => set((s) => ({ trackOpts: { ...s.trackOpts, ...patch } })),

  /**
   * Follows the selected layer through the footage and writes the result as
   * position (and optionally size) keyframes, so the tracked motion is ordinary
   * animation afterwards — editable, retimable, exportable.
   */
  runTracker: async (id, opts = {}) => {
    const s = get()
    const layer = s.doc.layers.find((x) => x.id === id)
    if (!layer || isGroup(layer)) {
      set({ notice: { kind: 'warn', text: 'Select a layer to track.' } })
      return
    }
    s.ensureTimeline()
    const duration = get().duration
    if (duration <= 0) {
      set({ notice: { kind: 'warn', text: 'Nothing to track against — this project has no timeline.' } })
      return
    }

    const times = trackTimes(get().doc, duration, opts.fps || 20)
    set({ tracking: { progress: 0 } })
    try {
      const anchorTime = s.time
      const runs = []
      const dirs = opts.direction === 'both' ? ['forward', 'backward'] : [opts.direction || 'forward']
      for (const direction of dirs) {
        runs.push(await trackLayer(get().doc, resolveLayer(layer, anchorTime), {
          times,
          anchorTime,
          direction,
          radius: opts.radius || 28,
          trackScale: !!opts.trackScale,
          onProgress: (p) => set({ tracking: { progress: p / dirs.length } }),
        }))
      }

      const merged = new Map()
      for (const r of runs) for (const smp of r.samples) merged.set(smp.t, smp)
      let samples = [...merged.values()].sort((a, b) => a.t - b.t)
      const failed = runs.find((r) => r.reason)
      if (failed) {
        set({ notice: { kind: 'warn', text: failed.reason } })
        return
      }
      if (samples.length < 2) {
        set({ notice: { kind: 'warn', text: 'Could not find anything to follow from here.' } })
        return
      }

      if (opts.simplify !== false) samples = simplifyTrack(samples, opts.tolerance ?? 0.75)

      get().pushHistory()
      const tracks = { ...(layer.tracks || {}) }
      const put = (prop, pick) => {
        tracks[prop] = samples.map((smp) => ({ t: Math.round(smp.t), v: pick(smp), ease: 'linear' }))
      }
      put('x', (smp) => smp.x)
      put('y', (smp) => smp.y)
      if (opts.trackScale) {
        put('w', (smp) => smp.w)
        put('h', (smp) => smp.h)
      }
      get().updateLayer(id, { tracks })
      get().recomputeDuration()

      const lost = runs.map((r) => r.lostAt).filter((t) => t != null)
      set({
        notice: lost.length
          ? {
              kind: 'warn',
              text: `Tracked ${samples.length} keys, but lost the subject at ${(Math.min(...lost) / 1000).toFixed(2)}s — re-anchor there and track again.`,
            }
          : { kind: 'ok', text: `Tracked ${samples.length} keyframes` },
      })
    } catch (err) {
      console.error('[pixelforge] tracking failed', err)
      set({ notice: { kind: 'warn', text: 'Tracking failed: ' + err.message } })
    } finally {
      set({ tracking: null })
    }
  },

  // ---- groups -----------------------------------------------------------
  groupLayers: (ids) => {
    const s = get()
    const members = s.doc.layers.filter((l) => ids.includes(l.id))
    if (members.length < 1) return null
    s.pushHistory()
    // The new group takes the place of the topmost member so z-order is kept.
    const topIndex = Math.max(...members.map((l) => s.doc.layers.indexOf(l)))
    const parentId = members[0].parentId || null
    const group = makeGroupLayer({ name: 'Group', parentId })
    const rest = s.doc.layers.filter((l) => !ids.includes(l.id))
    const below = s.doc.layers
      .slice(0, topIndex + 1)
      .filter((l) => !ids.includes(l.id)).length
    const placed = [...rest]
    placed.splice(below, 0, group, ...members.map((l) => ({ ...l, parentId: group.id })))
    set({ dirty: true, doc: { ...s.doc, layers: normalize(placed) }, selectedIds: [group.id] })
    return group.id
  },

  ungroupLayers: (ids) => {
    const s = get()
    const groups = s.doc.layers.filter((l) => ids.includes(l.id) && isGroup(l))
    if (!groups.length) return
    s.pushHistory()
    const gone = new Set(groups.map((g) => g.id))
    const freed = []
    const layers = []
    for (const l of s.doc.layers) {
      if (gone.has(l.id)) continue
      if (gone.has(l.parentId)) {
        const g = groups.find((x) => x.id === l.parentId)
        const out = { ...l, parentId: g.parentId || null }
        freed.push(out.id)
        layers.push(out)
      } else layers.push(l)
    }
    set({ dirty: true, doc: { ...s.doc, layers: normalize(layers) }, selectedIds: freed })
  },

  /** Moves layers into a group (or to the top level when groupId is null). */
  moveToGroup: (ids, groupId) => {
    const s = get()
    // Refuse to put a group inside itself or its own contents.
    if (groupId) {
      const inside = withDescendants(s.doc.layers, [groupId])
      if (ids.some((id) => id === groupId || inside.includes(id))) return
    }
    s.pushHistory()
    const layers = s.doc.layers.map((l) =>
      (ids.includes(l.id) ? { ...l, parentId: groupId || null } : l))
    set({ dirty: true, doc: { ...s.doc, layers: normalize(layers) } })
  },

  toggleCollapse: (id) => {
    const s = get()
    const l = s.doc.layers.find((x) => x.id === id)
    if (l) s.updateLayer(id, { collapsed: !l.collapsed })
  },

  /**
   * Click a subject, get a lasso around it.
   *
   * The segmentation model already produces a mask; this turns the piece of it
   * under the pointer into an ordinary editable outline, so every lasso action
   * that already exists — cut, copy, mask, erase, overlay — works on it, and
   * the points can be dragged afterwards like any other.
   *
   * It is worth being plain about the limit: this is not click-anything
   * segmentation. The model decides what counts as foreground, and the click
   * only chooses *which* piece of that foreground to take. Clicking a lamp in
   * the background will not select the lamp.
   */
  /**
   * Selects everything that looks like the colour clicked.
   *
   * The plain question the AI selection cannot answer: it finds subjects, so a
   * flat background, a logo or a panel of a screenshot is outside what it is
   * for. What comes back is an ordinary lasso, so every action that follows one
   * works on it unchanged.
   */
  wandSelectAt: (docX, docY, opts = {}) => {
    const s = get()
    let layer = null
    for (let i = s.doc.layers.length - 1; i >= 0; i--) {
      const l = s.doc.layers[i]
      if (l.type !== 'image' || l.visible === false || l.locked) continue
      const resolved = resolveLayer(l, s.time)
      if (docToAsset(resolved, docX, docY)) { layer = resolved; break }
    }
    if (!layer) {
      set({ notice: { kind: 'warn', text: 'Click on an image layer to select from it.' } })
      return null
    }
    const bitmap = sourceFor(layer, s.time)
    if (!bitmap) {
      set({ notice: { kind: 'warn', text: 'That layer has no frame decoded yet.' } })
      return null
    }

    const hit = docToAsset(layer, docX, docY)
    const tolerance = opts.tolerance ?? s.toolOptions.wandTolerance ?? 0.18
    const built = colorMask(bitmap, hit.x, hit.y, { tolerance })
    if (!built) return null

    // Always the region the click is inside. A lasso is one polygon, so a
    // selection scattered across the picture has no way to come back — offering
    // that choice would promise something the result cannot hold.
    const traced = maskToPolygon(built.mask, built.w, built.h, {
      x: built.seed.x,
      y: built.seed.y,
      threshold: 0.5,
      low: 0.5,
    })
    if (!traced) {
      set({
        notice: {
          kind: 'warn',
          text: 'Nothing matched there. Raise the tolerance, or click a flatter area.',
        },
      })
      return null
    }

    const points = traced.points.map(([x, y]) => {
      const d = assetToDoc(layer, x, y)
      return [d.x, d.y]
    })
    const pct = Math.round(coverage(built.mask) * 100)
    set({
      lasso: { points },
      selectedIds: [layer.id],
      notice: {
        kind: 'ok',
        text: `Selected ${pct}% of the picture with ${points.length} points — `
          + 'drag any of them to adjust, then pick an action.',
      },
    })
    return points
  },

  aiSelectAt: async (docX, docY) => {
    const s = get()
    // Topmost visible image layer under the pointer, which is what the user
    // means by "the thing I clicked".
    let layer = null
    for (let i = s.doc.layers.length - 1; i >= 0; i--) {
      const l = s.doc.layers[i]
      if (l.type !== 'image' || l.visible === false || l.locked) continue
      const resolved = resolveLayer(l, s.time)
      if (docToAsset(resolved, docX, docY)) { layer = resolved; break }
    }
    if (!layer) {
      set({ notice: { kind: 'warn', text: 'Click on an image layer to select from it.' } })
      return null
    }
    const bitmap = sourceFor(layer, s.time)
    if (!bitmap) {
      set({ notice: { kind: 'warn', text: 'That layer has no frame decoded yet.' } })
      return null
    }

    setModel(layer.bgRemove?.model || 'modnet')
    set({ matting: { progress: 0, stage: 'Loading model' } })
    try {
      const mask = await predictMask(bitmap, {
        onProgress: (p) => set({ matting: { progress: p, stage: 'Downloading model' } }),
      })
      rememberMask(bitmap, mask)
      set({ matting: { progress: 1, stage: 'Tracing' } })

      const size = Math.round(Math.sqrt(mask.length))
      const hit = docToAsset(layer, docX, docY)
      const traced = maskToPolygon(mask, size, size, {
        x: Math.round(hit.x * size),
        y: Math.round(hit.y * size),
        threshold: layer.bgRemove?.threshold ?? 0.5,
      })
      if (!traced) {
        set({
          notice: {
            kind: 'warn',
            text: 'Nothing found there. The model picks out the subject, so background '
              + 'objects cannot be selected this way — try clicking the subject itself.',
          },
        })
        return null
      }

      // Mask coordinates are a fraction of the asset frame, which is exactly
      // what assetToDoc consumes, so the outline lands on the canvas already
      // rotated, cropped and flipped to match the layer.
      // The matte is predicted at the model's resolution — 512 or so — and the
      // outline traced from it lands near the boundary rather than on it. The
      // picture itself knows where the boundary is, so the outline is pulled
      // onto the strongest gradient within a few pixels. Points with no real
      // edge nearby are left alone: on fur or motion blur the strongest thing
      // in reach is noise, and snapping to noise is worse than a soft outline.
      let asset01 = traced.points
      const edges = buildEdgeMap(bitmap)
      if (edges) {
        const inMap = traced.points.map(([x, y]) => ({ x: x * edges.w, y: y * edges.h }))
        const snapped = snapToEdges(inMap, edges, { radius: 4 })
        asset01 = snapped.map((p) => [p.x / edges.w, p.y / edges.h])
      }
      const points = asset01.map(([x, y]) => {
        const d = assetToDoc(layer, x, y)
        return [d.x, d.y]
      })
      set({
        lasso: { points },
        selectedIds: [layer.id],
        notice: {
          kind: 'ok',
          text: `Selected with ${points.length} points — drag any of them to adjust, `
            + 'then pick an action.',
        },
      })
      return points
    } catch (err) {
      console.error('[pixelforge] AI select failed', err)
      set({ notice: { kind: 'warn', text: 'AI select failed: ' + err.message } })
      return null
    } finally {
      set({ matting: null })
    }
  },

  /**
   * A path from one document point to another that runs along the picture's
   * edges rather than straight across them.
   *
   * This is the magnetic lasso: drag roughly around a subject and the outline
   * finds the boundary itself. Everything is done against the layer's own
   * frame, so it works the same on a rotated, cropped or scaled layer without
   * any of that having to be undone first.
   *
   * Falls back to the straight line whenever it cannot help — off the layer, no
   * frame decoded — because a lasso that stops following the pointer is worse
   * than one that briefly runs straight.
   */
  magnetPath: (layerId, from, to) => {
    const s = get()
    const raw = s.doc.layers.find((l) => l.id === layerId)
    if (!raw) return [to]
    const layer = resolveLayer(raw, s.time)
    const bitmap = sourceFor(layer, s.time)
    const map = bitmap && edgeMapFor(bitmap)
    if (!map) return [to]

    const a = docToAsset(layer, from[0], from[1])
    const b = docToAsset(layer, to[0], to[1])
    if (!a || !b) return [to]

    const path = livewire(map, { x: a.x * map.w, y: a.y * map.h }, { x: b.x * map.w, y: b.y * map.h })
    // Thinned on the way out: the path is one point per pixel, and a lasso with
    // nine hundred vertices is slow to draw and impossible to adjust by hand.
    const out = []
    for (let i = 0; i < path.length; i++) {
      if (i !== 0 && i !== path.length - 1 && i % 6) continue
      const d = assetToDoc(layer, path[i].x / map.w, path[i].y / map.h)
      out.push([d.x, d.y])
    }
    return out.length ? out : [to]
  },

  // ---- clone stamp --------------------------------------------------------
  //
  // Alt-click sets where the paint comes from; painting copies it to where the
  // brush goes. The offset between the two is fixed when a stroke starts, so
  // the source travels with the brush and copies rather than smearing.

  /** Where cloning samples from, as a document point. Null until one is set. */
  cloneSource: null,
  setCloneSource: (cloneSource) => set({
    cloneSource,
    notice: cloneSource
      ? { kind: 'ok', text: 'Clone source set — now paint over what you want gone.' }
      : null,
  }),

  /**
   * Starts a clone stroke.
   *
   * History is pushed once here rather than per point, so one drag is one undo.
   */
  beginClone: (id, point, opts = {}) => {
    const s = get()
    const layer = s.doc.layers.find((x) => x.id === id)
    if (!layer || layer.locked) return null
    if (!s.cloneSource) {
      set({ notice: { kind: 'warn', text: 'Alt-click to set where the paint comes from first.' } })
      return null
    }
    const resolved = resolveLayer(layer, s.time)
    const brush = { ...defaultStamp(), ...s.toolOptions.stamp, ...opts }
    const from = docToLayerPoint(resolved, s.cloneSource[0], s.cloneSource[1])
    const to = docToLayerPoint(resolved, point[0], point[1])
    s.pushHistory()
    const stroke = newStamp(brush, [from[0] - to[0], from[1] - to[1]], to)
    s.updateLayer(id, { clone: { strokes: [...(layer.clone?.strokes || []), stroke] } })
    set({ cloneStroke: { id, brush } })
    return stroke
  },

  cloneStroke: null,

  extendClone: (id, point) => {
    const s = get()
    const layer = s.doc.layers.find((x) => x.id === id)
    const strokes = layer?.clone?.strokes
    if (!strokes?.length) return
    const resolved = resolveLayer(layer, s.time)
    const pt = docToLayerPoint(resolved, point[0], point[1])
    const last = strokes[strokes.length - 1]
    const prev = last.pts[last.pts.length - 1]
    // Points closer together than a fraction of the brush add nothing but work.
    if (prev && Math.hypot(pt[0] - prev[0], pt[1] - prev[1]) < (last.size || 0.08) * 0.12) return
    const next = { ...last, pts: [...last.pts, pt] }
    s.updateLayer(id, { clone: { strokes: [...strokes.slice(0, -1), next] } })
  },

  endClone: () => set({ cloneStroke: null }),

  /** Throws away the cloning on a layer, or the last stroke of it. */
  clearClone: (id, { all = false } = {}) => {
    const s = get()
    const layer = s.doc.layers.find((x) => x.id === id)
    const strokes = layer?.clone?.strokes
    if (!strokes?.length) return
    s.pushHistory()
    s.updateLayer(id, {
      clone: all || strokes.length === 1 ? null : { strokes: strokes.slice(0, -1) },
    })
  },

  // ---- eraser -------------------------------------------------------------
  /**
   * Starts a stroke.
   *
   * History is pushed once here rather than on every point, so one drag is one
   * undo — an eraser that took fifty undos to reverse would be unusable.
   */
  beginErase: (id, point, opts = {}) => {
    const s = get()
    const layer = s.doc.layers.find((x) => x.id === id)
    if (!layer || layer.locked) return null
    const brush = { ...defaultBrush(), ...s.toolOptions.brush, ...opts }
    s.pushHistory()
    const stroke = newStroke(brush, point)
    s.updateLayer(id, {
      erase: { strokes: [...(layer.erase?.strokes || []), stroke] },
    })
    return stroke
  },

  /** Adds a point to the stroke in progress. Deliberately no history. */
  extendErase: (id, point) => {
    set((st) => ({
      dirty: true,
      doc: {
        ...st.doc,
        layers: st.doc.layers.map((l) => {
          if (l.id !== id || !l.erase?.strokes?.length) return l
          const strokes = l.erase.strokes.slice()
          const last = strokes[strokes.length - 1]
          // Points closer together than a fraction of the brush add nothing but
          // work — a slow drag would otherwise store hundreds a pixel apart.
          const prev = last.pts[last.pts.length - 1]
          const step = (last.size || 0.05) * 0.18
          if (prev && Math.hypot(point[0] - prev[0], point[1] - prev[1]) < step) return l
          strokes[strokes.length - 1] = { ...last, pts: [...last.pts, point] }
          return { ...l, erase: { strokes } }
        }),
      },
    }))
  },

  /**
   * Shrinks a layer's box to whatever is still visible in it.
   *
   * Erasing from an edge leaves a box measuring space that is no longer there,
   * so the handles and the rotation pivot drift away from the artwork. Measured
   * by rendering the layer — its matte, mask and erase strokes only combine in
   * the compositor — and applied through the same source window everything else
   * uses, so it stays undoable and nothing is baked.
   *
   * Mask points and erase strokes are both fractions of the layer box, so both
   * are rebased onto the new one; leaving either alone would slide it across
   * the picture.
   */
  refitToVisible: (id) => {
    const s = get()
    const layer = s.doc.layers.find((x) => x.id === id)
    if (!layer || layer.type !== 'image') return null
    const b = visibleBounds(resolveLayer(layer, s.time), s.time)
    // Nothing to do when it already fills its box, and nothing sensible to do
    // when it is empty — an empty layer keeps its box so it can still be found.
    if (!b || (b.x <= 0.002 && b.y <= 0.002 && b.w >= 0.996 && b.h >= 0.996)) return null
    if (b.w < 0.01 || b.h < 0.01) return null

    const r = sourceRect(layer)
    const ci = cropInsets(layer)
    // The picture occupies the box minus its crop insets, so the visible bounds
    // are rebased onto that before being turned into a source window.
    const toKeep = (v, lo, k) => Math.min(1, Math.max(0, (v - lo) / k))
    const u0 = toKeep(b.x, ci.cl, ci.kx)
    const v0 = toKeep(b.y, ci.ct, ci.ky)
    const u1 = toKeep(b.x + b.w, ci.cl, ci.kx)
    const v1 = toKeep(b.y + b.h, ci.ct, ci.ky)
    const clamped = {
      x: r.x + u0 * r.w,
      y: r.y + v0 * r.h,
      w: Math.max(1e-4, (u1 - u0) * r.w),
      h: Math.max(1e-4, (v1 - v0) * r.h),
    }

    const x = layer.x + b.x * layer.w
    const y = layer.y + b.y * layer.h
    const w = Math.max(1, b.w * layer.w)
    const h = Math.max(1, b.h * layer.h)

    // Rotation pivots on the centre, so the new centre is carried around the old
    // one by the same angle — the same correction the subject trim makes.
    const oldCx = layer.x + layer.w / 2
    const oldCy = layer.y + layer.h / 2
    const a = ((layer.rotation || 0) * Math.PI) / 180
    const ox = x + w / 2 - oldCx
    const oy = y + h / 2 - oldCy
    const cx = oldCx + ox * Math.cos(a) - oy * Math.sin(a)
    const cy = oldCy + ox * Math.sin(a) + oy * Math.cos(a)

    const rebase = ([pu, pv]) => [(pu - b.x) / b.w, (pv - b.y) / b.h]
    const patch = {
      src: clamped,
      cropT: 0, cropR: 0, cropB: 0, cropL: 0, zoom: 1, panX: 0, panY: 0,
      x: cx - w / 2,
      y: cy - h / 2,
      w,
      h,
    }
    if ((layer.mask?.points?.length || 0) >= 3) {
      patch.mask = { ...layer.mask, points: layer.mask.points.map(rebase) }
    }
    if (layer.erase?.strokes?.length) {
      patch.erase = {
        strokes: layer.erase.strokes.map((st) => ({
          ...st,
          pts: st.pts.map(rebase),
          // The brush is a fraction of the layer width, and the width just
          // changed — so the stored size is rescaled to keep the same stroke.
          size: (st.size || 0.05) * (layer.w / w),
        })),
      }
    }
    // No pushHistory: this runs at the end of a stroke that already pushed one,
    // so the erase and the refit undo together as the single action they are.
    s.updateLayer(id, patch)
    return patch
  },

  /** Removes the last stroke, or all of them. */
  clearErase: (id, { all = false } = {}) => {
    const s = get()
    const layer = s.doc.layers.find((x) => x.id === id)
    if (!layer?.erase?.strokes?.length) return
    s.pushHistory()
    s.updateLayer(id, {
      erase: all ? undefined : { strokes: layer.erase.strokes.slice(0, -1) },
    })
  },

  /** The layer the eraser paints on: the selection, else the topmost under the point. */
  eraseTarget: (px, py) => {
    const s = get()
    const sel = s.doc.layers.filter((l) => s.selectedIds.includes(l.id) && !l.locked
      && l.type !== 'group' && l.type !== 'effect')
    if (sel.length) return sel[sel.length - 1]
    for (let i = s.doc.layers.length - 1; i >= 0; i--) {
      const l = s.doc.layers[i]
      if (l.visible === false || l.locked || l.type === 'group' || l.type === 'effect') continue
      const r = resolveLayer(l, s.time)
      const p = docToLayer(r, px, py)
      if (p[0] >= 0 && p[0] <= 1 && p[1] >= 0 && p[1] <= 1) return l
    }
    return null
  },

  // ---- lasso selection --------------------------------------------------
  setLasso: (lasso) => set({ lasso }),
  clearLasso: () => set({ lasso: null }),

  /** The layer lasso actions apply to: the selection, else the topmost visible one. */
  lassoTarget: () => {
    const s = get()
    const sel = s.doc.layers.filter((l) => s.selectedIds.includes(l.id) && !l.locked)
    if (sel.length) return sel[sel.length - 1]
    for (let i = s.doc.layers.length - 1; i >= 0; i--) {
      const l = s.doc.layers[i]
      if (l.visible && !l.locked && l.type !== 'effect') return l
    }
    return null
  },

  /**
   * Applies the lasso to a layer.
   *
   *   mask    keep only what is inside the outline
   *   erase   remove what is inside, keep the rest
   *   copy    leave the original alone, add a new layer of just the outlined part
   *   cut     as copy, and remove that part from the original
   *   effect  drop a pixelate/blur overlay shaped like the outline
   */
  applyLasso: (mode, opts = {}) => {
    const s = get()
    const pts = s.lasso?.points
    if (!pts || pts.length < 3) return { ok: false, reason: 'Draw a lasso outline first.' }

    if (mode === 'effect') {
      const b = polygonBounds(pts)
      const o = s.toolOptions
      s.addLayer(makeEffectLayer({
        name: 'Lasso ' + o.effect,
        shape: 'path',
        effect: o.effect,
        pixelSize: o.pixelSize,
        blurRadius: o.blurRadius,
        feather: o.feather,
        x: b.x, y: b.y, w: b.w, h: b.h,
        points: pts.map(([x, y]) => [(x - b.x) / b.w, (y - b.y) / b.h]),
      }))
      set({ lasso: null })
      return { ok: true, text: 'Added a lasso-shaped overlay' }
    }

    const target = s.lassoTarget()
    if (!target) return { ok: false, reason: 'Select a layer to apply the lasso to.' }
    if (target.type === 'effect') {
      return { ok: false, reason: 'Effect overlays are shaped by their own outline, not masked.' }
    }

    s.pushHistory()

    // Erasing adds to what is already gone. It used to be written as the
    // layer's mask, inverted — but a layer has one mask, so erasing a second
    // region put the first one back. As an erase stroke it accumulates, undoes
    // one region at a time, and shows up in the "Erased" panel beside anything
    // painted with the brush.
    if (mode === 'erase') {
      s.updateLayer(target.id, {
        erase: {
          ...(target.erase || {}),
          strokes: [...(target.erase?.strokes || []), newRegion(polygonToLayer(pts, target))],
        },
      })
      set({ lasso: null })
      // The box stays: what remains is everything *except* the outline, and is
      // still the size of the original.
      return { ok: true, text: 'Erased the selection' }
    }

    // The same outline, meaning "and this bit too" rather than "only this".
    if (mode === 'mask-add') {
      const res = get().addToMask(target.id, pts, { commit: false })
      if (res.ok) set({ lasso: null })
      return res
    }

    if (mode === 'mask') {
      s.updateLayer(target.id, {
        mask: { points: polygonToLayer(pts, target), invert: false, feather: 0 },
      })
      set({ lasso: null })
      // Masking shrinks the box to what is left. A layer that still measures
      // the whole photo after cutting one person out of it puts the handles,
      // the rotation pivot and the snapping nowhere near the thing you can see.
      if (opts.trim !== false) get().trimToSubject(target.id, { quiet: true })
      return { ok: true, text: 'Masked and trimmed to the selection' }
    }

    if (mode === 'copy' || mode === 'cut') {
      const b = polygonBounds(pts)
      // Trim the copy to the outline's bounds so its handles hug the cut-out,
      // then mask it to the outline itself. cropLayer leaves rotated or
      // position-animated layers alone, which keeps the geometry honest.
      const trimmed = cropLayer({ ...clone(target), id: nid('l') }, b, { reorigin: false })
      const piece = {
        ...trimmed,
        name: target.name + ' cut-out',
        mask: { points: polygonToLayer(pts, trimmed), invert: false, feather: 0 },
      }
      const layers = [...s.doc.layers]
      const at = layers.findIndex((l) => l.id === target.id)
      if (mode === 'cut') {
        // The hole the piece left behind is an erase region for the same reason
        // the Erase action is one: cutting a second piece out of a layer must
        // not fill in the first hole.
        layers[at] = {
          ...target,
          erase: {
            ...(target.erase || {}),
            strokes: [...(target.erase?.strokes || []), newRegion(polygonToLayer(pts, target))],
          },
        }
      }
      layers.splice(at + 1, 0, piece)
      set({ dirty: true, doc: { ...s.doc, layers }, selectedIds: [piece.id], lasso: null })
      get().recomputeDuration()
      return { ok: true, text: mode === 'cut' ? 'Cut to a new layer' : 'Copied to a new layer' }
    }

    return { ok: false, reason: 'Unknown lasso action' }
  },

  /**
   * Adds an outline to a mask that already exists, rather than replacing it.
   *
   * The case this is for: a subject was cut out, and the cut took a slice off
   * an arm or a leg. Redrawing the whole outline to win back a sliver is not a
   * repair, it is doing the job again — so the missing piece is drawn on its own
   * and added, and the two outlines union.
   *
   * If the piece reaches outside the layer's frame, the frame grows to meet it.
   * Masking trims the box down to what was kept, so the very edge that was cut
   * too tight is often just outside it — without this, drawing over the missing
   * leg would land outside the layer and appear to do nothing at all, which is
   * the worst answer available.
   */
  addToMask: (id, points, { commit = true } = {}) => {
    const s = get()
    const layer = s.doc.layers.find((x) => x.id === id)
    if (!layer) return { ok: false, reason: 'Select a layer to add to.' }
    if (!hasMask(layer)) {
      return { ok: false, reason: 'That layer has no mask yet — use Mask to make one.' }
    }
    if (!points || points.length < 3) return { ok: false, reason: 'Draw an outline first.' }

    if (commit) s.pushHistory()
    // Every outline wound the same way, including the one already there: wound
    // against each other the overlap reads as a hole and the addition would cut
    // a bite out of the subject instead of filling one in.
    const added = windSame(polygonToLayer(points, layer))
    const mask = {
      ...layer.mask,
      points: windSame(layer.mask.points),
      plus: [...(layer.mask.plus || []).map(windSame), added],
    }
    const grown = growToFitMask({ ...layer, mask })
    get().updateLayer(id, grown || { mask })
    return {
      ok: true,
      text: grown ? 'Added to the mask, and the frame grew to hold it' : 'Added to the mask',
    }
  },

  /** Takes back the last piece added to a mask. */
  undoMaskAdd: (id) => {
    const s = get()
    const l = s.doc.layers.find((x) => x.id === id)
    if (!l?.mask?.plus?.length) return
    s.pushHistory()
    const plus = l.mask.plus.slice(0, -1)
    s.updateLayer(id, { mask: { ...l.mask, plus: plus.length ? plus : undefined } })
  },

  clearMask: (id) => {
    const s = get()
    s.pushHistory()
    s.updateLayer(id, { mask: undefined })
  },

  setMask: (id, patch) => {
    const s = get()
    const l = s.doc.layers.find((x) => x.id === id)
    if (!l?.mask) return
    s.updateLayer(id, { mask: { ...l.mask, ...patch } })
  },

  // ---- keyframes --------------------------------------------------------
  /**
   * The single entry point for layer edits.
   *
   * Properties that own a track are written as keyframes; everything else
   * (effect type, shape, colour, invert...) always lands on the base layer.
   * Splitting these matters: an animated layer whose effect type went into a
   * keyframe would lose the change entirely.
   *
   * `relative` marks gestures that are inherently relative (dragging on the
   * canvas), so an "all keys" edit offsets the whole animation instead of
   * flattening every key to the same value.
   */
  setLayerAtTime: (id, patch, { relative = false } = {}) => {
    const s = get()
    const l = s.doc.layers.find((x) => x.id === id)
    if (!l) return

    const basePatch = {}
    const animPatch = {}
    const seedPatch = {}
    for (const [k, v] of Object.entries(patch)) {
      if (!isAnimatable(k)) { basePatch[k] = v; continue }
      if (trackOf(l, k).length) { animPatch[k] = v; continue }
      // Tracking armed: the first time a property moves off its current value it
      // grows a track of its own. Nothing else is keyed.
      const changed = typeof v === 'number' && typeof l[k] === 'number' && v !== l[k]
      if (l.autoTrack && changed) seedPatch[k] = v
      else basePatch[k] = v
    }

    if (!Object.keys(animPatch).length && !Object.keys(seedPatch).length) {
      s.updateLayer(id, basePatch)
      return
    }

    let staged = l
    for (const [k, v] of Object.entries(seedPatch)) {
      staged = { ...staged, tracks: { ...staged.tracks, [k]: seedTrack(l[k], v, s.time) } }
    }
    for (const [k, v] of Object.entries(animPatch)) {
      const tracks = s.keyScope === 'all'
        ? applyToAllKeys(staged, k, v, s.time, relative ? 'offset' : 'set')
        : setTrackKey(staged, k, s.time, v)
      staged = { ...staged, tracks }
    }
    s.updateLayer(id, { ...basePatch, tracks: staged.tracks })
    if (Object.keys(seedPatch).length) s.recomputeDuration()
  },

  /** Arms or disarms automatic keyframing for a layer. */
  setAutoTrack: (id, on) => {
    const s = get()
    s.pushHistory()
    s.updateLayer(id, { autoTrack: !!on })
    if (on) s.ensureTimeline()
  },

  /**
   * Still images carry no frames, so a project made only of them has nowhere to
   * put a keyframe. Give it a default length the moment animation is asked for.
   */
  ensureTimeline: () => {
    const s = get()
    if (s.duration > 0) return
    set((st) => ({ doc: { ...st.doc, duration: DEFAULT_STILL_DURATION }, dirty: true }))
    get().recomputeDuration()
    set({
      notice: {
        kind: 'ok',
        text: `No animated media here, so the timeline is ${DEFAULT_STILL_DURATION / 1000}s — change it under Document.`,
      },
    })
  },

  setKeyScope: (keyScope) => set({ keyScope }),
  selectKey: (selectedKey) => set({
    selectedKey,
    keySelection: selectedKey ? [selectedKey] : [],
  }),

  /** Replaces the multi-selection. The last entry drives the easing control. */
  selectKeys: (keys) => set({
    keySelection: keys,
    selectedKey: keys.length ? keys[keys.length - 1] : null,
  }),

  clearKeySelection: () => set({ keySelection: [], selectedKey: null }),

  isKeySelected: (layerId, groupId, t) =>
    get().keySelection.some((k) => k.layerId === layerId && k.groupId === groupId && k.t === t),

  /**
   * Every keyframe inside a time span, across the layers and tracks given.
   *
   * Times are compared with a tolerance because a box drawn on screen is in
   * pixels and a keyframe is in milliseconds — landing exactly on one is not
   * something a drag can be asked to do.
   */
  keysInRange: (from, to, lanes) => {
    const s = get()
    const lo = Math.min(from, to)
    const hi = Math.max(from, to)
    const out = []
    for (const { layerId, groupId } of lanes) {
      const l = s.doc.layers.find((x) => x.id === layerId)
      if (!l) continue
      for (const t of groupKeyTimes(l, groupId)) {
        if (t >= lo && t <= hi) out.push({ layerId, groupId, t })
      }
    }
    return out
  },

  /**
   * Moves every selected key by the same offset.
   *
   * Applied furthest-first in the direction of travel, so a run of keys sliding
   * right does not have an earlier one land on top of a later one that has not
   * moved yet.
   */
  moveSelectedKeys: (deltaMs, { commit = true } = {}) => {
    const s = get()
    const keys = s.keySelection
    if (!keys.length || !deltaMs) return
    if (commit) s.pushHistory()
    const ordered = [...keys].sort((a, b) => (deltaMs > 0 ? b.t - a.t : a.t - b.t))
    const moved = []
    for (const k of ordered) {
      const l = get().doc.layers.find((x) => x.id === k.layerId)
      if (!l) continue
      const to = Math.max(0, Math.round(k.t + deltaMs))
      get().updateLayer(k.layerId, { tracks: moveGroupKey(l, k.groupId, k.t, to) })
      moved.push({ ...k, t: to })
    }
    set({
      keySelection: moved,
      selectedKey: moved.length ? moved[moved.length - 1] : null,
    })
    get().recomputeDuration()
  },

  /** Deletes every selected key, in one undo step. */
  removeSelectedKeys: () => {
    const s = get()
    const keys = s.keySelection
    if (!keys.length) return 0
    s.pushHistory()
    // Latest first: removing a key does not shift the others, but working
    // backwards keeps the order stable if that ever changes.
    for (const k of [...keys].sort((a, b) => b.t - a.t)) {
      const l = get().doc.layers.find((x) => x.id === k.layerId)
      if (!l) continue
      const { tracks, base } = removeGroupKey(l, k.groupId, k.t)
      get().updateLayer(k.layerId, { ...base, tracks })
    }
    set({ keySelection: [], selectedKey: null })
    get().recomputeDuration()
    return keys.length
  },

  enableTrack: (id, groupId) => {
    const s = get()
    const l = s.doc.layers.find((x) => x.id === id)
    if (!l) return
    s.ensureTimeline()
    s.pushHistory()
    s.updateLayer(id, { tracks: enableGroup(l, groupId, s.time) })
    s.recomputeDuration()
  },

  disableTrack: (id, groupId) => {
    const s = get()
    const l = s.doc.layers.find((x) => x.id === id)
    if (!l) return
    s.pushHistory()
    const { tracks, base } = disableGroup(l, groupId, s.time)
    s.updateLayer(id, { ...base, tracks })
    s.recomputeDuration()
  },

  addKeyframe: (id, groupId, t) => {
    const s = get()
    const l = s.doc.layers.find((x) => x.id === id)
    if (!l) return
    s.pushHistory()
    s.updateLayer(id, { tracks: addGroupKey(l, groupId, t ?? s.time) })
    s.recomputeDuration()
  },

  /**
   * A volume point: a keyframe with a value, set from a position on a lane.
   *
   * The group actions key whatever the property is *now*, which is right for a
   * diamond in the inspector and useless for dragging a point up and down — the
   * whole gesture is choosing the value. `from` names the point being moved, so
   * a drag is one action rather than a remove and an add, and one entry in the
   * history rather than two per pointer move.
   */
  setVolumePoint: (id, t, v, { from = null, commit = true } = {}) => {
    const s = get()
    const l = s.doc.layers.find((x) => x.id === id)
    if (!l) return
    if (commit) s.pushHistory()
    const at = Math.round(t)
    const value = Math.max(0, Math.min(2, v))
    let keys = [...(l.tracks?.volume || [])]
    if (from != null) keys = keys.filter((k) => Math.abs(k.t - from) > KEY_SNAP)
    const i = keys.findIndex((k) => Math.abs(k.t - at) <= KEY_SNAP)
    if (i >= 0) keys[i] = { ...keys[i], t: at, v: value }
    else keys.push({ t: at, v: value, ease: 'linear' })
    keys.sort((a, b) => a.t - b.t)
    s.updateLayer(id, { tracks: { ...(l.tracks || {}), volume: keys } })
  },

  /** Takes one away. The last one takes the track with it, so a clip with no
   *  points is the same document it was before any were put on. */
  removeVolumePoint: (id, t) => {
    const s = get()
    const l = s.doc.layers.find((x) => x.id === id)
    if (!l?.tracks?.volume) return
    s.pushHistory()
    const keys = l.tracks.volume.filter((k) => Math.abs(k.t - t) > KEY_SNAP)
    const tracks = { ...l.tracks }
    if (keys.length) tracks.volume = keys
    else delete tracks.volume
    s.updateLayer(id, { tracks: Object.keys(tracks).length ? tracks : undefined })
  },

  removeKeyframe: (id, groupId, t) => {
    const s = get()
    const l = s.doc.layers.find((x) => x.id === id)
    if (!l) return
    s.pushHistory()
    const { tracks, base } = removeGroupKey(l, groupId, t)
    s.updateLayer(id, { ...base, tracks })
    s.recomputeDuration()
  },

  moveKeyframe: (id, groupId, from, to, { commit = true } = {}) => {
    const s = get()
    const l = s.doc.layers.find((x) => x.id === id)
    if (!l) return
    if (commit) s.pushHistory()
    s.updateLayer(id, { tracks: moveGroupKey(l, groupId, from, to) })
    s.recomputeDuration()
  },

  setKeyEase: (id, groupId, t, ease) => {
    const s = get()
    const l = s.doc.layers.find((x) => x.id === id)
    if (!l) return
    s.pushHistory()
    s.updateLayer(id, { tracks: setGroupEase(l, groupId, t, ease) })
  },

  clearKeys: (id) => {
    const s = get()
    const l = s.doc.layers.find((x) => x.id === id)
    if (!l) return
    s.pushHistory()
    s.updateLayer(id, { ...resolveLayer(l, s.time), tracks: undefined, autoTrack: false })
    s.recomputeDuration()
  },

  // ---- selection / tools ------------------------------------------------
  select: (ids) => set({ selectedIds: Array.isArray(ids) ? ids : ids ? [ids] : [] }),

  /** Add to the selection, or take one out of it — shift-click. */
  toggleSelect: (id) => set((s) => ({
    selectedIds: s.selectedIds.includes(id)
      ? s.selectedIds.filter((x) => x !== id)
      : [...s.selectedIds, id],
  })),

  /**
   * Puts split clips back together.
   *
   * The inverse of Cut at playhead, and it holds itself to that: the clips have
   * to be the same media on the same track, touching in time, and *continuous in
   * the source* — the second must start in the footage exactly where the first
   * stopped. Anything else is not a join, it is a claim that some footage does
   * not exist, and joining would silently either skip frames or bring back ones
   * that had been trimmed away. When it refuses it says which of those it is,
   * because "cannot join" on its own is a puzzle.
   */
  joinClips: (ids = null) => {
    const s = get()
    const picked = (ids || s.selectedIds)
      .map((id) => s.doc.layers.find((l) => l.id === id))
      .filter((l) => l?.clip)
    if (picked.length < 2) {
      return { ok: false, reason: 'Select two or more clips on one track to join them.' }
    }
    if (new Set(picked.map((l) => l.assetId)).size > 1) {
      return { ok: false, reason: 'Those clips are different media — only pieces of the same clip join.' }
    }
    if (new Set(picked.map((l) => l.track || 0)).size > 1) {
      return { ok: false, reason: 'Those clips are on different tracks.' }
    }

    const assetOf = (l) => getAsset(l.assetId)
    const sorted = [...picked].sort(
      (a, b) => clipRange(a, assetOf(a)).start - clipRange(b, assetOf(b)).start)
    // A frame or two of slop is a drag, not an instruction. Anything more is a
    // gap or an overlap the user put there on purpose.
    const SLOP = 40
    for (let i = 1; i < sorted.length; i++) {
      const prev = sorted[i - 1]
      const cur = sorted[i]
      const pr = clipRange(prev, assetOf(prev))
      const cr = clipRange(cur, assetOf(cur))
      if (Math.abs(cr.start - pr.end) > SLOP) {
        return {
          ok: false,
          reason: cr.start > pr.end
            ? 'There is a gap between those clips. Close it first, or they are not one clip.'
            : 'Those clips overlap — that is a transition, not a cut to undo.',
        }
      }
      const pOut = sourceRange(prev, assetOf(prev)).out
      const cIn = sourceRange(cur, assetOf(cur)).in
      if (Math.abs(cIn - pOut) > SLOP) {
        return {
          ok: false,
          reason: 'Those pieces are not next to each other in the footage — '
            + 'one of them has been trimmed since the cut.',
        }
      }
    }

    s.pushHistory()
    const first = sorted[0]
    const last = sorted[sorted.length - 1]
    const merged = {
      ...first,
      clip: {
        ...first.clip,
        start: clipRange(first, assetOf(first)).start,
        in: sourceRange(first, assetOf(first)).in,
        out: sourceRange(last, assetOf(last)).out,
      },
      // The tail's fade-out belongs to the joined clip; the head's fade-in stays.
      fade: (first.fade?.in > 0 || last.fade?.out > 0)
        ? { in: first.fade?.in || 0, out: last.fade?.out || 0 }
        : undefined,
    }
    const gone = new Set(sorted.slice(1).map((l) => l.id))
    const layers = s.doc.layers
      .filter((l) => !gone.has(l.id))
      .map((l) => (l.id === first.id ? merged : l))
    set({ dirty: true, doc: { ...s.doc, layers }, selectedIds: [first.id] })
    get().recomputeDuration()
    return { ok: true, text: `Joined ${sorted.length} clips into one` }
  },
  setTool: (tool) => set({ tool }),
  setToolOptions: (patch) => set((s) => ({ toolOptions: { ...s.toolOptions, ...patch } })),
  setView: (patch) => set((s) => ({ view: { ...s.view, ...patch } })),
  setBusy: (busy) => set({ busy }),
  setNotice: (notice) => set({ notice }),
  setProjectName: (projectName) => set({ projectName }),

  // ---- project files ----------------------------------------------------
  /** Saves into this browser. Writing a file to disk is Export's job. */
  saveProject: async () => {
    const s = get()
    if (!s.doc.layers.length) {
      set({ notice: { kind: 'warn', text: 'Nothing to save yet.' } })
      return
    }
    const id = s.projectId || nid('p')
    set({ busy: 'Saving...' })
    try {
      const thumbBytes = await thumbnailBytes(s.doc, s.time)
      await writeProject({
        id,
        name: s.projectName || 'Untitled',
        doc: s.doc,
        time: s.time,
        thumb: thumbBytes ? new Blob([thumbBytes], { type: 'image/png' }) : null,
      })
      set({
        projectId: id,
        dirty: false,
        notice: { kind: 'ok', text: `Saved "${s.projectName}" to this browser` },
      })
      // Not awaited: the save is already done and reported, and a slow or
      // failed backup must not hold it up or undo it.
      get().backupNow('save')
    } catch (err) {
      console.error('[pixelforge] save failed', err)
      set({ notice: { kind: 'warn', text: 'Save failed: ' + err.message } })
    } finally {
      set({ busy: null })
    }
  },

  /** Packs the project as a .pfz and writes it out. Reached through Export. */
  downloadProject: async (filename) => {
    const s = get()
    const blob = await packProject(s.doc, { time: s.time, name: s.projectName })
    const safe = (filename || s.projectName || 'Untitled').replace(/[^\w.-]+/g, '-')
    const path = await saveBlob(blob, safe + PROJECT_EXT)
    if (path) set({ notice: { kind: 'ok', text: 'Saved to ' + path } })
    return blob
  },

  backups: [],
  backupsAvailable: backupsAvailable(),

  /**
   * Quietly writes the editable project alongside whatever else just happened.
   *
   * Deliberately silent and deliberately unawaited by its callers: it exists so
   * that exporting a PNG does not leave you with only a PNG, and a safety net
   * that could interrupt a save — or fail one — would be worse than no safety
   * net at all.
   */
  backupNow: async (reason = 'save') => {
    const s = get()
    const res = await writeBackup(s.doc, {
      time: s.time, name: s.projectName || 'Untitled', reason,
    })
    if (res.ok) get().refreshBackups()
    return res
  },

  refreshBackups: async () => {
    set({ backups: await listBackups() })
  },

  backupFolder,

  restoreBackup: async (entry) => {
    set({ busy: 'Opening backup...' })
    try {
      const { doc, time, name } = await openBackup(entry)
      resetBackupState()
      set({
        doc: normalizeDoc(doc),
        time: time || 0,
        projectId: null,
        projectName: name || entry.name || 'Recovered',
        selectedIds: [],
        selectedKey: null,
        keySelection: [],
        lasso: null,
        past: [],
        future: [],
        dirty: true,
        view: { zoom: 1, panX: 0, panY: 0, fitted: true, fitRequest: Date.now() },
        notice: { kind: 'ok', text: `Recovered "${name || entry.name}"` },
      })
      get().recomputeDuration()
      return true
    } catch (err) {
      console.error('[pixelforge] backup restore failed', err)
      set({ notice: { kind: 'warn', text: 'Could not open that backup: ' + err.message } })
      return false
    } finally {
      set({ busy: null })
    }
  },

  refreshSavedProjects: async () => {
    set({ savedProjects: await listProjects() })
  },

  openSavedProject: async (id) => {
    set({ busy: 'Opening...' })
    try {
      const rec = await readProject(id)
      if (!rec) throw new Error('That project is no longer stored')
      const { doc, time } = await restoreSnapshot(rec)
      resetBackupState()
      set({
        doc: normalizeDoc(doc),
        time,
        projectId: rec.id,
        projectName: rec.name || 'Untitled',
        selectedIds: [],
        selectedKey: null,
        lasso: null,
        past: [],
        future: [],
        dirty: false,
        view: { zoom: 1, panX: 0, panY: 0, fitted: true, fitRequest: Date.now() },
        notice: { kind: 'ok', text: `Opened ${rec.name}` },
      })
      get().recomputeDuration()
    } catch (err) {
      console.error('[pixelforge] open failed', err)
      set({ notice: { kind: 'warn', text: 'Could not open: ' + err.message } })
    } finally {
      set({ busy: null })
    }
  },

  deleteSavedProject: async (id) => {
    await deleteProject(id)
    await get().refreshSavedProjects()
    if (get().projectId === id) set({ projectId: null })
  },

  openProject: async (file) => {
    set({ busy: 'Opening project...' })
    try {
      const { doc, time, name, missing } = await unpackProject(file)
      set({
        doc: normalizeDoc(doc),
        time,
        projectName: name,
        projectId: null,
        selectedIds: [],
        selectedKey: null,
        past: [],
        future: [],
        dirty: false,
        view: { zoom: 1, panX: 0, panY: 0, fitted: true, fitRequest: Date.now() },
        notice: missing.length
          ? { kind: 'warn', text: `Opened, but ${missing.length} media file(s) were missing: ${missing.join(', ')}` }
          : { kind: 'ok', text: `Opened ${name}` },
      })
      get().recomputeDuration()
    } catch (err) {
      console.error('[pixelforge] open failed', err)
      set({ notice: { kind: 'warn', text: 'Could not open project: ' + err.message } })
    } finally {
      set({ busy: null })
    }
  },

  /** Replaces the document wholesale, e.g. from an autosave snapshot. */
  loadDocument: (doc, time = 0, name = 'Untitled') => {
    set({
      doc: normalizeDoc(doc),
      time,
      projectName: name,
      selectedIds: [],
      selectedKey: null,
      past: [],
      future: [],
      dirty: false,
      view: { zoom: 1, panX: 0, panY: 0, fitted: true, fitRequest: Date.now() },
    })
    get().recomputeDuration()
  },

  // ---- playback ---------------------------------------------------------
  setTime: (time) => set({ time }),
  setPlaying: (playing) => set({ playing }),
  // Deliberately delegates rather than repeating the rule. This used to be a
  // second copy of docDuration's logic, and the copies drifted the moment loop
  // repair changed how long a clip runs: the renderer knew, the timeline did
  // not.
  recomputeDuration: () => set({ duration: docDuration(get().doc) }),

  // ---- importing --------------------------------------------------------
  addImages: async (files, opts = {}) => {
    const all = [...files]
    // A dropped project file opens rather than importing as media.
    const project = all.find(isProjectFile)
    if (project) {
      await get().openProject(project)
      return
    }
    const list = all.filter((f) => f.type.startsWith('image/') || f.type.startsWith('video/')
      || /\.(gif|png|jpe?g|webp|bmp|avif|mp4|m4v|mov)$/i.test(f.name))
    if (!list.length) return
    set({ busy: `Decoding ${list.length} file${list.length > 1 ? 's' : ''}...` })
    const added = []
    const failed = []
    try {
      for (const file of list) {
        try {
          const asset = await loadImageFile(file)
          added.push(asset.id)
        } catch (err) {
          console.error('[pixelforge]', err)
          failed.push(file.name)
        }
      }
      if (added.length) {
        get().pushHistory()
        set((st) => ({
          dirty: true,
          doc: { ...st.doc, media: [...st.doc.media, ...added] },
        }))
      }
    } finally {
      set({ busy: null })
    }

    if (!added.length) {
      set({ notice: { kind: 'warn', text: `Could not read ${failed.join(', ')}` } })
      return added
    }

    // Import fills the bin, always. Dropping ten photos used to make ten stacked
    // layers where only the largest was visible; placing "just the first one"
    // fixed that but left an exception to explain, so there is no exception —
    // everything imported waits in Media until it is asked for.
    const s = get()
    const autoPlace = opts.place === true
    if (autoPlace) {
      get().placeMedia(added, { resizeDocToFirst: s.doc.layers.length === 0 })
    } else {
      set({
        workspace: 'media',
        notice: {
          kind: 'ok',
          text: `Added ${added.length} to Media`
            + (failed.length ? `, ${failed.length} could not be read` : '')
            + (added.length === 1
              ? ' — double-click it to put it on the canvas.'
              : ' — double-click one, or use Add to canvas.'),
        },
      })
    }
    return added
  },

  /** Puts media from the bin onto the canvas as ordinary image layers. */
  placeMedia: (assetIds, { resizeDocToFirst = false, select = true } = {}) => {
    const ids = [...assetIds].filter((id) => getAsset(id))
    if (!ids.length) return []
    get().pushHistory()

    const made = []
    for (let i = 0; i < ids.length; i++) {
      const asset = getAsset(ids[i])
      const st = get()
      const first = resizeDocToFirst && i === 0 && st.doc.layers.length === 0
      let { width, height } = st.doc
      if (first) {
        width = asset.width
        height = asset.height
        set({ doc: { ...st.doc, width, height } })
      }
      const fit = Math.min(1, width / asset.width, height / asset.height)
      const w = first ? asset.width : asset.width * fit
      const h = first ? asset.height : asset.height * fit
      // Several at once are stepped rather than stacked, so they are all
      // reachable instead of hiding behind whichever is largest.
      const step = ids.length > 1 ? (i - (ids.length - 1) / 2) * Math.min(40, width * 0.04) : 0
      const layer = {
        id: nid('l'),
        type: 'image',
        name: asset.name,
        assetId: asset.id,
        x: (width - w) / 2 + step,
        y: (height - h) / 2 + step,
        w, h,
        rotation: 0,
        radius: 0,
        opacity: 1,
        blend: 'source-over',
        visible: true,
        locked: false,
        flipX: false,
        flipY: false,
        speed: 1,
        timeOffset: 0,
        // Video lands as a clip on the first track. A 164-second MP4 is footage,
        // not an overlay: arriving as something that loops forever and cannot be
        // cut is not a sensible starting point for editing it. A GIF still
        // arrives unclipped, because in this app a GIF usually *is* an overlay.
        ...(asset.isVideo
          ? { track: 0, clip: wholeClip({}, asset, freeSpotOn(get().doc.layers, 0, 0)) }
          : null),
        ...imageFraming(),
        adjust: defaultAdjust(),
      }
      set((x) => ({ dirty: true, doc: { ...x.doc, layers: [...x.doc.layers, layer] } }))
      made.push(layer.id)
    }
    set({
      workspace: 'editor',
      ...(select ? { selectedIds: made } : null),
    })
    get().recomputeDuration()
    return made
  },

  collageOpts: defaultCollage(),
  setCollageOpts: (patch) => set((st) => ({ collageOpts: { ...st.collageOpts, ...patch } })),

  /**
   * Arranges media into a grid of tilted photo mounts.
   *
   * Every card is an ordinary image layer — position, rotation, crop and mount
   * are all normal properties — so the collage is editable afterwards rather
   * than being a picture of one. Nudge a card, change a border, delete one, and
   * everything else stays put.
   */
  makeCollage: (assetIds, opts = {}) => {
    const ids = [...assetIds].filter((id) => getAsset(id))
    if (!ids.length) {
      set({ notice: { kind: 'warn', text: 'Pick some media for the collage first.' } })
      return []
    }
    const o = { ...get().collageOpts, ...opts }
    const items = ids.map((id) => {
      const a = getAsset(id)
      return { width: a.width, height: a.height }
    })
    const plan = layoutCollage(items, o)

    get().pushHistory()
    // Laid down bottom of the pile first. With overlap, layer order *is* the
    // stacking order, so the shuffled z from the layout has to survive into the
    // document rather than being flattened back to index order.
    const stacked = [...plan.cards].sort((a, b) => (a.z ?? a.index) - (b.z ?? b.index))
    const layers = stacked.map((card) => {
      const i = card.index
      const a = getAsset(ids[i])
      return {
        id: nid('l'),
        type: 'image',
        name: card.hero ? `${a.name} (centre)` : a.name,
        assetId: a.id,
        x: card.x,
        y: card.y,
        w: card.w,
        h: card.h,
        rotation: card.rotation,
        radius: 0,
        opacity: 1,
        blend: 'source-over',
        visible: true,
        locked: false,
        flipX: false,
        flipY: false,
        speed: 1,
        timeOffset: 0,
        // The crop is the existing non-destructive source window, so the photo
        // is filling its mount rather than being squashed into it, and the
        // original is untouched.
        src: card.src,
        frame: o.style === 'none' ? { on: false } : {
          on: true,
          insets: card.insets,
          color: o.frameColor || '#f6f4ef',
          radius: Math.max(2, card.w * 0.012),
          shadow: Math.max(4, card.w * 0.05),
          shadowColor: 'rgba(0,0,0,0.5)',
          shadowY: Math.max(2, card.w * 0.02),
        },
        ...imageFraming(),
        adjust: defaultAdjust(),
      }
    })

    const grouped = makeGroupLayer({ name: `Collage (${layers.length})` })
    set((st) => ({
      dirty: true,
      workspace: 'editor',
      collageOpts: o,
      doc: {
        ...st.doc,
        width: plan.width,
        height: plan.height,
        ...(o.backdrop ? { background: o.backdropColor } : null),
        layers: normalize([
          ...st.doc.layers,
          grouped,
          ...layers.map((l) => ({ ...l, parentId: grouped.id })),
        ]),
      },
      selectedIds: [grouped.id],
      view: { ...st.view, fitRequest: Date.now() },
      notice: {
        kind: 'ok',
        text: `Collage: ${layers.length} photos in ${plan.columns} × ${plan.rows} `
          + `on a ${plan.width} × ${plan.height} canvas. Every card is a normal layer.`,
      },
    }))
    get().recomputeDuration()
    return layers.map((l) => l.id)
  },

  /**
   * Takes media out of the bin.
   *
   * Layers already using it keep working and keep it in the saved project —
   * removing from the bin is not a way to break the canvas — so the count of
   * still-referenced items is reported rather than silently ignored.
   */
  removeMedia: (assetIds) => {
    const ids = new Set(assetIds)
    if (!ids.size) return
    const s = get()
    const inUse = s.doc.layers.filter((l) => l.type === 'image' && ids.has(l.assetId)).length
    s.pushHistory()
    set((x) => ({
      dirty: true,
      doc: { ...x.doc, media: x.doc.media.filter((id) => !ids.has(id)) },
    }))
    set({
      notice: inUse
        ? {
            kind: 'warn',
            text: `Removed from Media. ${inUse} layer${inUse === 1 ? '' : 's'} still `
              + 'using it will keep working and stay in the saved project.',
          }
        : { kind: 'ok', text: `Removed ${ids.size} from Media` },
    })
  },
}))

export const nextId = nid
