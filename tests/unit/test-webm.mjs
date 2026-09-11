// The WebM reader, on files built byte by byte.
//
// Each fixture is written element by element here, so every number the reader
// should find — times, keyframes, sizes, the codec — is known exactly. The
// main one is shaped like what a browser records: a segment and a cluster of
// unknown size, no duration, the index at the end.
import { demuxWebm, isWebm, codecFor } from '../../src/engine/webm.js'

const checks = []
const check = (name, ok, detail = '') => {
  checks.push([name, ok])
  console.log((ok ? 'PASS  ' : 'FAIL  ') + name + (detail ? '  — ' + detail : ''))
}

// --- writing EBML -------------------------------------------------------------------
const idBytes = (id) => {
  const out = []
  let v = id
  while (v > 0) { out.unshift(v & 0xff); v = Math.floor(v / 256) }
  return out
}
function size(n) {
  for (let len = 1; len <= 8; len++) {
    if (n < 2 ** (7 * len) - 1) {
      const out = []
      let v = n
      for (let i = 0; i < len; i++) { out.unshift(v & 0xff); v = Math.floor(v / 256) }
      out[0] |= 0x80 >> (len - 1)
      return out
    }
  }
  throw new Error('too big')
}
const UNKNOWN = [0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]
const el = (id, payload, unknown = false) => [...idBytes(id), ...(unknown ? UNKNOWN : size(payload.length)), ...payload]
const uintB = (v, n = 1) => { const o = []; for (let i = 0; i < n; i++) { o.unshift(v & 0xff); v = Math.floor(v / 256) } return o }
const str = (s) => [...s].map((c) => c.charCodeAt(0))
const f64 = (v) => { const b = new Uint8Array(8); new DataView(b.buffer).setFloat64(0, v); return [...b] }
/** A block's body: track, time relative to its cluster, flags, then the frame. */
const blockBody = (track, rel, flags, data) => [0x80 | track, (rel >> 8) & 0xff, rel & 0xff, flags, ...data]

const header = el(0x1a45dfa3, [...el(0x4282, str('webm'))])
const info = (withDuration) => el(0x1549a966, [
  ...el(0x2ad7b1, uintB(1000000, 3)),
  ...(withDuration ? el(0x4489, f64(200)) : []),
])
const tracks = (codecId, priv) => el(0x1654ae6b, [
  ...el(0xae, [
    ...el(0xd7, [1]), ...el(0x83, [1]), ...el(0x86, str(codecId)),
    ...(priv ? el(0x63a2, priv) : []),
    ...el(0xe0, [...el(0xb0, uintB(64, 2)), ...el(0xba, uintB(48, 2))]),
  ]),
  // A sound track, whose blocks must be passed over.
  ...el(0xae, [...el(0xd7, [2]), ...el(0x83, [2]), ...el(0x86, str('A_OPUS'))]),
])

// Frames are two bytes each: which frame, and a marker.
const frame = (i) => [i, 0xee]
function recorded(withDuration, codecId = 'V_VP9', priv = [1, 1, 0, 2, 1, 31, 3, 1, 8]) {
  // First cluster: unknown size, the way MediaRecorder writes it, with sound
  // blocks interleaved.
  const c1 = el(0x1f43b675, [
    ...el(0xe7, [0]),
    ...el(0xa3, blockBody(1, 0, 0x80, frame(0))),
    ...el(0xa3, blockBody(2, 0, 0x80, [9, 9, 9])),
    ...el(0xa3, blockBody(1, 33, 0x00, frame(1))),
    ...el(0xa3, blockBody(1, 67, 0x00, frame(2))),
    ...el(0xa3, blockBody(2, 20, 0x80, [9, 9])),
  ], true)
  // Second cluster: a known size, and the older BlockGroup form — one that
  // refers to an earlier frame and one that refers to none.
  const c2 = el(0x1f43b675, [
    ...el(0xe7, [100]),
    ...el(0xa3, blockBody(1, 0, 0x80, frame(3))),
    ...el(0xa0, [...el(0xa1, blockBody(1, 33, 0, frame(4))), ...el(0xfb, [0xdf])]),
    ...el(0xa0, [...el(0xa1, blockBody(1, 66, 0, frame(5)))]),
  ])
  const cues = el(0x1c53bb6b, [...el(0xbb, [0x00])])
  const segment = el(0x18538067, [...info(withDuration), ...tracks(codecId, priv), ...c1, ...c2, ...cues], true)
  return new Uint8Array([...header, ...segment])
}

