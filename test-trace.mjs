// Mask -> lasso polygon, checked as geometry rather than by eye. Every mask
// here is synthesised, so the numbers below are exact expectations, not
// eyeballed ones.
import {
  componentAt, largestComponent, fillHoles, traceContour, simplify,
  smoothPolygon, maskToPolygon,
} from './src/engine/trace.js'

const checks = []
const check = (name, ok, detail = '') => {
  checks.push([name, ok])
  console.log((ok ? 'PASS  ' : 'FAIL  ') + name + (detail ? '  — ' + detail : ''))
}

// --- helpers ----------------------------------------------------------------

const blank = (w, h) => new Float32Array(w * h)

const disc = (mask, w, h, cx, cy, r, v = 1) => {
  let count = 0
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const dx = x - cx
      const dy = y - cy
      if (dx * dx + dy * dy <= r * r) { mask[y * w + x] = v; count++ }
    }
  }
  return count
}

const rect = (mask, w, h, x0, y0, x1, y1, v = 1) => {
  let count = 0
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) { mask[y * w + x] = v; count++ }
  }
  return count
}

const countOver = (m, t = 0.5) => {
  let n = 0
  for (let i = 0; i < m.length; i++) if (m[i] > t) n++
  return n
}

const sumBinary = (b) => {
  let n = 0
  for (let i = 0; i < b.length; i++) n += b[i]
  return n
}

// Shoelace, written out here rather than imported so the module's own area
// helper cannot agree with itself.
const area = (pts) => {
  let a = 0
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i]
    const q = pts[(i + 1) % pts.length]
    a += p[0] * q[1] - q[0] * p[1]
  }
  return Math.abs(a / 2)
}

const bbox = (pts) => {
  let x0 = Infinity
  let y0 = Infinity
  let x1 = -Infinity
  let y1 = -Infinity
  for (const p of pts) {
    if (p[0] < x0) x0 = p[0]
    if (p[1] < y0) y0 = p[1]
    if (p[0] > x1) x1 = p[0]
    if (p[1] > y1) y1 = p[1]
  }
  return { x0, y0, x1, y1 }
}

// Ray casting, half-open on y so a vertex is never counted twice.
const inPolygon = (pts, px, py) => {
  let inside = false
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const xi = pts[i][0]
    const yi = pts[i][1]
    const xj = pts[j][0]
    const yj = pts[j][1]
    if ((yi > py) !== (yj > py) && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) inside = !inside
  }
  return inside
}

const mulberry32 = (seed) => () => {
  seed = (seed + 0x6d2b79f5) | 0
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296
}

const pct = (a, b) => (((a - b) / b) * 100).toFixed(2) + '%'

// --- componentAt picks the disc that was clicked ----------------------------
{
  const W = 200
  const H = 200
  const m = blank(W, H)
  const areaA = disc(m, W, H, 50, 100, 25)
  const areaB = disc(m, W, H, 150, 100, 25)
  console.log(`two discs r=25: left ${areaA}px, right ${areaB}px, total ${countOver(m)}px`)

  const got = componentAt(m, W, H, 50, 100)
  const gotCount = sumBinary(got)
  check('componentAt returns exactly the clicked disc',
    gotCount === areaA, `${gotCount}px vs the disc's ${areaA}px (tolerance: exact, a flood fill is not approximate)`)

  let leaked = 0
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const dx = x - 150
      const dy = y - 100
      if (dx * dx + dy * dy <= 625 && got[y * W + x]) leaked++
    }
  }
  check('and no pixel of the other disc', leaked === 0, `${leaked} leaked pixels`)

  check('componentAt is null on background', componentAt(m, W, H, 100, 100) === null)
  check('componentAt is null outside the image on every side',
    componentAt(m, W, H, -5, 100) === null && componentAt(m, W, H, 100, -1) === null &&
    componentAt(m, W, H, 500, 100) === null && componentAt(m, W, H, 100, 500) === null)

  const big = largestComponent(m, W, H)
  check('largestComponent finds one whole disc with no click to go on',
    sumBinary(big) === areaA, `${sumBinary(big)}px`)
  check('largestComponent is null on an empty mask',
    largestComponent(blank(20, 20), 20, 20) === null)
}

