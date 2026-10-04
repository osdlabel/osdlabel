import { defineConfig } from '@playwright/test';

// One above the Solid dev app's port, which `apps/dev` reads from `PORT`
// (default 5173), so the two suites never contend for a port even when run by
// hand side by side. `REACT_PORT` overrides. Turbo passes both variables
// through to `test:e2e` (`passThroughEnv` in turbo.json); a worktree running
// alongside another needs a `PORT` at least 2 away from the other's.
const PORT = process.env.REACT_PORT
  ? parseInt(process.env.REACT_PORT, 10)
  : (process.env.PORT ? parseInt(process.env.PORT, 10) : 5173) + 1;

export default defineConfig({
  // Every spec in `apps/dev` runs here too: both dev apps serve the same pages
  // with the same test ids and `window` hooks, so one spec covers both
  // bindings (#152). A spec that cannot apply to React would go in
  // `testIgnore`, with the reason beside it; today there is none.
  testDir: '../dev/tests/e2e',
  // Read by every spec (`tests/e2e/helpers/fixtures.ts`), which fails if the
  // page it drove is the other binding's (a server left running on this port,
  // say).
  metadata: { framework: 'react' },
  // CI keeps an HTML report for the workflow to upload; locally, just a list.
  reporter: process.env.CI ? [['dot'], ['html', { open: 'never' }]] : 'list',
  webServer: {
    command: `pnpm dev --port ${PORT} --strictPort`,
    port: PORT,
    reuseExistingServer: !process.env.CI,
  },
  use: {
    baseURL: `http://localhost:${PORT}`,
  },
});
