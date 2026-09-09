// What a click on a grouped layer selects, under plain node.
//
// Clicking a word of a title should select the title, not the word. That is the
// only thing that makes a group something you can pick up — otherwise every
// click reaches straight through to whatever is under the pointer, and the group
// exists in the layers panel and nowhere else.
//
// Going deeper is a second gesture, which is the part with the arithmetic in it:
// how far in you already are decides what the next click means.
import { clickTarget, isInside, ancestors } from '../../src/engine/groups.js'

const checks = []
const check = (name, ok, detail = '') => {
  checks.push([name, ok])
  console.log((ok ? 'PASS  ' : 'FAIL  ') + name + (detail ? '  — ' + detail : ''))
}

// A title of two words inside a card, inside nothing.
const layers = [
  { id: 'card', type: 'group', parentId: null },
  { id: 'title', type: 'group', parentId: 'card' },
  { id: 'alex', type: 'text', parentId: 'title' },
  { id: 'grey', type: 'text', parentId: 'title' },
  { id: 'photo', type: 'image', parentId: 'card' },
  { id: 'loose', type: 'shape', parentId: null },
]
const at = (id) => layers.find((l) => l.id === id)

check('a layer in no group is itself', clickTarget(layers, at('loose'), null) === 'loose')
check('a layer in a group selects the outermost group',
  clickTarget(layers, at('alex'), null) === 'card', clickTarget(layers, at('alex'), null))
check('however deep it is', clickTarget(layers, at('photo'), null) === 'card')

// Inside the card: one level further in, which is the title, not the word.
check('inside the card, a word selects the title it is in',
  clickTarget(layers, at('alex'), 'card') === 'title',
  clickTarget(layers, at('alex'), 'card'))
check('and a direct child of the card is itself',
  clickTarget(layers, at('photo'), 'card') === 'photo')

// Inside the title: now the word itself.
check('inside the title, a word is the word',
  clickTarget(layers, at('alex'), 'title') === 'alex')

// Standing inside a group you are not in any more.
check('being inside a group you clicked out of starts again from the top',
  clickTarget(layers, at('loose'), 'title') === 'loose')
check('and a click elsewhere in the document is unaffected',
  clickTarget(layers, at('photo'), 'title') === 'card',
  clickTarget(layers, at('photo'), 'title'))

check('nothing clicked selects nothing', clickTarget(layers, null, null) === null)

// --- what counts as being inside ---------------------------------------------
check('a group is inside itself, which is what stops a click leaving it',
  isInside(layers, 'title', 'title'))
check('a child is inside its parent', isInside(layers, 'alex', 'title'))
check('and inside its grandparent', isInside(layers, 'alex', 'card'))
check('a sibling branch is not', !isInside(layers, 'photo', 'title'))
check('and neither is a layer in no group', !isInside(layers, 'loose', 'card'))
check('nothing is inside nothing', !isInside(layers, 'alex', null))

check('the chain runs innermost first, which the rule depends on',
  ancestors(layers, at('alex')).map((g) => g.id).join() === 'title,card',
  ancestors(layers, at('alex')).map((g) => g.id).join())

console.log(checks.filter(([, o]) => o).length + ' of ' + checks.length + ' passed')
process.exit(checks.some(([, ok]) => !ok) ? 1 : 0)
