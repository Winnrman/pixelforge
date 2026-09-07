// Where the edges are, and how to walk along them.
//
// Two things need this. A magnetic lasso needs to find the cheapest path along
// an edge between where you last were and where the pointer is now. And the AI
// selection needs to pull its outline onto the real boundary, because a matte
// predicted at 512px is close to the edge but rarely on it.
//
// Colour gradients, not luminance. Converting to grey first is the usual
// shortcut and it throws away exactly the edges that matter on artwork with a
// single dominant hue: a green creature against a green background can be a
// strong colour boundary at almost constant brightness, and a luminance edge
// map sees nothing there at all.

/** Working resolution. Edge finding does not need full size, and a megapixel
 *  Dijkstra per pointer move is not a thing anyone wants to wait for. */
const MAX_SIDE = 720

/**
 * Sobel magnitude per pixel, 0..1, taken as the strongest of the three colour
 * channels rather than of their average.
 *
 * Returns the map plus the scale it was built at, so callers can convert
 * between image and map coordinates.
 */
export function buildEdgeMap(source, maxSide = MAX_SIDE) {
  const sw = source.naturalWidth || source.width
  const sh = source.naturalHeight || source.height
  if (!sw || !sh) return null
  const k = Math.min(1, maxSide / Math.max(sw, sh))
  const w = Math.max(2, Math.round(sw * k))
  const h = Math.max(2, Math.round(sh * k))

  const c = typeof OffscreenCanvas !== 'undefined'
    ? new OffscreenCanvas(w, h)
    : Object.assign(document.createElement('canvas'), { width: w, height: h })
  const ctx = c.getContext('2d', { willReadFrequently: true })
  ctx.drawImage(source, 0, 0, w, h)
  const px = ctx.getImageData(0, 0, w, h).data

  const grad = new Float32Array(w * h)
  let peak = 0
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      let best = 0
      for (let ch = 0; ch < 3; ch++) {
        const at = (xx, yy) => px[((yy * w + xx) << 2) + ch]
        const gx = at(x + 1, y - 1) + 2 * at(x + 1, y) + at(x + 1, y + 1)
          - at(x - 1, y - 1) - 2 * at(x - 1, y) - at(x - 1, y + 1)
        const gy = at(x - 1, y + 1) + 2 * at(x, y + 1) + at(x + 1, y + 1)
          - at(x - 1, y - 1) - 2 * at(x, y - 1) - at(x + 1, y - 1)
        const m = Math.sqrt(gx * gx + gy * gy)
        if (m > best) best = m
      }
      grad[y * w + x] = best
      if (best > peak) peak = best
    }
  }
  if (peak > 0) for (let i = 0; i < grad.length; i++) grad[i] /= peak
  return { w, h, grad, scale: k }
}

// One map per decoded frame. Building it is a canvas draw plus a Sobel pass —
// cheap once, far too slow to repeat on every pointer move while dragging.
const cache = new WeakMap()

/** The edge map for a frame, built on first ask and kept with it. */
export function edgeMapFor(source) {
  if (!source) return null
  const hit = cache.get(source)
  if (hit) return hit
  const map = buildEdgeMap(source)
  if (map) cache.set(source, map)
  return map
}

/** Image point to edge-map point. */
export const toMap = (map, x, y) => ({ x: x * map.scale, y: y * map.scale })

/** Edge-map point back to image space. */
export const fromMap = (map, x, y) => ({ x: x / map.scale, y: y / map.scale })

/**
 * The cheapest path from `from` to `to` that prefers to run along edges.
 *
 * Dijkstra over the pixel grid, with each step costing little where the
 * gradient is strong. Confined to a corridor around the two points: the path
 * cannot be helped by pixels far off to one side, and searching the whole image
 * on every pointer move would be far too slow to feel live.
 *
 * Returns points in map space, `from` first and `to` last. Falls back to a
 * straight line if the two points are further apart than the budget allows,
 * because a lasso that stops responding is worse than one that runs straight
 * for a moment.
 */
