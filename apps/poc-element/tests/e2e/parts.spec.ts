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

/**
 * The two light-DOM stylesheet designs side by side, with the host rule at
 * specificity (0,2,0) (`.host-override [part~=…]`) or (0,1,0) (`[part~=…]`).
 * In `@layer osdlabel` any unlayered host rule wins; an unlayered class sheet
 * is beaten only by a more specific host rule, since the stock sheet is
 * adopted after the page's own sheets and wins the tie.
 */
const LIGHT_BINDINGS = ['solid', 'react', 'element-light'] as const;
const STOCK_LOOK = {
  rectBackground: 'rgb(51, 51, 51)',
  rectPadding: '4px',
  rectColor: 'rgb(255, 255, 255)',
  navigateBackground: 'rgb(33, 150, 243)',
};
const OVERRIDDEN = {
  rectBackground: 'rgb(0, 128, 0)',
  rectPadding: '20px',
  rectColor: 'rgb(255, 255, 0)',
  navigateBackground: 'rgb(128, 0, 128)',
};
const VARIANTS = [
  { stock: 'layer', selector: 'bare', expected: OVERRIDDEN },
  { stock: 'unlayered', selector: 'scoped', expected: OVERRIDDEN },
  { stock: 'unlayered', selector: 'bare', expected: STOCK_LOOK },
] as const;

for (const binding of LIGHT_BINDINGS) {
  for (const v of VARIANTS) {
    test(`${binding}: stock=${v.stock}, host selector=${v.selector}`, async ({ page }) => {
      await page.goto(
        `/parts.html?binding=${binding}&override=1&stock=${v.stock}&selector=${v.selector}`,
      );
      await waitInteractive(page);
      const rect = page.getByTestId('tool-rectangle');
      const observed = {
        rectBackground: await css(rect, 'background-color'),
        rectPadding: await css(rect, 'padding-top'),
        rectColor: await css(rect, 'color'),
        navigateBackground: await css(page.getByTestId('tool-navigate'), 'background-color'),
      };
      test.info().annotations.push({ type: 'observed', description: JSON.stringify(observed) });
      expect(observed).toEqual(v.expected);
    });
  }
}

/**
 * Under a strict `style-src 'self'` CSP, `<style>` elements and `style`
 * attributes are blocked; CSSOM inline styles and adopted constructed sheets
 * are not (scripts/csp-probe.mjs). The stock toolbar and the element's
 * `:host` styles use only the latter, so both still apply.
 */
const STRICT_CSP =
  "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; " +
  "connect-src 'self'; worker-src 'self' blob:";

/** Computed styles of every element under the annotator root, keyed by tree path. */
const annotatorStyleSignature = (page: Page) =>
  page.evaluate(() => {
    const PROPS = [
      'display',
      'position',
      'flex-direction',
      'background-color',
      'color',
      'padding-top',
      'font-size',
      'border-top-style',
      'width',
      'height',
    ];
    const find = (root: Document | ShadowRoot): Element | null => {
      const hit = root.querySelector('[data-testid="annotator-root"]');
      if (hit) return hit;
      for (const el of root.querySelectorAll('*')) {
        if (el.shadowRoot) {
          const inner = find(el.shadowRoot);
          if (inner) return inner;
        }
      }
      return null;
    };
    const out: Record<string, { readonly toolbar: boolean; readonly values: string }> = {};
    const walk = (el: Element, path: string, inToolbar: boolean): void => {
      const cs = getComputedStyle(el);
      const toolbar = inToolbar || (el.getAttribute('part') ?? '').split(' ').includes('toolbar');
      out[path] = { toolbar, values: PROPS.map((p) => cs.getPropertyValue(p)).join('|') };
      [...el.children].forEach((c, i) => walk(c, `${path}/${i}`, toolbar));
    };
    const root = find(document);
    if (root) walk(root, '0', false);
    return out;
  });

for (const binding of BINDINGS) {
  test(`${binding}: styled under a strict style-src CSP`, async ({ page }) => {
    // Reference: the same page without CSP.
    await page.goto(`/parts.html?binding=${binding}`);
    await waitInteractive(page);
    const reference = await annotatorStyleSignature(page);

    const violations: string[] = [];
    page.on('console', (m) => {
      if (m.text().includes('Content Security Policy')) violations.push(m.text());
    });
    await page.route('**/parts.html*', async (route) => {
      const response = await route.fetch();
      await route.fulfill({
        response,
        headers: { ...response.headers(), 'content-security-policy': STRICT_CSP },
      });
    });
    await page.goto(`/parts.html?binding=${binding}`);
    await waitInteractive(page);
    const rect = page.getByTestId('tool-rectangle');
    expect(await css(page.getByTestId('tool-navigate'), 'background-color')).toBe(
      'rgb(33, 150, 243)',
    );
    expect(await css(rect, 'padding-top')).toBe('4px');
    expect(await css(rect, 'border-top-left-radius')).toBe('4px');
    if (binding === 'element-shadow') {
      // :host{display:block} from the element's adopted host sheet.
      const display = await page.evaluate(
        () => getComputedStyle(document.querySelector('osdlabel-annotator')!).display,
      );
      expect(display).toBe('block');
    }

    // What the CSP changed elsewhere in the annotator: Solid compiles static
    // style objects into its templates' HTML `style` attributes, which the
    // CSP blocks; React sets every style through the CSSOM.
    const underCsp = await annotatorStyleSignature(page);
    const paths = Object.keys(reference);
    const differing = paths.filter((p) => underCsp[p]?.values !== reference[p]!.values);
    const toolbarDiffering = differing.filter((p) => reference[p]!.toolbar);
    test.info().annotations.push({
      type: 'csp effect',
      description: JSON.stringify({
        cspViolations: violations.length,
        elements: paths.length,
        elementsRestyledByCsp: differing.length,
        toolbarElementsRestyledByCsp: toolbarDiffering.length,
      }),
    });
    expect(toolbarDiffering).toEqual([]);
  });
}
