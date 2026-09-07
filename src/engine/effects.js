import { addShapePath, layerAABB } from './shapes.js'

// Reusable scratch surfaces. Effects are applied synchronously inside a single
// render pass, so a shared pool is safe and avoids per-frame allocation.
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

export const EFFECTS = [
  { id: 'pixelate', label: 'Pixelate' },
  { id: 'blur', label: 'Gaussian blur' },
  { id: 'pixelblur', label: 'Pixel + blur' },
  { id: 'solid', label: 'Solid fill' },
  { id: 'darken', label: 'Darken' },
  { id: 'brighten', label: 'Brighten' },
  { id: 'desaturate', label: 'Desaturate' },
  { id: 'invert', label: 'Invert' },
  { id: 'noise', label: 'Noise' },
]

function pixelateInto(fc, source, bx, by, bw, bh, px) {
  // Snap the sample grid to document coordinates so blocks stay locked to the
  // image instead of crawling when the overlay is dragged.
  const gx = Math.floor(bx / px) * px
  const gy = Math.floor(by / px) * px
  const gw = Math.ceil((bx + bw - gx) / px) * px
  const gh = Math.ceil((by + bh - gy) / px) * px
  const sw = Math.max(1, Math.round(gw / px))
  const sh = Math.max(1, Math.round(gh / px))

  const sm = scratch('small', sw, sh)
  const smc = sm.getContext('2d')
  smc.clearRect(0, 0, sw, sh)
  smc.imageSmoothingEnabled = true
  smc.imageSmoothingQuality = 'high'
  smc.drawImage(source, gx, gy, gw, gh, 0, 0, sw, sh)

  fc.imageSmoothingEnabled = false
  fc.drawImage(sm, 0, 0, sw, sh, gx - bx, gy - by, gw, gh)
  fc.imageSmoothingEnabled = true
}

function noiseInto(fc, bw, bh, amount) {
  const img = fc.getImageData(0, 0, bw, bh)
  const d = img.data
  for (let i = 0; i < d.length; i += 4) {
    const n = (Math.random() - 0.5) * amount * 2.55
    d[i] += n
    d[i + 1] += n
    d[i + 2] += n
  }
  fc.putImageData(img, 0, 0)
}

/**
 * Applies a region effect layer to whatever has already been composited onto
 * `target`. The effect reads the pixels *behind* the shape, transforms them,
 * masks them to the shape (with optional feathering) and draws them back.
 */
