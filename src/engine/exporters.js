import { renderDocument, docDuration, sampleTimes, awaitVideo } from './render.js'
import { blobWithDPI } from './dpi.js'
import { saveBlob, downloadBlob, isDesktop, encoder, tempFile, removeFile, pickSavePath } from './desktop.js'
import { getAsset } from './assets.js'

// Kept for callers that genuinely want a browser download regardless of shell.
export const download = downloadBlob

/**
 * Where an export ends up. On the desktop this is a Save dialog and a real
 * file; in the browser it is a download. `opts.dir` writes straight into a
 * folder without prompting, which is what batch export needs.
 */
const deliver = (blob, filename, opts) => saveBlob(blob, filename, opts || {})

function makeCanvas(w, h) {
  const c = document.createElement('canvas')
  c.width = w
  c.height = h
  return c
}

// Render at native document resolution, then downsample — region effects read
// raw canvas pixels, so they must run at 1:1 to stay grid-accurate.
function renderScaled(doc, time, scale, matte) {
  const dc = makeCanvas(doc.width, doc.height)
  renderDocument(dc.getContext('2d'), doc, time)
  const ow = Math.max(1, Math.round(doc.width * scale))
  const oh = Math.max(1, Math.round(doc.height * scale))
  if (scale === 1 && !matte) return dc
  const out = makeCanvas(ow, oh)
  const oc = out.getContext('2d')
  if (matte) {
    oc.fillStyle = matte
    oc.fillRect(0, 0, ow, oh)
  }
  oc.imageSmoothingQuality = 'high'
  oc.drawImage(dc, 0, 0, ow, oh)
  return out
}

export async function exportPNG(doc, time, {
  scale = 1, matte = null, filename = 'pixelforge.png', dir = null, silent = false, dpi = 0,
} = {}) {
  await awaitVideo(doc, time)
  const c = renderScaled(doc, time, scale, matte)
  const raw = await new Promise((r) => c.toBlob(r, 'image/png'))
  // Stamped after encoding rather than asked of the encoder, because canvas
  // cannot be told a resolution — toBlob always writes a file with no physical
  // size at all, which print software then guesses at.
  const blob = await blobWithDPI(raw, dpi)
  const path = await deliver(blob, filename, { dir, silent })
  return { blob, path }
}

export async function copyPNGToClipboard(doc, time) {
  await awaitVideo(doc, time)
  const c = renderScaled(doc, time, 1, null)
  const blob = await new Promise((r) => c.toBlob(r, 'image/png'))
  await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })])
}

export async function exportGIF(doc, opts = {}, onProgress = () => {}) {
  const {
    fps = 20,
    scale = 1,
    transparent = false,
    matte = '#000000',
    colors = 256,
    maxFrames = 400,
    filename = 'pixelforge.gif',
  } = opts

  const duration = docDuration(doc)
  const { times, exact } = sampleTimes(doc, duration, fps, maxFrames)
  const ow = Math.max(1, Math.round(doc.width * scale))
  const oh = Math.max(1, Math.round(doc.height * scale))

  const worker = new Worker(new URL('./gifWorker.js', import.meta.url), { type: 'module' })
  const waitFor = (type) =>
    new Promise((res, rej) => {
      const h = (e) => {
        if (e.data.type === type) {
          worker.removeEventListener('message', h)
          res(e.data)
        }
      }
      worker.addEventListener('message', h)
      worker.addEventListener('error', rej, { once: true })
    })

  try {
    worker.postMessage({ type: 'begin', transparent, colors })
    await waitFor('ready')

    for (let i = 0; i < times.length; i++) {
      const t = times[i]
      const next = i + 1 < times.length ? times[i + 1] : duration || t + 1000 / fps
      const delay = Math.max(20, Math.round(next - t))
      // Frame-accurate: wait for the real frame rather than whatever is cached.
      await awaitVideo(doc, t)
      const c = renderScaled(doc, t, scale, transparent ? null : matte)
      const img = c.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, ow, oh)
      const buffer = img.data.buffer
      worker.postMessage({ type: 'frame', buffer, width: ow, height: oh, delay }, [buffer])
      await waitFor('frameDone')
      onProgress((i + 1) / times.length)
    }

    worker.postMessage({ type: 'finish' })
    const { bytes } = await waitFor('done')
    const blob = new Blob([bytes], { type: 'image/gif' })
    const path = await deliver(blob, filename, { dir: opts.dir || null, silent: !!opts.silent })
    return { blob, frames: times.length, exact, path }
  } finally {
    worker.terminate()
  }
}

/** Video assets in the document that could supply a soundtrack. */
export function audioCandidates(doc) {
  const out = []
  for (const l of doc.layers) {
    if (l.type !== 'image' || l.visible === false) continue
    const a = getAsset(l.assetId)
    if (!a?.isVideo || !a.blob) continue
    // Retiming and loop repair both move the picture without moving the sound,
    // so the original track would drift. Rather than pretend, those layers are
    // offered with the reason they cannot be used.
    const retimed = (l.speed || 1) !== 1 || (l.timeOffset || 0) !== 0 || !!l.loop?.on
    out.push({ assetId: a.id, layerId: l.id, name: l.name, retimed })
  }
  return out
}

