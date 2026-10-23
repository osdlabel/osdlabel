import path from 'node:path';
import { fileURLToPath } from 'node:url';
import solidPlugin from 'vite-plugin-solid';

/**
 * PoC harness server.
 *
 * Packages resolve through their `exports` to each package's built `dist/`
 * (run `pnpm exec turbo run build --filter="./packages/*"` first; the bench
 * script does). Nothing is fetched off-origin: every frame is synthesised in
 * the page.
 *
 * COOP/COEP make the page cross-origin isolated, which lifts Chromium's
 * performance.now() clamp to ~5 µs and enables SharedArrayBuffer and
 * performance.measureUserAgentSpecificMemory().
 */
const HERE = path.dirname(fileURLToPath(import.meta.url));

export default {
  root: HERE,
  plugins: [solidPlugin()],
  server: {
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
      'Cross-Origin-Resource-Policy': 'same-origin',
    },
    watch: { ignored: ['**/results/**'] },
    // OSD logs a warning per superseded tile; keep the bench output readable.
    forwardConsole: false,
  },
  build: {
    target: 'esnext',
    rollupOptions: {
      input: {
        main: path.join(HERE, 'index.html'),
        solid: path.join(HERE, 'solid.html'),
      },
    },
  },
  optimizeDeps: {
    include: ['fabric', 'openseadragon', 'solid-js', 'solid-js/web', 'solid-js/store'],
  },
  logLevel: 'warn',
};
