/**
 * Starts the PoC's Vite dev server and a Chromium, the way apps/bench does.
 *
 * Chromium: POC_CHROMIUM, else /opt/pw-browsers/chromium when present (the
 * sandbox's), else Playwright's own. On a desktop, point POC_CHROMIUM at a
 * real Chrome (e.g. "/Applications/Google Chrome.app/Contents/MacOS/Google
 * Chrome") and pass --headed to scripts/bench.mjs to see a GPU-backed run.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { chromium } from 'playwright';

export const APP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

export async function startServer(port) {
  const server = await createServer({
    configFile: path.join(APP_DIR, 'vite.config.mjs'),
    server: { port, strictPort: true, host: '127.0.0.1' },
    logLevel: 'warn',
  });
  await server.listen();
  return { server, origin: `http://127.0.0.1:${port}` };
}

export function chromiumPath() {
  if (process.env.POC_CHROMIUM) return process.env.POC_CHROMIUM;
  if (fs.existsSync('/opt/pw-browsers/chromium')) return '/opt/pw-browsers/chromium';
  return chromium.executablePath();
}

export async function launch({ headed = false } = {}) {
  return chromium.launch({
    executablePath: chromiumPath(),
    headless: !headed,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--enable-unsafe-webgpu'],
  });
}
