// WebM import: reading the container, so the video decoder can take it from
// there.
//
// A WebM is Matroska — a tree of tagged, length-prefixed elements — holding
// VP8, VP9 or AV1 video, and the browser's decoder already speaks all three.
// So all this file does is what the MP4 demuxer does for MP4: walk the
// container, and hand back the frames in the order they are stored, each with
// its time and whether it is a keyframe. Everything after that — the frame
// cache, playback, export — is the same code for both.
//
// The case that matters most is a file a browser recorded. MediaRecorder writes
// WebM as a live stream: the segment and every cluster say "size unknown",
// there is no duration, and no index. A cluster of unknown size ends where the
// next element that can only live in a segment begins, and that is the rule
// used here.

const ID = {
  EBML: 0x1a45dfa3,
  SEGMENT: 0x18538067,
  INFO: 0x1549a966,
  TIMECODE_SCALE: 0x2ad7b1,
  DURATION: 0x4489,
  TRACKS: 0x1654ae6b,
  TRACK_ENTRY: 0xae,
  TRACK_NUMBER: 0xd7,
  TRACK_TYPE: 0x83,
  CODEC_ID: 0x86,
  CODEC_PRIVATE: 0x63a2,
  DEFAULT_DURATION: 0x23e383,
  VIDEO: 0xe0,
  PIXEL_WIDTH: 0xb0,
  PIXEL_HEIGHT: 0xba,
  CLUSTER: 0x1f43b675,
  TIMECODE: 0xe7,
  SIMPLE_BLOCK: 0xa3,
  BLOCK_GROUP: 0xa0,
  BLOCK: 0xa1,
  BLOCK_DURATION: 0x9b,
  REFERENCE_BLOCK: 0xfb,
}

// Elements that only ever sit directly in a segment. Meeting one inside a
// cluster of unknown size means the cluster is over.
const SEGMENT_LEVEL = new Set([
  ID.CLUSTER, ID.INFO, ID.TRACKS, 0x1c53bb6b /* Cues */, 0x1254c367 /* Tags */,
  0x1043a770 /* Chapters */, 0x1941a469 /* Attachments */, 0x114d9b74 /* SeekHead */,
  ID.EBML, ID.SEGMENT,
])

/** Whether some bytes start the way every WebM and Matroska file does. */
export const isWebm = (u8) => u8?.length >= 4 && u8[0] === 0x1a && u8[1] === 0x45 && u8[2] === 0xdf && u8[3] === 0xa3

/**
 * A variable-length integer: the count of leading zero bits in the first byte
 * says how many bytes it has. IDs keep their marker bit; sizes do not, and a
 * size of all ones means "unknown".
 */
function vint(u8, pos, keepMarker) {
  const b = u8[pos]
  if (b === undefined || b === 0) return null
  let len = 1
  let mask = 0x80
  while (!(b & mask)) { len++; mask >>= 1 }
  if (pos + len > u8.length) return null
  let value = keepMarker ? b : b & (mask - 1)
  let ones = (b & (mask - 1)) === mask - 1
  for (let i = 1; i < len; i++) {
    const c = u8[pos + i]
    value = value * 256 + c
    if (c !== 0xff) ones = false
  }
  return { value, len, unknown: !keepMarker && ones }
}

/** An element's header: its ID, and where its contents start and end. */
function header(u8, pos, limit) {
  const id = vint(u8, pos, true)
  if (!id) return null
  const size = vint(u8, pos + id.len, false)
  if (!size) return null
  const start = pos + id.len + size.len
  const end = size.unknown ? limit : Math.min(limit, start + size.value)
  return { id: id.value, start, end, unknown: size.unknown }
}

const uint = (u8, s, e) => {
  let v = 0
  for (let i = s; i < e; i++) v = v * 256 + u8[i]
  return v
}
const float = (u8, s, e) => {
  const dv = new DataView(u8.buffer, u8.byteOffset + s, e - s)
  return e - s === 4 ? dv.getFloat32(0) : e - s === 8 ? dv.getFloat64(0) : 0
}
const text = (u8, s, e) => {
  let out = ''
  for (let i = s; i < e && u8[i]; i++) out += String.fromCharCode(u8[i])
  return out
}

function* children(u8, s, e) {
  let pos = s
  while (pos < e) {
    const el = header(u8, pos, e)
    if (!el) return
    yield el
    pos = el.unknown ? e : el.end
  }
}

