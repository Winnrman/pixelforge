import { useMemo, useRef } from 'react'
import { isCropped } from '../engine/shapes.js'
import { useStore, BLEND_MODES, defaultAdjust } from '../state/store.js'
import { getAsset } from '../engine/assets.js'
import { clipRange } from '../engine/clips.js'
import { defaultBgRemove, analyzeKey } from '../engine/matte.js'
import { MODELS, currentBackend } from '../engine/aiMatte.js'
import { sourceFor } from '../engine/render.js'
import { EFFECTS } from '../engine/effects.js'
import { pairsIn, TRANSITIONS, kindOf, hasFade, maxFade } from '../engine/transitions.js'
import {
  resolveLayer, hasTracks, activeGroups, groupKeyTimes,
  groupEaseAt, GROUP_OF, EASING_OPTIONS,
} from '../engine/keyframes.js'
import { Section, Row, Slider, Num, CommitNum, Select, Color, Toggle, Segmented } from './ui.jsx'
import { RETRO_PRESETS, RETRO_CONTROLS, retroDefaults } from '../engine/retro.js'
import { defaultSticker, defaultTrails } from '../engine/subject.js'
import { availableFonts } from '../engine/fonts.js'

const SHAPES = [
  { value: 'ellipse', label: 'Ellipse' },
  { value: 'rect', label: 'Rectangle' },
  { value: 'triangle', label: 'Triangle' },
  { value: 'diamond', label: 'Diamond' },
  { value: 'star', label: 'Star' },
  { value: 'path', label: 'Freehand' },
]

const ADJUSTMENTS = [
  { key: 'brightness', label: 'Brightness', min: 0, max: 300, def: 100 },
  { key: 'contrast', label: 'Contrast', min: 0, max: 300, def: 100 },
  { key: 'saturate', label: 'Saturation', min: 0, max: 300, def: 100 },
  { key: 'hue', label: 'Hue', min: -180, max: 180, def: 0, suffix: '°' },
  { key: 'blur', label: 'Blur', min: 0, max: 40, def: 0, suffix: 'px' },
  { key: 'grayscale', label: 'Grayscale', min: 0, max: 100, def: 0 },
  { key: 'sepia', label: 'Sepia', min: 0, max: 100, def: 0 },
  { key: 'invert', label: 'Invert', min: 0, max: 100, def: 0 },
]

const PRESETS = {
  None: {},
  Punchy: { contrast: 125, saturate: 130, brightness: 104 },
  Faded: { contrast: 88, saturate: 78, brightness: 108 },
  Noir: { grayscale: 100, contrast: 135 },
  Sepia: { sepia: 80, contrast: 108, saturate: 85 },
  Cold: { hue: -14, saturate: 112, brightness: 102 },
  Warm: { hue: 12, saturate: 116, brightness: 104 },
  Dream: { blur: 1.5, brightness: 110, saturate: 120, contrast: 92 },
}

/** Which mount a layer is wearing. A Polaroid is the one with a deep chin. */
const mountStyle = (l) => (l.frame?.on
  ? (l.frame.insets?.b > (l.frame.insets?.t || 0) * 1.5 ? 'polaroid' : 'border')
  : 'none')

