// The magic eraser against real pictures: making fills, keeping them, and
// drawing a picture with them in place.
//
// A fill is a *patch* — the pixels that go into one stroke's hole, and nothing
// else — stored on the stroke that asked for it. Stored, not recomputed, and
// that is a deliberate break from how the eraser and the clone stamp work:
// those replay their strokes on every frame because replaying is cheap and
// exact. A model's estimate is neither. It takes a second, needs weights that
// may not be downloaded on the next machine, and has to come out the same
// every time the project is opened or exported. So it is made once and kept,
// small — only the hole's own pixels — as a PNG inside the document. Undo
// still takes it back with its stroke, because it lives on the stroke.
//
// Every stroke gets a quick fill the moment it is painted, from the pixels
// around it, and the model's fill replaces it when the model is done. Painting
// never waits on a download.

import {
  strokeBox, boxRect, rasterStroke, hugText, pushPull, patchFill, maskBounds, pieces, planCrops,
} from './heal.js'
import { inpaint } from './inpaint.js'
import { detectWatermark, deblend, toStored, fromStored, hasDewater } from './watermark.js'

// ---- patches ---------------------------------------------------------------------

const images = new Map()      // patch id -> something drawable
const clears = new Map()      // patch id -> its footprint, for patches that are not opaque
const decoding = new Map()    // patch id -> promise

let pseq = 0
const patchId = () => `p${Date.now().toString(36)}${(++pseq).toString(36)}${Math.random().toString(36).slice(2, 5)}`

function footprint(src, w, h) {
  const c = document.createElement('canvas')
  c.width = w
  c.height = h
  const g = c.getContext('2d', { willReadFrequently: true })
  g.drawImage(src, 0, 0)
  const img = g.getImageData(0, 0, w, h)
  const d = img.data
  for (let p = 0; p < d.length; p += 4) {
    const on = d[p + 3] > 0
    d[p] = 255
    d[p + 1] = 255
    d[p + 2] = 255
    d[p + 3] = on ? 255 : 0
  }
  g.putImageData(img, 0, 0)
  return c
}

/** Decodes a stored patch. Resolves to null when it cannot be read. */
export function decodePatch(p) {
  if (!p?.png) return Promise.resolve(null)
  if (images.has(p.id)) return Promise.resolve(images.get(p.id))
  if (decoding.has(p.id)) return decoding.get(p.id)
  const job = new Promise((res) => {
    const img = new Image()
    img.onload = () => {
      images.set(p.id, img)
      if (p.clear) clears.set(p.id, footprint(img, p.w, p.h))
      decoding.delete(p.id)
      res(img)
    }
    img.onerror = () => { decoding.delete(p.id); res(null) }
    img.src = p.png
  })
  decoding.set(p.id, job)
  return job
}

/**
 * Decodes every patch in a document. Opening a project awaits this, so the
 * first frame drawn — and the first export — already has the text gone.
 */
export function primePatches(doc) {
  const jobs = []
  for (const l of doc?.layers || []) {
    for (const s of l.heal?.strokes || []) if (s.patch) jobs.push(decodePatch(s.patch))
  }
  return Promise.all(jobs)
}

export const patchReady = (p) => !!p && images.has(p.id)

// ---- the picture with its fills in -------------------------------------------------

let fseq = 0
const frameIds = new WeakMap()
const frameId = (x) => {
  let i = frameIds.get(x)
  if (i === undefined) { i = ++fseq; frameIds.set(x, i) }
  return i
}

// A healed picture remembers the one it was made from, so anything cached
// against the original — the learned matte, chiefly — can still be found.
const origins = new WeakMap()
export const originOf = (x) => {
  // All the way back: a picture can be unmarked and then healed, and the
  // original is two steps behind what is drawn.
  let o = origins.get(x)
  while (o && origins.has(o)) o = origins.get(o)
  return o
}

