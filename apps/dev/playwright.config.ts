import { defineConfig } from '@playwright/test';

const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 5173;

export default defineConfig({
  testDir: './tests/e2e',
  // Read by specs shared with `apps/dev-react` (#152), which fail if the page
  // they reached is the other binding's.
  metadata: { framework: 'solid' },
  webServer: {
    // Fail rather than drift to another port, which the React suite may hold.
    command: `pnpm dev --port ${PORT} --strictPort`,
    port: PORT,
    reuseExistingServer: !process.env.CI,
  },
  use: {
    baseURL: `http://localhost:${PORT}`,
  },
});
