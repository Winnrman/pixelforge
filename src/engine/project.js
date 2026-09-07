// Project files: a plain ZIP holding the editable document plus every original
// media file, byte for byte.
//
//   project.json      document, layers, keyframe tracks, asset manifest
//   assets/<id>.<ext> the exact bytes that were imported
//
// Storing originals rather than decoded frames keeps the file small and the
// round-trip lossless, and means you can just unzip it to get your media back.

import { zip, unzip, strToU8, strFromU8 } from 'fflate'
import { getAsset, loadImageBytes } from './assets.js'
import { renderDocument } from './render.js'

export const PROJECT_FORMAT = 'pixelforge-project'
export const PROJECT_VERSION = 1
export const PROJECT_EXT = '.pfz'

const EXT_BY_TYPE = {
  'image/gif': 'gif',
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/avif': 'avif',
  'image/bmp': 'bmp',
}

const extFor = (asset) => {
  const fromName = /\.([a-z0-9]+)$/i.exec(asset.name || '')?.[1]?.toLowerCase()
  return EXT_BY_TYPE[asset.type] || fromName || 'bin'
}

const safeId = (id) => String(id).replace(/[^a-zA-Z0-9_-]/g, '_')

/** Assets actually referenced by the document, so deleted layers do not bloat the file. */
export function usedAssets(doc) {
  const out = []
  const seen = new Set()
  // The media bin counts as a reference. Something imported but not yet placed
  // is still the user's material, and dropping it on save would quietly lose
  // work they can see on screen.
  const ids = [
    ...doc.layers.filter((l) => l.type === 'image' && l.assetId).map((l) => l.assetId),
    ...(doc.media || []),
  ]
  for (const id of ids) {
    if (seen.has(id)) continue
    const a = getAsset(id)
    if (!a?.blob) continue
    seen.add(id)
    out.push(a)
  }
  return out
}

/**
 * Re-points a document at assets that have just been re-imported.
 *
 * Reopening anything gives every asset a fresh id, so the layers *and* the media
 * bin have to be remapped. This lives in one place because it did not used to:
 * project files remapped both while autosave remapped only the layers, and the
 * bin came back pointing at ids from the session that saved it.
 */
export function remapAssets(doc, idMap) {
  const layers = []
  for (const l of doc.layers) {
    if (l.type === 'image') {
      // A layer whose media could not be restored is dropped rather than left
      // pointing at nothing.
      const mapped = idMap.get(l.assetId)
      if (!mapped) continue
      layers.push({ ...l, assetId: mapped })
    } else {
      layers.push(l)
    }
  }
  const media = (doc.media || []).map((id) => idMap.get(id)).filter(Boolean)
  return { ...doc, layers, media }
}

export async function thumbnailBytes(doc, time) {
  try {
    const scale = Math.min(1, 480 / Math.max(doc.width, doc.height))
    const src = document.createElement('canvas')
    src.width = doc.width
    src.height = doc.height
    renderDocument(src.getContext('2d'), doc, time)
    const out = document.createElement('canvas')
    out.width = Math.max(1, Math.round(doc.width * scale))
    out.height = Math.max(1, Math.round(doc.height * scale))
    const c = out.getContext('2d')
    c.fillStyle = '#16161b'
    c.fillRect(0, 0, out.width, out.height)
    c.drawImage(src, 0, 0, out.width, out.height)
    const blob = await new Promise((r) => out.toBlob(r, 'image/png'))
    return new Uint8Array(await blob.arrayBuffer())
  } catch {
    return null // a preview is a nicety, never a reason to fail a save
  }
}

/** Serialises the document and its media into a .pfz Blob. */
export async function packProject(doc, { time = 0, name = 'Untitled' } = {}) {
  const assets = usedAssets(doc)
  const files = {}
  const manifest = []

  for (const a of assets) {
    const path = `assets/${safeId(a.id)}.${extFor(a)}`
    files[path] = [new Uint8Array(await a.blob.arrayBuffer()), { level: 0 }] // media is already compressed
    manifest.push({ id: a.id, name: a.name, type: a.type, file: path })
  }

  const meta = {
    format: PROJECT_FORMAT,
    version: PROJECT_VERSION,
    app: 'PixelForge',
    name,
    savedAt: new Date().toISOString(),
    playback: { time },
    doc,
    assets: manifest,
  }
  files['project.json'] = [strToU8(JSON.stringify(meta, null, 2)), { level: 6 }]

  const thumb = await thumbnailBytes(doc, time)
  if (thumb) files['thumbnail.png'] = [thumb, { level: 0 }]

  const packed = await new Promise((res, rej) =>
    zip(files, (err, data) => (err ? rej(err) : res(data))))
  return new Blob([packed], { type: 'application/zip' })
}

/**
 * Reads a .pfz back. Assets are re-imported through the normal decode path and
 * get fresh ids, which are then remapped onto the layers — so opening a project
 * can never collide with assets already loaded in this session.
 */
export async function unpackProject(file) {
  const bytes = new Uint8Array(await file.arrayBuffer())
  const entries = await new Promise((res, rej) =>
    unzip(bytes, (err, data) => (err ? rej(err) : res(data))))

  if (!entries['project.json']) {
    throw new Error('Not a PixelForge project (no project.json inside)')
  }

  let meta
  try {
    meta = JSON.parse(strFromU8(entries['project.json']))
  } catch {
    throw new Error('project.json is corrupt')
  }
  if (meta.format !== PROJECT_FORMAT) throw new Error('Not a PixelForge project file')
  if (meta.version > PROJECT_VERSION) {
    throw new Error(`This project was saved by a newer version (v${meta.version})`)
  }
  if (!meta.doc?.layers) throw new Error('Project contains no document')

  const idMap = new Map()
  const missing = []
  for (const entry of meta.assets || []) {
    const data = entries[entry.file]
    if (!data) { missing.push(entry.name || entry.file); continue }
    try {
      const asset = await loadImageBytes(data, entry.name || 'asset', entry.type)
      idMap.set(entry.id, asset.id)
    } catch {
      missing.push(entry.name || entry.file)
    }
  }

  return {
    doc: remapAssets(meta.doc, idMap),
    time: meta.playback?.time || 0,
    name: meta.name || 'Untitled',
    savedAt: meta.savedAt,
    missing,
  }
}

export const isProjectFile = (file) =>
  /\.(pfz|zip)$/i.test(file.name) ||
  file.type === 'application/zip' ||
  file.type === 'application/x-zip-compressed'
