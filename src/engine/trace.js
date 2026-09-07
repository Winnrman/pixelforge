// Turning a segmentation mask into an editable lasso polygon.
//
// The AI-select button hands this module the soft mask aiMatte's predictMask
// produces and gets back the same normalized [x, y] points a hand-drawn lasso
// makes. That is the whole point: once the outline is ordinary lasso points,
// dragging a vertex, inverting the mask and masking a layer all keep working
// without anything downstream knowing where the outline came from.
//
// Nothing here touches the DOM. It is Float32Array/Uint8Array in and plain
// arrays out, so it runs under bare node — which is how test-trace.mjs checks
// the geometry rather than checking pixels by eye.

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v)

// Reads a pixel, treating everything outside the image as background. The
// contour walk leans on this so a region flush against the edge still gets a
// boundary there instead of running off the array.
const at = (b, w, h, x, y) => (x < 0 || y < 0 || x >= w || y >= h ? 0 : b[y * w + x])

// ------------------------------------------------------------- flood filling

/**
 * Marks the 4-connected above-threshold region containing `start` into `seen`,
 * returning how many pixels it covered.
 *
 * The stack is explicit and preallocated. Recursion is the obvious way to write
 * this and it is wrong here: a 320×320 mask that is mostly foreground is a
 * hundred thousand pixels deep, which overflows the call stack long before the
 * fill finishes. Every pixel is marked as it is pushed, so it can never be
 * pushed twice and w*h is a hard bound on the stack.
 */
const fillFrom = (mask, w, h, start, threshold, seen, stack) => {
  const n = w * h
  let top = 0
  let count = 0
  stack[top++] = start
  seen[start] = 1
  while (top > 0) {
    const i = stack[--top]
    count++
    const x = i % w
    // 4-connectivity, not 8: diagonal steps let a mask leak through the
    // one-pixel pinches that soft segmentation edges are full of.
    if (x > 0 && !seen[i - 1] && mask[i - 1] > threshold) { seen[i - 1] = 1; stack[top++] = i - 1 }
    if (x < w - 1 && !seen[i + 1] && mask[i + 1] > threshold) { seen[i + 1] = 1; stack[top++] = i + 1 }
    if (i >= w && !seen[i - w] && mask[i - w] > threshold) { seen[i - w] = 1; stack[top++] = i - w }
    if (i + w < n && !seen[i + w] && mask[i + w] > threshold) { seen[i + w] = 1; stack[top++] = i + w }
  }
  return count
}

/**
 * The connected above-threshold region containing pixel (x, y), as a w*h
 * Uint8Array of 1 inside / 0 outside. Null when the click landed on background
 * or outside the image — the caller needs to be able to tell the user nothing
 * was picked rather than silently selecting something else.
 */
export function componentAt(mask, w, h, x, y, threshold = 0.5) {
  const px = Math.floor(x)
  const py = Math.floor(y)
  if (!(px >= 0 && py >= 0 && px < w && py < h)) return null
  const start = py * w + px
  if (!(mask[start] > threshold)) return null
  const out = new Uint8Array(w * h)
  fillFrom(mask, w, h, start, threshold, out, new Int32Array(w * h))
  return out
}

/**
 * The biggest above-threshold region in the mask, for when there is no click to
 * go on — a toolbar button rather than a click on the image. Null if the mask
 * is empty at this threshold.
 */
export function largestComponent(mask, w, h, threshold = 0.5) {
  const n = w * h
  const seen = new Uint8Array(n)
  const stack = new Int32Array(n)
  let best = -1
  let bestCount = 0
  for (let s = 0; s < n; s++) {
    if (seen[s] || !(mask[s] > threshold)) continue
    const count = fillFrom(mask, w, h, s, threshold, seen, stack)
    if (count > bestCount) { bestCount = count; best = s }
  }
  if (best < 0) return null
  const out = new Uint8Array(n)
  fillFrom(mask, w, h, best, threshold, out, stack)
  return out
}

