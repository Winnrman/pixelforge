// The tool list, its two sets of keys, and how big a brush really is.
//
// The list used to be written twice — once in the rail that draws the buttons
// and once in the keyboard handler — which is how a tool ends up with a button
// and no shortcut. It is one list now, and the map is derived from it, so this
// suite is mostly checking that the derivation cannot go wrong quietly.
//
// The brush arithmetic is here for a different reason: the preview in the rail
// has to agree with the stroke that gets painted, and the only way to be sure of
// that is for both to come out of the same function.
import { TOOLS, TOOL_KEYS, toolForKey, keyHint, BRUSH_TOOLS } from '../../src/engine/tools.js'
import { brushMetrics, previewFit, fitLabel } from '../../src/engine/brush.js'
import { posterHeight } from '../../src/engine/filmstrip.js'
import { paletteFromPixels, colorDistance } from '../../src/engine/palette.js'

const checks = []
const check = (name, ok, detail = '') => {
  checks.push([name, ok])
  console.log((ok ? 'PASS  ' : 'FAIL  ') + name + (detail ? '  — ' + detail : ''))
}
const near = (a, b, tol = 0.001) => Math.abs(a - b) <= tol

// --- the list -------------------------------------------------------------------
{
  check('every tool has an id, a letter and a label',
    TOOLS.every((t) => t.id && t.key && t.label), JSON.stringify(TOOLS.map((t) => t.id)))
  check('no two tools share an id', new Set(TOOLS.map((t) => t.id)).size === TOOLS.length)
  check('no two share a letter',
    new Set(TOOLS.map((t) => t.key.toLowerCase())).size === TOOLS.length,
    TOOLS.map((t) => t.key).join())

  const digits = TOOLS.map((t) => t.digit).filter(Boolean)
  check('no two share a digit', new Set(digits).size === digits.length, digits.join())
  check('the digits are the rail order, starting at the selector',
    digits.join('') === '1234567890', digits.join(''))
  check('and the selector is the one that answers to 1',
    TOOLS[0].id === 'move' && TOOLS[0].digit === '1', JSON.stringify(TOOLS[0]))
  // Ten digits, twelve tools. The two without one are the two you reach for
  // least, and each has its own way back — the eyedropper hands the tool back
  // when it is done, and panning has the space bar.
  check('the tools past the tenth keep their letter alone',
    TOOLS.filter((t) => !t.digit).map((t) => t.id).join() === 'eyedrop,hand',
    TOOLS.filter((t) => !t.digit).map((t) => t.id).join())
}

// --- the keys --------------------------------------------------------------------
{
  check('a letter arms its tool', toolForKey('v') === 'move' && toolForKey('e') === 'erase')
  check('and so does the digit beside it', toolForKey('1') === 'move' && toolForKey('8') === 'erase')
  check('case does not matter, since a shift is not a different key',
    toolForKey('V') === 'move' && toolForKey('B') === 'mask')
  check('a key belonging to something else arms nothing',
    toolForKey('z') === null && toolForKey('') === null && toolForKey(undefined) === null)
  check('every tool is reachable from the map',
    TOOLS.every((t) => TOOL_KEYS[t.key.toLowerCase()] === t.id
      && (!t.digit || TOOL_KEYS[t.digit] === t.id)))
  check('the map has exactly the keys the list describes',
    Object.keys(TOOL_KEYS).length === TOOLS.length + TOOLS.filter((t) => t.digit).length,
    String(Object.keys(TOOL_KEYS).length))

  check('a tooltip offers both keys', keyHint(TOOLS[0]) === 'V or 1', keyHint(TOOLS[0]))
  check('and only the letter where there is no digit',
    keyHint(TOOLS.find((t) => t.id === 'hand')) === 'H')
  check('the brush tools are the ones with a size to set',
    [...BRUSH_TOOLS].sort().join() === 'clone,erase,mask', [...BRUSH_TOOLS].join())
}

