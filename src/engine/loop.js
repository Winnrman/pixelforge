// Loop repair for GIF and video clips: a clip that does not loop cleanly is made
// to loop again. Every repair is expressed as a *time remap* plus an optional
// two-frame blend, so nothing is ever baked back into the decoded asset — the
// document keeps the original frames and the repair stays a reversible setting.
//
// Nothing here touches the DOM or a canvas. Pixels arrive through a
// caller-supplied `sampleRGBA(index) -> {data, width, height}` so the quality
// metric can run under a bare node process as well as in the app.

/**
 * Frame index for a time inside an asset's own timeline.
 *
 * Deliberately a copy of render.js's `frameIndexAt` instead of an import:
 * render.js pulls in canvas, effects and matte code, and this module has to stay
 * runnable outside a browser. `cum` holds cumulative end times, so frame k
 * occupies [cum[k-1], cum[k]).
 */
function frameIndex(cum, t, n) {
  if (n <= 1) return 0
  let lo = 0
  let hi = n - 1
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (t < cum[mid]) hi = mid
    else lo = mid + 1
  }
  return lo
}

function wrap(t, span) {
  if (!(span > 0)) return 0
  return ((t % span) + span) % span
}

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v)

/**
 * Maps a time on the ping-pong timeline onto a forward-then-backward pass of the
 * source.
 *
 * ENDPOINT HANDLING — this is the whole point of the function. A naive triangle
 * wave (`duration - |duration - (t mod 2*duration)|`) plays the first and last
 * frame for *two* frame-widths each, once on the way up and once on the way
 * down. That double-width hold at each turnaround is the classic ping-pong
 * stutter. To remove it the reverse pass has to exclude both endpoints, so it
 * carries only frames 1..n-2 and the period shrinks by one frame at each end:
 *
 *   period = 2 * duration - 2 * frameMs      (for 6 frames: 0 1 2 3 4 5 4 3 2 1)
 *
 * `frameMs` is the width of the frames being deduplicated. It is optional
 * because the pure-time reading of ping-pong (frameMs = 0) is still the exact
 * symmetric triangle; only a frame-quantised source needs the correction, and
 * loopPlan passes the real delay in. GIF delays are effectively always uniform,
 * so one width is used at both turnarounds.
 *
 * Consequences worth knowing:
 * - speed is |dt'/dt| = 1 everywhere, so motion never slows near a turnaround
 * - the remap steps back by exactly one frame width at each turnaround. That
 *   step is not a visible jump: it is what keeps the turnaround frame on screen
 *   for one frame-width instead of two. Sampled anywhere inside a frame slot
 *   (its centre, say) the index sequence never repeats.
 */
export function pingPongTime(t, duration, frameMs = 0) {
  if (!(duration > 0)) return 0
  const f = clamp(frameMs || 0, 0, duration / 2)
  const period = 2 * duration - 2 * f
  if (!(period > 0)) return 0
  const u = wrap(t, period)
  // Forward pass covers the whole source, including the last frame.
  if (u < duration) return u
  // Reverse pass runs at the same speed but re-enters one frame below the top,
  // so it spans (f, duration - f] and touches neither endpoint frame again.
  return 2 * duration - f - u
}

/**
 * Builds a loop from an asset and a repair choice.
 *
 * `opts` is `{ mode: 'none'|'pingpong'|'crossfade', crossfadeMs, trimEndMs }`.
 * Returns `{ mode, duration, sample(t) }` where `sample(t)` is
 * `{ a, b, mix }` — draw frame `a`, and if `mix > 0` draw frame `b` over it at
 * that alpha. `mix === 0` with `b === a` means "no blend needed", which is the
 * answer for every mode except inside a crossfade window.
 */
