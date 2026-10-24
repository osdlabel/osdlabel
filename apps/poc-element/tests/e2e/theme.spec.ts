import { test, expect, type Locator } from '@playwright/test';
import { drawRectangle, waitInteractive } from './helpers.js';

/** H3 on the element: tokens cross the shadow boundary, parts are styleable, the slot replaces the toolbar. */

const css = (locator: Locator, prop: string) =>
  locator.evaluate((el, p) => getComputedStyle(el).getPropertyValue(p), prop);

test('unthemed: the token fallbacks reproduce the stock look', async ({ page }) => {
  await page.goto('/theme.html');
  await waitInteractive(page);
  const navigate = page.getByTestId('tool-navigate');
  expect(await css(navigate, 'background-color')).toBe('rgb(33, 150, 243)');
  expect(await css(navigate, 'border-top-left-radius')).toBe('4px');
  expect(await css(navigate, 'font-size')).toBe('13px');
});

test('tokens set on the host restyle the stock toolbar inside the shadow root', async ({
  page,
}) => {
  await page.goto('/theme.html?theme=1');
  await waitInteractive(page);
  const navigate = page.getByTestId('tool-navigate');
  const rect = page.getByTestId('tool-rectangle');
  expect(await css(navigate, 'background-color')).toBe('rgb(233, 30, 99)');
  expect(await css(navigate, 'border-top-left-radius')).toBe('0px');
  expect(await css(navigate, 'font-size')).toBe('15px');
  expect(await css(rect, 'background-color')).toBe('rgb(224, 224, 224)');
  expect(await css(page.getByTestId('annotator-root'), 'background-color')).toBe(
    'rgb(245, 245, 245)',
  );
});

test('::part() reaches the active-state part and only it', async ({ page }) => {
  await page.goto('/theme.html?theme=1');
  await waitInteractive(page);
  const navigate = page.getByTestId('tool-navigate');
  const rect = page.getByTestId('tool-rectangle');
  expect(await css(navigate, 'outline-color')).toBe('rgb(0, 128, 0)');
  expect(await css(rect, 'outline-style')).toBe('none');
  await rect.click();
  // The state part moves with the state.
  expect(await css(rect, 'outline-color')).toBe('rgb(0, 128, 0)');
  expect(await css(navigate, 'outline-style')).toBe('none');
  expect(await css(page.locator('[part="status-bar"]'), 'letter-spacing')).toBe('1px');
});

test('slot="toolbar": a host toolbar replaces the stock one and drives the annotator', async ({
  page,
}) => {
  await page.goto('/theme.html?override=1');
  await waitInteractive(page);
  // The stock toolbar is the slot's fallback content: in the tree, not rendered.
  await expect(page.getByTestId('tool-navigate')).toBeHidden();
  await expect(page.getByTestId('host-toolbar')).toBeVisible();
  await expect(page.getByTestId('host-tool-navigate')).toHaveText('[Navigate]');

  await page.getByTestId('host-tool-rectangle').click();
  await expect(page.getByTestId('host-tool-rectangle')).toHaveAttribute('data-active', 'true');
  await expect(page.getByTestId('status-tool')).toContainText('Rectangle');

  // Drawing through the slotted toolbar's selection: drawRectangle clicks the
  // stock button first, which is hidden, so select via the host and drag.
  const canvas = page.locator('canvas.upper-canvas').first();
  const box = (await canvas.boundingBox())!;
  await page.mouse.move(box.x + box.width * 0.3, box.y + box.height * 0.3);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.3 + 120, box.y + box.height * 0.3 + 80, {
    steps: 6,
  });
  await page.mouse.up();
  await expect(page.getByTestId('host-annotation-count')).toHaveText('1');
  await expect(page.getByTestId('host-tool-rectangle')).toHaveText('[Rect 1]');
});

test('the shadow root has a named <slot> for every shared slot name', async ({ page }) => {
  await page.goto('/theme.html');
  await waitInteractive(page);
  const { names, rendered } = await page.evaluate(() => {
    const el = document.querySelector('osdlabel-annotator')!;
    const names = (window as unknown as { __slotNames: readonly string[] }).__slotNames;
    const rendered = [...el.shadowRoot!.querySelectorAll('slot[name]')].map((s) =>
      s.getAttribute('name'),
    );
    return { names, rendered };
  });
  expect(names.length).toBeGreaterThan(0);
  for (const name of names) expect(rendered).toContain(name);
});

test('without an override, drawing still uses the stock toolbar', async ({ page }) => {
  await page.goto('/theme.html?theme=1');
  await waitInteractive(page);
  await drawRectangle(page);
  await expect(page.getByTestId('host-annotation-count')).toHaveText('1');
});
