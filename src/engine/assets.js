import { decodeGIF } from './gif.js'
import { isVideoFile, loadVideo, prewarm } from './video.js'

// Bitmaps live outside the undo history — layers only ever hold an assetId.
const registry = new Map()
let counter = 0

export const getAsset = (id) => registry.get(id)
export const allAssets = () => registry

/** Re-imports an asset from stored bytes, returning the freshly registered one. */
export function loadImageBytes(bytes, name, type) {
  return loadImageFile(new File([bytes], name, { type: type || '' }))
}

function makeAsset(id, name, width, height, frames) {
  const cum = []
  let t = 0
  for (const f of frames) {
    t += f.delay || 0
    cum.push(t)
  }
  return {
    id, name, width, height, frames, cum,
    duration: t || 0,
    animated: frames.length > 1,
    live: false,
  }
}

async function framesFromImageDecoder(blob) {
  if (typeof ImageDecoder === 'undefined') return null
  try {
    const dec = new ImageDecoder({ data: await blob.arrayBuffer(), type: blob.type })
    await dec.tracks.ready
    const track = dec.tracks.selectedTrack
    const count = track?.frameCount || 1
    if (count <= 1) return null
    const frames = []
    for (let i = 0; i < count; i++) {
      const { image } = await dec.decode({ frameIndex: i })
      const delay = image.duration ? image.duration / 1000 : 100
      frames.push({ bitmap: await createImageBitmap(image), delay: delay < 20 ? 100 : delay })
      image.close()
    }
    dec.close()
    return frames
  } catch {
    return null
  }
}

export async function loadImageFile(file) {
  const id = `a${++counter}_${Math.random().toString(36).slice(2, 7)}`
  const buf = await file.arrayBuffer()

  if (isVideoFile(file)) {
    // Video keeps only frame timing up front; pixels are decoded on demand.
    const v = await loadVideo(buf, file.name, file.type)
    v.id = id
    // A file with no type says what it is in its first bytes; a WebM kept as
    // video/mp4 would be saved and reopened as something it is not.
    const head = new Uint8Array(buf, 0, Math.min(4, buf.byteLength))
    const vtype = file.type || (head[0] === 0x1a && head[1] === 0x45 ? 'video/webm' : 'video/mp4')
    v.blob = new Blob([buf], { type: vtype })
    v.type = vtype
    registry.set(id, v)
    // Start decoding from the first frame right away, so the clip shows a
    // picture as soon as it lands rather than a blank until something asks.
    prewarm(v)
    // And build its filmstrip pictures now, in the background, rather than when
    // the timeline is first looked at. It is the same work either way; doing it
    // here is the difference between a strip that is there and a strip you watch
    // being made. Imported dynamically so the asset module does not depend on
    // the timeline's.
    import('./filmstrip.js').then((m) => m.primeThumbs(v)).catch(() => {})
    // The encoded bytes are kept for the audio decoder, which runs on first play
    // rather than now: decoding a long soundtrack to PCM costs real memory, and
    // most imports are never played with sound on.
    v.audioBytes = buf
    return v
  }

  const isGif = file.type === 'image/gif' || /\.gif$/i.test(file.name)
  let asset = null

  if (isGif) {
    try {
      const g = decodeGIF(new Uint8Array(buf))
      const frames = []
      for (const f of g.frames) {
        frames.push({ bitmap: await createImageBitmap(f.imageData), delay: f.delay })
      }
      asset = makeAsset(id, file.name, g.width, g.height, frames)
    } catch (err) {
      console.warn('[pixelforge] GIF decode failed, trying ImageDecoder:', err.message)
    }
  }

  if (!asset) {
    const blob = new Blob([buf], { type: file.type || 'image/png' })
    const decoded = await framesFromImageDecoder(blob)
    if (decoded) {
      asset = makeAsset(id, file.name, decoded[0].bitmap.width, decoded[0].bitmap.height, decoded)
    } else {
      try {
        const bmp = await createImageBitmap(blob)
        asset = makeAsset(id, file.name, bmp.width, bmp.height, [{ bitmap: bmp, delay: 0 }])
      } catch {
        // Last resort: an <img> element the browser animates for us. Preview works,
        // but frame-exact export does not, so flag it as `live`.
        const url = URL.createObjectURL(blob)
        const el = await new Promise((res, rej) => {
          const i = new Image()
          i.onload = () => res(i)
          i.onerror = () => rej(new Error('Could not decode ' + file.name))
          i.src = url
        })
        asset = {
          id, name: file.name, width: el.naturalWidth, height: el.naturalHeight,
          frames: [], cum: [], duration: 0, animated: false, live: true, el,
        }
      }
    }
  }

  // Keep the original encoded file. Saving a project stores these bytes rather
  // than re-encoding decoded frames, so a round-trip is lossless and small.
  asset.blob = new Blob([buf], { type: file.type || 'application/octet-stream' })
  asset.type = file.type || ''
  registry.set(id, asset)
  return asset
}
