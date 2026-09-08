// MP4 import.
//
// The rest of the app assumes `renderDocument(ctx, doc, t)` is synchronous and
// that every frame is available. That holds for GIFs, where decoding everything
// up front costs a few megabytes. It cannot hold for video: ten seconds of
// 1080p30 as raw bitmaps is about 2.5GB.
//
// So video keeps the *timing* of every frame up front — cheap, and enough for
// the timeline, keyframe sampling and export planning — while the pixels live in
// a bounded LRU cache. `frameAt` is synchronous and returns the nearest frame it
// has; `ensureDecoded` fills the cache around a time. During a scrub that can
// mean showing a neighbouring frame for a moment, which is invisible. Export
// awaits the exact frame, so it stays frame-accurate.

import { createFile, DataStream, Endianness } from 'mp4box'

/** Roughly how many pixels of decoded frames to keep. ~380MB at 4 bytes each. */
const CACHE_PIXEL_BUDGET = 96_000_000

export const isVideoFile = (file) =>
  /^video\//.test(file.type || '') || /\.(mp4|m4v|mov)$/i.test(file.name || '')

export const webCodecsAvailable = () =>
  typeof VideoDecoder !== 'undefined' && typeof EncodedVideoChunk !== 'undefined'

/**
 * Demuxes an MP4 into a sample table plus the metadata a decoder needs.
 * Nothing is decoded here — this is only the index.
 */
function demux(buffer) {
  return new Promise((resolve, reject) => {
    const file = createFile()
    let info = null

    file.onError = (e) => reject(new Error('Could not read this MP4: ' + e))
    file.onReady = (i) => {
      info = i
      const track = i.videoTracks?.[0]
      if (!track) { reject(new Error('That file has no video track')); return }
      file.setExtractionOptions(track.id, null, { nbSamples: Number.MAX_SAFE_INTEGER })
      file.start()
    }
    file.onSamples = (id, _user, samples) => {
      const track = info.videoTracks.find((t) => t.id === id)
      const scale = track.timescale
      const entry = file.getTrackById(id)?.mdia?.minf?.stbl?.stsd?.entries?.[0]
      const box = entry?.avcC || entry?.hvcC || entry?.vpcC || entry?.av1C
      let description = null
      if (box) {
        // H.264/H.265 in an MP4 needs its parameter sets, which live in the
        // avcC/hvcC box. Without them the decoder configures and then silently
        // produces nothing. Re-serialise the box and strip its 8-byte header.
        const ds = new DataStream(undefined, 0, Endianness.BIG_ENDIAN)
        box.write(ds)
        description = new Uint8Array(ds.buffer, 8)
      }

      // Kept in *decode* order, exactly as the file stores them. With B-frames
      // the presentation order differs, and feeding a decoder frames sorted by
      // presentation time is simply invalid input — it fails with a bare
      // "Decoding error". Presentation order is expressed separately, as an
      // index, so both are available without reordering the data.
      const table = samples.map((s) => ({
        data: s.data,
        timeUs: Math.round((s.cts / scale) * 1e6),
        durationUs: Math.round((s.duration / scale) * 1e6),
        isSync: !!s.is_sync,
      }))
      const order = table.map((_, i) => i).sort((a, b) => table[a].timeUs - table[b].timeUs)

      resolve({
        codec: track.codec,
        description,
        width: track.track_width || track.video?.width,
        height: track.track_height || track.video?.height,
        durationMs: (info.duration / info.timescale) * 1000,
        samples: table,
        order,
      })
    }

    buffer.fileStart = 0
    file.appendBuffer(buffer)
    file.flush()
  })
}

/**
 * Decode accounting, for diagnosing playback that stalls.
 *
 * `chunks` counts samples handed to the decoder and `shown` counts frames the
 * cache actually kept. The ratio between them is the thing worth watching: it is
 * how much work is being thrown away, and on a long video with a long GOP it is
 * where playback goes.
 */
