import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import fs from 'fs'
import path from 'path'

/**
 * ONNX Runtime dynamically imports its emscripten glue, and Vite answers that
 * with `?import` and a transform pass the glue does not survive (HTTP 500).
 * Serve anything under /ort/ straight off disk instead. Only the dev server
 * needs this; a production build copies public/ verbatim.
 */
function serveOrtRaw() {
  return {
    name: 'serve-ort-raw',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const m = /^\/ort\/([\w.-]+)/.exec(req.url || '')
        if (!m) return next()
        const file = path.resolve('public/ort', m[1])
        if (!fs.existsSync(file)) return next()
        res.setHeader('Content-Type',
          file.endsWith('.wasm') ? 'application/wasm' : 'text/javascript')
        res.setHeader('Cache-Control', 'no-cache')
        fs.createReadStream(file).pipe(res)
      })
    },
  }
}

export default defineConfig({
  plugins: [react(), serveOrtRaw()],
  server: {
    port: 5173,
    open: true,
    // The packaged app is ~250MB of Electron under release/. Watching it is
    // pointless, and on Windows the watcher's open handles stop electron-builder
    // renaming its own staging directory — the build fails with EPERM while the
    // dev server is up.
    watch: { ignored: ['**/release/**', '**/shots-*/**', '**/dist/**'] },
  },
  worker: { format: 'es' },
  optimizeDeps: { exclude: ['onnxruntime-web'] },
})
