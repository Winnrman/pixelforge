// No paragraphs on screen.
//
// The panels had grown essays. Three of them sat under the canvas size fields
// explaining what Leave, Fit and Fill do, what "shrink canvas to fit content"
// moves and what "scale content to fill canvas" moves instead — perfectly true,
// and between the reader and the two buttons they were about.
//
// The explanations are worth having; they are worth having behind the (i). So
// this walks the interface source and measures what a panel actually *shows*,
// with anything inside an <Info> taken out, and fails on anything long enough to
// read as a paragraph. It is a linter rather than a test of behaviour, which is
// the right shape for the thing it guards: nobody notices prose creeping back in
// a diff, and everybody notices it in the panel a month later.
import fs from 'fs'
import path from 'path'

/** How much visible text a hint may carry. About two lines in a panel. */
const LIMIT = 120

/** Long enough to be prose rather than a label, a unit or a class name. */
const PROSE = 40

const checks = []
const check = (name, ok, detail = '') => {
  checks.push([name, ok])
  console.log((ok ? 'PASS  ' : 'FAIL  ') + name + (detail ? '  — ' + detail : ''))
}

function jsxFiles(dir) {
  const out = []
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) out.push(...jsxFiles(p))
    else if (e.name.endsWith('.jsx')) out.push(p)
  }
  return out
}

/**
 * What one element shows, as the longest single run a reader meets.
 *
 * Two kinds of run, because there are two ways to write a paragraph. The plain
 * text between the tags is one, joined up — a sentence broken across source
 * lines is still a sentence. Each string literal inside a brace is another,
 * measured on its own, because the arms of a ternary are alternatives rather
 * than a queue: only one of them is ever on screen.
 */
function longestRun(body) {
  const visible = body.replace(/<Info>[\s\S]*?<\/Info>/g, '')
  const runs = []

  const flat = visible
    .replace(/\{[^{}]*\}/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&\w+;/g, ' ')
  runs.push(flat.split(/\s+/).filter(Boolean).join(' '))

  for (const m of visible.matchAll(/(['"`])((?:\\.|(?!\1)[^\\])*)\1/g)) {
    const lit = m[2].replace(/\$\{[^{}]*\}/g, ' ').trim()
    if (lit.length >= PROSE) runs.push(lit)
  }
  return runs.reduce((a, b) => (b.length > a.length ? b : a), '')
}

// Anything that reads as running text. Buttons, labels and readouts are not
// here: a long readout is a long number, not a paragraph.
const ELEMENTS = /<(p|h1|h2|li)(\s[^>]*)?>([\s\S]*?)<\/\1>/g

const offenders = []
let scanned = 0
let elements = 0
for (const file of [...jsxFiles('src')]) {
  const src = fs.readFileSync(file, 'utf8')
  scanned++
  for (const m of src.matchAll(ELEMENTS)) {
    // Elements holding other elements are measured through those instead, or
    // the outer one counts its children's text twice.
    const inner = m[3].replace(/<Info>[\s\S]*?<\/Info>/g, '')
    if (/<(p|h1|h2|li)[\s>]/.test(inner)) continue
    elements++
    const run = longestRun(m[3])
    if (run.length > LIMIT) {
      offenders.push({
        where: `${file}:${src.slice(0, m.index).split('\n').length}`,
        len: run.length,
        text: run.slice(0, 90),
      })
    }
  }
}

console.log(`${elements} pieces of running text across ${scanned} files`)
check('the interface has text in it to check', elements > 40, `${elements}`)
for (const o of offenders) console.log(`  ${o.where}  (${o.len} chars)  ${o.text}...`)
check(`nothing on screen runs longer than ${LIMIT} characters`,
  offenders.length === 0,
  offenders.length ? `${offenders.length} to move behind an (i)` : '')

// And the (i) is genuinely being used, rather than everything having been
// deleted to get the number down.
const infos = jsxFiles('src')
  .map((f) => (fs.readFileSync(f, 'utf8').match(/<Info>|info=\{/g) || []).length)
  .reduce((a, b) => a + b, 0)
console.log(`${infos} explanations behind an (i)`)
check('the explanations are still there, behind the dot', infos > 40, `${infos}`)

console.log(checks.filter(([, o]) => o).length + ' of ' + checks.length + ' passed')
process.exit(checks.some(([, ok]) => !ok) ? 1 : 0)