export function loopPlan(asset, opts = {}) {
  const mode = opts.mode || 'none'
  const frames = asset?.frames || []
  const cum = asset?.cum || []
  const total = asset?.duration || 0

  // trimEndMs snaps to a frame boundary — you cannot show half a decoded frame.
  // A cut that lands inside a frame keeps that whole frame: under-trimming is
  // the recoverable mistake, and the auto-repair path always passes an exact
  // frame boundary anyway (suggestLoop derives it from a frame count).
  const wantEnd = Math.max(0, total - Math.max(0, opts.trimEndMs || 0))
  let n = frames.length
  while (n > 1 && cum[n - 2] >= wantEnd) n--
  const D = n > 0 ? cum[n - 1] : total
  const idx = (t) => frameIndex(cum, wrap(t, D), n)

  if (!(D > 0) || n === 0) {
    return { mode, duration: 0, sample: () => ({ a: 0, b: 0, mix: 0 }) }
  }

  if (mode === 'pingpong') {
    // One frame width is deduplicated at each turnaround; with per-frame delays
    // the tail frame's width is the one that matters for where the reverse pass
    // re-enters, and GIF delays are uniform in practice.
    const tail = n > 1 ? D - cum[n - 2] : D
    const period = Math.max(D, 2 * D - 2 * tail)
    return {
      mode,
      duration: period,
      sample: (t) => {
        const a = idx(pingPongTime(t, D, tail))
        return { a, b: a, mix: 0 }
      },
    }
  }

  if (mode === 'crossfade') {
    // A fade cannot be longer than half the clip or the head and the tail would
    // overlap each other twice.
    const cf = clamp(opts.crossfadeMs || 0, 0, D / 2)
    if (cf > 0) {
      // WHY THE DURATION SHRINKS: the last `cf` of the source is never shown on
      // its own again — it is dissolved on top of the first `cf`, so those two
      // windows occupy the same slice of the new timeline and the loop is
      // `D - cf` long. Reporting `D` here is the mistake that makes a
      // "repaired" clip hitch: the player would wait out a stretch of timeline
      // whose frames have already been consumed by the blend.
      const L = D - cf
      const fadeStart = L - cf
      return {
        mode,
        duration: L,
        sample: (t) => {
          const tt = wrap(t, L)
          // The fade is parked at the *end* of the reported timeline (the plain
          // stretch is rotated forward by `cf`) so that a player starting at
          // t = 0 opens on a clean, unblended frame.
          if (tt < fadeStart) {
            const a = idx(tt + cf)
            return { a, b: a, mix: 0 }
          }
          const u = tt - fadeStart
          return { a: idx(D - cf + u), b: idx(u), mix: u / cf }
        },
      }
    }
  }

  return {
    mode: 'none',
    duration: D,
    sample: (t) => {
      const a = idx(t)
      return { a, b: a, mix: 0 }
    },
  }
}

// Comparing every pixel of a 1080p frame to score a seam is wasted work; a few
// thousand evenly spread samples put the mean within a fraction of a percent.
const MAX_SAMPLES = 20000
// How far back to hunt for a better loop point. Beyond a dozen frames a "trim"
// stops being a repair and starts being an edit the user did not ask for.
const LOOK_BACK = 12

/** Mean absolute RGBA difference of two frames, 0..1. null when uncomparable. */
function meanAbsDiff(a, b) {
  if (!a?.data || !b?.data) return null
  if (a.width !== b.width || a.height !== b.height) return null
  const len = Math.min(a.data.length, b.data.length)
  const px = len >> 2
  if (px < 1) return null
  const stride = Math.max(1, Math.ceil(px / MAX_SAMPLES))
  let sum = 0
  let count = 0
  for (let p = 0; p < px; p += stride) {
    const o = p * 4
    sum += Math.abs(a.data[o] - b.data[o]) +
      Math.abs(a.data[o + 1] - b.data[o + 1]) +
      Math.abs(a.data[o + 2] - b.data[o + 2]) +
      Math.abs(a.data[o + 3] - b.data[o + 3])
    count++
  }
  // Alpha is included: a GIF whose transparency shifts across the seam pops just
  // as badly as one whose colour does.
  return sum / (count * 4 * 255)
}

/**
 * Scores how badly a clip fails to loop, so the UI can say "this needs 180ms of
 * crossfade" instead of making the user guess.
 *
 * `sampleRGBA(index)` returns `{data, width, height}` for a frame; keeping pixel
 * access on the caller is what lets this run without a canvas.
 *
 * Returns `{ score, bestTrimFrames, bestScore, ok }`:
 * - `score`      last frame vs first frame, 0 (identical) .. 1 (inverted)
 * - `bestTrimFrames` how many frames to drop off the end so the *best* match to
 *   frame 0 becomes the last frame — an auto-repair can trim instead of always
 *   crossfading
 * - `bestScore`  that best frame's score
 * - `ok`         false when the pixels could not be read or compared at all, so
 *   callers can say "unmeasured" rather than reporting a flattering 0
 */
/**
 * Typical frame-to-frame change within the clip.
 *
 * This is what makes the seam score mean anything. A mean absolute difference
 * is dominated by how much of the frame moves, so a small subject travelling
 * across a static background produces a *tiny* absolute seam even when the jump
 * is glaring — a disc crossing a whole frame measures under 2%, which would be
 * called "already loops" on an absolute threshold. Comparing the seam against
 * the clip's own motion asks the right question instead: is the wrap a bigger
 * jump than an ordinary frame step? Sampled at a dozen points rather than every
 * pair, which is plenty for a median and keeps long clips cheap.
 */
function typicalStep(n, sampleRGBA) {
  const steps = []
  const stride = Math.max(1, Math.floor((n - 1) / 12))
  for (let i = 0; i + 1 < n && steps.length < 12; i += stride) {
    const d = meanAbsDiff(sampleRGBA(i), sampleRGBA(i + 1))
    if (d !== null) steps.push(d)
  }
  if (!steps.length) return null
  steps.sort((a, b) => a - b)
  return steps[steps.length >> 1]
}

