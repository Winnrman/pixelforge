// Learned background removal: U²-Net (small) run locally through ONNX Runtime
// Web, on WebGPU where the browser offers it.
//
// This is the one part of the app that is not self-contained. The weights are
// ~4.6MB and are fetched once, then cached in IndexedDB, so it is offline from
// the second run onward. The image itself never leaves the machine — inference
// happens on the local GPU.
//
// Model: U²-Netp, Apache-2.0 (github.com/xuebinqin/U-2-Net). Chosen over the
// larger matters because 4.6MB downloads in a blink and it segments general
// subjects, not only people.

import { loadOrt, cachedModel, forgetModel, fetchModel } from './models.js'
import { originOf } from './healed.js'

/**
 * Two models, because they fail in different places. U²-Netp is small and
 * general but uses a MaxPool with ceil_mode that ONNX Runtime's WebGPU backend
 * has not implemented, so it lands on the CPU. MODNet is bigger and portrait
 * oriented, and its operators are ones WebGPU does support.
 */
export const MODELS = {
  u2netp: {
    key: 'u2netp',
    name: 'U²-Netp',
    size: '4.6 MB',
    licence: 'Apache-2.0',
    dim: 320,
    normalise: 'imagenet',
    urls: ['https://huggingface.co/tomjackson2023/rembg/resolve/main/u2netp.onnx'],
    note: 'General subjects. Runs on the CPU: WebGPU lacks a kernel it needs.',
  },
  modnet: {
    key: 'modnet',
    name: 'MODNet',
    size: '25.9 MB',
    licence: 'Apache-2.0',
    dim: 512,
    normalise: 'signed',
    urls: ['https://huggingface.co/Xenova/modnet/resolve/main/onnx/model.onnx'],
    note: 'Tuned for people, and able to use the GPU.',
  },
}

let modelId = 'u2netp'
export const setModel = (id) => {
  if (!MODELS[id] || id === modelId) return
  modelId = id
  sessionPromise = null
  modelBytes = null
  forceCpu = false
  backend = null
}
export const currentModel = () => MODELS[modelId]

let sessionPromise = null
let backend = null

// ---------------------------------------------------------------- model cache
// The download, the cache and the runtime are shared with the magic eraser's
// model in models.js; this module only says which weights it wants.

export async function isModelCached() {
  return !!(await cachedModel(modelId))
}

export async function clearModel() {
  await forgetModel(modelId)
  sessionPromise = null
}

// ------------------------------------------------------------------- session

/** Which device inference is actually running on, once a session exists. */
export const currentBackend = () => backend

let modelBytes = null
let forceCpu = false

async function makeSession(ep, onProgress) {
  const ort = await loadOrt()
  if (!modelBytes) modelBytes = await fetchModel(modelId, MODELS[modelId].urls, onProgress)
  const s = await ort.InferenceSession.create(modelBytes, {
    executionProviders: [ep],
    graphOptimizationLevel: 'all',
  })
  backend = ep
  return s
}

async function getSession(onProgress) {
  if (sessionPromise) return sessionPromise
  const ep = forceCpu ? 'wasm' : 'webgpu'
  sessionPromise = makeSession(ep, onProgress).catch(async (err) => {
    if (ep === 'wasm') { sessionPromise = null; throw err }
    console.warn('[pixelforge] WebGPU session failed, using CPU:', err.message)
    forceCpu = true
    sessionPromise = makeSession('wasm', onProgress)
    return sessionPromise
  })
  return sessionPromise
}

/**
 * Some models use operators the WebGPU backend has not implemented — U²-Net's
 * MaxPool with ceil_mode is one — and that only surfaces when a kernel actually
 * runs, not when the session is built. So a run-time failure has to fall back
 * too, otherwise the GPU path simply breaks the feature.
 */
