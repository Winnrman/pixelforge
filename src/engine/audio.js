// Audio playback.
//
// Until now audio was never touched in the app at all — it was handed to ffmpeg
// at export and that was the whole story, which is why a video with sound played
// silently. This decodes it and plays it alongside the picture.
//
// Two things shape the design.
//
// **Audio is the clock.** The render loop advanced time by the wall-clock delta
// between animation frames, which is fine when nothing has to agree with it. It
// is not fine next to sound: a dropped video frame is invisible, a gap or a
// drift in audio is immediately audible, and a picture that slowly slides out of
// sync with speech is worse than either. So while sound is playing, document
// time is *derived* from the audio clock rather than accumulated separately.
//
// **The graph is built against any context.** Nothing here assumes speakers, so
// the same code that plays can be rendered by an OfflineAudioContext and the
// samples inspected — which is the only way to check that a mute really silences
// something, or that a trimmed clip really starts where it claims, without
// listening to it.

import { clipRange, sourceRange } from './clips.js'
import { pairsIn, voiceGainPoints, gainAt } from './transitions.js'
import { valueAt, trackOf } from './keyframes.js'

let ctx = null

/** The shared output context, created on first use — browsers refuse to make
 *  one before a user gesture, and most sessions never need it at all. */
export function audioContext() {
  if (!ctx) {
    const C = window.AudioContext || window.webkitAudioContext
    if (!C) return null
    ctx = new C()
  }
  return ctx
}

export const audioAvailable = () =>
  typeof window !== 'undefined' && !!(window.AudioContext || window.webkitAudioContext)

/**
 * Decodes an asset's sound, once, and hangs it on the asset.
 *
 * `decodeAudioData` detaches the buffer it is given, so it gets a copy — the
 * original bytes are the asset's own and are still needed to save the project.
 * A file with no audio track throws; that is an answer, not an error.
 */
export function ensureAudio(asset, bytes = null) {
  if (!asset || asset.audio !== undefined) return asset?.audioPending || Promise.resolve(asset?.audio)
  const c = audioContext()
  const src = bytes || asset.audioBytes
  if (!c || !src) { asset.audio = null; return Promise.resolve(null) }

  asset.audioPending = c.decodeAudioData(src.slice(0))
    .then((buf) => { asset.audio = buf; return buf })
    .catch(() => { asset.audio = null; return null })
    .finally(() => { asset.audioPending = null })
  return asset.audioPending
}

export const hasAudio = (asset) => !!asset?.audio

/** Layers that would make a sound, with the asset behind each. */
export function audioLayers(doc, assetOf) {
  const out = []
  for (const l of doc.layers || []) {
    if (l.type !== 'image' || l.visible === false) continue
    const a = assetOf(l)
    if (!a?.audio) continue
    out.push({ layer: l, asset: a })
  }
  return out
}

/**
 * Where a layer's sound sits, in seconds: when it starts relative to the
 * document, where in its own audio it starts, and how long it runs.
 *
 * A clip plays its piece once. Anything unclipped loops, because that is what
 * the picture does and the two must agree.
 */
export function voiceFor(layer, asset, fromMs) {
  const speed = Math.abs(layer.speed || 1) || 1
  const buf = asset.audio
  if (!buf) return null

  if (!layer.clip) {
    const total = buf.duration
    const at = ((fromMs / 1000 - (layer.timeOffset || 0) / 1000) * speed) % total
    return {
      delay: 0,
      offset: ((at % total) + total) % total,
      duration: null,          // runs until stopped
      loop: true,
      rate: speed,
    }
  }

  const { start, end } = clipRange(layer, asset)
  const { in: cin } = sourceRange(layer, asset)
  if (fromMs >= end) return null

  // Starting before the clip does means waiting, not playing from a negative
  // offset — which silently plays the wrong part of the sound.
  const delay = Math.max(0, (start - fromMs) / 1000)
  const into = Math.max(0, (fromMs - start) / 1000) * speed
  const offset = cin / 1000 + into
  const duration = (end - Math.max(start, fromMs)) / 1000 * speed
  if (duration <= 0) return null
  return { delay, offset, duration, loop: false, rate: speed }
}

/**
 * Builds the playing graph on a context and starts it.
 *
 * `when` is the context time to start at, so an offline render can begin at zero
 * and a live one can be scheduled a hair into the future — starting exactly at
 * `currentTime` means the first fraction of a second has already passed by the
 * time the graph is connected, which clicks.
 */