const pad2 = (n) => String(n).padStart(2, '0')
const hex2 = (n) => n.toString(16).padStart(2, '0')

/**
 * The name the video decoder knows a track's codec by, from Matroska's own
 * name for it and whatever setup bytes the track carries.
 */
export function codecFor(codecId, priv) {
  if (codecId === 'V_VP8') return { codec: 'vp8' }
  if (codecId === 'V_VP9') {
    // Optional: profile, level and bit depth, as id-length-value triples.
    let profile = 0
    let level = 10
    let depth = 8
    for (let i = 0; priv && i + 2 < priv.length + 1 && i + 1 < priv.length;) {
      const id = priv[i]
      const n = priv[i + 1]
      const v = priv[i + 2]
      if (id === 1) profile = v
      else if (id === 2) level = v
      else if (id === 3) depth = v
      i += 2 + n
    }
    return { codec: `vp09.${pad2(profile)}.${pad2(level)}.${pad2(depth)}` }
  }
  if (codecId === 'V_AV1') {
    if (priv?.length >= 3) {
      const profile = priv[1] >> 5
      const level = priv[1] & 31
      const tier = (priv[2] >> 7) & 1
      const high = (priv[2] >> 6) & 1
      const twelve = (priv[2] >> 5) & 1
      const depth = high ? (twelve ? 12 : 10) : 8
      return { codec: `av01.${profile}.${pad2(level)}${tier ? 'H' : 'M'}.${pad2(depth)}` }
    }
    return { codec: 'av01.0.08M.08' }
  }
  if (codecId === 'V_MPEG4/ISO/AVC' && priv?.length >= 4) {
    // The track's setup bytes are an avcC record, which is exactly the
    // description the decoder wants for H.264.
    return { codec: `avc1.${hex2(priv[1])}${hex2(priv[2])}${hex2(priv[3])}`, description: priv }
  }
  return null
}

/**
 * Reads a WebM's video track into the same shape the MP4 demuxer produces:
 * codec, size, duration, and the frames in stored order with their times and
 * keyframe flags, plus their order on screen.
 */