export const decodeStats = { chunks: 0, kept: 0, passes: 0, scans: 0 }
export const resetDecodeStats = () => {
  decodeStats.chunks = 0
  decodeStats.kept = 0
  decodeStats.passes = 0
  decodeStats.scans = 0
}

/** Bounded cache of decoded frames, evicted furthest-from-playhead first. */
function makeCache(width, height) {
  const limit = Math.max(12, Math.floor(CACHE_PIXEL_BUDGET / Math.max(1, width * height)))
  return { map: new Map(), limit }
}

function trim(cache, aroundIndex) {
  if (cache.map.size <= cache.limit) return
  // Frames behind the playhead are worth a third of the ones ahead of it:
  // playback is going forwards, so a frame already shown will most likely not be
  // wanted again, while one just ahead certainly will. Weighting them equally
  // spends half the cache on the past.
  const cost = (i) => (i >= aroundIndex ? i - aroundIndex : (aroundIndex - i) * 3)
  const keys = [...cache.map.keys()].sort((a, b) => cost(b) - cost(a))
  while (cache.map.size > cache.limit) {
    const k = keys.shift()
    if (k === undefined) break
    cache.map.get(k)?.close?.()
    cache.map.delete(k)
  }
}

export async function loadVideo(buffer, name, type) {
  if (!webCodecsAvailable()) {
    throw new Error('This browser cannot decode video (WebCodecs is unavailable)')
  }
  const meta = await demux(buffer)
  // Everything outside this module thinks in presentation order.
  const shown = meta.order.map((i) => meta.samples[i])
  // B-frame reordering pushes the first composition time forward — for a clip
  // with two reference frames it starts at 83ms, not 0 — and a player hides that
  // with the container's edit list. Rebasing to zero does the same job: the
  // document timeline starts at the first frame, where anyone would expect it.
  const baseMs = shown.length ? shown[0].timeUs / 1000 : 0
  const times = shown.map((s) => s.timeUs / 1000 - baseMs)
  const cum = []
  let t = 0
  for (const s of shown) {
    t += s.durationUs / 1000
    cum.push(t)
  }
  const duration = cum.length ? cum[cum.length - 1] : meta.durationMs

  // Two lookups the decoder needs constantly, computed once here instead of by
  // scanning the sample table on every call. On a 48,000-frame clip that scan
  // was 96,000 iterations per decode; at playback rates it is most of a core.
  //
  //   syncBefore[p]  the keyframe to start decoding from to reach frame p
  //   maxDecode[p]   the last sample in *decode* order needed to cover frame p
  //
  // Both are running maxima taken in presentation order, which is exactly what
  // the scans were computing the long way. They differ because B-frames make
  // decode order and presentation order disagree.
  const n = meta.order.length
  const syncBefore = new Int32Array(n)
  const maxDecode = new Int32Array(n)
  let bestSync = 0
  let bestDecode = 0
  for (let p = 0; p < n; p++) {
    const d = meta.order[p]
    if (d > bestDecode) bestDecode = d
    if (meta.samples[d].isSync && d > bestSync) bestSync = d
    syncBefore[p] = bestSync
    maxDecode[p] = bestDecode
  }

  const config = { codec: meta.codec, codedWidth: meta.width, codedHeight: meta.height }
  if (meta.description) config.description = meta.description
  // Asked once, at import, so an unsupported codec is reported when the file is
  // opened rather than as a blank canvas the first time it is played.
  const support = await VideoDecoder.isConfigSupported(config).catch(() => null)
  if (!support?.supported) {
    throw new Error(`This browser cannot decode ${meta.codec}. Try an H.264 (avc1) MP4.`)
  }

  return {
    name,
    type,
    width: meta.width,
    height: meta.height,
    animated: meta.samples.length > 1,
    isVideo: true,
    duration,
    // Frame *timing* only. Bitmaps live in `cache` and are decoded on demand,
    // so the timeline and export planner can work without touching the codec.
    frames: shown.map((s) => ({ delay: s.durationUs / 1000 })),
    times,
    cum,
    baseMs,
    video: meta,
    config,
    syncBefore,
    maxDecode,
    cache: makeCache(meta.width, meta.height),
    // The live forward-decoding run, and the promise for the exact-frame path.
    dec: null,
    decoding: null,
  }
}