async function runWithFallback(session, feeds) {
  try {
    return await session.run(feeds)
  } catch (err) {
    if (forceCpu) throw err
    console.warn('[pixelforge] WebGPU kernel unsupported, re-running on CPU:', err.message)
    forceCpu = true
    sessionPromise = null
    const cpu = await getSession()
    return cpu.run(feeds)
  }
}

export function isReady() {
  return !!sessionPromise
}

// ----------------------------------------------------------------- inference

const IMAGENET_MEAN = [0.485, 0.456, 0.406]
const IMAGENET_STD = [0.229, 0.224, 0.225]

function preprocess(bitmap) {
  const SIZE = MODELS[modelId].dim
  const c = document.createElement('canvas')
  c.width = SIZE
  c.height = SIZE
  const ctx = c.getContext('2d', { willReadFrequently: true })
  ctx.drawImage(bitmap, 0, 0, SIZE, SIZE)
  const { data } = ctx.getImageData(0, 0, SIZE, SIZE)

  // NCHW float, scaled by the largest channel value then standardised — the
  // preprocessing U²-Net was trained with.
  const out = new Float32Array(3 * SIZE * SIZE)
  let max = 1
  for (let i = 0; i < data.length; i += 4) {
    if (data[i] > max) max = data[i]
    if (data[i + 1] > max) max = data[i + 1]
    if (data[i + 2] > max) max = data[i + 2]
  }
  const plane = SIZE * SIZE
  const signed = MODELS[modelId].normalise === 'signed'
  for (let i = 0, p = 0; i < plane; i++, p += 4) {
    if (signed) {
      // MODNet wants -1..1 rather than ImageNet standardisation.
      out[i] = data[p] / 127.5 - 1
      out[plane + i] = data[p + 1] / 127.5 - 1
      out[2 * plane + i] = data[p + 2] / 127.5 - 1
    } else {
      out[i] = (data[p] / max - IMAGENET_MEAN[0]) / IMAGENET_STD[0]
      out[plane + i] = (data[p + 1] / max - IMAGENET_MEAN[1]) / IMAGENET_STD[1]
      out[2 * plane + i] = (data[p + 2] / max - IMAGENET_MEAN[2]) / IMAGENET_STD[2]
    }
  }
  return out
}

/**
 * Runs the model and returns a SIZE×SIZE Float32 alpha map in 0..1.
 * The network emits several side outputs; the first is the full-resolution one.
 */
export async function predictMask(bitmap, { onProgress } = {}) {
  const ort = await loadOrt()
  const session = await getSession(onProgress)
  const SIZE = MODELS[modelId].dim
  const input = preprocess(bitmap)
  const tensor = new ort.Tensor('float32', input, [1, 3, SIZE, SIZE])
  const feeds = { [session.inputNames[0]]: tensor }
  const results = await runWithFallback(session, feeds)
  const first = results[Object.keys(results)[0]]
  const raw = first.data

  // U²-Net outputs unnormalised saliency; rescale to 0..1.
  let lo = Infinity
  let hi = -Infinity
  for (let i = 0; i < raw.length; i++) {
    if (raw[i] < lo) lo = raw[i]
    if (raw[i] > hi) hi = raw[i]
  }
  const span = hi - lo || 1
  const mask = new Float32Array(raw.length)
  for (let i = 0; i < mask.length; i++) mask[i] = (raw[i] - lo) / span
  return mask
}

/**
 * Applies a predicted mask to a frame, returning a canvas with the background
 * removed. The mask is produced at 320² and resampled bilinearly, so edges are
 * soft by nature; `threshold` and `feather` shape how hard the cut reads.
 */
