import { build } from 'esbuild';
import { mkdir, copyFile, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const root = fileURLToPath(new URL('..', import.meta.url));
const out = resolve(root, 'vendor/llm');
await mkdir(out, { recursive: true });
// The main application never imports this bundle. It is fetched only after consent.
await build({
  entryPoints: [resolve(root, 'src/llm-worker.js')],
  outfile: resolve(out, 'worker.js'),
  bundle: true, format: 'esm', platform: 'browser', target: ['es2022'],
  minify: true, legalComments: 'inline', sourcemap: false,
});
const ort = resolve(root, 'node_modules/onnxruntime-web/dist');
for (const name of ['ort-wasm-simd-threaded.jsep.mjs', 'ort-wasm-simd-threaded.jsep.wasm', 'ort-wasm-simd-threaded.asyncify.mjs', 'ort-wasm-simd-threaded.asyncify.wasm']) {
  await copyFile(resolve(ort, name), resolve(out, name));
}
const licenses = [
  ['Transformers.js', 'node_modules/@huggingface/transformers/LICENSE'],
  ['ONNX Runtime', 'licenses/ONNX-Runtime-LICENSE.txt'],
];
for (const [name, path] of licenses) {
  try { await copyFile(resolve(root, path), resolve(out, `${name.replaceAll(' ', '-')}-LICENSE.txt`)); }
  catch { /* Package versions may ship their notice in a different file. */ }
}
const pkg = JSON.parse(await readFile(resolve(root, 'node_modules/@huggingface/transformers/package.json'), 'utf8'));
await writeFile(resolve(out, 'NOTICE.json'), JSON.stringify({ runtime: '@huggingface/transformers', version: pkg.version, model: 'onnx-community/Qwen2.5-0.5B-Instruct', modelLicense: 'Apache-2.0', weightsBundled: false }, null, 2));
console.log(`Local LLM runtime built in vendor/llm (weights are downloaded only after consent).`);
