// Fetches the real-weight ONNX models the PoC uses into apps/poc-sam/models/
// (git-ignored). Sources that work without huggingface.co / github.com:
//
// - MobileSAM image encoder + the official SAM (ViT-H) ONNX mask decoder,
//   bundled in the npm package @geti-ui/smart-tools (Apache-2.0; Intel Geti's
//   in-browser smart tools), from registry.npmjs.org.
// - SAM 2 Hiera-T (real weights), bundled in @annotorious/plugin-segment-anything
//   0.5.0 (BSD-3-Clause), from registry.npmjs.org.
// - EfficientSAM-Ti encoder + decoder ONNX exports committed to the
//   yformer/EfficientSAM repository (Apache-2.0), via raw.githubusercontent.com.
//
// Then, when a Python with `onnx` is available ($POC_PYTHON or python3), it
// derives the low-res-only SAM decoder (scripts/lowres_decoder.py) and, with
// torch + segment-anything + timm + iopath, the random-weight architectures
// (scripts/export_models.py). Without Python the benchmark falls back to the
// full decoder graph and skips the random-weight models.
//
//   pnpm --filter @osdlabel/poc-sam fetch-models
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MODELS = process.env.POC_MODELS_DIR ?? path.resolve(HERE, '..', 'models');
fs.mkdirSync(MODELS, { recursive: true });

const GETI = 'https://registry.npmjs.org/@geti-ui/smart-tools/-/smart-tools-1.7.0.tgz';
const GETI_FILES = {
  'package/dist/esm/mobile_sam.encoder.onnx': 'mobile_sam.encoder.onnx',
  'package/dist/esm/sam_vit_h_4b8939.decoder.onnx': 'sam_vit_h_4b8939.decoder.onnx',
};
// Real SAM 2 Hiera-T weights: an ORT-format encoder (runtime-optimised) and a
// multimask-only decoder, shipped by Annotorious' OpenSeadragon SAM plugin
// (BSD-3-Clause; ~200 MB unpacked, 151 MB of it these two files).
const ANNOTORIOUS =
  'https://registry.npmjs.org/@annotorious/plugin-segment-anything/-/plugin-segment-anything-0.5.0.tgz';
const ANNOTORIOUS_FILES = {
  'package/dist/sam2_hiera_tiny_encoder.with_runtime_opt.ort': 'sam2_hiera_tiny.encoder.real.ort',
  'package/dist/sam2_hiera_tiny_decoder_pr1.onnx': 'sam2_hiera_tiny.decoder.real.onnx',
};
const RAW = 'https://raw.githubusercontent.com/yformer/EfficientSAM/main/weights';
const DIRECT = {
  'efficient_sam_vitt_encoder.onnx': `${RAW}/efficient_sam_vitt_encoder.onnx`,
  'efficient_sam_vitt_decoder.onnx': `${RAW}/efficient_sam_vitt_decoder.onnx`,
};

async function download(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

/** Minimal ustar reader: yields [name, data] for regular files. */
function* untar(buf) {
  let pos = 0;
  while (pos + 512 <= buf.length) {
    const header = buf.subarray(pos, pos + 512);
    if (header.every((b) => b === 0)) return;
    const name = header.toString('utf8', 0, 100).replace(/\0.*$/s, '');
    const prefix = header.toString('utf8', 345, 500).replace(/\0.*$/s, '');
    const size = parseInt(header.toString('utf8', 124, 136).replace(/\0.*$/s, '').trim() || '0', 8);
    const type = String.fromCharCode(header[156] || 48);
    const full = prefix ? `${prefix}/${name}` : name;
    pos += 512;
    if (type === '0' || type === '\0') yield [full, buf.subarray(pos, pos + size)];
    pos += Math.ceil(size / 512) * 512;
  }
}

const have = (f) => fs.existsSync(path.join(MODELS, f));

async function fromTarball(url, files) {
  if (Object.values(files).every(have)) return;
  console.log(`downloading ${url} …`);
  const tar = zlib.gunzipSync(await download(url));
  for (const [name, data] of untar(tar)) {
    const out = files[name];
    if (!out) continue;
    fs.writeFileSync(path.join(MODELS, out), data);
    console.log(`  ${out} (${(data.length / 1e6).toFixed(1)} MB)`);
  }
}

await fromTarball(GETI, GETI_FILES);
await fromTarball(ANNOTORIOUS, ANNOTORIOUS_FILES);
for (const [file, url] of Object.entries(DIRECT)) {
  if (have(file)) continue;
  console.log(`downloading ${url} …`);
  const data = await download(url);
  fs.writeFileSync(path.join(MODELS, file), data);
  console.log(`  ${file} (${(data.length / 1e6).toFixed(1)} MB)`);
}

const python = process.env.POC_PYTHON ?? 'python3';
const probe = spawnSync(python, ['-c', 'import onnx, onnxruntime'], { encoding: 'utf8' });
if (probe.status !== 0) {
  console.log(
    `\n${python} lacks onnx/onnxruntime: skipping the low-res decoder and the random-weight exports.\n` +
      'The benchmark will use the full SAM decoder graph. To derive the rest:\n' +
      '  python -m venv .venv && .venv/bin/pip install onnx onnxruntime onnxscript torch segment-anything timm iopath\n' +
      '  POC_PYTHON=.venv/bin/python pnpm --filter @osdlabel/poc-sam fetch-models',
  );
} else {
  const run = (args) => {
    console.log(`\n$ ${python} ${args.join(' ')}`);
    const r = spawnSync(python, ['-I', ...args], { stdio: 'inherit', cwd: path.resolve(HERE, '..') });
    return r.status === 0;
  };
  if (!have('sam_vit_h_4b8939.decoder.lowres.onnx')) run(['scripts/lowres_decoder.py']);
  const torch = spawnSync(python, ['-c', 'import torch, segment_anything, timm, iopath'], { encoding: 'utf8' });
  if (torch.status === 0) {
    run(['scripts/export_models.py']);
  } else {
    console.log('\nNo torch/segment-anything/timm/iopath: skipping random-weight exports (EdgeSAM, LiteMedSAM, SAM 2.1-T, SAM ViT-B).');
  }
}
console.log('\nmodels:', fs.readdirSync(MODELS).filter((f) => /\.(onnx|ort)$/.test(f)).join(', '));
