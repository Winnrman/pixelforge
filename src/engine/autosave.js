// Crash/reload recovery. The document JSON is small, so it is rewritten on a
// debounce; media blobs are written once each and reused, which keeps the
// frequent write cheap even for a heavy GIF project.
//
// The same database also holds named projects (Save) and the media they share.
// Autosave itself is a safety net holding one session; the browser may evict it.

import { getAsset, loadImageBytes } from './assets.js'
import { usedAssets, remapAssets } from './project.js'

const DB_NAME = 'pixelforge'
const DB_VERSION = 3
const STATE = 'state'
const PROJECTS = 'projects'
const ASSETS = 'assets'
const BACKUPS = 'backups'
const KEY = 'current'

let dbPromise = null

function openDB() {
  if (dbPromise) return dbPromise
  dbPromise = new Promise((res, rej) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION)
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains(STATE)) db.createObjectStore(STATE)
      if (!db.objectStoreNames.contains(ASSETS)) db.createObjectStore(ASSETS)
      if (!db.objectStoreNames.contains(PROJECTS)) db.createObjectStore(PROJECTS)
      if (!db.objectStoreNames.contains(BACKUPS)) db.createObjectStore(BACKUPS)
    }
    req.onsuccess = () => res(req.result)
    req.onerror = () => rej(req.error)
  }).catch((err) => {
    dbPromise = null
    throw err
  })
  return dbPromise
}

function tx(db, store, mode, fn) {
  return new Promise((res, rej) => {
    const t = db.transaction(store, mode)
    const s = t.objectStore(store)
    let out
    try { out = fn(s) } catch (err) { rej(err); return }
    t.oncomplete = () => res(out?.result ?? out)
    t.onerror = () => rej(t.error)
    t.onabort = () => rej(t.error)
  })
}

const get = async (store, key) => {
  const db = await openDB()
  return new Promise((res, rej) => {
    const r = db.transaction(store, 'readonly').objectStore(store).get(key)
    r.onsuccess = () => res(r.result)
    r.onerror = () => rej(r.error)
  })
}

const put = async (store, key, value) => {
  const db = await openDB()
  return tx(db, store, 'readwrite', (s) => s.put(value, key))
}

const del = async (store, key) => {
  const db = await openDB()
  return tx(db, store, 'readwrite', (s) => s.delete(key))
}

const storedAssetIds = new Set()

export async function saveSnapshot(doc, time) {
  const assets = usedAssets(doc)
  for (const a of assets) {
    if (storedAssetIds.has(a.id)) continue
    await put(ASSETS, a.id, { blob: a.blob, name: a.name, type: a.type })
    storedAssetIds.add(a.id)
  }
  await put(STATE, KEY, {
    doc,
    time,
    savedAt: Date.now(),
    assetIds: assets.map((a) => a.id),
  })
}

export async function readSnapshot() {
  try {
    const snap = await get(STATE, KEY)
    // A project with media but no layers is the normal state right after
    // importing, and it is worth recovering. Requiring a layer here quietly
    // threw away everything in the media bin.
    const hasWork = snap?.doc && (snap.doc.layers?.length || snap.doc.media?.length)
    if (!hasWork) return null
    return snap
  } catch {
    return null // private windows, blocked storage, etc.
  }
}

/** Rebuilds a snapshot into a live document, re-registering its media. */
export async function restoreSnapshot(snap) {
  const idMap = new Map()
  for (const id of snap.assetIds || []) {
    if (getAsset(id)) { idMap.set(id, id); continue }
    const rec = await get(ASSETS, id)
    if (!rec?.blob) continue
    const bytes = new Uint8Array(await rec.blob.arrayBuffer())
    try {
      const asset = await loadImageBytes(bytes, rec.name || 'asset', rec.type)
      idMap.set(id, asset.id)
    } catch { /* skip media that no longer decodes */ }
  }
  // Shared with project files, so the bin cannot be forgotten in one path and
  // remembered in the other.
  return { doc: remapAssets(snap.doc, idMap), time: snap.time || 0 }
}

// ---------------------------------------------------------- saved projects
// Save keeps the project in this browser. Only Export writes a file to disk.

export async function writeProject(rec) {
  const assets = usedAssets(rec.doc)
  for (const a of assets) {
    if (storedAssetIds.has(a.id)) continue
    await put(ASSETS, a.id, { blob: a.blob, name: a.name, type: a.type })
    storedAssetIds.add(a.id)
  }
  const full = { ...rec, assetIds: assets.map((a) => a.id), savedAt: Date.now() }
  await put(PROJECTS, rec.id, full)
  return full
}

export async function listProjects() {
  try {
    const db = await openDB()
    return await new Promise((res, rej) => {
      const out = []
      const req = db.transaction(PROJECTS, 'readonly').objectStore(PROJECTS).openCursor()
      req.onsuccess = () => {
        const c = req.result
        if (!c) { res(out.sort((a, b) => b.savedAt - a.savedAt)); return }
        const v = c.value
        out.push({
          id: v.id,
          name: v.name,
          savedAt: v.savedAt,
          layers: v.doc?.layers?.length || 0,
          width: v.doc?.width,
          height: v.doc?.height,
          thumb: v.thumb || null,
        })
        c.continue()
      }
      req.onerror = () => rej(req.error)
    })
  } catch {
    return []
  }
}

export const readProject = (id) => get(PROJECTS, id)
export const deleteProject = (id) => del(PROJECTS, id)

export async function clearSnapshot() {
  // Only the recovery slot. Assets are shared with saved projects, so wiping
  // them here would quietly gut every project the user has kept.
  try { await del(STATE, KEY) } catch { /* nothing to clear */ }
}

/** Marks assets as already persisted, e.g. right after a restore. */
export function markAssetsStored(ids) {
  for (const id of ids) storedAssetIds.add(id)
}

export const autosaveAvailable = () => typeof indexedDB !== 'undefined'


// ---------------------------------------------------------- automatic backups
// The browser half of the backup ring. The desktop app writes real files
// instead; this exists so the safety net is not simply absent in a browser.
// Packed .pfz bytes are stored whole, assets included, so a backup restores
// without depending on anything else in the database still being there.

export async function putBackup(rec) {
  await put(BACKUPS, rec.id, rec)
  return rec
}

export async function allBackups() {
  try {
    const db = await openDB()
    return await new Promise((res, rej) => {
      const out = []
      const req = db.transaction(BACKUPS, 'readonly').objectStore(BACKUPS).openCursor()
      req.onsuccess = () => {
        const c = req.result
        if (!c) { res(out.sort((a, b) => b.at - a.at)); return }
        const v = c.value
        out.push({ id: v.id, name: v.name, reason: v.reason, at: v.at, size: v.blob?.size || 0 })
        c.continue()
      }
      req.onerror = () => rej(req.error)
    })
  } catch {
    return []
  }
}

export const readBackup = (id) => get(BACKUPS, id)
export const deleteBackup = (id) => del(BACKUPS, id)