export function livewire(map, from, to, opts = {}) {
  const { pad = 28, maxNodes = 260000 } = opts
  const { w, h, grad } = map

  const x0 = Math.max(0, Math.min(from.x, to.x) - pad) | 0
  const y0 = Math.max(0, Math.min(from.y, to.y) - pad) | 0
  const x1 = Math.min(w - 1, Math.max(from.x, to.x) + pad) | 0
  const y1 = Math.min(h - 1, Math.max(from.y, to.y) + pad) | 0
  const bw = x1 - x0 + 1
  const bh = y1 - y0 + 1
  const straight = () => [{ x: from.x, y: from.y }, { x: to.x, y: to.y }]
  if (bw < 2 || bh < 2 || bw * bh > maxNodes) return straight()

  const sx = Math.round(from.x) - x0
  const sy = Math.round(from.y) - y0
  const tx = Math.round(to.x) - x0
  const ty = Math.round(to.y) - y0
  const inside = (x, y) => x >= 0 && y >= 0 && x < bw && y < bh
  if (!inside(sx, sy) || !inside(tx, ty)) return straight()

  const n = bw * bh
  const dist = new Float32Array(n).fill(Infinity)
  const prev = new Int32Array(n).fill(-1)
  const done = new Uint8Array(n)
  // A binary heap: a linear scan for the next node turns this into minutes.
  const heapI = new Int32Array(n * 4)
  const heapD = new Float32Array(n * 4)
  let heapN = 0
  const push = (i, d) => {
    let c = heapN++
    heapI[c] = i
    heapD[c] = d
    while (c > 0) {
      const p = (c - 1) >> 1
      if (heapD[p] <= heapD[c]) break
      const ti = heapI[p]; const td = heapD[p]
      heapI[p] = heapI[c]; heapD[p] = heapD[c]
      heapI[c] = ti; heapD[c] = td
      c = p
    }
  }
  const pop = () => {
    const top = heapI[0]
    heapN--
    if (heapN > 0) {
      heapI[0] = heapI[heapN]
      heapD[0] = heapD[heapN]
      let c = 0
      for (;;) {
        const l = c * 2 + 1
        const r = l + 1
        let m = c
        if (l < heapN && heapD[l] < heapD[m]) m = l
        if (r < heapN && heapD[r] < heapD[m]) m = r
        if (m === c) break
        const ti = heapI[m]; const td = heapD[m]
        heapI[m] = heapI[c]; heapD[m] = heapD[c]
        heapI[c] = ti; heapD[c] = td
        c = m
      }
    }
    return top
  }

  const start = sy * bw + sx
  const goal = ty * bw + tx
  dist[start] = 0
  push(start, 0)

  while (heapN > 0) {
    const cur = pop()
    if (done[cur]) continue
    done[cur] = 1
    if (cur === goal) break
    const cx = cur % bw
    const cy = (cur / bw) | 0
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (!dx && !dy) continue
        const nx = cx + dx
        const ny = cy + dy
        if (!inside(nx, ny)) continue
        const ni = ny * bw + nx
        if (done[ni]) continue
        const g = grad[(ny + y0) * w + (nx + x0)]
        // Strong edge, cheap step. The floor keeps every step positive, or the
        // search wanders along a plateau of free moves.
        const step = (1.02 - g) * (dx && dy ? Math.SQRT2 : 1)
        const nd = dist[cur] + step
        if (nd < dist[ni]) {
          dist[ni] = nd
          prev[ni] = cur
          push(ni, nd)
        }
      }
    }
  }

  if (dist[goal] === Infinity) return straight()
  const out = []
  for (let i = goal; i !== -1; i = prev[i]) {
    out.push({ x: (i % bw) + x0, y: ((i / bw) | 0) + y0 })
    if (i === start) break
  }
  out.reverse()
  return out
}

/**
 * Pulls each point of an outline onto the strongest edge near it.
 *
 * A matte predicted at 512px and traced gives an outline that is close to the
 * boundary and seldom on it. Moving each vertex to the best gradient within a
 * short distance costs almost nothing and is the difference between an outline
 * that looks traced and one that looks approximate.
 *
 * Points are moved only when there is a real edge to move to: on a soft
 * boundary — fur, motion blur — the strongest thing nearby may be noise, and
 * dragging the outline onto noise is worse than leaving it where the model put
 * it.
 */
export function snapToEdges(points, map, opts = {}) {
  const { radius = 4, minGrad = 0.12 } = opts
  const { w, h, grad } = map
  return points.map((p) => {
    const cx = Math.round(p.x)
    const cy = Math.round(p.y)
    let best = null
    let bestScore = 0
    for (let dy = -radius; dy <= radius; dy++) {
      for (let dx = -radius; dx <= radius; dx++) {
        const x = cx + dx
        const y = cy + dy
        if (x < 0 || y < 0 || x >= w || y >= h) continue
        const g = grad[y * w + x]
        if (g < minGrad) continue
        // Nearer wins ties, so a vertex does not jump across the subject to a
        // marginally stronger edge on the far side of it.
        const d = Math.hypot(dx, dy)
        const score = g / (1 + d * 0.35)
        if (score > bestScore) { bestScore = score; best = { x, y } }
      }
    }
    return best || p
  })
}