/** Starts filling the cache from the beginning, so the first frame is ready
 *  before anyone presses play rather than after. */
export function prewarm(asset) {
  if (asset?.isVideo) ensureDecoded(asset, 0)
  return asset
}

/** Index of the frame visible at `ms`. */
export function indexAt(asset, ms) {
  const times = asset.times
  if (!times.length) return 0
  let lo = 0
  let hi = times.length - 1
  if (ms <= times[0]) return 0
  if (ms >= times[hi]) return hi
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (times[mid] <= ms) lo = mid
    else hi = mid - 1
  }
  return lo
}

/**
 * The best frame available right now, without waiting.
 *
 * Returns the exact frame when it is cached, otherwise the nearest one, so a
 * scrub shows something rather than flickering to nothing while decode catches
 * up. Null only before anything has been decoded.
 */
export function frameAt(asset, ms) {
  const want = indexAt(asset, ms)
  const hit = asset.cache.map.get(want)
  if (hit) return hit
  let best = null
  let bestDist = Infinity
  for (const [i, bmp] of asset.cache.map) {
    const d = Math.abs(i - want)
    if (d < bestDist) { bestDist = d; best = bmp }
  }
  return best
}

/**
 * How many samples to keep in flight. Enough to keep the decoder busy, small
 * enough that a seek does not have to wait for a long queue to drain.
 */
const QUEUE_HIGH = 12

function closeRun(asset) {
  const run = asset.dec
  asset.dec = null
  if (!run) return
  try { run.decoder.close() } catch { /* already gone */ }
}

/**
 * Starts a decoding run at a keyframe.
 *
 * A run is a decoder that stays open and is fed forward as the playhead
 * advances. That is the whole point: reaching an arbitrary frame means decoding
 * from the keyframe before it, and if every request starts a new decoder, that
 * walk is repeated over and over. On a long clip with a long GOP the same
 * hundreds of frames were being decoded and thrown away several times a second.
 */
function startRun(asset, fromDecode, startPres) {
  closeRun(asset)
  const scratch = new OffscreenCanvas(asset.width, asset.height)
  const sctx = scratch.getContext('2d')
  const run = {
    decoder: null, next: fromDecode, startPres, want: startPres, lastOut: -1, broken: false,
  }

  run.decoder = new VideoDecoder({
    output: (frame) => {
      try {
        const i = indexAt(asset, frame.timestamp / 1000 - asset.baseMs)
        // Every frame decoded is kept, including the ones between the keyframe
        // and the frame actually asked for. Discarding those was most of the
        // waste: they cost exactly as much to produce as the wanted one.
        if (!asset.cache.map.has(i)) {
          sctx.drawImage(frame, 0, 0)
          asset.cache.map.set(i, scratch.transferToImageBitmap())
          decodeStats.kept++
          // Frames arrive from the queue between requests, so the budget has to
          // hold here too — trimming only in `ensureDecoded` lets the cache run
          // over by however deep the decoder queue happens to be.
          trim(asset.cache, run.want)
        }
        if (i > run.lastOut) run.lastOut = i
      } finally {
        // A decoded VideoFrame holds a slot in a small, hardware-backed pool —
        // for 1080p often only a dozen. Holding them exhausts the pool, the
        // decoder stops emitting, and nothing ever completes.
        frame.close()
      }
    },
    error: (e) => {
      run.broken = true
      lastError = e?.message || String(e)
      console.error('[pixelforge] video decode failed', e)
    },
  })
  run.decoder.configure(asset.config)
  asset.dec = run
  decodeStats.passes++
  return run
}

