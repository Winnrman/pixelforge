// Cursor tracking for screen recordings, and the auto zoom/pan it drives.
//
// The Screen Studio effect: find where the mouse went, then move a virtual
// camera to follow it. Everything here is pure and DOM-free — frames arrive as
// plain `{ data, width, height }` RGBA buffers (an ImageData works, so does a
// hand-built object), and the output is keyframe tracks in the shape
// `src/engine/keyframes.js` already understands: `[{ t, v, ease }]`.
//
// There is no cursor template to correlate against the way `tracker.js` does —
// the pointer changes shape (arrow, I-beam, hand, spinner) and is different on
// every OS and theme. The one signal that survives all of that is motion: a
// screen recording is a mostly static image, and the small, fast, high-contrast
// thing that moves is nearly always the pointer. So this is frame differencing
// plus connected components plus a lot of rejection rules, and it borrows
// `tracker.js`'s two habits that matter most: grayscale planes for the pixel
// work, and reporting failure honestly instead of emitting confident nonsense.

// Defaults are per-frame-pair and tuned for a ~1080p desktop recording.
const DEFAULTS = {
  // Diff level (0..255 gray) that counts as "changed". Below ~20 the codec
  // noise in a real screen capture starts voting.
  threshold: 26,
  // A pointer is small. 48px on a side covers a 2x-scaled arrow on a HiDPI
  // capture with room to spare; anything bigger is a UI element, not a mouse.
  maxSize: 48,
  // Below this, it is sensor/codec noise or a text caret's stray pixels.
  minArea: 8,
  // Second, independent size gate: even a blob inside the bbox limit is not a
  // cursor if it is a meaningful share of the screen.
  maxAreaFrac: 0.01,
  // If this much of the frame changed at once, the frame is a scroll, a page
  // transition or a video playing — the cursor is in there somewhere but it is
  // not separable, and guessing would be worse than admitting it.
  maxChangedFrac: 0.25,
  // Soft locality weight, not a hard limit: a candidate this far from `hint`
  // is worth about half a candidate sitting on top of it.
  searchRadius: 260,
  // A blob this close to `hint` is probably the hole the cursor left behind
  // (see the two-blob problem in `pickCandidate`).
  ghostRadius: 40,
  // How much to trust "the pointer is the light part". See `blobCentroid`.
  lightBias: 0.6,
  // Mean diff magnitude (0..1) a blob must reach to be reported at all.
  minScore: 0.06,
}

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v)

/** Luma plane, same weights and layout as `tracker.js`'s `toGray`. */
function toGray(data, w, h) {
  const out = new Float32Array(w * h)
  for (let i = 0, p = 0; i < out.length; i++, p += 4) {
    out[i] = 0.299 * data[p] + 0.587 * data[p + 1] + 0.114 * data[p + 2]
  }
  return out
}

/**
 * Flood-fills every above-threshold run in `mask` into components.
 *
 * Iterative with an explicit stack — a recursive fill blows the JS stack on a
 * full-screen repaint, which is exactly the case this has to survive in order
 * to reject it. 8-connectivity, so a one-pixel-wide diagonal arrow edge does
 * not shatter into a dozen useless fragments.
 */
function components(mask, w, h) {
  const seen = new Uint8Array(w * h)
  const stack = new Int32Array(w * h)
  const out = []
  for (let start = 0; start < mask.length; start++) {
    if (!mask[start] || seen[start]) continue
    let sp = 0
    stack[sp++] = start
    seen[start] = 1
    let minX = w
    let minY = h
    let maxX = -1
    let maxY = -1
    let area = 0
    const px = []
    while (sp > 0) {
      const i = stack[--sp]
      const x = i % w
      const y = (i / w) | 0
      area++
      px.push(i)
      if (x < minX) minX = x
      if (x > maxX) maxX = x
      if (y < minY) minY = y
      if (y > maxY) maxY = y
      for (let dy = -1; dy <= 1; dy++) {
        const ny = y + dy
        if (ny < 0 || ny >= h) continue
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx
          if (nx < 0 || nx >= w) continue
          const ni = ny * w + nx
          if (mask[ni] && !seen[ni]) {
            seen[ni] = 1
            stack[sp++] = ni
          }
        }
      }
    }
    out.push({ px, area, minX, minY, maxX, maxY, w: maxX - minX + 1, h: maxY - minY + 1 })
  }
  return out
}