function paintPatch(g, p) {
  const img = images.get(p.id)
  if (!img) { decodePatch(p); return false }
  // An opaque patch simply goes over the top. One that is partly transparent —
  // a fill across a picture's own transparent background — has to clear what
  // is under it first, or the text it replaces shows through it.
  const clear = clears.get(p.id)
  if (clear) {
    g.globalCompositeOperation = 'destination-out'
    g.drawImage(clear, p.x, p.y)
    g.globalCompositeOperation = 'source-over'
  }
  g.drawImage(img, p.x, p.y)
  return true
}

function composite(raw, strokes) {
  const w = raw.naturalWidth || raw.width
  const h = raw.naturalHeight || raw.height
  const c = document.createElement('canvas')
  c.width = w
  c.height = h
  const g = c.getContext('2d')
  g.drawImage(raw, 0, 0)
  for (const s of strokes) if (s.patch) paintPatch(g, s.patch)
  origins.set(c, raw)
  return c
}

const frames = new Map()   // layer id -> { sig, canvas }

/**
 * The layer's picture with every fill made so far painted in.
 *
 * One canvas per layer, rebuilt only when a fill arrives, goes, or finishes
 * decoding — the render loop asks for it every frame and nearly always gets
 * the one it had.
 */
export function healedFrame(raw, l) {
  const strokes = l.heal?.strokes
  if (!raw || !strokes?.length) return raw
  const sig = frameId(raw) + '|' + strokes
    .map((s) => (s.patch ? s.patch.id + (images.has(s.patch.id) ? '' : '?') : '-')).join(',')
  const hit = frames.get(l.id)
  if (hit && hit.sig === sig) return hit.canvas
  const canvas = composite(raw, strokes)
  frames.set(l.id, { sig, canvas })
  return canvas
}

/** The picture as it stood before stroke `i` — what that stroke is filled from. */
export const frameBefore = (raw, strokes, i) => composite(raw, strokes.slice(0, i))

// ---- watermarks ---------------------------------------------------------------------

// Big enough to see a mark's strokes on any sensible picture, small enough that
// the search takes a second or two rather than a minute. The mark that is found
// here is taken off the original at its full size.
const WORK = 2048

/**
 * Looks for a repeated mark on a picture. Resolves to `{ ok, dewater }` — the
 * mark as it is kept on a layer — or `{ ok: false, reason }`.
 */
export async function findWatermark(raw) {
  const aw = raw.naturalWidth || raw.width
  const ah = raw.naturalHeight || raw.height
  const k = Math.min(1, WORK / Math.max(aw, ah))
  const w = Math.max(1, Math.round(aw * k))
  const h = Math.max(1, Math.round(ah * k))
  const c = document.createElement('canvas')
  c.width = w
  c.height = h
  const g = c.getContext('2d', { willReadFrequently: true })
  g.imageSmoothingQuality = 'high'
  g.drawImage(raw, 0, 0, w, h)
  const img = g.getImageData(0, 0, w, h)
  const found = await detectWatermark(img.data, w, h, { tick: () => new Promise((r) => setTimeout(r, 0)) })
  if (!found.ok) return found
  return { ok: true, dewater: toStored(found, w / aw, h / ah) }
}

const unmarked = new Map()   // layer id -> { sig, canvas }

/** The layer's picture with its watermark taken off, made once per change. */
export function dewaterFrame(raw, l) {
  const d = l.dewater
  const sig = [
    frameId(raw), d.alpha.length, d.alpha.slice(0, 24), d.alpha.slice(-24),
    d.box, d.offsets?.length, d.offsets?.slice(0, 4), d.v1, d.v2, d.color, d.sx, d.sy,
  ].join('|')
  const hit = unmarked.get(l.id)
  if (hit && hit.sig === sig) return hit.canvas
  const w = raw.naturalWidth || raw.width
  const h = raw.naturalHeight || raw.height
  const c = document.createElement('canvas')
  c.width = w
  c.height = h
  const g = c.getContext('2d', { willReadFrequently: true })
  g.drawImage(raw, 0, 0)
  const img = g.getImageData(0, 0, w, h)
  deblend(img.data, w, h, fromStored(d, w, h))
  g.putImageData(img, 0, 0)
  origins.set(c, raw)
  unmarked.set(l.id, { sig, canvas: c })
  return c
}

