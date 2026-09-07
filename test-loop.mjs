// Unit tests for loop repair (src/engine/loop.js). Plain node, no browser and no
// canvas: that module is deliberately DOM-free, and pixels reach it through a
// caller-supplied sampler, so both the time remaps and the seam metric can be
// checked against synthetic assets here.
//
//   node test-loop.mjs
import { pingPongTime, loopPlan, loopSeam, suggestLoop } from './src/engine/loop.js'

const checks = []
const check = (name, ok, detail = '') => {
  checks.push([name, ok])
  console.log((ok ? 'PASS  ' : 'FAIL  ') + name + (detail ? '  — ' + detail : ''))
}

// ---------------------------------------------------------------- fixtures --

/** Fabricates the `{frames, cum, duration}` shape the decoders produce. */
function makeAsset(delays) {
  const cum = []
  let acc = 0
  const frames = delays.map((delay) => {
    acc += delay
    cum.push(acc)
    return { delay, bitmap: null }
  })
  return { frames, cum, duration: acc, animated: frames.length > 1 }
}

// Same binary search render.js uses, copied so the test does not depend on the
// module under test for its own expectations.
function frameIndexAt(asset, t) {
  const n = asset.frames.length
  if (n <= 1) return 0
  const d = asset.duration
  let tt = ((t % d) + d) % d
  let lo = 0
  let hi = n - 1
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (tt < asset.cum[mid]) hi = mid
    else lo = mid + 1
  }
  return lo
}

const W = 12
const H = 12

/**
 * Generates a deterministic gradient frame from a spec:
 *   { p }               distinct gradient phase
 *   { p, invert: true } the photographic negative of phase p
 *   { p, shift: 30 }    phase p nudged by a constant on every channel
 */
function frameRGBA(spec) {
  const data = new Uint8ClampedArray(W * H * 4)
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const o = (y * W + x) * 4
      let r = (x * 17 + spec.p * 37) & 255
      let g = (y * 13 + spec.p * 29) & 255
      let b = (x * 5 + y * 7 + spec.p * 61) & 255
      if (spec.invert) { r = 255 - r; g = 255 - g; b = 255 - b }
      if (spec.shift) { r += spec.shift; g += spec.shift; b += spec.shift }
      data[o] = r
      data[o + 1] = g
      data[o + 2] = b
      data[o + 3] = 255
    }
  }
  return { data, width: W, height: H }
}

const samplerFor = (specs) => (i) => frameRGBA(specs[i])

// ------------------------------------------------- 1. pingPongTime periodic --

const SIX = makeAsset([100, 100, 100, 100, 100, 100])
const D = SIX.duration            // 600ms
const F = 100                     // one frame width
const PERIOD = 2 * D - 2 * F      // 1000ms — two endpoint frames removed

let maxDrift = 0
for (let t = -733; t < 3000; t += 7.3) {
  const drift = Math.abs(pingPongTime(t, D, F) - pingPongTime(t + PERIOD, D, F))
  if (drift > maxDrift) maxDrift = drift
}
check(`pingPongTime is periodic with period ${PERIOD}ms`, maxDrift < 1e-9,
  `max drift over 511 samples = ${maxDrift.toExponential(2)}ms`)

// --------------------------------------- 2. no repeated index at turnaround --

// Sampled at slot centres: a time remap is evaluated where the frame is actually
// on screen. The turnaround instant itself lands exactly on a frame boundary,
// which is ambiguous by definition, so it is not a meaningful sample point.
const slots = PERIOD / F
const seq = []
for (let i = 0; i < slots; i++) {
  seq.push(frameIndexAt(SIX, pingPongTime((i + 0.5) * F, D, F)))
}
const expected = [0, 1, 2, 3, 4, 5, 4, 3, 2, 1]
check('pingPongTime index sequence has no doubled endpoints',
  seq.join(',') === expected.join(','),
  `got [${seq.join(',')}] expected [${expected.join(',')}]`)

