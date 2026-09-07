import { GIFEncoder, quantize, applyPalette } from 'gifenc'

let gif = null
let opts = null

self.onmessage = (e) => {
  const msg = e.data
  if (msg.type === 'begin') {
    gif = GIFEncoder()
    opts = msg
    self.postMessage({ type: 'ready' })
    return
  }
  if (msg.type === 'frame') {
    const data = new Uint8ClampedArray(msg.buffer)
    const format = opts.transparent ? 'rgba4444' : 'rgb565'
    const palette = quantize(data, opts.colors || 256, {
      format,
      oneBitAlpha: opts.transparent ? true : undefined,
    })
    const index = applyPalette(data, palette, format)
    gif.writeFrame(index, msg.width, msg.height, {
      palette,
      delay: msg.delay,
      transparent: !!opts.transparent,
      transparentIndex: 0,
      dispose: opts.transparent ? 2 : -1,
      repeat: 0,
    })
    self.postMessage({ type: 'frameDone' })
    return
  }
  if (msg.type === 'finish') {
    gif.finish()
    const bytes = gif.bytes()
    gif = null
    self.postMessage({ type: 'done', bytes }, [bytes.buffer])
  }
}
