import { useStore } from '../state/store.js'
import { EFFECTS } from '../engine/effects.js'
import { Row, Select, Slider, Segmented, Toggle, Info } from './ui.jsx'

const TOOLS = [
  // Bounding box deliberately centred on the 24x24 viewBox (x 5.5-18.5,
  // y 2.5-22): the original arrow measured 4-15 by 2-19, which sat visibly
  // up and to the left of every other icon in the rail.
  { id: 'move', key: 'V', label: 'Move / select', icon: 'M5.5 2.5 L5.5 20.5 L10 16 L13 22 L15.6 20.8 L12.7 15.1 L18.5 15.1 Z' },
  { id: 'crop', key: 'C', label: 'Crop', icon: 'M6 2 V15 A1 1 0 0 0 7 16 H20 M2 6 H15 A1 1 0 0 1 16 7 V20' },
  { id: 'effect', key: 'P', label: 'Pixel / blur overlay', icon: null },
  { id: 'lasso', key: 'L', label: 'Lasso select — click to plot points, or drag to trace', icon: 'M4 14 C2 9 6 3 12 3 C18 3 21 8 18 12 C16 15 10 15 9 18 C8 20 10 21 11 20' },
  { id: 'shape', key: 'S', label: 'Shape', icon: 'M3 3 H12 V12 H3 Z M9 9 A6 6 0 1 0 21 9 A6 6 0 1 0 9 9' },
  { id: 'text', key: 'T', label: 'Text', icon: 'M4 4 H20 M12 4 V20 M8 20 H16' },
  { id: 'erase', key: 'E', label: 'Erase — paint away part of a layer', icon: 'M8.5 20 H20 M3.6 16.4 l8-8 a1.5 1.5 0 0 1 2.1 0 l4.9 4.9 a1.5 1.5 0 0 1 0 2.1 l-4.6 4.6 H9.2 l-5.6 -5.6 a1.5 1.5 0 0 1 0 -2.1 Z' },
  { id: 'clone', key: 'K', label: 'Clone stamp — copy one part of a picture over another', icon: 'M9 3 h6 a2 2 0 0 1 2 2 v1 a3 3 0 0 0 3 3 v2 H4 V9 a3 3 0 0 0 3 -3 V5 a2 2 0 0 1 2 -2 z M9 11 v4 a3 3 0 0 0 3 3 v3' },
  { id: 'wand', key: 'W', label: 'Select by colour', icon: 'M4 20 L14 10 M12.5 8.5 l3 3 M17 3 l1 2.2 l2.2 1 l-2.2 1 l-1 2.2 l-1 -2.2 l-2.2 -1 l2.2 -1 z M6 4 l0.6 1.4 l1.4 0.6 l-1.4 0.6 l-0.6 1.4 l-0.6 -1.4 l-1.4 -0.6 l1.4 -0.6 z' },
  { id: 'eyedrop', key: 'I', label: 'Pick a colour from the picture', icon: 'M18.5 2.6 a2 2 0 0 1 2.9 2.9 l-2.2 2.2 l1 1 l-1.6 1.6 l-1 -1 l-8 8 l-4 1 l1 -4 l8 -8 l-1 -1 l1.6 -1.6 l1 1 z' },
  { id: 'hand', key: 'H', label: 'Pan', icon: 'M6 11 V6 a1.5 1.5 0 0 1 3 0 v5 V4 a1.5 1.5 0 0 1 3 0 v7 V5 a1.5 1.5 0 0 1 3 0 v6 V8 a1.5 1.5 0 0 1 3 0 v7 a6 6 0 0 1 -6 6 h-2 a5 5 0 0 1 -4 -2 l-3 -4 a1.5 1.5 0 0 1 2.5 -2 z' },
]

const SHAPES = [
  { value: 'ellipse', label: '●', title: 'Ellipse' },
  { value: 'rect', label: '■', title: 'Rectangle' },
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
            title={`${t.label}  (${t.key})`}
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

      {tool === 'erase' && (
        <div className="rail-options">
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
