import { useEffect, useRef, useState } from 'react'
import { useStore } from '../state/store.js'
import { exportPNG, exportGIF, exportWebM, exportMP4, audioCandidates } from '../engine/exporters.js'
import { sampleTimes } from '../engine/render.js'
import { runBatch, slotCandidates, FIT_MODES } from '../engine/batch.js'
import { isDesktop, openFiles, pickFolder, listFolder, readPath, revealItem, ffmpegStatus } from '../engine/desktop.js'
import { Row, Slider, Num, Select, Color, Segmented, Toggle, Info } from './ui.jsx'
import { UNITS, DPI_PRESETS, pxFor, sizeFor } from '../engine/dpi.js'

// Windows rejects \ / : * ? " < > | outright and the others are merely awkward
// in a filename, so they all become a dash rather than being silently dropped —
// a name that loses characters is harder to recognise than one with dashes in.
const safeName = (v) => v.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '-').replace(/^\.+/, '').slice(0, 120)

const EXT_FOR = {
  png: 'png', gif: 'gif', webm: 'webm', mp4: 'mp4', project: 'pfz',
}

export default function ExportDialog({ onClose }) {
  const doc = useStore((s) => s.doc)
  const duration = useStore((s) => s.duration)
  const markIn = useStore((s) => s.markIn)
  const markOut = useStore((s) => s.markOut)
  const marked = markIn != null || markOut != null
  const [ranged, setRanged] = useState(true)
  const from = marked && ranged ? (markIn ?? 0) : 0
  const to = marked && ranged ? (markOut ?? duration) : duration
  const time = useStore((s) => s.time)

  const [format, setFormat] = useState(duration > 0 ? 'gif' : 'png')
  const [scale, setScale] = useState(100)
  // Print sizing. Kept as a separate mode rather than a second way to drive the
  // same slider: at 300dpi a sticker is a four-figure percentage, which is not a
  // number anyone wants to reason about.
  const [sizeBy, setSizeBy] = useState('scale')
  const [dpi, setDpi] = useState(300)
  const [printW, setPrintW] = useState(100)
  const [printUnit, setPrintUnit] = useState('mm')
  const [fps, setFps] = useState(20)
  const [colors, setColors] = useState(256)
  const [transparent, setTransparent] = useState(doc.background === 'transparent')
  const [matte, setMatte] = useState('#000000')
  const downloadProject = useStore((s) => s.downloadProject)
  const backupNow = useStore((s) => s.backupNow)
  const projectName = useStore((s) => s.projectName)
  const setProjectName = useStore((s) => s.setProjectName)
  const [progress, setProgress] = useState(null)
  const [error, setError] = useState(null)
  const [stage, setStage] = useState(null)

  // Seeded from the project name, which is where the default "Untitled" comes
  // from. Kept separate afterwards so an export can be named something the
  // project is not — but see the checkbox below, which is the fix for the
  // actual problem: forgetting to rename and only noticing after the fact.
  const [baseName, setBaseName] = useState(() => safeName(projectName || 'Untitled'))
  const [renameProject, setRenameProject] = useState(true)
  const ext = EXT_FOR[format] || 'png'
  const filename = `${baseName.trim() || 'Untitled'}.${ext}`
  const looksUnnamed = /^untitled$/i.test(baseName.trim()) || !baseName.trim()

  // --- mp4 -----------------------------------------------------------------
  const [crf, setCrf] = useState(18)
  const [audioId, setAudioId] = useState('')
  const [ffmpeg, setFfmpeg] = useState(null)
  const audio = audioCandidates(doc)

  // Probed once when the dialog opens. Asking on every render would spawn a
  // process per keystroke, and the answer cannot change while it is open.
  useEffect(() => {
    let live = true
    ffmpegStatus().then((r) => live && setFfmpeg(r))
    return () => { live = false }
  }, [])

  // --- batch ---------------------------------------------------------------
  const slots = slotCandidates(doc)
  const [slotId, setSlotId] = useState(slots[0]?.id || '')
  const [fit, setFit] = useState('cover')
  const [batchFiles, setBatchFiles] = useState([])
  const [outDir, setOutDir] = useState(null)
  const [batchNote, setBatchNote] = useState(null)
  const batchInput = useRef(null)

  const pickBatchFolder = async () => {
    setError(null)
    const dir = await pickFolder()
    if (!dir) return
    const paths = await listFolder(dir)
    if (!paths.length) {
      setError('No images or video found in that folder.')
      return
    }
    setBatchFiles(await Promise.all(paths.map(readPath)))
    setBatchNote(`${paths.length} file${paths.length === 1 ? '' : 's'} from ${dir}`)
  }

  const pickBatchFiles = async () => {
    setError(null)
    if (isDesktop()) {
      const picked = await openFiles({ multi: true })
      if (picked?.length) {
        setBatchFiles(picked)
        setBatchNote(`${picked.length} file${picked.length === 1 ? '' : 's'} selected`)
      }
      return
    }
    batchInput.current?.click()
  }

  const runTheBatch = async () => {
    setError(null)
    setBatchNote(null)
    if (!slotId) { setError('Pick which layer the images replace.'); return }
    if (!batchFiles.length) { setError('Choose some images first.'); return }
    let dir = outDir
    if (isDesktop() && !dir) {
      dir = await pickFolder()
      if (!dir) return
      setOutDir(dir)
    }
    setProgress(0)
    try {
      const out = await runBatch({
        doc,
        slotId,
        files: batchFiles,
        outDir: dir,
        fit,
        format: format === 'batch-gif' ? 'gif' : 'png',
        scale: effScale,
        matte,
        transparent,
        colors,
        fps,
        onProgress: ({ i, n }) => setProgress(i / n),
      })
      backupNow('batch')
      setProgress(null)
      const parts = [`Wrote ${out.results.length} file${out.results.length === 1 ? '' : 's'}`]
      if (out.failures.length) parts.push(`${out.failures.length} failed`)
      if (dir) parts.push('to ' + dir)
      setBatchNote(parts.join(' \u00b7 '))
      if (out.failures.length) setError(out.failures.map((f) => `${f.name}: ${f.error}`).join(' | '))
      else if (dir) revealItem(dir)
      else onClose()
    } catch (err) {
      console.error(err)
      setError(err.message || String(err))
      setProgress(null)
    }
  }

  const isBatch = format === 'batch' || format === 'batch-gif'

  // In print mode the physical width and the resolution decide the pixel count,
  // and the scale is whatever gets there — the reverse of the usual direction.
  const printPx = pxFor(printW, printUnit, dpi)
  const effScale = sizeBy === 'print' ? printPx / doc.width : scale / 100
  const ow = Math.max(1, Math.round(doc.width * effScale))
  const oh = Math.max(1, Math.round(doc.height * effScale))
  const printH = sizeFor(oh, printUnit, dpi)
  const stampDpi = sizeBy === 'print' ? dpi : 0
  const planAll = duration > 0 ? sampleTimes(doc, duration, fps) : { times: [0], exact: true }
  const plan = duration > 0 && marked && ranged
    ? { ...planAll, times: planAll.times.filter((t) => t >= from && t < to) }
    : planAll

  const run = async () => {
    if (isBatch) return runTheBatch()
    setError(null)
    setProgress(0)
    try {
      const s = effScale
      // One name, applied to whichever encoder runs. Renaming the project at the
      // same time is what stops the next export being Untitled as well.
      if (renameProject && baseName.trim() && baseName.trim() !== projectName) {
        setProjectName(baseName.trim())
      }
      if (format === 'project') {
        await downloadProject(baseName.trim())
      } else if (format === 'png') {
        await exportPNG(doc, time, {
          scale: s, matte: transparent ? null : matte, filename, dpi: stampDpi,
        })
      } else if (format === 'gif') {
        await exportGIF(doc, { fps, scale: s, transparent, matte, colors, filename, from, to }, setProgress)
      } else if (format === 'mp4') {
        const out = await exportMP4(doc, {
          fps, scale: s, crf, matte, audioAssetId: audioId || null, filename, from, to,
        }, (p, info) => {
          setProgress(p)
          setStage(info ? `frame ${info.rendered} of ${info.total}` +
            (info.encoded ? ` · ${info.encoded} encoded` : '') : null)
        })
        setStage(null)
        if (out.cancelled) { setProgress(null); return }
        if (out.path) revealItem(out.path)
      } else {
        await exportWebM(doc, { fps: Math.max(fps, 24), scale: s, filename, from, to }, setProgress)
      }
      // Every export also stashes the editable project, so a PNG on disk is
      // never the only copy of the work that made it.
      backupNow('export')
      setProgress(null)
      onClose()
    } catch (err) {
      console.error(err)
      setError(err.message || String(err))
      setProgress(null)
      setStage(null)
    }
  }

  return (
    <div className="modal-backdrop" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal">
        <div className="modal-head">
          <h2>Export</h2>
          <button className="x" onClick={onClose}>✕</button>
        </div>

        <div className="modal-body">
          {!isBatch && (
            <>
              <Row label="File name">
                <span className="filename-field">
                  <input
                    className="filename"
                    value={baseName}
                    spellCheck={false}
                    placeholder="Untitled"
                    onChange={(e) => setBaseName(safeName(e.target.value))}
                    onFocus={(e) => e.target.select()}
                  />
                  <span className="filename-ext">.{ext}</span>
                </span>
              </Row>
              {looksUnnamed && (
                <p className="hint warn">
                  This will be saved as <b>{filename}</b>. Give it a name here and you will
                  not have to find it again later.
                </p>
              )}
              <Row label="">
                <label className="checkline">
                  <input
                    type="checkbox"
                    checked={renameProject}
                    onChange={(e) => setRenameProject(e.target.checked)}
                  />
                  <span>Rename the project to match</span>
                </label>
              </Row>
            </>
          )}

          <Row label="Format">
            <Segmented
              value={format}
              onChange={setFormat}
              options={[
                { value: 'png', label: 'PNG' },
                { value: 'gif', label: 'GIF' },
                { value: 'mp4', label: 'MP4' },
                { value: 'webm', label: 'WebM' },
                { value: 'project', label: 'Project' },
                { value: 'batch', label: 'Batch' },
              ]}
            />
          </Row>

          {isBatch && (
            <>
              <Row
                label="Replace layer"
                info={'Batch applies this document to a whole folder. One image layer is the '
                  + 'slot; everything else — overlays, text, effects, the cutout, the '
                  + 'palette — is kept exactly as it is now.'}
              >
                <Select
                  value={slotId}
                  onChange={setSlotId}
                  options={slots.map((sl) => ({ value: sl.id, label: sl.name }))}
                />
              </Row>
              <Row label="Fit">
                <Select value={fit} onChange={setFit} options={FIT_MODES} />
              </Row>
              <Row label="Write">
                <Segmented
                  value={format}
                  onChange={setFormat}
                  options={[{ value: 'batch', label: 'PNG each' }, { value: 'batch-gif', label: 'GIF each' }]}
                />
              </Row>
              <Row label="Images">
                <span className="btn-group">
                  <button className="btn ghost" onClick={pickBatchFiles}>Choose files…</button>
                  {isDesktop() && (
                    <button className="btn ghost" onClick={pickBatchFolder}>Whole folder…</button>
                  )}
                </span>
              </Row>
              <input
                ref={batchInput}
                type="file"
                accept="image/*,video/mp4"
                multiple
                style={{ display: 'none' }}
                onChange={(e) => {
                  const picked = [...e.target.files]
                  setBatchFiles(picked)
                  setBatchNote(`${picked.length} file${picked.length === 1 ? '' : 's'} selected`)
                }}
              />
              {batchNote && <p className="hint">{batchNote}</p>}
              {!slots.length && <p className="hint warn">This document has no image layer to swap.</p>}
              {!isDesktop() && (
                <p className="hint">
                  Results come back as one zip.
                  <Info>
                    The browser cannot write into a folder. The desktop build writes them
                    straight to disk.
                  </Info>
                </p>
              )}
            </>
          )}

          {format === 'project' && (
            <p className="hint">
              Writes <b>{filename}</b>.
              <Info>
                The editable project, with every layer, keyframe and original media file
                inside. Reopen it with Open Existing.
              </Info>
            </p>
          )}

          {format !== 'project' && (
            <>
              <Row label="Size by">
                <Segmented
                  value={sizeBy}
                  onChange={setSizeBy}
                  options={[
                    { value: 'scale', label: 'Scale' },
                    { value: 'print', label: 'Print size' },
                  ]}
                />
              </Row>
              {sizeBy === 'scale' ? (
                <Row label="Scale">
                  <Slider value={scale} min={5} max={200} onChange={setScale} suffix="%" />
                </Row>
              ) : (
                <>
                  <Row label="Width">
                    <Num value={printW} min={1} step={1}
                      onChange={(v) => setPrintW(Math.max(1, v))} />
                    <Select
                      value={printUnit}
                      onChange={setPrintUnit}
                      options={UNITS.map((u) => ({ value: u.id, label: u.label }))}
                    />
                  </Row>
                  <Row label="Resolution">
                    <Select
                      value={String(dpi)}
                      onChange={(v) => setDpi(Number(v))}
                      options={DPI_PRESETS.map((d) => ({ value: String(d.dpi), label: d.label }))}
                    />
                  </Row>
                  <Row label="Height">
                    <span className="readout">
                      {printH.toFixed(printUnit === 'in' ? 2 : 1)} {printUnit}
                    </span>
                  </Row>
                </>
              )}
              <Row label="Output">
                <span className="readout">
                  {isBatch && fit === 'native' ? 'each image at its own size' : `${ow} × ${oh} px`}
                </span>
              </Row>
              {sizeBy === 'print' && format === 'png' && (
                <p className="hint">
                  Prints at {printW}{printUnit}.
                  <Info>
                    The resolution is written into the PNG itself, rather than leaving a
                    print pipeline to assume one when the file does not say. Formats other
                    than PNG carry no such field and come out as pixels only.
                  </Info>
                </p>
              )}
            </>
          )}

          {format === 'png' && duration > 0 && (
            <p className="hint">Exports the frame currently on the playhead ({(time / 1000).toFixed(2)}s).</p>
          )}

          {format !== 'png' && !isBatch && marked && (
            <Row
              label="Range"
              info={'You have marked a range on the transport bar. Exporting it writes only '
                + 'that stretch — the way you pull one clip out of a longer edit without '
                + 'rendering the whole thing and trimming it afterwards.'}
            >
              <Segmented
                value={ranged ? 'marked' : 'all'}
                onChange={(v) => setRanged(v === 'marked')}
                options={[
                  { value: 'marked', label: `Marked · ${((to - from) / 1000).toFixed(2)}s` },
                  { value: 'all', label: `Whole · ${(duration / 1000).toFixed(2)}s` },
                ]}
              />
            </Row>
          )}
          {format !== 'png' && !isBatch && duration <= 0 && (
            <p className="hint warn">Nothing in this document animates — add a GIF to export motion.</p>
          )}

          {(format === 'gif' || format === 'batch-gif') && (
            <>
              <Row label="Colors">
                <Select
                  value={String(colors)}
                  onChange={(v) => setColors(Number(v))}
                  options={[256, 128, 64, 32, 16].map((n) => ({ value: String(n), label: `${n} colors` }))}
                />
              </Row>
              <Row label="Transparency">
                <Toggle value={transparent} onChange={setTransparent}>
                  {transparent ? 'Keep alpha (1-bit)' : 'Flatten onto matte'}
                </Toggle>
              </Row>
              {!transparent && (
                <Row label="Matte"><Color value={matte} onChange={setMatte} /></Row>
              )}
              {!plan.exact && (
                <Row label="Frame rate">
                  <Slider value={fps} min={5} max={50} onChange={setFps} suffix="fps" />
                </Row>
              )}
              <Row label="Frames">
                <span className="readout">
                  {plan.times.length}
                  <span className="dim">
                    {plan.exact ? ' · original GIF timing preserved' : ' · resampled at fixed fps'}
                  </span>
                </span>
              </Row>
            </>
          )}

          {format === 'mp4' && (
            <>
              {!isDesktop() && (
                <p className="hint warn">
                  MP4 needs the desktop build — or export WebM.
                  <Info>
                    MP4 export runs a local ffmpeg, which the browser cannot do. WebM is the
                    one the browser can record itself.
                  </Info>
                </p>
              )}
              {isDesktop() && ffmpeg && !ffmpeg.ok && (
                <p className="hint warn">
                  No ffmpeg found.
                  <Info>
                    Install it and put it on PATH, or point PF_FFMPEG at the binary, then
                    reopen this dialog.
                  </Info>
                </p>
              )}
              {isDesktop() && ffmpeg?.ok && (
                <p className="hint">Encoding with <b>{ffmpeg.version?.replace(/^ffmpeg version /, '') || ffmpeg.path}</b>.</p>
              )}
              <Row label="Frame rate">
                <Slider value={fps} min={12} max={60} onChange={setFps} suffix="fps" />
              </Row>
              <Row
                label="Quality"
                info={"Lower is better. 18 is visually lossless, 23 is a sensible default "
                  + "for sharing, above 28 starts to show. This is x264's CRF, so the file "
                  + 'size follows the footage rather than a fixed bitrate.'}
              >
                <Slider value={crf} min={14} max={32} onChange={setCrf} />
              </Row>
              {audio.length > 0 && (
                <Row label="Audio">
                  <Select
                    value={audioId}
                    onChange={setAudioId}
                    options={[
                      { value: '', label: 'None (silent)' },
                      ...audio.map((a) => ({
                        value: a.assetId,
                        label: a.retimed ? `${a.name} — retimed, would drift` : `Keep audio from ${a.name}`,
                      })),
                    ]}
                  />
                </Row>
              )}
              {audio.some((a) => a.retimed && a.assetId === audioId) && (
                <p className="hint warn">
                  That audio will drift.
                  <Info>
                    The layer has been retimed or loop-repaired, so its original sound no
                    longer lines up with the picture. It is muxed in unchanged.
                  </Info>
                </p>
              )}
              <p className="hint">
                Sampled every {(1000 / fps).toFixed(1)}ms.
                <Info>
                  MP4 is constant frame rate; GIF is the export that keeps original
                  per-frame timing. H.264 has no alpha either, so a transparent document is
                  flattened onto the matte.
                </Info>
              </p>
              {transparent && <Row label="Matte"><Color value={matte} onChange={setMatte} /></Row>}
            </>
          )}

          {format === 'webm' && (
            <>
              <Row label="Frame rate">
                <Slider value={fps} min={12} max={60} onChange={setFps} suffix="fps" />
              </Row>
              <p className="hint">
                WebM is captured in real time, so recording takes about {(duration / 1000).toFixed(1)}s.
              </p>
            </>
          )}

          {error && <p className="hint warn">{error}</p>}
          {progress !== null && (
            <>
              <div className="progress"><div style={{ width: `${Math.round(progress * 100)}%` }} /></div>
              {stage && <p className="hint">{stage}</p>}
            </>
          )}
        </div>

        <div className="modal-foot">
          <button className="btn ghost" onClick={onClose}>Cancel</button>
          <button
            className="btn primary"
            onClick={run}
            disabled={progress !== null || (format === 'mp4' && (!isDesktop() || (ffmpeg && !ffmpeg.ok)))}
          >
            {progress !== null
              ? `Rendering ${Math.round(progress * 100)}%`
              : isBatch
                ? `Apply to ${batchFiles.length || '\u2026'} file${batchFiles.length === 1 ? '' : 's'}`
                : `Export ${filename}`}
          </button>
        </div>
      </div>
    </div>
  )
}
