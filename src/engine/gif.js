// Minimal, dependency-free GIF87a/89a decoder.
// Returns fully-composited RGBA frames (disposal methods applied) so callers
// can treat every frame as an independent still image.

function readColorTable(u8, p, size) {
  return u8.subarray(p, p + size * 3)
}

function readSubBlocks(u8, p) {
  let total = 0
  let q = p
  while (q < u8.length && u8[q] !== 0) {
    total += u8[q]
    q += u8[q] + 1
  }
  const out = new Uint8Array(total)
  let o = 0
  q = p
  while (q < u8.length && u8[q] !== 0) {
    const n = u8[q]
    out.set(u8.subarray(q + 1, q + 1 + n), o)
    o += n
    q += n + 1
  }
  return { data: out, next: q + 1 }
}

function lzwDecode(minCodeSize, data, pixelCount) {
  const MAX = 4096
  const clearCode = 1 << minCodeSize
  const eoiCode = clearCode + 1
  let codeSize = minCodeSize + 1
  let codeMask = (1 << codeSize) - 1
  const prefix = new Int32Array(MAX)
  const suffix = new Uint8Array(MAX)
  const stack = new Uint8Array(MAX + 1)
  let available = clearCode + 2
  let oldCode = -1
  let first = 0
  for (let i = 0; i < clearCode; i++) suffix[i] = i

  const dst = new Uint8Array(pixelCount)
  let dstPos = 0
  let bitBuf = 0
  let bitCount = 0
  let pos = 0
  let top = 0

  while (dstPos < pixelCount) {
    if (top === 0) {
      while (bitCount < codeSize) {
        if (pos >= data.length) break
        bitBuf |= data[pos++] << bitCount
        bitCount += 8
      }
      if (bitCount < codeSize) break

      let code = bitBuf & codeMask
      bitBuf >>= codeSize
      bitCount -= codeSize

      if (code === eoiCode) break
      if (code === clearCode) {
        codeSize = minCodeSize + 1
        codeMask = (1 << codeSize) - 1
        available = clearCode + 2
        oldCode = -1
        continue
      }
      if (oldCode === -1) {
        stack[top++] = suffix[code]
        oldCode = code
        first = code
        continue
      }
      const inCode = code
      if (code >= available) {
        stack[top++] = first
        code = oldCode
      }
      let guard = 0
      while (code >= clearCode && guard++ < MAX) {
        stack[top++] = suffix[code]
        code = prefix[code]
      }
      first = suffix[code] & 0xff
      stack[top++] = first
      if (available < MAX) {
        prefix[available] = oldCode
        suffix[available] = first
        available++
        if ((available & codeMask) === 0 && available < MAX) {
          codeSize++
          codeMask += available
        }
      }
      oldCode = inCode
    }
    top--
    dst[dstPos++] = stack[top]
  }
  return dst
}

function deinterlace(pixels, w, h) {
  const out = new Uint8Array(pixels.length)
  const offsets = [0, 4, 2, 1]
  const steps = [8, 8, 4, 2]
  let row = 0
  for (let pass = 0; pass < 4; pass++) {
    for (let y = offsets[pass]; y < h; y += steps[pass]) {
      out.set(pixels.subarray(row * w, (row + 1) * w), y * w)
      row++
    }
  }
  pixels.set(out)
}

export function decodeGIF(bytes) {
  const u8 = bytes
  let p = 0
  const sig = String.fromCharCode(u8[0], u8[1], u8[2])
  if (sig !== 'GIF') throw new Error('Not a GIF file')
  p = 6

  const width = u8[p++] | (u8[p++] << 8)
  const height = u8[p++] | (u8[p++] << 8)
  const flags = u8[p++]
  p++ // background color index
  p++ // pixel aspect ratio

  let gct = null
  if (flags & 0x80) {
    const gctSize = 2 << (flags & 7)
    gct = readColorTable(u8, p, gctSize)
    p += gctSize * 3
  }

  const frames = []
  const buf = new Uint8ClampedArray(width * height * 4)
  let prevBuf = null
  let gce = null
  let loopCount = 0

  while (p < u8.length) {
    const block = u8[p++]

    if (block === 0x3b) break // trailer

    if (block === 0x21) {
      const label = u8[p++]
      if (label === 0xf9) {
        const size = u8[p]
        const f = u8[p + 1]
        const delay = u8[p + 2] | (u8[p + 3] << 8)
        const tIndex = u8[p + 4]
        p += size + 1
        p++ // block terminator
        gce = { disposal: (f >> 2) & 7, transparent: !!(f & 1), delay, tIndex }
      } else if (label === 0xff) {
        const appId = String.fromCharCode(...u8.subarray(p + 1, p + 12))
        const r = readSubBlocks(u8, p + 1 + u8[p])
        if (appId.startsWith('NETSCAPE') && r.data.length >= 3) {
          loopCount = r.data[1] | (r.data[2] << 8)
        }
        p = r.next
      } else {
        const r = readSubBlocks(u8, p)
        p = r.next
      }
      continue
    }

    if (block === 0x2c) {
      const ix = u8[p++] | (u8[p++] << 8)
      const iy = u8[p++] | (u8[p++] << 8)
      const iw = u8[p++] | (u8[p++] << 8)
      const ih = u8[p++] | (u8[p++] << 8)
      const f = u8[p++]
      let ct = gct
      if (f & 0x80) {
        const lctSize = 2 << (f & 7)
        ct = readColorTable(u8, p, lctSize)
        p += lctSize * 3
      }
      const interlaced = !!(f & 0x40)
      const minCodeSize = u8[p++]
      const r = readSubBlocks(u8, p)
      p = r.next

      if (!ct || iw === 0 || ih === 0) { gce = null; continue }

      const indices = lzwDecode(minCodeSize, r.data, iw * ih)
      if (interlaced) deinterlace(indices, iw, ih)

      const disposal = gce ? gce.disposal : 0
      if (disposal === 3) prevBuf = buf.slice()

      const tI = gce && gce.transparent ? gce.tIndex : -1
      for (let y = 0; y < ih; y++) {
        const dy = iy + y
        if (dy < 0 || dy >= height) continue
        for (let x = 0; x < iw; x++) {
          const dx = ix + x
          if (dx < 0 || dx >= width) continue
          const idx = indices[y * iw + x]
          if (idx === tI) continue
          const o = (dy * width + dx) * 4
          const c = idx * 3
          buf[o] = ct[c]
          buf[o + 1] = ct[c + 1]
          buf[o + 2] = ct[c + 2]
          buf[o + 3] = 255
        }
      }

      let delay = gce ? gce.delay * 10 : 100
      if (delay < 20) delay = 100 // match browser behaviour for 0/1cs frames
      frames.push({ imageData: new ImageData(buf.slice(), width, height), delay })

      if (disposal === 2) {
        for (let y = iy; y < iy + ih && y < height; y++) {
          if (y < 0) continue
          const o = (y * width + Math.max(0, ix)) * 4
          const len = Math.min(iw, width - ix) * 4
          if (len > 0) buf.fill(0, o, o + len)
        }
      } else if (disposal === 3 && prevBuf) {
        buf.set(prevBuf)
      }
      gce = null
      continue
    }

    // Unrecognised block — bail rather than spin.
    break
  }

  if (!frames.length) throw new Error('GIF contained no decodable frames')
  return { width, height, frames, loopCount }
}
