// Things you can do once you have a subject alpha.
//
// The matte itself already exists: `keyedFrame` (colour key) and `keyedFrameAI`
// (the segmentation model) both hand back a canvas whose alpha is the subject.
// Everything here builds on that one surface rather than re-deriving it, which
// is why the sticker outline and the motion trails cost almost nothing on top
// of a matte the user has already run.
import { keyedFrame } from './matte.js'
import { keyedFrameAI } from './aiMatte.js'

const pool = new Map()
function scratch(key, w, h) {
  let c = pool.get(key)
  if (!c) {
    c = document.createElement('canvas')
    pool.set(key, c)
  }
  if (c.width !== w || c.height !== h) {
    c.width = w
    c.height = h
  }
  return c
}

/**
 * The subject-only version of a frame, or null when this layer has no matte.
 *
 * Returning null rather than the raw frame is deliberate: a caller that wanted
 * a cutout and silently got an opaque rectangle produces a confusing result,
 * so each caller decides for itself what to do without one.
 */
export function subjectFrame(raw, bgRemove) {
  if (!raw || !bgRemove?.on) return null
  if (bgRemove.mode === 'ai') return keyedFrameAI(raw, bgRemove)
  return keyedFrame(raw, bgRemove)
}

/**
 * The box the subject actually occupies, as a 0..1 sub-rect of the frame.
 *
 * Read off the alpha of a keyed frame, so it works the same for a colour key
 * and for the segmentation model. Returns null when nothing is above the
 * threshold — an empty matte should say so rather than hand back a full frame
 * that looks like a successful trim.
 */
export function alphaBounds(keyed, threshold = 24) {
  if (!keyed) return null
  const w = keyed.naturalWidth || keyed.width
  const h = keyed.naturalHeight || keyed.height
  if (!w || !h) return null
  const c = scratch('bounds', w, h)
  const ctx = c.getContext('2d', { willReadFrequently: true })
  ctx.setTransform(1, 0, 0, 1, 0, 0)
  ctx.clearRect(0, 0, w, h)
  ctx.drawImage(keyed, 0, 0)
  const d = ctx.getImageData(0, 0, w, h).data

  let minX = w
  let minY = h
  let maxX = -1
  let maxY = -1
  for (let y = 0; y < h; y++) {
    const row = y * w
    for (let x = 0; x < w; x++) {
      if (d[(row + x) * 4 + 3] < threshold) continue
      if (x < minX) minX = x
      if (x > maxX) maxX = x
      if (y < minY) minY = y
      if (y > maxY) maxY = y
    }
  }
  if (maxX < 0) return null
  return {
    x: minX / w,
    y: minY / h,
    w: (maxX - minX + 1) / w,
    h: (maxY - minY + 1) / h,
  }
}

/** The smallest box containing all of them; nulls are ignored. */
export function unionBounds(list) {
  const real = list.filter(Boolean)
  if (!real.length) return null
  const x = Math.min(...real.map((b) => b.x))
  const y = Math.min(...real.map((b) => b.y))
  const x2 = Math.max(...real.map((b) => b.x + b.w))
  const y2 = Math.max(...real.map((b) => b.y + b.h))
  return { x, y, w: x2 - x, h: y2 - y }
}

/**
 * Whether a layer has been cut out of its background at all, by any route.
 *
 * A sticker needs a subject standing free of its surroundings; it does not care
 * *how* that happened. Removing the background is one way, drawing round the
 * subject with the lasso — the AI one included — is another, brushing the mask
 * is a third, and rubbing the background out with the eraser is a fourth. All three leave the same thing: a
 * layer with transparency where the background used to be.
 *
 * It lives here so the renderer and the switch that turns stickers on read the
 * same definition. They did not: the renderer had always accepted a lasso mask
 * and the switch had always demanded background removal, so the way through was
 * to turn background removal on and set it to zero — a step that did nothing,
 * to satisfy a check that was wrong.
 */
export const isCutOut = (l) => !!(
  l?.type === 'image'
  && (l.bgRemove?.on
    || (l.mask?.points?.length || 0) >= 3
    || (l.mask?.paint?.length || 0) > 0
    || (l.erase?.strokes?.length || 0) > 0)
)

export const defaultSticker = () => ({
  on: false,
  outline: 12,          // px of border, measured on the source image
  color: '#ffffff',
  shadow: 10,           // blur radius of the drop shadow
  shadowColor: 'rgba(0,0,0,0.45)',
  shadowY: 6,
})

export const defaultTrails = () => ({
  on: false,
  count: 5,
  gapMs: 70,
  fade: 0.6,            // opacity multiplier per echo
  scale: 1,             // <1 shrinks older echoes, which reads as depth
})