/**
 * H.264 in MP4, encoded by a local ffmpeg.
 *
 * Frames are streamed into ffmpeg's stdin as PNGs rather than staged on disk —
 * a few thousand 1080p PNGs is gigabytes of intermediate for a file that ends
 * up a few dozen megabytes. Every write is awaited, so ffmpeg's backpressure
 * paces the render loop instead of memory climbing until something gives.
 *
 * Unlike GIF this is *constant* frame rate. MP4 players expect CFR, and the
 * per-frame delays a GIF carries have no clean equivalent here, so the document
 * is sampled at a fixed interval and the dialog says so rather than implying
 * the source timing survived untouched.
 */
export async function exportMP4(doc, opts = {}, onProgress = () => {}) {
  const {
    fps = 30,
    scale = 1,
    crf = 18,
    preset = 'medium',
    matte = '#000000',
    filename = 'pixelforge.mp4',
    audioAssetId = null,
    dir = null,
    loops = 1,
  } = opts

  if (!isDesktop()) {
    throw new Error('MP4 export needs the desktop build — the browser has no ffmpeg to call.')
  }

  const outPath = dir
    ? dir.replace(/[\\/]+$/, '') + (dir.includes('\\') ? '\\' : '/') + filename
    : await pickSavePath(filename)
  if (!outPath) return { cancelled: true }

  const duration = Math.max(1000 / fps, docDuration(doc) * Math.max(1, loops))
  const count = Math.max(1, Math.round((duration / 1000) * fps))

  // H.264 in yuv420p has no alpha, so a transparent document is flattened onto
  // the matte instead of exporting black holes where the alpha was.
  let audioPath = null
  let enc = null
  try {
    if (audioAssetId) {
      const a = getAsset(audioAssetId)
      if (a?.blob) audioPath = await tempFile(await a.blob.arrayBuffer(), 'mp4')
    }

    const args = [
      '-y',
      // Without this the first twenty lines of any failure are the build banner.
      '-hide_banner',
      '-f', 'image2pipe', '-framerate', String(fps), '-i', '-',
      ...(audioPath ? ['-i', audioPath] : []),
      '-map', '0:v:0',
      // '?' makes the audio stream optional, so a silent source is not an error.
      ...(audioPath ? ['-map', '1:a:0?', '-c:a', 'aac', '-b:a', '192k', '-shortest'] : []),
      '-c:v', 'libx264',
      '-preset', preset,
      '-crf', String(crf),
      // yuv420p is what every player and browser can decode, and it requires
      // even dimensions — hence the trunc, which a scale like 33% will hit.
      '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2',
      '-pix_fmt', 'yuv420p',
      '-movflags', '+faststart',
      outPath,
    ]

    let encoded = 0
    enc = await encoder(args, (frame) => { encoded = frame })

    for (let i = 0; i < count; i++) {
      const t = (i / count) * duration
      await awaitVideo(doc, t % Math.max(1, docDuration(doc) || duration))
      const c = renderScaled(doc, t % Math.max(1, docDuration(doc) || duration), scale, matte)
      const blob = await new Promise((r) => c.toBlob(r, 'image/png'))
      await enc.write(await blob.arrayBuffer())
      onProgress((i + 1) / count, { rendered: i + 1, total: count, encoded })
    }

    const res = await enc.finish()
    enc = null
    return { path: outPath, frames: count, fps, duration, log: res.log, audio: !!audioPath }
  } catch (err) {
    if (enc) await enc.abort().catch(() => {})
    throw err
  } finally {
    if (audioPath) await removeFile(audioPath)
  }
}

export async function exportWebM(doc, opts = {}, onProgress = () => {}) {
  const { fps = 30, scale = 1, filename = 'pixelforge.webm', loops = 1 } = opts
  const duration = Math.max(1000, docDuration(doc) * loops)
  const ow = Math.max(1, Math.round(doc.width * scale))
  const oh = Math.max(1, Math.round(doc.height * scale))
  const out = makeCanvas(ow, oh)
  const oc = out.getContext('2d')
  const dc = makeCanvas(doc.width, doc.height)
  const dctx = dc.getContext('2d')

  const stream = out.captureStream(fps)
  const mime = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm']
    .find((m) => MediaRecorder.isTypeSupported(m))
  const rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 12_000_000 })
  const chunks = []
  rec.ondataavailable = (e) => e.data.size && chunks.push(e.data)

  const done = new Promise((res) => (rec.onstop = res))
  rec.start()

  const start = performance.now()
  await new Promise((res) => {
    const tick = () => {
      const elapsed = performance.now() - start
      renderDocument(dctx, doc, elapsed)
      oc.clearRect(0, 0, ow, oh)
      oc.drawImage(dc, 0, 0, ow, oh)
      onProgress(Math.min(1, elapsed / duration))
      if (elapsed >= duration) res()
      else requestAnimationFrame(tick)
    }
    tick()
  })

  rec.stop()
  await done
  const blob = new Blob(chunks, { type: mime })
  const path = await deliver(blob, filename, { dir: opts.dir || null })
  return { blob, path }
}
