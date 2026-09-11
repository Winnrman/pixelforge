import { useEffect, useRef } from 'react'
import { useStore } from '../state/store.js'
import { EFFECTS, applyEffectLayer } from '../engine/effects.js'
import { renderDocument } from '../engine/render.js'
import { isCutOut } from '../engine/subject.js'
import { TOOLS, keyHint } from '../engine/tools.js'
import { INPAINT_MODEL } from '../engine/inpaint.js'
import { previewFit, fitLabel } from '../engine/brush.js'
import { resolveLayer } from '../engine/keyframes.js'
import { Row, Select, Slider, Segmented, Toggle, Info } from './ui.jsx'


const SHAPES = [
  // A rectangle first, and as the default: it is what most overlays and most
  // shapes actually are, and the one that needs the fewest words to describe.
  { value: 'rect', label: '■', title: 'Rectangle' },
  { value: 'ellipse', label: '●', title: 'Ellipse' },
  { value: 'triangle', label: '▲', title: 'Triangle' },
  { value: 'diamond', label: '◆', title: 'Diamond' },
  { value: 'star', label: '★', title: 'Star' },
]

function PixelIcon() {
  return (
    <svg viewBox="0 0 24 24" width="20" height="20">
      <defs>
        <clipPath id="pf-circ"><circle cx="12" cy="12" r="9" /></clipPath>
      </defs>
      <g clipPath="url(#pf-circ)">
        {[0, 1, 2, 3, 4, 5].map((r) =>
          [0, 1, 2, 3, 4, 5].map((c) => (
            <rect
              key={`${r}-${c}`}
              x={c * 4}
              y={r * 4}
              width="4"
              height="4"
              fill="currentColor"
              opacity={0.18 + ((r * 7 + c * 5) % 5) * 0.17}
            />
          )))}
      </g>
      <circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  )
}

/**
 * The brush, life-size, above the sliders that set it.
 *
 * A brush is a fraction of the layer width rather than a number of pixels, which
 * is what keeps a stroke the same size on the picture at any zoom — and which
 * makes "6%" a number you cannot picture. The ring on the canvas answers that
 * once the pointer is out over the artwork; this answers it while your hand is
 * still on the slider, which is when you are deciding.
 *
 * It is drawn by the same arithmetic that lays a stroke down, so the softness
 * you see here is the softness you get. Both sliders feed it: size is the
 * diameter, hardness is the falloff, and there is one picture rather than two
 * because there is one brush.
 */
function BrushPreview({ brush, warm = false }) {
  const ref = useRef(null)
  const zoom = useStore((s) => s.view.zoom)
  // What the brush is a fraction *of*, resolved at the playhead so an animated
  // layer previews the width it has now. A number, so this re-renders when that
  // width changes and not when anything else does.
  //
  // The same order `eraseTarget` uses to decide where a stroke lands: the
  // selection, then whatever is on top. Painting has never needed a layer
  // selected — the tool takes what is under the pointer — so a preview that
  // demanded one was refusing to answer a question the tool answers happily.
  // With nothing on the canvas at all it falls back to the document, which is
  // still a picture the brush would be a share of. There is always an answer.
  const layerW = useStore((s) => {
    const paints = (l) => !l.locked && l.type !== 'group' && l.type !== 'effect'
    const sel = s.doc.layers.filter((l) => s.selectedIds.includes(l.id) && paints(l))
    const top = [...s.doc.layers].reverse().find((l) => l.visible !== false && paints(l))
    const l = sel[sel.length - 1] || top
    return l ? Math.abs(resolveLayer(l, s.time).w) : s.doc.width
  })

  // Tall enough that an ordinary brush is life-size rather than fitted: the
  // shorter box this started as hit its limit at about 30px of picture, which
  // is a brush people use constantly.
  const box = { w: 188, h: 140 }
  const fit = previewFit(brush, layerW, zoom, box)
  const scaled = fitLabel(fit.fit)

  useEffect(() => {
    const c = ref.current
    if (!c) return
    const dpr = window.devicePixelRatio || 1
    c.width = Math.round(box.w * dpr)
    c.height = Math.round(box.h * dpr)
    const ctx = c.getContext('2d')
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, box.w, box.h)
    const cx = box.w / 2
    const cy = box.h / 2

    // The extent first, as a faint ring: a very soft brush fades out long
    // before its edge, and without this there is no telling how far it reaches.
    ctx.save()
    ctx.globalAlpha = 0.35
    ctx.strokeStyle = '#fff'
    ctx.lineWidth = 1
    ctx.setLineDash([3, 3])
    ctx.beginPath()
    ctx.arc(cx, cy, Math.max(1, fit.drawn.width / 2), 0, Math.PI * 2)
    ctx.stroke()
    ctx.restore()

    // Then the brush itself, blurred exactly as a stroke of it would be.
    ctx.save()
    ctx.filter = fit.drawn.soft > 0.4 ? `blur(${fit.drawn.soft.toFixed(2)}px)` : 'none'
    ctx.fillStyle = warm ? '#4ade80' : '#fff'
    ctx.beginPath()
    ctx.arc(cx, cy, fit.drawn.radius, 0, Math.PI * 2)
    ctx.fill()
    ctx.restore()
  }, [brush?.size, brush?.hardness, zoom, layerW, warm, fit.drawn.radius, fit.drawn.soft,
    fit.drawn.width, box.w, box.h])

  return (
    <div className="brush-preview">
      <canvas ref={ref} style={{ width: box.w, height: box.h }} />
      <span className="brush-size">
        {fit.px} px
        {scaled && <em>{scaled}</em>}
      </span>
    </div>
  )
}