// A sticker is expensive enough to be worth caching, and it only changes when
// the frame or the settings change — so one entry per source bitmap, keyed on
// the settings, is both correct and cheap. WeakMap so decoded frames stay
// collectable.
const stickerCache = new WeakMap()

/**
 * Wraps a cutout in a sticker border and drop shadow.
 *
 * The border is made by stamping the silhouette around a circle rather than by
 * a real distance transform: at these radii the difference is invisible and it
 * runs on the GPU instead of per-pixel in JS. `steps` scales with the radius
 * so a wide border does not turn into a flower.
 *
 * Returns `{ canvas, pad }` — `pad` is how far the result grew on every side,
 * in source pixels, so the caller can keep the subject registered where it was.
 */
export function stickerFrame(cut, opts) {
  if (!cut) return null
  const outline = Math.max(0, Math.round(opts.outline || 0))
  const shadow = Math.max(0, Math.round(opts.shadow || 0))
  const shadowY = Math.round(opts.shadowY || 0)
  if (!outline && !shadow) return { canvas: cut, pad: 0 }

  const key = [outline, opts.color, shadow, opts.shadowColor, shadowY].join('|')
  const hit = stickerCache.get(cut)
  if (hit && hit.key === key) return hit.value

  const w = cut.width
  const h = cut.height
  const pad = outline + shadow * 2 + Math.abs(shadowY) + 2
  const ow = w + pad * 2
  const oh = h + pad * 2

  // The silhouette: the cutout flattened to a solid shape in the border colour.
  const sil = scratch('sil', ow, oh)
  const sc = sil.getContext('2d')
  sc.setTransform(1, 0, 0, 1, 0, 0)
  sc.clearRect(0, 0, ow, oh)
  if (outline > 0) {
    const steps = Math.max(8, Math.min(48, outline * 4))
    for (let i = 0; i < steps; i++) {
      const a = (i / steps) * Math.PI * 2
      sc.drawImage(cut, pad + Math.cos(a) * outline, pad + Math.sin(a) * outline)
    }
  }
  sc.drawImage(cut, pad, pad)
  sc.globalCompositeOperation = 'source-in'
  sc.fillStyle = opts.color || '#ffffff'
  sc.fillRect(0, 0, ow, oh)
  sc.globalCompositeOperation = 'source-over'

  const out = document.createElement('canvas')
  out.width = ow
  out.height = oh
  const oc = out.getContext('2d')

  if (shadow > 0) {
    // Shadowing the silhouette, not the artwork, keeps the shadow the shape of
    // the sticker rather than the shape of the subject inside it.
    oc.save()
    oc.filter = `blur(${shadow}px)`
    oc.globalAlpha = 1
    const sh = scratch('shadow', ow, oh)
    const shc = sh.getContext('2d')
    shc.setTransform(1, 0, 0, 1, 0, 0)
    shc.clearRect(0, 0, ow, oh)
    shc.drawImage(sil, 0, 0)
    shc.globalCompositeOperation = 'source-in'
    shc.fillStyle = opts.shadowColor || 'rgba(0,0,0,0.45)'
    shc.fillRect(0, 0, ow, oh)
    shc.globalCompositeOperation = 'source-over'
    oc.drawImage(sh, 0, shadowY)
    oc.restore()
  }

  oc.drawImage(sil, 0, 0)
  oc.drawImage(cut, pad, pad)

  const value = { canvas: out, pad }
  stickerCache.set(cut, { key, value })
  return value
}

/**
 * Export presets for sticker mode. Telegram wants 512px on the long edge and
 * WebP under 512KB for a static sticker; Discord's emoji slot is 128px and
 * capped at 256KB. Both are the current published limits — a size that is
 * merely close gets rejected on upload, so these are exact.
 */
export const STICKER_PRESETS = [
  { id: 'telegram', label: 'Telegram sticker', size: 512, format: 'png', note: '512px long edge' },
  { id: 'telegram-anim', label: 'Telegram animated', size: 512, format: 'gif', note: '512px, ≤3s' },
  { id: 'discord', label: 'Discord emoji', size: 128, format: 'png', note: '128px, ≤256KB' },
  { id: 'discord-sticker', label: 'Discord sticker', size: 320, format: 'png', note: '320px' },
  { id: 'slack', label: 'Slack emoji', size: 128, format: 'png', note: '128px, ≤128KB' },
  { id: 'whatsapp', label: 'WhatsApp sticker', size: 512, format: 'png', note: '512px' },
]
