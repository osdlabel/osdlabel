import type { Locator, Page } from '@playwright/test';
import { test, expect } from './helpers/fixtures.js';

/**
 * The grid popover opens rightward from its button, so a button near a right
 * edge clipped it (#147). It now flips to open leftward when rightward would
 * be clipped — by a host container that hides overflow, or by the viewport.
 *
 * Driven through `grid-controls.html`, which mounts `<GridControls>` in a
 * fixed-width slot whose alignment and clipping the query string chooses.
 */

const boxOf = async (locator: Locator) => {
  const box = await locator.boundingBox();
  if (!box) throw new Error('element has no layout box');
  return box;
};

const open = async (page: Page, query: string) => {
  await page.goto(`/grid-controls.html?${query}`);
  await page.getByTestId('grid-selector-trigger').click();
  const popover = page.getByTestId('grid-selector-popover');
  await expect(popover).toBeVisible();
  return popover;
};

/** Every grid cell's box lies inside [left, right]. */
const expectCellsWithin = async (page: Page, left: number, right: number) => {
  const cells = page.locator('[data-testid^="grid-cell-"]');
  const count = await cells.count();
  // 6 columns x 4 rows in the harness.
  expect(count).toBe(24);
  for (let i = 0; i < count; i++) {
    const box = await boxOf(cells.nth(i));
    expect(box.x).toBeGreaterThanOrEqual(left);
    expect(box.x + box.width).toBeLessThanOrEqual(right);
  }
};

test('opens rightward when there is room', async ({ page }) => {
  const popover = await open(page, 'align=start');
  await expect(popover).toHaveAttribute('data-alignment', 'start');

  const trigger = await boxOf(page.getByTestId('grid-selector-trigger'));
  const box = await boxOf(popover);
  expect(Math.abs(box.x - trigger.x)).toBeLessThanOrEqual(1);
});

test('flips leftward at the right edge of a clipping container', async ({ page }) => {
  const popover = await open(page, 'align=end&clip=slot');
  await expect(popover).toHaveAttribute('data-alignment', 'end');

  const slot = await boxOf(page.getByTestId('grid-host-slot'));
  const trigger = await boxOf(page.getByTestId('grid-selector-trigger'));
  const box = await boxOf(popover);
  // Right edges line up, and the whole popover is inside the slot.
  expect(Math.abs(box.x + box.width - (trigger.x + trigger.width))).toBeLessThanOrEqual(1);
  expect(box.x).toBeGreaterThanOrEqual(slot.x);
  expect(box.x + box.width).toBeLessThanOrEqual(slot.x + slot.width);
  await expectCellsWithin(page, slot.x, slot.x + slot.width);

  // And it is usable: the leftmost column, the part that used to be clipped
  // furthest from the button, takes a click.
  await page.getByTestId('grid-cell-1-2').click();
  await expect(page.getByTestId('grid-size')).toHaveText('1x2');
});

test('flips leftward at the right edge of the viewport', async ({ page }) => {
  // No clipping container: the slot sits against the window's right edge.
  const popover = await open(page, 'align=end&clip=viewport');
  await expect(popover).toHaveAttribute('data-alignment', 'end');

  const viewportWidth = await page.evaluate(() => document.documentElement.clientWidth);
  const box = await boxOf(popover);
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(viewportWidth);
  await expectCellsWithin(page, 0, viewportWidth);
});

test('re-decides on every open', async ({ page }) => {
  // The alignment is measured each time the popover opens, not once: move the
  // button from the slot's right edge to its left between opens, and the
  // popover follows.
  const popover = await open(page, 'align=end&clip=slot');
  await expect(popover).toHaveAttribute('data-alignment', 'end');
  await page.getByTestId('grid-selector-trigger').click();
  await expect(popover).toHaveCount(0);

  await page
    .getByTestId('grid-host-slot')
    .evaluate((el) => ((el as HTMLElement).style.justifyContent = 'flex-start'));
  await page.getByTestId('grid-selector-trigger').click();
  await expect(page.getByTestId('grid-selector-popover')).toHaveAttribute(
    'data-alignment',
    'start',
  );
});