// --- the recursion trap -----------------------------------------------------
{
  const S = 320
  const m = new Float32Array(S * S).fill(1)
  let ok = true
  let count = 0
  try {
    count = sumBinary(componentAt(m, S, S, 160, 160))
  } catch (err) {
    ok = false
    console.log('  threw:', err.message)
  }
  check('a fully-foreground 320x320 mask floods without blowing the stack',
    ok && count === S * S, `${count}px of ${S * S}`)
}

// --- fillHoles closes an annulus --------------------------------------------
{
  const W = 120
  const H = 120
  const m = blank(W, H)
  const outer = disc(m, W, H, 60, 60, 40)
  disc(m, W, H, 60, 60, 20, 0)
  const ring = countOver(m)
  const bin = componentAt(m, W, H, 60, 25)
  const before = sumBinary(bin)
  const after = sumBinary(fillHoles(bin, W, H))
  console.log(`annulus r 20..40: ${ring}px ring, solid disc is ${outer}px, pi*40^2 = ${(Math.PI * 1600).toFixed(0)}px`)
  check('fillHoles turns the ring solid',
    after === outer, `${before}px before -> ${after}px after, expected ${outer}px`)
  check('and the filled disc is within 1% of pi*R^2',
    Math.abs(after - Math.PI * 1600) / (Math.PI * 1600) < 0.01, pct(after, Math.PI * 1600))
  const untouched = fillHoles(componentAt(blank(10, 10).fill(1), 10, 10, 5, 5), 10, 10)
  check('fillHoles leaves a hole-free region alone', sumBinary(untouched) === 100)
}

// --- traceContour on a square ------------------------------------------------
let squareContour = null
{
  const W = 140
  const H = 140
  const m = blank(W, H)
  const px = rect(m, W, H, 10, 10, 109, 109)   // 100x100, pixels 10..109
  const bin = componentAt(m, W, H, 50, 50)
  const pts = traceContour(bin, W, H)
  squareContour = pts
  const bb = bbox(pts)
  const a = area(pts)
  console.log(`100x100 square: ${pts.length} contour points, perimeter 400, area ${a} vs ${px}px`)
  check('the traced square is a closed loop of about its perimeter',
    Math.abs(pts.length - 400) <= 4, `${pts.length} points vs 400`)
  check('its bounding box is the square',
    bb.x0 === 10 && bb.y0 === 10 && bb.x1 === 110 && bb.y1 === 110,
    JSON.stringify(bb))
  check('and its area matches the pixel count within 0.5%',
    Math.abs(a - px) / px < 0.005, `${a} vs ${px} (${pct(a, px)})`)
  check('no point is repeated, so the ring goes round exactly once',
    new Set(pts.map((p) => p.join(','))).size === pts.length)
  check('an empty binary traces to nothing',
    traceContour(new Uint8Array(W * H), W, H).length === 0)

  const one = blank(20, 20)
  one[10 * 20 + 10] = 1
  const dot = traceContour(componentAt(one, 20, 20, 10, 10), 20, 20)
  check('a single pixel traces to a 4-point square of area 1',
    dot.length === 4 && area(dot) === 1, `${dot.length} points, area ${area(dot)}`)
}

