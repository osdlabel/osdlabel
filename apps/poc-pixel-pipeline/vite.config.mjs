import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..');

/**
 * Dev server for the pixel-pipeline harness. Cross-origin isolation (COOP +
 * COEP) gives SharedArrayBuffer (worker-pool variant) and a 5 µs
 * performance.now(). Workspace packages resolve through their package.json
 * `exports` to `dist/`, so the harness measures built code, as apps/bench does.
 */
export default {
  root: HERE,
  define: {
    // grid.html opens apps/dev's committed DZI sample through /@fs/.
    __REPO_ROOT__: JSON.stringify(REPO_ROOT),
  },
  optimizeDeps: {
    include: ['openseadragon', 'openseadragon6', 'fabric'],
  },
  server: {
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
      'Cross-Origin-Resource-Policy': 'same-origin',
    },
    // No HMR socket: the harness is driven, not edited live, and the client
    // would otherwise echo every page error into the bench log.
    hmr: false,
    fs: { allow: [REPO_ROOT] },
    watch: { ignored: ['**/results/**'] },
  },
  logLevel: 'warn',
};
