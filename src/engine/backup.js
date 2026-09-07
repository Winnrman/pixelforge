// Automatic project backups.
//
// The problem this solves: exporting a PNG or an MP4 throws the editable
// document away. You end up with the picture and no way back to the layers that
// made it. So every save and every export also quietly writes a real .pfz —
// assets and all — into the app's own data folder, kept as a ring of the most
// recent.
//
// It is deliberately not the same thing as autosave. Autosave holds one
// snapshot of the current session for crash recovery; this holds a history of
// deliberate moments, and it survives the session that made it.
import { packProject, unpackProject, PROJECT_EXT } from './project.js'
import { isDesktop } from './desktop.js'
import { putBackup, allBackups, readBackup, deleteBackup } from './autosave.js'

const bridge = typeof window !== 'undefined' ? window.pixelforge : null
const desk = () => (isDesktop() && bridge?.backup ? bridge.backup : null)

/** How many the browser half keeps. The desktop half prunes in the main
 *  process, where it can do it by filename without loading anything. */
export const BROWSER_KEEP = 15

export const backupsAvailable = () => !!desk() || typeof indexedDB !== 'undefined'

/**
 * A cheap content hash, so saving twice without touching anything does not
 * write the same project again. FNV-1a over the document JSON — the document
 * carries asset *ids*, not asset bytes, so this stays small and fast.
 */
function signature(doc) {
  const str = JSON.stringify(doc)
  let h = 0x811c9dc5
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return `${str.length}:${(h >>> 0).toString(36)}`
}

let lastSig = null

/** Forget the last signature, so the next backup is written even if the
 *  document is unchanged. Used when a different project is opened. */
export const resetBackupState = () => { lastSig = null }

/**
 * Writes a backup, unless the document is byte-for-byte what was backed up
 * last time.
 *
 * Never throws: a failed backup must not be able to fail the save or the export
 * that triggered it. Returns what happened so a caller can say so if it wants.
 */
export async function writeBackup(doc, { time = 0, name = 'Untitled', reason = 'save' } = {}) {
  if (!doc?.layers?.length) return { ok: false, skipped: 'empty' }
  const sig = signature(doc)
  if (sig === lastSig) return { ok: false, skipped: 'unchanged' }
  try {
    const blob = await packProject(doc, { time, name })
    const d = desk()
    if (d) {
      const bytes = new Uint8Array(await blob.arrayBuffer())
      const file = await d.write(bytes, name, reason)
      lastSig = sig
      return { ok: true, where: file }
    }
    const id = `b_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`
    await putBackup({ id, name, reason, at: Date.now(), blob })
    const all = await allBackups()
    for (const old of all.slice(BROWSER_KEEP)) await deleteBackup(old.id).catch(() => {})
    lastSig = sig
    return { ok: true, where: 'this browser' }
  } catch (err) {
    console.warn('[pixelforge] backup failed', err)
    return { ok: false, error: err.message }
  }
}

/** Most recent first. `{ id, name, reason, at, size }`. */
export async function listBackups() {
  const d = desk()
  if (d) {
    try { return await d.list() } catch { return [] }
  }
  return allBackups()
}

/** The stored .pfz as a File, ready for `unpackProject`. */
export async function backupFile(entry) {
  const d = desk()
  if (d) {
    const bytes = await d.read(entry.id)
    return new File([bytes], (entry.name || 'backup') + PROJECT_EXT,
      { type: 'application/zip' })
  }
  const rec = await readBackup(entry.id)
  if (!rec?.blob) throw new Error('That backup is no longer stored')
  return new File([rec.blob], (entry.name || 'backup') + PROJECT_EXT,
    { type: 'application/zip' })
}

/** Unpacks a backup into `{ doc, time, name }`. */
export async function openBackup(entry) {
  return unpackProject(await backupFile(entry))
}

/** Where the desktop app keeps them, for a Reveal button. Null in a browser. */
export async function backupFolder() {
  const d = desk()
  if (!d) return null
  try { return await d.dir() } catch { return null }
}