// --- traceContour on a disc --------------------------------------------------
{
  const W = 120
  const H = 120
  const m = blank(W, H)
  const px = disc(m, W, H, 60, 60, 40)
  const pts = traceContour(componentAt(m, W, H, 60, 60), W, H)
  const a = area(pts)
  const ideal = Math.PI * 1600
  console.log(`disc R=40: ${pts.length} points, traced area ${a}, pixels ${px}, pi*R^2 ${ideal.toFixed(1)}`)
  check('the traced disc area matches its pixel count exactly',
    a === px, `${a} vs ${px}`)
  check('and is within 3% of pi*R^2', Math.abs(a - ideal) / ideal < 0.03, pct(a, ideal))
}

// --- traceContour on a concave C ---------------------------------------------
{
  const W = 140
  const H = 140
  const m = blank(W, H)
  disc(m, W, H, 70, 70, 45)
  disc(m, W, H, 70, 70, 22, 0)
  // Slot opening to the right, turning the annulus into a C.
  rect(m, W, H, 70, 58, 139, 82, 0)
  const px = countOver(m)
  const bin = componentAt(m, W, H, 30, 70)
  const pts = traceContour(bin, W, H)
  const a = area(pts)
  console.log(`C shape: ${px}px, ${pts.length} contour points, traced area ${a}`)
  check('the C traces to its own pixel count, notch and all',
    a === sumBinary(bin), `${a} vs ${sumBinary(bin)}px`)
  check('a point in the slot is outside the polygon',
    !inPolygon(pts, 100.5, 70.5), 'point (100.5, 70.5)')
  check('the hollow centre is outside it too',
    !inPolygon(pts, 70.5, 70.5), 'point (70.5, 70.5)')
  check('but a point in the arm of the C is inside',
    inPolygon(pts, 70.5, 32.5), 'point (70.5, 32.5)')
}

// --- traceContour against the image edge -------------------------------------
{
  const W = 60
  const H = 60
  const m = blank(W, H)
  const px = rect(m, W, H, 0, 0, 29, 59)   // flush left, top and bottom
  const pts = traceContour(componentAt(m, W, H, 5, 5), W, H)
  const bb = bbox(pts)
  console.log(`edge-flush 30x60 block: ${pts.length} points, bbox ${JSON.stringify(bb)}, area ${area(pts)}`)
  check('a region flush against three edges keeps them',
    bb.x0 === 0 && bb.y0 === 0 && bb.x1 === 30 && bb.y1 === 60, JSON.stringify(bb))
  check('and its area is still exact', area(pts) === px, `${area(pts)} vs ${px}px`)
}

// --- simplify -----------------------------------------------------------------
{
  const before = squareContour
  const after = simplify(before, 1.5)
  const aB = area(before)
  const aA = area(after)
  console.log(`simplify(1.5): ${before.length} -> ${after.length} points, area ${aB} -> ${aA}`)
  check('a traced square simplifies to 4-8 points',
    after.length >= 4 && after.length <= 8, `${after.length} points`)
  check('and keeps its area within 0.5%',
    Math.abs(aA - aB) / aB < 0.005, `${aA} vs ${aB} (${pct(aA, aB)})`)
  check('the first point survives',
    after[0][0] === before[0][0] && after[0][1] === before[0][1])
  const set = new Set(before.map((p) => p.join(',')))
  check('every kept point came from the input',
    after.every((p) => set.has(p.join(','))))

  // The closed-ring handling is the point: an open-path DP would swallow one
  // whole side of the square into the chord from first point to last.
  const tight = simplify(before, 0.01)
  check('a tiny tolerance still drops the collinear runs',
    tight.length >= 4 && tight.length <= 8 && Math.abs(area(tight) - aB) / aB < 0.005,
    `${tight.length} points, area ${area(tight)}`)
}

