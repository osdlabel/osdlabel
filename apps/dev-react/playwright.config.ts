import { defineConfig } from '@playwright/test';

// One above the Solid dev app's port, which `apps/dev` reads from `PORT`
// (default 5173): `pnpm test:e2e` runs both apps' suites at once, so they must
// not share a port. `REACT_PORT` overrides. Turbo passes both variables through
// to `test:e2e` (`passThroughEnv` in turbo.json); a worktree running alongside
// another needs a `PORT` at least 2 away from the other's.
const PORT = process.env.REACT_PORT
  ? parseInt(process.env.REACT_PORT, 10)
  : (process.env.PORT ? parseInt(process.env.PORT, 10) : 5173) + 1;

export default defineConfig({
  // Specs shared with `apps/dev`: each drives a page both dev apps serve, with
  // the same test hooks, so one spec covers both bindings (#152).
  testDir: '../dev/tests/e2e',
  testMatch: ['viewer-cell-rebuild.spec.ts'],
  // Read by the shared specs, which fail if the page they reached is the other
  // binding's (a server left running on this port, say).
  metadata: { framework: 'react' },
  webServer: {
    command: `pnpm dev --port ${PORT} --strictPort`,
    port: PORT,
    reuseExistingServer: !process.env.CI,
  },
  use: {
    baseURL: `http://localhost:${PORT}`,
  },
});
