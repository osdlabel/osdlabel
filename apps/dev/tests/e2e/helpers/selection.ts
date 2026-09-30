import type { Page } from '@playwright/test';

/**
 * The annotation id of the first cell's currently selected Fabric object, or
 * `null` when nothing is selected.
 *
 * Read through the overlay handle `FabricOverlay` publishes in `testMode`
 * (`.openseadragon-canvas.__osdOverlay`), which the dev app enables. A missing
 * handle throws rather than reporting "nothing selected", so a broken hook
 * cannot silently satisfy a negative assertion (#193: an earlier probe read a
 * `__canvas` property Fabric v7 never sets, and passed without looking).
 */
export const selectedAnnotationId = (page: Page): Promise<string | null> =>
  page.evaluate(() => {
    const el = document.querySelector('.openseadragon-canvas') as
      | (Element & {
          __osdOverlay?: { canvas?: { getActiveObject: () => { id?: string } | null } };
        })
      | null;
    const canvas = el?.__osdOverlay?.canvas;
    if (!canvas) throw new Error('overlay test hook not installed');
    return canvas.getActiveObject()?.id ?? null;
  });