/**
 * What this overlay will actually do, on this picture.
 *
 * A pixel size is a number of document pixels, which tells you nothing about how
 * coarse the blocks will look over the photograph in front of you — and the only
 * way to find out was to draw an overlay, look, undo, and change the number. So
 * the middle of the canvas is borrowed, the effect is run over it with exactly
 * the settings in the panel, and the shape is the shape that is armed, which
 * puts the feather on an edge where it can be seen.
 *
 * The picture is rendered once and kept; only the effect is re-run as the
 * sliders move, because re-rendering the document on every tick of a slider is
 * how a panel starts to feel heavy.
 */
function EffectPreview({ o }) {
  const ref = useRef(null)
  const sample = useRef(null)
  const zoom = useStore((s) => s.view.zoom)
  // What the sample is of. A number of layers and an instant is enough: it is a
  // thumbnail of the middle of the canvas, not a second viewport.
  const docKey = useStore((s) => `${s.doc.width}x${s.doc.height}:${s.doc.layers.length}`)
  const box = { w: 188, h: 116 }

  useEffect(() => {
    const c = ref.current
    if (!c) return
    const dpr = Math.min(2, window.devicePixelRatio || 1)
    c.width = Math.round(box.w * dpr)
    c.height = Math.round(box.h * dpr)

    // The picture, once.
    if (!sample.current) sample.current = document.createElement('canvas')
    const src = sample.current
    src.width = c.width
    src.height = c.height
    const sc = src.getContext('2d')
    sc.setTransform(1, 0, 0, 1, 0, 0)
    const st = useStore.getState()
    const doc = st.doc
    if (doc.layers.length) {
      const full = document.createElement('canvas')
      full.width = doc.width
      full.height = doc.height
      renderDocument(full.getContext('2d'), doc, st.time)
      // The middle of the canvas at the zoom you are working at, so the blocks
      // are the size they will be on screen.
      const k = zoom * dpr
      const cw = Math.min(doc.width, c.width / k)
      const ch = Math.min(doc.height, c.height / k)
      sc.fillStyle = '#15151a'
      sc.fillRect(0, 0, c.width, c.height)
      sc.drawImage(full, (doc.width - cw) / 2, (doc.height - ch) / 2, cw, ch,
        0, 0, cw * k, ch * k)
    } else {
      // Nothing on the canvas yet, so something with enough detail in it to
      // show what a block size does.
      for (let i = 0; i < 22; i++) {
        sc.fillStyle = `hsl(${(i * 37) % 360} 62% ${34 + (i % 5) * 9}%)`
        sc.fillRect((i * 37) % c.width, 0, 18, c.height)
        sc.fillStyle = `hsl(${(i * 71) % 360} 55% ${60 - (i % 4) * 11}%)`
        sc.fillRect(0, (i * 23) % c.height, c.width, 7)
      }
    }

    const ctx = c.getContext('2d')
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.clearRect(0, 0, c.width, c.height)
    ctx.drawImage(src, 0, 0)
    // The shape that is armed, centred, big enough to leave the picture showing
    // round it — the effect against what it replaced is the comparison.
    const pad = 12 * dpr
    applyEffectLayer(ctx, src, {
      type: 'effect',
      shape: o.shape,
      effect: o.effect,
      pixelSize: Math.max(1, (o.pixelSize || 12) * zoom * dpr),
      blurRadius: (o.blurRadius || 0) * zoom * dpr,
      feather: (o.feather || 0) * zoom * dpr,
      x: pad,
      y: pad,
      w: c.width - pad * 2,
      h: c.height - pad * 2,
      rotation: 0,
      opacity: 1,
    })
  }, [docKey, zoom, o.effect, o.shape, o.pixelSize, o.blurRadius, o.feather, box.w, box.h])

  return (
    <div className="fx-preview">
      <canvas ref={ref} style={{ width: box.w, height: box.h }} />
    </div>
  )
}