test.describe('only elements that really clip the popover count', () => {
  // Each case wraps the control in something with hidden overflow that does
  // NOT clip it, with room to open rightward. A walk over plain ancestors
  // would see the hidden overflow and flip leftward for nothing.

  test('a fixed-position box escapes a clipping ancestor', async ({ page }) => {
    await page.goto('/grid-controls.html?align=start&clip=viewport');
    await page.getByTestId('grid-host-slot').evaluate((slot) => {
      const outer = slot.parentElement as HTMLElement;
      outer.style.overflow = 'hidden';
      outer.style.width = '200px';
      Object.assign((slot as HTMLElement).style, { position: 'fixed', left: '600px', top: '40px' });
    });
    await page.getByTestId('grid-selector-trigger').click();
    await expect(page.getByTestId('grid-selector-popover')).toHaveAttribute(
      'data-alignment',
      'start',
    );
  });

  test('an absolutely positioned box escapes a static clipping ancestor', async ({ page }) => {
    await page.goto('/grid-controls.html?align=start&clip=viewport');
    await page.getByTestId('grid-host-slot').evaluate((slot) => {
      const outer = slot.parentElement as HTMLElement;
      // Static and clipping, so not the slot's containing block.
      outer.style.overflow = 'hidden';
      outer.style.width = '200px';
      Object.assign((slot as HTMLElement).style, {
        position: 'absolute',
        left: '600px',
        top: '40px',
      });
    });
    await page.getByTestId('grid-selector-trigger').click();
    await expect(page.getByTestId('grid-selector-popover')).toHaveAttribute(
      'data-alignment',
      'start',
    );
  });

  test('a body whose overflow goes to the viewport does not clip', async ({ page }) => {
    // With the root's overflow visible, the body's overflow-x applies to the
    // viewport instead; the body box itself clips nothing.
    await page.goto('/grid-controls.html?align=end&clip=viewport');
    await page.evaluate(() => {
      document.body.style.overflowX = 'hidden';
      document.body.style.width = 'calc(100vw - 200px)';
    });
    await page.getByTestId('grid-selector-trigger').click();
    await expect(page.getByTestId('grid-selector-popover')).toHaveAttribute(
      'data-alignment',
      'start',
    );
  });
});

test('the stock Annotator still opens it rightward', async ({ page }) => {
  // The button sits next to the tools at the bar's left, so nothing changes
  // for the common layout.
  await page.goto('/annotator.html?width=900');
  await page.getByTestId('grid-selector-trigger').click();
  await expect(page.getByTestId('grid-selector-popover')).toHaveAttribute(
    'data-alignment',
    'start',
  );
});

/**
 * `getHorizontalClipBounds` against DOM fixtures, called directly. Each
 * fixture builds a clipping box `clip` (240px wide, at x = 40) and an anchor
 * somewhere inside it, then compares the helper's bounds with what really
 * clips the anchor's popover. Built in the page so the browser's own layout
 * and computed styles are what the helper reads.
 */