/** Feeds samples up to `needDecode`, without blocking. */
function feed(asset, run, needDecode) {
  const samples = asset.video.samples
  while (run.next <= needDecode && !run.broken
         && run.decoder.decodeQueueSize < QUEUE_HIGH) {
    const smp = samples[run.next++]
    decodeStats.chunks++
    run.decoder.decode(new EncodedVideoChunk({
      type: smp.isSync ? 'key' : 'delta',
      timestamp: smp.timeUs,
      duration: smp.durationUs,
      data: smp.data,
    }))
  }
}

/**
 * Keeps the cache filled around `ms`, decoding forward.
 *
 * Returns immediately. Playback asks for a frame and draws whatever is there;
 * `frameAt` falls back to the nearest one, so being briefly behind shows a
 * neighbouring frame rather than stalling the whole render loop.
 */
export function ensureDecoded(asset, ms, lookahead = 0) {
  const n = asset.times.length
  if (!n) return
  const want = indexAt(asset, ms)

  // Fill most of the cache rather than a fixed handful. Getting to a keyframe is
  // the expensive part; once there, decoding further is nearly free, and it is
  // what stops the next request paying that cost all over again.
  const ahead = lookahead || Math.max(24, asset.cache.limit - 8)
  const target = Math.min(n - 1, want + ahead)

  let run = asset.dec
  if (run) {
    // Whether to keep this run is a cost question, and only ever asked about a
    // frame that is not already in hand — during ordinary playback the answer is
    // always "keep going", and asking anything else here restarts the decoder
    // every time the playhead crosses a keyframe the feed cursor has not reached.
    const cached = asset.cache.map.has(want)
    const need = asset.maxDecode[want]
    // A run only goes forwards, so once it has fed past the samples a frame is
    // built from it can never produce that frame. Note this asks where the feed
    // cursor is, not where the run began: a frame decoded earlier may since have
    // been evicted, and a run that will never produce it again is a seek that
    // hangs on a frame that never comes.
    // `lastOut` is what separates "already emitted, and since evicted" from
    // "fed, but still in the decoder's queue". Without it, a playhead moving
    // faster than the decoder looks identical to an unreachable frame, and the
    // run gets torn down and rebuilt on every frame it is briefly behind on —
    // which is the one thing guaranteed to keep it behind.
    const stalled = !cached && run.next > need && run.lastOut >= want
    // Otherwise, restart only when starting from the keyframe is less work than
    // decoding forward from here — which is exactly when that keyframe lies
    // ahead of the cursor.
    const cheaper = !cached && run.next < asset.syncBefore[want]
    if (run.broken || stalled || cheaper) { closeRun(asset); run = null }
  }
  if (run) run.want = want
  if (!run) run = startRun(asset, asset.syncBefore[want], want)

  feed(asset, run, asset.maxDecode[target])
  trim(asset.cache, want)
}

/**
 * Decodes a run of frames and waits for them. Used by export and thumbnails,
 * where the exact frame matters more than latency.
 *
 * This one flushes, so it needs a decoder of its own — and the streaming run is
 * closed first, because two decoders competing for the same hardware slots is
 * how the pool runs dry.
 */
async function decodeExact(asset, from, to) {
  closeRun(asset)
  const end = Math.min(asset.times.length - 1, to)
  const scratch = new OffscreenCanvas(asset.width, asset.height)
  const sctx = scratch.getContext('2d')
  let fail = null

  const decoder = new VideoDecoder({
    output: (frame) => {
      try {
        const i = indexAt(asset, frame.timestamp / 1000 - asset.baseMs)
        if (!asset.cache.map.has(i)) {
          sctx.drawImage(frame, 0, 0)
          asset.cache.map.set(i, scratch.transferToImageBitmap())
          decodeStats.kept++
        }
      } finally {
        frame.close()
      }
    },
    error: (e) => { fail = e },
  })
  decoder.configure(asset.config)
  decodeStats.passes++

  const samples = asset.video.samples
  const last = asset.maxDecode[end]
  for (let i = asset.syncBefore[from]; i <= last; i++) {
    decodeStats.chunks++
    const smp = samples[i]
    decoder.decode(new EncodedVideoChunk({
      type: smp.isSync ? 'key' : 'delta',
      timestamp: smp.timeUs,
      duration: smp.durationUs,
      data: smp.data,
    }))
  }
  await decoder.flush()
  decoder.close()
  if (fail) throw fail
  trim(asset.cache, from)
}

