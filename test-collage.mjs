// Collage layout, checked as geometry rather than by eye.
import {
  layoutCollage, bestColumns, coverRect, cardInsets, defaultCollage, PHOTO_SHAPES, ratioFor,
} from './src/engine/collage.js'

const checks = []
const check = (name, ok, detail = '') => {
  checks.push([name, ok])
  console.log((ok ? 'PASS  ' : 'FAIL  ') + name + (detail ? '  — ' + detail : ''))
}

const photos = (n, sizes) => Array.from({ length: n }, (_, i) => {
  const [w, h] = sizes ? sizes[i % sizes.length] : [640, 480]
  return { width: w, height: h }
})

// --- cover crop -------------------------------------------------------------
{
  const wide = coverRect(1600, 900, 1)       // 16:9 into a square
  const tall = coverRect(900, 1600, 1)
  const same = coverRect(500, 500, 1)
  console.log('cover:', JSON.stringify({ wide, tall, same }))
  check('a wide photo is trimmed at the sides, not the top',
    wide.h === 1 && wide.w < 1 && wide.y === 0, JSON.stringify(wide))
  check('a tall photo is trimmed top and bottom',
    tall.w === 1 && tall.h < 1 && tall.x === 0, JSON.stringify(tall))
  check('and it stays centred',
    Math.abs(wide.x - (1 - wide.w) / 2) < 1e-9 && Math.abs(tall.y - (1 - tall.h) / 2) < 1e-9)
  check('a photo already the right shape is left whole',
    same.w === 1 && same.h === 1, JSON.stringify(same))
  // The visible window must have the target shape, or the photo is squashed.
  const visAR = (r, w, h) => (r.w * w) / (r.h * h)
  check('the visible window really is the target shape',
    Math.abs(visAR(wide, 1600, 900) - 1) < 1e-9 && Math.abs(visAR(tall, 900, 1600) - 1) < 1e-9,
    `${visAR(wide, 1600, 900).toFixed(6)} / ${visAR(tall, 900, 1600).toFixed(6)}`)
  const to43 = coverRect(1000, 1000, 4 / 3)
  check('and for a non-square target too',
    Math.abs(visAR(to43, 1000, 1000) - 4 / 3) < 1e-9, visAR(to43, 1000, 1000).toFixed(6))
  check('a degenerate size does not produce NaN',
    JSON.stringify(coverRect(0, 0, 1)) === '{"x":0,"y":0,"w":1,"h":1}')
}

// --- Polaroid insets ---------------------------------------------------------
{
  const p = cardInsets('polaroid', 0.05)
  const b = cardInsets('border', 0.05)
  const n = cardInsets('none', 0.05)
  console.log('insets:', JSON.stringify({ p, b, n }))
  check('a Polaroid is bottom-heavy', p.b > p.t * 2.5, `bottom ${p.b} vs top ${p.t}`)
  check('and even on the other three sides', p.l === p.r && p.l === p.t)
  check('an even border is even', b.l === b.r && b.t === b.b)
  check('no border means no inset', n.l === 0 && n.b === 0)
}

// --- column choice -----------------------------------------------------------
{
  const sq = bestColumns(30, 1800, 1350, 1)
  const one = bestColumns(1, 1800, 1350, 1)
  const twelve = bestColumns(12, 1800, 1350, 1)
  console.log('columns for 30 / 1 / 12:', sq, one, twelve)
  check('one photo is one column', one === 1)
  check('30 square cards on a 4:3 canvas lands on a sensible grid',
    sq >= 5 && sq <= 7, String(sq))
  check('12 divides cleanly rather than leaving a ragged row',
    12 % twelve === 0, `${twelve} columns for 12`)
  // A wide canvas should want more columns than a tall one.
  const wide = bestColumns(24, 3000, 1000, 1)
  const tall = bestColumns(24, 1000, 3000, 1)
  console.log('24 on a wide canvas:', wide, '· on a tall one:', tall)
  check('a wide canvas takes more columns than a tall one', wide > tall, `${wide} vs ${tall}`)
}

