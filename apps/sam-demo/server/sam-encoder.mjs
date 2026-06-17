// @ts-nocheck
// Dev-only MobileSAM image encoder, run as Vite dev-server middleware. It is the
// "server" half of the server-encode -> client-decode topology: it turns an
// image into the [1,256,64,64] embedding the browser's RemoteEmbeddingEncoder
// expects (matching its default JSON wire format).
//
// Plain ESM JS so it isn't part of the TS build; heavy deps (onnxruntime-web,
// sharp) are imported lazily inside the handler so `vite build` never loads them.

import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const INPUT_SIZE = 1024;
// SAM / MobileSAM pixel normalization (ImageNet stats on 0-255 pixels).
const MEAN = [123.675, 116.28, 103.53];
const STD = [58.395, 57.12, 57.375];

const ENCODER_PATH = process.env.SAM_ENCODER_PATH ?? null; // resolved against publicDir/models by default
const ENCODER_INPUT = process.env.SAM_ENCODER_INPUT ?? 'input_image';
const ENCODER_OUTPUT = process.env.SAM_ENCODER_OUTPUT ?? 'image_embeddings';

/**
 * @param {{ publicDir: string }} options
 * @returns {(req: any, res: any, next: () => void) => void}
 */
export function createSamEncoderMiddleware({ publicDir }) {
  let sessionPromise = null;

  const getSession = async () => {
    if (!sessionPromise) sessionPromise = createEncoderSession(publicDir);
    return sessionPromise;
  };

  return (req, res, next) => {
    if (req.method !== 'POST' || (req.url ?? '').split('?')[0] !== '/api/sam/embed') {
      next();
      return;
    }
    handle(req, res, publicDir, getSession).catch((err) => {
      // eslint-disable-next-line no-console
      console.error('[sam-encoder]', err);
      sendJson(res, 500, { error: String(err?.message ?? err) });
    });
  };
}

async function handle(req, res, publicDir, getSession) {
  const body = JSON.parse(await readBody(req));
  const tileSource = String(body.tileSource ?? '');
  const bytes = await loadImageBytes(tileSource, publicDir);

  const { default: sharp } = await import('sharp');
  const meta = await sharp(bytes).metadata();
  const origWidth = meta.width ?? 0;
  const origHeight = meta.height ?? 0;
  if (!origWidth || !origHeight) throw new Error('Could not read image dimensions');

  const scale = INPUT_SIZE / Math.max(origWidth, origHeight);
  const newW = Math.max(1, Math.round(origWidth * scale));
  const newH = Math.max(1, Math.round(origHeight * scale));

  const { data: rgb } = await sharp(bytes)
    .resize(newW, newH, { fit: 'fill' })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  // Build a zero-padded NCHW float tensor and normalize per channel.
  const plane = INPUT_SIZE * INPUT_SIZE;
  const chw = new Float32Array(3 * plane);
  for (let y = 0; y < newH; y++) {
    for (let x = 0; x < newW; x++) {
      const src = (y * newW + x) * 3;
      const dst = y * INPUT_SIZE + x;
      chw[dst] = (rgb[src] - MEAN[0]) / STD[0];
      chw[plane + dst] = (rgb[src + 1] - MEAN[1]) / STD[1];
      chw[2 * plane + dst] = (rgb[src + 2] - MEAN[2]) / STD[2];
    }
  }

  const { ort, session } = await getSession();
  const input = new ort.Tensor('float32', chw, [1, 3, INPUT_SIZE, INPUT_SIZE]);
  const outputs = await session.run({ [ENCODER_INPUT]: input });
  const embedding = outputs[ENCODER_OUTPUT];
  if (!embedding) {
    throw new Error(`Encoder output '${ENCODER_OUTPUT}' missing (set SAM_ENCODER_OUTPUT)`);
  }

  const float = embedding.data;
  const base64 = Buffer.from(float.buffer, float.byteOffset, float.byteLength).toString('base64');
  sendJson(res, 200, {
    dims: embedding.dims,
    origWidth,
    origHeight,
    inputSize: INPUT_SIZE,
    embedding: base64,
  });
}

async function createEncoderSession(publicDir) {
  const ort = await import('onnxruntime-web');
  // onnxruntime-web needs to locate its .wasm assets; point at the installed dist.
  const require = createRequire(import.meta.url);
  ort.env.wasm.wasmPaths = path.dirname(require.resolve('onnxruntime-web')) + path.sep;
  ort.env.wasm.numThreads = 1; // avoid spawning workers in Node

  const modelPath = ENCODER_PATH ?? path.join(publicDir, 'models', 'mobile_sam_encoder.onnx');
  if (!existsSync(modelPath)) {
    throw new Error(
      `MobileSAM encoder not found at ${modelPath}. Run \`pnpm --filter @osdlabel/sam-demo fetch-models\` or set SAM_ENCODER_PATH.`,
    );
  }
  const session = await ort.InferenceSession.create(modelPath, { executionProviders: ['wasm'] });
  return { ort, session };
}

async function loadImageBytes(tileSource, publicDir) {
  if (/^https?:\/\//i.test(tileSource)) {
    const response = await fetch(tileSource);
    if (!response.ok) throw new Error(`Failed to fetch image: ${response.status}`);
    return Buffer.from(await response.arrayBuffer());
  }
  // Resolve a relative tileSource against the served public dir, guarding traversal.
  const rel = tileSource.replace(/^\/+/, '');
  const resolved = path.resolve(publicDir, rel);
  if (!resolved.startsWith(path.resolve(publicDir))) throw new Error('Invalid image path');
  return readFile(resolved);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function sendJson(res, status, payload) {
  const data = JSON.stringify(payload);
  res.statusCode = status;
  res.setHeader('content-type', 'application/json');
  res.end(data);
}
