// Downloaded models, and the runtime that runs them.
//
// Two features use a learned model now — the background matte and the magic
// eraser — and both need the same three things: ONNX Runtime pointed at its own
// wasm, the weights fetched once with progress, and those weights kept so the
// second run needs no network at all. One copy of each, so a fix to the cache
// or the loader is a fix for both.
//
// The pictures themselves never leave the machine. Only the weights travel,
// and only the first time.

const DB_NAME = 'pixelforge-models'
const STORE = 'models'

let ortPromise = null

/** ONNX Runtime, loaded on first use and configured once. */
export function loadOrt() {
  if (!ortPromise) {
    ortPromise = import('onnxruntime-web').then((ort) => {
      // ORT fetches its wasm at run time rather than inlining it. Left to
      // itself it resolves a path the dev server answers with index.html, which
      // fails as "expected magic word". Point it at the copies in public/ort.
      ort.env.wasm.wasmPaths = {
        wasm: '/ort/ort-wasm-simd-threaded.jsep.wasm',
        mjs: '/ort/ort-wasm-simd-threaded.jsep.mjs',
      }
      ort.env.wasm.numThreads = 1  // threads would need cross-origin isolation
      ort.env.logLevel = 'error'
      return ort
    })
  }
  return ortPromise
}

function openDB() {
  return new Promise((res, rej) => {
    const req = indexedDB.open(DB_NAME, 1)
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE)
    }
    req.onsuccess = () => res(req.result)
    req.onerror = () => rej(req.error)
  })
}

/** The stored weights for `key`, or null. */
export async function cachedModel(key) {
  try {
    const db = await openDB()
    return await new Promise((res, rej) => {
      const r = db.transaction(STORE, 'readonly').objectStore(STORE).get(key)
      r.onsuccess = () => res(r.result || null)
      r.onerror = () => rej(r.error)
    })
  } catch {
    return null
  }
}

async function storeModel(key, bytes) {
  try {
    const db = await openDB()
    await new Promise((res, rej) => {
      const t = db.transaction(STORE, 'readwrite')
      t.objectStore(STORE).put(bytes, key)
      t.oncomplete = () => res()
      t.onerror = () => rej(t.error)
    })
  } catch { /* a cache miss next time is survivable */ }
}

export async function forgetModel(key) {
  try {
    const db = await openDB()
    await new Promise((res) => {
      const t = db.transaction(STORE, 'readwrite')
      t.objectStore(STORE).delete(key)
      t.oncomplete = res
      t.onerror = res
    })
  } catch { /* nothing cached */ }
}

/**
 * The weights for `key`: from the cache if they are there, otherwise from the
 * first of `urls` that answers, streamed so a slow download says how far along
 * it is rather than sitting silent.
 */
export async function fetchModel(key, urls, onProgress) {
  const hit = await cachedModel(key)
  if (hit) return hit

  let res = null
  let lastErr = null
  for (const url of urls) {
    try {
      const r = await fetch(url)
      if (r.ok) { res = r; break }
      lastErr = new Error(`HTTP ${r.status}`)
    } catch (err) { lastErr = err }
  }
  if (!res) {
    throw new Error('Could not download the model: ' + (lastErr?.message || 'unreachable'))
  }
  const total = Number(res.headers.get('content-length')) || 0

  const reader = res.body?.getReader()
  if (!reader) {
    const buf = new Uint8Array(await res.arrayBuffer())
    await storeModel(key, buf)
    return buf
  }
  const chunks = []
  let got = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    chunks.push(value)
    got += value.length
    if (total) onProgress?.(got / total)
  }
  const bytes = new Uint8Array(got)
  let at = 0
  for (const c of chunks) { bytes.set(c, at); at += c.length }
  await storeModel(key, bytes)
  return bytes
}
