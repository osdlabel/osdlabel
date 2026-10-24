import { createRequire } from 'node:module';
const require = createRequire(
  '/home/user/osdlabel/node_modules/.pnpm/playwright-core@1.60.0/node_modules/playwright-core/package.json',
);
const { chromium } = require('playwright-core');
const [, , url, flagsJson = '[]', timeoutMs = '120000'] = process.argv;
const args = JSON.parse(flagsJson);
const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1243/chrome-linux64/chrome',
  headless: true,
  args,
});
const page = await browser.newPage();
const logs = [];
page.on('console', (m) => logs.push(m.type() + ': ' + m.text()));
await page.goto(url);
await page.waitForFunction(() => window.__results, null, { timeout: Number(timeoutMs) });
const res = await page.evaluate(() => window.__results);
if (process.env.SHOT) await page.screenshot({ path: process.env.SHOT, fullPage: true });
console.log(
  JSON.stringify(
    {
      version: browser.version(),
      args,
      res,
      warnings: logs.filter((l) => /WARNING|lost|error/i.test(l)).slice(0, 5),
    },
    null,
    1,
  ),
);
await browser.close();