// The plan must drive the exact same remap.
const ppPlan = loopPlan(SIX, { mode: 'pingpong' })
const planSeq = []
for (let i = 0; i < slots; i++) planSeq.push(ppPlan.sample((i + 0.5) * F).a)
check('loopPlan pingpong reproduces that sequence and length',
  planSeq.join(',') === expected.join(',') && ppPlan.duration === PERIOD,
  `duration ${ppPlan.duration}ms, [${planSeq.join(',')}]`)

// ------------------------------------- 3. monotonic up, monotonic down, ±1f --

const STEP = 0.5
let rising = true
let falling = true
let worstIndexJump = 0
let prevT = pingPongTime(0, D, F)
let prevI = frameIndexAt(SIX, prevT)
let turnStep = 0
let wrapStep = 0
for (let t = STEP; t <= PERIOD; t += STEP) {
  const v = pingPongTime(t, D, F)
  const i = frameIndexAt(SIX, v)
  if (t < D && !(v > prevT)) rising = false
  if (t > D && t < PERIOD && !(v < prevT)) falling = false
  if (Math.abs(t - D) < 1e-9) turnStep = prevT - v
  if (Math.abs(t - PERIOD) < 1e-9) wrapStep = prevT - v
  const jump = Math.abs(i - prevI)
  if (jump > worstIndexJump) worstIndexJump = jump
  prevT = v
  prevI = i
}
check('pingPongTime rises then falls, one pass each', rising && falling,
  `rising=${rising} falling=${falling} over ${Math.round(PERIOD / STEP)} samples`)
check('pingPongTime never jumps more than one frame', worstIndexJump <= 1,
  `worst index jump = ${worstIndexJump}`)
check('turnaround and wrap step back by exactly one frame width',
  Math.abs(turnStep - F) <= STEP + 1e-9 && Math.abs(wrapStep - F) <= STEP + 1e-9,
  `turnaround ${turnStep.toFixed(1)}ms, wrap ${wrapStep.toFixed(1)}ms, frame ${F}ms`)

// ------------------------------------------------------ 4. crossfade timing --

const CF = 200
const xf = loopPlan(SIX, { mode: 'crossfade', crossfadeMs: CF })
check('crossfade duration is source minus the fade', xf.duration === D - CF,
  `${xf.duration}ms = ${D} - ${CF}`)

const at0 = xf.sample(0)
check('crossfade sample(0) needs no blend', at0.mix === 0 && at0.b === at0.a,
  `a=${at0.a} b=${at0.b} mix=${at0.mix}`)

const fadeStart = xf.duration - CF
const atFadeStart = xf.sample(fadeStart)
const atEnd = xf.sample(xf.duration - 0.001)
check('crossfade mix rises to ~1 at the end of the loop',
  atFadeStart.mix < 1e-9 && atEnd.mix > 0.999,
  `mix ${atFadeStart.mix.toFixed(4)} at ${fadeStart}ms -> ${atEnd.mix.toFixed(4)} at ${xf.duration}ms`)

// Everything blended toward must come from the first `CF` of the clip.
let bWraps = true
const bSeen = new Set()
for (let t = fadeStart; t < xf.duration; t += 5) {
  const s = xf.sample(t)
  bSeen.add(s.b)
  if (s.b > frameIndexAt(SIX, CF - 1)) bWraps = false
  if (s.a <= s.b) bWraps = false
}
check('crossfade blends the tail toward the head of the clip',
  bWraps && atFadeStart.b === 0,
  `tail a=${atFadeStart.a}..${atEnd.a}, head b=[${[...bSeen].join(',')}]`)

// A cut inside a frame keeps that frame whole, so the loop always ends on a real
// frame boundary: 250ms off a 6x100ms clip drops two frames, not two and a half.
const trims = [300, 250, 350].map((ms) => loopPlan(SIX, { mode: 'none', trimEndMs: ms }).duration)
check('mode none snaps a trim outward to a frame boundary',
  trims[0] === 300 && trims[1] === 400 && trims[2] === 300,
  `trim 300/250/350ms -> ${trims.join('/')}ms of a ${D}ms clip`)

