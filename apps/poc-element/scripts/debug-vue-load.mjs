// Ad-hoc probe for the Vue "load sample" path: console, errors, element state.
//   node scripts/debug-vue-load.mjs <base-url>
/* global window, document */
import { chromium } from 'playwright';

const base = process.argv[2] ?? 'http://localhost:5470';
const browser = await chromium.launch({
  executablePath: process.env.POC_CHROMIUM ?? '/opt/pw-browsers/chromium',
});
try {
  const page = await browser.newPage();
  page.on('console', (m) => {
    if (m.type() === 'error' || m.type() === 'warning') console.log(`[${m.type()}]`, m.text());
  });
  page.on('pageerror', (e) => console.log('[pageerror]', e.message));
  await page.goto(`${base}/vue.html`);
  await page.waitForFunction(() => window.__interactive, null, { timeout: 30000 });
  await page.getByTestId('host-load-sample').click();
  await page.waitForTimeout(1000);
  console.log(
    JSON.stringify(
      await page.evaluate(() => {
        const el = document.querySelector('osdlabel-annotator');
        const list = el.annotations;
        return {
          elementAnnotations: list.length,
          statusCount: el.shadowRoot.querySelector('[data-testid="status-count"]')?.textContent,
          own: Object.prototype.hasOwnProperty.call(el, 'annotations'),
        };
      }),
    ),
  );
} finally {
  await browser.close();
}
