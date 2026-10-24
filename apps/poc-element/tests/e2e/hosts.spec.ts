import { test, expect } from '@playwright/test';
import { drawRectangle, hostEvents, rectangleCentre, waitInteractive } from './helpers.js';

/**
 * H1: the one custom element, consumed through each host framework's own
 * binding syntax. Each page renders the count from its framework's state, so
 * a pass means the event crossed the framework's event binding into its
 * reactive state, not merely that a raw listener fired.
 */
const ELEMENT_HOSTS = ['vanilla', 'vue', 'svelte', 'angular', 'react-host'] as const;
const FRAMEWORK_HOSTS = new Set<string>(['vue', 'svelte', 'angular', 'react-host']);
const ALL_HOSTS = [...ELEMENT_HOSTS, 'vanilla-se', 'solid'] as const;

for (const host of ALL_HOSTS) {
  test(`${host}: draw a rectangle and receive annotationschange`, async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(`/${host}.html`);
    await waitInteractive(page);

    await drawRectangle(page);

    await expect(page.getByTestId('host-annotation-count')).toHaveText('1');
    if (FRAMEWORK_HOSTS.has(host)) {
      await expect(page.getByTestId('fw-annotation-count')).toHaveText('1');
      await expect(page.getByTestId('fw-geometry')).toHaveText('rectangle');
    }
    const changes = (await hostEvents(page)).filter((e) => e.type === 'annotationschange');
    expect(changes.at(-1)?.geometryTypes).toEqual(['rectangle']);
    expect(errors).toEqual([]);
  });
}

for (const host of ELEMENT_HOSTS) {
  test(`${host}: selecting the rectangle fires selectedannotationchange`, async ({ page }) => {
    await page.goto(`/${host}.html`);
    await waitInteractive(page);
    await drawRectangle(page);
    await expect(page.getByTestId('host-annotation-count')).toHaveText('1');

    await page.getByTestId('tool-select').click();
    const c = await rectangleCentre(page);
    await page.mouse.click(c.x, c.y);

    await expect(page.getByTestId('host-selected')).not.toHaveText('none');
    if (FRAMEWORK_HOSTS.has(host)) {
      await expect(page.getByTestId('fw-selected')).not.toHaveText('none');
    }
  });
}

/** Objects with an annotation id on cell 0's Fabric canvas (testMode exposes the overlay). */
const canvasAnnotationCount = (page: import('@playwright/test').Page) =>
  page.evaluate(() => {
    const find = (root: Document | ShadowRoot): Element | null => {
      const hit = root.querySelector('.openseadragon-canvas');
      if (hit) return hit;
      for (const el of root.querySelectorAll('*')) {
        if (el.shadowRoot) {
          const inner = find(el.shadowRoot);
          if (inner) return inner;
        }
      }
      return null;
    };
    const c = find(document) as
      | (Element & { __osdOverlay?: { canvas: { getObjects(): { id?: string }[] } } })
      | null;
    return c?.__osdOverlay?.canvas.getObjects().filter((o) => o.id).length ?? -1;
  });

for (const host of ELEMENT_HOSTS) {
  test(`${host}: the host sets annotations as a property, with no echo event`, async ({ page }) => {
    await page.goto(`/${host}.html`);
    await waitInteractive(page);
    await page.getByTestId('host-load-sample').click();
    await expect(page.getByTestId('status-count')).toContainText('1');
    await expect.poll(() => canvasAnnotationCount(page)).toBe(1);
    // A property write is not a user change: like `input.value = x`, no event.
    expect((await hostEvents(page)).filter((e) => e.type === 'annotationschange')).toEqual([]);
  });
}

for (const host of FRAMEWORK_HOSTS) {
  test(`${host}: controlled binding round-trips without echo or rebuild`, async ({ page }) => {
    await page.goto(`/${host}.html`);
    await waitInteractive(page);
    await drawRectangle(page);
    await expect(page.getByTestId('fw-annotation-count')).toHaveText('1');
    await drawRectangle(page, 150);
    await expect(page.getByTestId('fw-annotation-count')).toHaveText('2');
    await page.waitForTimeout(300);
    const changes = (await hostEvents(page)).filter((e) => e.type === 'annotationschange');
    expect(changes.map((c) => c.count)).toEqual([1, 2]);
    expect(await canvasAnnotationCount(page)).toBe(2);
  });
}

test('solid-element: a bare boolean attribute does not reach the prop as true', async ({
  page,
}) => {
  // Records the component-register behaviour the vanilla-se host works around:
  // attribute values are JSON.parse'd, `JSON.parse('')` throws, and the raw ''
  // (falsy) is kept, so `<osdlabel-annotator-se test-mode>` is not test mode.
  await page.goto('/vanilla-se.html');
  await waitInteractive(page);
  const value = await page.evaluate(async () => {
    const el = document.createElement('osdlabel-annotator-se') as HTMLElement & {
      testMode?: unknown;
    };
    el.setAttribute('test-mode', '');
    document.body.append(el);
    // component-register initialises props after connect, not synchronously.
    await new Promise((resolve) => setTimeout(resolve, 50));
    const v = el.testMode;
    el.remove();
    return v === undefined ? 'undefined' : JSON.stringify(v);
  });
  // Whatever it is, it is not `true`; record what it actually is.
  test
    .info()
    .annotations.push({ type: 'solid-element testMode from bare attribute', description: value });
  expect(value).not.toBe('true');
});
