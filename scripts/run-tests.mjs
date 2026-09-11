// Running the suites.
//
// There were thirty-eight browser suites chained with `&&`, one at a time, each
// booting its own Chrome. That is around twelve minutes to find out whether a
// one-line change broke anything, which is long enough that you stop running it
// — and a suite you stop running is worth nothing.
//
// Two things fix that. They are independent, and the second matters more.
//
//   Run them at once. Every suite drives its own browser against the same dev
//   server and writes to its own screenshot folder, so nothing shares state and
//   there is nothing to serialise. On twenty cores this is most of the wall
//   clock back.
//
//   Run fewer. Most changes touch one corner of the app, and `--changed` maps
//   what git says you edited onto the suites that could possibly notice. A
//   change to the eraser does not need the MP4 export suite's opinion.
//
// The full run stays exactly one command, because a full run before pushing is
// the point of having the thing at all.
import { spawn, execFileSync } from 'child_process'
import { existsSync } from 'fs'
import os from 'os'

/**
 * Which suites care about which source.
 *
 * Prefix-matched against the paths git reports, longest first, so a specific
 * entry beats a general one. Anything that matches nothing falls through to
 * EVERYTHING — the honest default when the map has not been taught about a file
 * is to run the lot, not to quietly skip.
 */
const OWNERS = [
  ['src/engine/transitions.js', ['e2e-transitions', 'test-transitions', 'e2e-clips', 'e2e-tracks']],
  ['src/engine/clips.js', ['e2e-clips', 'e2e-tracks', 'e2e-transitions', 'test-clips', 'e2e-filmstrip', 'e2e-join']],
  ['src/engine/gradient.js', ['e2e-gradient', 'test-gradient', 'e2e-text', 'e2e-tint']],
  ['src/engine/shapes.js', ['test-mask', 'e2e-maskedit', 'e2e-lasso', 'e2e-subject', 'e2e-gradient']],
  ['src/engine/lassoedit.js', ['test-lassoedit', 'e2e-maskedit', 'e2e-lasso']],
  ['src/engine/tools.js', ['test-tools', 'e2e-tools2', 'e2e-erase', 'e2e-maskedit', 'e2e-heal']],
  ['src/engine/heal.js', ['test-heal', 'test-watermark', 'e2e-heal', 'e2e-healai', 'e2e-watermark']],
  ['src/engine/healed.js', ['e2e-heal', 'e2e-healai', 'e2e-ai', 'e2e-watermark']],
  ['src/engine/watermark.js', ['test-watermark', 'e2e-watermark']],
  ['src/engine/fft.js', ['test-watermark', 'e2e-watermark']],
  ['src/engine/inpaint.js', ['e2e-heal', 'e2e-healai']],
  ['src/engine/models.js', ['e2e-ai', 'e2e-heal', 'e2e-healai']],
  ['src/engine/palette.js', ['test-tools', 'e2e-tint']],
  ['src/engine/fonts.js', ['e2e-text']],
  ['src/engine/brush.js', ['test-tools', 'e2e-erase', 'e2e-maskedit', 'e2e-clone']],
  ['src/engine/groups.js', ['test-groups', 'e2e-groups', 'e2e-canvas', 'e2e-gradient']],
  ['src/engine/erase.js', ['e2e-erase', 'e2e-sticker', 'e2e-tools2', 'e2e-lasso']],
  ['src/engine/clone.js', ['e2e-clone']],
  ['src/engine/wand.js', ['e2e-wand']],
  ['src/engine/edges.js', ['e2e-magnet', 'test-edges']],
  ['src/engine/snap.js', ['test-snap', 'e2e-snap']],
  ['src/engine/grid.js', ['test-snap', 'e2e-snap', 'e2e-canvas']],
  ['src/engine/dpi.js', ['e2e-print', 'test-dpi']],
  ['src/engine/waveform.js', ['e2e-audio', 'e2e-tracks']],
  ['src/engine/audio.js', ['e2e-audio', 'e2e-transitions', 'e2e-audiotrack']],
  ['src/engine/video.js', ['e2e-video', 'e2e-videoperf', 'e2e-transitions', 'e2e-clips', 'e2e-webm']],
  ['src/engine/webm.js', ['test-webm', 'e2e-webm']],
  ['src/engine/effects.js', ['e2e-tools2', 'e2e', 'e2e-batch']],
  ['src/engine/subject.js', ['e2e-subject', 'e2e-sticker', 'e2e-matte', 'e2e-ai', 'e2e-maskedit']],
  ['src/engine/matte.js', ['e2e-matte', 'e2e-ai', 'e2e-subject']],
  ['src/engine/aiMatte.js', ['e2e-ai', 'e2e-subject']],
  ['src/engine/keyframes.js', ['e2e-keyframes', 'e2e-keysel', 'e2e-framing', 'e2e-identity', 'e2e-audiotrack']],
  ['src/engine/exporters.js', ['e2e-editing', 'e2e-print', 'e2e-batch']],
  ['pf.mjs', ['test-cli']],
  ['scripts/headless-entry.js', ['test-cli']],
  ['src/engine/text.js', ['e2e-text']],
  ['src/engine/richtext.js', ['test-richtext', 'e2e-text']],
  ['src/engine/collage.js', ['e2e-mount', 'test-collage']],
  ['src/engine/project.js', ['e2e-project', 'e2e-backup']],
  ['src/engine/filmstrip.js', ['e2e-filmstrip', 'e2e-clips', 'e2e-tracks', 'e2e-join']],
  ['src/engine/loop.js', ['e2e-loop', 'test-loop']],
  ['src/engine/retro.js', ['test-retro', 'e2e-batch', 'e2e-tint']],
  ['src/engine/cursor.js', ['test-cursor']],
  ['src/engine/trace.js', ['test-trace', 'e2e-magnet']],
  ['src/components/Filmstrip.jsx', ['e2e-clips', 'e2e-tracks', 'e2e-filmstrip', 'e2e-transitions', 'e2e-join']],
  ['src/components/Timeline.jsx', ['e2e-keyframes', 'e2e-keysel', 'e2e-clips', 'e2e-tracks', 'e2e-audiotrack', 'e2e-transport', 'e2e-editing']],
  ['src/components/AudioRow.jsx', ['e2e-audiotrack']],
  ['src/components/MediaPool.jsx', ['e2e-media', 'e2e', 'e2e-transport']],
  ['src/components/MediaView.jsx', ['e2e-media', 'e2e-mount']],
  ['src/components/ExportDialog.jsx', ['e2e-print', 'e2e-batch', 'e2e', 'e2e-editing']],
  ['src/components/Inspector.jsx', ['e2e-gradient', 'e2e-keyframes', 'e2e-text', 'e2e-subject']],
  ['src/components/LassoBar.jsx', ['e2e-lasso', 'e2e-wand', 'e2e-tools2', 'e2e-maskedit']],
  ['src/components/ToolRail.jsx', ['e2e-clone', 'e2e-wand', 'e2e-eyedrop', 'e2e-lasso', 'e2e-erase', 'e2e-maskedit', 'e2e-tools2', 'e2e-heal']],
  ['src/components/OpenDialog.jsx', ['e2e-project', 'e2e-backup']],
  ['electron/', ['desktop']],
]

