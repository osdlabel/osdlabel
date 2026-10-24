import { test, expect, type Page } from '@playwright/test';
import {
  drawRectangle,
  hostEvents,
  rectangleCentre,
  upperCanvas,
  waitInteractive,
} from './helpers.js';

/**
 * H2: does OSD + Fabric + the Solid binding work inside a shadow root? Every
 * check runs against the same element in shadow-DOM and light-DOM mode
 * (`lab.html?mode=…`), so a shadow-only failure is attributable to the shadow
 * boundary and nothing else.
 */
const MODES = ['shadow', 'light'] as const;

async function openLab(page: Page, mode: string, css = 'none'): Promise<void> {
  await page.goto(`/lab.html?mode=${mode}&css=${css}`);
  await waitInteractive(page);
}

/** The annotator's active element, looking through the shadow root when there is one. */
function deepActiveElementInfo(page: Page) {
  return page.evaluate(() => {
    let el: Element | null = document.activeElement;
    while (el?.shadowRoot?.activeElement) el = el.shadowRoot.activeElement;
    return el ? { tag: el.tagName.toLowerCase(), className: String(el.className) } : null;
  });
}

for (const mode of MODES) {
  test.describe(`${mode} DOM`, () => {
    test('pointer: a dragged rectangle is created', async ({ page }) => {
      await openLab(page, mode);
      await drawRectangle(page);
      await expect(page.getByTestId('host-annotation-count')).toHaveText('1');
    });

    test('pointer: polyline finished by double click (overlay dblclick detection)', async ({
      page,
    }) => {
      await openLab(page, mode);
      await page.getByTestId('tool-polyline').click();
      const box = (await upperCanvas(page).boundingBox())!;
      const pts = [
        [0.3, 0.3],
        [0.5, 0.35],
        [0.45, 0.55],
      ] as const;
      for (const [fx, fy] of pts) {
        await page.mouse.click(box.x + box.width * fx, box.y + box.height * fy);
        await page.waitForTimeout(350); // beyond the double-click window
      }
      await page.mouse.dblclick(box.x + box.width * 0.35, box.y + box.height * 0.6);
      await expect(page.getByTestId('host-annotation-count')).toHaveText('1');
      const last = (await hostEvents(page)).filter((e) => e.type === 'annotationschange').at(-1);
      expect(last?.geometryTypes).toEqual(['polyline']);
    });

    test('keyboard: a shortcut works after clicking the cell', async ({ page }) => {
      await openLab(page, mode);
      const c = await rectangleCentre(page);
      await page.mouse.click(c.x, c.y);
      await page.keyboard.press('r');
      await expect(page.getByTestId('status-tool')).toContainText('Rectangle');
    });

    test('keyboard: typing in a text field inside the annotator does not trigger shortcuts', async ({
      page,
    }) => {
      await openLab(page, mode);
      // A text field rendered inside the annotator, as a DOM decoration or a
      // custom toolbar override would render one.
      await page.evaluate(() => {
        const lab = (window as unknown as { __lab: { el: { renderRoot: ParentNode } } }).__lab;
        const input = document.createElement('input');
        input.dataset['testid'] = 'inner-input';
        lab.el.renderRoot.querySelector('[data-testid="annotator-root"]')!.prepend(input);
      });
      await page.getByTestId('inner-input').click();
      await page.keyboard.type('r');
      await expect(page.getByTestId('inner-input')).toHaveValue('r');
      await expect(page.getByTestId('status-tool')).toContainText('Navigate');
    });

    test('focus: a press on the canvas focuses the OSD canvas', async ({ page }) => {
      await openLab(page, mode);
      await page.getByTestId('tool-rectangle').focus();
      await drawRectangle(page);
      const info = await deepActiveElementInfo(page);
      expect(info?.className).toContain('openseadragon-canvas');
    });

    test('fullscreen: the toggle targets the annotator root and reports its state', async ({
      page,
    }) => {
      await openLab(page, mode);
      const button = page.getByTestId('view-fullscreen');
      await expect(button).toHaveAttribute('aria-pressed', 'false');
      await button.click();
      await expect(button).toHaveAttribute('aria-pressed', 'true');
      const state = await page.evaluate(() => {
        const host = document.fullscreenElement;
        const inner = host?.shadowRoot?.fullscreenElement ?? host;
        const r = inner?.getBoundingClientRect();
        return {
          documentFullscreenTag: host?.tagName.toLowerCase() ?? null,
          innerTestId: (inner as HTMLElement | null | undefined)?.dataset['testid'] ?? null,
          width: r?.width ?? 0,
          viewportWidth: window.innerWidth,
        };
      });
      expect(state.innerTestId).toBe('annotator-root');
      expect(Math.round(state.width)).toBe(state.viewportWidth);
      await button.click();
      await expect(button).toHaveAttribute('aria-pressed', 'false');
    });

    test('decorations: the measurement label sits on the drawn rectangle', async ({ page }) => {
      await openLab(page, mode);
      await drawRectangle(page);
      await expect(page.getByTestId('host-annotation-count')).toHaveText('1');
      const c = await rectangleCentre(page);
      const label = page.locator('[data-osdlabel="decoration-text"]').first();
      await expect(label).toBeVisible();
      const box = (await label.boundingBox())!;
      // Anchored to the rectangle: within its 120x80 px screen extent (+ margin).
      expect(Math.abs(box.x + box.width / 2 - c.x)).toBeLessThan(120);
      expect(Math.abs(box.y + box.height / 2 - c.y)).toBeLessThan(100);
    });

    test('popover: the grid selector opens and applies a layout', async ({ page }) => {
      await openLab(page, mode);
      await page.getByTestId('grid-selector-trigger').click();
      const popover = page.getByTestId('grid-selector-popover');
      await expect(popover).toBeVisible();
      await page.getByTestId('grid-cell-2-1').click();
      await expect(page.getByTestId('grid-size')).toHaveText('2x1');
      await expect(page.getByTestId('grid-cell-1')).toBeVisible();
    });

    test('focus: clearing a filmstrip cell from the keyboard hands focus to the thumbnail (#189)', async ({
      page,
    }) => {
      await openLab(page, mode);
      const clear = page.getByTestId('filmstrip-clear-landscape');
      await clear.focus();
      await page.keyboard.press('Enter');
      await expect(page.getByTestId('cell-placeholder-0')).toBeVisible();
      await expect(page.getByTestId('filmstrip-thumb-landscape')).toBeFocused();
    });

    test('CSS: the element adds nothing to document.head', async ({ page }) => {
      await openLab(page, mode);
      const counts = await page.evaluate(() => {
        const lab = (
          window as unknown as {
            __lab: { headNodesBefore: number; headNodesAfter: () => number };
          }
        ).__lab;
        return { before: lab.headNodesBefore, after: lab.headNodesAfter() };
      });
      expect(counts.after).toBe(counts.before);
    });
  });
}