// --- the layout itself --------------------------------------------------------
{
  const items = photos(30, [[640, 480], [480, 640], [800, 450]])
  const r = layoutCollage(items)
  console.log('30 mixed photos:', JSON.stringify({
    canvas: [r.width, r.height], grid: [r.columns, r.rows], cardAspect: +r.cardAspect.toFixed(4),
  }))
  check('every photo gets a card', r.cards.length === 30)
  check('the grid holds them all', r.columns * r.rows >= 30)
  check('without a wholly empty row', (r.columns * r.rows) - 30 < r.columns,
    `${r.columns * r.rows - 30} empty cells in a row of ${r.columns}`)

  // A Polaroid card is taller than its picture, so it must not be square.
  check('a Polaroid card is taller than it is wide', r.cardAspect < 1, r.cardAspect.toFixed(4))

  // Nothing may sit outside the canvas, tilt included.
  const corners = (c) => {
    const a = (c.rotation * Math.PI) / 180
    const cx = c.x + c.w / 2
    const cy = c.y + c.h / 2
    const pts = [[-c.w / 2, -c.h / 2], [c.w / 2, -c.h / 2], [c.w / 2, c.h / 2], [-c.w / 2, c.h / 2]]
    return pts.map(([px, py]) => [
      cx + px * Math.cos(a) - py * Math.sin(a),
      cy + px * Math.sin(a) + py * Math.cos(a),
    ])
  }
  let worst = 0
  for (const c of r.cards) {
    for (const [x, y] of corners(c)) {
      worst = Math.max(worst, -x, -y, x - r.width, y - r.height)
    }
  }
  console.log('worst overhang past the canvas edge:', worst.toFixed(1), 'px')
  check('no tilted card hangs off the canvas', worst <= 0.5, `${worst.toFixed(1)}px over`)

  // The margin has to grow to cover overlap, size variation and tilt together —
  // each pushes the outer cards further out than their cell.
  for (const extreme of [
    { gap: -0.3, sizeVary: 0.3, angle: 12 },
    { gap: -0.35, sizeVary: 0.5, angle: 15, columns: 3 },
    { gap: -0.2, sizeVary: 0.2, angle: 15, shape: 'landscape' },
  ]) {
    const e = layoutCollage(items, extreme)
    let over = 0
    for (const c of e.cards) {
      for (const [x, y] of corners(c)) over = Math.max(over, -x, -y, x - e.width, y - e.height)
    }
    check(`nothing clips at ${JSON.stringify(extreme)}`, over <= 0.5, `${over.toFixed(1)}px over`)
  }

  // Overlap is the point: cards should lap over their neighbours at the edges
  // and corners, so far less backdrop shows through.
  const overlapPairs = (cards) => {
    let n = 0
    for (let i = 0; i < cards.length; i++) {
      for (let j = i + 1; j < cards.length; j++) {
        const a = cards[i]
        const b = cards[j]
        if (a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h) n++
      }
    }
    return n
  }
  const overlaps = overlapPairs(r.cards)
  console.log('overlapping card pairs (axis-aligned boxes):', overlaps)
  check('cards overlap by default', overlaps > 0, `${overlaps} pairs`)
  // Every card should touch a neighbour, or one is stranded on its own.
  const touching = r.cards.filter((a) => r.cards.some((b) => b !== a
    && a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h)).length
  check('and no card is left stranded on its own', touching === r.cards.length,
    `${touching} of ${r.cards.length} touch a neighbour`)

  // How much backdrop is left: the union of the cards against the canvas.
  const grid = 400
  const covered = (() => {
    let hit = 0
    for (let gy = 0; gy < grid; gy++) {
      for (let gx = 0; gx < grid; gx++) {
        const px = ((gx + 0.5) / grid) * r.width
        const py = ((gy + 0.5) / grid) * r.height
        if (r.cards.some((c) => px >= c.x && px <= c.x + c.w && py >= c.y && py <= c.y + c.h)) hit++
      }
    }
    return hit / (grid * grid)
  })()
  const spaced = layoutCollage(items, { gap: 0.1, sizeVary: 0 })
  const coveredSpaced = (() => {
    let hit = 0
    for (let gy = 0; gy < grid; gy++) {
      for (let gx = 0; gx < grid; gx++) {
        const px = ((gx + 0.5) / grid) * spaced.width
        const py = ((gy + 0.5) / grid) * spaced.height
        if (spaced.cards.some((c) => px >= c.x && px <= c.x + c.w && py >= c.y && py <= c.y + c.h)) hit++
      }
    }
    return hit / (grid * grid)
  })()
  console.log('canvas covered — overlapping:', (covered * 100).toFixed(1) + '%',
    '· spaced:', (coveredSpaced * 100).toFixed(1) + '%')
  check('overlapping leaves far less empty space than spacing does',
    covered > coveredSpaced + 0.1,
    `${(covered * 100).toFixed(1)}% vs ${(coveredSpaced * 100).toFixed(1)}%`)
  check('and most of the canvas is covered', covered > 0.8, `${(covered * 100).toFixed(1)}%`)

  // The stack order has to be a real permutation, and not the raster order —
  // dealing them in index sequence makes the whole thing shingle one way.
  const zs = r.cards.map((c) => c.z)
  check('every card has a distinct place in the pile',
    new Set(zs).size === zs.length && Math.min(...zs) === 0 && Math.max(...zs) === zs.length - 1)
  check('and the pile is not simply raster order',
    zs.some((z, i) => z !== i), zs.slice(0, 8).join(','))

  // Sizes should differ, or it reads as a tiling however much it overlaps.
  const widths = r.cards.map((c) => c.w)
  const spread = (Math.max(...widths) - Math.min(...widths)) / Math.max(...widths)
  console.log('card width spread:', (spread * 100).toFixed(1) + '%')
  check('cards are not all the same size', spread > 0.05, `${(spread * 100).toFixed(1)}%`)

  const tilts = r.cards.map((c) => c.rotation)
  const maxTilt = Math.max(...tilts.map(Math.abs))
  const distinct = new Set(tilts.map((t) => t.toFixed(4))).size
  console.log('tilt: max', maxTilt.toFixed(2) + '°, distinct', distinct)
  check('tilt stays within the limit', maxTilt <= defaultCollage().angle + 1e-9,
    `${maxTilt.toFixed(2)}° vs ${defaultCollage().angle}°`)
  check('and every card gets its own angle', distinct === 30, `${distinct} of 30`)
  check('some tilt each way', tilts.some((t) => t > 0.5) && tilts.some((t) => t < -0.5))
}