/**
 * Fills interior holes: floods the background inward from the border and calls
 * anything it never reached inside.
 *
 * This matters more than it sounds. A person mask nearly always has a gap
 * between an arm and the body, and a contour that dives into that gap, round
 * the inside and back out produces a selection nobody asked for. Closing the
 * holes first means the traced outline is the silhouette.
 *
 * The background flood is 8-connected on purpose. Foreground is 4-connected
 * here, and the two have to be opposites or a diagonal chain of pixels counts
 * as both a wall and not a wall, and enclosure stops being well defined.
 */
export function fillHoles(binary, w, h) {
  const n = w * h
  const out = Uint8Array.from(binary)
  const reached = new Uint8Array(n)
  const stack = new Int32Array(n)
  let top = 0
  const push = (i) => {
    if (!reached[i] && !binary[i]) { reached[i] = 1; stack[top++] = i }
  }
  for (let x = 0; x < w; x++) { push(x); push((h - 1) * w + x) }
  for (let y = 0; y < h; y++) { push(y * w); push(y * w + w - 1) }
  while (top > 0) {
    const i = stack[--top]
    const x = i % w
    const y = (i - x) / w
    for (let dy = -1; dy <= 1; dy++) {
      const ny = y + dy
      if (ny < 0 || ny >= h) continue
      for (let dx = -1; dx <= 1; dx++) {
        const nx = x + dx
        if (nx < 0 || nx >= w) continue
        push(ny * w + nx)
      }
    }
  }
  for (let i = 0; i < n; i++) if (!reached[i]) out[i] = 1
  return out
}

// ---------------------------------------------------------------- contouring

const RIGHT = 0
const DOWN = 1
const LEFT = 2
const UP = 3
const DX = [1, 0, -1, 0]
const DY = [0, 1, 0, -1]

/**
 * Marching squares over the crack lattice — the grid of pixel *corners* — and
 * not Moore-neighbour tracing over pixel centres.
 *
 * Two reasons for the choice. The corner walk encloses whole pixels, so the
 * shoelace area of the outline equals the region's pixel count exactly; centre
 * tracing loses half a pixel the whole way round, which is a 2% shortfall on a
 * 100px square and worse on anything smaller. And a single-pixel region comes
 * out as an honest 4-point square rather than a degenerate dot that no lasso
 * could edit.
 *
 * The turn table below is indexed by the four pixels touching the current
 * corner. Cases 6 and 9 are the diagonal saddles and are genuinely ambiguous;
 * they are resolved from the incoming direction so that foreground stays
 * 4-connected, matching the flood fill above.
 */
const nextDir = (v, dir) => {
  switch (v) {
    case 1: case 3: case 11: return LEFT
    case 2: case 10: case 14: return UP
    case 4: case 5: case 7: return DOWN
    case 8: case 12: case 13: return RIGHT
    case 6: return dir === RIGHT ? DOWN : UP
    case 9: return dir === DOWN ? LEFT : RIGHT
    default: return -1
  }
}

/**
 * The outer boundary of the region as an ordered ring of [x, y] corner
 * coordinates, going round once. Empty array for an empty binary.
 *
 * Only the component containing the first foreground pixel in raster order is
 * traced, which is exactly right after componentAt or largestComponent has
 * already reduced the mask to one region. Holes have their own contours and are
 * never started on, so what comes back is the silhouette.
 */
export function traceContour(binary, w, h) {
  const n = w * h
  let start = -1
  for (let i = 0; i < n; i++) {
    if (binary[i]) { start = i; break }
  }
  if (start < 0) return []

  const sx = start % w
  const sy = (start - sx) / w
  // The raster-first pixel always sits at case 8 — everything above and to its
  // left is background — so the walk can start rightward with no guessing, and
  // that corner has exactly one way out, which makes "back at the start" a
  // sound stopping test even when the ring passes through saddles.
  let x = sx
  let y = sy
  let dir = RIGHT
  const points = []
  const limit = 4 * (w + 1) * (h + 1) + 8
  do {
    points.push([x, y])
    const ul = at(binary, w, h, x - 1, y - 1)
    const ur = at(binary, w, h, x, y - 1)
    const dl = at(binary, w, h, x - 1, y)
    const dr = at(binary, w, h, x, y)
    const nd = nextDir(ul | (ur << 1) | (dl << 2) | (dr << 3), dir)
    if (nd < 0) break
    dir = nd
    x += DX[dir]
    y += DY[dir]
  } while (!(x === sx && y === sy) && points.length < limit)
  return points
}