/**
 * Every wanted frame in one forward pass.
 *
 * This is how a filmstrip is supposed to be built, and it is the difference
 * between a strip that appears and a strip you watch fill in. Asking for each
 * thumbnail on its own — which is what `exactFrame` per slot amounts to — tears
 * the decoder down and walks it from the nearest keyframe again for *every*
 * picture: forty slots is forty configure-seek-flush-close cycles, and on a long
 * GOP each of those decodes dozens of frames to keep one. The work is quadratic
 * in the number of thumbnails for no reason at all.
 *
 * One decoder, opened once, fed straight through from the keyframe before the
 * first wanted frame to the last. Every frame in between is decoded exactly once
 * — which has to happen anyway to reach the later ones — and the wanted ones are
 * handed to the caller as they go by. Nothing is kept: `onThumb` is expected to
 * downscale immediately, because holding full frames is what exhausts the
 * hardware pool.
 *
 * Fed with backpressure rather than all at once. A thirty-second clip is nine
 * hundred chunks, and queueing them all makes the decoder's own buffer the
 * memory problem this was meant to avoid.
 */
export async function decodeThumbs(asset, wanted, onThumb) {
  if (!wanted?.length) return
  closeRun(asset)
  const want = new Set(wanted)
  const first = Math.max(0, Math.min(...wanted))
  const last = Math.min(asset.times.length - 1, Math.max(...wanted))
  let fail = null

  const decoder = new VideoDecoder({
    output: (frame) => {
      try {
        const i = indexAt(asset, frame.timestamp / 1000 - asset.baseMs)
        if (want.has(i)) onThumb(i, frame)
      } catch (e) {
        fail = e
      } finally {
        frame.close()
      }
    },
    error: (e) => { fail = e },
  })
  decoder.configure(asset.config)
  decodeStats.passes++

  const samples = asset.video.samples
  const end = asset.maxDecode[last]
  for (let i = asset.syncBefore[first]; i <= end; i++) {
    if (fail) break
    decodeStats.chunks++
    const smp = samples[i]
    decoder.decode(new EncodedVideoChunk({
      type: smp.isSync ? 'key' : 'delta',
      timestamp: smp.timeUs,
      duration: smp.durationUs,
      data: smp.data,
    }))
    if (decoder.decodeQueueSize > 24) {
      // Wait for it to catch up rather than piling on. Polling rather than
      // `ondequeue`, which not every build fires reliably.
      while (decoder.decodeQueueSize > 8 && !fail) {
        await new Promise((r) => setTimeout(r, 4))
      }
    }
  }
  try {
    await decoder.flush()
  } finally {
    try { decoder.close() } catch { /* already gone */ }
  }
  if (fail) throw fail
}

export let lastError = null
export const clearError = () => { lastError = null }

/** Awaits the exact frame at `ms`. Used by export, where accuracy beats latency. */
export async function exactFrame(asset, ms) {
  const want = indexAt(asset, ms)
  if (!asset.cache.map.has(want)) {
    if (asset.decoding) await asset.decoding
    if (!asset.cache.map.has(want)) {
      // A run of frames, not one: export walks forward, so the frames after
      // this one are about to be asked for and cost nothing extra now.
      const ahead = Math.max(12, asset.cache.limit - 8)
      asset.decoding = decodeExact(asset, want, want + ahead)
        .catch((err) => {
          lastError = err?.message || String(err)
          console.error('[pixelforge] video decode failed', err)
        })
        .finally(() => { asset.decoding = null })
      await asset.decoding
    }
  }
  return asset.cache.map.get(want) || frameAt(asset, ms)
}