export function loopSeam(frames, sampleRGBA) {
  const unknown = { score: 0, bestTrimFrames: 0, bestScore: 0, motion: 0, ratio: 0, ok: false }
  const n = frames?.length || 0
  if (n < 2 || typeof sampleRGBA !== 'function') return unknown

  const head = sampleRGBA(0)
  const score = meanAbsDiff(head, sampleRGBA(n - 1))
  if (score === null) return unknown

  const motion = typicalStep(n, sampleRGBA)
  // A perfectly still clip has no motion to compare against, so the ratio is
  // left at 0 and the absolute score decides on its own.
  const ratio = motion && motion > 1e-6 ? score / motion : 0

  let bestScore = score
  let bestTrimFrames = 0
  const lo = Math.max(1, n - LOOK_BACK)
  // Walk backwards with a strict improvement test so ties keep the shallowest
  // trim — never throw away frames for a match we already had.
  for (let k = n - 2; k >= lo; k--) {
    const d = meanAbsDiff(head, sampleRGBA(k))
    if (d === null) continue
    if (d < bestScore) {
      bestScore = d
      bestTrimFrames = n - 1 - k
    }
  }
  return { score, bestTrimFrames, bestScore, motion: motion || 0, ratio, ok: true }
}

// A seam under ~2% mean error is invisible in motion; over ~25% the two ends of
// the clip are simply different pictures and dissolving one into the other reads
// as a smear rather than a loop.
const CLEAN = 0.02
const HARSH = 0.25
// ...but absolute error alone misses a small subject on a static background, so
// a wrap that jumps more than about twice an ordinary frame step counts as a
// pop however small it measures. 1.0 would be a perfect loop; the fixtures
// measure ~1.1 for a clip that loops and ~3.5 for one that does not, so 2.0
// sits well clear of both.
const CLEAN_RATIO = 2.0

/**
 * Turns the metric into a recommendation: `{ mode, crossfadeMs, trimEndMs, note }`.
 *
 * `note` is one honest sentence for the UI. It never claims a clip loops well on
 * a high seam score, and when the pixels cannot be measured it says so instead
 * of inventing a repair.
 */
export function suggestLoop(asset, sampleRGBA) {
  const frames = asset?.frames || []
  const cum = asset?.cum || []
  const n = frames.length
  const D = asset?.duration || 0
  const none = (note) => ({ mode: 'none', crossfadeMs: 0, trimEndMs: 0, note })
  const pct = (x) => Math.round(x * 1000) / 10

  if (n < 3 || !(D > 0)) return none('Too few frames to judge a loop, so nothing was changed.')

  const seam = loopSeam(frames, sampleRGBA)
  if (!seam.ok) {
    return none('Could not read this clip’s pixels, so the seam is unmeasured — pick a repair by eye.')
  }

  const pops = seam.ratio > CLEAN_RATIO
  if (seam.score <= CLEAN && !pops) {
    return none(`This already loops: the last frame is only ${pct(seam.score)}% off the first.`)
  }

  // Trimming beats blending when a real loop point exists a few frames back —
  // it keeps every remaining frame pixel-exact instead of dissolving them.
  const trimMs = seam.bestTrimFrames > 0 ? D - cum[n - 1 - seam.bestTrimFrames] : 0
  const trimIsClean = seam.bestScore <= CLEAN
    && (!seam.motion || seam.bestScore / seam.motion <= CLEAN_RATIO)
  if (seam.bestTrimFrames > 0 && trimIsClean && trimMs <= D * 0.4) {
    return {
      mode: 'none',
      crossfadeMs: 0,
      trimEndMs: Math.round(trimMs),
      note: `Frame ${n - 1 - seam.bestTrimFrames} matches the first frame to ${pct(seam.bestScore)}%, so dropping the last ${seam.bestTrimFrames} frame(s) (${Math.round(trimMs)}ms) loops it with no blending at all.`,
    }
  }

  if (seam.score >= HARSH) {
    return {
      mode: 'pingpong',
      crossfadeMs: 0,
      trimEndMs: 0,
      note: `The clip ends somewhere completely different from where it starts (${pct(seam.score)}% off) and no earlier frame comes back — a crossfade would smear, so ping-pong is the safer repair.`,
    }
  }

  const meanFrame = D / n
  // Length follows the overshoot, not the raw error: a wrap that jumps three
  // ordinary frame steps needs about three frames of blend to cover it.
  const overshoot = seam.ratio > 1 ? seam.ratio : Math.max(1, seam.score / CLEAN)
  const want = Math.max(D * seam.score, meanFrame * overshoot)
  const cf = Math.max(20, Math.round(clamp(want, Math.min(2 * meanFrame, D * 0.25), D * 0.25) / 10) * 10)
  const borderline = seam.bestTrimFrames > 0 && seam.bestScore > CLEAN && seam.bestScore > seam.score * 0.6
  return {
    mode: 'crossfade',
    crossfadeMs: cf,
    trimEndMs: 0,
    note: borderline
      ? `The seam is ${pct(seam.score)}% off and no frame near the end matches the start much better (best ${pct(seam.bestScore)}%), so this is a judgement call — about ${cf}ms of crossfade is the safe guess.`
      : `The wrap jumps ${seam.ratio > 1.05 ? seam.ratio.toFixed(1) + '\u00d7 further than an ordinary frame step' : pct(seam.score) + '% off the first frame'}, which shows as a visible pop; about ${cf}ms of crossfade should hide it.`,
  }
}