export function demuxWebm(bytes) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
  if (!isWebm(u8)) throw new Error('This is not a WebM file')
  let pos = 0
  let segment = null
  while (pos < u8.length) {
    const el = header(u8, pos, u8.length)
    if (!el) break
    if (el.id === ID.SEGMENT) { segment = el; break }
    pos = el.end
  }
  if (!segment) throw new Error('Could not read this WebM: it has no segment')

  let scale = 1_000_000          // nanoseconds per timecode unit
  let durationUnits = null
  const tracks = new Map()
  const frames = []

  const readTracks = (el) => {
    for (const te of children(u8, el.start, el.end)) {
      if (te.id !== ID.TRACK_ENTRY) continue
      const t = { number: 0, type: 0, codecId: '', priv: null, defaultNs: 0, width: 0, height: 0 }
      for (const f of children(u8, te.start, te.end)) {
        if (f.id === ID.TRACK_NUMBER) t.number = uint(u8, f.start, f.end)
        else if (f.id === ID.TRACK_TYPE) t.type = uint(u8, f.start, f.end)
        else if (f.id === ID.CODEC_ID) t.codecId = text(u8, f.start, f.end)
        else if (f.id === ID.CODEC_PRIVATE) t.priv = u8.slice(f.start, f.end)
        else if (f.id === ID.DEFAULT_DURATION) t.defaultNs = uint(u8, f.start, f.end)
        else if (f.id === ID.VIDEO) {
          for (const v of children(u8, f.start, f.end)) {
            if (v.id === ID.PIXEL_WIDTH) t.width = uint(u8, v.start, v.end)
            else if (v.id === ID.PIXEL_HEIGHT) t.height = uint(u8, v.start, v.end)
          }
        }
      }
      tracks.set(t.number, t)
    }
  }

  // The video track is known by the time blocks arrive: Tracks comes before
  // the first cluster in any file that can be played.
  let video = null
  const block = (s, e, clusterTime, simple, keyIfGroup) => {
    const tn = vint(u8, s, false)
    if (!tn) return
    if (!video) video = [...tracks.values()].find((t) => t.type === 1) || null
    if (!video || tn.value !== video.number) return
    let p = s + tn.len
    const rel = ((u8[p] << 8) | u8[p + 1]) << 16 >> 16
    const flags = u8[p + 2]
    p += 3
    const key = simple ? !!(flags & 0x80) : keyIfGroup
    const lacing = (flags >> 1) & 3
    const time = (clusterTime + rel) * scale / 1000
    if (!lacing) {
      frames.push({ data: u8.subarray(p, e), timeUs: Math.round(time), durationUs: 0, isSync: key })
      return
    }
    // Several frames packed in one block. Unheard of for video from anything
    // that records it, but fixed-size packing is simple enough to honour.
    if (lacing === 2) {
      const count = u8[p] + 1
      p++
      const size = Math.floor((e - p) / count)
      for (let i = 0; i < count; i++) {
        frames.push({ data: u8.subarray(p + i * size, p + (i + 1) * size), timeUs: Math.round(time), durationUs: 0, isSync: key && i === 0 })
      }
      return
    }
    throw new Error('This WebM packs its video frames in a way that is not supported')
  }

  pos = segment.start
  const end = segment.end
  while (pos < end) {
    const el = header(u8, pos, end)
    if (!el) break
    if (el.id === ID.INFO) {
      for (const f of children(u8, el.start, el.end)) {
        if (f.id === ID.TIMECODE_SCALE) scale = uint(u8, f.start, f.end) || scale
        else if (f.id === ID.DURATION) durationUnits = float(u8, f.start, f.end)
      }
      pos = el.end
    } else if (el.id === ID.TRACKS) {
      readTracks(el)
      pos = el.end
    } else if (el.id === ID.CLUSTER) {
      let clusterTime = 0
      let p = el.start
      const limit = el.end
      while (p < limit) {
        const c = header(u8, p, limit)
        if (!c) { p = limit; break }
        // A cluster of unknown size is over at the first thing that is not a
        // cluster's child.
        if (el.unknown && SEGMENT_LEVEL.has(c.id)) break
        if (c.id === ID.TIMECODE) clusterTime = uint(u8, c.start, c.end)
        else if (c.id === ID.SIMPLE_BLOCK) block(c.start, c.end, clusterTime, true, false)
        else if (c.id === ID.BLOCK_GROUP) {
          let b = null
          let referenced = false
          for (const g of children(u8, c.start, c.end)) {
            if (g.id === ID.BLOCK) b = g
            else if (g.id === ID.REFERENCE_BLOCK) referenced = true
          }
          // A block that refers to no other block stands on its own: a keyframe.
          if (b) block(b.start, b.end, clusterTime, false, !referenced)
        }
        p = c.unknown ? limit : c.end
      }
      pos = p
    } else {
      // The index, tags, padding: nothing a decoder needs.
      pos = el.unknown ? end : el.end
    }
  }

  const track = video || [...tracks.values()].find((t) => t.type === 1)
  if (!track) throw new Error('That file has no video track')
  const named = codecFor(track.codecId, track.priv)
  if (!named) throw new Error(`This WebM's video is ${track.codecId || 'of an unknown kind'}, which cannot be decoded here. VP8, VP9 and AV1 can.`)
  if (!frames.length) throw new Error('That WebM has no video frames')

  // How long each frame is shown: until the next one, in screen order. The
  // last lasts as long as the track says frames last, or as long as frames
  // usually do.
  const order = frames.map((_, i) => i).sort((a, b) => frames[a].timeUs - frames[b].timeUs)
  const gaps = []
  for (let k = 0; k + 1 < order.length; k++) {
    const g = frames[order[k + 1]].timeUs - frames[order[k]].timeUs
    frames[order[k]].durationUs = g
    if (g > 0) gaps.push(g)
  }
  gaps.sort((a, b) => a - b)
  const typical = track.defaultNs ? Math.round(track.defaultNs / 1000) : gaps[gaps.length >> 1] || 33333
  frames[order[order.length - 1]].durationUs = typical
  // Two frames at one instant would show one of them for no time at all.
  for (const f of frames) if (f.durationUs <= 0) f.durationUs = typical

  const last = frames[order[order.length - 1]]
  const durationMs = durationUnits ? (durationUnits * scale) / 1e6 : (last.timeUs + last.durationUs) / 1000
  return {
    codec: named.codec,
    description: named.description || null,
    width: track.width,
    height: track.height,
    durationMs,
    samples: frames,
    order,
  }
}
