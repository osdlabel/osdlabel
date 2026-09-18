import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Bench dev-server config.
 *
 * `BENCH_ROOT` selects *which checkout's built packages* the bench page loads.
 * It defaults to this repository (resolved from this file's location), so a
 * plain `pnpm bench` measures the working checkout; `scripts/compare.mjs` sets
 * it to a `git worktree` of the base ref for the second server.
 *
 * Everything is resolved to absolute paths inside the selected checkout so the
 * two builds are never mixed. Nothing is fetched from the network.
 */
const HERE = path.dirname(fileURLToPath(import.meta.url));
/** The checkout this harness itself lives in (…/apps/bench -> repo root). */
export const HARNESS_REPO_ROOT = path.resolve(HERE, '..', '..');

const ROOT = path.resolve(process.env.BENCH_ROOT ?? HARNESS_REPO_ROOT);

/**
 * The sample image always comes from the *harness* checkout, never from
 * BENCH_ROOT, so both builds are fed byte-identical pixels. It is served
 * through Vite's `/@fs/` prefix, which `server.fs.allow` below permits. No
 * image is copied into apps/bench and nothing is fetched off-origin.
 */
const SAMPLE_IMAGE = path.join(HARNESS_REPO_ROOT, 'apps', 'dev', 'sample-data', 'landscape.png');

// `fabric` and `openseadragon` live in the pnpm-linked node_modules of the
// fabric-osd package inside the selected checkout.
const req = createRequire(path.join(ROOT, 'packages', 'fabric-osd', 'package.json'));
const osdEntry = req.resolve('openseadragon');
const fabricEntry = req.resolve('fabric');

export default {
  root: HERE,
  resolve: {
    alias: [
      { find: /^openseadragon$/, replacement: osdEntry },
      { find: /^fabric$/, replacement: fabricEntry },
      {
        find: /^@osdlabel\/fabric-osd$/,
        replacement: path.join(ROOT, 'packages', 'fabric-osd', 'dist', 'index.js'),
      },
    ],
  },
  define: {
    __BENCH_ROOT__: JSON.stringify(ROOT),
    __SAMPLE_IMAGE_URL__: JSON.stringify(`/@fs${SAMPLE_IMAGE}`),
  },
  optimizeDeps: {
    // Entries are absolute paths resolved by the aliases above, so there is
    // nothing for the bare-specifier scanner to pre-bundle.
    entries: [],
    include: [],
  },
  server: {
    // crossOriginIsolated lifts Chromium's 100µs clamp on performance.now()
    // down to ~5µs, which the per-call `_reposition` timings need.
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
      'Cross-Origin-Resource-Policy': 'same-origin',
    },
    fs: { allow: [ROOT, HARNESS_REPO_ROOT] },
    watch: { ignored: ['**/results/**', '**/.worktrees/**'] },
  },
  logLevel: 'warn',
};
