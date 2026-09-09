// Styling part of a text layer rather than all of it.
//
// A layer had one colour, one weight, one slant, and that is right for a title
// and wrong for a sentence with a word in it that matters more than the rest.
// So a layer may also carry runs: stretches of its own text, given by character
// offsets, that override some of what the layer says.
//
// Runs are kept sorted, touching-but-not-overlapping, and merged whenever two
// neighbours end up saying the same thing. Everything downstream reads them
// through `segments`, which hands back the whole string cut into pieces with a
// resolved style on each — so the renderer never has to think about ranges, only
// about a list of things to draw one after another.
//
// The invariants are worth stating because every operation here has to keep
// them: no run is empty, no two overlap, they are in order, and no two adjacent
// runs carry the same style. A set of runs that breaks any of those still draws
// correctly but drifts — an editor that splits a run on every keystroke ends up
// with a hundred of them describing one colour.

/**
 * What a run may override. Anything else stays the layer's business.
 *
 * Size and family are here because a cover is the case this exists for: one word
 * of a line set larger, or in a different face, is the ordinary way a masthead
 * or a standfirst is built. Tracking too — a word can be tightened without the
 * line around it moving.
 */
export const RUN_PROPS = ['color', 'weight', 'italic', 'size', 'font', 'tracking']

const clean = (style) => {
  const out = {}
  for (const k of RUN_PROPS) if (style?.[k] !== undefined && style[k] !== null) out[k] = style[k]
  return out
}

const same = (a, b) => RUN_PROPS.every((k) => a?.[k] === b?.[k])

const empty = (style) => Object.keys(clean(style)).length === 0

/**
 * Puts a set of runs back in order: sorted, clipped to the text, nothing empty,
 * and neighbours that agree folded together.
 *
 * Called after every edit rather than trusted to the caller, because the cost of
 * getting it wrong is not a wrong picture — it is a slow creep of runs that each
 * say the same thing, and nobody notices until a title carries two hundred of
 * them.
 */
export function normalizeRuns(runs, length = Infinity) {
  const kept = (runs || [])
    .map((r) => ({
      from: Math.max(0, Math.min(Math.round(r.from ?? 0), length)),
      to: Math.max(0, Math.min(Math.round(r.to ?? 0), length)),
      style: clean(r.style ?? r),
    }))
    .filter((r) => r.to > r.from && !empty(r.style))
    .sort((a, b) => a.from - b.from || a.to - b.to)

  const out = []
  for (const r of kept) {
    const last = out[out.length - 1]
    if (last && r.from <= last.to) {
      // Overlapping: the later one wins over the stretch they share, which is
      // what "apply this to the selection" means when the selection crosses
      // something already styled.
      if (r.to <= last.to && same(last.style, r.style)) continue
      if (r.from < last.to) last.to = r.from
      if (last.to <= last.from) out.pop()
    }
    const prev = out[out.length - 1]
    if (prev && prev.to === r.from && same(prev.style, r.style)) prev.to = r.to
    else out.push({ ...r })
  }
  return out
}

/**
 * Applies a style over a stretch of text, returning fresh runs.
 *
 * A property set to null is *removed* from that stretch — which is how a word
 * is put back to whatever the layer says, and it is a different thing from
 * setting it to the layer's current value: the layer may change later, and text
 * that was never styled should follow it.
 */
export function applyRun(runs, from, to, patch, length = Infinity) {
  const lo = Math.max(0, Math.min(from, to))
  const hi = Math.min(length, Math.max(from, to))
  if (!(hi > lo)) return normalizeRuns(runs, length)

  const out = []
  for (const r of normalizeRuns(runs, length)) {
    // The parts of this run outside the stretch keep their style untouched.
    if (r.from < lo) out.push({ from: r.from, to: Math.min(r.to, lo), style: r.style })
    if (r.to > hi) out.push({ from: Math.max(r.from, hi), to: r.to, style: r.style })
    // The part inside it takes the patch on top of what it already said.
    const midFrom = Math.max(r.from, lo)
    const midTo = Math.min(r.to, hi)
    if (midTo > midFrom) out.push({ from: midFrom, to: midTo, style: merge(r.style, patch) })
  }
  // And whatever the stretch covered that no run did.
  for (const gap of gapsIn(out, lo, hi)) {
    out.push({ from: gap.from, to: gap.to, style: merge({}, patch) })
  }
  return normalizeRuns(out, length)
}

/** `patch` over `base`, with null meaning "stop saying this". */
function merge(base, patch) {
  const out = { ...clean(base) }
  for (const k of RUN_PROPS) {
    if (!(k in (patch || {}))) continue
    if (patch[k] === null || patch[k] === undefined) delete out[k]
    else out[k] = patch[k]
  }
  return out
}

/** The stretches between `lo` and `hi` that no run in `parts` covers. */
function gapsIn(parts, lo, hi) {
  const inside = parts
    .filter((r) => r.to > lo && r.from < hi)
    .map((r) => ({ from: Math.max(r.from, lo), to: Math.min(r.to, hi) }))
    .sort((a, b) => a.from - b.from)
  const out = []
  let at = lo
  for (const r of inside) {
    if (r.from > at) out.push({ from: at, to: r.from })
    at = Math.max(at, r.to)
  }
  if (at < hi) out.push({ from: at, to: hi })
  return out
}

/** What a run says at one character, or nothing if none does. */
export function styleAt(runs, i) {
  for (const r of runs || []) if (i >= r.from && i < r.to) return r.style
  return null
}

/**
 * The whole string, cut into pieces that each draw with one style.
 *
 * Callers get `{ text, from, to, style }` where the style is already the layer's
 * own with the run's overrides folded in — so drawing is a loop and nothing
 * downstream needs to know that runs exist.
 */
export function segments(text, runs, base = {}) {
  const s = String(text ?? '')
  const rs = normalizeRuns(runs, s.length)
  if (!rs.length) return [{ text: s, from: 0, to: s.length, style: { ...base } }]
  const out = []
  let at = 0
  const push = (from, to, style) => {
    if (to > from) out.push({ text: s.slice(from, to), from, to, style })
  }
  for (const r of rs) {
    push(at, r.from, { ...base })
    push(r.from, r.to, { ...base, ...r.style })
    at = r.to
  }
  push(at, s.length, { ...base })
  return out
}

/** Whether a layer styles any part of itself differently from the whole. */
export const hasRuns = (l) => (l?.runs?.length || 0) > 0

/**
 * Runs rewritten for an edit that replaced `[from, to)` with `insert` characters.
 *
 * Typing in the middle of a styled word should extend that word's style, not
 * leave the new letters unstyled or shift every run after it out of place.
 */
export function shiftRuns(runs, from, to, insert = 0) {
  const delta = insert - (to - from)
  // One rule for both ends, with a tie at the edit point moving forward. That is
  // the whole of the convention that text takes the style of the character
  // before it: typing at the end of a styled word extends the run, because the
  // run's end sits at the edit point and moves with it, while typing at the
  // start does not, because the run's start moves forward and leaves the new
  // characters outside. Anything inside a deletion collapses to where it began.
  const at = (i) => (i < from ? i : (i >= to ? i + delta : from))
  return normalizeRuns((runs || []).map((r) => ({
    from: at(r.from),
    to: at(r.to),
    style: r.style,
  })))
}
