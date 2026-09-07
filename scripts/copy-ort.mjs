// ONNX Runtime loads its wasm at run time rather than inlining it, so the two
// files it needs are copied into public/ and served locally.
import fs from 'fs'
import path from 'path'

const src = 'node_modules/onnxruntime-web/dist'
const dst = 'public/ort'
fs.mkdirSync(dst, { recursive: true })
for (const f of ['ort-wasm-simd-threaded.jsep.wasm', 'ort-wasm-simd-threaded.jsep.mjs']) {
  fs.copyFileSync(path.join(src, f), path.join(dst, f))
  console.log('copied', f, (fs.statSync(path.join(src, f)).size / 1048576).toFixed(1) + 'MB')
}