// --- reading a recorded file -----------------------------------------------------------
{
  const bytes = recorded(false)
  check('a WebM is known by its first bytes', isWebm(bytes) && !isWebm(new Uint8Array([0, 0, 0, 0x20])))
  const m = demuxWebm(bytes)
  console.log(JSON.stringify({ ...m, samples: m.samples.map((s) => [s.timeUs, s.isSync, s.durationUs, [...s.data]]) }))
  check('only the video frames, not the sound', m.samples.length === 6, String(m.samples.length))
  check('each frame whole and in the order it was stored',
    m.samples.every((s, i) => s.data.length === 2 && s.data[0] === i && s.data[1] === 0xee))
  check('at its time: the cluster time plus its own, in microseconds',
    m.samples.map((s) => s.timeUs).join() === '0,33000,67000,100000,133000,166000',
    m.samples.map((s) => s.timeUs).join())
  check('keyframes known from either form of block',
    m.samples.map((s) => (s.isSync ? 'K' : '.')).join('') === 'K..K.K', m.samples.map((s) => (s.isSync ? 'K' : '.')).join(''))
  check('a cluster of unknown size ends where the next cluster begins, not at the end of the file',
    m.samples[3].timeUs === 100000)
  check('each frame lasts until the next one',
    m.samples.slice(0, 5).map((s) => s.durationUs).join() === '33000,34000,33000,33000,33000',
    m.samples.map((s) => s.durationUs).join())
  check('and the last as long as frames usually do', m.samples[5].durationUs === 33000, String(m.samples[5].durationUs))
  check('with no duration written, the length is where the frames end', Math.abs(m.durationMs - 199) < 0.01, String(m.durationMs))
  check('the size comes from the track', m.width === 64 && m.height === 48, `${m.width}x${m.height}`)
  check('and the codec by the name the decoder knows it by', m.codec === 'vp09.00.31.08', m.codec)
  check('in screen order too', m.order.join() === '0,1,2,3,4,5')
}

{
  const m = demuxWebm(recorded(true))
  check('a duration written in the file is believed', m.durationMs === 200, String(m.durationMs))
}

// --- the codecs ---------------------------------------------------------------------------
{
  check('VP8', codecFor('V_VP8')?.codec === 'vp8')
  check('VP9 with nothing said about it', codecFor('V_VP9', null)?.codec === 'vp09.00.10.08')
  check('VP9 ten-bit', codecFor('V_VP9', new Uint8Array([1, 1, 2, 3, 1, 10]))?.codec === 'vp09.02.10.10')
  // An av1C record: marker/version, then profile+level, then tier/depth bits.
  check('AV1 from its setup bytes', codecFor('V_AV1', new Uint8Array([0x81, 0x08, 0x0c, 0x00]))?.codec === 'av01.0.08M.08',
    codecFor('V_AV1', new Uint8Array([0x81, 0x08, 0x0c, 0x00]))?.codec)
  const avc = codecFor('V_MPEG4/ISO/AVC', new Uint8Array([1, 0x64, 0x00, 0x1f, 0xff]))
  check('H.264 in a Matroska file, with its setup handed on', avc?.codec === 'avc1.64001f' && avc.description?.length === 5)
  let msg = ''
  try { demuxWebm(recorded(false, 'V_THEORA', null)) } catch (e) { msg = e.message }
  check('a codec that cannot be decoded is named, not guessed at', /V_THEORA/.test(msg) && /VP8, VP9 and AV1/.test(msg), msg)
  let bad = ''
  try { demuxWebm(new Uint8Array([1, 2, 3, 4, 5])) } catch (e) { bad = e.message }
  check('and something that is not a WebM says so', /not a WebM/.test(bad), bad)
}

const failed = checks.filter(([, ok]) => !ok)
console.log(`\n${checks.length - failed.length}/${checks.length} passed`)
process.exit(failed.length ? 1 : 0)
