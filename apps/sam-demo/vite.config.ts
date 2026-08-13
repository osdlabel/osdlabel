import { defineConfig, type PluginOption } from 'vite';
import solidPlugin from 'vite-plugin-solid';
import { resolve, dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
// The encoder middleware is plain ESM JS (no heavy imports at module top); it
// lazily imports `onnxruntime-web` + `sharp` only when a request arrives, so
// `vite build` (which evaluates this config) never loads them.
import { createSamEncoderMiddleware } from './server/sam-encoder.mjs';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 5175;

// `@osdlabel/segmentation-onnx` dynamically imports the bare specifier
// `onnxruntime-web` (it declares no ORT dependency by design). Node resolution
// would pick the Node build and, under pnpm isolation, the bundler can't resolve
// it from the library's dist at all. Alias the bare specifier to the BROWSER ESM
// bundle (all execution providers) so the client graph resolves correctly. The
// Node-side encoder middleware is unaffected — it resolves via Node, not Vite.
const ortBrowserBundle = join(
  dirname(createRequire(import.meta.url).resolve('onnxruntime-web')),
  'ort.all.bundle.min.mjs',
);

/**
 * Runs the MobileSAM image encoder in the Vite dev process and serves embeddings
 * at POST /api/sam/embed — the server half of the server-encode → client-decode
 * topology, in a single `pnpm dev` command.
 */
function samEncoderPlugin(): PluginOption {
  return {
    name: 'sam-encoder',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use(
        createSamEncoderMiddleware({ publicDir: resolve(__dirname, 'public') }),
      );
    },
  };
}

export default defineConfig({
  server: {
    port: PORT,
    // Cross-origin isolation enables the threaded ONNX Runtime WASM backend
    // (SharedArrayBuffer). The demo loads only same-origin assets, so
    // `require-corp` won't block anything.
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    },
  },
  plugins: [solidPlugin(), samEncoderPlugin()],
  build: { target: 'esnext' },
  resolve: {
    alias: {
      // Resolve the library from source for instant HMR (mirrors apps/dev).
      osdlabel: resolve(__dirname, '../../packages/osdlabel/src/index.ts'),
      'onnxruntime-web': ortBrowserBundle,
    },
  },
});
