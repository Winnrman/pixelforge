// A plain radix-2 FFT, for finding how a picture repeats.
//
// Autocorrelation — how much a picture looks like itself shifted by every
// possible amount — is one multiply in the frequency domain and a quarter of a
// billion in the pixel domain. That is the whole reason this file exists.

/** In-place complex FFT of length n, which must be a power of two. */
export function fft(re, im, inverse = false) {
  const n = re.length
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1
    for (; j & bit; bit >>= 1) j ^= bit
    j ^= bit
    if (i < j) {
      let t = re[i]; re[i] = re[j]; re[j] = t
      t = im[i]; im[i] = im[j]; im[j] = t
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const half = len >> 1
    const ang = ((inverse ? 2 : -2) * Math.PI) / len
    for (let k = 0; k < half; k++) {
      // Each twiddle computed outright rather than by recurrence: the
      // recurrence drifts over a thousand steps, and this is cheap enough.
      const wr = Math.cos(ang * k)
      const wi = Math.sin(ang * k)
      for (let i = k; i < n; i += len) {
        const b = i + half
        const tr = re[b] * wr - im[b] * wi
        const ti = re[b] * wi + im[b] * wr
        re[b] = re[i] - tr
        im[b] = im[i] - ti
        re[i] += tr
        im[i] += ti
      }
    }
  }
  if (inverse) {
    for (let i = 0; i < n; i++) { re[i] /= n; im[i] /= n }
  }
}

/** In-place 2D FFT of a W×H grid, row-major, both powers of two. */
export function fft2d(re, im, W, H, inverse = false) {
  for (let y = 0; y < H; y++) {
    fft(re.subarray(y * W, (y + 1) * W), im.subarray(y * W, (y + 1) * W), inverse)
  }
  const cr = new Float64Array(H)
  const ci = new Float64Array(H)
  for (let x = 0; x < W; x++) {
    for (let y = 0; y < H; y++) { cr[y] = re[y * W + x]; ci[y] = im[y * W + x] }
    fft(cr, ci, inverse)
    for (let y = 0; y < H; y++) { re[y * W + x] = cr[y]; im[y * W + x] = ci[y] }
  }
}

export const nextPow2 = (n) => {
  let p = 1
  while (p < n) p <<= 1
  return p
}
