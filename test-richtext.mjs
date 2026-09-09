// Styling part of a text layer, under plain node.
//
// A layer had one colour, one weight, one slant. That is right for a title and
// wrong for a sentence with a word in it that matters more than the rest.
//
// The arithmetic is the whole feature: ranges that split, merge, overlap and
// move as the text is edited. Getting it wrong rarely draws a wrong picture — it
// drifts, leaving runs that each say the same thing, and nobody notices until a
// title carries two hundred of them.
import {
  normalizeRuns, applyRun, styleAt, segments, hasRuns, shiftRuns, RUN_PROPS,
} from './src/engine/richtext.js'

const checks = []
const check = (name, ok, detail = '') => {
  checks.push([name, ok])
  console.log((ok ? 'PASS  ' : 'FAIL  ') + name + (detail ? '  — ' + detail : ''))
}
const shape = (runs) => runs.map((r) => `${r.from}-${r.to}:${JSON.stringify(r.style)}`).join(' ')

// --- keeping the set tidy ------------------------------------------------------
{
  check('an empty run is dropped',
    normalizeRuns([{ from: 3, to: 3, style: { color: '#f00' } }]).length === 0)
  check('and one that says nothing is too',
    normalizeRuns([{ from: 0, to: 4, style: {} }]).length === 0)

  const ordered = normalizeRuns([
    { from: 6, to: 9, style: { color: '#00f' } },
    { from: 0, to: 3, style: { color: '#f00' } },
  ])
  check('runs come back in order',
    ordered[0].from === 0 && ordered[1].from === 6, shape(ordered))

  // The creep this exists to stop: an editor that splits on every keystroke.
  const folded = normalizeRuns([
    { from: 0, to: 3, style: { color: '#f00' } },
    { from: 3, to: 6, style: { color: '#f00' } },
  ])
  check('neighbours that agree are folded into one',
    folded.length === 1 && folded[0].to === 6, shape(folded))
  check('but neighbours that differ are not',
    normalizeRuns([
      { from: 0, to: 3, style: { color: '#f00' } },
      { from: 3, to: 6, style: { color: '#00f' } },
    ]).length === 2)

  const clipped = normalizeRuns([{ from: 2, to: 99, style: { weight: 900 } }], 5)
  check('nothing reaches past the end of the text',
    clipped[0].to === 5, shape(clipped))
  check('only the properties a run may carry survive',
    JSON.stringify(normalizeRuns([{ from: 0, to: 3, style: { color: '#f00', size: 90 } }])[0].style)
      === '{"color":"#f00"}')
}

// --- applying a style to a stretch ---------------------------------------------
{
  const one = applyRun([], 5, 10, { color: '#a0f' }, 20)
  check('styling a stretch of plain text makes one run',
    shape(one) === '5-10:{"color":"#a0f"}', shape(one))

  const both = applyRun(one, 5, 10, { weight: 900 }, 20)
  check('styling it again adds to what it already said',
    both.length === 1 && both[0].style.color === '#a0f' && both[0].style.weight === 900,
    shape(both))

  // Straddling a styled word: the overlap takes both, the rest takes the new.
  const wide = applyRun(one, 8, 15, { weight: 900 }, 20)
  check('a stretch that straddles an existing run splits it',
    wide.length === 3
    && wide[0].from === 5 && wide[0].to === 8 && wide[0].style.weight === undefined
    && wide[1].style.color === '#a0f' && wide[1].style.weight === 900
    && wide[2].from === 10 && wide[2].style.color === undefined,
    shape(wide))

  const inner = applyRun(one, 7, 8, { color: '#0f0' }, 20)
  check('and one inside it cuts a hole with the new colour in it',
    inner.length === 3 && inner[1].style.color === '#0f0'
    && inner[0].style.color === '#a0f' && inner[2].style.color === '#a0f',
    shape(inner))

  // Null removes, which differs from setting the layer's current value: text
  // that was never styled has to keep following the layer as it changes.
  const cleared = applyRun(both, 5, 10, { color: null }, 20)
  check('setting a property to null takes it off that stretch',
    cleared.length === 1 && cleared[0].style.color === undefined
    && cleared[0].style.weight === 900, shape(cleared))
  check('and taking off the last one removes the run entirely',
    applyRun(one, 5, 10, { color: null }, 20).length === 0)

  check('a stretch of no length changes nothing',
    shape(applyRun(one, 7, 7, { weight: 900 }, 20)) === shape(one))
  check('and a backwards one is read the right way round',
    shape(applyRun([], 10, 5, { color: '#a0f' }, 20)) === '5-10:{"color":"#a0f"}',
    shape(applyRun([], 10, 5, { color: '#a0f' }, 20)))
}