/** Signed shoelace area. Sign is the winding direction; callers usually want abs. */
export function polygonArea(points) {
  const n = points.length
  if (n < 3) return 0
  let a = 0
  for (let i = 0; i < n; i++) {
    const p = points[i]
    const q = points[(i + 1) % n]
    a += p[0] * q[1] - q[0] * p[1]
  }
  return a / 2
}

// -------------------------------------------------------------- simplifying

// Douglas–Peucker on an open chain, with an explicit stack for the same reason
// the flood fill has one: a traced contour is thousands of points long.
const dpChain = (pts, tol) => {
  const n = pts.length
  if (n < 3) return pts.slice()
  const keep = new Uint8Array(n)
  keep[0] = 1
  keep[n - 1] = 1
  const stack = [[0, n - 1]]
  while (stack.length) {
    const span = stack.pop()
    const i0 = span[0]
    const i1 = span[1]
    if (i1 <= i0 + 1) continue
    const x0 = pts[i0][0]
    const y0 = pts[i0][1]
    const dx = pts[i1][0] - x0
    const dy = pts[i1][1] - y0
    const len = Math.hypot(dx, dy)
    let far = -1
    let farD = tol
    for (let i = i0 + 1; i < i1; i++) {
      const px = pts[i][0]
      const py = pts[i][1]
      // A zero-length span has no line to measure against, so fall back to the
      // radius from its endpoint.
      const d = len > 0
        ? Math.abs(dy * (px - x0) - dx * (py - y0)) / len
        : Math.hypot(px - x0, py - y0)
      if (d > farD) { farD = d; far = i }
    }
    if (far < 0) continue
    keep[far] = 1
    stack.push([i0, far], [far, i1])
  }
  return pts.filter((_, i) => keep[i])
}

/**
 * Douglas–Peucker on a *closed* polygon. The first point is preserved and the
 * result is always a subset of the input.
 *
 * The closure is the whole difficulty. Douglas–Peucker needs two fixed
 * endpoints, and a ring has none; running it on points[0]..points[n-1] as if it
 * were an open path measures every vertex against a chord that is not an edge
 * of the shape, and a long arc on the far side can collapse into it. So the
 * ring is cut at two anchors instead — points[0], and the vertex farthest from
 * it, which is an extreme of the shape and therefore survives any tolerance —
 * and the two halves are simplified as open chains and stitched back together.
 * The closing edge from the last kept point to points[0] stays implicit, the
 * same convention addMaskPath uses.
 */
export function simplify(points, tolerance) {
  const n = points.length
  if (n < 4 || !(tolerance > 0)) return points.slice()
  let far = 0
  let farD = -1
  for (let i = 1; i < n; i++) {
    const dx = points[i][0] - points[0][0]
    const dy = points[i][1] - points[0][1]
    const d = dx * dx + dy * dy
    if (d > farD) { farD = d; far = i }
  }
  if (far < 1 || far > n - 2) return dpChain(points, tolerance)
  const head = dpChain(points.slice(0, far + 1), tolerance)
  const tail = dpChain(points.slice(far), tolerance)
  return head.concat(tail.slice(1))
}

/**
 * A light moving-average pass round the closed ring, so the outline does not
 * read as pixel stair-steps.
 *
 * Averaging alone pulls every vertex toward the centroid — on a 4-point square
 * at full strength that costs three quarters of the area — and a lasso that
 * quietly creeps inside the subject is worse than a jagged one. So the pass is
 * followed by a uniform scale about the centroid that puts the original area
 * back. The steps go, the silhouette stays where it was, and the point count is
 * unchanged, which matters because this runs after simplify has already met the
 * caller's maxPoints budget.
 */
