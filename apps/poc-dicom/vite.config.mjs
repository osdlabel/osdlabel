import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import solidPlugin from 'vite-plugin-solid';
import { dicomServer } from './scripts/lib/dicom-server.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root: HERE,
  plugins: [solidPlugin(), dicomServer({ dataDir: path.join(HERE, 'data') })],
  server: {
    port: Number(process.env.PORT ?? 5400),
    strictPort: true,
    host: '127.0.0.1',
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
      'Cross-Origin-Resource-Policy': 'same-origin',
    },
    watch: { ignored: ['**/results/**', '**/data/**'] },
  },
  optimizeDeps: {
    // The codec's Emscripten glue is CommonJS; pre-bundle it for the worker.
    include: ['@cornerstonejs/codec-openjpeg/decodewasmjs'],
  },
  build: {
    target: 'esnext',
    rollupOptions: {
      input: {
        wsi: path.join(HERE, 'wsi.html'),
        annotate: path.join(HERE, 'annotate.html'),
      },
    },
  },
  worker: { format: 'es' },
});