export function buildGraph(context, doc, assetOf, {
  from = 0, when = null, master = 1, muted = false, rate = 1,
} = {}) {
  const at = when == null ? context.currentTime + 0.02 : when
  const voices = []
  const gain = context.createGain()
  gain.gain.value = muted ? 0 : Math.max(0, Math.min(1, master))
  gain.connect(context.destination)

  // Clips that lap over each other are dissolving on screen, so their sound has
  // to cross as well: a picture that dissolves under a hard audio cut is the
  // thing that sounds broken, and it is the cut you hear, not the dissolve you
  // see, that gives it away.
  const pairs = pairsIn(doc.layers, assetOf)

  for (const { layer, asset } of audioLayers(doc, assetOf)) {
    const v = voiceFor(layer, asset, from)
    if (!v) continue
    const g = context.createGain()
    const vol = Math.max(0, Math.min(2, layer.muted ? 0 : (layer.volume == null ? 1 : layer.volume)))
    g.connect(gain)

    // Two things move a voice's gain: what the layer's volume is doing, which is
    // an ordinary keyframe track, and what a transition or fade is doing to it,
    // which is a multiplier. They are independent and they multiply — turning a
    // clip down and fading it out should give something quieter than either.
    const points = voiceGainPoints(layer, asset, pairs)
    const keys = layer.muted ? [] : trackOf(layer, 'volume')
    const level = (ms) => (keys.length
      ? Math.max(0, Math.min(2, valueAt(layer, 'volume', ms) ?? 1))
      : vol)

    if (!points.length && !keys.length) {
      g.gain.value = vol
    } else {
      // Every time either curve has something to say, plus a sample through each
      // volume segment: keyframes ease, and a straight ramp between two keys
      // would flatten an ease-in-out into a line.
      const marks = new Set([from, ...points.map((p) => p[0])])
      for (let i = 0; i < keys.length; i++) {
        marks.add(keys[i].t)
        const next = keys[i + 1]
        if (!next) continue
        const step = Math.max(40, (next.t - keys[i].t) / 8)
        for (let t = keys[i].t + step; t < next.t; t += step) marks.add(t)
      }
      const times = [...marks].filter((t) => t >= from).sort((a, b) => a - b)

      // Starting the graph in the middle of a transition is ordinary — the
      // playhead was dropped there — so the curve is picked up at its current
      // value rather than restarted from the top.
      g.gain.setValueAtTime(level(from) * gainAt(points, from), at)
      for (const ms of times) {
        if (ms <= from) continue
        g.gain.linearRampToValueAtTime(level(ms) * gainAt(points, ms), at + (ms - from) / 1000)
      }
    }

    const src = context.createBufferSource()
    src.buffer = asset.audio
    // The clip's own speed, times how fast the preview is running.
    src.playbackRate.value = v.rate * (rate || 1)
    if (v.loop) {
      src.loop = true
      // A clip that starts later starts sooner when the preview runs fast: the
      // wait is in document time, and the preview is playing document time at a
      // different speed.
      src.start(at + v.delay / (rate || 1), v.offset)
    } else {
      src.start(at + v.delay / (rate || 1), v.offset, v.duration)
    }
    src.connect(g)
    voices.push({ layerId: layer.id, source: src, gain: g, ...v })
  }
  return { master: gain, voices, startedAt: at }
}

// ---------------------------------------------------------------- the player

let live = null

export const isPlaying = () => !!live

/**
 * Starts playing the document from `fromMs`.
 *
 * Returns false when there is nothing to play, so the caller can fall back to
 * driving time itself rather than waiting on a clock that will never tick.
 */
export async function play(doc, assetOf, fromMs, { master = 1, muted = false, rate = 1 } = {}) {
  stop()
  const c = audioContext()
  if (!c) return false
  // Browsers start the context suspended until a gesture; play *is* the gesture.
  if (c.state === 'suspended') await c.resume().catch(() => {})

  const needed = audioLayers(doc, assetOf)
  if (!needed.length) return false

  const graph = buildGraph(c, doc, assetOf, { from: fromMs, master, muted, rate })
  if (!graph.voices.length) { graph.master.disconnect(); return false }

  live = { graph, fromMs, startedAt: graph.startedAt, ctx: c, rate }
  return true
}

export function stop() {
  if (!live) return
  for (const v of live.graph.voices) {
    try { v.source.stop() } catch { /* already ended */ }
    v.source.disconnect()
    v.gain.disconnect()
  }
  live.graph.master.disconnect()
  live = null
}

/**
 * Document time, in ms, from the audio clock.
 *
 * Null when nothing is playing — the caller then keeps its own time, which is
 * what a project with no sound has always done.
 */
export function currentTime() {
  if (!live) return null
  const elapsed = live.ctx.currentTime - live.startedAt
  // Before the scheduled start the clock has not begun; reporting a negative
  // elapsed would run the playhead backwards for the first few milliseconds.
  //
  // Scaled by the preview rate, because the sound is playing faster and the
  // playhead has to agree with it — a clock that ignores the rate would drift
  // against the very thing it is reading.
  return live.fromMs + Math.max(0, elapsed) * 1000 * (live.rate || 1)
}

/** Master volume and mute, applied to whatever is already playing. */
export function setMaster(master, muted) {
  if (!live) return
  const g = live.graph.master.gain
  const v = muted ? 0 : Math.max(0, Math.min(1, master))
  // A ramp rather than a jump: an instant gain change on a running signal is a
  // click, which is more noticeable than the change itself.
  g.setTargetAtTime(v, live.ctx.currentTime, 0.01)
}

/** Frees decoded audio when an asset goes away. */
export function releaseAudio(asset) {
  if (!asset) return
  asset.audio = undefined
  asset.audioPending = null
  asset.audioBytes = null
}