export function smoothPolygon(points, strength = 0.5) {
  const n = points.length
  if (n < 4 || !(strength > 0)) return points.map((p) => [p[0], p[1]])
  const s = Math.min(1, strength) * 0.5
  const out = new Array(n)
  for (let i = 0; i < n; i++) {
    const p = points[i]
    const a = points[(i + n - 1) % n]
    const b = points[(i + 1) % n]
    out[i] = [
      p[0] + s * ((a[0] + b[0]) / 2 - p[0]),
      p[1] + s * ((a[1] + b[1]) / 2 - p[1]),
    ]
  }
  const before = Math.abs(polygonArea(points))
  const after = Math.abs(polygonArea(out))
  if (!(before > 0) || !(after > 0)) return out
  const k = Math.sqrt(before / after)
  let cx = 0
  let cy = 0
  for (const p of out) { cx += p[0]; cy += p[1] }
  cx /= n
  cy /= n
  return out.map((p) => [cx + (p[0] - cx) * k, cy + (p[1] - cy) * k])
}

// ----------------------------------------------------------------- pipeline

/**
 * Mask to editable lasso polygon, end to end.
 *
 * Returns { points, area, bounds } where `points` are [x, y] pairs normalized
 * 0..1 against w and h — the shape addMaskPath and polygonToLayer expect —
 * `area` is the region's pixel count, and `bounds` is the polygon's normalized
 * box. Null when the click landed on background, when the mask is empty, or
 * when what was found is smaller than minArea; the caller has to be able to say
 * "nothing there" rather than dropping a stray speck of a mask on the layer.
 *
 * A click that misses is not quietly upgraded to the largest region: the user
 * pointed somewhere specific, and selecting a different subject instead is a
 * worse answer than selecting nothing.
 */
export function maskToPolygon(mask, w, h, opts = {}) {
  const {
    x, y,
    threshold = 0.5,
    tolerance = 1.5,
    smooth = 0.5,
    fillHoles: doFillHoles = true,
    maxPoints = 120,
    minArea = 24,
  } = opts

  const aimed = Number.isFinite(x) && Number.isFinite(y)
  const region = aimed
    ? componentAt(mask, w, h, x, y, threshold)
    : largestComponent(mask, w, h, threshold)
  if (!region) return null

  const solid = doFillHoles ? fillHoles(region, w, h) : region
  let area = 0
  for (let i = 0; i < solid.length; i++) area += solid[i]
  if (area < minArea) return null

  const contour = traceContour(solid, w, h)
  if (contour.length < 3) return null

  // Over budget means re-simplify at a coarser tolerance, not slice the tail
  // off. The ring closes implicitly from the last point back to the first, so a
  // truncated outline would draw a chord straight across the subject rather
  // than just losing detail.
  let tol = tolerance
  let poly = simplify(contour, tol)
  for (let i = 0; i < 6 && poly.length > maxPoints; i++) {
    tol = tol > 0 ? tol * 2 : 1
    poly = simplify(contour, tol)
  }

  poly = smoothPolygon(poly, smooth)

  // Corner coordinates run 0..w, so this lands in 0..1 already; the clamp is
  // only there because smoothing's area compensation can push a vertex a
  // fraction of a pixel past the edge.
  const points = poly.map((p) => [clamp01(p[0] / w), clamp01(p[1] / h)])

  let x0 = Infinity
  let y0 = Infinity
  let x1 = -Infinity
  let y1 = -Infinity
  for (const p of points) {
    if (p[0] < x0) x0 = p[0]
    if (p[1] < y0) y0 = p[1]
    if (p[0] > x1) x1 = p[0]
    if (p[1] > y1) y1 = p[1]
  }
  return { points, area, bounds: { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } }
}