/** Suites that always run: they are the ones a change anywhere can break. */
const ALWAYS = ['e2e', 'test-prose']

// Pure node, milliseconds each. `test-edges` is not here: it is named like a
// unit suite but drives a browser, because buildEdgeMap draws through a canvas.
// What matters for scheduling is what a suite costs, not what it is called.
const UNITS = [
  'test-retro', 'test-loop', 'test-cursor', 'test-collage', 'test-trace',
  'test-dpi', 'test-clips', 'test-transitions', 'test-gradient', 'test-mask',
  'test-prose', 'test-groups', 'test-richtext', 'test-snap', 'test-lassoedit',
  'test-tools', 'test-heal', 'test-watermark', 'test-webm',
]

const BROWSER = [
  'e2e', 'e2e-keyframes', 'e2e-crop', 'e2e-video', 'e2e-framing', 'e2e-matte',
  'e2e-ai', 'e2e-tracking', 'e2e-snap', 'e2e-identity', 'e2e-lasso', 'e2e-groups',
  'e2e-project', 'e2e-subject', 'e2e-loop', 'e2e-batch', 'e2e-filmstrip',
  'e2e-media', 'e2e-erase', 'e2e-text', 'e2e-keysel', 'e2e-sticker', 'e2e-backup',
  'e2e-canvas', 'e2e-print', 'e2e-videoperf', 'e2e-clips', 'e2e-audio',
  'e2e-tracks', 'e2e-mount', 'e2e-cropimage', 'e2e-magnet', 'e2e-eyedrop',
  'e2e-wand', 'e2e-clone', 'e2e-tools2', 'e2e-clipboard', 'e2e-transitions',
  'e2e-audiotrack', 'e2e-join', 'e2e-transport', 'e2e-editing', 'e2e-gradient',
  'e2e-maskedit', 'e2e-tint', 'e2e-heal', 'e2e-healai', 'e2e-watermark', 'e2e-webm', 'test-edges', 'test-cli',
]

// Where a suite lives, from what it is: the two lists above are the same split
// as the two folders, so nothing has to be said twice and a suite in the wrong
// folder is a suite the runner cannot find.
const isUnit = (name) => UNITS.includes(name)
const fileFor = (name) => `tests/${isUnit(name) ? 'unit' : 'browser'}/${name}.mjs`

function changedFiles() {
  const out = []
  for (const args of [['diff', '--name-only', 'HEAD'], ['ls-files', '--others', '--exclude-standard']]) {
    try {
      const r = execFileSync('git', args, { encoding: 'utf8' })
      if (r) out.push(...r.split('\n').map((s) => s.trim()).filter(Boolean))
    } catch { /* not a repo, or git missing: fall through to everything */ }
  }
  return [...new Set(out)]
}


