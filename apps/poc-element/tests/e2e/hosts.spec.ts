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
