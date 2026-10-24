// Ad-hoc probe: open a page, print console + page errors and the probe state.
//   node scripts/debug-page.mjs <url> [waitMs]
/* global window */
import { chromium } from 'playwright';

const url = process.argv[2];
const waitMs = Number(process.argv[3] ?? 5000);
const browser = await chromium.launch({
  executablePath: process.env.POC_CHROMIUM ?? '/opt/pw-browsers/chromium',
});
try {
  const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
  page.on('console', (m) => console.log(`[console.${m.type()}]`, m.text()));
  page.on('pageerror', (e) => console.log('[pageerror]', e.message));
  await page.goto(url);
  await page.waitForTimeout(waitMs);
  const state = await page.evaluate(() => ({
    interactive: window.__interactive ?? null,
    marks: window.__marks ?? null,
    events: window.__hostEvents ?? [],
    isolated: window.crossOriginIsolated,
  }));
  console.log(JSON.stringify(state, null, 2));
} finally {
  await browser.close();
}