/**
 * Diff-weighted centroid of a blob, biased toward the bright pixels.
 *
 * Why the bias: a two-frame difference of a moving object lights up *both*
 * where it was and where it is. When the two overlap they merge into one blob
 * whose plain centroid sits halfway between the old and new positions, which
 * shows up as a permanent half-a-step lag. In the current frame the vacated
 * pixels hold background again while the occupied ones hold the pointer, and
 * every stock pointer is a light shape with a dark outline — so weighting by
 * luma pulls the centroid onto the new position. On a light background the
 * bias buys nothing and the answer degrades back to the midpoint; that is the
 * detector's main known weakness.
 */
function blobCentroid(c, diff, gray, w, lightBias) {
  let sw = 0
  let sx = 0
  let sy = 0
  let energy = 0
  for (const i of c.px) {
    const d = diff[i]
    energy += d
    const lum = gray[i] / 255
    const weight = d * (1 - lightBias + lightBias * lum)
    sw += weight
    sx += weight * (i % w)
    sy += weight * ((i / w) | 0)
  }
  if (sw <= 0) return null
  return {
    x: sx / sw,
    y: sy / sw,
    // Mean diff magnitude over the blob, 0..1. A crisp pointer against a
    // static desktop lands around 0.3-0.6; codec shimmer never gets close.
    score: energy / (c.area * 255),
  }
}

/**
 * Chooses among surviving blobs, given where the cursor was last seen.
 *
 * The two-blob problem: on a fast move the old and new positions no longer
 * overlap, so the frame yields two candidates of near-identical size and
 * contrast. Nearest-to-hint picks the one the cursor *left*, and the track then
 * lags a frame behind forever. So when the winner is sitting on top of `hint`,
 * it is handed over to its *twin* — a blob of comparable area and contrast
 * further away — because that pairing is the signature of one object having
 * jumped, and the blob still at the old address is its shadow.
 *
 * The handover is deliberately only to a twin, never to whatever else ranked
 * next. Measured: demoting the near blob generically let a blinking text caret
 * (small, high contrast, on the other side of the screen) steal the track on
 * the frames it toggled, throwing the path 300px off; requiring a lookalike
 * leaves it no way in, because a caret looks nothing like the pointer's blob.
 */
function twinOf(c, cands, hint, o) {
  let best = null
  for (const k of cands) {
    if (k === c) continue
    if (Math.hypot(k.x - hint.x, k.y - hint.y) <= o.ghostRadius) continue
    const ratio = k.area / c.area
    if (ratio < 0.5 || ratio > 2) continue
    if (k.score < c.score * 0.6) continue
    if (!best || k.score > best.score) best = k
  }
  return best
}

function pickCandidate(cands, hint, o) {
  let best = null
  for (const c of cands) {
    // Locality is a soft weight, never a hard window: a flick across the whole
    // screen has to stay recoverable.
    const weight = hint ? 1 / (1 + Math.hypot(c.x - hint.x, c.y - hint.y) / o.searchRadius) : 1
    const rank = c.score * weight
    if (!best || rank > best.rank) best = { ...c, rank }
  }
  if (!best || !hint) return best
  if (Math.hypot(best.x - hint.x, best.y - hint.y) > o.ghostRadius) return best
  return twinOf(best, cands, hint, o) || best
}

/**
 * Locates the cursor in one frame by differencing it against `prev`.
 *
 * `hint` is the last known position (`{ x, y }`) and only biases the choice
 * between candidates — it is never a hard search window, so a flick across the
 * screen is still recoverable.
 *
 * Returns `{ x, y, score, area }` or `null`. Null is the correct, honest answer
 * whenever the cursor did not move: a static pointer emits no signal at all in
 * a difference image, and there is nothing else in a screen recording that
 * says where it is. `cursorPath` fills those gaps by holding position.
 */
