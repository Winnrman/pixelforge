// Collage layout.
//
// Pure geometry: given how many photos there are and how big each one is, work
// out where every Polaroid sits, how much of each photo is visible, and how far
// it is tilted. Nothing here touches the DOM or the store, so the arrangement
// can be checked properly rather than eyeballed.

export const PHOTO_SHAPES = [
  { value: 'mixed', label: 'Mixed portrait & landscape', ratio: null },
  { value: 'square', label: 'Square', ratio: 1 },
  { value: 'portrait', label: 'Portrait', ratio: 3 / 4 },
  { value: 'landscape', label: 'Landscape', ratio: 4 / 3 },
  { value: 'source', label: 'Keep each photo’s shape', ratio: null },
]

// The three standard print shapes a mixed set snaps to. Snapping rather than
// keeping the exact source ratio is what makes a mixed wall read as a set of
// prints instead of an accident — and it stops one panorama from producing a
// card five cells wide.
const MIXED_RATIOS = [3 / 4, 1, 4 / 3]

const snapRatio = (ar) =>
  MIXED_RATIOS.reduce((best, r) =>
    (Math.abs(Math.log(ar / r)) < Math.abs(Math.log(ar / best)) ? r : best), MIXED_RATIOS[0])

/** The mount shape for one photo, given the chosen style. */
export function ratioFor(shape, srcW, srcH) {
  const ar = srcW / srcH || 1
  if (shape === 'mixed') return snapRatio(ar)
  if (shape === 'source') return ar
  const found = PHOTO_SHAPES.find((s) => s.value === shape)
  return found?.ratio || 1
}

export const COLLAGE_STYLES = [
  { value: 'polaroid', label: 'Polaroid' },
  { value: 'border', label: 'Even white border' },
  { value: 'none', label: 'No border' },
]

export const defaultCollage = () => ({
  width: 1800,         // canvas width; the height follows from the grid
  columns: 0,          // 0 = pick one that suits the count and the canvas
  style: 'polaroid',
  shape: 'square',
  border: 0.055,       // fraction of the card's short side
  angle: 5,            // maximum tilt, degrees either way
  // Negative is overlap: the card is drawn larger than its cell and laps over
  // its neighbours. Positive leaves a gap. A little overlap reads as a pile of
  // photographs, a gap reads as a contact sheet.
  gap: -0.07,
  sizeVary: 0.1,       // how much card sizes differ, fraction either way
  margin: 0.04,        // fraction of the canvas width, kept clear all round
  seed: 1,
  // One photo printed large, the way a wall of snapshots usually has a centre
  // piece. 'auto' picks the card nearest the middle of the grid, 'none' skips
  // it, or pass an index to choose.
  hero: 'auto',
  heroScale: 1.75,
  backdrop: true,
  backdropColor: '#17171c',
})

/**
 * Deterministic jitter.
 *
 * Rotation has to survive a re-render, an undo and a reload, so it cannot come
 * from Math.random — it is hashed from the photo's index and the collage seed.
 * Changing the seed reshuffles every angle, which is what "try again" means.
 */
function jitter(i, seed, salt) {
  let h = (i + 1) * 374761393 + seed * 668265263 + salt * 2246822519
  h = (h ^ (h >>> 13)) >>> 0
  h = Math.imul(h, 1274126177) >>> 0
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296
}

/**
 * How many columns to use.
 *
 * The aim is cells whose shape roughly matches the canvas, so the grid fills it
 * instead of leaving a band of empty space down one side. Solved directly
 * rather than searched: for a W×H canvas and N cells of aspect `cellAR`, the
 * column count that squares things up is sqrt(N * W / (H * cellAR)).
 */
