// The engine, on a page with no interface on it.
//
// The shipped application deliberately carries no scripting surface — a check in
// verify-package.mjs fails the build if the `__pf*` handles leak into it — so the
// command line cannot borrow the app's. This is a separate bundle, built only
// for the CLI and never installed, whose whole job is to put the same engine on
// a blank page and let something outside drive it.
//
// It runs in a real browser rather than under node, and deliberately. The
// renderer *is* canvas code: filters, gradients, text metrics, font fallback.
// Reimplementing it against a node canvas would be a second renderer to keep in
// step with the first, which is the usual way to end up with two outputs that
// differ in ways nobody notices until it matters. Headless here means no
// interface and no person, not no browser.
import { GIFEncoder, quantize, applyPalette } from 'gifenc'
import { renderDocument, docDuration } from '../src/engine/render.js'
import { loadImageBytes } from '../src/engine/assets.js'
import { allKeyTimes } from '../src/engine/keyframes.js'
import {
  makeShapeLayer, makeTextLayer, makeGroupLayer, emptyDoc,
} from '../src/state/store.js'

/** Fills in every default a layer of that kind expects. */
function hydrate(layer) {
  if (layer.type === 'text') return makeTextLayer(layer)
  if (layer.type === 'group') return makeGroupLayer(layer)
  if (layer.type === 'image') {
    // An image layer wants none of the shape defaults, only an id and the
    // ordinary transform fields.
    const base = makeShapeLayer(layer)
    return { ...base, ...layer, type: 'image' }
  }
  return makeShapeLayer(layer)
}

/** A document from a plain description, with every default filled in. */
export function buildDoc(spec) {
  const doc = { ...emptyDoc(), ...spec, layers: (spec.layers || []).map(hydrate) }
  doc.duration = spec.duration ?? 0
  return doc
}

/**
 * Decodes the media a spec refers to and rewires the layers onto it.
 *
 * Assets are given real ids when they load, so a spec that says `"asset": "hero"`
 * has to be pointed at whatever id that turned into.
 */
export async function loadMedia(doc, media) {
  const byName = {}
  for (const m of media || []) {
    const bytes = Uint8Array.from(atob(m.bytes), (c) => c.charCodeAt(0))
    const asset = await loadImageBytes(bytes, m.name || 'asset', m.type)
    byName[m.id] = asset.id
  }
  const layers = doc.layers.map((l) => (l.asset && byName[l.asset]
    ? { ...l, assetId: byName[l.asset] }
    : l))
  return { ...doc, layers, media: Object.values(byName) }
}

function surface(doc) {
  const c = document.createElement('canvas')
  c.width = doc.width
  c.height = doc.height
  return c
}

/** One frame, as a PNG data URL. */
export function renderFrame(doc, time = 0) {
  const c = surface(doc)
  renderDocument(c.getContext('2d'), doc, time)
  return c.toDataURL('image/png')
}

/**
 * The instants an animation should be sampled at.
 *
 * A fixed frame rate, plus every keyframe time that falls inside the run — so a
 * move that lands exactly on 400ms lands there in the file too, rather than at
 * whichever sample happened to be nearest.
 */
export function frameTimes(doc, { fps = 20, duration = null } = {}) {
  const ms = duration ?? docDuration(doc) ?? 0
  const step = 1000 / fps
  const times = new Set()
  for (let t = 0; t < Math.max(step, ms); t += step) times.add(Math.round(t))
  for (const k of allKeyTimes(doc.layers || [])) if (k >= 0 && k <= ms) times.add(Math.round(k))
  return [...times].sort((a, b) => a - b)
}

/** Every frame of an animation, encoded as a GIF and handed back as base64. */
export function renderGif(doc, { fps = 20, duration = null, colors = 256 } = {}) {
  const times = frameTimes(doc, { fps, duration })
  const ms = duration ?? docDuration(doc) ?? 0
  const c = surface(doc)
  const ctx = c.getContext('2d', { willReadFrequently: true })
  const transparent = !doc.background || doc.background === 'transparent'
  const gif = GIFEncoder()

  times.forEach((t, i) => {
    ctx.clearRect(0, 0, c.width, c.height)
    renderDocument(ctx, doc, t)
    const data = ctx.getImageData(0, 0, c.width, c.height).data
    const format = transparent ? 'rgba4444' : 'rgb565'
    const palette = quantize(data, colors, {
      format,
      oneBitAlpha: transparent ? true : undefined,
    })
    const index = applyPalette(data, palette, format)
    const next = i + 1 < times.length ? times[i + 1] : Math.max(ms, t + 1000 / fps)
    gif.writeFrame(index, c.width, c.height, {
      palette,
      delay: Math.max(20, Math.round(next - t)),
      transparent,
      transparentIndex: 0,
      dispose: transparent ? 2 : -1,
      repeat: 0,
    })
  })
  gif.finish()
  const bytes = gif.bytes()
  let bin = ''
  // In chunks: spreading a megabyte into apply() overflows the argument list.
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000))
  }
  return { base64: btoa(bin), frames: times.length }
}

window.__pfHeadless = { buildDoc, loadMedia, renderFrame, renderGif, frameTimes }
