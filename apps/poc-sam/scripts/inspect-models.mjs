// Prints the input/output signature of every ONNX model in models/ (or the
// paths given), using onnxruntime-node. Used to wire model adapters.
//
//   node scripts/inspect-models.mjs [model.onnx ...]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ort from 'onnxruntime-node';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MODELS = path.resolve(HERE, '..', 'models');
const files =
  process.argv.length > 2
    ? process.argv.slice(2)
    : fs
        .readdirSync(MODELS)
        .filter((f) => f.endsWith('.onnx'))
        .map((f) => path.join(MODELS, f));

for (const file of files) {
  const session = await ort.InferenceSession.create(file);
  const meta = (names, metas) =>
    names.map((n, i) => {
      const m = metas?.[i];
      const shape = m && 'shape' in m ? JSON.stringify(m.shape) : '?';
      const type = m && 'type' in m ? m.type : '?';
      return `${n}:${type}${shape}`;
    });
  console.log(path.basename(file), `${(fs.statSync(file).size / 1e6).toFixed(1)} MB`);
  console.log('  in :', meta(session.inputNames, session.inputMetadata).join('  '));
  console.log('  out:', meta(session.outputNames, session.outputMetadata).join('  '));
  await session.release();
}