export function findCursor(frame, prev, hint = null, opts = {}) {
  const o = { ...DEFAULTS, ...opts }
  if (!frame?.data || !prev?.data) return null
  const w = frame.width
  const h = frame.height
  if (prev.width !== w || prev.height !== h) return null

  const a = toGray(frame.data, w, h)
  const b = toGray(prev.data, w, h)
  const n = w * h
  const diff = new Float32Array(n)
  const mask = new Uint8Array(n)
  let changed = 0
  for (let i = 0; i < n; i++) {
    const d = Math.abs(a[i] - b[i])
    if (d >= o.threshold) {
      diff[i] = d
      mask[i] = 1
      changed++
    }
  }
  if (changed === 0) return null
  // Whole-screen change: scroll, window switch, playing video. Bail before
  // component labelling, which would otherwise chew through the entire frame.
  if (changed > n * o.maxChangedFrac) return null

  const maxArea = n * o.maxAreaFrac
  const cands = []
  for (const c of components(mask, w, h)) {
    // Size is the whole defence against window repaints and dialogs. Both gates
    // are needed: bbox catches a compact 300x200 panel, area fraction catches a
    // sprawling thin region whose bbox happens to be small in one axis.
    if (c.area < o.minArea || c.area > maxArea) continue
    if (c.w > o.maxSize || c.h > o.maxSize) continue
    const p = blobCentroid(c, diff, a, w, o.lightBias)
    if (!p || p.score < o.minScore) continue
    cands.push({ ...p, area: c.area })
  }
  if (!cands.length) return null

  const best = pickCandidate(cands, hint, o)
  return best ? { x: best.x, y: best.y, score: best.score, area: best.area } : null
}

/**
 * Runs `findCursor` across a sequence and fills in the still moments.
 *
 * `frames` is either an array of `{ data, width, height }`, or a function
 * `(i) => frame` — in which case pass `opts.count`. The function form exists so
 * a caller can decode lazily instead of holding a whole recording in memory.
 *
 * Timing comes from `opts.times` (ms per frame) if given, else `opts.fps`
 * (default 30).
 *
 * Returns one entry per frame: `{ t, x, y, moving, confidence }`. `moving` is
 * false wherever the position was held over a gap, and `confidence` decays
 * across a long hold so downstream code can tell a one-frame pause from a
 * pointer that left the screen a second ago.
 *
 * This layer also gates implausible jumps. `findCursor` only ever sees two
 * frames, so on a frame where the pointer sat still and something *else* small
 * changed — a blinking text caret, a spinner, a notification badge — the only
 * blob on offer is the distractor and it will duly be reported. Measured on the
 * fixture: that single frame threw the raw path 310px off. Here there is
 * history and timing, so a sighting that implies more than `maxSpeed` px/s is
 * dropped in favour of holding — unless the same far region keeps showing up
 * for `relockFrames` in a row, which is what a genuine teleport (a cut, an
 * occlusion ending) looks like and must not strand the tracker forever.
 */
