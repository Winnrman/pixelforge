// The magic eraser's model: MI-GAN, run locally through ONNX Runtime Web.
//
// Given a picture and a hole, it paints what was probably in the hole — the
// "estimate" in the tool's name. Chosen because it was built for exactly this
// on small devices: 28MB, fast enough on a CPU to feel like a brush rather
// than a render, and good at the thing text removal mostly is, which is
// carrying a background's texture across a narrow gap.
//
// The pipeline export takes the picture and mask at any size and does its own
// cropping and resizing inside the graph, so nothing here has to know the
// network's working resolution.
//
// Model: MI-GAN (Picsart AI Research), MIT licence.
// github.com/Picsart-AI-Research/MI-GAN

import { loadOrt, cachedModel, fetchModel } from './models.js'

export const INPAINT_MODEL = {
  key: 'migan',
  name: 'MI-GAN',
  size: '28 MB',
  licence: 'MIT',
  urls: ['https://huggingface.co/andraniksargsyan/migan/resolve/main/migan_pipeline_v2.onnx'],
}

// How the pipeline's mask reads: 0 marks the hole, 255 the picture to keep.
const HOLE = 0
const KEEP = 255

let sessionPromise = null
let backend = null
let forceCpu = false
let bytes = null

export const inpaintBackend = () => backend
export const inpaintLoaded = () => !!sessionPromise
export async function inpaintCached() {
  return !!(await cachedModel(INPAINT_MODEL.key))
}

async function makeSession(ep, onProgress) {
  const ort = await loadOrt()
  if (!bytes) bytes = await fetchModel(INPAINT_MODEL.key, INPAINT_MODEL.urls, onProgress)
  const s = await ort.InferenceSession.create(bytes, {
    executionProviders: [ep],
    graphOptimizationLevel: 'all',
  })
  backend = ep
  return s
}

function getSession(onProgress) {
  if (sessionPromise) return sessionPromise
  const ep = forceCpu ? 'wasm' : 'webgpu'
  sessionPromise = makeSession(ep, onProgress).catch((err) => {
    if (ep === 'wasm') { sessionPromise = null; throw err }
    console.warn('[pixelforge] WebGPU inpainting session failed, using CPU:', err.message)
    forceCpu = true
    sessionPromise = makeSession('wasm', onProgress).catch((e) => { sessionPromise = null; throw e })
    return sessionPromise
  })
  return sessionPromise
}

// A kernel the GPU backend lacks only shows up when it runs, not when the
// session is built, so a run that fails has to be able to fall back too.
async function runWithFallback(session, feeds) {
  try {
    return await session.run(feeds)
  } catch (err) {
    if (forceCpu) throw err
    console.warn('[pixelforge] WebGPU inpainting kernel unsupported, re-running on CPU:', err.message)
    forceCpu = true
    sessionPromise = null
    const cpu = await getSession()
    return cpu.run(feeds)
  }
}

// The two inputs by name where the export names them, by position otherwise.
function inputNames(session) {
  const names = session.inputNames
  const mask = names.find((n) => /mask/i.test(n)) || names[1]
  const image = names.find((n) => n !== mask) || names[0]
  return { image, mask }
}

/**
 * Fills the hole in an RGBA crop and returns a new RGBA array: the model's
 * colours inside the hole, the input untouched everywhere else, and the input's
 * alpha kept throughout — the model knows nothing of transparency.
 */
export async function inpaint(rgba, hole, w, h, { onProgress } = {}) {
  const ort = await loadOrt()
  const session = await getSession(onProgress)
  const n = w * h
  const img = new Uint8Array(3 * n)
  const msk = new Uint8Array(n)
  for (let i = 0, p = 0; i < n; i++, p += 4) {
    img[i] = rgba[p]
    img[n + i] = rgba[p + 1]
    img[2 * n + i] = rgba[p + 2]
    msk[i] = hole[i] ? HOLE : KEEP
  }
  const names = inputNames(session)
  const results = await runWithFallback(session, {
    [names.image]: new ort.Tensor('uint8', img, [1, 3, h, w]),
    [names.mask]: new ort.Tensor('uint8', msk, [1, 1, h, w]),
  })
  const out = results[session.outputNames[0]]
  const [oh, ow] = out.dims.slice(-2)
  if (oh !== h || ow !== w) throw new Error(`The model answered ${ow}×${oh} for a ${w}×${h} crop`)

  // uint8 from this export; a float export would say 0..1 or -1..1, and is
  // read either way rather than trusted to be one or the other.
  const data = out.data
  let k = 1
  let off = 0
  if (!(data instanceof Uint8Array)) {
    let lo = Infinity
    let hi = -Infinity
    for (let i = 0; i < data.length; i += 97) { lo = Math.min(lo, data[i]); hi = Math.max(hi, data[i]) }
    if (hi <= 1.01) { k = lo < -0.01 ? 127.5 : 255; off = lo < -0.01 ? 1 : 0 }
  }
  const res = new Uint8ClampedArray(rgba)
  for (let i = 0, p = 0; i < n; i++, p += 4) {
    if (!hole[i]) continue
    res[p] = (data[i] + off) * k
    res[p + 1] = (data[n + i] + off) * k
    res[p + 2] = (data[2 * n + i] + off) * k
  }
  return res
}
