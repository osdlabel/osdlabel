import { test, expect, type Page } from '@playwright/test';

/**
 * The suite must run without network access (issue #144).
 *
 * Three of the dev app's four images were remote DZI tile sources, so 23 of
 * these specs failed wherever `openseadragon.github.io` was unreachable — and
 * failed by timing out on assertions about a viewer that never opened, which
 * reads as a broken feature rather than a missing network.
 *
 * This guards the property rather than the specific URLs: any request leaving
 * the dev server's own origin fails it, whoever adds it and whatever it is for.
 */

/**
 * Requests that left the dev server's own origin, and every response the tile
 * pyramid produced.
 *
 * The origin is read from `baseURL` rather than matched against a list of
 * loopback names, so pointing the config at a LAN host does not turn every
 * request into a false positive.
 */
interface Traffic {
  readonly external: string[];
  readonly tiles: { url: string; status: number; contentType: string }[];
}

function collectTraffic(page: Page, baseURL: string): Traffic {
  const origin = new URL(baseURL).origin;
  const traffic: Traffic = { external: [], tiles: [] };

  page.on('request', (request) => {
    const url = request.url();
    // data:, blob: and about: carry no host and never leave the page.
    if (!/^https?:/i.test(url)) return;
    if (!url.startsWith(origin)) traffic.external.push(url);
  });

  page.on('response', (response) => {
    const url = response.url();
    if (!url.startsWith(origin) || !url.includes('/tiled_files/')) return;
    traffic.tiles.push({
      url,
      status: response.status(),
      contentType: response.headers()['content-type'] ?? '',
    });
  });

  return traffic;
}

test.describe('Offline operation', () => {
  /**
   * Every image the filmstrip offers, read from the DOM rather than listed
   * here. A hardcoded list would protect today's images instead of the
   * property: the regression this guards against is someone *adding* an image
   * with a remote source, which a fixed list would never select.
   */
  async function everyFilmstripId(page: Page): Promise<string[]> {
    const items = await page.locator('[data-testid^="filmstrip-item-"]').all();
    const ids = await Promise.all(
      items.map(async (item) =>
        (await item.getAttribute('data-testid'))!.replace(/^filmstrip-item-/, ''),
      ),
    );
    // The enumeration must not silently come back empty — that would make
    // every assertion below vacuous.
    expect(ids.length).toBeGreaterThanOrEqual(4);
    return ids;
  }

  test('loading the app and every image makes no external request', async ({ page, baseURL }) => {
    const traffic = collectTraffic(page, baseURL!);

    await page.goto('/');
    await page.waitForSelector('[data-testid="tool-navigate"]', { timeout: 10000 });

    for (const id of await everyFilmstripId(page)) {
      await page.getByTestId(`filmstrip-item-${id}`).click();
      await page.waitForTimeout(400);
    }
    // The per-image budget above is the only window in which the *last*
    // image's requests can be observed. A source that opens lazily would
    // issue its request after the loop and escape the assertion, so settle
    // the network before reading.
    await page.waitForLoadState('networkidle');

    expect(traffic.external).toEqual([]);

    // The vendored pyramid must actually serve tiles, not merely parse its
    // descriptor: `tilesUrl` is derived from the `.dzi` path, so the positive
    // control below would pass against an empty `tiled_files/`.
    //
    // This has to inspect the response rather than rely on a failed request.
    // Vite's SPA fallback answers a missing file with `200 text/html`, not a
    // 404, so OSD asks for a tile, is handed an HTML page, and fails to decode
    // it with nothing on the wire to distinguish that from success.
    //
    // Scope, precisely: this covers the tiles OSD requests at the zoom this
    // test drives — in practice levels 8 and 9, not the full pyramid. Deleting
    // a level-10 tile does NOT fail this, because nothing here zooms in far
    // enough to request one. It is a guard against a missing or mis-pathed
    // pyramid, not a completeness check over all 25 tiles.
    expect(traffic.tiles.length).toBeGreaterThan(0);
    expect(
      traffic.tiles.filter((t) => t.status !== 200 || !t.contentType.startsWith('image/')),
    ).toEqual([]);
  });

  test('every image actually opens its own tile source', async ({ page }) => {
    // The negative test above would also pass if an image silently failed to
    // load and requested nothing, so this is its positive control. It asserts
    // OSD's opened source, not canvas dimensions: the Fabric canvas is sized
    // whether or not a tile source ever opened, which makes any assertion
    // about it pass against an unreachable image.
    //
    // Asserting the *url* rather than a count also removes a dependency on
    // `ViewerCell` closing the viewer before opening the next one — a count
    // would be satisfied by the previous image still being loaded.
    await page.goto('/');
    await page.waitForSelector('[data-testid="tool-navigate"]', { timeout: 10000 });

    const ids = await everyFilmstripId(page);
    // Cell 0 is auto-assigned the first image at startup, so clicking it first
    // would assert the initial state and pass before any click took effect.
    // Open a different one first, so every iteration is a real transition.
    await page.getByTestId(`filmstrip-item-${ids.at(-1)!}`).click();

    for (const id of ids) {
      await page.getByTestId(`filmstrip-item-${id}`).click();
      await expect
        .poll(
          () =>
            page.evaluate(() => {
              // `testMode` puts the OSD viewer on its own canvas element.
              const el = document.querySelector('.openseadragon-canvas') as unknown as {
                __osdViewer?: {
                  world: {
                    getItemCount(): number;
                    getItemAt(i: number): { source?: { url?: string; tilesUrl?: string } };
                  };
                };
              } | null;
              const world = el?.__osdViewer?.world;
              if (!world || world.getItemCount() === 0) return '';
              const source = world.getItemAt(0).source;
              // A simple-image source reports `url`; a DziTileSource reports
              // `tilesUrl` and has no `url` at all. Reading only `url` made
              // this return '' for the DZI and look like a failure to open.
              return source?.url ?? source?.tilesUrl ?? '';
            }),
          { timeout: 15000, message: `no tile source opened for ${id}` },
        )
        .toContain(id);
    }
  });
});
