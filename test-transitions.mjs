// Transitions, without a browser.
//
// The whole design rests on one claim — that the overlap between two clips is
// enough to describe a transition, with nothing stored at the join — so most of
// what is worth testing is arithmetic on clip ranges, and that runs under plain
// node.
import {
  pairsIn, stateAt, drawFor, revealRect, orderForTransitions,
  audioRamp, gainPointsFor, gainAt, kindOf, MIN_OVERLAP_MS, DEFAULT_KIND,
  fadeAlphaAt, fadePoints, voiceGainPoints, hasFade, maxFade,
} from './src/engine/transitions.js'

let pass = 0
let fail = 0
const check = (name, ok, detail = '') => {
  if (ok) pass++
  else fail++
  console.log((ok ? 'PASS  ' : 'FAIL  ') + name + (detail ? '  — ' + detail : ''))
}
const near = (a, b, eps = 1e-6) => Math.abs(a - b) < eps

// A clip over a source with a known length. No asset: a clip on a still is
// whatever length it was given, which keeps the fixture to numbers.
const clip = (id, start, length, extra = {}) => ({
  id,
  clip: { start, in: 0, out: length },
  track: 0,
  ...extra,
})
const assetOf = () => null

// --- finding the overlap ---------------------------------------------------------
{
  const a = clip('a', 0, 1000)
  const b = clip('b', 800, 1000)
  const pairs = pairsIn([a, b], assetOf)
  check('two clips that lap over each other are a transition', pairs.length === 1)
  check('running from where the second starts to where the first ends',
    pairs[0].start === 800 && pairs[0].end === 1000, JSON.stringify([pairs[0].start, pairs[0].end]))
  check('and lasting as long as they overlap', pairs[0].length === 200)
  check('the arriving clip is the one it belongs to', pairs[0].inId === 'b' && pairs[0].outId === 'a')
  check('and it is a crossfade unless told otherwise', pairs[0].kind === DEFAULT_KIND)
}

// Order in the array must not matter: clips are sorted by where they sit.
{
  const a = clip('a', 0, 1000)
  const b = clip('b', 800, 1000)
  const pairs = pairsIn([b, a], assetOf)
  check('which clip comes first in the list changes nothing',
    pairs.length === 1 && pairs[0].outId === 'a' && pairs[0].inId === 'b')
}

// --- no overlap, no transition ---------------------------------------------------
{
  const pairs = pairsIn([clip('a', 0, 1000), clip('b', 1000, 1000)], assetOf)
  check('clips butted together are a cut, not a transition', pairs.length === 0)
}
{
  const pairs = pairsIn([clip('a', 0, 1000), clip('b', 1400, 1000)], assetOf)
  check('clips with a gap between them are not one either', pairs.length === 0)
}
{
  // A frame or two of slop from dragging is not an instruction to dissolve.
  const pairs = pairsIn([clip('a', 0, 1000), clip('b', 1000 - (MIN_OVERLAP_MS - 10), 1000)], assetOf)
  check('and neither is an overlap too small to be meant', pairs.length === 0,
    `${MIN_OVERLAP_MS - 10}ms`)
}

// --- stacked, not sequential -------------------------------------------------------
{
  // Two clips over exactly the same span on one row is something people do by
  // accident, and it has always just drawn one in front of the other. Calling it
  // a full-length dissolve would be a dissolve into something that ends at the
  // same moment — into nothing.
  const pairs = pairsIn([clip('a', 0, 1000), clip('b', 0, 1000)], assetOf)
  check('two clips over the same span are stacked, not dissolving', pairs.length === 0)
}
{
  const pairs = pairsIn([clip('a', 0, 1000), clip('b', 200, 400)], assetOf)
  check('and neither is one sitting entirely inside another', pairs.length === 0)
}
{
  // Two clips dropped at the same spot, one longer: they start together, so
  // there is no arriving and no leaving, whatever the ends do.
  const pairs = pairsIn([clip('a', 0, 600), clip('b', 0, 1000)], assetOf)
  check('two clips starting together are stacked however long they run',
    pairs.length === 0)
}
{
  const pairs = pairsIn([clip('a', 0, 1000), clip('b', 200, 1000)], assetOf)
  check('but one that laps over and carries on is a transition', pairs.length === 1,
    `${pairs.length}`)
}

// --- tracks are separate ----------------------------------------------------------
{
  const a = clip('a', 0, 1000, { track: 0 })
  const b = clip('b', 800, 1000, { track: 1 })
  check('clips on different tracks are stacked, not dissolving',
    pairsIn([a, b], assetOf).length === 0)
}

// --- a run of three ---------------------------------------------------------------
{
  const pairs = pairsIn([
    clip('a', 0, 1000), clip('b', 800, 1000), clip('c', 1600, 1000),
  ], assetOf)
  check('a run of three clips has two transitions, not three', pairs.length === 2,
    pairs.map((p) => `${p.outId}->${p.inId}`).join(', '))
  check('each between neighbours',
    pairs[0].outId === 'a' && pairs[0].inId === 'b'
    && pairs[1].outId === 'b' && pairs[1].inId === 'c')
}

