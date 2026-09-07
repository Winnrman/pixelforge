// Desktop dev: run the Vite server and point Electron at it, so the desktop
// build gets hot reload instead of needing a production build each time.
import { spawn } from 'child_process'
import net from 'net'

const PORT = 5173
const vite = spawn('npm', ['run', 'dev', '--', '--no-open'], { shell: true, stdio: 'inherit' })

const up = () => new Promise((res) => {
  const s = net.connect(PORT, '127.0.0.1')
  s.on('connect', () => { s.destroy(); res(true) })
  s.on('error', () => res(false))
})

// Electron shows a blank window if it beats the dev server to the punch, so
// wait for the port rather than guessing at a delay.
for (let i = 0; i < 100; i++) {
  if (await up()) break
  await new Promise((r) => setTimeout(r, 200))
}

const electron = spawn(
  process.platform === 'win32' ? 'npx.cmd' : 'npx',
  ['electron', '.'],
  { stdio: 'inherit', env: { ...process.env, PF_DEV: '1' }, shell: process.platform === 'win32' },
)
electron.on('close', () => { vite.kill(); process.exit(0) })