test.describe('getHorizontalClipBounds', () => {
  type Bounds = { left: number; right: number };

  const boundsFor = (page: Page, build: string): Promise<{ bounds: Bounds; clip: Bounds }> =>
    page.evaluate((build) => {
      const stage = document.createElement('div');
      stage.id = 'stage';
      stage.style.cssText = 'position: relative; margin-left: 40px; margin-top: 300px;';
      document.body.append(stage);
      // `build` populates `stage` and returns [anchor, clipping element].
      const [anchor, clip] = new Function('stage', build)(stage) as [Element, Element];
      const api = (
        window as unknown as {
          __popoverPlacement: { getHorizontalClipBounds: (el: Element) => Bounds };
        }
      ).__popoverPlacement;
      const rect = clip.getBoundingClientRect();
      return {
        bounds: api.getHorizontalClipBounds(anchor),
        clip: {
          left: rect.left + clip.clientLeft,
          right: rect.left + clip.clientLeft + clip.clientWidth,
        },
      };
    }, build);

  const viewportBounds = (page: Page) =>
    page.evaluate(() => ({ left: 0, right: document.documentElement.clientWidth }));

  test.beforeEach(async ({ page }) => {
    await page.goto('/grid-controls.html');
  });

  test('follows a shadow tree out to a clipping shadow host', async ({ page }) => {
    const { bounds, clip } = await boundsFor(
      page,
      `const host = document.createElement('div');
       host.style.cssText = 'overflow: hidden; width: 240px;';
       stage.append(host);
       const root = host.attachShadow({ mode: 'open' });
       const anchor = document.createElement('div');
       anchor.style.cssText = 'position: relative; width: 60px;';
       root.append(anchor);
       return [anchor, host];`,
    );
    expect(bounds).toEqual(clip);
  });

  test('sees the shadow-tree wrapper around slotted content', async ({ page }) => {
    const { bounds, clip } = await boundsFor(
      page,
      `const host = document.createElement('div');
       stage.append(host);
       const root = host.attachShadow({ mode: 'open' });
       const wrapper = document.createElement('div');
       wrapper.style.cssText = 'overflow: hidden; width: 240px;';
       wrapper.append(document.createElement('slot'));
       root.append(wrapper);
       const anchor = document.createElement('div');
       anchor.style.cssText = 'position: relative; width: 60px;';
       host.append(anchor);
       return [anchor, wrapper];`,
    );
    expect(bounds).toEqual(clip);
  });

  test('counts a transformed clipping ancestor that contains an absolute box', async ({ page }) => {
    // Static but transformed: the containing block of the absolute slot, so
    // its overflow clips it.
    const { bounds, clip } = await boundsFor(
      page,
      `const outer = document.createElement('div');
       outer.style.cssText = 'transform: translateX(0); overflow: hidden; width: 240px; height: 80px;';
       const slot = document.createElement('div');
       slot.style.cssText = 'position: absolute; left: 150px; top: 0;';
       const anchor = document.createElement('div');
       anchor.style.cssText = 'position: relative; width: 60px;';
       slot.append(anchor); outer.append(slot); stage.append(outer);
       return [anchor, outer];`,
    );
    expect(bounds).toEqual(clip);
  });

  test('counts a transformed clipping ancestor that contains a fixed box', async ({ page }) => {
    const { bounds, clip } = await boundsFor(
      page,
      `const outer = document.createElement('div');
       outer.style.cssText = 'transform: translateX(0); overflow: hidden; width: 240px; height: 80px;';
       const slot = document.createElement('div');
       slot.style.cssText = 'position: fixed; left: 150px; top: 0;';
       const anchor = document.createElement('div');
       anchor.style.cssText = 'position: relative; width: 60px;';
       slot.append(anchor); outer.append(slot); stage.append(outer);
       return [anchor, outer];`,
    );
    expect(bounds).toEqual(clip);
  });

  // A fixed slot inside `outer { <style>; overflow: hidden }`: when the style
  // makes `outer` its containing block, `outer` clips it. Each of these is one
  // Chromium treats as a containing block for fixed (and absolute) boxes.
  for (const style of [
    'translate: 0px',
    'rotate: 0deg',
    'scale: 1',
    'transform-style: preserve-3d',
    'content-visibility: auto',
    'will-change: contain',
    'will-change: offset-path',
    'will-change: offset-position',
  ]) {
    test(`counts \`${style}\` as a containing block for a fixed box`, async ({ page }) => {
      const { bounds, clip } = await boundsFor(
        page,
        `const outer = document.createElement('div');
         outer.style.cssText = '${style}; overflow: hidden; width: 240px; height: 80px;';
         const slot = document.createElement('div');
         slot.style.cssText = 'position: fixed; left: 150px; top: 0;';
         const anchor = document.createElement('div');
         anchor.style.cssText = 'position: relative; width: 60px;';
         slot.append(anchor); outer.append(slot); stage.append(outer);
         return [anchor, outer];`,
      );
      expect(bounds).toEqual(clip);
    });
  }

  test('does not count a container query container as a containing block', async ({ page }) => {
    // `container-type` establishes no containing block, so the fixed slot
    // escapes the clipping container entirely.
    const { bounds } = await boundsFor(
      page,
      `const outer = document.createElement('div');
       outer.style.cssText = 'container-type: inline-size; overflow: hidden; width: 240px; height: 80px;';
       const slot = document.createElement('div');
       slot.style.cssText = 'position: fixed; left: 150px; top: 0;';
       const anchor = document.createElement('div');
       anchor.style.cssText = 'position: relative; width: 60px;';
       slot.append(anchor); outer.append(slot); stage.append(outer);
       return [anchor, outer];`,
    );
    expect(bounds).toEqual(await viewportBounds(page));
  });

  test('counts will-change: position for an absolute box but not a fixed one', async ({ page }) => {
    const build = (position: string) =>
      `const outer = document.createElement('div');
       outer.style.cssText = 'will-change: position; overflow: hidden; width: 240px; height: 80px;';
       const slot = document.createElement('div');
       slot.style.cssText = 'position: ${position}; left: 150px; top: 0;';
       const anchor = document.createElement('div');
       anchor.style.cssText = 'position: relative; width: 60px;';
       slot.append(anchor); outer.append(slot); stage.append(outer);
       return [anchor, outer];`;
    const absolute = await boundsFor(page, build('absolute'));
    expect(absolute.bounds).toEqual(absolute.clip);
    const fixed = await boundsFor(page, build('fixed'));
    expect(fixed.bounds).toEqual(await viewportBounds(page));
  });

  // Only exact `will-change` tokens count: these merely contain the name of
  // one (`position`, `transform`, `perspective`) and establish nothing, so an
  // absolute slot escapes the scroller they sit on.
  for (const value of ['scroll-position', 'transform-origin', 'perspective-origin']) {
    test(`does not count \`will-change: ${value}\` as a containing block`, async ({ page }) => {
      const { bounds } = await boundsFor(
        page,
        `const outer = document.createElement('div');
         outer.style.cssText = 'will-change: ${value}; overflow: auto; width: 240px; height: 80px;';
         const slot = document.createElement('div');
         slot.style.cssText = 'position: absolute; left: 150px; top: 0;';
         const anchor = document.createElement('div');
         anchor.style.cssText = 'position: relative; width: 60px;';
         slot.append(anchor); outer.append(slot); stage.append(outer);
         return [anchor, stage];`,
      );
      // The stage (position: relative, not clipping) is the slot's containing
      // block, so nothing clips it.
      expect(bounds).toEqual(await viewportBounds(page));
    });
  }

  test('counts content-visibility as a clip', async ({ page }) => {
    const { bounds, clip } = await boundsFor(
      page,
      `const outer = document.createElement('div');
       outer.style.cssText = 'content-visibility: auto; width: 240px;';
       const anchor = document.createElement('div');
       anchor.style.cssText = 'position: relative; width: 60px;';
       outer.append(anchor); stage.append(outer);
       return [anchor, outer];`,
    );
    expect(bounds).toEqual(clip);
  });

  test('ignores paint containment on an inline box, where it does not apply', async ({ page }) => {
    const { bounds } = await boundsFor(
      page,
      `const outer = document.createElement('span');
       outer.style.cssText = 'contain: paint;';
       const anchor = document.createElement('span');
       anchor.style.cssText = 'position: relative;';
       anchor.textContent = 'anchor';
       outer.append(anchor); stage.append(outer);
       return [anchor, outer];`,
    );
    expect(bounds).toEqual(await viewportBounds(page));
  });

  // Filters, unlike transforms and containment, also apply to an inline box,
  // which then contains the fixed slot inside it; transforms do not.
  for (const [style, contains] of [
    ['filter: blur(0px)', true],
    ['backdrop-filter: blur(0px)', true],
    ['will-change: filter', true],
    ['transform: translateX(0)', false],
  ] as const) {
    test(`an inline box with \`${style}\` ${contains ? 'contains' : 'does not contain'} a fixed box`, async ({
      page,
    }) => {
      const { bounds, clip } = await boundsFor(
        page,
        `const outer = document.createElement('div');
         outer.style.cssText = 'overflow: hidden; width: 240px; height: 80px;';
         const inline = document.createElement('span');
         inline.style.cssText = '${style};';
         inline.textContent = 'x';
         const slot = document.createElement('div');
         slot.style.cssText = 'position: fixed; left: 150px; top: 0;';
         const anchor = document.createElement('div');
         anchor.style.cssText = 'position: relative; width: 60px;';
         slot.append(anchor); inline.append(slot); outer.append(inline); stage.append(outer);
         return [anchor, outer];`,
      );
      expect(bounds).toEqual(contains ? clip : await viewportBounds(page));
    });
  }

  // A top-layer element is painted above everything, so even a clipping
  // ancestor that would contain it as a fixed box does not clip it.
  for (const [name, open] of [
    ['an open popover', `top.setAttribute('popover', 'manual'); top.showPopover();`],
    ['a modal dialog', `top.showModal();`],
  ] as const) {
    test(`stops at ${name} in the top layer`, async ({ page }) => {
      const { bounds } = await boundsFor(
        page,
        `const outer = document.createElement('div');
         outer.style.cssText = 'transform: translateX(0); overflow: hidden; width: 240px; height: 80px;';
         const top = document.createElement('${name === 'a modal dialog' ? 'dialog' : 'div'}');
         top.style.cssText = 'overflow: visible;';
         const anchor = document.createElement('div');
         anchor.style.cssText = 'position: relative; width: 60px;';
         top.append(anchor); outer.append(top); stage.append(outer);
         ${open}
         return [anchor, outer];`,
      );
      expect(bounds).toEqual(await viewportBounds(page));
    });
  }

  test('counts paint containment as a clip', async ({ page }) => {
    const { bounds, clip } = await boundsFor(
      page,
      `const outer = document.createElement('div');
       outer.style.cssText = 'contain: paint; width: 240px;';
       const anchor = document.createElement('div');
       anchor.style.cssText = 'position: relative; width: 60px;';
       outer.append(anchor); stage.append(outer);
       return [anchor, outer];`,
    );
    expect(bounds).toEqual(clip);
  });

  test('ignores display: contents, which has no box to clip with', async ({ page }) => {
    const { bounds } = await boundsFor(
      page,
      `const outer = document.createElement('div');
       outer.style.cssText = 'display: contents; overflow: hidden;';
       const anchor = document.createElement('div');
       anchor.style.cssText = 'position: relative; width: 60px;';
       outer.append(anchor); stage.append(outer);
       return [anchor, outer];`,
    );
    expect(bounds).toEqual(await viewportBounds(page));
  });

  test('counts the body when the root clips on the other axis', async ({ page }) => {
    // Body overflow goes to the viewport only when the root is visible on both
    // axes. Here it is not, so the body clips with its own box.
    await page.evaluate(() => {
      document.documentElement.style.overflow = 'visible clip';
      document.body.style.overflowX = 'hidden';
      document.body.style.width = 'calc(100vw - 200px)';
    });
    const { bounds, clip } = await boundsFor(
      page,
      `const anchor = document.createElement('div');
       anchor.style.cssText = 'position: relative; width: 60px;';
       stage.append(anchor);
       return [anchor, document.body];`,
    );
    expect(bounds).toEqual(clip);
  });
});