export function cursorPath(frames, opts = {}) {
  const fn = typeof frames === 'function'
  const count = fn ? (opts.count || 0) : (frames?.length || 0)
  const at = fn ? frames : (i) => frames[i]
  const fps = opts.fps || 30
  const timeOf = (i) => (opts.times ? opts.times[i] : (i * 1000) / fps)
  // Well above a real flick (~1500px/s) and below a screen-width teleport
  // between adjacent frames.
  const maxSpeed = opts.maxSpeed || 5000
  const relockFrames = opts.relockFrames || 3
  const relockRadius = opts.relockRadius || 60
  if (count === 0) return []

  const out = []
  let last = null
  let held = 0
  let pending = null
  let prev = at(0)
  for (let i = 0; i < count; i++) {
    const frame = i === 0 ? prev : at(i)
    let hit = i === 0 ? null : findCursor(frame, prev, last, opts)
    prev = frame

    if (hit && last && i > 0) {
      const dt = timeOf(i) - timeOf(i - 1)
      const jump = Math.hypot(hit.x - last.x, hit.y - last.y)
      if (dt > 0 && jump > (maxSpeed * dt) / 1000) {
        pending = pending && Math.hypot(hit.x - pending.x, hit.y - pending.y) <= relockRadius
          ? { x: hit.x, y: hit.y, n: pending.n + 1 }
          : { x: hit.x, y: hit.y, n: 1 }
        if (pending.n < relockFrames) hit = null
      } else {
        pending = null
      }
    }

    if (hit) {
      last = { x: hit.x, y: hit.y }
      held = 0
      out.push({ t: timeOf(i), x: hit.x, y: hit.y, moving: true, confidence: hit.score })
    } else if (last) {
      held++
      out.push({
        t: timeOf(i),
        x: last.x,
        y: last.y,
        moving: false,
        // Halves every ~10 held frames: still credible for a pause, clearly
        // stale after a few seconds of nothing.
        confidence: Math.exp(-held / 14),
      })
    } else {
      // Nothing found yet and nowhere to hold from. Centre is a placeholder,
      // flagged with zero confidence so it is never mistaken for a sighting.
      const f = at(i)
      out.push({ t: timeOf(i), x: f.width / 2, y: f.height / 2, moving: false, confidence: 0 })
    }
  }

  // Backfill the leading placeholders with the first real sighting, so the
  // camera starts already pointing at the cursor instead of sliding in from the
  // middle of the screen.
  const first = out.findIndex((p) => p.confidence > 0)
  if (first > 0) {
    for (let i = 0; i < first; i++) {
      out[i] = { ...out[i], x: out[first].x, y: out[first].y }
    }
  }
  return out
}

/**
 * Turns the raw path into something a camera can follow without inducing
 * motion sickness.
 *
 * Two mechanisms, and the second one matters far more than the first:
 *
 *  - `lag`: a critically damped spring (no overshoot, ever — an overshooting
 *    camera reads as drunk) pulling the camera toward the cursor. The camera
 *    trails slightly, which is what makes the move look intentional rather
 *    than glued.
 *  - `deadZone`: while the cursor stays within this many pixels of the camera
 *    centre, the camera does not move *at all*. This is the important one.
 *    Smoothing alone still produces continuous low-amplitude drift, and a
 *    frame that is always gently sliding is precisely what makes a zoomed
 *    screencast nauseating to watch — the eye has no stable reference. A dead
 *    zone gives it hard stops: the camera is either parked or deliberately
 *    moving. Halving `lag` improves the feel a little; removing the dead zone
 *    ruins it.
 *
 * The pull uses the *excess* distance beyond the dead zone, so the camera
 * eases out of a stop instead of snapping the moment the boundary is crossed.
 */
export function smoothPath(path, { lag = 140, deadZone = 26 } = {}) {
  if (!path?.length) return []
  if (path.length === 1) return [{ ...path[0] }]

  // A critically damped follower trails a constant-velocity target by exactly
  // 2/w seconds of its travel, so w = 2/lag makes `lag` mean what it says: the
  // camera is `lag` milliseconds behind the cursor during a steady move. At the
  // default 140ms that is ~180px behind a 1300px/s flick, which reads as
  // following rather than chasing.
  const w = 2000 / Math.max(1, lag)
  let cx = path[0].x
  let cy = path[0].y
  let vx = 0
  let vy = 0
  const out = [{ ...path[0], x: cx, y: cy }]

  for (let i = 1; i < path.length; i++) {
    const dt = Math.max(1, path[i].t - path[i - 1].t) / 1000
    const dx = path[i].x - cx
    const dy = path[i].y - cy
    const dist = Math.hypot(dx, dy)
    let tx = cx
    let ty = cy
    if (dist > deadZone) {
      const k = (dist - deadZone) / dist
      tx = cx + dx * k
      ty = cy + dy * k
    }
    // Exact discrete solution of a critically damped spring — stable at any
    // frame rate, unlike the naive `v += k*e*dt` form which explodes on a
    // dropped frame.
    const e = Math.exp(-w * dt)
    const stepX = (vx + w * (cx - tx)) * dt
    const stepY = (vy + w * (cy - ty)) * dt
    const nx = tx + (cx - tx + stepX) * e
    const ny = ty + (cy - ty + stepY) * e
    vx = (vx - w * stepX) * e
    vy = (vy - w * stepY) * e
    cx = nx
    cy = ny
    out.push({ ...path[i], x: cx, y: cy })
  }
  return out
}

