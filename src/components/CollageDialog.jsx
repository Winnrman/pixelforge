import { useMemo, useState } from 'react'
import { useStore } from '../state/store.js'
import { getAsset } from '../engine/assets.js'
import { layoutCollage, PHOTO_SHAPES, COLLAGE_STYLES } from '../engine/collage.js'
import { Row, Slider, Select, Color, Segmented, Toggle, Info } from './ui.jsx'

export default function CollageDialog({ assetIds, onClose }) {
  const makeCollage = useStore((s) => s.makeCollage)
  const stored = useStore((s) => s.collageOpts)
  const [o, setO] = useState(stored)
  const set = (patch) => setO((p) => ({ ...p, ...patch }))

  const items = assetIds.map(getAsset).filter(Boolean)
  // The same layout the action will use, so the readout is the real answer
  // rather than an estimate that can disagree with the result.
  const plan = useMemo(() => layoutCollage(
    items.map((a) => ({ width: a.width, height: a.height })), o,
  ), [items.length, o])

  const mp = (plan.width * plan.height) / 1e6

  return (
    <div className="modal-backdrop" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal">
        <div className="modal-head">
          <h2>Collage</h2>
          <button className="x" onClick={onClose}>✕</button>
        </div>

        <div className="modal-body">
          <p className="hint">
            {items.length} photo{items.length === 1 ? '' : 's'} into a
            {' '}<b>{plan.columns} × {plan.rows}</b> grid, on a {plan.width} × {plan.height} canvas
            {mp > 24 && <span className="warn"> — that is {mp.toFixed(0)} megapixels; drop the width if it feels slow</span>}.
          </p>

          <Row label="Style">
            <Segmented value={o.style} onChange={(style) => set({ style })} options={COLLAGE_STYLES} />
          </Row>
          <Row
            label="Photo shape"
            info={'Photos are cropped to fill their mount, not squashed into it — the crop '
              + 'is the ordinary non-destructive one, so you can reframe any card '
              + 'afterwards.'}
          >
            <Select value={o.shape} onChange={(shape) => set({ shape })} options={PHOTO_SHAPES} />
          </Row>

          <Row label="Centre piece">
            <Select
              value={String(o.hero)}
              onChange={(v) => set({ hero: v === 'auto' ? 'auto' : v })}
              options={[
                { value: 'auto', label: `Auto${plan.hero >= 0 ? ` (photo ${plan.hero + 1})` : ' — none for this many'}` },
                { value: 'none', label: 'No centre piece' },
              ]}
            />
          </Row>
          {o.hero !== 'none' && plan.hero >= 0 && (
            <Row label="Centre size">
              <Slider value={Math.round((o.heroScale ?? 1.75) * 100)} min={110} max={320} step={5}
                onChange={(v) => set({ heroScale: v / 100 })} suffix="%" />
            </Row>
          )}
          {o.hero !== 'none' && plan.hero < 0 && (
            <p className="hint">
              Too few photos for a centre piece.
              <Info>
                It needs an interior cell to sit in, or enlarging one just buries the rest.
              </Info>
            </p>
          )}

          <Row label="Columns">
            <Select
              value={String(o.columns)}
              onChange={(v) => set({ columns: Number(v) })}
              options={[
                { value: '0', label: `Auto (${plan.columns})` },
                ...Array.from({ length: Math.min(12, Math.max(1, items.length)) },
                  (_, i) => ({ value: String(i + 1), label: `${i + 1}` })),
              ]}
            />
          </Row>
          <Row label="Canvas width">
            <Slider value={o.width} min={600} max={4800} step={100}
              onChange={(width) => set({ width })} suffix="px" />
          </Row>

          {o.style !== 'none' && (
            <Row label="Border">
              <Slider value={Math.round(o.border * 1000)} min={10} max={140}
                onChange={(v) => set({ border: v / 1000 })} suffix="‰" />
            </Row>
          )}
          <Row label="Tilt">
            <Slider value={o.angle} min={0} max={15} step={0.5}
              onChange={(angle) => set({ angle })} suffix="°" />
          </Row>
          <Row label="Margin">
            <Slider value={Math.round((o.margin ?? 0.04) * 100)} min={-8} max={20}
              onChange={(v) => set({ margin: v / 100 })} suffix="%" />
          </Row>
          <Row label="Spacing">
            <Slider value={Math.round(-o.gap * 100)} min={-35} max={30}
              onChange={(v) => set({ gap: -v / 100 })} suffix="%" />
          </Row>
          <p className="hint">
            {o.gap < -0.005
              ? `Cards overlap by ${Math.round(-o.gap * 100)}% of a cell.`
              : o.gap > 0.005
                ? `Cards are spaced ${Math.round(o.gap * 100)}% apart, so nothing touches.`
                : 'Cards sit flush against each other.'}
          </p>
          <Row label="Size variation">
            <Slider value={Math.round((o.sizeVary ?? 0) * 100)} min={0} max={35}
              onChange={(v) => set({ sizeVary: v / 100 })} suffix="%" />
          </Row>
          <Row
            label="Shuffle"
            info={'Tilt, wobble, size and the stacking order all come from the seed rather '
              + 'than from chance, so a collage looks the same after an undo or a reload. '
              + 'Re-tilt picks a new one. A negative margin lets the outer cards bleed off '
              + 'the edge.'}
          >
            <span className="btn-group">
              <button className="btn ghost" onClick={() => set({ seed: (o.seed % 999) + 1 })}>
                Re-tilt
              </button>
              <span className="readout dim">seed {o.seed}</span>
            </span>
          </Row>


          <Row label="Backdrop">
            <Toggle value={o.backdrop} onChange={(backdrop) => set({ backdrop })}>
              {o.backdrop ? 'Set the canvas colour' : 'Leave the canvas alone'}
            </Toggle>
          </Row>
          {o.backdrop && (
            <Row label="Colour">
              <Color value={o.backdropColor} onChange={(backdropColor) => set({ backdropColor })} />
            </Row>
          )}
        </div>

        <div className="modal-foot">
          <button className="btn ghost" onClick={onClose}>Cancel</button>
          <button
            className="btn primary"
            disabled={!items.length}
            onClick={() => { makeCollage(assetIds, o); onClose() }}
          >Make collage</button>
        </div>
      </div>
    </div>
  )
}
