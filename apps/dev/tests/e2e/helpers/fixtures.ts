import { test as base, expect, type Page } from '@playwright/test';

/**
 * The `test` every spec imports, in place of `@playwright/test`'s (lint
 * enforces it). Specs here run against both dev apps — `apps/dev` (SolidJS) and
 * `apps/dev-react` — and each app's pages declare their binding on
 * `<html data-framework>`. This auto fixture checks, after every test, that
 * each page the test drove came from the binding its Playwright config names
 * in `metadata.framework`. Without it, a config pointed at the wrong dev
 * server would pass by testing the other binding (#152).
 */
const UNRESPONSIVE = Symbol('unresponsive');

/**
 * The page's `data-framework`, or `UNRESPONSIVE` if it does not answer within
 * 5s. A crashed or wedged page never answers `evaluate`, which would otherwise
 * hang teardown until the test timeout and bury the real failure.
 */
function frameworkOf(page: Page): Promise<string | undefined | typeof UNRESPONSIVE> {
  const answer = page.evaluate(() => document.documentElement.dataset['framework']);
  // The losing evaluate rejects once the context closes; nothing awaits it.
  answer.catch(() => {});
  return Promise.race([
    answer,
    new Promise<typeof UNRESPONSIVE>((resolve) => setTimeout(() => resolve(UNRESPONSIVE), 5000)),
  ]);
}

export const test = base.extend<{ frameworkGuard: undefined }>({
  frameworkGuard: [
    async ({ page }, use, testInfo) => {
      await use(undefined);

      const expected: unknown = testInfo.config.metadata['framework'];
      expect(expected, 'the Playwright config must set metadata.framework').toEqual(
        expect.any(String),
      );
      // Every page in the test's context, not just the default one, so a spec
      // that opens a second page is checked too. A page still on about:blank
      // tested neither binding.
      for (const p of page.context().pages()) {
        if (p.isClosed() || p.url() === 'about:blank') continue;
        const actual = await frameworkOf(p);
        expect(actual, `${p.url()} did not answer; did it crash?`).not.toBe(UNRESPONSIVE);
        expect(actual, `${p.url()} must come from the ${String(expected)} dev app`).toBe(expected);
      }
    },
    { auto: true },
  ],
});

export { expect };