// --- how big a brush is -------------------------------------------------------------
{
  // A brush is a fraction of the layer width, so the same setting is a different
  // number of pixels on every layer — which is the whole reason the preview
  // exists. 10% of an 800px layer is 80px of picture.
  const m = brushMetrics({ size: 0.1, hardness: 1 }, 800, 1)
  check('a brush is its fraction of the layer width', near(m.width, 80), String(m.width))
  check('a hard brush has no softness to spread', near(m.soft, 0), String(m.soft))
  check('and its dot is half its width', near(m.radius, 40), String(m.radius))

  const soft = brushMetrics({ size: 0.1, hardness: 0 }, 800, 1)
  check('a soft brush blurs by half its width', near(soft.soft, 40), String(soft.soft))
  // The blur spreads the stroke, so the dot is narrowed by what the blur adds
  // back. This is what keeps the covered width matching the ring on screen.
  check('and the drawn dot is narrowed to keep the covered width',
    near(soft.radius, 20), String(soft.radius))

  check('zoom scales it, because the preview is in screen pixels',
    near(brushMetrics({ size: 0.1, hardness: 1 }, 800, 2).width, 160))
  check('a brush is never nothing, however small the layer',
    brushMetrics({ size: 0.001, hardness: 1 }, 1, 1).width >= 0.5)
  check('and a missing setting falls back rather than vanishing',
    brushMetrics({}, 800, 1).width > 0 && brushMetrics(null, 800, 1).width > 0)
  check('hardness outside 0..1 is clamped rather than inverting the blur',
    brushMetrics({ size: 0.1, hardness: 5 }, 800, 1).soft === 0
    && brushMetrics({ size: 0.1, hardness: -5 }, 800, 1).soft > 0)
}

// --- fitting it into the preview box --------------------------------------------------
{
  const box = { w: 188, h: 140 }   // the box the rail actually draws into

  const small = previewFit({ size: 0.05, hardness: 1 }, 800, 1, box)
  check('a brush that fits is drawn life-size', small.exact && near(small.fit, 1),
    JSON.stringify(small.fit))
  check('and life-size means exactly the size it will paint',
    near(small.drawn.width, small.width), `${small.drawn.width} vs ${small.width}`)

  // A brush larger than the box: shrunk to fit and *said so*, because a preview
  // that silently shrinks reads as a brush half the size of the real one.
  const big = previewFit({ size: 0.5, hardness: 1 }, 800, 1, box)
  check('a brush too big for the box is fitted into it',
    !big.exact && big.drawn.width <= box.h, `${big.drawn.width} in ${box.h}`)
  check('and says how much it had to shrink', /shown at \d+%/.test(fitLabel(big.fit)),
    String(fitLabel(big.fit)))
  check('while a life-size one says nothing at all', fitLabel(small.fit) === null)

  // The number under the picture is in document pixels, so it is the one thing
  // that stays true whatever the box or the zoom had to do.
  check('the pixel readout is what the brush covers on the picture',
    previewFit({ size: 0.1, hardness: 1 }, 800, 3, box).px === 80,
    String(previewFit({ size: 0.1, hardness: 1 }, 800, 3, box).px))

  // A soft brush reaches past its own dot, and the room it needs includes that
  // — otherwise the softest brushes clip their falloff at the box edge and read
  // as hard.
  const feathered = previewFit({ size: 0.28, hardness: 0 }, 300, 1, box)
  check('the room a soft brush needs counts its blur',
    feathered.drawn.width + feathered.drawn.soft * 2 <= box.h + 0.01,
    `${feathered.drawn.width + feathered.drawn.soft * 2} in ${box.h}`)

  // The rail always has something to measure against — the selection, the
  // topmost layer, or the document — so this is a guard on the arithmetic
  // rather than a state the panel can show.
  check('nothing to measure against reports nothing, and does not divide by it',
    previewFit({ size: 0.1, hardness: 1 }, 0, 1, box).px === 0
    && Number.isFinite(previewFit({ size: 0.1, hardness: 1 }, 0, 0, box).fit))
}

