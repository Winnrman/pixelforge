// The clip model, under plain node.
//
// Clips are arithmetic — where a piece of media sits on a timeline and which
// part of it plays. Getting that arithmetic wrong loses footage or silently
// shows the wrong frames, and neither announces itself, so it is worth pinning
// down before any interface is built on top of it.
import {
  sourceRange, clipRange, visibleAt, assetTimeFor, wholeClip, slideTo, trimTo,
  splitAt, clipsEnd, closeGaps, hasClip, MIN_CLIP_MS,
} from './src/engine/clips.js'

const checks = []
const check = (name, ok, detail = '') => {
  checks.push([name, ok])
  console.log((ok ? 'PASS  ' : 'FAIL  ') + name + (detail ? '  — ' + detail : ''))
}
const near = (a, b, tol = 0.6) => Math.abs(a - b) <= tol

const asset = { duration: 10000 }
const clipped = (clip, extra = {}) => ({ id: 'l1', assetId: 'a', clip, ...extra })

// --- a layer with no clip is untouched ------------------------------------------
const plain = { id: 'p', timeOffset: 500, speed: 1 }
check('a layer with no clip has no clip', !hasClip(plain))
check('and is visible throughout', visibleAt(plain, 0, asset) && visibleAt(plain, 99999, asset))
check('and keeps the old offset behaviour', assetTimeFor(plain, 1500, asset) === 1000,
  String(assetTimeFor(plain, 1500, asset)))

// --- a whole clip ---------------------------------------------------------------
const whole = wholeClip({ }, asset, 2000)
console.log('whole clip:', JSON.stringify(whole))
check('a whole clip covers the source', whole.in === 0 && whole.out === 10000)
check('and starts where it was put', whole.start === 2000)
const w = clipped(whole)
check('its length is the source length', clipRange(w, asset).length === 10000)
check('and it ends where that puts it', clipRange(w, asset).end === 12000)

// --- visibility is a half-open span ---------------------------------------------
check('not visible before it starts', !visibleAt(w, 1999, asset))
check('visible on its first frame', visibleAt(w, 2000, asset))
check('visible just inside the end', visibleAt(w, 11999, asset))
// Exclusive, so two clips butted together do not both draw on the frame where
// they meet — which reads as a flash on every cut.
check('and not visible on the frame it ends', !visibleAt(w, 12000, asset))

// --- document time maps into the source -------------------------------------------
check('the clip start plays the in point', assetTimeFor(w, 2000, asset) === 0)
check('and halfway through plays halfway in', near(assetTimeFor(w, 7000, asset), 5000))
check('time before the clip clamps to the in point', assetTimeFor(w, 0, asset) === 0)
check('and time after it clamps inside the out point',
  assetTimeFor(w, 99999, asset) < 10000 && assetTimeFor(w, 99999, asset) > 9990)

// --- trimmed ----------------------------------------------------------------------
const mid = clipped({ start: 1000, in: 3000, out: 6000 })
check('a trimmed clip is as long as the piece it plays', clipRange(mid, asset).length === 3000)
check('and its start still plays its in point', assetTimeFor(mid, 1000, asset) === 3000)
check('so the trimmed-off head is genuinely gone',
  assetTimeFor(mid, 1000, asset) > 0 && !visibleAt(mid, 999, asset))

// --- speed shortens the clip, not the media ----------------------------------------
const fast = clipped({ start: 0, in: 0, out: 4000 }, { speed: 2 })
check('at 2x the clip takes half the timeline', clipRange(fast, asset).length === 2000,
  String(clipRange(fast, asset).length))
check('and still plays the whole piece', near(assetTimeFor(fast, 1999, asset), 3998, 3))

// --- sliding ------------------------------------------------------------------------
const slid = clipped(slideTo(mid, 5000))
check('sliding moves when it plays', clipRange(slid, asset).start === 5000)
check('and not what it plays', slid.clip.in === 3000 && slid.clip.out === 6000)
check('a clip cannot be slid before zero', slideTo(mid, -400).start === 0)

// --- trimming the ends ---------------------------------------------------------------
const rightTrim = clipped(trimTo(w, 'end', 6000, asset))
console.log('right edge to 6000:', JSON.stringify(rightTrim.clip))
check('dragging the right edge shortens the clip', clipRange(rightTrim, asset).end === 6000,
  String(clipRange(rightTrim, asset).end))