/** The suites a set of changed paths could possibly affect. */
export function suitesFor(files) {
  if (!files.length) return []
  const picked = new Set(ALWAYS)
  for (const f of files) {
    const p = f.replace(/\\/g, '/')
    // A suite edited directly is a suite to run.
    const own = p.match(/^tests\/(?:unit|browser)\/(e2e[a-z0-9-]*|test-[a-z0-9-]*)\.mjs$/)
    if (own) { picked.add(own[1]); continue }
    const hit = OWNERS
      .filter(([prefix]) => p.startsWith(prefix))
      .sort((a, b) => b[0].length - a[0].length)[0]
    if (hit) { for (const s of hit[1]) picked.add(s) }
    else if (p.startsWith('src/') || p.startsWith('scripts/') || p.startsWith('tests/')
      || p === 'package.json') {
      // Touched something the map has not been taught about. Everything, then:
      // guessing narrowly here is how a suite stops being trusted.
      return null
    }
  }
  return [...picked]
}

function runOne(name) {
  return new Promise((resolve) => {
    const started = Date.now()
    const child = spawn(process.execPath, [fileFor(name)], { stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    child.stdout.on('data', (d) => { out += d })
    child.stderr.on('data', (d) => { out += d })
    child.on('close', (code) => {
      const pass = (out.match(/^PASS /gm) || []).length
      const fail = (out.match(/^FAIL /gm) || []).length
      resolve({ name, code, pass, fail, out, ms: Date.now() - started })
    })
  })
}

async function pool(names, limit, onDone) {
  const queue = [...names]
  const results = []
  const workers = Array.from({ length: Math.min(limit, queue.length) }, async () => {
    while (queue.length) {
      const name = queue.shift()
      const r = await runOne(name)
      results.push(r)
      onDone(r, results.length, names.length)
    }
  })
  await Promise.all(workers)
  return results
}

const args = process.argv.slice(2)
const only = args.find((a) => a.startsWith('--only='))?.slice(7).split(',').filter(Boolean)
const wantChanged = args.includes('--changed')
const unitsOnly = args.includes('--units')
const jobsArg = Number(args.find((a) => a.startsWith('--jobs='))?.slice(7))

let names
if (only) {
  names = only
} else if (unitsOnly) {
  names = UNITS
} else if (wantChanged) {
  const files = changedFiles()
  const picked = suitesFor(files)
  if (picked === null) {
    console.log(`${files.length} files changed, and one of them is not in the map — running everything.`)
    names = [...UNITS, ...BROWSER]
  } else if (!picked.length) {
    console.log('Nothing changed. Nothing to run.')
    process.exit(0)
  } else {
    console.log(`${files.length} files changed:`)
    for (const f of files.slice(0, 12)) console.log('  ' + f)
    if (files.length > 12) console.log(`  ...and ${files.length - 12} more`)
    names = picked
  }
} else {
  names = [...UNITS, ...BROWSER]
}

names = names.filter((n) => {
  if (existsSync(fileFor(n))) return true
  console.log(`(no such suite: ${n})`)
  return false
})

// Units are pure node and cost milliseconds; browser suites each want a core and
// a Chrome. More than about half the cores and they start queueing on the dev
// server rather than on the CPU.
const jobs = jobsArg || Math.max(2, Math.min(8, Math.floor(os.cpus().length / 2)))
const browsers = names.filter((n) => !isUnit(n))
console.log(`\n${names.length} suite${names.length === 1 ? '' : 's'}, ${jobs} at a time\n`)

const t0 = Date.now()
const results = await pool(names, jobs, (r, done, total) => {
  const mark = r.code === 0 ? 'ok  ' : 'FAIL'
  const bar = `[${String(done).padStart(2)}/${total}]`
  console.log(`${bar} ${mark} ${r.name.padEnd(18)} ${String(r.pass).padStart(3)} checks  ${(r.ms / 1000).toFixed(1)}s`)
})

const failed = results.filter((r) => r.code !== 0)
const totalPass = results.reduce((n, r) => n + r.pass, 0)
const totalFail = results.reduce((n, r) => n + r.fail, 0)

if (failed.length) {
  console.log('\n' + '─'.repeat(70))
  for (const r of failed) {
    console.log(`\n=== ${r.name} ===`)
    // The failures and enough around them to read, not the whole log.
    const lines = r.out.split('\n')
    const wanted = new Set()
    lines.forEach((l, i) => {
      if (/^FAIL |Error|error:|PAGEERROR|CONSOLE ERROR/.test(l)) {
        for (let k = Math.max(0, i - 2); k <= Math.min(lines.length - 1, i + 2); k++) wanted.add(k)
      }
    })
    const shown = [...wanted].sort((a, b) => a - b)
    if (shown.length) for (const i of shown) console.log('  ' + lines[i])
    else console.log(r.out.split('\n').slice(-15).map((l) => '  ' + l).join('\n'))
  }
}

console.log('\n' + '─'.repeat(70))
console.log(`${totalPass} checks, ${totalFail} failed, across ${results.length} suites`
  + ` in ${((Date.now() - t0) / 1000).toFixed(1)}s`
  + (browsers.length ? ` (${browsers.length} in a browser)` : ''))
if (failed.length) console.log(`failed: ${failed.map((r) => r.name).join(', ')}`)
process.exit(failed.length ? 1 : 0)