/**
 * Douglas–Peucker over time, with error measured as linear-interpolation error
 * between the kept keys.
 *
 * Same reasoning as `simplifyTrack` in `tracker.js`: the keyframe system
 * replays these by lerping, so measuring the error the way it will actually be
 * replayed means everything dropped is provably within `tol` of the dense
 * curve — and what is left is short enough to hand-edit.
 */
function thin(samples, tol) {
  if (samples.length <= 2) return samples.slice()
  const keep = new Set([0, samples.length - 1])
  const walk = (a, b) => {
    if (b - a < 2) return
    const t0 = samples[a].t
    const t1 = samples[b].t
    const v0 = samples[a].v
    const v1 = samples[b].v
    let worst = -1
    let at = -1
    for (let i = a + 1; i < b; i++) {
      const u = t1 === t0 ? 0 : (samples[i].t - t0) / (t1 - t0)
      const err = Math.abs(samples[i].v - (v0 + (v1 - v0) * u))
      if (err > worst) {
        worst = err
        at = i
      }
    }
    if (worst > tol) {
      keep.add(at)
      walk(a, at)
      walk(at, b)
    }
  }
  walk(0, samples.length - 1)
  return [...keep].sort((a, b) => a - b).map((i) => samples[i])
}

/**
 * Speed in px/s measured over a trailing window rather than frame to frame.
 *
 * Instantaneous speed is the wrong instrument here. This normally runs on a
 * path that has already been through `smoothPath`, whose whole job is to
 * flatten single-frame excursions, so a per-frame difference under-reports a
 * flick badly (measured: ~800px/s for a move the cursor made at 1300px/s). A
 * ~120ms window is long enough to survive the smoothing and short enough to
 * still react inside a flick.
 */
function speedAt(path, i, ms) {
  if (i === 0) return 0
  let j = i
  while (j > 0 && path[i].t - path[j - 1].t <= ms) j--
  const dt = path[i].t - path[j].t
  if (dt <= 0) return 0
  return (Math.hypot(path[i].x - path[j].x, path[i].y - path[j].y) * 1000) / dt
}

/** True when every sample within `ms` before `i` sat inside `radius` of it. */
function dwellingAt(path, i, ms, radius) {
  const p = path[i]
  for (let j = i; j >= 0; j--) {
    if (Math.hypot(path[j].x - p.x, path[j].y - p.y) > radius) return false
    if (p.t - path[j].t >= ms) return true
  }
  return false
}

/**
 * Builds editable zoom/pan tracks from a (preferably smoothed) cursor path.
 *
 * Returns `{ zoom, panX, panY }` in this app's `sourceRect()` convention:
 * `zoom > 1` pushes in, and pan is a signed fraction of the source window, so
 * -0.5..0.5 spans the whole frame and `panX = x / width - 0.5` centres on a
 * pixel column.
 *
 * The behaviour:
 *  - Dwell longer than `dwellMs` inside `dwellRadius` and the camera pushes in
 *    to `zoom`. Dwelling is where the interesting thing is happening.
 *  - Move faster than `flickSpeed` and it pulls straight back out to 1. You
 *    cannot follow a fast flick at 2x: the visible window is half the screen,
 *    so a pointer crossing at 2000px/s traverses the entire frame in a couple
 *    of hundred milliseconds and the result is an unwatchable whip pan. Zooming
 *    out keeps the destination in shot and lets the viewer keep their bearings.
 *  - The zoom filter is deliberately asymmetric: pulling out is quick
 *    (`zoomOutMs`) because it must beat the flick it is reacting to, pushing in
 *    is slow (`zoomInMs`) because a leisurely push reads as confident.
 *
 * Pan is clamped so the zoom window never leaves the frame. `sourceRect` clamps
 * too, but doing it here means the emitted keyframes say where the camera
 * actually ends up rather than describing an off-screen position that the
 * renderer silently corrects.
 *
 * Keyframes are thinned to `zoomTol` (0.01 zoom units — 1% of frame scale,
 * invisible) and `panTol` (0.004 of the frame, ~4px on a 1080p capture, which
 * is a sixth of the dead zone and so cannot change how the move reads).
 * Emitted with `ease: 'linear'` because linear is exactly the interpolation the
 * tolerance was measured against — the same argument `simplifyTrack` makes.
 */