export default function Inspector() {
  const doc = useStore((s) => s.doc)
  const selectedIds = useStore((s) => s.selectedIds)
  const update = useStore((s) => s.updateLayer)
  const push = useStore((s) => s.pushHistory)
  const setDoc = useStore((s) => s.setDoc)
  const resizeDoc = useStore((s) => s.resizeDoc)
  const docResize = useStore((s) => s.docResize)
  const setDocResize = useStore((s) => s.setDocResize)
  const linkRatio = useStore((s) => s.docLinkRatio)
  const setLinkRatio = useStore((s) => s.setDocLinkRatio)
  const fillCanvas = useStore((s) => s.fillCanvas)
  const fitCanvasToContent = useStore((s) => s.fitCanvasToContent)
  const recompute = useStore((s) => s.recomputeDuration)
  const setAutoTrack = useStore((s) => s.setAutoTrack)
  const setMask = useStore((s) => s.setMask)
  const clearMask = useStore((s) => s.clearMask)
  const enableTrack = useStore((s) => s.enableTrack)
  const disableTrack = useStore((s) => s.disableTrack)
  const setKeyEase = useStore((s) => s.setKeyEase)
  const clearKeys = useStore((s) => s.clearKeys)
  const keyScope = useStore((s) => s.keyScope)
  const setKeyScope = useStore((s) => s.setKeyScope)
  const selectedKey = useStore((s) => s.selectedKey)
  const runAiMatte = useStore((s) => s.runAiMatte)
  const matting = useStore((s) => s.matting)
  const runTracker = useStore((s) => s.runTracker)
  const tracking = useStore((s) => s.tracking)
  const trackOpts = useStore((s) => s.trackOpts)
  const setTrackOpts = useStore((s) => s.setTrackOpts)
  const textBehindSubject = useStore((s) => s.textBehindSubject)
  const toggleSticker = useStore((s) => s.toggleSticker)
  const mountLayers = useStore((s) => s.mountLayers)
  const trimToCrop = useStore((s) => s.trimToCrop)
  const toggleTrails = useStore((s) => s.toggleTrails)
  const analyzeLoop = useStore((s) => s.analyzeLoop)
  const setLoop = useStore((s) => s.setLoop)
  const setFreeze = useStore((s) => s.setFreeze)
  const autoCursorZoom = useStore((s) => s.autoCursorZoom)
  const cursorZoom = useStore((s) => s.cursorZoom)
  const setCursorZoom = useStore((s) => s.setCursorZoom)
  const trimToSubject = useStore((s) => s.trimToSubject)
  const clearErase = useStore((s) => s.clearErase)
  const setTransitionKind = useStore((s) => s.setTransitionKind)
  const setFade = useStore((s) => s.setFade)
  // The overlap this layer arrives into, in milliseconds, or 0. A number rather
  // than the pair itself, because a selector that builds an object rebuilds it
  // every call and never compares equal.
  const lap = useStore((st) => {
    const id = st.selectedIds[st.selectedIds.length - 1]
    if (!id) return 0
    const p = pairsIn(st.doc.layers, (x) => getAsset(x.assetId)).find((x) => x.inId === id)
    return p ? Math.round(p.length) : 0
  })
  // The selected clip's own length, for capping the fade sliders at half of it.
  const clipLength = useStore((st) => {
    const id = st.selectedIds[st.selectedIds.length - 1]
    const l = id && st.doc.layers.find((x) => x.id === id)
    return l?.clip ? Math.round(clipRange(l, getAsset(l.assetId)).length) : 0
  })
  const setText = useStore((s) => s.setText)

  const sel = doc.layers.filter((l) => selectedIds.includes(l.id))
  const base = sel.length === 1 ? sel[0] : null
  const animated = hasTracks(base)

  // Only subscribe to the playhead when it can actually change what is shown,
  // and then only at ~20fps so scrubbing does not thrash the panel.
  useStore((s) => (animated ? Math.round(s.time / 50) : 0))
  const time = useStore.getState().time
  const l = animated ? resolveLayer(base, time) : base

  // Per-property keyframe toggle for a Row: anim={animFor('opacity')}.
  const animFor = (prop) => {
    if (!base) return undefined
    const groupId = GROUP_OF[prop]
    if (!groupId) return undefined
    const active = groupKeyTimes(base, groupId).length > 0
    return {
      active,
      onToggle: () => (active ? disableTrack(base.id, groupId) : enableTrack(base.id, groupId)),
    }
  }

  // Live edits are transient; history is pushed once, on the first change of a
  // gesture, via `begin()`.
  // Grade the key on the frame in view, so the panel can say when colour
  // keying simply is not going to work on this image.
  const keyReport = useMemo(() => {
    if (l?.type !== 'image' || !l.bgRemove?.on || l.bgRemove.mode === 'ai') return null
    try {
      const bmp = sourceFor(l, time)
      return bmp ? analyzeKey(bmp, l.bgRemove) : null
    } catch { return null }
  }, [l?.id, l?.bgRemove && JSON.stringify(l.bgRemove), time])

  const pushed = useRef(false)
  const begin = () => { if (!pushed.current) { push(); pushed.current = true } }
  const setBg = (patch) => {
    if (!base) return
    update(base.id, { bgRemove: { ...defaultBgRemove(), ...base.bgRemove, ...patch } })
  }

  const set = (patch) => {
    begin()
    if (!base) return
    // Always route through setLayerAtTime: it decides per property whether a
    // value belongs in a keyframe or on the base layer.
    useStore.getState().setLayerAtTime(base.id, patch)
  }
  const commit = () => { pushed.current = false }

  if (!l) {
    return (
      <div className="inspector">
        <div className="panel-head"><span>{sel.length ? `${sel.length} layers` : 'Document'}</span></div>
        <div className="inspector-body">
          <Section
            title="Canvas"
            info={'Timeline sets the length for projects with no animated media. Zero means the timeline just follows whatever GIFs are in the document.'}
          >
            <Row label="Width">
              <CommitNum
                value={doc.width}
                onCommit={(v) => {
                  const w = Math.max(1, Math.round(v))
                  // The ratio is read before the change, so a run of edits does
                  // not compound rounding error into a drifting shape.
                  const h = linkRatio
                    ? Math.max(1, Math.round(w * (doc.height / doc.width)))
                    : doc.height
                  resizeDoc(w, h)
                }}
              />
            </Row>
            <Row label="Height">
              <CommitNum
                value={doc.height}
                onCommit={(v) => {
                  const h = Math.max(1, Math.round(v))
                  const w = linkRatio
                    ? Math.max(1, Math.round(h * (doc.width / doc.height)))
                    : doc.width
                  resizeDoc(w, h)
                }}
              />
            </Row>
            <Row label="Aspect">
              <Toggle value={linkRatio} onChange={setLinkRatio}>
                {linkRatio ? '⛓ Linked' : '⛓ Free'}
              </Toggle>
            </Row>
            <Row label="Content">
              <Segmented
                value={docResize}
                onChange={setDocResize}
                options={[
                  { value: 'leave', label: 'Leave' },
                  { value: 'fit', label: 'Fit' },
                  { value: 'fill', label: 'Fill' },
                ]}
              />
            </Row>
            <p className="hint">
              What happens to the artwork when the canvas is resized. <b>Leave</b> does nothing
              to it — the canvas is the frame, not the picture. <b>Fit</b> and <b>Fill</b>
              scale it uniformly about the centre, so nothing is ever stretched: Fit shrinks
              the content until all of it is inside, Fill grows it until it covers and crops
              the overflow.
            </p>
            <Row label="">
              <button className="btn" onClick={fitCanvasToContent}>
                Shrink canvas to fit content
              </button>
            </Row>
            <p className="hint">
              Moves the <b>canvas</b>: it shrinks to whatever is actually on it, so empty
              space around the artwork goes away. This is the one to reach for after
              cropping a picture and finding the canvas still its old size.
            </p>
            <Row label="">
              <button className="btn ghost" onClick={fillCanvas}>
                Scale content to fill canvas
              </button>
            </Row>
            <p className="hint">
              Moves the <b>content</b>: the artwork is scaled where it sits until it covers
              the canvas, cropping whatever falls outside. The opposite direction to the
              button above — which of the two moves is the whole difference between them.
            </p>
            <Row label="Background">
              <Segmented
                value={doc.background === 'transparent' ? 'transparent' : 'color'}
                onChange={(v) => {
                  push()
                  setDoc({ background: v === 'transparent' ? 'transparent' : '#4ea1ff' })
                }}
                options={[{ value: 'transparent', label: 'None' }, { value: 'color', label: 'Color' }]}
              />
            </Row>
            <Row label="Timeline">
              <Slider
                value={Math.round((doc.duration || 0) / 100) / 10}
                min={0}
                max={30}
                step={0.1}
                onChange={(v) => setDoc({ duration: Math.round(v * 1000) })}
                onCommit={() => useStore.getState().recomputeDuration()}
                suffix="s"
              />
            </Row>
            {doc.background !== 'transparent' && (
              <Row label="Color">
                <Color
                  value={doc.background}
                  onChange={(background) => { begin(); setDoc({ background }) }}
                  onCommit={commit}
                />
              </Row>
            )}
          </Section>
          <p className="hint">
            Select a layer to edit it. Anything you drop in goes to <b>Media</b> first,
            so importing a folder gives you a bin to choose from rather than a stack of
            layers.
          </p>
        </div>
      </div>
    )
  }

  if (l.type === 'group') {
    return (
      <div className="inspector">
        <div className="panel-head"><span>{l.name}</span></div>
        <div className="inspector-body">
          <Section title="Group"
            info={'Hiding a group hides everything in it, and its opacity multiplies with each layer\u2019s own. Drag layers onto the group row to add them.'}>
            <Row label="Opacity">
              <Slider
                value={Math.round((l.opacity ?? 1) * 100)}
                min={0}
                max={100}
                onChange={(v) => set({ opacity: v / 100 })}
                onCommit={commit}
                suffix="%"
              />
            </Row>
          </Section>
        </div>
      </div>
    )
  }

  const asset = l.type === 'image' ? getAsset(l.assetId) : null
  // After a crop the layer shows only part of its asset, so "native size" means
  // the size of that visible slice, not the whole file.
  const srcRect = l.src || { w: 1, h: 1 }
  const nativeW = Math.round((asset?.width || 0) * srcRect.w)
  const nativeH = Math.round((asset?.height || 0) * srcRect.h)

  return (
    <div className="inspector">
      <div className="panel-head"><span>{l.name}</span></div>
      <div className="inspector-body">

        <Section title="Transform">
          <Row label="Animate">
            <span className="btn-group">
              <Toggle value={!!animFor('x')?.active} onChange={() => animFor('x').onToggle()}>
                Position
              </Toggle>
              <Toggle value={!!animFor('w')?.active} onChange={() => animFor('w').onToggle()}>
                Size
              </Toggle>
            </span>
          </Row>
          <div className="grid2">
            <Row label="X"><Num value={l.x} onChange={(x) => set({ x })} onCommit={commit} /></Row>
            <Row label="Y"><Num value={l.y} onChange={(y) => set({ y })} onCommit={commit} /></Row>
            <Row label="W"><Num value={l.w} onChange={(w) => set({ w: Math.max(1, w) })} onCommit={commit} /></Row>
            <Row label="H"><Num value={l.h} onChange={(h) => set({ h: Math.max(1, h) })} onCommit={commit} /></Row>
          </div>
          <Row label="Rotation" anim={animFor('rotation')}>
            <Slider value={l.rotation || 0} min={-180} max={180} step={0.5}
              onChange={(rotation) => set({ rotation })} onCommit={commit} suffix="°" />
          </Row>
          <Row label="Opacity" anim={animFor('opacity')}>
            <Slider value={Math.round((l.opacity ?? 1) * 100)} min={0} max={100}
              onChange={(v) => set({ opacity: v / 100 })} onCommit={commit} suffix="%" />
          </Row>
          {l.type !== 'effect' && (
            <Row label="Blend">
              <Select value={l.blend || 'source-over'} onChange={(blend) => set({ blend })}
                options={BLEND_MODES.map((m) => ({ value: m, label: m === 'source-over' ? 'normal' : m }))} />
            </Row>
          )}
        </Section>

        {l.erase?.strokes?.length > 0 && (
          <Section
            title="Erased"
            info={'Painted with the eraser (E). Strokes are stored as points rather than '
              + 'baked pixels, so they scale and rotate with the layer, save into the '
              + 'project, and undo one drag at a time.'}
            right={(
              <button className="mini" onClick={() => clearErase(base.id, { all: true })}>
                Clear
              </button>
            )}
          >
            <Row label="Strokes">
              <span className="readout">
                {l.erase.strokes.length}
                <span className="dim">
                  {l.erase.strokes.some((st) => st.mode === 'restore')
                    ? ' · some restore'
                    : ''}
                </span>
              </span>
            </Row>
            <Row label="">
              <button className="btn ghost" onClick={() => clearErase(base.id)}>
                Undo the last stroke
              </button>
            </Row>
          </Section>
        )}

        {l.clip && (
          <Section
            title="Fade"
            info={'How long the clip takes to come up from black at its start and go back to '
              + 'black at its end. Drag the square handles in the top corners of the clip on '
              + 'the timeline — the ramp drawn on it is the fade. The black lands only where '
              + 'the clip has pixels, so a cutout fades without a black rectangle appearing '
              + 'around it. Each is capped at half the clip so the two cannot cross.'}
            right={hasFade(l) && (
              <button className="mini" onClick={() => setFade(base.id, { in: 0, out: 0 })}>
                Clear
              </button>
            )}
          >
            <Row label="In">
              <Slider
                value={Math.round(l.fade?.in || 0)} min={0} max={Math.round(maxFade(clipLength))}
                step={10} suffix="ms"
                onChange={(v) => setFade(base.id, { in: v }, { commit: false })}
                onCommit={() => setFade(base.id, {}, { commit: true })}
              />
            </Row>
            <Row label="Out">
              <Slider
                value={Math.round(l.fade?.out || 0)} min={0} max={Math.round(maxFade(clipLength))}
                step={10} suffix="ms"
                onChange={(v) => setFade(base.id, { out: v }, { commit: false })}
                onCommit={() => setFade(base.id, {}, { commit: true })}
              />
            </Row>
          </Section>
        )}

        {/* `> 0`, not just `lap`: a zero here is falsy but it is still a number,
            and React renders a number. `{lap && ...}` printed a bare 0 above the
            next section on every clip that had no overlap. */}
        {lap > 0 && (
          <Section
            title="Transition"
            info={'Two clips lapping over each other on a track is the transition, and the '
              + 'overlap is how long it takes. There is nothing here to add or remove: drag the '
              + 'clips further over each other to make it longer, or apart to end it. All this '
              + 'chooses is which kind.'}
          >
            <Row label="Kind">
              <Select
                value={kindOf(l)}
                onChange={(kind) => setTransitionKind(base.id, kind)}
                options={TRANSITIONS.map((t) => ({ value: t.id, label: t.label }))}
              />
            </Row>
            <Row label="Length">
              <span className="readout">
                {(lap / 1000).toFixed(2)}s
                <span className="dim"> · set by the overlap</span>
              </span>
            </Row>
          </Section>
        )}

        {l.type !== 'group' && l.type !== 'effect' && (
          <Section
            title="Motion trails"
            info={'Stamps the layer as it was a few moments ago, fading out. The echoes are '
              + 'read from the real keyframed motion, so this follows a track, a hand-animated '
              + 'move or a playing clip without any extra setup. On an image with the background '
              + 'removed it trails the cutout; without a cutout it trails the whole frame, '
              + 'rectangle and all.'}
          >
            <Row label="Trails">
              <Toggle value={!!l.trails?.on} onChange={(on) => toggleTrails(base.id, on)}>
                {l.trails?.on ? 'On' : 'Off'}
              </Toggle>
            </Row>
            {l.trails?.on && (
              <>
                <Row label="Echoes">
                  <Slider value={l.trails.count ?? 5} min={1} max={24} step={1}
                    onChange={(count) => set({ trails: { ...l.trails, count } })} onCommit={commit} />
                </Row>
                <Row label="Spacing">
                  <Slider value={l.trails.gapMs ?? 70} min={10} max={500} step={5}
                    onChange={(gapMs) => set({ trails: { ...l.trails, gapMs } })} onCommit={commit} suffix="ms" />
                </Row>
                <Row label="Fade">
                  <Slider value={Math.round((l.trails.fade ?? 0.6) * 100)} min={10} max={95}
                    onChange={(v) => set({ trails: { ...l.trails, fade: v / 100 } })} onCommit={commit} suffix="%" />
                </Row>
                <Row label="Shrink">
                  <Slider value={Math.round((l.trails.scale ?? 1) * 100)} min={70} max={100}
                    onChange={(v) => set({ trails: { ...l.trails, scale: v / 100 } })} onCommit={commit} suffix="%" />
                </Row>
                {l.type === 'image' && !l.bgRemove?.on && (
                  <p className="hint">Remove the background to trail just the subject.</p>
                )}
              </>
            )}
          </Section>
        )}

        {l.type !== 'group' && (
          <Section title="Motion tracking"
            info={'Put the layer over the thing you want followed, then track. It matches the patch underneath it frame by frame and writes the result as ordinary position keyframes you can edit afterwards. If it loses the subject it stops and says where: scrub there, reposition, and track again.'}>
            <Row label="Direction">
              <Segmented
                value={trackOpts.direction}
                onChange={(direction) => setTrackOpts({ direction })}
                options={[
                  { value: 'forward', label: 'Forward' },
                  { value: 'backward', label: 'Back' },
                  { value: 'both', label: 'Both' },
                ]}
              />
            </Row>
            <Row label="Search">
              <Slider
                value={trackOpts.radius}
                min={6}
                max={120}
                onChange={(radius) => setTrackOpts({ radius })}
                suffix="px"
              />
            </Row>
            <Row label="Follow size">
              <Toggle
                value={trackOpts.trackScale}
                onChange={(trackScale) => setTrackOpts({ trackScale })}
              >
                {trackOpts.trackScale ? 'Position and size' : 'Position only'}
              </Toggle>
            </Row>
            <Row label="Simplify">
              <Toggle
                value={trackOpts.simplify}
                onChange={(simplify) => setTrackOpts({ simplify })}
              >
                {trackOpts.simplify ? 'Fewest keys that fit' : 'A key per frame'}
              </Toggle>
            </Row>
            <Row label="">
              <button
                className="btn primary"
                disabled={!!tracking}
                onClick={() => runTracker(base.id, trackOpts)}
              >
                {tracking
                  ? `Tracking ${Math.round((tracking.progress || 0) * 100)}%`
                  : 'Track from playhead'}
              </button>
            </Row>
            {tracking && (
              <div className="progress">
                <div style={{ width: `${Math.round((tracking.progress || 0) * 100)}%` }} />
              </div>
            )}
          </Section>
        )}

        {l.mask?.points?.length >= 3 && (
          <Section
            title="Mask"
            info={'Cut from a lasso outline. The mask is stored relative to the layer box, so it follows the layer when you move, resize or rotate it.'}
            right={<button className="mini" onClick={() => clearMask(base.id)}>Remove</button>}
          >
            <Row label="Keeps">
              <Toggle
                value={!l.mask.invert}
                onChange={(keep) => { push(); setMask(base.id, { invert: !keep }) }}
              >
                {l.mask.invert ? 'Everything outside' : 'Everything inside'}
              </Toggle>
            </Row>
            <Row label="Feather">
              <Slider
                value={l.mask.feather || 0}
                min={0}
                max={80}
                onChange={(feather) => { begin(); setMask(base.id, { feather }) }}
                onCommit={commit}
                suffix="px"
              />
            </Row>
          </Section>
        )}

        {(
          <Section
            title="Motion"
            info={'Tracking on: any property you change grows its own animation track, keyed '
              + 'from where it was to where you put it. Or click the diamond beside a single '
              + 'property to animate just that one. All keys applies a slider across the whole '
              + 'track, while dragging on canvas offsets the path instead of flattening it.'}
            right={animated && <button className="mini" onClick={() => clearKeys(base.id)}>Clear all</button>}
          >
            <Row label="Tracking">
              <Toggle
                value={!!base.autoTrack}
                onChange={(on) => setAutoTrack(base.id, on)}
              >
                {base.autoTrack ? 'Tracking changes' : 'Add animation tracking'}
              </Toggle>
            </Row>
            {!animated ? (
              <p className="hint">
                {base.autoTrack ? 'Armed — change anything to key it.' : 'Off.'}
              </p>
            ) : (
              <>
                <Row label="Editing">
                  <Segmented
                    value={keyScope}
                    onChange={setKeyScope}
                    options={[
                      { value: 'key', label: 'This key', title: 'Write to the key at the playhead' },
                      { value: 'all', label: 'All keys', title: 'Apply to every key in the track' },
                    ]}
                  />
                </Row>
                <Row label="Animating">
                  <span className="track-chips">
                    {activeGroups(base).map((g) => (
                      <button
                        key={g.id}
                        className="chip"
                        title={'Stop animating ' + g.label.toLowerCase()}
                        onClick={() => disableTrack(base.id, g.id)}
                      >
                        {g.label} <b>{groupKeyTimes(base, g.id).length}</b> &times;
                      </button>
                    ))}
                  </span>
                </Row>
                {selectedKey?.layerId === base.id && (
                  <Row label="Ease out">
                    <Select
                      value={groupEaseAt(base, selectedKey.groupId, selectedKey.t)}
                      onChange={(ease) => setKeyEase(base.id, selectedKey.groupId, selectedKey.t, ease)}
                      options={EASING_OPTIONS}
                    />
                  </Row>
                )}
                <p className="hint">
                  {keyScope === 'all' ? 'Editing every key at once.' : 'Editing the key at the playhead.'}
                </p>
              </>
            )}
          </Section>
        )}

        {l.type === 'effect' && (
          <Section title="Overlay effect"
            info={'Effect layers read whatever is composited beneath them, so this tracks '
              + 'every frame of an animated GIF automatically. On a timeline an overlay '
              + 'arrives covering the clip it was put over, and only that one — if the shot '
              + 'has been cut into pieces it covers the piece under the playhead, and its '
              + 'right edge drags across the rest. Worth knowing when the overlay is hiding '
              + 'something: it ends where its clip ends. From then on it belongs to that '
              + 'shot: move the shot and the overlay goes with it, ripple the shot out and '
              + 'the overlay goes too. Drag the overlay somewhere else and it belongs to '
              + 'whatever is under it there.'}>
            <Row label="Effect">
              <Select value={l.effect} onChange={(effect) => { set({ effect }); commit() }} options={EFFECTS} />
            </Row>
            <Row label="Shape">
              <Select value={l.shape} onChange={(shape) => { set({ shape }); commit() }}
                options={SHAPES.filter((s) => s.value !== 'path' || l.shape === 'path')} />
            </Row>
            {(l.effect === 'pixelate' || l.effect === 'pixelblur') && (
              <Row label="Pixel size" anim={animFor('pixelSize')}>
                <Slider value={l.pixelSize} min={2} max={160}
                  onChange={(pixelSize) => set({ pixelSize })} onCommit={commit} suffix="px" />
              </Row>
            )}
            {(l.effect === 'blur' || l.effect === 'pixelblur') && (
              <Row label="Blur" anim={animFor('blurRadius')}>
                <Slider value={l.blurRadius} min={0} max={80}
                  onChange={(blurRadius) => set({ blurRadius })} onCommit={commit} suffix="px" />
              </Row>
            )}
            {['darken', 'brighten', 'desaturate', 'noise'].includes(l.effect) && (
              <Row label="Amount" anim={animFor('amount')}>
                <Slider value={l.amount ?? 50} min={0} max={100}
                  onChange={(amount) => set({ amount })} onCommit={commit} suffix="%" />
              </Row>
            )}
            {l.effect === 'solid' && (
              <Row label="Color"><Color value={l.color} onChange={(color) => set({ color })} onCommit={commit} /></Row>
            )}
            <Row label="Feather" anim={animFor('feather')}>
              <Slider value={l.feather || 0} min={0} max={120}
                onChange={(feather) => set({ feather })} onCommit={commit} suffix="px" />
            </Row>
            {l.shape === 'rect' && (
              <Row label="Corner">
                <Slider value={l.radius || 0} min={0} max={Math.round(Math.min(l.w, l.h) / 2)}
                  onChange={(radius) => set({ radius })} onCommit={commit} suffix="px" />
              </Row>
            )}
            {l.shape === 'star' && (
              <>
                <Row label="Points">
                  <Slider value={l.starPoints ?? 5} min={3} max={16}
                    onChange={(starPoints) => set({ starPoints })} onCommit={commit} />
                </Row>
                <Row label="Inner">
                  <Slider value={l.starInner ?? 0.45} min={0.1} max={0.9} step={0.01}
                    onChange={(starInner) => set({ starInner })} onCommit={commit} />
                </Row>
              </>
            )}
            <Row label="Invert">
              <Toggle value={!!l.invert} onChange={(invert) => { set({ invert }); commit() }}>
                {l.invert ? 'Everything except shape' : 'Inside shape'}
              </Toggle>
            </Row>
          </Section>
        )}

        {l.type === 'image' && (
          <>
            <Section title="Image">
              <Row label="Presets">
                <Select
                  value=""
                  onChange={(name) => {
                    begin()
                    update(l.id, { adjust: { ...defaultAdjust(), ...PRESETS[name] } })
                    commit()
                  }}
                  options={[{ value: '', label: 'Apply preset…' },
                    ...Object.keys(PRESETS).map((k) => ({ value: k, label: k }))]}
                />
              </Row>
              <Row label="Flip">
                <span className="btn-group">
                  <Toggle value={!!l.flipX} onChange={(flipX) => { set({ flipX }); commit() }}>↔</Toggle>
                  <Toggle value={!!l.flipY} onChange={(flipY) => { set({ flipY }); commit() }}>↕</Toggle>
                </span>
              </Row>
              <Row label="Corner">
                <Slider value={l.radius || 0} min={0} max={Math.round(Math.min(l.w, l.h) / 2)}
                  onChange={(radius) => set({ radius })} onCommit={commit} suffix="px" />
              </Row>
              <Row label="">
                <button className="btn ghost" onClick={() => {
                  const a = getAsset(l.assetId)
                  if (!a) return
                  begin()
                  update(l.id, { w: nativeW, h: nativeH })
                  commit()
                }}>Reset to native size ({nativeW}×{nativeH})</button>
              </Row>
            </Section>

            <Section
              title="Remove background"
              info={'Edges and Colour are colour keys: instant, offline, and only able to '
                + 'separate a background that differs in colour. AI runs a small segmentation '
                + 'model locally on your GPU — it handles busy, multi-coloured backgrounds, '
                + 'costs a one-time 4.6MB download, and must be re-run when you change frames.'}
              right={l.bgRemove?.on && (
                <button className="mini" onClick={() => {
                  begin(); update(base.id, { bgRemove: { ...defaultBgRemove(), on: true } }); commit()
                }}>Reset</button>
              )}
            >
              <Row label="Enabled">
                <Toggle
                  value={!!l.bgRemove?.on}
                  onChange={(on) => {
                    begin()
                    update(base.id, { bgRemove: { ...defaultBgRemove(), ...l.bgRemove, on } })
                    commit()
                  }}
                >{l.bgRemove?.on ? 'Keying' : 'Off'}</Toggle>
              </Row>
              {l.bgRemove?.on && (
                <>
                  <Row label="Method">
                    <Segmented
                      value={l.bgRemove.mode}
                      onChange={(mode) => { begin(); setBg({ mode }); commit() }}
                      options={[
                        { value: 'auto', label: 'Edges' },
                        { value: 'color', label: 'Colour' },
                        { value: 'ai', label: 'AI' },
                      ]}
                    />
                  </Row>
                  {l.bgRemove.mode === 'ai' && (
                    <>
                      <Row label="Model">
                        <Select
                          value={l.bgRemove.model || 'modnet'}
                          onChange={(model) => { begin(); setBg({ model }); commit() }}
                          options={Object.values(MODELS).map((m) => ({
                            value: m.key, label: `${m.name} · ${m.size}`,
                          }))}
                        />
                      </Row>
                      <Row label="">
                        <button
                          className="btn primary"
                          disabled={!!matting}
                          onClick={() => runAiMatte(base.id)}
                        >
                          {matting
                            ? `${matting.stage} ${Math.round((matting.progress || 0) * 100)}%`
                            : 'Run subject detection'}
                        </button>
                      </Row>
                      {matting && (
                        <div className="progress">
                          <div style={{ width: `${Math.round((matting.progress || 0) * 100)}%` }} />
                        </div>
                      )}
                      <Row label="Cutoff">
                        <Slider value={l.bgRemove.threshold ?? 0.5} min={0.05} max={0.95} step={0.01}
                          onChange={(threshold) => { begin(); setBg({ threshold }) }} onCommit={commit} />
                      </Row>
                      <p className="hint">
                        {(MODELS[l.bgRemove.model || 'modnet']).note}
                        {currentBackend()
                          ? ` Ran on ${currentBackend() === 'webgpu' ? 'the GPU (WebGPU).' : 'the CPU.'}`
                          : ' Downloaded once, then cached.'}
                      </p>
                    </>
                  )}
                  {l.bgRemove.mode === 'color' && (
                    <Row label="Colour">
                      <Color
                        value={l.bgRemove.color}
                        onChange={(color) => { begin(); setBg({ color }) }}
                        onCommit={commit}
                      />
                    </Row>
                  )}
                  {l.bgRemove.mode !== 'ai' && (
                  <Row label="Tolerance">
                    <Slider value={l.bgRemove.tolerance} min={0} max={160}
                      onChange={(tolerance) => { begin(); setBg({ tolerance }) }} onCommit={commit} />
                  </Row>
                  )}
                  <Row label="Edge feather">
                    <Slider value={l.bgRemove.feather ?? 1} min={0} max={8}
                      onChange={(feather) => { begin(); setBg({ feather }) }} onCommit={commit}
                      suffix="px" />
                  </Row>
                  <Row label="Shrink">
                    <Slider value={l.bgRemove.shrink} min={0} max={4}
                      onChange={(shrink) => { begin(); setBg({ shrink }) }} onCommit={commit} suffix="px" />
                  </Row>
                  {l.bgRemove.mode !== 'ai' && (
                  <Row label="Reach">
                    <Toggle
                      value={!!l.bgRemove.contiguous}
                      onChange={(contiguous) => { begin(); setBg({ contiguous }); commit() }}
                    >
                      {l.bgRemove.contiguous ? 'Only from the edges' : 'Anywhere in frame'}
                    </Toggle>
                  </Row>
                  )}
                  {keyReport && (
                    <p className={'hint' + (keyReport.verdict === 'ok' ? '' : ' warn')}>
                      Removing <b>{Math.round(keyReport.removed * 100)}%</b> of the frame.
                      {' '}{keyReport.note}
                    </p>
                  )}

                </>
              )}
            </Section>

            <Section
              title="Framing"
              info={'Crop trims what the layer shows without squashing it, so animating it reads as a reveal. Zoom pushes into the image while the layer box stays put.'}
              right={
                <button className="mini" onClick={() => {
                  begin()
                  update(base.id, {
                    cropT: 0, cropR: 0, cropB: 0, cropL: 0, zoom: 1, panX: 0, panY: 0,
                  })
                  commit()
                }}>Reset</button>
              }
            >
              <Row label="Crop top" anim={animFor('cropT')}>
                <Slider value={Math.round((l.cropT ?? 0) * 100)} min={0} max={95}
                  onChange={(v) => set({ cropT: v / 100 })} onCommit={commit} suffix="%" />
              </Row>
              <Row label="Crop bottom">
                <Slider value={Math.round((l.cropB ?? 0) * 100)} min={0} max={95}
                  onChange={(v) => set({ cropB: v / 100 })} onCommit={commit} suffix="%" />
              </Row>
              <Row label="Crop left">
                <Slider value={Math.round((l.cropL ?? 0) * 100)} min={0} max={95}
                  onChange={(v) => set({ cropL: v / 100 })} onCommit={commit} suffix="%" />
              </Row>
              <Row label="Crop right">
                <Slider value={Math.round((l.cropR ?? 0) * 100)} min={0} max={95}
                  onChange={(v) => set({ cropR: v / 100 })} onCommit={commit} suffix="%" />
              </Row>
              {(isCropped(l) || (l.zoom ?? 1) !== 1 || l.panX || l.panY) && (
                <>
                  <Row label="">
                    <button className="btn" onClick={() => trimToCrop(base.id)}>
                      Trim to crop
                    </button>
                  </Row>
                  <p className="hint">
                    These sliders are a moving window onto the picture, which is why the
                    layer stays its full size while showing less — they can be keyframed, and
                    a crop that resized its own layer would drag the subject around as it
                    animated. <b>Trim to crop</b> makes it permanent instead: the layer
                    becomes the piece you kept. Still non-destructive, so undo brings the
                    whole frame back.
                  </p>
                </>
              )}
              <Row label="Zoom" anim={animFor('zoom')}>
                <Slider value={l.zoom ?? 1} min={0.2} max={8} step={0.01}
                  onChange={(zoom) => set({ zoom })} onCommit={commit} suffix="×" />
              </Row>
              <Row label="Pan X" anim={animFor('panX')}>
                <Slider value={Math.round((l.panX ?? 0) * 100)} min={-50} max={50}
                  onChange={(v) => set({ panX: v / 100 })} onCommit={commit} suffix="%" />
              </Row>
              <Row label="Pan Y">
                <Slider value={Math.round((l.panY ?? 0) * 100)} min={-50} max={50}
                  onChange={(v) => set({ panY: v / 100 })} onCommit={commit} suffix="%" />
              </Row>
            </Section>

            {asset?.animated && (
              <Section title="Animation">
                <Row label="Frames"><span className="readout">{asset.frames.length}</span></Row>
                <Row label="Duration"><span className="readout">{(asset.duration / 1000).toFixed(2)}s</span></Row>
                <Row label="Speed">
                  <Slider value={l.speed || 1} min={0.1} max={4} step={0.05}
                    onChange={(speed) => { set({ speed }); recompute() }} onCommit={commit} suffix="×" />
                </Row>
                <Row label="Offset">
                  <Slider value={l.timeOffset || 0} min={0} max={Math.round(asset.duration)}
                    onChange={(timeOffset) => { set({ timeOffset }); recompute() }} onCommit={commit} suffix="ms" />
                </Row>
              </Section>
            )}

            {asset?.animated && !asset.isVideo && (
              <Section
                title="Loop repair"
                info={'Analyse measures how far the last frame is from the first and picks the '
                  + 'cheapest fix: trim to a frame that already matches, crossfade the seam, or '
                  + 'ping-pong. It is a remap, so switching it off restores the original clip. '
                  + 'A repaired loop no longer lines up with the source frames, so those exports '
                  + 'sample at a steady rate instead of claiming exact timing.'}
                right={l.loop?.on && (
                  <button className="mini" onClick={() => setLoop(base.id, { on: false, mode: 'none', crossfadeMs: 0, trimEndMs: 0 })}>
                    Off
                  </button>
                )}
              >
                <Row label="">
                  <button className="btn" onClick={() => analyzeLoop(base.id)}>Analyse this loop</button>
                </Row>
                <Row label="Mode">
                  <Select
                    value={l.loop?.on ? (l.loop.mode || 'none') : 'none'}
                    onChange={(mode) => setLoop(base.id, { on: true, mode })}
                    options={[
                      { value: 'none', label: 'As recorded (trim only)' },
                      { value: 'crossfade', label: 'Crossfade the seam' },
                      { value: 'pingpong', label: 'Ping-pong' },
                    ]}
                  />
                </Row>
                {l.loop?.mode === 'crossfade' && (
                  <Row label="Crossfade">
                    <Slider value={l.loop.crossfadeMs || 0} min={0} max={Math.round(asset.duration / 2)}
                      step={10} onChange={(crossfadeMs) => setLoop(base.id, { crossfadeMs })}
                      onCommit={commit} suffix="ms" />
                  </Row>
                )}
                <Row label="Trim end">
                  <Slider value={l.loop?.trimEndMs || 0} min={0} max={Math.round(asset.duration / 2)}
                    step={10} onChange={(trimEndMs) => setLoop(base.id, { trimEndMs })}
                    onCommit={commit} suffix="ms" />
                </Row>
              </Section>
            )}

            {asset?.animated && (
              <Section
                title="Cinemagraph"
                info={'Freezes the whole layer at one instant and lets only the lasso-masked '
                  + 'region keep moving. Draw a lasso mask on the layer first — steam, hair, a '
                  + 'screen — then pick the frame everything else should hold on.'}
              >
                <Row label="Freeze">
                  <Toggle value={!!l.freeze?.on} onChange={(on) => setFreeze(base.id, on)}>
                    {l.freeze?.on ? 'On' : 'Off'}
                  </Toggle>
                </Row>
                {l.freeze?.on && (
                  <Row label="Frozen at">
                    <Slider value={l.freeze.time || 0} min={0} max={Math.round(asset.duration)}
                      step={10} onChange={(t) => set({ freeze: { ...l.freeze, time: t } })}
                      onCommit={commit} suffix="ms" />
                  </Row>
                )}
                {!(l.mask?.points?.length >= 3) && (
                  <p className="hint">Needs a lasso mask — that region is what stays alive.</p>
                )}
              </Section>
            )}

            {asset?.animated && (
              <Section
                title="Follow the cursor"
                info={'For screen recordings. Finds the pointer by frame differencing, smooths '
                  + 'the path with a trailing lag and a dead zone so the camera is not seasick, '
                  + 'then writes zoom and pan keyframes: in while the pointer dwells, out during '
                  + 'a fast flick. The result is ordinary keyframes you can edit or delete. It '
                  + 'cannot see a pointer that is not moving, and it says so rather than guessing.'}
              >
                <Row label="Style">
                  <Segmented
                    value={cursorZoom.mode}
                    onChange={(mode) => setCursorZoom({ mode })}
                    options={[
                      { value: 'follow', label: 'Stay in' },
                      { value: 'dwell', label: 'In on dwell' },
                    ]}
                  />
                </Row>
                <p className="hint">
                  {cursorZoom.mode === 'follow'
                    ? 'Zoomed in and following the pointer for most of the clip, pulling out only to cross the screen. Delete the keys you do not want afterwards — they are ordinary keyframes.'
                    : 'Out by default, pushing in only where the pointer settles somewhere for a moment.'}
                </p>
                <Row label="Zoom">
                  <Slider value={cursorZoom.zoom} min={1.2} max={4} step={0.1}
                    onChange={(zoom) => setCursorZoom({ zoom })} suffix="×" />
                </Row>
                <Row label="">
                  <button className="btn" disabled={!!tracking}
                    onClick={() => autoCursorZoom(base.id)}>
                    {tracking ? 'Working…' : 'Generate camera moves'}
                  </button>
                </Row>
              </Section>
            )}

            <Section title="Adjustments" right={
              <button className="mini" onClick={() => { begin(); update(l.id, { adjust: defaultAdjust() }); commit() }}>
                Reset
              </button>
            }>
              {ADJUSTMENTS.map((a) => (
                <Row key={a.key} label={a.label}>
                  <Slider
                    value={l.adjust?.[a.key] ?? a.def}
                    min={a.min}
                    max={a.max}
                    step={a.key === 'blur' ? 0.5 : 1}
                    suffix={a.suffix || '%'}
                    onChange={(v) => set({ adjust: { ...l.adjust, [a.key]: v } })}
                    onCommit={commit}
                  />
                </Row>
              ))}
            </Section>

            <Section
              title="Subject"
              info={'These all reuse the cutout from Remove background, so run that first. '
                + 'Text behind the subject leaves the photo whole underneath, drops a text layer '
                + 'on top of it, and puts a second copy of the same image above the text with the '
                + 'mask on — the model only runs once because both copies share the frame.'}
            >
              <Row
                label=""
                info={'Works from either kind of cut-out: a removed background, or a lasso '
                  + 'mask. With the lasso there is a Text behind button right on the outline '
                  + 'bar, so AI select then Text behind is two clicks.'}
              >
                <button
                  className="btn"
                  disabled={!l.bgRemove?.on && !(l.mask?.points?.length >= 3)}
                  onClick={() => textBehindSubject(base.id)}
                >Put text behind the subject</button>
              </Row>
              <Row
                label=""
                info={'Leaves the subject exactly where it is on screen but makes the layer '
                  + 'only as big as the subject — so the handles, snapping and rotation work '
                  + 'on the thing you can see instead of a mostly-empty rectangle. The same '
                  + 'non-destructive crop as everything else, so undo brings the whole frame '
                  + 'back. On a clip it measures several frames and keeps the box big enough '
                  + 'for all of them.'}
              >
                <button
                  className="btn"
                  disabled={!l.bgRemove?.on}
                  title="Shrink the layer box to what the matte keeps"
                  onClick={() => trimToSubject(base.id)}
                >Trim the layer to the subject</button>
              </Row>
              {!l.bgRemove?.on && !(l.mask?.points?.length >= 3) && (
                <p className="hint">Nothing is cut out yet — remove the background, or lasso the subject and Mask.</p>
              )}
              <Row label="Mount">
                <Segmented
                  value={mountStyle(l)}
                  onChange={(style) => mountLayers([base.id], style, {
                    border: l.frame?.insets?.l || 0.05,
                    color: l.frame?.color,
                    shadow: l.frame?.shadow,
                  })}
                  options={[
                    { value: 'none', label: 'None' },
                    { value: 'border', label: 'Border' },
                    { value: 'polaroid', label: 'Polaroid' },
                  ]}
                />
              </Row>
              {l.frame?.on && (
                <>
                  <Row label="Border">
                    <Slider
                      value={Math.round((l.frame.insets?.l || 0.05) * 100)}
                      min={1} max={20} suffix="%"
                      onChange={(v) => mountLayers([base.id], mountStyle(l), {
                        border: v / 100, color: l.frame.color, shadow: l.frame.shadow,
                      })}
                    />
                  </Row>
                  <Row label="Card colour">
                    <Color value={l.frame.color || '#ffffff'}
                      onChange={(color) => { set({ frame: { ...l.frame, color } }); commit() }} />
                  </Row>
                  <Row label="Shadow">
                    <Slider value={l.frame.shadow ?? 14} min={0} max={40} suffix="px"
                      onChange={(shadow) => set({ frame: { ...l.frame, shadow } })}
                      onCommit={commit} />
                  </Row>
                  <p className="hint">
                    The card grows around the picture rather than the picture shrinking inside
                    it, so framing something never changes the photo you framed.
                  </p>
                </>
              )}
              <Row label="Sticker">
                <Toggle
                  value={!!l.sticker?.on}
                  onChange={(on) => toggleSticker(base.id, on)}
                >{l.sticker?.on ? 'On' : 'Off'}</Toggle>
              </Row>
              {l.sticker?.on && (
                <>
                  <Row label="Border">
                    <Slider value={l.sticker.outline ?? 12} min={0} max={64}
                      onChange={(outline) => set({ sticker: { ...l.sticker, outline } })}
                      onCommit={commit} suffix="px" />
                  </Row>
                  <Row label="Border colour">
                    <Color value={l.sticker.color || '#ffffff'}
                      onChange={(color) => { set({ sticker: { ...l.sticker, color } }); commit() }} />
                  </Row>
                  <Row label="Shadow">
                    <Slider value={l.sticker.shadow ?? 10} min={0} max={40}
                      onChange={(shadow) => set({ sticker: { ...l.sticker, shadow } })}
                      onCommit={commit} suffix="px" />
                  </Row>
                  <Row label="Shadow drop">
                    <Slider value={l.sticker.shadowY ?? 6} min={-30} max={30}
                      onChange={(shadowY) => set({ sticker: { ...l.sticker, shadowY } })}
                      onCommit={commit} suffix="px" />
                  </Row>
                  <p className="hint">
                    Export at a square scale for a sticker. The platform size presets
                    (Telegram 512, Discord 128, Slack, WhatsApp) are defined but not yet
                    wired into Export.
                  </p>
                </>
              )}
            </Section>

            <Section
              title="Retro look"
              info={'Palette quantisation with real dithering, the same machinery GIF export '
                + 'already uses to fit 256 colours. Applied last, so it also colours a cutout '
                + 'and its sticker border. Halftone is roughly three times the cost of the others.'}
              right={l.retro?.on && (
                <button className="mini" onClick={() => {
                  begin(); update(base.id, { retro: { on: false } }); commit()
                }}>Off</button>
              )}
            >
              <Row label="Preset">
                <Select
                  value={l.retro?.on ? l.retro.preset : ''}
                  onChange={(preset) => {
                    begin()
                    update(base.id, preset
                      ? { retro: { on: true, preset, opts: retroDefaults(preset) } }
                      : { retro: { on: false } })
                    commit()
                  }}
                  options={[{ value: '', label: 'None' },
                    ...RETRO_PRESETS.map((r) => ({ value: r.id, label: r.label }))]}
                />
              </Row>
              {l.retro?.on && Object.entries(l.retro.opts || {}).map(([k, v]) => {
                const c = RETRO_CONTROLS[k]
                if (!c) return null
                const put = (nv) => set({ retro: { ...l.retro, opts: { ...l.retro.opts, [k]: nv } } })
                return (
                  <Row key={k} label={c.label}>
                    {c.color ? (
                      <Color value={v} onChange={(nv) => { put(nv); commit() }} />
                    ) : c.bool ? (
                      <Toggle value={!!v} onChange={(nv) => { put(nv); commit() }}>{v ? 'On' : 'Off'}</Toggle>
                    ) : c.options ? (
                      <Select value={v} onChange={(nv) => { put(nv); commit() }}
                        options={c.options.map((o) => ({ value: o, label: o }))} />
                    ) : (
                      <Slider value={v} min={c.min} max={c.max} step={c.step}
                        onChange={put} onCommit={commit} suffix={c.suffix || ''} />
                    )}
                  </Row>
                )
              })}
            </Section>
          </>
        )}

        {l.type === 'shape' && (
          <Section title="Shape">
            <Row label="Shape">
              <Select value={l.shape} onChange={(shape) => { set({ shape }); commit() }} options={SHAPES} />
            </Row>
            <Row label="Fill"><Color value={l.fill} onChange={(fill) => set({ fill })} onCommit={commit} /></Row>
            <Row label="Stroke"><Color value={l.stroke} onChange={(stroke) => set({ stroke })} onCommit={commit} /></Row>
            <Row label="Width">
              <Slider value={l.strokeWidth} min={0} max={80}
                onChange={(strokeWidth) => set({ strokeWidth })} onCommit={commit} suffix="px" />
            </Row>
            {l.shape === 'rect' && (
              <Row label="Corner">
                <Slider value={l.radius || 0} min={0} max={Math.round(Math.min(l.w, l.h) / 2)}
                  onChange={(radius) => set({ radius })} onCommit={commit} suffix="px" />
              </Row>
            )}
          </Section>
        )}

        {l.type === 'text' && (
          <>
          <Section title="Text">
            <Row wide>
              <textarea
                id="pf-text-input"
                value={l.text}
                rows={3}
                onChange={(e) => setText(base.id, { text: e.target.value })}
                onBlur={commit}
              />
            </Row>
            <p className="hint">Or double-click the text on the canvas to edit it in place.</p>
            <Row label="Font">
              <Select
                value={l.font}
                onChange={(font) => { setText(base.id, { font }); commit() }}
                options={availableFonts().map((f) => ({
                  value: f.stack,
                  label: f.label,
                  // Each name set in its own face, so the menu is a specimen
                  // sheet rather than a list of words.
                  style: { fontFamily: f.stack, fontSize: '14px' },
                }))}
              />
            </Row>
            <Row label="Size">
              <Slider value={l.size} min={8} max={400}
                onChange={(size) => setText(base.id, { size })} onCommit={commit} suffix="px" />
            </Row>
            <Row label="Weight">
              <Select value={String(l.weight)} onChange={(w) => { setText(base.id, { weight: Number(w) }); commit() }}
                options={[300, 400, 500, 600, 700, 800, 900].map((n) => ({ value: String(n), label: String(n) }))} />
            </Row>
            <Row label="Align">
              <Segmented value={l.align} onChange={(align) => { setText(base.id, { align }); commit() }}
                options={[{ value: 'left', label: '⇤' }, { value: 'center', label: '↔' }, { value: 'right', label: '⇥' }]} />
            </Row>
            <Row label="Line height">
              <Slider value={l.lineHeight} min={0.7} max={2.5} step={0.05}
                onChange={(lineHeight) => setText(base.id, { lineHeight })} onCommit={commit} />
            </Row>
            <Row label="Box">
              <Toggle
                value={l.autoSize !== false}
                onChange={(autoSize) => { setText(base.id, { autoSize }); commit() }}
              >{l.autoSize !== false ? 'Hugs the text' : 'Fixed width, text wraps'}</Toggle>
            </Row>
            <p className="hint">
              {l.autoSize !== false
                ? 'The box follows the text as you type or change the size. Resizing it by hand switches to a fixed width.'
                : 'Text wraps at the box width; the height still follows the number of lines.'}
            </p>
            <Row label="Color"><Color value={l.color} onChange={(color) => set({ color })} onCommit={commit} /></Row>
            <Row label="Outline"><Color value={l.stroke} onChange={(stroke) => set({ stroke })} onCommit={commit} /></Row>
            <Row label="Outline w">
              <Slider value={l.strokeWidth} min={0} max={30}
                onChange={(strokeWidth) => set({ strokeWidth })} onCommit={commit} suffix="px" />
            </Row>
          </Section>

          <Section
            title="Outline over the top"
            info={'Strokes the same letters again, after everything else has been drawn. '
              + 'Over the solid text it is the same colour and invisible; over anything '
              + 'covering the text — the cut-out subject in a text-behind sandwich — the '
              + 'outline is all you see. One text layer does both, so there is nothing to '
              + 'keep in step when you retype it.'}
          >
            <Row label="Outline above">
              <Select
                value={l.outlineAbove ? String(l.outlineAbove) : 'off'}
                onChange={(v) => { set({ outlineAbove: v === 'off' ? false : v }); commit() }}
                options={[
                  { value: 'off', label: 'Off' },
                  { value: 'all', label: 'Everything' },
                  // Every layer, not just the ones stacked above. Picking one
                  // below moves the text's fill behind it rather than refusing,
                  // so layer order never has to be rearranged first.
                  ...doc.layers
                    .filter((x) => x.type !== 'group' && x.id !== base.id)
                    .map((x) => ({ value: x.id, label: x.name })),
                ]}
              />
            </Row>
            <p className="hint">
              The outline only shows where something is <b>covering</b> the text — over the
              solid letters it is the same colour and invisible. So on plain text it does
              nothing, which is correct: there is nothing in front of it to show through.
              Pick the layer it should show through, or Everything. A layer stacked
              <i> below</i> the text works too — the text is drawn behind it instead, so the
              order in the layers panel does not have to be rearranged first.
              {l.outlineAbove && ' Give it a different colour below to see it everywhere.'}
            </p>
            {l.outlineAbove && (
              <>
                <Row label="Letters">
                  <Toggle
                    value={!!l.outlineWhole}
                    onChange={(outlineWhole) => { set({ outlineWhole }); commit() }}
                  >{l.outlineWhole ? 'Switch whole letters' : 'Switch where it crosses'}</Toggle>
                </Row>
                <p className="hint">
                  {l.outlineWhole
                    ? 'A letter is either solid or outlined, never both — the change happens at the gap between letters rather than through the middle of one.'
                    : 'The change follows the covering edge exactly, so a letter it crosses comes out part solid and part outline.'}
                </p>
                {l.outlineWhole && (
                  <Row label="Switch at">
                    <Slider value={Math.round((l.outlineThreshold ?? 0.35) * 100)} min={5} max={90}
                      onChange={(v) => set({ outlineThreshold: v / 100 })} onCommit={commit} suffix="%" />
                  </Row>
                )}
                <Row label="Width">
                  <Slider value={l.outlineWidth ?? 2} min={0.5} max={20} step={0.5}
                    onChange={(outlineWidth) => set({ outlineWidth })} onCommit={commit} suffix="px" />
                </Row>
                <Row label="Colour">
                  <Color value={l.outlineColor || l.color}
                    onChange={(outlineColor) => set({ outlineColor })} onCommit={commit} />
                </Row>
              </>
            )}
          </Section>
          </>
        )}
      </div>
    </div>
  )
}
