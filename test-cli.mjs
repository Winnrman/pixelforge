// The command line, end to end.
//
// Every check runs the real thing as a person would: `node pf.mjs render ...`,
// then looks at the bytes that came out. Nothing here reaches inside the tool,
// because what is being tested is whether it works from outside — which is the
// only place it is ever used from.
import { execFile } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'

const checks = []
const check = (name, ok, detail = '') => {
  checks.push([name, ok])
  console.log((ok ? 'PASS  ' : 'FAIL  ') + name + (detail ? '  — ' + detail : ''))
}

const OUT = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-cli-'))
process.on('exit', () => {
  try { fs.rmSync(OUT, { recursive: true, force: true }) } catch { /* held open */ }
})

const run = (args) => new Promise((res) => {
  execFile(process.execPath, ['pf.mjs', ...args], { timeout: 120000 }, (err, stdout, stderr) => {
    res({ code: err?.code ?? 0, stdout: String(stdout), stderr: String(stderr) })
  })
})

/** Width and height straight out of a PNG's IHDR. */
const pngSize = (file) => {
  const b = fs.readFileSync(file)
  const png = b.slice(0, 8).toString('hex') === '89504e470d0a1a0a'
  return { png, w: b.readUInt32BE(16), h: b.readUInt32BE(20), bytes: b.length }
}

const spec = path.join(OUT, 'spec.json')
fs.writeFileSync(spec, JSON.stringify({
  width: 400,
  height: 200,
  background: '#101014',
  duration: 600,
  layers: [
    {
      type: 'shape', shape: 'rect', x: 0, y: 0, w: 400, h: 200,
      fill: '#3a1c71', fill2: '#d76d77', fillAngle: 90,
      stroke: 'none', strokeWidth: 0,
    },
    {
      type: 'text', text: 'CLI', x: 40, y: 60, w: 320, h: 90,
      size: 64, weight: 900, color: '#ffffff', strokeWidth: 0, autoSize: false,
      // A move, so a frame drawn at one instant differs from another.
      tracks: {
        x: [{ t: 0, v: -200, ease: 'linear' }, { t: 600, v: 40, ease: 'linear' }],
      },
    },
  ],
}, null, 2))

// --- it explains itself ---------------------------------------------------------
const help = await run(['--help'])
check('help says what it is for', help.code === 0 && /render a document/i.test(help.stdout),
  help.stdout.split('\n')[0])

// --- a still --------------------------------------------------------------------
const png = path.join(OUT, 'still.png')
const one = await run(['render', spec, '--out', png])
console.log('render:', one.stdout.trim() || one.stderr.trim())
check('a spec renders to a png', one.code === 0 && fs.existsSync(png), one.stderr.slice(0, 120))
const size = fs.existsSync(png) ? pngSize(png) : {}
check('which is a real png at the size the spec asked for',
  size.png && size.w === 400 && size.h === 200, JSON.stringify(size))
check('with something actually drawn in it', size.bytes > 2000, `${size.bytes} bytes`)

// --- the instant matters ---------------------------------------------------------
// A keyframed move means two instants are two different pictures. If they come
// back identical the animation was not applied, which nothing else here notices.
const late = path.join(OUT, 'late.png')
await run(['render', spec, '--out', late, '--time', '600'])
const same = fs.existsSync(late) && Buffer.compare(fs.readFileSync(png), fs.readFileSync(late)) === 0
check('drawing a different instant gives a different picture', !same)

// --- scale ------------------------------------------------------------------------
const big = path.join(OUT, 'big.png')
await run(['render', spec, '--out', big, '--scale', '2'])
const bigSize = fs.existsSync(big) ? pngSize(big) : {}
check('scale multiplies the output', bigSize.w === 800 && bigSize.h === 400, JSON.stringify(bigSize))

// --- an animation -----------------------------------------------------------------
const gif = path.join(OUT, 'anim.gif')
const g = await run(['render', spec, '--out', gif, '--fps', '12'])
console.log('gif:', g.stdout.trim() || g.stderr.trim())
const head = fs.existsSync(gif) ? fs.readFileSync(gif).slice(0, 6).toString('ascii') : ''
check('an animation renders to a gif', g.code === 0 && head === 'GIF89a', head)
check('with more than one frame in it', /(\d+) frames/.test(g.stdout)
  && Number(g.stdout.match(/(\d+) frames/)[1]) > 3, g.stdout.trim())

// --- a numbered sequence ------------------------------------------------------------
const dir = path.join(OUT, 'frames')
const f = await run(['render', spec, '--out', dir, '--frames', '--fps', '10'])
const written = fs.existsSync(dir) ? fs.readdirSync(dir).filter((n) => n.endsWith('.png')) : []
check('frames can be written one file each', f.code === 0 && written.length > 3,
  `${written.length} files`)
check('numbered so they sort into order',
  written.length > 0 && written[0] === '0000.png' && written.every((n) => /^\d{4}\.png$/.test(n)),
  written.slice(0, 3).join(' '))

// --- saying no ------------------------------------------------------------------------
// A tool that fails quietly is worse than one that fails: the output of a bad
// spec is a missing file nobody looks for until later.
const missing = await run(['render', path.join(OUT, 'nope.json'), '--out', path.join(OUT, 'x.png')])
check('a spec that does not exist is an error, not a silence',
  missing.code !== 0 && /no such spec/i.test(missing.stderr), missing.stderr.trim().slice(0, 80))

const noOut = await run(['render', spec])
check('and so is forgetting where to put it',
  noOut.code !== 0 && /--out/.test(noOut.stderr), noOut.stderr.trim().slice(0, 80))

const badMedia = path.join(OUT, 'badmedia.json')
fs.writeFileSync(badMedia, JSON.stringify({
  width: 100, height: 100, media: [{ id: 'hero', file: 'nowhere.png' }], layers: [],
}))
const bm = await run(['render', badMedia, '--out', path.join(OUT, 'y.png')])
check('a spec naming media that is not there says which',
  bm.code !== 0 && /nowhere\.png/.test(bm.stderr), bm.stderr.trim().slice(0, 90))

console.log(checks.filter(([, o]) => o).length + ' of ' + checks.length + ' passed')
process.exit(checks.some(([, ok]) => !ok) ? 1 : 0)
