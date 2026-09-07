import { useStore } from '../state/store.js'
import { EFFECTS } from '../engine/effects.js'
import { Select, Slider, Segmented, Toggle } from './ui.jsx'

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

      {tool === 'crop' && (
        <div className="rail-options">
          <div className="rail-opt-label">Crop</div>
          <p className="rail-hint">
            {cropTarget
              ? <>Drag the box, then <b>Enter</b> to crop <b>{cropTarget}</b>. Nothing is
                thrown away — undo brings the whole frame back.</>
              : <>Nothing is selected, so this crops the <b>whole canvas</b>. Select an
                image first to crop just that.</>}
          </p>
          <p className="rail-hint">Escape to leave it alone.</p>
        </div>
      )}

      {tool === 'lasso' && (
        <div className="rail-options">
          <div className="rail-opt-label">Lasso select</div>
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
          {o.aiSelect ? (
            <>
              <p className="rail-hint">
                Click the subject and the segmentation model traces an outline around it.
                What comes back is an ordinary lasso — drag the points to adjust it, then
                Copy, Cut, Mask, Erase or Pixelate as usual.
              </p>
              <p className="rail-hint">
                The model decides what counts as the subject; your click only picks which
                part of it to take. Something in the background cannot be selected this
                way. The first run downloads the model.
              </p>
            </>
          ) : o.magnet ? (
            <>
              <p className="rail-hint">
                Drag roughly around the subject and the outline finds the edge itself — it
                looks for the strongest boundary between where it last settled and where the
                pointer is, so it can be steered without being traced.
              </p>
              <p className="rail-hint">
                It reads colour edges, not just light and dark, so a subject that is the same
                brightness as what is behind it still has a boundary to follow. Where there
                genuinely is none it runs straight, and those points can be dragged
                afterwards like any other.
              </p>
            </>
          ) : (
            <p className="rail-hint">
            Click to plot points, or press and drag to trace freehand.
            Click the first point, double-click or press Enter to close.
            Backspace removes the last point, Esc cancels.
          </p>
          )}
          <p className="rail-hint">
            Once closed, drag a point to move it, click a hollow midpoint to add one,
            right-click a point to remove it.
          </p>
          <p className="rail-hint">
            Then choose Copy, Cut, Mask, Erase or Pixelate from the bar beneath
            the outline.
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
            Paints away part of the selected layer — the usual way to clean up what a
            background removal got wrong. Nothing is baked: strokes are stored as points, so
            they scale and rotate with the layer and undo one drag at a time.
          </p>
          <p className="rail-hint">
            Hold <kbd>Alt</kbd> to restore while erasing. Brush size is a share of the layer
            width, so it stays the same size on screen as you zoom.
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
