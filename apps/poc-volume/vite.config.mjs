import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * PoC dev server. Serves bench.html / mpr.html / niivue.html with the
 * cross-origin-isolation headers SharedArrayBuffer and fine-grained
 * performance.now() need. Everything is local: the volume is synthesized in
 * the page, nothing is fetched off-origin.
 */
const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');

export default {
  root: HERE,
  server: {
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
      'Cross-Origin-Resource-Policy': 'same-origin',
    },
    fs: { allow: [REPO] },
    watch: { ignored: ['**/results/**'] },
  },
  optimizeDeps: {
    include: ['fabric', 'openseadragon', '@niivue/niivue'],
  },
  worker: { format: 'es' },
  logLevel: 'warn',
};