// --- smoothPolygon does not shrink -------------------------------------------
{
  const W = 120
  const H = 120
  const m = blank(W, H)
  disc(m, W, H, 60, 60, 40)
  const poly = simplify(traceContour(componentAt(m, W, H, 60, 60), W, H), 1.5)
  const sm = smoothPolygon(poly, 0.5)
  const aB = area(poly)
  const aA = area(sm)
  console.log(`smooth(0.5) on a ${poly.length}-point disc: area ${aB.toFixed(1)} -> ${aA.toFixed(1)} (${pct(aA, aB)})`)
  check('smoothing keeps the point count', sm.length === poly.length)
  check('and the area, within 0.5%', Math.abs(aA - aB) / aB < 0.005, pct(aA, aB))

  // Area is restored by construction, so on its own that check proves nothing.
  // The claim that earns its keep is that the stair-steps actually go: on the
  // raw traced contour, every edge is an axis-aligned pixel step, and a right
  // angle is longer than the diagonal that replaces it.
  const raw = traceContour(componentAt(m, W, H, 60, 60), W, H)
  const rawS = smoothPolygon(raw, 0.5)
  const perim = (pts) => {
    let p = 0
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i]
      const b = pts[(i + 1) % pts.length]
      p += Math.hypot(b[0] - a[0], b[1] - a[1])
    }
    return p
  }
  console.log(`smooth(0.5) on the raw ${raw.length}-point contour: perimeter ${perim(raw).toFixed(1)} -> ${perim(rawS).toFixed(1)} (${pct(perim(rawS), perim(raw))}), area ${pct(area(rawS), area(raw))}`)
  check('smoothing shortens a stair-stepped perimeter toward the true circle',
    perim(rawS) < perim(raw) * 0.95 && perim(rawS) > 2 * Math.PI * 40 * 0.95,
    `${perim(rawS).toFixed(1)} vs ${perim(raw).toFixed(1)}, circle is ${(2 * Math.PI * 40).toFixed(1)}`)
  check('while still holding the area', Math.abs(area(rawS) - area(raw)) / area(raw) < 0.005,
    pct(area(rawS), area(raw)))

  const sq = [[0, 0], [10, 0], [10, 10], [0, 10]]
  const sqS = smoothPolygon(sq, 1)
  console.log(`smooth(1) on a 4-point square: area ${area(sq)} -> ${area(sqS).toFixed(3)}`)
  check('even a bare 4-point square keeps its area at full strength',
    Math.abs(area(sqS) - 100) < 0.5, `${area(sqS).toFixed(3)} vs 100`)
  check('and stays centred', Math.abs(sqS[0][0] + sqS[2][0] - 10) < 1e-9)
}

// --- maskToPolygon, end to end ------------------------------------------------
{
  const W = 200
  const H = 160
  const m = blank(W, H)
  const px = disc(m, W, H, 80, 70, 40)
  const res = maskToPolygon(m, W, H, { x: 80, y: 70 })
  console.log('maskToPolygon:', res.points.length, 'points, area', res.area,
    'bounds', JSON.stringify(res.bounds))
  check('it finds the disc', res && res.area === px, `${res.area}px vs ${px}px`)
  check('every normalized point is inside 0..1',
    res.points.every((p) => p[0] >= 0 && p[0] <= 1 && p[1] >= 0 && p[1] <= 1))
  const want = { x: 40 / W, y: 30 / H, w: 81 / W, h: 81 / H }
  const near = (a, b) => Math.abs(a - b) < 0.02
  check('the bounds match the disc',
    near(res.bounds.x, want.x) && near(res.bounds.y, want.y) &&
    near(res.bounds.w, want.w) && near(res.bounds.h, want.h),
    `got ${JSON.stringify(res.bounds)} want ${JSON.stringify(want)}`)
  // Denormalised, the polygon should still cover the disc's pixel area.
  const back = res.points.map((p) => [p[0] * W, p[1] * H])
  check('and the polygon still covers the disc area within 3%',
    Math.abs(area(back) - px) / px < 0.03, `${area(back).toFixed(1)} vs ${px}px (${pct(area(back), px)})`)

  check('a click on background gives null', maskToPolygon(m, W, H, { x: 190, y: 150 }) === null)
  check('a click outside the image gives null', maskToPolygon(m, W, H, { x: -3, y: 70 }) === null)

  const speck = blank(W, H)
  rect(speck, W, H, 100, 100, 102, 102)   // 9px, under the default minArea of 24
  check('a region under minArea gives null',
    maskToPolygon(speck, W, H, { x: 101, y: 101 }) === null, '9px region, minArea 24')
  check('and the same region comes back once minArea allows it',
    maskToPolygon(speck, W, H, { x: 101, y: 101, minArea: 4 }).area === 9)

  check('with no click it falls back to the largest region',
    maskToPolygon(m, W, H).area === px)
  check('an empty mask gives null', maskToPolygon(blank(W, H), W, H) === null)

  // Holes: a mask with an enclosed gap must come back as the silhouette.
  const holed = blank(W, H)
  const solid = disc(holed, W, H, 80, 70, 40)
  disc(holed, W, H, 80, 70, 12, 0)
  const filled = maskToPolygon(holed, W, H, { x: 80, y: 40 })
  const raw = maskToPolygon(holed, W, H, { x: 80, y: 40, fillHoles: false })
  console.log(`holed disc: fillHoles on ${filled.area}px, off ${raw.area}px, solid disc ${solid}px`)
  check('fillHoles:true recovers the whole silhouette',
    filled.area === solid, `${filled.area}px vs ${solid}px`)
  check('fillHoles:false leaves the hole out of the area',
    raw.area < solid, `${raw.area}px`)
}