/**
 * The magic eraser's options: a size, and what the model is doing.
 *
 * One slider. The tool decides the rest for itself — which pixels under the
 * brush are the text, how far to grow the hole round them, whether the model
 * or the surrounding pixels do the filling — because every one of those is a
 * question with a right answer that depends on the picture, not on taste.
 */
function HealPanel() {
  const heal = useStore((s) => s.toolOptions.heal) || { size: 0.045 }
  const setToolOptions = useStore((s) => s.setToolOptions)
  const work = useStore((s) => s.healWork)
  const ai = useStore((s) => s.healAi)

  let hint = 'Paint over it and let go. One stroke is one undo.'
  if (work?.phase === 'download') {
    hint = `Fetching the model (${INPAINT_MODEL.size}, once)… ${Math.round((work.progress || 0) * 100)}%`
  } else if (work?.phase === 'running') {
    hint = 'Estimating what was behind it…'
  } else if (work?.phase === 'matching') {
    hint = 'Rebuilding it from the picture around it…'
  } else if (ai === false) {
    hint = 'Filling from the surrounding picture — the model could not be loaded.'
  }

  return (
    <div className="rail-options">
      <div className="rail-opt-label">
        Magic eraser
        <Info>
          Paint over text, a logo or a blemish and let go: it is replaced by what was probably
          behind it. Colours under the brush that are not around it are taken to be the text, so
          the background between the letters is kept rather than guessed. The first stroke fetches
          a {INPAINT_MODEL.size} model ({INPAINT_MODEL.name}, {INPAINT_MODEL.licence}) that runs on
          this machine — nothing is uploaded. Until it arrives, and whenever it cannot, the fill
          comes from the surrounding pixels. The fill belongs to the picture, so cropping,
          flipping or resizing the layer keeps it in place.
        </Info>
      </div>
      <BrushPreview brush={{ size: heal.size, hardness: 1 }} />
      <Row label="Brush">
        <Slider
          value={Math.round((heal.size ?? 0.045) * 100)}
          min={1} max={30} suffix="%"
          onChange={(v) => setToolOptions({ heal: { ...heal, size: v / 100 } })}
        />
      </Row>
      <p className="rail-hint">{hint}</p>
    </div>
  )
}