// --- how big a poster's thumbnail has to be ---------------------------------------------
// A poster covers its card and crops the overflow, so a tall picture in a wide
// tile is scaled by its *width*. Asking for a thumbnail by the box's height is
// what made a portrait clip come back twenty-one pixels wide and get stretched
// across the whole tile.
{
  const portrait = { width: 720, height: 1606 }
  const landscape = { width: 1920, height: 1080 }
  const square = { width: 800, height: 800 }

  // The failure this exists to stop, stated as a number: covering a 200px card
  // with a 720x1606 picture needs a thumbnail 446 tall, not 46.
  const tall = posterHeight(portrait, 200, 46, 1)
  check('a tall picture is sized by the width it has to cover',
    tall === Math.round((200 * 1606) / 720), String(tall))
  check('which is far more than the box is high', tall > 46 * 8, `${tall} vs 46`)

  check('a wide picture is sized by the height instead',
    posterHeight(landscape, 200, 132, 1) === 132,
    String(posterHeight(landscape, 200, 132, 1)))
  check('a square one in a wide box follows the width',
    posterHeight(square, 200, 132, 1) === 200, String(posterHeight(square, 200, 132, 1)))

  check('a sharp screen asks for twice as much',
    posterHeight(landscape, 200, 132, 2) === 264, String(posterHeight(landscape, 200, 132, 2)))

  // Never more than the asset has. Upscaling a small source adds no detail and
  // costs memory to hold.
  const tiny = { width: 32, height: 24 }
  check('a picture smaller than the box is not blown up to fill it',
    posterHeight(tiny, 200, 132, 2) === 24, String(posterHeight(tiny, 200, 132, 2)))
  check('and a poster is never zero pixels tall',
    posterHeight({ width: 0, height: 0 }, 0, 0, 1) >= 1
    && posterHeight(null, 200, 132, 1) >= 1)
}

// --- the colours a picture is made of ----------------------------------------------------
// A cover looks designed when the type picks up a colour that is in the
// photograph. The thinning is the part that makes this useful rather than merely
// correct: a photograph of a room is nine hundred shades of one brown, and a
// palette of nine hundred browns is not a palette.
{
  const px = (list) => {
    const d = new Uint8ClampedArray(list.length * 4)
    list.forEach(([r, g, b, a = 255], i) => {
      d[i * 4] = r; d[i * 4 + 1] = g; d[i * 4 + 2] = b; d[i * 4 + 3] = a
    })
    return d
  }

  const red = [220, 30, 30]
  const blue = [30, 40, 220]
  // Red twice as common as blue, so it has to come back first.
  const two = paletteFromPixels(px([red, red, red, red, blue, blue]))
  check('the colours come back, most of the picture first',
    two.length === 2 && two[0] === '#dc1e1e' && two[1] === '#1e28dc', two.join(' '))

  // Nine near-identical browns and one blue: the browns are one colour.
  const browns = []
  for (let i = 0; i < 40; i++) browns.push([120 + (i % 4), 90 + (i % 3), 60])
  const mixed = paletteFromPixels(px([...browns, blue, blue]))
  check('near neighbours are one colour, not forty',
    mixed.length === 2, mixed.join(' '))
  check('and the odd one out survives being outnumbered',
    mixed[1] === '#1e28dc', mixed.join(' '))

  check('it stops when it is asked to',
    paletteFromPixels(px([red, blue, [20, 200, 20], [230, 230, 20]]), { count: 2 }).length === 2)

  // A cut-out subject should give the subject's colours, not a majority vote for
  // whatever used to be behind it.
  const cut = paletteFromPixels(px([[9, 9, 9, 0], [9, 9, 9, 0], [9, 9, 9, 0], red]))
  check('transparent pixels are not colours', cut.length === 1 && cut[0] === '#dc1e1e', cut.join())
  check('and a picture of nothing has no palette',
    paletteFromPixels(px([[0, 0, 0, 0]])).length === 0 && paletteFromPixels(null).length === 0)

  // Green carries most of the luminance, so an equal step in green has to read
  // as a bigger difference than the same step in blue.
  check('distance is weighted the way the eye is',
    colorDistance([0, 0, 0], [0, 40, 0]) > colorDistance([0, 0, 0], [0, 0, 40]))
}

console.log(checks.filter(([, o]) => o).length + ' of ' + checks.length + ' passed')
process.exit(checks.some(([, ok]) => !ok) ? 1 : 0)