export function bestColumns(count, canvasW, canvasH, cellAR = 1) {
  if (count <= 1) return 1
  const ideal = Math.sqrt((count * canvasW) / (canvasH * cellAR))
  let best = 1
  let bestCost = Infinity
  for (let c = 1; c <= count; c++) {
    const rows = Math.ceil(count / c)
    // Two costs: how far the grid is from the ideal shape, and how many cells
    // are left empty on the last row. A grid that fits perfectly but wastes
    // half a row is usually worse than a slightly off one that is full.
    const shape = Math.abs(Math.log(c / ideal))
    const waste = (c * rows - count) / count
    const cost = shape + waste * 0.6
    if (cost < bestCost) {
      bestCost = cost
      best = c
    }
  }
  return best
}

/** The photo's visible window, as a 0..1 sub-rect that covers `targetAR`. */
export function coverRect(srcW, srcH, targetAR) {
  const srcAR = srcW / srcH
  if (!(srcAR > 0) || !(targetAR > 0)) return { x: 0, y: 0, w: 1, h: 1 }
  if (srcAR > targetAR) {
    // Wider than the slot: trim the sides.
    const w = targetAR / srcAR
    return { x: (1 - w) / 2, y: 0, w, h: 1 }
  }
  const h = srcAR / targetAR
  return { x: 0, y: (1 - h) / 2, w: 1, h }
}

/**
 * Where the photo sits inside its card.
 *
 * A Polaroid is not an even border: the bottom is roughly three times the
 * others, which is the whole reason it reads as a Polaroid rather than as a
 * picture frame. Returned as fractions of the card so it survives scaling.
 */
export function cardInsets(style, border) {
  if (style === 'none') return { l: 0, r: 0, t: 0, b: 0 }
  const b = Math.max(0, border)
  if (style === 'border') return { l: b, r: b, t: b, b }
  return { l: b, r: b, t: b, b: b * 3.1 }
}

/**
 * Which card gets printed large.
 *
 * 'auto' takes the one whose cell is nearest the middle of the grid, so the
 * hero anchors the arrangement instead of hanging off a corner. A grid too
 * small to have a middle gets no hero at all — scaling one of four cards up
 * just buries the other three.
 */
function pickHero(hero, cards, columns, rows, n) {
  if (hero === 'none' || hero === -1 || hero == null) return -1
  if (typeof hero === 'number') return hero >= 0 && hero < n ? hero : -1
  if (n < 5 || columns < 3 || rows < 2) return -1
  const midCol = (columns - 1) / 2
  const midRow = (rows - 1) / 2
  let best = -1
  let bestCost = Infinity
  for (let i = 0; i < n; i++) {
    const col = i % columns
    const row = Math.floor(i / columns)
    // Edge cells are skipped: a hero on the boundary has to be clamped back in,
    // which pulls it off the grid it is supposed to sit on.
    if (col === 0 || col === columns - 1 || row === 0 || row === rows - 1) continue
    const cost = Math.abs(col - midCol) + Math.abs(row - midRow)
    if (cost < bestCost) {
      bestCost = cost
      best = i
    }
  }
  // No interior cell (a 3xN grid with 2 rows, say) — fall back to the centre.
  if (best < 0) best = Math.min(n - 1, Math.round(midRow) * columns + Math.round(midCol))
  return best
}

/**
 * Lays out a collage.
 *
 * `items` is `[{ width, height }]` in source pixels. Returns the canvas it
 * wants plus one entry per photo: the card rect in canvas coordinates, its
 * tilt, and the sub-rect of the source that should show through.
 */
