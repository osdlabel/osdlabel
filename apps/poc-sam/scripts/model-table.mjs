// Node-side view of src/model-table.json (the browser imports the same file
// through src/model-specs.ts), so the runner, the remote server and the pages
// share one model list.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const MODELS_DIR = path.resolve(HERE, '..', 'models');
export const MODEL_TABLE = JSON.parse(
  fs.readFileSync(path.resolve(HERE, '..', 'src', 'model-table.json'), 'utf8'),
);

export function modelById(id) {
  const spec = MODEL_TABLE.find((m) => m.id === id);
  if (!spec) throw new Error(`unknown model ${id}`);
  return spec;
}

/** Absolute encoder / decoder paths for `spec`, honouring `decoderFallback`; null when missing. */
export function modelPaths(spec, modelsDir = MODELS_DIR) {
  const encoder = path.join(modelsDir, spec.encoder);
  let decoder = path.join(modelsDir, spec.decoder);
  if (!fs.existsSync(decoder) && spec.decoderFallback)
    decoder = path.join(modelsDir, spec.decoderFallback);
  if (!fs.existsSync(encoder) || !fs.existsSync(decoder)) return null;
  return { encoder, decoder };
}