// --- reading it back -----------------------------------------------------------
{
  const runs = applyRun([], 6, 11, { color: '#a0f', weight: 900 }, 20)
  check('a character inside a run reports it', styleAt(runs, 7)?.color === '#a0f')
  check('one outside reports nothing', styleAt(runs, 2) === null)
  check('the far edge is outside, being where the next character starts',
    styleAt(runs, 11) === null)
  check('a layer with runs says so', hasRuns({ runs }) && !hasRuns({ runs: [] }) && !hasRuns({}))
}

// --- cutting the string into things to draw -------------------------------------
{
  const base = { color: '#fff', weight: 700 }
  const plain = segments('hello world', [], base)
  check('with no runs the whole string is one piece',
    plain.length === 1 && plain[0].text === 'hello world' && plain[0].style.color === '#fff')

  const runs = applyRun([], 6, 11, { color: '#a0f', weight: 900 }, 11)
  const cut = segments('hello world', runs, base)
  check('a run in the middle gives the pieces either side of it',
    cut.map((p) => p.text).join('|') === 'hello |world', cut.map((p) => p.text).join('|'))
  check('each piece carries the layer style with the run folded in',
    cut[0].style.color === '#fff' && cut[0].style.weight === 700
    && cut[1].style.color === '#a0f' && cut[1].style.weight === 900,
    JSON.stringify(cut.map((p) => p.style)))
  check('and the pieces cover the string exactly',
    cut.map((p) => p.text).join('') === 'hello world'
    && cut[0].from === 0 && cut[cut.length - 1].to === 11)

  const atStart = segments('hello', applyRun([], 0, 2, { weight: 900 }, 5), base)
  check('a run at the very start leaves no empty piece in front of it',
    atStart.length === 2 && atStart[0].text === 'he', atStart.map((p) => p.text).join('|'))
}

// --- text being edited underneath the runs ---------------------------------------
// Typing in the middle of a styled word should extend that word's style, not
// leave the new letters unstyled or shift every run after it out of place.
{
  const runs = applyRun([], 6, 11, { color: '#a0f' }, 11)   // "world" in "hello world"

  check('typing before a run carries it along',
    shape(shiftRuns(runs, 0, 0, 3)) === '9-14:{"color":"#a0f"}', shape(shiftRuns(runs, 0, 0, 3)))
  check('typing inside a run extends it',
    shape(shiftRuns(runs, 8, 8, 2)) === '6-13:{"color":"#a0f"}', shape(shiftRuns(runs, 8, 8, 2)))
  check('deleting before a run pulls it back',
    shape(shiftRuns(runs, 0, 6, 0)) === '0-5:{"color":"#a0f"}', shape(shiftRuns(runs, 0, 6, 0)))
  check('deleting the run text takes the run with it',
    shiftRuns(runs, 6, 11, 0).length === 0, shape(shiftRuns(runs, 6, 11, 0)))
  // Typing at the very end of a styled word extends it; typing at the very
  // start does not, because there the character before belongs to what came
  // first. Two ends, opposite tie-breaks, one convention.
  check('typing at the end of a run extends it',
    shape(shiftRuns(runs, 11, 11, 4)) === '6-15:{"color":"#a0f"}', shape(shiftRuns(runs, 11, 11, 4)))
  check('but typing at the start of one does not',
    shape(shiftRuns(runs, 6, 6, 2)) === '8-13:{"color":"#a0f"}', shape(shiftRuns(runs, 6, 6, 2)))
  check('and typing well after it leaves it alone',
    shape(shiftRuns(runs, 14, 14, 3)) === '6-11:{"color":"#a0f"}', shape(shiftRuns(runs, 14, 14, 3)))
}

check('the properties a run may carry are the ones the inspector offers',
  RUN_PROPS.join() === 'color,weight,italic', RUN_PROPS.join())

console.log(checks.filter(([, o]) => o).length + ' of ' + checks.length + ' passed')
process.exit(checks.some(([, ok]) => !ok) ? 1 : 0)