export function applyMask(bitmap, mask, { threshold = 0.5, feather = 1, shrink = 0 } = {}) {
  const SIZE = Math.round(Math.sqrt(mask.length))
  const w = bitmap.naturalWidth || bitmap.width
  const h = bitmap.naturalHeight || bitmap.height
  const c = document.createElement('canvas')
  c.width = w
  c.height = h
  const ctx = c.getContext('2d', { willReadFrequently: true })
  ctx.drawImage(bitmap, 0, 0)
  const img = ctx.getImageData(0, 0, w, h)
  const d = img.data

  const alpha = new Float32Array(w * h)
  for (let y = 0; y < h; y++) {
    const sy = ((y + 0.5) / h) * SIZE - 0.5
    const y0 = Math.max(0, Math.min(SIZE - 1, Math.floor(sy)))
    const y1 = Math.min(SIZE - 1, y0 + 1)
    const fy = sy - y0
    for (let x = 0; x < w; x++) {
      const sx = ((x + 0.5) / w) * SIZE - 0.5
      const x0 = Math.max(0, Math.min(SIZE - 1, Math.floor(sx)))
      const x1 = Math.min(SIZE - 1, x0 + 1)
      const fx = sx - x0
      const a = mask[y0 * SIZE + x0] * (1 - fx) + mask[y0 * SIZE + x1] * fx
      const b = mask[y1 * SIZE + x0] * (1 - fx) + mask[y1 * SIZE + x1] * fx
      // A soft ramp around the threshold rather than a hard cut, so hair and
      // motion blur keep some partial alpha.
      const v = a * (1 - fy) + b * fy
      alpha[y * w + x] = Math.min(1, Math.max(0, (v - threshold) / 0.12 + 0.5))
    }
  }

  for (let r = 0; r < Math.min(4, Math.round(shrink)); r++) {
    const prev = Float32Array.from(alpha)
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x
        let lo2 = prev[i]
        if (x > 0) lo2 = Math.min(lo2, prev[i - 1])
        if (x < w - 1) lo2 = Math.min(lo2, prev[i + 1])
        if (y > 0) lo2 = Math.min(lo2, prev[i - w])
        if (y < h - 1) lo2 = Math.min(lo2, prev[i + w])
        alpha[i] = lo2
      }
    }
  }

  const fr = Math.min(8, Math.round(feather))
  if (fr >= 1) {
    const tmp = new Float32Array(alpha.length)
    const norm = 1 / (fr * 2 + 1)
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let sum = 0
        for (let k = -fr; k <= fr; k++) sum += alpha[y * w + Math.min(w - 1, Math.max(0, x + k))]
        tmp[y * w + x] = sum * norm
      }
    }
    for (let x = 0; x < w; x++) {
      for (let y = 0; y < h; y++) {
        let sum = 0
        for (let k = -fr; k <= fr; k++) sum += tmp[Math.min(h - 1, Math.max(0, y + k)) * w + x]
        alpha[y * w + x] = sum * norm
      }
    }
  }

  for (let i = 0, p = 3; i < alpha.length; i++, p += 4) d[p] = Math.round(d[p] * alpha[i])
  ctx.putImageData(img, 0, 0)
  return c
}

export const MODEL_INFO = MODELS.u2netp

// ------------------------------------------------------------------- caching
// Rendering is synchronous, inference is not. Masks are computed ahead of time
// by an explicit action and parked here; the renderer only ever reads.

const maskCache = new WeakMap()   // bitmap -> Float32Array
const frameCache = new WeakMap()  // bitmap -> { key, canvas }

export const hasMaskFor = (bitmap) => maskCache.has(bitmap)
export const rememberMask = (bitmap, mask) => maskCache.set(bitmap, mask)

/** A keyed canvas for this frame, or null when no mask has been computed yet. */
export function keyedFrameAI(bitmap, opts = {}) {
  // A picture the magic eraser has been over is a new canvas, but it is the
  // same subject in the same place — so the matte made for the original serves.
  const from = originOf(bitmap)
  const mask = maskCache.get(bitmap) || (from && maskCache.get(from))
  if (!mask) return null
  const key = [opts.threshold ?? 0.5, opts.feather ?? 1, opts.shrink ?? 0].join('|')
  const hit = frameCache.get(bitmap)
  if (hit && hit.key === key) return hit.canvas
  const canvas = applyMask(bitmap, mask, opts)
  frameCache.set(bitmap, { key, canvas })
  return canvas
}