export function layoutCollage(items, opts = {}) {
  const o = { ...defaultCollage(), ...opts }
  const n = items.length
  if (!n) return { width: 0, height: 0, cards: [], columns: 0, rows: 0 }

  const shape = PHOTO_SHAPES.find((s) => s.value === o.shape) || PHOTO_SHAPES[0]
  // Each photo's own mount shape. With a fixed shape they are all the same; with
  // 'mixed' or 'source' they differ, and the grid is planned against their
  // average so one outlier does not stretch every cell.
  const ratios = items.map((it) => ratioFor(o.shape, it.width, it.height))
  const photoAR = shape.ratio || (ratios.reduce((a, r) => a + r, 0) / n)
  const ins = cardInsets(o.style, o.border)
  // A card is the photo plus its borders, so it is never the photo's shape and
  // the grid has to be planned on the card. From first principles: the photo is
  // cardW * (1 - l - r) wide and cardH * (1 - t - b) tall, and their ratio must
  // come out as photoAR.
  const cw = 1 - ins.l - ins.r
  const ch = 1 - ins.t - ins.b
  const cardAspect = cw > 0 && ch > 0 ? (photoAR * ch) / cw : photoAR

  const canvasW = Math.max(64, Math.round(o.width || 1800))
  // The canvas height follows from the grid rather than being fixed, so the
  // collage is never letterboxed inside a shape it did not choose.
  const columns = o.columns > 0
    ? Math.min(Math.max(1, Math.round(o.columns)), n)
    : bestColumns(n, canvasW, Math.round(canvasW * 0.75), cardAspect)
  const rows = Math.ceil(n / columns)

  // Below zero the card outgrows its cell and laps over its neighbours.
  const gap = Math.max(-0.35, Math.min(0.4, o.gap))
  const vary = Math.max(0, Math.min(0.5, o.sizeVary ?? 0))
  const wobble = Math.max(0.05, Math.abs(gap)) * 0.35

  // How far past its own cell an outer card can reach, as a fraction of the
  // cell. Three things push it out: overlap and size variation make the card
  // bigger than the cell, the wobble shifts it, and tilt swings the corners
  // wider still. A rotated w x h box is (w·cos + h·sin) across, so the tilt
  // term is scaled by the taller of the two cell dimensions.
  // With mixed shapes a card is not the cell's shape, so its extents have to be
  // derived rather than assumed. Matching areas means w = sqrt(A·rho) and
  // h = sqrt(A/rho) in cell units, where rho is the card's aspect over the
  // cell's — so the widest and tallest cards fall out of the extreme ratios.
  // For a single fixed shape rho is 1 and both collapse to (1-gap)(1+vary),
  // which is what this was before mixed mounts existed.
  const rhos = shape.ratio ? [1] : ratios.map((r) => ((r * ch) / cw) / cardAspect)
  const A = ((1 - gap) * (1 + vary)) ** 2
  const widest = Math.sqrt(A * Math.max(...rhos))
  const tallest = Math.sqrt(A / Math.min(...rhos))
  const biggest = Math.max(widest, tallest)
  const rot = (Math.abs(o.angle) * Math.PI) / 180
  const tall = Math.max(1, 1 / cardAspect)
  const reach = (biggest * (Math.cos(rot) + tall * Math.sin(rot)) - 1) / 2 + wobble / 2
  const need = Math.max(0, reach)

  // Solved rather than guessed at. The margin has to cover `need` cells, but the
  // cell size itself depends on the margin — substituting one into the other
  // gives cellW = canvasW / (columns + 2·need) directly.
  const asked = Math.min(0.25, o.margin ?? 0.04) * canvasW
  // A negative margin is honoured as asked: letting the outer cards bleed off
  // the edge is a deliberate look, not a mistake to correct.
  const margin = o.margin < 0
    ? o.margin * canvasW
    : Math.max(asked, need * (canvasW / (columns + 2 * need)))

  const cellW = (canvasW - margin * 2) / columns
  const cellH = cellW / cardAspect
  const canvasH = Math.round(cellH * rows + margin * 2)

  const cardW = cellW * (1 - gap)
  const cardH = cellH * (1 - gap)

  // With overlap, which card sits on top matters. Strict index order deals them
  // in raster sequence and the whole thing reads as a shingled cascade running
  // down and to the right, so the stack is shuffled — deterministically, from
  // the same seed, or the pile would rearrange itself on every render.
  const z = Array.from({ length: n }, (_, i) => i)
  for (let i = n - 1; i > 0; i--) {
    const j = Math.floor(jitter(i, o.seed, 9) * (i + 1))
    const t = z[i]
    z[i] = z[j]
    z[j] = t
  }

  const cards = []
  for (let i = 0; i < n; i++) {
    const col = i % columns
    const row = Math.floor(i / columns)
    // The last row is centred when it is short, so the collage does not end on
    // a ragged left-aligned edge.
    const inRow = Math.min(columns, n - row * columns)
    const rowOffset = ((columns - inRow) * cellW) / 2

    const cx = margin + rowOffset + col * cellW + cellW / 2
    const cy = margin + row * cellH + cellH / 2
    // A little positional wobble as well as rotation: a grid of tilted cards on
    // exact centres still reads as a grid.
    const dx = (jitter(i, o.seed, 1) - 0.5) * cellW * wobble
    const dy = (jitter(i, o.seed, 2) - 0.5) * cellH * wobble

    const it = items[i]
    const thisAR = ratios[i]
    // Not every print comes back the same size, and a few percent either way is
    // most of what separates a pile of photos from a tiling.
    const scale = 1 + (jitter(i, o.seed, 4) - 0.5) * 2 * vary
    const thisCardAspect = (thisAR * ch) / cw
    // Cards of differing shapes are matched by *area*, not fitted inside the
    // cell. Fitting inside leaves a portrait card narrower than its cell and a
    // band of backdrop down each side, which is the opposite of what overlap is
    // for; equal areas keep every print the same size on the wall whatever
    // shape it is.
    const area = cardW * cardH
    const baseW = shape.ratio ? cardW : Math.sqrt(area * thisCardAspect)
    const w = baseW * scale
    const h = (shape.ratio ? cardH : baseW / thisCardAspect) * scale

    cards.push({
      index: i,
      x: cx + dx - w / 2,
      y: cy + dy - h / 2,
      w,
      h,
      rotation: (jitter(i, o.seed, 3) - 0.5) * 2 * o.angle,
      // Where this card sits in the pile; 0 is the bottom.
      z: z.indexOf(i),
      src: coverRect(it.width, it.height, thisAR),
      insets: ins,
    })
  }

  // One photo printed large. It is scaled about its own centre and moved to the
  // top of the pile rather than being given a cell of its own: the collage
  // already overlaps, so a big card lying over its neighbours is exactly the
  // look, and carving a hole out of the grid would leave the remaining cards
  // reflowing every time the hero changed.
  const heroIndex = pickHero(o.hero, cards, columns, rows, n)
  if (heroIndex >= 0) {
    const c = cards[heroIndex]
    const asked = Math.max(1, Math.min(3.5, o.heroScale ?? 1.75))
    // Capped so it actually fits. A rotated w x h card spans
    // (w·cos + h·sin) across, so the largest scale that still fits the canvas
    // follows directly — without this, asking for 3.5x on a small grid produced
    // a card bigger than the canvas, and clamping its centre then cannot help.
    const ra = (Math.abs(c.rotation) * Math.PI) / 180
    const spanX = c.w * Math.cos(ra) + c.h * Math.sin(ra)
    const spanY = c.w * Math.sin(ra) + c.h * Math.cos(ra)
    const k = Math.max(1, Math.min(asked, canvasW / spanX, canvasH / spanY))
    const cx = c.x + c.w / 2
    const cy = c.y + c.h / 2
    c.w *= k
    c.h *= k
    c.x = cx - c.w / 2
    c.y = cy - c.h / 2
    // Nudged back inside if it would hang off, which only happens on a small
    // grid where the middle cell is also an edge cell.
    const halfW = (spanX * k) / 2
    const halfH = (spanY * k) / 2
    const midX = Math.min(Math.max(c.x + c.w / 2, halfW), canvasW - halfW)
    const midY = Math.min(Math.max(c.y + c.h / 2, halfH), canvasH - halfH)
    c.x = midX - c.w / 2
    c.y = midY - c.h / 2
    c.hero = true
    // Top of the pile, and everything that was above it drops one place.
    for (const other of cards) if (other !== c && other.z > c.z) other.z -= 1
    c.z = n - 1
  }

  return {
    width: canvasW, height: canvasH, cards, columns, rows, cardAspect, margin,
    hero: heroIndex,
  }
}
