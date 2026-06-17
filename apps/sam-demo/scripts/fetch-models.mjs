// Downloads the MobileSAM encoder + decoder ONNX models into public/models/.
// URLs are configurable via env vars (no brittle hardcoded links). Export your
// own with https://github.com/vietanhdev/samexporter or use a community release.
//
//   SAM_ENCODER_URL=<url> SAM_DECODER_URL=<url> \
//     pnpm --filter @osdlabel/sam-demo fetch-models

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const modelsDir = path.resolve(here, '..', 'public', 'models');

const targets = [
  { env: 'SAM_ENCODER_URL', file: 'mobile_sam_encoder.onnx' },
  { env: 'SAM_DECODER_URL', file: 'mobile_sam_decoder.onnx' },
];

const missing = targets.filter((t) => !process.env[t.env]);
if (missing.length > 0) {
  console.error(
    `Missing model URL(s): ${missing.map((t) => t.env).join(', ')}\n\n` +
      'Set both before running, e.g.:\n' +
      '  SAM_ENCODER_URL=<url> SAM_DECODER_URL=<url> \\\n' +
      '    pnpm --filter @osdlabel/sam-demo fetch-models\n\n' +
      'Obtain MobileSAM ONNX via https://github.com/vietanhdev/samexporter or a community export.',
  );
  process.exit(1);
}

await mkdir(modelsDir, { recursive: true });
for (const target of targets) {
  const url = process.env[target.env];
  console.log(`Downloading ${target.file} ...`);
  const response = await fetch(url);
  if (!response.ok) {
    console.error(`Failed (${response.status}): ${url}`);
    process.exit(1);
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  await writeFile(path.join(modelsDir, target.file), buffer);
  console.log(`  -> public/models/${target.file} (${(buffer.length / 1e6).toFixed(1)} MB)`);
}
console.log('Done.');