// --- the shape of a crossfade -----------------------------------------------------
{
  // Drawing the outgoing at 1-p and the incoming at p is the obvious thing and
  // it is wrong: the second lands over the first, so the two never sum to one
  // and the picture sags dark through the middle. The outgoing stays solid.
  const start = drawFor('crossfade', 'out', 0)
  const mid = drawFor('crossfade', 'in', 0.5)
  const end = drawFor('crossfade', 'in', 1)
  check('the outgoing clip stays solid through a crossfade', start.alpha === 1)
  check('and the incoming one comes up to meet it', near(mid.alpha, 0.5) && end.alpha === 1)
  // What lands on the canvas: A*(1-p) + B*p, which is a dissolve.
  const p = 0.25
  const composited = 1 * (1 - drawFor('crossfade', 'in', p).alpha)
  check('so the two sum to one at every point', near(composited + p, 1), String(composited))
}

// --- a dip is two halves, not a blend ----------------------------------------------
{
  const outEarly = drawFor('black', 'out', 0.25)
  const outLate = drawFor('black', 'out', 0.75)
  const inEarly = drawFor('black', 'in', 0.25)
  const inLate = drawFor('black', 'in', 0.75)
  check('the outgoing clip is up for the first half of a dip', outEarly.alpha === 1)
  check('and gone for the second', outLate.alpha === 0)
  check('the incoming clip is the other way round',
    inEarly.alpha === 0 && inLate.alpha === 1)
  check('the colour comes up as the first half runs out',
    near(outEarly.veil.alpha, 0.5) && outEarly.veil.colour === '#000000',
    JSON.stringify(outEarly.veil))
  check('and goes away again as the second half runs in',
    near(inLate.veil.alpha, 0.5), JSON.stringify(inLate.veil))
  check('at the middle it is fully covered',
    near(drawFor('black', 'out', 0.499).veil.alpha, 0.998, 0.01))
  check('and a white dip dips to white',
    drawFor('white', 'out', 0.25).veil.colour === '#ffffff')
}

// --- a wipe uncovers rather than fades ----------------------------------------------
{
  const half = drawFor('wipe', 'in', 0.5)
  check('both clips stay solid through a wipe',
    drawFor('wipe', 'out', 0.5).alpha === 1 && half.alpha === 1)
  const r = revealRect(half.reveal, 200, 100)
  check('and the incoming one is uncovered across the frame',
    r.x === 0 && near(r.w, 100) && r.h === 100, JSON.stringify(r))
  const back = revealRect(drawFor('wipe-back', 'in', 0.25).reveal, 200, 100)
  check('the other way for the other direction',
    near(back.x, 150) && near(back.w, 50), JSON.stringify(back))
}

// --- where the playhead is ------------------------------------------------------
{
  const layers = [clip('a', 0, 1000), clip('b', 800, 1000)]
  check('before the overlap nothing is mixing', stateAt(layers, assetOf, 700).size === 0)
  const mid = stateAt(layers, assetOf, 900)
  check('inside it both clips know their part',
    mid.size === 2 && mid.get('a').role === 'out' && mid.get('b').role === 'in')
  check('and how far through it is', near(mid.get('a').p, 0.5), String(mid.get('a').p))
  check('after it, nothing again', stateAt(layers, assetOf, 1100).size === 0)
  // Half-open, like clip visibility: the last frame belongs to the next thing.
  check('the end belongs to what comes after', stateAt(layers, assetOf, 1000).size === 0)
}

// --- draw order -------------------------------------------------------------------
{
  const a = clip('a', 0, 1000)
  const b = clip('b', 800, 1000)
  const pairs = pairsIn([a, b], assetOf)
  const ordered = orderForTransitions([b, a], pairs)
  check('the arriving clip is moved on top of the one it replaces',
    ordered.map((l) => l.id).join(',') === 'a,b', ordered.map((l) => l.id).join(','))
  const already = orderForTransitions([a, b], pairs)
  check('and left alone when it is already there',
    already.map((l) => l.id).join(',') === 'a,b')
  const others = orderForTransitions(
    [{ id: 'x' }, b, a, { id: 'y' }], pairs).map((l) => l.id).join(',')
  check('everything else keeps its place', others === 'x,a,b,y', others)
}