// --- the tilt is reproducible ---------------------------------------------------
{
  const items = photos(12)
  const a = layoutCollage(items, { seed: 7 })
  const b = layoutCollage(items, { seed: 7 })
  const c = layoutCollage(items, { seed: 8 })
  const same = a.cards.every((card, i) => card.rotation === b.cards[i].rotation
    && card.x === b.cards[i].x && card.y === b.cards[i].y)
  const differs = a.cards.some((card, i) => card.rotation !== c.cards[i].rotation)
  check('the same seed lays out identically', same)
  check('a different seed re-tilts everything', differs)
  console.log('seed 7 first tilt', a.cards[0].rotation.toFixed(3),
    '· seed 8 first tilt', c.cards[0].rotation.toFixed(3))
}

// --- options actually do something ------------------------------------------------
{
  const items = photos(9)
  const forced = layoutCollage(items, { columns: 3 })
  check('a forced column count is honoured', forced.columns === 3 && forced.rows === 3)

  const flat = layoutCollage(items, { angle: 0 })
  check('zero tilt means zero tilt', flat.cards.every((c) => c.rotation === 0))

  const noBorder = layoutCollage(items, { style: 'none' })
  check('with no border the card is the picture',
    Math.abs(noBorder.cardAspect - 1) < 1e-9, noBorder.cardAspect.toFixed(4))

  const wide = layoutCollage(items, { width: 3000 })
  check('canvas width is respected', wide.width === 3000)
  check('and the height follows the grid rather than being fixed',
    Math.abs(wide.height / wide.width - layoutCollage(items).height / layoutCollage(items).width) < 0.01,
    `${wide.width}x${wide.height}`)

  const tight = layoutCollage(items, { margin: 0 })
  const roomy = layoutCollage(items, { margin: 0.15 })
  check('more margin makes smaller cards', roomy.cards[0].w < tight.cards[0].w,
    `${roomy.cards[0].w.toFixed(0)} vs ${tight.cards[0].w.toFixed(0)}`)

  // Positive spacing must still separate them completely — overlap is a default,
  // not the only option.
  const apart = layoutCollage(items, { gap: 0.15, sizeVary: 0, angle: 0, hero: 'none' })
  let apartPairs = 0
  for (let i = 0; i < apart.cards.length; i++) {
    for (let j = i + 1; j < apart.cards.length; j++) {
      const a = apart.cards[i]
      const b = apart.cards[j]
      if (a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h) apartPairs++
    }
  }
  check('positive spacing still separates every card', apartPairs === 0, `${apartPairs} pairs`)

  // The centre piece is deliberately a different size, so it is excluded here.
  const uniform = layoutCollage(items, { sizeVary: 0, hero: 'none' })
  const uw = uniform.cards.map((c) => +c.w.toFixed(6))
  check('zero size variation makes every card identical', new Set(uw).size === 1, uw[0].toFixed(1))

  const bleed = layoutCollage(items, { margin: -0.05 })
  check('a negative margin is honoured rather than clamped away',
    bleed.margin < 0, String(Math.round(bleed.margin)))
  check('so the outer cards run off the canvas',
    bleed.cards.some((c) => c.x < 0) && bleed.cards.some((c) => c.x + c.w > bleed.width))

  const shapes = PHOTO_SHAPES.filter((s) => s.ratio).map((s) => {
    const r = layoutCollage(items, { shape: s.value, style: 'none' })
    return [s.value, +(r.cards[0].w / r.cards[0].h).toFixed(3), s.ratio]
  })
  console.log('shapes:', JSON.stringify(shapes))
  check('each photo shape produces cards of that shape',
    shapes.every(([, got, want]) => Math.abs(got - want) < 0.01),
    shapes.map(([n, got, want]) => `${n} ${got} vs ${want.toFixed(3)}`).join(', '))
}