// --- maxPoints ------------------------------------------------------------------
{
  const W = 200
  const H = 200
  const m = blank(W, H)
  disc(m, W, H, 100, 100, 70)
  const loose = maskToPolygon(m, W, H, { x: 100, y: 100, tolerance: 0.5 })
  const capped = maskToPolygon(m, W, H, { x: 100, y: 100, tolerance: 0.5, maxPoints: 20 })
  console.log(`maxPoints: uncapped ${loose.points.length} points, capped ${capped.points.length} (limit 20)`)
  check('maxPoints is respected by raising the tolerance, not truncating',
    capped.points.length <= 20 && loose.points.length > 20,
    `${loose.points.length} -> ${capped.points.length}`)
  const backL = loose.points.map((p) => [p[0] * W, p[1] * H])
  const backC = capped.points.map((p) => [p[0] * W, p[1] * H])
  check('and the capped outline still encloses nearly the same area',
    Math.abs(area(backC) - area(backL)) / area(backL) < 0.05,
    `${area(backC).toFixed(0)} vs ${area(backL).toFixed(0)} (${pct(area(backC), area(backL))})`)
}

// --- timing on a real-sized mask -------------------------------------------------
{
  const S = 320
  const m = blank(S, S)
  disc(m, S, S, 150, 150, 90)
  rect(m, S, S, 120, 200, 180, 300)          // a body under the head
  disc(m, S, S, 150, 150, 25, 0)             // and a hole to fill
  // Seeded noise, so the contour has to deal with a ragged edge like a real one.
  const rand = mulberry32(20260906)
  for (let i = 0; i < S * S; i++) m[i] = Math.min(1, Math.max(0, m[i] + (rand() - 0.5) * 0.6))

  const t0 = performance.now()
  let out = null
  for (let i = 0; i < 10; i++) out = maskToPolygon(m, S, S, { x: 150, y: 250 })
  const ms = (performance.now() - t0) / 10
  console.log(`320x320 noisy mask -> polygon: ${ms.toFixed(2)} ms/run, ${out.points.length} points, ${out.area}px`)
  check('the full pipeline survives a noisy 320x320 mask', out !== null && out.points.length >= 3)
  check('and runs in well under a frame', ms < 50, `${ms.toFixed(2)} ms`)
}

const failed = checks.filter(([, ok]) => !ok).length
console.log(`\n${checks.length - failed}/${checks.length} checks passed`)
process.exit(failed ? 1 : 0)