// --- sound ----------------------------------------------------------------------
{
  const ramp = audioRamp('crossfade', 'out', 1000, 1200)
  check('sound fades out across the whole overlap',
    ramp[0][1] === 1 && ramp[ramp.length - 1][1] === 0)
  const dip = audioRamp('black', 'in', 1000, 1200)
  check('and a dip holds silence through the middle rather than crossing',
    dip.length === 3 && dip[1][1] === 0 && near(dip[1][0], 1100), JSON.stringify(dip))
}
{
  // The middle clip of a run is the outgoing half of one and the incoming half
  // of another. A map keyed by layer would keep one and lose the other, leaving
  // it fading in and then never fading out.
  const layers = [clip('a', 0, 1000), clip('b', 800, 1000), clip('c', 1600, 1000)]
  const pairs = pairsIn(layers, assetOf)
  const pts = gainPointsFor('b', pairs)
  check('a clip in the middle of a run has both its fades', pts.length === 4,
    JSON.stringify(pts))
  check('silent as it arrives', near(gainAt(pts, 800), 0), String(gainAt(pts, 800)))
  check('up in the middle of it', near(gainAt(pts, 900), 0.5), String(gainAt(pts, 900)))
  check('full once it is in', near(gainAt(pts, 1200), 1), String(gainAt(pts, 1200)))
  check('and silent again once it has gone', near(gainAt(pts, 1800), 0),
    String(gainAt(pts, 1800)))
  check('full before anything starts', gainAt(gainPointsFor('a', pairs), 0) === 1)
  check('and a clip in no transition at all is left alone', gainAt([], 500) === 1)
}

// --- the kind -------------------------------------------------------------------
{
  check('a clip with nothing set is a crossfade', kindOf({ id: 'a' }) === 'crossfade')
  check('and one that was changed keeps what it was changed to',
    kindOf({ transition: { kind: 'wipe' } }) === 'wipe')
}

// --- a hidden clip is not half of anything ----------------------------------------
{
  const a = clip('a', 0, 1000)
  const b = clip('b', 800, 1000, { visible: false })
  check('a hidden clip does not dissolve into anything',
    pairsIn([a, b], assetOf).length === 0)
}

// --- fades at a clip's own edges ---------------------------------------------------
// A transition needs two clips; a fade needs one. This is the one thing here
// that has to be stored, because a clip's edges say when it starts, not how.
{
  const l = clip('a', 1000, 2000, { fade: { in: 400, out: 400 } })
  check('a clip with no fade is left alone', fadeAlphaAt(clip('b', 0, 1000), 500, null) === 1)
  check('at the very start it is not there yet', fadeAlphaAt(l, 1000, null) === 0)
  check('a quarter in, a quarter up', near(fadeAlphaAt(l, 1100, null), 0.25),
    String(fadeAlphaAt(l, 1100, null)))
  check('and fully up once the fade is done', fadeAlphaAt(l, 1400, null) === 1)
  check('it stays up through the middle', fadeAlphaAt(l, 2000, null) === 1)
  check('then goes away at the far end', near(fadeAlphaAt(l, 2900, null), 0.25),
    String(fadeAlphaAt(l, 2900, null)))
  check('reaching nothing on the last frame', fadeAlphaAt(l, 3000, null) === 0)
}
{
  // Fades are capped at half a clip each, so they meet at most in the middle
  // rather than defining the same moment twice.
  const l = clip('a', 0, 1000, { fade: { in: 500, out: 500 } })
  check('two fades that meet dip rather than fight',
    near(fadeAlphaAt(l, 500, null), 1) && near(fadeAlphaAt(l, 250, null), 0.5),
    `${fadeAlphaAt(l, 250, null)} / ${fadeAlphaAt(l, 500, null)}`)
  check('and half a clip is as long as either may be', maxFade(1000) === 500)
}
{
  check('a clip is only fading if a fade is set', hasFade({ fade: { in: 0, out: 0 } }) === false)
  check('and is once one is', hasFade({ fade: { in: 10, out: 0 } }) === true)
}
{
  const l = clip('a', 1000, 2000, { fade: { in: 400, out: 400 } })
  const pts = fadePoints(l, null)
  check('the sound follows the same curve',
    JSON.stringify(pts) === JSON.stringify([[1000, 0], [1400, 1], [2600, 1], [3000, 0]]),
    JSON.stringify(pts))
}
{
  // A clip can be dissolving into its neighbour at one end and fading at the
  // other. Both attenuate, so where they meet the quieter one is the answer —
  // adding or averaging would make a clip doing both come out louder than one
  // doing either.
  const a = clip('a', 0, 1000)
  const b = clip('b', 800, 1000, { fade: { out: 400, in: 0 } })
  const pairs = pairsIn([a, b], assetOf)
  const pts = voiceGainPoints(b, null, pairs)
  check('a clip that both dissolves in and fades out has both', pts.length >= 4,
    JSON.stringify(pts))
  check('silent as it dissolves in', near(gainAt(pts, 800), 0), String(gainAt(pts, 800)))
  check('full in the middle', near(gainAt(pts, 1200), 1), String(gainAt(pts, 1200)))
  check('and silent again at the end', near(gainAt(pts, 1800), 0), String(gainAt(pts, 1800)))
}

console.log(`\n${pass} of ${pass + fail} passed`)
process.exit(fail ? 1 : 0)
