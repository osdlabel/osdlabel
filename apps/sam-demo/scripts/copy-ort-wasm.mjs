// Copies the ONNX Runtime Web `.wasm` / `.mjs` assets into public/ort/ so the
// browser decoder can load them same-origin (required under COEP: require-corp).
// Runs automatically on `predev`.

import { createRequire } from 'node:module';
import { mkdir, readdir, copyFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

let dist = path.dirname(require.resolve('onnxruntime-web'));
const hasAssets = async (dir) => (await readdir(dir)).some((f) => f.endsWith('.wasm'));

if (!(await hasAssets(dist).catch(() => false))) {
  // Fall back to a nested dist/ directory if the main entry isn't alongside the wasm.
  const nested = path.join(dist, 'dist');
  if (await hasAssets(nested).catch(() => false)) dist = nested;
}

const outDir = path.resolve(here, '..', 'public', 'ort');
await mkdir(outDir, { recursive: true });

let copied = 0;
for (const file of await readdir(dist)) {
  if (file.endsWith('.wasm') || file.endsWith('.mjs')) {
    await copyFile(path.join(dist, file), path.join(outDir, file));
    copied += 1;
  }
}
console.log(`[copy-ort-wasm] copied ${copied} ONNX Runtime asset(s) to public/ort/`);
