import { useStore } from '../state/store.js'
import { requestPick } from '../state/picker.js'
import { useRef, useState } from 'react'
import { createPortal } from 'react-dom'

/**
 * Explanatory text, folded behind an (i) so it stops eating panel height.
 *
 * The bubble is rendered into document.body and positioned in viewport
 * coordinates: the inspector scrolls, so anything absolutely positioned inside
 * it gets clipped at the panel edge. Placement is clamped so it cannot run off
 * screen, and it flips above the icon when there is no room below.
 */
export function Info({ children }) {
  const [pos, setPos] = useState(null)
  const ref = useRef(null)

  const show = () => {
    const r = ref.current?.getBoundingClientRect()
    if (!r) return
    const W = 250
    const left = Math.max(10, Math.min(window.innerWidth - W - 10, r.right - W))
    const below = r.bottom + 8
    const flip = below + 150 > window.innerHeight
    setPos({
      left,
      width: W,
      ...(flip ? { bottom: window.innerHeight - r.top + 8 } : { top: below }),
    })
  }
  const hide = () => setPos(null)

  return (
    <span className="info" onMouseEnter={show} onMouseLeave={hide}>
      <button
        ref={ref}
        type="button"
        className="info-dot"
        aria-label="More information"
        onFocus={show}
        onBlur={hide}
        onClick={(e) => { e.preventDefault(); pos ? hide() : show() }}
      />
      {pos && createPortal(
        <span className="info-bubble" style={pos}>{children}</span>,
        document.body,
      )}
    </span>
  )
}

export function Section({ title, children, right, info }) {
  return (
    <div className="section">
      {title && (
        <div className="section-head">
          <span className="section-title">
            {title}
            {info && <Info>{info}</Info>}
          </span>
          {right}
        </div>
      )}
      <div className="section-body">{children}</div>
    </div>
  )
}

/**
 * `anim` turns on the keyframe stopwatch: {active, onToggle}. Clicking it starts
 * or stops a track for that property, so each property animates independently.
 */
export function Row({ label, children, wide, anim, info }) {
  return (
    <label className={'row' + (wide ? ' wide' : '') + (anim?.active ? ' animated' : '')}>
      {anim && (
        <button
          type="button"
          className={'anim-dot' + (anim.active ? ' on' : '')}
          title={anim.active ? `Stop animating ${label}` : `Animate ${label}`}
          onClick={(e) => { e.preventDefault(); anim.onToggle() }}
        >◆</button>
      )}
      {label && (
        <span className="row-label">
          {label}
          {info && <Info>{info}</Info>}
        </span>
      )}
      {/* A control with something to explain and no label to hang it off — the
          explanation still belongs behind an (i) rather than in a paragraph
          taking up the panel. */}
      {!label && info && <Info>{info}</Info>}
      <span className="row-control">{children}</span>
    </label>
  )
}

export function Slider({ value, min, max, step = 1, onChange, onCommit, suffix = '' }) {
  return (
    <span className="slider">
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(parseFloat(e.target.value))}
        onPointerUp={onCommit}
        onKeyUp={onCommit}
      />
      <input
        className="num"
        type="number"
        min={min}
        max={max}
        step={step}
        value={Math.round(value * 100) / 100}
        onChange={(e) => {
          const v = parseFloat(e.target.value)
          if (!Number.isNaN(v)) onChange(v)
        }}
        onBlur={onCommit}
      />
      {suffix && <span className="suffix">{suffix}</span>}
    </span>
  )
}

export function Num({ value, onChange, onCommit, step = 1, min, max }) {
  return (
    <input
      className="num solo"
      type="number"
      step={step}
      min={min}
      max={max}
      value={Math.round((value ?? 0) * 100) / 100}
      onChange={(e) => {
        const v = parseFloat(e.target.value)
        if (!Number.isNaN(v)) onChange(v)
      }}
      onBlur={onCommit}
    />
  )
}

/** Numeric field that only applies its value on blur or Enter. */
export function CommitNum({ value, onCommit, min = 1, step = 1 }) {
  return (
    <input
      className="num solo"
      type="number"
      min={min}
      step={step}
      defaultValue={value}
      key={value}
      onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur() }}
      onBlur={(e) => {
        const v = parseFloat(e.target.value)
        if (!Number.isNaN(v) && v !== value) onCommit(v)
        else e.target.value = value
      }}
    />
  )
}

export function Select({ value, onChange, options }) {
  // An option may carry its own `style`, which is how the font menu shows each
  // family in the family itself — reading the word "Consolas" set in the UI font
  // tells you nothing about what you are choosing. The closed control takes the
  // selected option's style too, so the current font is visible without opening
  // the menu.
  const selected = options.find((o) => (typeof o === 'string' ? o : o.value ?? o.id) === value)
  const own = typeof selected === 'object' ? selected?.style : null
  return (
    <select value={value} onChange={(e) => onChange(e.target.value)} style={own || undefined}>
      {options.map((o) => {
        const val = typeof o === 'string' ? o : o.value ?? o.id
        const label = typeof o === 'string' ? o : o.label
        const style = typeof o === 'object' ? o.style : null
        return <option key={val} value={val} style={style || undefined}>{label}</option>
      })}
    </select>
  )
}

export function Color({ value, onChange, onCommit }) {
  const setTool = useStore((s) => s.setTool)
  const tool = useStore((s) => s.tool)
  return (
    <span className="color-field">
      <input type="color" value={value} onChange={(e) => onChange(e.target.value)} onBlur={onCommit} />
      <input
        className="hex"
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onBlur={onCommit}
      />
      <button
        type="button"
        className="pipette"
        title="Pick this colour from the picture"
        onClick={() => {
          // The tool in use is remembered and handed back afterwards: asking for
          // one colour should not leave you holding a different tool.
          requestPick((hex) => { onChange(hex); onCommit?.() }, tool)
          setTool('eyedrop')
        }}
      >⦿</button>
    </span>
  )
}

export function Toggle({ value, onChange, children }) {
  return (
    <button className={'toggle' + (value ? ' on' : '')} onClick={() => onChange(!value)} type="button">
      {children}
    </button>
  )
}

export function Segmented({ value, onChange, options }) {
  return (
    <div className="segmented">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          className={value === o.value ? 'on' : ''}
          title={o.title || o.label}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}