export default function ToolRail() {
  const tool = useStore((s) => s.tool)
  const setTool = useStore((s) => s.setTool)
  const o = useStore((s) => s.toolOptions)
  const setToolOptions = useStore((s) => s.setToolOptions)
  const cloneSource = useStore((s) => s.cloneSource)
  // Named rather than described, so the hint says which picture will be cropped
  // rather than leaving you to work it out from the selection.
  const cropTarget = useStore((s) => {
    const l = s.doc.layers.find(
      (x) => s.selectedIds.includes(x.id) && x.type === 'image' && !x.locked,
    )
    return l ? l.name : null
  })

  const showOverlayOpts = tool === 'effect'

  return (
    <div className="rail">
      <div className="rail-tools">
        {TOOLS.map((t) => (
          <button
            key={t.id}
            className={'tool' + (tool === t.id ? ' on' : '')}
            title={`${t.label}  (${keyHint(t)})`}
            onClick={() => setTool(t.id)}
          >
            {t.icon ? (
              <svg viewBox="0 0 24 24" width="20" height="20">
                <path d={t.icon} fill="none" stroke="currentColor" strokeWidth="1.7"
                  strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            ) : <PixelIcon />}
          </button>
        ))}
      </div>

      {tool === 'heal' && <HealPanel />}

      {tool === 'clone' && (
        <div className="rail-options">
          <div className="rail-opt-label">
            Clone stamp
            <Info>
              Alt-click the part of the picture you want to copy from, then paint over what
              you want gone. The distance between the two is held for the whole stroke, so
              the source travels with the brush. Kept as strokes rather than pixels, so it
              scales with the layer, survives a save, and undoes cleanly.
            </Info>
          </div>
          <BrushPreview brush={o.stamp} />
          <Row label="Brush">
            <Slider
              value={Math.round((o.stamp?.size ?? 0.08) * 100)}
              min={1} max={40} suffix="%"
              onChange={(v) => setToolOptions({ stamp: { ...o.stamp, size: v / 100 } })}
            />
          </Row>
          <Row label="Softness">
            <Slider
              value={Math.round((1 - (o.stamp?.hardness ?? 0.7)) * 100)}
              min={0} max={100} suffix="%"
              onChange={(v) => setToolOptions({ stamp: { ...o.stamp, hardness: 1 - v / 100 } })}
            />
          </Row>
          <p className="rail-hint">
            {cloneSource
              ? 'Source set. Paint away — one drag is one undo.'
              : 'No source yet. Alt-click somewhere clean first.'}
          </p>
        </div>
      )}

      {tool === 'wand' && (
        <div className="rail-options">
          <div className="rail-opt-label">
            Select by colour
            <Info>
              Click a colour and everything like it, spreading out from where you clicked,
              is selected. What comes back is an ordinary lasso — drag its points to adjust,
              then Copy, Cut, Mask, Erase or Pixelate as usual. For flat colour: a
              background, a logo, a sky, a panel of a screenshot; the AI lasso looks for
              subjects, so this is the one for everything that is not one. A lasso is a
              single outline, so selecting a background that wraps around something takes
              that something with it — to cut a subject out, select the subject.
            </Info>
          </div>
          <Row label="Tolerance">
            <Slider
              value={Math.round((o.wandTolerance ?? 0.18) * 100)}
              min={1} max={60} suffix="%"
              onChange={(v) => setToolOptions({ wandTolerance: v / 100 })}
            />
          </Row>
        </div>
      )}

      {tool === 'eyedrop' && (
        <div className="rail-options">
          <div className="rail-opt-label">
            Eyedropper
            <Info>
              Click anywhere to take that colour. It reads the picture as composited, so
              what you sample is what you can see — through an overlay, a mask or an
              adjustment. The pipette beside any colour box picks straight into it and hands
              the tool back when it is done.
            </Info>
          </div>
          {o.sampled && (
            <>
              <Row label="">
                <span className="swatch-row">
                  <span className="swatch" style={{ background: o.sampled }} />
                  <code>{o.sampled}</code>
                </span>
              </Row>
              <button
                className="btn ghost"
                onClick={() => navigator.clipboard?.writeText(o.sampled)}
              >Copy</button>
            </>
          )}
        </div>
      )}

      {tool === 'crop' && (
        <div className="rail-options">
          <div className="rail-opt-label">
            Crop
            <Info>
              Drag the box, then Enter to crop; Escape leaves it alone. Nothing is thrown
              away — undo brings the whole frame back. With nothing selected this crops the
              whole canvas, so select an image first to crop just that.
            </Info>
          </div>
          <p className="rail-hint">
            {cropTarget
              ? <>Crops <b>{cropTarget}</b>.</>
              : <>Crops the <b>whole canvas</b>.</>}
          </p>
        </div>
      )}

      {tool === 'lasso' && (
        <div className="rail-options">
          <div className="rail-opt-label">
            Lasso select
            <Info>
              Freehand: click to plot points, or press and drag to trace. Click the first
              point, double-click or press Enter to close; Backspace removes the last point,
              Esc cancels. Magnetic: drag roughly around the subject and the outline finds
              the edge itself, looking for the strongest boundary between where it last
              settled and where the pointer is — it reads colour edges, not just light and
              dark, so a subject the same brightness as its background still has a boundary
              to follow. AI: click the subject and the segmentation model traces it; the
              model decides what counts as the subject and your click only picks which part
              to take, so something in the background cannot be selected this way. The first
              run downloads the model.
              {' '}
              Whichever drew it, what you get is an ordinary lasso: drag a point to move it,
              click a hollow midpoint to add one, right-click a point to remove it, then
              choose Copy, Cut, Mask, Erase or Pixelate from the bar beneath the outline.
            </Info>
          </div>
          <Segmented
            value={o.aiSelect ? 'ai' : (o.magnet ? 'magnet' : 'free')}
            onChange={(mode) => setToolOptions({
              aiSelect: mode === 'ai',
              magnet: mode === 'magnet',
            })}
            options={[
              { value: 'free', label: 'Freehand' },
              { value: 'magnet', label: 'Magnetic' },
              { value: 'ai', label: 'AI' },
            ]}
          />
          {/* One line each, saying what this mode does differently. The rest is
              behind the (i) on the heading. */}
          <p className="rail-hint">
            {o.aiSelect
              ? 'Click the subject.'
              : o.magnet
                ? 'Drag roughly around the subject.'
                : 'Click to plot points, or drag to trace.'}
          </p>
        </div>
      )}

      {tool === 'mask' && <MaskPanel />}

      {tool === 'erase' && (
        <div className="rail-options">
          <BrushPreview brush={o.brush} warm={o.brush?.mode === 'restore'} />
          <div className="rail-opt-label">Brush size</div>
          <Slider
            value={Math.round((o.brush?.size ?? 0.06) * 200)}
            min={1}
            max={60}
            onChange={(v) => setToolOptions({ brush: { ...o.brush, size: v / 200 } })}
          />
          <div className="rail-opt-label">Hardness</div>
          <Slider
            value={Math.round((o.brush?.hardness ?? 0.65) * 100)}
            min={0}
            max={100}
            onChange={(v) => setToolOptions({ brush: { ...o.brush, hardness: v / 100 } })}
          />
          <div className="rail-opt-label">Mode</div>
          <Segmented
            value={o.brush?.mode || 'erase'}
            onChange={(mode) => setToolOptions({ brush: { ...o.brush, mode } })}
            options={[{ value: 'erase', label: 'Erase' }, { value: 'restore', label: 'Restore' }]}
          />
          <p className="rail-hint">
            Hold <kbd>Alt</kbd> to restore while erasing.
            <Info>
              Paints away part of the selected layer — the usual way to clean up what a
              background removal got wrong. Nothing is baked: strokes are stored as points,
              so they scale and rotate with the layer and undo one drag at a time. Brush
              size is a share of the layer width, so it stays the same size on screen as you
              zoom.
            </Info>
          </p>
        </div>
      )}

      {(showOverlayOpts || tool === 'shape') && (
        <div className="rail-options">
          {tool !== 'lasso' && (
            <>
              <div className="rail-opt-label">Shape</div>
              <Segmented value={o.shape} onChange={(shape) => setToolOptions({ shape })} options={SHAPES} />
            </>
          )}
          {showOverlayOpts && (
            <>
              <EffectPreview o={o} />
              <div className="rail-opt-label">Effect</div>
              <Select value={o.effect} onChange={(effect) => setToolOptions({ effect })} options={EFFECTS} />
              {(o.effect === 'pixelate' || o.effect === 'pixelblur') && (
                <>
                  <div className="rail-opt-label">Pixel size</div>
                  <Slider value={o.pixelSize} min={2} max={120} onChange={(pixelSize) => setToolOptions({ pixelSize })} />
                </>
              )}
              {(o.effect === 'blur' || o.effect === 'pixelblur') && (
                <>
                  <div className="rail-opt-label">Blur</div>
                  <Slider value={o.blurRadius} min={0} max={60} onChange={(blurRadius) => setToolOptions({ blurRadius })} />
                </>
              )}
              <div className="rail-opt-label">Feather</div>
              <Slider value={o.feather} min={0} max={80} onChange={(feather) => setToolOptions({ feather })} />
            </>
          )}
          <p className="rail-hint">Drag on the canvas to place. Shift = square, Alt = from center.</p>
        </div>
      )}
    </div>
  )
}

