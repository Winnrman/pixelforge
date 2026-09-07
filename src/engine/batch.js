// Batch apply: run the current document over a folder of images.
//
// The document is treated as a recipe. One image layer is nominated as the
// slot, and for each input file that layer's asset is swapped while every other
// layer — overlays, text, effects, the cutout settings, the retro palette —
// stays exactly as it is. Nothing about the editing model changes; only which
// asset the slot points at.
import { zipSync } from 'fflate'
import { loadImageFile, getAsset } from './assets.js'
import { exportPNG, exportGIF } from './exporters.js'
import { docDuration } from './render.js'
import { saveBlob, isDesktop } from './desktop.js'

/** Image layers that could stand in as the slot, outermost first. */
export function slotCandidates(doc) {
  return doc.layers.filter((l) => l.type === 'image')
}

const stem = (name) => name.replace(/\.[^.]+$/, '')

/**
 * How the swapped-in image is fitted to the slot.
 *
 * 'cover' and 'contain' keep the document size, so every overlay stays where it
 * was placed — that is what makes a batch look consistent. 'native' resizes the
 * document per image and scales every other layer by the same factor, which is
 * right when the inputs vary in size and the overlay is meant to stay
 * proportional rather than fixed.
 */
export const FIT_MODES = [
  { value: 'cover', label: 'Fill the frame (crop)' },
  { value: 'contain', label: 'Fit inside the frame' },
  { value: 'native', label: 'Match each image, scale overlays' },
]

function fitInto(box, aw, ah, mode) {
  const k = mode === 'contain'
    ? Math.min(box.w / aw, box.h / ah)
    : Math.max(box.w / aw, box.h / ah)
  const w = aw * k
  const h = ah * k
  return { x: box.x + (box.w - w) / 2, y: box.y + (box.h - h) / 2, w, h }
}

/**
 * Builds the document for one input file.
 *
 * Returns a plain document — no store involvement — so a batch never disturbs
 * what the user has open, and a failure part-way through leaves the editor
 * exactly as it was.
 */
export function docForAsset(doc, slotId, asset, fit) {
  const slot = doc.layers.find((l) => l.id === slotId)
  if (!slot) return doc

  if (fit === 'native') {
    const k = Math.min(asset.width / (slot.w || 1), asset.height / (slot.h || 1))
    const sx = asset.width / doc.width
    const sy = asset.height / doc.height
    return {
      ...doc,
      width: asset.width,
      height: asset.height,
      layers: doc.layers.map((l) => {
        if (l.id === slotId) {
          return { ...l, assetId: asset.id, x: 0, y: 0, w: asset.width, h: asset.height, src: null }
        }
        if (typeof l.x !== 'number') return l
        // Overlays keep their relative placement and their aspect, so a circle
        // stays a circle rather than stretching with a non-uniform canvas.
        return {
          ...l,
          x: l.x * sx,
          y: l.y * sy,
          w: l.w * k,
          h: l.h * k,
          ...(typeof l.size === 'number' ? { size: l.size * k } : null),
        }
      }),
    }
  }

  const box = { x: slot.x, y: slot.y, w: slot.w, h: slot.h }
  const r = fitInto(box, asset.width, asset.height, fit)
  return {
    ...doc,
    layers: doc.layers.map((l) => (l.id === slotId
      ? { ...l, assetId: asset.id, x: r.x, y: r.y, w: r.w, h: r.h, src: null }
      : l)),
  }
}

/**
 * Applies the document to every file and writes the results.
 *
 * On the desktop each output is written straight into `outDir`. In the browser
 * there is no folder to write to, so the results are collected into a single
 * zip — the same outputs, one download instead of thirty.
 */
export async function runBatch({
  doc, slotId, files, outDir = null, fit = 'cover', format = 'png',
  scale = 1, matte = null, transparent = false, colors = 256, fps = 20,
  onProgress = () => {},
}) {
  const results = []
  const failures = []
  const zipEntries = {}
  const collect = !isDesktop() || !outDir

  for (let i = 0; i < files.length; i++) {
    const file = files[i]
    onProgress({ i, n: files.length, name: file.name, phase: 'loading' })
    try {
      const asset = await loadImageFile(file)
      const d = docForAsset(doc, slotId, asset, fit)
      // A still photo dropped into an animated recipe still animates, because
      // the overlays carry the keyframes — so the format follows the result,
      // not the input.
      const animated = docDuration(d) > 0
      const useGif = format === 'gif' && animated
      const name = stem(file.name) + (useGif ? '.gif' : '.png')

      onProgress({ i, n: files.length, name: file.name, phase: 'rendering' })
      const out = useGif
        ? await exportGIF(d, { fps, scale, transparent, matte, colors, filename: name, dir: collect ? null : outDir, silent: collect })
        : await exportPNG(d, 0, { scale, matte: transparent ? null : matte, filename: name, dir: collect ? null : outDir, silent: collect })

      if (collect) zipEntries[name] = new Uint8Array(await out.blob.arrayBuffer())
      results.push({ name, path: out.path || null })
    } catch (err) {
      // One bad file must not abandon the other twenty-nine.
      console.error('[pixelforge] batch failed on', file.name, err)
      failures.push({ name: file.name, error: err.message || String(err) })
    }
    onProgress({ i: i + 1, n: files.length, name: file.name, phase: 'done' })
  }

  let zipPath = null
  if (collect && Object.keys(zipEntries).length) {
    const blob = new Blob([zipSync(zipEntries, { level: 6 })], { type: 'application/zip' })
    zipPath = await saveBlob(blob, 'pixelforge-batch.zip')
  }
  return { results, failures, zipPath }
}
