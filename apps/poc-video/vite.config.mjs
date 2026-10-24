import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Dev server for the video PoC pages. Cross-origin isolated (COOP + COEP) so
 * `performance.now()` has ~5 µs resolution and SharedArrayBuffer exists, and
 * served from http://localhost so WebCodecs is defined (it needs a secure
 * context). Workspace packages resolve to their built dist/.
 */
const HERE = path.dirname(fileURLToPath(import.meta.url));

export default {
  root: HERE,
  server: {
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
      'Cross-Origin-Resource-Policy': 'same-origin',
    },
    watch: { ignored: ['**/results/**', '**/media/**'] },
  },
  optimizeDeps: {
    include: ['fabric', 'openseadragon', 'mediabunny'],
  },
  build: {
    rollupOptions: {
      input: {
        seek: path.join(HERE, 'seek.html'),
        render: path.join(HERE, 'render.html'),
        tracks: path.join(HERE, 'tracks.html'),
        keyframes: path.join(HERE, 'keyframes.html'),
      },
    },
  },
  logLevel: 'warn',
};
