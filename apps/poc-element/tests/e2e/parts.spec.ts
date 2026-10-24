import { test, expect, type Locator, type Page } from '@playwright/test';
import { waitInteractive } from './helpers.js';

/**
 * Review finding 2: can a host restyle the stock toolbar through the public
 * hooks, overriding properties the stock UI sets itself (background,
 * padding, colour)? In light DOM the hooks are `[part~=…]` and the
 * `osdlabel-*` classes; in shadow DOM, `::part()`.
 *
 * `parts.html` loads an unlayered host stylesheet (see src/parts/main.ts).
 */
const BINDINGS = ['solid', 'react', 'element-light', 'element-shadow'] as const;

const css = (locator: Locator, prop: string) =>
  locator.evaluate((el, p) => getComputedStyle(el).getPropertyValue(p), prop);

interface StyleCounts {
  readonly addedHeadStyleNodes: number;
  readonly documentAdoptedSheets: number;
  readonly shadowAdoptedSheets: number | null;
  readonly shadowStyleNodes: number | null;
}

const styleCounts = (page: Page): Promise<StyleCounts> =>
  page.evaluate(() => {
    const lab = (
      window as unknown as {
        __parts: {
          addedHeadStyleNodes(): number;
          documentAdoptedSheets(): number;
          shadowAdoptedSheets(): number | null;
          shadowStyleNodes(): number | null;
        };
      }
    ).__parts;
    return {
      addedHeadStyleNodes: lab.addedHeadStyleNodes(),
      documentAdoptedSheets: lab.documentAdoptedSheets(),
      shadowAdoptedSheets: lab.shadowAdoptedSheets(),
      shadowStyleNodes: lab.shadowStyleNodes(),
    };
  });

for (const binding of BINDINGS) {
  test(`${binding}: without host CSS the stock look is unchanged`, async ({ page }) => {
    await page.goto(`/parts.html?binding=${binding}`);
    await waitInteractive(page);
    const navigate = page.getByTestId('tool-navigate');
    const rect = page.getByTestId('tool-rectangle');
    expect(await css(navigate, 'background-color')).toBe('rgb(33, 150, 243)');
    expect(await css(navigate, 'font-weight')).toBe('700');
    expect(await css(rect, 'background-color')).toBe('rgb(51, 51, 51)');
    expect(await css(rect, 'padding-top')).toBe('4px');
    expect(await css(rect, 'padding-left')).toBe('10px');
    expect(await css(rect, 'color')).toBe('rgb(255, 255, 255)');
    expect(await css(rect, 'border-top-left-radius')).toBe('4px');
    expect(await css(rect, 'border-top-style')).toBe('none');
    expect(await css(rect, 'font-size')).toBe('13px');
    expect(await css(rect, 'cursor')).toBe('pointer');
    test.info().annotations.push({
      type: 'style counts',
      description: JSON.stringify(await styleCounts(page)),
    });
  });

  test(`${binding}: host CSS overrides background, padding and colour through the public hooks`, async ({
    page,
  }) => {
    await page.goto(`/parts.html?binding=${binding}&override=1`);
    await waitInteractive(page);
    const navigate = page.getByTestId('tool-navigate');
    const rect = page.getByTestId('tool-rectangle');
    // Record what the cascade actually produced before asserting, so a failing
    // run still documents the values.
    const observed = {
      rectBackground: await css(rect, 'background-color'),
      rectPadding: await css(rect, 'padding-top'),
      rectColor: await css(rect, 'color'),
      navigateBackground: await css(navigate, 'background-color'),
    };
    test.info().annotations.push({ type: 'observed', description: JSON.stringify(observed) });
    expect(observed).toEqual({
      rectBackground: 'rgb(0, 128, 0)',
      rectPadding: '20px',
      rectColor: 'rgb(255, 255, 0)',
      navigateBackground: 'rgb(128, 0, 128)',
    });
    // The state hook follows the state.
    await rect.click();
    await expect(page.getByTestId('status-tool')).toContainText('Rectangle');
    expect(await css(rect, 'background-color')).toBe('rgb(128, 0, 128)');
    expect(await css(navigate, 'background-color')).toBe('rgb(0, 128, 0)');
  });
}
