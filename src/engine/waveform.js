// Waveforms for the timeline.
//
// The point of drawing sound is to find a moment by eye — the start of a word,
// a beat, the gap before the next line — which needs shape, not fidelity. So the
// file is reduced once to a fixed number of buckets and every later draw
// resamples that summary. A 164-second clip has millions of samples and maybe
// nine hundred pixels to show them in; summarising per pixel on every redraw
// would re-read the whole buffer each time the panel is dragged.
//
// Peaks rather than averages. An average of a loud symmetric waveform tends to
// zero, so averaging draws silence over the loudest passage — the one thing the
// picture exists to show.

/** Buckets per asset. Far more than any timeline is wide, so resampling is
 *  always a reduction and never an interpolation of invented detail. */
const BUCKETS = 4096

const cache = new WeakMap()

/**
 * The summary for an asset: one magnitude per bucket, 0..1.
 *
 * Computed on first ask and kept on the asset's behalf in a WeakMap, so it goes
 * away with the asset rather than pinning a decoded buffer alive.
 */
function summaryFor(asset) {
  if (!asset?.audio) return null
  const hit = cache.get(asset.audio)
  if (hit) return hit

  const buf = asset.audio
  const peak = new Float32Array(BUCKETS)
  const rms = new Float32Array(BUCKETS)
  const per = Math.max(1, Math.floor(buf.length / BUCKETS))
  // A fixed number of samples per bucket rather than a fixed stride. A stride
  // wide relative to the bucket lands on whatever phase it happens to hit: on a
  // 440Hz tone in a 43-sample bucket, stepping by 8 gives five readings inside
  // half a cycle and reports a tenth of the real amplitude. Sampling a set
  // number of points instead is exact for short buckets and still cheap for long
  // ones.
  const stride = Math.max(1, Math.floor(per / 64))
  // Every channel folded together: two channels drawn separately would say
  // something about stereo width, which is not what anyone reads a timeline
  // waveform for.
  for (let ch = 0; ch < buf.numberOfChannels; ch++) {
    const d = buf.getChannelData(ch)
    for (let b = 0; b < BUCKETS; b++) {
      const from = b * per
      const to = Math.min(d.length, from + per)
      let hi = 0
      let sum = 0
      let n = 0
      for (let i = from; i < to; i += stride) {
        const v = d[i] < 0 ? -d[i] : d[i]
        if (v > hi) hi = v
        sum += v * v
        n++
      }
      if (hi > peak[b]) peak[b] = hi
      const r = n ? Math.sqrt(sum / n) : 0
      if (r > rms[b]) rms[b] = r
    }
  }
  const out = { peak, rms }
  cache.set(buf, out)
  return out
}

/**
 * The peak envelope: how far the signal went, column by column.
 *
 * Kept because it is the outline of the sound, but it is not on its own a good
 * picture of one. Anything mastered in the last thirty years is compressed hard
 * enough that its peaks sit near maximum from end to end, and an envelope of
 * that is a solid block — technically true and useless for finding a word in it.
 */
export function peaksFor(asset) {
  return summaryFor(asset)?.peak ?? null
}

/**
 * The body of the sound: how loud it actually is, column by column.
 *
 * Root mean square rather than peak, which is what separates a shout from a
 * whisper when both clip the same ceiling. This is the shape you read a
 * waveform for, and drawing it inside the peak outline gives both — the reach
 * of the sound and the weight of it.
 */
export function bodyFor(asset) {
  return summaryFor(asset)?.rms ?? null
}

/** Whether a summary exists already, without computing one. */
export const hasPeaks = (asset) => !!(asset?.audio && cache.get(asset.audio))

/**
 * How much to scale a file's peaks by when drawing it.
 *
 * Plenty of real footage is quiet — phone audio, a distant mic — and at true
 * scale it draws as a flat line, which is exactly the material you most need to
 * see the shape of. So a quiet file is scaled up to fill the band.
 *
 * Capped, because without a limit a file containing only room tone gets
 * amplified into a dense band that looks like continuous speech. Past the cap a
 * quiet file stays visibly quiet, which is the honest answer.
 */
const MAX_GAIN = 8

export function gainFor(asset) {
  const peaks = peaksFor(asset)
  if (!peaks) return 1
  let loudest = 0
  for (let i = 0; i < peaks.length; i++) if (peaks[i] > loudest) loudest = peaks[i]
  if (!(loudest > 0)) return 1
  return Math.min(MAX_GAIN, 1 / loudest)
}

/**
 * Resamples the summary into `width` columns covering `[fromMs, toMs]` of the
 * source.
 *
 * Returns null when there is nothing to draw, so a caller can leave the space
 * alone rather than painting a flat line that looks like silence.
 */
export function columnsFor(asset, fromMs, toMs, width, which = 'peak') {
  const peaks = which === 'rms' ? bodyFor(asset) : peaksFor(asset)
  if (!peaks || !(width > 0)) return null
  const total = asset.audio.duration * 1000
  if (!(total > 0)) return null

  const gain = gainFor(asset)
  const out = new Float32Array(width)
  let loudest = 0
  for (let x = 0; x < width; x++) {
    const a = fromMs + ((toMs - fromMs) * x) / width
    const b = fromMs + ((toMs - fromMs) * (x + 1)) / width
    // Out of range is silence, not the nearest bucket. Clamping instead smears
    // the last moment of the file across everything past the end, which draws a
    // steady tone over a span where there is no sound at all.
    const lo = Math.floor((a / total) * BUCKETS)
    const hi = Math.ceil((b / total) * BUCKETS)
    let peak = 0
    if (hi > 0 && lo < BUCKETS) {
      const i0 = Math.max(0, lo)
      const i1 = Math.min(BUCKETS, Math.max(i0 + 1, hi))
      for (let i = i0; i < i1; i++) if (peaks[i] > peak) peak = peaks[i]
    }
    out[x] = Math.min(1, peak * gain)
    if (peak > loudest) loudest = peak
  }
  // Nothing at all in this span is worth saying so, rather than drawing a flat
  // line that reads as "silence here" when it may mean "not decoded yet".
  return loudest > 0.0005 ? out : null
}
