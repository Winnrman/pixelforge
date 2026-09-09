// The clip model, under plain node.
//
// Clips are arithmetic — where a piece of media sits on a timeline and which
// part of it plays. Getting that arithmetic wrong loses footage or silently
// shows the wrong frames, and neither announces itself, so it is worth pinning
// down before any interface is built on top of it.
import {
  sourceRange, clipRange, visibleAt, assetTimeFor, wholeClip, slideTo, trimTo,
  splitAt, clipsEnd, closeGaps, hasClip, MIN_CLIP_MS,
  snapPoints, snapClip, snapEdge, SNAP_PX, hostOf, ridersOf, isOverlay,
  audioRange, hasAudioEdges,
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

// --- snapping ---------------------------------------------------------------------
// Butting one clip against another by eye is a pixel hunt, and being a frame out
// shows as a flash of whatever is behind.
const world = [
  clipped({ start: 0, in: 0, out: 1000 }, { id: 'first' }),
  clipped({ start: 4000, in: 0, out: 1000 }, { id: 'second' }),
  { id: 'title', type: 'text' },
]
const pts = snapPoints(world, () => asset, 'moving', [2500])
console.log('snap points:', JSON.stringify([...pts].sort((a, b) => a - b)))
check('every clip edge is a snap point', pts.includes(1000) && pts.includes(4000)
  && pts.includes(5000), pts.join(','))
check('and so is the start of the project', pts.includes(0))
check('and the playhead', pts.includes(2500))
check('a layer with no clip contributes none', pts.length === 6, `${pts.length} points`)
// A clip that snapped to its own edges could never be moved at all.
const own = snapPoints(world, () => asset, 'first', [])
check('the clip being dragged is excluded', !own.includes(1000), own.join(','))

// The near edge wins, whichever end of the clip it is.
const byStart = snapClip(980, 500, pts, 60)
check('a start near an edge snaps to it', byStart.start === 1000 && byStart.at === 1000,
  JSON.stringify(byStart))
const byEnd = snapClip(3560, 500, pts, 60)
check('and so does an end', byEnd.start === 3500 && byEnd.at === 4000, JSON.stringify(byEnd))
check('the guide reports where it caught, not where the clip is',
  byEnd.at === 4000 && byEnd.start !== byEnd.at, JSON.stringify(byEnd))

// 1800..2200, with points at 1000 and 2500 — both out of reach at either end.
const nowhere = snapClip(1800, 400, pts, 60)
check('nothing in reach leaves the clip alone', nowhere.start === 1800 && nowhere.at === null,
  JSON.stringify(nowhere))
// The line only appears when it is telling the truth.
check('and draws no line', nowhere.at === null)

// Start 10 from an edge, end 50 from another: the near one is the start.
const both = snapClip(1010, 3040, pts, 60)
check('with two edges in reach the nearer one wins', both.at === 1000, JSON.stringify(both))
check('and the whole clip moves by that much, not to it', both.start === 1000,
  JSON.stringify(both))
check('a snap cannot push a clip before zero', snapClip(20, 500, [-500], 600).start >= 0)

const edge = snapEdge(4020, pts, 60)
check('trimming snaps the edge being dragged', edge.value === 4000 && edge.at === 4000,
  JSON.stringify(edge))
check('and leaves it alone when nothing is near',
  snapEdge(2000, pts, 60).at === null)

// --- what an overlay is riding on -----------------------------------------------
// A blur over a face lives on a shot, not at a number of seconds, and the rows
// do not say so: the censor is on track 2 and the shot on track 0. The bond is
// worked out from where things are, so there is nothing to attach and nothing
// to go stale.
{
  const of = (l) => (l.assetId ? { duration: 10000 } : null)
  const shot = { id: 'A', assetId: 'a', track: 0, clip: { start: 0, in: 0, out: 4000 } }
  const next = { id: 'B', assetId: 'a', track: 0, clip: { start: 4000, in: 4000, out: 8000 } }
  const censor = { id: 'C', track: 1, type: 'effect', clip: { start: 500, in: 0, out: 1500 } }
  const title = { id: 'T', track: 2, type: 'text', clip: { start: 5000, in: 0, out: 1000 } }
  const floating = { id: 'F', track: 3, type: 'text', clip: { start: 9000, in: 0, out: 500 } }
  const all = [shot, next, censor, title, floating]

  check('an overlay is a clip with no media of its own', isOverlay(censor) && !isOverlay(shot))
  check('a censor rides the shot it sits over', hostOf(all, censor, of)?.id === 'A')
  check('and a title over the next shot rides that one', hostOf(all, title, of)?.id === 'B')
  check('an overlay over nothing rides nothing', hostOf(all, floating, of) === null)
  check('a shot is not riding on anything', hostOf(all, shot, of) === null)
  check('the shot knows what it is carrying',
    ridersOf(all, shot, of).map((l) => l.id).join() === 'C')
  check('and does not claim the other one’s',
    ridersOf(all, next, of).map((l) => l.id).join() === 'T')

  // Run past the end of its shot on purpose — a censor that has to outlast the
  // cut. Where it *begins* is what pins it, so it still belongs to that shot.
  const long = { ...censor, clip: { start: 3000, in: 0, out: 3000 } }
  check('an overlay run past the cut still belongs to the shot it started on',
    hostOf([shot, next, long], long, of)?.id === 'A')

  // Two shots lapping over each other is a dissolve. An overlay dropped on the
  // join belongs to the shot coming in.
  const early = { id: 'A', assetId: 'a', track: 0, clip: { start: 0, in: 0, out: 4000 } }
  const late = { id: 'B', assetId: 'a', track: 0, clip: { start: 3000, in: 0, out: 4000 } }
  const onJoin = { id: 'C', track: 1, type: 'effect', clip: { start: 3200, in: 0, out: 2000 } }
  check('at a dissolve an overlay belongs to the shot coming in',
    hostOf([early, late, onJoin], onJoin, of)?.id === 'B')
}

{
  const of = () => ({ duration: 10000 })
  const a = { id: 'A', assetId: 'a', clip: { start: 0, in: 0, out: 2000 } }
  const b = { id: 'B', assetId: 'a', clip: { start: 4000, in: 0, out: 2000 } }
  const both = snapPoints([a, b], of, ['A', 'B'])
  check('a drag can hold several ids out of the snap points',
    !both.includes(4000) && !both.includes(2000), JSON.stringify(both))
  check('and one id still works on its own',
    snapPoints([a, b], of, 'A').includes(4000))
}

// --- a clip's sound has its own two edges --------------------------------------
// A J cut is the next shot's sound arriving before its picture; an L cut is this
// shot's sound carrying on after the picture has gone. Both need the sound and
// the picture to end at different moments, which is all this is.
{
  const ten = { duration: 10000 }
  const mid = { id: 'm', assetId: 'a', clip: { start: 2000, in: 600, out: 1600 } }

  const plain = audioRange(mid, ten)
  check('with no cut the sound is exactly the picture',
    plain.start === 2000 && plain.end === 3000 && plain.lead === 0 && plain.trail === 0,
    JSON.stringify(plain))
  check('and the clip says so', !hasAudioEdges(mid))

  const j = audioRange({ ...mid, audio: { lead: 300 } }, ten)
  check('leading starts the sound early and leaves the picture alone',
    j.start === 1700 && j.end === 3000 && j.lead === 300, JSON.stringify(j))
  const l = audioRange({ ...mid, audio: { trail: 400 } }, ten)
  check('trailing carries it past the end', l.start === 2000 && l.end === 3400 && l.trail === 400,
    JSON.stringify(l))
  check('and either counts as a cut', hasAudioEdges({ ...mid, audio: { trail: 1 } }))

  // Leading by half a second means playing half a second of sound from before
  // the in-point. If it is not there, it is not there.
  const greedy = audioRange({ ...mid, audio: { lead: 5000, trail: 20000 } }, ten)
  check('a lead is held to what is in front of the in-point',
    greedy.lead === 600, `${greedy.lead} of 600 available`)
  check('and a trail to what is behind the out-point',
    greedy.trail === 8400, `${greedy.trail} of 8400 available`)
  // Asking for less than there is gets what was asked for, which is the case
  // that would pass either way and so says nothing on its own.
  check('while asking for less than there is gets exactly that',
    audioRange({ ...mid, audio: { trail: 5000 } }, ten).trail === 5000)
  check('the room either side is said out loud, so a lane can show it',
    greedy.room.lead === 600 && greedy.room.trail === 8400, JSON.stringify(greedy.room))

  // Nor can the sound start before the project does.
  const atZero = audioRange({ id: 'z', assetId: 'a', clip: { start: 100, in: 600, out: 1600 }, audio: { lead: 500 } }, ten)
  check('and the sound cannot start before the project does', atZero.start === 0 && atZero.lead === 100,
    JSON.stringify(atZero))

  // At double speed a second of document time is two seconds of recording, so
  // the same spare material buys half as much lead.
  const fast = audioRange({ ...mid, speed: 2, audio: { lead: 5000 } }, ten)
  check('speed is taken into account, the recording being played faster',
    fast.lead === 300, `${fast.lead}`)
}

console.log(checks.filter(([, o]) => o).length + ' of ' + checks.length + ' passed')
process.exit(checks.some(([, ok]) => !ok) ? 1 : 0)