export function applyEffectLayer(ctx, target, l, yieldTo = []) {
  const feather = Math.max(0, l.feather || 0)
  const blurR = Math.max(0, l.blurRadius || 0)
  const usesBlur = l.effect === 'blur' || l.effect === 'pixelblur'
  const pad = Math.ceil((usesBlur ? blurR * 3 : 0) + feather * 3) + 2

  let bx, by, bw, bh
  if (l.invert) {
    bx = 0; by = 0; bw = target.width; bh = target.height
  } else {
    const b = layerAABB(l)
    bx = Math.floor(b.x - pad)
    by = Math.floor(b.y - pad)
    bw = Math.ceil(b.w + pad * 2)
    bh = Math.ceil(b.h + pad * 2)
    // Clamp to the canvas; nothing outside it can be sampled anyway.
    const x2 = Math.min(target.width, bx + bw)
    const y2 = Math.min(target.height, by + bh)
    bx = Math.max(0, bx)
    by = Math.max(0, by)
    bw = x2 - bx
    bh = y2 - by
  }
  if (bw <= 0 || bh <= 0) return

  const fx = scratch('fx', bw, bh)
  const fc = fx.getContext('2d', { willReadFrequently: l.effect === 'noise' })
  fc.setTransform(1, 0, 0, 1, 0, 0)
  fc.globalCompositeOperation = 'source-over'
  fc.globalAlpha = 1
  fc.filter = 'none'
  fc.clearRect(0, 0, bw, bh)

  const px = Math.max(1, Math.round(l.pixelSize || 12))

  switch (l.effect) {
    case 'pixelate':
      pixelateInto(fc, target, bx, by, bw, bh, px)
      break
    case 'pixelblur':
      pixelateInto(fc, target, bx, by, bw, bh, px)
      if (blurR > 0) {
        const tmp = scratch('tmp', bw, bh)
        const tc = tmp.getContext('2d')
        tc.clearRect(0, 0, bw, bh)
        tc.drawImage(fx, 0, 0)
        fc.clearRect(0, 0, bw, bh)
        fc.filter = `blur(${blurR}px)`
        fc.drawImage(tmp, 0, 0)
        fc.filter = 'none'
      }
      break
    case 'blur':
      fc.filter = `blur(${blurR}px)`
      fc.drawImage(target, bx, by, bw, bh, 0, 0, bw, bh)
      fc.filter = 'none'
      break
    case 'solid':
      fc.fillStyle = l.color || '#000000'
      fc.fillRect(0, 0, bw, bh)
      break
    case 'darken':
      fc.filter = `brightness(${Math.max(0, 100 - (l.amount ?? 50))}%)`
      fc.drawImage(target, bx, by, bw, bh, 0, 0, bw, bh)
      fc.filter = 'none'
      break
    case 'brighten':
      fc.filter = `brightness(${100 + (l.amount ?? 50)}%)`
      fc.drawImage(target, bx, by, bw, bh, 0, 0, bw, bh)
      fc.filter = 'none'
      break
    case 'desaturate':
      fc.filter = `grayscale(${Math.min(100, l.amount ?? 100)}%)`
      fc.drawImage(target, bx, by, bw, bh, 0, 0, bw, bh)
      fc.filter = 'none'
      break
    case 'invert':
      fc.filter = 'invert(100%)'
      fc.drawImage(target, bx, by, bw, bh, 0, 0, bw, bh)
      fc.filter = 'none'
      break
    case 'noise':
      fc.drawImage(target, bx, by, bw, bh, 0, 0, bw, bh)
      noiseInto(fc, bw, bh, l.amount ?? 30)
      break
    default:
      return
  }

  // Build the alpha mask and punch the effect down to the shape.
  const mk = scratch('mask', bw, bh)
  const mc = mk.getContext('2d')
  mc.setTransform(1, 0, 0, 1, 0, 0)
  mc.clearRect(0, 0, bw, bh)
  mc.save()
  if (feather > 0) mc.filter = `blur(${feather}px)`
  mc.translate(-bx, -by)
  mc.fillStyle = '#fff'
  mc.beginPath()
  if (l.invert) {
    mc.rect(bx - 1, by - 1, bw + 2, bh + 2)
    addShapePath(mc, l)
    mc.fill('evenodd')
  } else {
    addShapePath(mc, l)
    mc.fill()
  }
  mc.restore()

  // An inverted effect means "treat everything except this shape", so it is the
  // layer that claims the whole canvas — and two of them claim it twice. Adding
  // a second one to protect a second face used to re-cover the first, and the
  // only way out was to draw one outline around both, which is not a shape
  // anybody wants to draw. So the "everything else" layer yields: it leaves
  // alone the territory every other effect layer has claimed, whether that is a
  // window another inverted layer is holding open or a region a plain effect is
  // already treating. Effects stack by union rather than by overwriting, and
  // protecting one more thing is one more shape rather than a redraw.
  if (l.invert && yieldTo.length) {
    mc.save()
    mc.globalCompositeOperation = 'destination-out'
    if (feather > 0) mc.filter = `blur(${feather}px)`
    mc.translate(-bx, -by)
    mc.fillStyle = '#fff'
    // Either way it is the other layer's shape that is spared: for a plain
    // effect that shape is the region it treats, and for an inverted one it is
    // the window it is holding open. What is left over is covered by both, and
    // pixelating an already-pixelated area on the same grid changes nothing.
    for (const o of yieldTo) {
      mc.beginPath()
      addShapePath(mc, o)
      mc.fill()
    }
    mc.restore()
  }

  fc.globalCompositeOperation = 'destination-in'
  fc.drawImage(mk, 0, 0)
  fc.globalCompositeOperation = 'source-over'

  ctx.save()
  ctx.globalAlpha = l.opacity ?? 1
  ctx.drawImage(fx, bx, by)
  ctx.restore()
}