/** The picture a layer's repairs are made on: unmarked, if it has been. */
export const baseFrame = (raw, l) => (raw && hasDewater(l) ? dewaterFrame(raw, l) : raw)

/** The picture a layer draws: unmarked, then healed. */
export function cleanFrame(raw, l) {
  const base = baseFrame(raw, l)
  return l.heal?.strokes?.length ? healedFrame(base, l) : base
}

// ---- making a fill -------------------------------------------------------------------

/**
 * Everything a fill needs: the pixels around the stroke, and which of them are
 * the hole. The work area reaches past the brush far enough for `hugText` to
 * see the background ring and for the grown mask to fit.
 */
function prepare(src, stroke) {
  const aw = src.naturalWidth || src.width
  const ah = src.naturalHeight || src.height
  if (!aw || !ah) return null
  // A lasso has no brush, so its outline's narrow side stands in for one:
  // it is about as wide as whatever was outlined.
  let brushPx = Math.max(2, (stroke.size || 0) * aw)
  if (stroke.kind === 'region') {
    const b = strokeBox(stroke, aw, ah, 0)
    if (!b) return null
    brushPx = Math.max(4, Math.min(b.x1 - b.x0, b.y1 - b.y0))
  }
  const ring = Math.min(36, Math.max(3, Math.round(brushPx * 0.45)))
  const grow = Math.min(10, Math.max(2, Math.round(brushPx * 0.07)))
  // Past the ring as well: the pieces a fill is made from are found in here,
  // and a brush's width of picture round the stroke is enough to hold another
  // run of the same edge or the same grain.
  const box = strokeBox(stroke, aw, ah, Math.max(ring + grow + 6, Math.min(96, Math.round(brushPx))))
  if (!box) return null
  const region = boxRect(box)
  const c = document.createElement('canvas')
  c.width = region.w
  c.height = region.h
  const g = c.getContext('2d', { willReadFrequently: true })
  g.drawImage(src, -region.x, -region.y)
  const rgba = g.getImageData(0, 0, region.w, region.h).data
  const band = rasterStroke(stroke, aw, ah, region)
  const hug = hugText(rgba, band, region.w, region.h, { brushPx })
  return { aw, ah, region, rgba, mask: hug.mask, mode: hug.mode, brushPx }
}

function makePatch(filled, mask, region, by, mode) {
  const b = maskBounds(mask, region.w, region.h)
  if (!b) return null
  const w = b.x1 - b.x0
  const h = b.y1 - b.y0
  const c = document.createElement('canvas')
  c.width = w
  c.height = h
  const g = c.getContext('2d')
  const img = g.createImageData(w, h)
  const d = img.data
  let clear = false
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const si = (y + b.y0) * region.w + (x + b.x0)
      if (!mask[si]) continue
      const sp = si * 4
      const dp = (y * w + x) * 4
      d[dp] = filled[sp]
      d[dp + 1] = filled[sp + 1]
      d[dp + 2] = filled[sp + 2]
      // Never quite zero inside the hole: the footprint of a patch is read back
      // from its alpha, and a fill that is itself transparent still has to say
      // where it is.
      d[dp + 3] = Math.max(1, filled[sp + 3])
      if (filled[sp + 3] < 250) clear = true
    }
  }
  g.putImageData(img, 0, 0)
  const id = patchId()
  images.set(id, c)
  if (clear) clears.set(id, footprint(c, w, h))
  return {
    id, by, mode,
    x: region.x + b.x0, y: region.y + b.y0, w, h,
    ...(clear ? { clear: true } : {}),
    png: c.toDataURL('image/png'),
  }
}

/**
 * A fill from the surrounding pixels alone. Synchronous and quick, so a stroke
 * shows its result the instant it is let go — and it is what stays when there
 * is no model to be had.
 */
export function quickFill(src, stroke) {
  const prep = prepare(src, stroke)
  if (!prep) return null
  const filled = new Uint8ClampedArray(prep.rgba)
  pushPull(filled, prep.mask, prep.region.w, prep.region.h)
  return makePatch(filled, prep.mask, prep.region, 'quick', prep.mode)
}