// ---------------------------------------------------------- 5. seam metric --

const cleanSpecs = [{ p: 0 }, { p: 1 }, { p: 2 }, { p: 3 }, { p: 4 }, { p: 0 }]
const brokenSpecs = [{ p: 0 }, { p: 1 }, { p: 2 }, { p: 3 }, { p: 4 }, { p: 0, invert: true }]
const cleanSeam = loopSeam(SIX.frames, samplerFor(cleanSpecs))
const brokenSeam = loopSeam(SIX.frames, samplerFor(brokenSpecs))
check('loopSeam scores a perfect loop near zero', cleanSeam.ok && cleanSeam.score < 0.001,
  `score = ${cleanSeam.score.toFixed(5)}`)
check('loopSeam scores a broken loop clearly higher',
  brokenSeam.ok && brokenSeam.score > cleanSeam.score + 0.1,
  `broken ${brokenSeam.score.toFixed(5)} vs clean ${cleanSeam.score.toFixed(5)} ` +
  `(${(brokenSeam.score / Math.max(cleanSeam.score, 1e-9)).toExponential(1)}x)`)

// ------------------------------------------------------ 6. trim suggestion --

// Nine frames that loop cleanly (frame 8 == frame 0) with three junk frames
// stapled on the end — exactly the "recorded a few frames too many" case.
const junkSpecs = [
  { p: 0 }, { p: 1 }, { p: 2 }, { p: 3 }, { p: 4 }, { p: 5 }, { p: 6 }, { p: 7 },
  { p: 0 },
  { p: 40 }, { p: 41 }, { p: 42 },
]
const junkAsset = makeAsset(junkSpecs.map(() => 100))
const junkSeam = loopSeam(junkAsset.frames, samplerFor(junkSpecs))
check('loopSeam recovers the 3 appended junk frames',
  junkSeam.ok && junkSeam.bestTrimFrames === 3,
  `bestTrimFrames=${junkSeam.bestTrimFrames} bestScore=${junkSeam.bestScore.toFixed(5)} ` +
  `seam=${junkSeam.score.toFixed(5)}`)

// -------------------------------------------------------- 7. suggestLoop -----

const sugTrim = suggestLoop(junkAsset, samplerFor(junkSpecs))
check('suggestLoop prefers a trim over a blend when a loop point exists',
  sugTrim.mode === 'none' && sugTrim.trimEndMs === 300,
  `mode=${sugTrim.mode} trimEndMs=${sugTrim.trimEndMs} :: ${sugTrim.note}`)

const sugClean = suggestLoop(SIX, samplerFor(cleanSpecs))
check('suggestLoop leaves a clean loop alone',
  sugClean.mode === 'none' && sugClean.trimEndMs === 0 && /already loops/i.test(sugClean.note),
  `${sugClean.note}`)

const sugBroken = suggestLoop(SIX, samplerFor(brokenSpecs))
check('suggestLoop does not call a bad seam good',
  sugBroken.mode !== 'none' && !/already loops/i.test(sugBroken.note),
  `mode=${sugBroken.mode} :: ${sugBroken.note}`)

const nudgedSpecs = [{ p: 0 }, { p: 1 }, { p: 2 }, { p: 3 }, { p: 4 }, { p: 0, shift: 30 }]
const sugFade = suggestLoop(SIX, samplerFor(nudgedSpecs))
check('suggestLoop asks for a crossfade on a middling seam',
  sugFade.mode === 'crossfade' && sugFade.crossfadeMs > 0,
  `${sugFade.crossfadeMs}ms :: ${sugFade.note}`)

const sugBlind = suggestLoop(SIX, () => null)
check('suggestLoop admits it when the pixels cannot be measured',
  sugBlind.mode === 'none' && /unmeasured/i.test(sugBlind.note),
  `${sugBlind.note}`)

// --------------------------------------------------------------- summary ----

const failed = checks.filter(([, ok]) => !ok)
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`)
if (failed.length) {
  console.log('FAILED: ' + failed.map(([n]) => n).join(', '))
  process.exit(1)
}