/**
 * Everything to do with a mask, in the one place you go to work on one.
 *
 * These controls used to live in the inspector, on the far side of the window
 * from the brush that needs them — so fixing an edge meant picking the tool on
 * the left, painting in the middle, then crossing to the right to feather it and
 * back again. The tool is where the work happens, so the settings are here.
 */
function MaskPanel() {
  const o = useStore((s) => s.toolOptions)
  const setToolOptions = useStore((s) => s.setToolOptions)
  const setMask = useStore((s) => s.setMask)
  const clearMask = useStore((s) => s.clearMask)
  const editMask = useStore((s) => s.editMask)
  const undoMaskAdd = useStore((s) => s.undoMaskAdd)
  const undoMaskPaint = useStore((s) => s.undoMaskPaint)
  const setNotice = useStore((s) => s.setNotice)
  const push = useStore((s) => s.pushHistory)
  // The same layer the brush will land on: the selection, so what the panel says
  // and what a stroke does can never disagree.
  const l = useStore((s) => {
    const sel = s.doc.layers.filter((x) => s.selectedIds.includes(x.id) && !x.locked
      && x.type !== 'group' && x.type !== 'effect')
    return sel[sel.length - 1] || null
  })

  const pushed = useRef(false)
  const begin = () => { if (!pushed.current) { push(); pushed.current = true } }
  const commit = () => { pushed.current = false }

  const brush = o.maskBrush || {}
  const outlined = (l?.mask?.points?.length || 0) >= 3
  const cut = isCutOut(l)

  return (
    <div className="rail-options">
      <div className="rail-opt-label">
        Mask
        <Info>
          Paint over the edge of a cut-out to fix it: Keep brings back what was cut off,
          Remove takes away what should not have survived. Hold Alt to flip while you paint.
          Strokes are kept as strokes, so they scale and turn with the layer and undo one
          drag at a time — the picture underneath is never touched. Edit outline hands the
          shape back to the lasso with its points intact, and opens the frame out so you can
          see the edge you are fixing; there, band a run of points to move or delete a whole
          stretch at once.
        </Info>
      </div>
      <Segmented
        value={brush.mode === 'take' ? 'take' : 'add'}
        onChange={(mode) => setToolOptions({ maskBrush: { ...brush, mode } })}
        options={[{ value: 'add', label: 'Keep' }, { value: 'take', label: 'Remove' }]}
      />
      <BrushPreview brush={brush} warm={brush.mode !== 'take'} />
      <div className="rail-opt-label">Brush size</div>
      <Slider
        value={Math.round((brush.size ?? 0.06) * 200)}
        min={1}
        max={60}
        onChange={(v) => setToolOptions({ maskBrush: { ...brush, size: v / 200 } })}
      />
      <div className="rail-opt-label">Hardness</div>
      <Slider
        value={Math.round((brush.hardness ?? 0.65) * 100)}
        min={0}
        max={100}
        onChange={(v) => setToolOptions({ maskBrush: { ...brush, hardness: v / 100 } })}
      />

      {!cut ? (
        <p className="rail-hint">
          Nothing cut out on this layer yet. Lasso the subject and choose <b>Mask</b>.
        </p>
      ) : (
        <>
          {outlined && (
            <>
              <div className="rail-opt-label">Keeps</div>
              <Toggle
                value={!l.mask.invert}
                onChange={(keep) => { push(); setMask(l.id, { invert: !keep }) }}
              >
                {l.mask.invert ? 'Everything outside' : 'Everything inside'}
              </Toggle>
              <div className="rail-opt-label">Feather</div>
              <Slider
                value={l.mask.feather || 0}
                min={0}
                max={80}
                suffix="px"
                onChange={(feather) => { begin(); setMask(l.id, { feather }) }}
                onCommit={commit}
              />
            </>
          )}
          <div className="rail-row">
            {outlined && (
              <button
                className="btn ghost"
                title="Put the outline back on the lasso so its points can be moved"
                onClick={() => {
                  const res = editMask(l.id)
                  setNotice(res.ok ? { kind: 'ok', text: res.text } : { kind: 'warn', text: res.reason })
                }}
              >Edit outline</button>
            )}
            {l.mask?.paint?.length > 0 && (
              <button className="btn ghost" title="Take back the last brush stroke"
                onClick={() => undoMaskPaint(l.id)}>Undo stroke</button>
            )}
            {l.mask?.plus?.length > 0 && (
              <button className="btn ghost" title="Take back the last piece added"
                onClick={() => undoMaskAdd(l.id)}>Undo piece</button>
            )}
            {outlined && (
              <button className="btn ghost" onClick={() => clearMask(l.id)}>Remove mask</button>
            )}
          </div>
        </>
      )}
    </div>
  )
}