/**
 * A fill made of pieces of the picture itself — what content-aware fill does,
 * and what stands in for the model when there is none. Sharper than the quick
 * fill across an edge or a texture, and slower, so it runs after it and lets
 * the page draw between rounds.
 */
export async function matchFill(src, stroke) {
  const prep = prepare(src, stroke)
  if (!prep) return null
  const filled = new Uint8ClampedArray(prep.rgba)
  await patchFill(filled, prep.mask, prep.region.w, prep.region.h, {
    tick: () => new Promise((r) => setTimeout(r, 0)),
  })
  return makePatch(filled, prep.mask, prep.region, 'match', prep.mode)
}

/**
 * The model's fill for a stroke.
 *
 * The hole is first filled the quick way, so no crop ever shows the model a
 * letter it is not being asked to replace — it would happily continue a
 * pattern of letters into the hole. Then each crop is handed over in turn and
 * its answer written back before the next one is cut, so a long caption is
 * filled as one continuous thing rather than as lengths that disagree at the
 * joins.
 */
export async function aiFill(src, stroke, { onProgress } = {}) {
  const prep = prepare(src, stroke)
  if (!prep) return null
  const { aw, ah, region, rgba, mask, mode, brushPx } = prep
  // Pull-push is enough for this: the model paints over the whole hole, and
  // the first fill is only there so no crop shows it a letter.
  const filled = new Uint8ClampedArray(rgba)
  pushPull(filled, mask, region.w, region.h)

  const boxes = pieces(mask, region.w, region.h, Math.max(4, brushPx * 0.5))
    .map((b) => ({ x0: b.x0 + region.x, y0: b.y0 + region.y, x1: b.x1 + region.x, y1: b.y1 + region.y }))
  const plan = planCrops(boxes, aw, ah)
  if (!plan.length) return null

  // Only as much of the picture as the crops reach, not all of it: a photo
  // straight off a camera is a hundred megabytes of canvas to copy.
  let x0 = region.x
  let y0 = region.y
  let x1 = region.x + region.w
  let y1 = region.y + region.h
  for (const { crop: k } of plan) {
    x0 = Math.min(x0, k.x)
    y0 = Math.min(y0, k.y)
    x1 = Math.max(x1, k.x + k.w)
    y1 = Math.max(y1, k.y + k.h)
  }
  const work = document.createElement('canvas')
  work.width = x1 - x0
  work.height = y1 - y0
  const wg = work.getContext('2d', { willReadFrequently: true })
  wg.drawImage(src, -x0, -y0)
  wg.putImageData(new ImageData(new Uint8ClampedArray(filled), region.w, region.h), region.x - x0, region.y - y0)

  for (const { core, crop } of plan) {
    const hole = new Uint8Array(crop.w * crop.h)
    let any = false
    for (let y = Math.max(core.y0, region.y); y < Math.min(core.y1, region.y + region.h); y++) {
      for (let x = Math.max(core.x0, region.x); x < Math.min(core.x1, region.x + region.w); x++) {
        if (!mask[(y - region.y) * region.w + (x - region.x)]) continue
        hole[(y - crop.y) * crop.w + (x - crop.x)] = 1
        any = true
      }
    }
    if (!any) continue
    const cut = wg.getImageData(crop.x - x0, crop.y - y0, crop.w, crop.h)
    const out = await inpaint(cut.data, hole, crop.w, crop.h, { onProgress })
    for (let i = 0; i < hole.length; i++) {
      if (!hole[i]) continue
      const cx = crop.x + (i % crop.w)
      const cy = crop.y + Math.floor(i / crop.w)
      const p = i * 4
      cut.data[p] = out[p]
      cut.data[p + 1] = out[p + 1]
      cut.data[p + 2] = out[p + 2]
      const rp = ((cy - region.y) * region.w + (cx - region.x)) * 4
      filled[rp] = out[p]
      filled[rp + 1] = out[p + 1]
      filled[rp + 2] = out[p + 2]
    }
    wg.putImageData(cut, crop.x - x0, crop.y - y0)
  }
  return makePatch(filled, mask, region, 'ai', mode)
}