check('and leaves the start alone', rightTrim.clip.start === 2000 && rightTrim.clip.in === 0)

const leftTrim = clipped(trimTo(w, 'start', 5000, asset))
console.log('left edge to 5000:', JSON.stringify(leftTrim.clip))
// The two ends are not symmetric: moving the left edge has to move `start` too,
// or the rest of the clip slides along the timeline as you trim it.
check('dragging the left edge moves the start there', leftTrim.clip.start === 5000)
check('and skips that much of the source', leftTrim.clip.in === 3000, String(leftTrim.clip.in))
check('so the far end has not moved', clipRange(leftTrim, asset).end === 12000,
  String(clipRange(leftTrim, asset).end))

check('a clip cannot be trimmed past its other end',
  clipRange(clipped(trimTo(w, 'end', 2000, asset)), asset).length >= MIN_CLIP_MS)
check('nor can the left edge cross the right',
  clipRange(clipped(trimTo(w, 'start', 99999, asset)), asset).length >= MIN_CLIP_MS)
check('and the right edge cannot claim source that is not there',
  clipped(trimTo(w, 'end', 99999, asset)).clip.out <= 10000,
  String(clipped(trimTo(w, 'end', 99999, asset)).clip.out))

// --- splitting -------------------------------------------------------------------------
const parts = splitAt(w, 5000, asset)
console.log('split at 5000:', JSON.stringify(parts))
check('a split gives two clips', Array.isArray(parts) && parts.length === 2)
const [a, b] = parts.map((c) => clipped(c))
check('the first runs up to the cut', clipRange(a, asset).end === 5000)
check('the second starts at it', clipRange(b, asset).start === 5000)
// Nothing may be lost or repeated: the two halves have to tile the original
// exactly, in the timeline and in the source.
check('together they cover the original span',
  clipRange(a, asset).start === 2000 && clipRange(b, asset).end === 12000)
check('and the source is cut once, not overlapped',
  a.clip.out === b.clip.in, `${a.clip.out} vs ${b.clip.in}`)
check('the frame at the cut is the second clip first frame',
  assetTimeFor(b, 5000, asset) === a.clip.out)
check('splitting at the very start is refused', splitAt(w, 2000, asset) === null)
check('and at the very end too', splitAt(w, 12000, asset) === null)
check('and outside it entirely', splitAt(w, 50, asset) === null)

// --- the end of the timeline ---------------------------------------------------------
const many = [
  clipped({ start: 0, in: 0, out: 2000 }, { id: 'x' }),
  clipped({ start: 4000, in: 0, out: 3000 }, { id: 'y' }),
  { id: 'z' },
]
check('the timeline ends at the last clip', clipsEnd(many, () => asset) === 7000,
  String(clipsEnd(many, () => asset)))
check('and a layer with no clip does not extend it', clipsEnd([{ id: 'q' }], () => asset) === 0)

// --- closing gaps -----------------------------------------------------------------------
const closed = closeGaps(many, () => asset)
console.log('closed:', JSON.stringify([...closed]))
check('closing gaps butts the clips together',
  closed.get('x').start === 0 && closed.get('y').start === 2000,
  JSON.stringify([...closed.values()]))
check('and leaves unclipped layers alone', !closed.has('z'))
check('the order is kept, not the position',
  [...closed.keys()].join() === 'x,y', [...closed.keys()].join())

// --- degenerate input --------------------------------------------------------------------
const backwards = clipped({ start: 0, in: 5000, out: 1000 })
check('an inverted range is repaired, not obeyed',
  sourceRange(backwards, asset).out > sourceRange(backwards, asset).in,
  JSON.stringify(sourceRange(backwards, asset)))
const noOut = clipped({ start: 0, in: 0, out: null })
check('a missing out point means the whole source', sourceRange(noOut, asset).out === 10000)
// A title has no inherent length, so its clip is its length.
const title = { id: 't', type: 'text', clip: { start: 1000, in: 0, out: 3000 } }
check('a clip over a layer with no media still has a span',
  clipRange(title, null).length === 3000 && visibleAt(title, 2000, null),
  String(clipRange(title, null).length))
check('and that layer is hidden outside it', !visibleAt(title, 4001, null))

console.log(checks.filter(([, o]) => o).length + ' of ' + checks.length + ' passed')
process.exit(checks.some(([, ok]) => !ok) ? 1 : 0)