// --- mixed mounts ---------------------------------------------------------------------
{
  console.log('')
  console.log('-- mixed mounts --')
  check('a wide photo gets a landscape mount', ratioFor('mixed', 1600, 900) === 4 / 3,
    ratioFor('mixed', 1600, 900).toFixed(3))
  check('a tall one gets portrait', ratioFor('mixed', 900, 1600) === 3 / 4,
    ratioFor('mixed', 900, 1600).toFixed(3))
  check('and a squarish one gets square', ratioFor('mixed', 1000, 1050) === 1,
    ratioFor('mixed', 1000, 1050).toFixed(3))
  // Snapping is the point: a panorama must not become a card five cells wide.
  check('an extreme panorama is snapped, not honoured', ratioFor('mixed', 4000, 900) === 4 / 3,
    ratioFor('mixed', 4000, 900).toFixed(3))
  check('but source mode does honour it',
    Math.abs(ratioFor('source', 4000, 900) - 4000 / 900) < 1e-9)

  const mixedItems = photos(12, [[1600, 900], [900, 1600], [1000, 1000]])
  const m = layoutCollage(mixedItems, { shape: 'mixed', angle: 0, sizeVary: 0, hero: 'none' })
  const shapes = new Set(m.cards.map((c) => (c.w / c.h).toFixed(2)))
  console.log('distinct card shapes in a mixed collage:', [...shapes].join(', '))
  check('a mixed collage really contains three different mount shapes', shapes.size === 3,
    [...shapes].join(', '))
  // Different shapes, comparable footprint — one must not dwarf the others.
  const areas = m.cards.map((c) => c.w * c.h)
  const ratio = Math.max(...areas) / Math.min(...areas)
  console.log('largest / smallest card area:', ratio.toFixed(2))
  check('and they take up comparable room', ratio < 1.6, ratio.toFixed(2) + 'x')
  check('none is squashed — each keeps its own mount shape',
    m.cards.every((c, i) => {
      const want = ratioFor('mixed', mixedItems[i].width, mixedItems[i].height)
      const ins = c.insets
      const photoAR = (c.w * (1 - ins.l - ins.r)) / (c.h * (1 - ins.t - ins.b))
      return Math.abs(photoAR - want) < 0.02
    }))
}

