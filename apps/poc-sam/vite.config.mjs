import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { synthTileMiddleware } from './scripts/synth-tiles.mjs';
import { remoteSamMiddleware } from './scripts/remote-sam-server.mjs';

/**
 * PoC harness server.
 *
 * - COOP/COEP so the page is cross-origin isolated: SharedArrayBuffer (threaded
 *   WASM) and a ~5µs performance.now().
 * - /ort/*     onnxruntime-web's .wasm/.mjs runtime, served same-origin.
 * - /models/*  ONNX models from apps/poc-sam/models (git-ignored; fetched or
 *              exported by scripts/fetch-models.mjs and scripts/export_models.py).
 * - /synth/*   a procedurally generated gigapixel DZI (scripts/synth-tiles.mjs).
 * - /api/sam/* the "remote" topology: server-side encode (onnxruntime-node).
 * - /sample/*  the repo's vendored sample DZI (apps/dev/sample-data).
 */
const HERE = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const ORT_DIST = path.dirname(require.resolve('onnxruntime-web/ort-wasm-simd-threaded.wasm'));
const MODELS = path.join(HERE, 'models');
const SAMPLE = path.resolve(HERE, '..', 'dev', 'sample-data');

const MIME = {
  '.wasm': 'application/wasm',
  '.mjs': 'text/javascript',
  '.js': 'text/javascript',
  '.onnx': 'application/octet-stream',
  '.dzi': 'application/xml',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.png': 'image/png',
};

const isolation = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
  'Cross-Origin-Resource-Policy': 'same-origin',
};

function staticDir(prefix, dir, { immutable = false } = {}) {
  return (req, res, next) => {
    const url = (req.url ?? '').split('?')[0];
    if (!url.startsWith(prefix)) return next();
    const rel = decodeURIComponent(url.slice(prefix.length));
    const file = path.join(dir, rel);
    if (!file.startsWith(dir) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
      res.statusCode = 404;
      res.end(`not found: ${url}`);
      return;
    }
    res.setHeader('Content-Type', MIME[path.extname(file)] ?? 'application/octet-stream');
    res.setHeader('Content-Length', fs.statSync(file).size);
    for (const [k, v] of Object.entries(isolation)) res.setHeader(k, v);
    if (immutable) res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    fs.createReadStream(file).pipe(res);
  };
}

export default {
  root: HERE,
  plugins: [
    {
      name: 'poc-sam-assets',
      configureServer(server) {
        server.middlewares.use(staticDir('/ort/', ORT_DIST, { immutable: true }));
        server.middlewares.use(staticDir('/models/', MODELS, { immutable: true }));
        server.middlewares.use(staticDir('/sample/', SAMPLE, { immutable: true }));
        server.middlewares.use(synthTileMiddleware('/synth/'));
        server.middlewares.use(remoteSamMiddleware('/api/sam/', { modelsDir: MODELS }));
      },
    },
  ],
  optimizeDeps: {
    // onnxruntime-web locates its .wasm relative to itself; pre-bundling would
    // move it. We set env.wasm.wasmPaths = '/ort/' explicitly anyway.
    exclude: ['onnxruntime-web'],
    include: ['fabric', 'openseadragon'],
  },
  worker: { format: 'es' },
  server: {
    headers: isolation,
    fs: { allow: [path.resolve(HERE, '..', '..')] },
    watch: { ignored: ['**/results/**', '**/models/**', '**/.synth-cache/**'] },
  },
  preview: { headers: isolation },
  build: {
    target: 'esnext',
    rollupOptions: {
      input: {
        index: path.join(HERE, 'index.html'),
        models: path.join(HERE, 'bench-models.html'),
        e2e: path.join(HERE, 'e2e.html'),
      },
    },
  },
  logLevel: 'warn',
};