export function autoZoomTracks(path, {
  width = 1920,
  height = 1080,
  zoom = 2,
  // 'follow' stays zoomed in and only pulls out to cross the screen, which is
  // what a screen recording usually wants: the pointer is the subject nearly
  // all the time. 'dwell' is the cautious opposite — out by default, in only
  // once the pointer settles.
  mode = 'follow',
  dwellMs = 400,
  dwellRadius = 80,
  flickSpeed = 900,
  // Coming back in needs a clearly slower pointer than going out did, or a
  // cursor hovering either side of the threshold makes the camera chatter.
  settleSpeed = 520,
  speedWindowMs = 120,
  lookAheadMs = 250,
  zoomInMs = 450,
  zoomOutMs = 140,
  zoomTol = 0.01,
  panTol = 0.004,
} = {}) {
  if (!path?.length) return { zoom: [], panX: [], panY: [] }

  // This runs on a finished recording, so the flick can be *anticipated*
  // instead of reacted to: every sample within `lookAheadMs` before a fast one
  // is marked as flicking too, and the camera starts easing out before the
  // pointer takes off. Purely reactive pull-out was measured on the fixture at
  // 1.68x by the middle of the flick — still half zoomed in through the fastest
  // part of the move, which is exactly the unwatchable case. Anticipating gets
  // it to ~1.1x by the same instant, and it reads as authored rather than
  // startled.
  const flicking = path.map((_, i) => speedAt(path, i, speedWindowMs) > flickSpeed)
  const anticipated = flicking.slice()
  for (let i = 0; i < path.length; i++) {
    if (!flicking[i]) continue
    for (let j = i - 1; j >= 0 && path[i].t - path[j].t <= lookAheadMs; j--) anticipated[j] = true
  }

  const zSamples = []
  const xSamples = []
  const ySamples = []
  // 'follow' opens already zoomed in rather than diving in over the first
  // half-second, which reads as a mistake being corrected.
  let z = mode === 'dwell' ? 1 : zoom
  let desired = z

  for (let i = 0; i < path.length; i++) {
    const p = path[i]
    const dt = i === 0 ? 0 : Math.max(1, p.t - path[i - 1].t)

    if (mode === 'dwell') {
      // Out by default, in only once the pointer settles. Between the two the
      // previous intent stands, so an ordinary slow drag neither yanks the
      // camera out nor pushes it in.
      if (anticipated[i]) desired = 1
      else if (dwellingAt(path, i, dwellMs, dwellRadius)) desired = zoom
    } else {
      // In by default. Only a genuinely fast move pulls out, and it has to slow
      // well below the threshold that triggered it before coming back — one
      // threshold on its own leaves the camera pumping whenever the pointer
      // drifts across it.
      if (anticipated[i]) desired = 1
      else if (desired < zoom && speedAt(path, i, speedWindowMs) < settleSpeed) desired = zoom
      else if (desired >= zoom) desired = zoom
    }

    if (i > 0) {
      const tau = desired > z ? zoomInMs : zoomOutMs
      z += (desired - z) * (1 - Math.exp(-dt / tau))
    } else {
      z = desired
    }

    // Half the visible window in normalized units; the centre cannot go closer
    // to an edge than this without exposing outside the frame.
    const limit = Math.max(0, 0.5 - 1 / (2 * Math.max(1, z)))
    zSamples.push({ t: p.t, v: z })
    xSamples.push({ t: p.t, v: clamp(p.x / width - 0.5, -limit, limit) })
    ySamples.push({ t: p.t, v: clamp(p.y / height - 0.5, -limit, limit) })
  }

  const key = (s) => ({ t: Math.round(s.t), v: s.v, ease: 'linear' })
  return {
    zoom: thin(zSamples, zoomTol).map(key),
    panX: thin(xSamples, panTol).map(key),
    panY: thin(ySamples, panTol).map(key),
  }
}