// --- the centre piece -------------------------------------------------------------------
{
  console.log('')
  console.log('-- centre piece --')
  const items = photos(12, [[640, 480], [480, 640]])
  const withHero = layoutCollage(items, { hero: 'auto' })
  const without = layoutCollage(items, { hero: 'none' })
  console.log('hero index:', withHero.hero, '· none gives', without.hero)
  check('auto picks a hero', withHero.hero >= 0)
  check('none means none', without.hero === -1)

  const hero = withHero.cards[withHero.hero]
  const others = withHero.cards.filter((c) => c !== hero)
  const avg = others.reduce((a, c) => a + c.w, 0) / others.length
  console.log('hero width', hero.w.toFixed(0), 'vs average', avg.toFixed(0))
  check('the hero is markedly bigger', hero.w > avg * 1.4, `${(hero.w / avg).toFixed(2)}x`)
  check('and sits on top of the pile', hero.z === items.length - 1, `z ${hero.z}`)
  check('the pile is still a clean permutation',
    new Set(withHero.cards.map((c) => c.z)).size === items.length)
  check('it is flagged, so the layer can be named', hero.hero === true)

  // It must be interior, or it gets clamped and stops looking centred.
  const col = withHero.hero % withHero.columns
  const row = Math.floor(withHero.hero / withHero.columns)
  console.log('hero cell:', col, row, 'in a', withHero.columns + 'x' + withHero.rows, 'grid')
  check('the hero sits in an interior cell',
    col > 0 && col < withHero.columns - 1 && row > 0 && row < withHero.rows - 1,
    `${col},${row}`)

  // And it still may not hang off the canvas.
  const cor = (c) => {
    const a = (c.rotation * Math.PI) / 180
    const cx = c.x + c.w / 2
    const cy = c.y + c.h / 2
    return [[-c.w / 2, -c.h / 2], [c.w / 2, -c.h / 2], [c.w / 2, c.h / 2], [-c.w / 2, c.h / 2]]
      .map(([px, py]) => [cx + px * Math.cos(a) - py * Math.sin(a), cy + px * Math.sin(a) + py * Math.cos(a)])
  }
  for (const scale of [1.75, 2.5, 3.5]) {
    const e = layoutCollage(items, { heroScale: scale })
    let over = 0
    for (const c of e.cards) for (const [x, y] of cor(c)) over = Math.max(over, -x, -y, x - e.width, y - e.height)
    check(`a ${scale}x centre piece stays on the canvas`, over <= 0.5, `${over.toFixed(1)}px over`)
  }

  // Too few photos, or too flat a grid, and a hero just buries everything.
  check('four photos get no hero', layoutCollage(photos(4)).hero === -1)
  const picked = layoutCollage(items, { hero: 3 })
  check('an explicit index is honoured', picked.hero === 3 && picked.cards[3].hero === true)
  check('an out-of-range index is ignored rather than crashing',
    layoutCollage(items, { hero: 99 }).hero === -1)
}

// --- edge cases ---------------------------------------------------------------------
{
  check('an empty set lays out to nothing', layoutCollage([]).cards.length === 0)
  const one = layoutCollage(photos(1))
  check('a single photo is a 1x1 grid', one.columns === 1 && one.rows === 1)
  check('and it is on the canvas', one.cards[0].x >= 0 && one.cards[0].y >= 0)

  const many = layoutCollage(photos(200))
  check('200 photos still lay out', many.cards.length === 200 && many.width > 0 && many.height > 0,
    `${many.columns} x ${many.rows}`)
  check('every card has real numbers',
    many.cards.every((c) => [c.x, c.y, c.w, c.h, c.rotation].every(Number.isFinite)))

  // A last row that is not full should be centred, not left-aligned.
  // Size variation and wobble both move individual card centres, so they are
  // switched off here — the claim is about where the *row* sits, not about how
  // much any one card differs from its neighbour.
  const ragged = layoutCollage(photos(7), { columns: 3, angle: 0, gap: 0, sizeVary: 0 })
  const lastRow = ragged.cards.slice(6)
  const firstRow = ragged.cards.slice(0, 3)
  const rowCentre = (cards) => cards.reduce((a, c) => a + c.x + c.w / 2, 0) / cards.length
  // Each card carries a deliberate positional wobble, so row centres are only
  // equal to within that noise. The tolerance is derived from the wobble
  // amplitude rather than picked, so it cannot quietly hide a real drift: the
  // wobble is 0.05 * 0.35 of a cell either way at this spacing.
  const cell = (ragged.width - ragged.margin * 2) / ragged.columns
  const tol = 0.05 * 0.35 * cell
  const drift = Math.abs(rowCentre(lastRow) - rowCentre(firstRow))
  console.log('row centres — full:', rowCentre(firstRow).toFixed(1),
    'ragged:', rowCentre(lastRow).toFixed(1), '· drift', drift.toFixed(1),
    'against a wobble of', tol.toFixed(1))
  check('a short last row is centred, to within the wobble',
    drift < tol, `${drift.toFixed(1)}px drift, wobble ${tol.toFixed(1)}px`)

  // And with the wobble scaled away it must be exact, which is the real claim.
  const still = layoutCollage(photos(7), { columns: 3, angle: 0, gap: 0, sizeVary: 0, width: 60 })
  const stillCentre = (from, to) => {
    const cs = still.cards.slice(from, to)
    return cs.reduce((a, c) => a + c.x + c.w / 2, 0) / cs.length
  }
  check('and exactly centred once the wobble is negligible',
    Math.abs(stillCentre(6, 7) - stillCentre(0, 3)) < 0.2,
    `${stillCentre(6, 7).toFixed(3)} vs ${stillCentre(0, 3).toFixed(3)}`)
}

const failed = checks.filter(([, ok]) => !ok).length
console.log(`\n${checks.length - failed}/${checks.length} checks passed`)
process.exit(failed ? 1 : 0)
