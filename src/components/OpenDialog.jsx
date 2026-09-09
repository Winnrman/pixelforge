import { useEffect, useRef, useState } from 'react'
import { useStore } from '../state/store.js'
import { Info } from './ui.jsx'

function Thumb({ blob }) {
  const [url, setUrl] = useState(null)
  useEffect(() => {
    if (!blob) return undefined
    const u = URL.createObjectURL(blob)
    setUrl(u)
    return () => URL.revokeObjectURL(u)
  }, [blob])
  return <span className="proj-thumb">{url && <img src={url} alt="" />}</span>
}

const AGO = (t) => {
  const m = Math.round((Date.now() - t) / 60000)
  if (m < 1) return 'just now'
  if (m < 60) return `${m} min ago`
  const h = Math.round(m / 60)
  if (h < 24) return `${h} hour${h === 1 ? '' : 's'} ago`
  return new Date(t).toLocaleString()
}

const SIZE = (n) => (n > 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.round(n / 1024)} KB`)

const WHY = { save: 'on save', export: 'on export', batch: 'on batch export' }

export default function OpenDialog({ onClose }) {
  const projects = useStore((s) => s.savedProjects)
  const refresh = useStore((s) => s.refreshSavedProjects)
  const backups = useStore((s) => s.backups)
  const refreshBackups = useStore((s) => s.refreshBackups)
  const restoreBackup = useStore((s) => s.restoreBackup)
  const [showBackups, setShowBackups] = useState(false)
  const openSaved = useStore((s) => s.openSavedProject)
  const openFile = useStore((s) => s.openProject)
  const deleteSaved = useStore((s) => s.deleteSavedProject)
  const currentId = useStore((s) => s.projectId)
  const dirty = useStore((s) => s.dirty)
  const fileRef = useRef(null)

  useEffect(() => { refresh(); refreshBackups() }, [refresh, refreshBackups])

  const guard = () => !dirty || confirm('You have unsaved changes. Discard them?')

  return (
    <div className="modal-backdrop" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal wide">
        <div className="modal-head">
          <h2>Open a project</h2>
          <button className="x" onClick={onClose}>✕</button>
        </div>

        <div className="modal-body">
          {!projects.length && (
            <p className="hint">
              Nothing saved in this browser yet.
              <Info>
                Press Save to keep a project here, or open a .pfz file you exported earlier.
              </Info>
            </p>
          )}

          <div className="proj-list">
            {projects.map((p) => (
              <div
                key={p.id}
                className={'proj' + (p.id === currentId ? ' current' : '')}
                onDoubleClick={() => { if (guard()) { openSaved(p.id); onClose() } }}
              >
                <Thumb blob={p.thumb} />
                <span className="proj-meta">
                  <b>{p.name}</b>
                  <small>
                    {p.width}×{p.height} · {p.layers} layer{p.layers === 1 ? '' : 's'} ·{' '}
                    {new Date(p.savedAt).toLocaleString()}
                  </small>
                </span>
                <span className="proj-actions">
                  <button
                    className="btn"
                    onClick={() => { if (guard()) { openSaved(p.id); onClose() } }}
                  >Open</button>
                  <button
                    className="btn ghost"
                    title="Delete this saved project"
                    onClick={() => {
                      if (confirm(`Delete "${p.name}" from this browser?`)) deleteSaved(p.id)
                    }}
                  >🗑</button>
                </span>
              </div>
            ))}
          </div>

          <div className="backups">
            <button
              className="btn ghost wide-btn"
              onClick={() => setShowBackups((v) => !v)}
            >
              {showBackups ? '▾' : '▸'} Automatic backups
              {backups.length > 0 && <span className="dim"> · {backups.length}</span>}
            </button>
            {showBackups && (
              <>
                <p className="hint">
                  Written on every save and every export.
                  <Info>
                    So an exported PNG is never the only copy. The most recent are kept;
                    older ones are dropped as new ones arrive.
                  </Info>
                </p>
                {!backups.length && <p className="hint">No backups yet.</p>}
                <div className="proj-list">
                  {backups.map((b) => (
                    <div key={b.id} className="proj">
                      <span className="proj-meta">
                        <b>{b.name}</b>
                        <small>
                          {AGO(b.at)} · {WHY[b.reason] || b.reason} · {SIZE(b.size)}
                        </small>
                      </span>
                      <span className="proj-actions">
                        <button
                          className="btn"
                          onClick={async () => {
                            if (!guard()) return
                            if (await restoreBackup(b)) onClose()
                          }}
                        >Recover</button>
                      </span>
                    </div>
                  ))}
                </div>
              </>
            )}
          </div>
        </div>

        <div className="modal-foot">
          <input
            ref={fileRef}
            className="pf-project-input"
            type="file"
            accept=".pfz,.zip,application/zip"
            hidden
            onChange={(e) => {
              const f = e.target.files?.[0]
              e.target.value = ''
              if (f && guard()) { openFile(f); onClose() }
            }}
          />
          <button className="btn ghost" onClick={() => fileRef.current.click()}>
            Open a .pfz file…
          </button>
          <div className="spacer" />
          <button className="btn ghost" onClick={onClose}>Cancel</button>
        </div>
      </div>
    </div>
  )
}
