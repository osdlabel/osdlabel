# Sample data

Every asset here is **synthetic** — procedurally generated flat colour bands, a
grid, and an origin marker. None of it is a photograph, none of it originates
from a third party, and none of it carries a licence obligation: it is part of
this repository under the repository's own licence.

That is deliberate, not a fallback. Photographs would need provenance tracking
for something no test asserts anything about, and the generated pixels are
deterministic, so a future colour assertion has no unstated dependency on an
image someone might swap. The grid makes pan and zoom visually verifiable by
eye during development.

| Asset                        | Dimensions | Size    | Opened as           |
| ---------------------------- | ---------- | ------- | ------------------- |
| `landscape.png`              | 1280×800   | 15.5 KB | OSD `type: 'image'` |
| `portrait.png`               | 800×1200   | 12.8 KB | OSD `type: 'image'` |
| `wide.png`                   | 2000×500   | 14.5 KB | OSD `type: 'image'` |
| `tiled.dzi` + `tiled_files/` | 800×600    | 12.1 KB | OSD DZI tile source |

The three simple images have distinct aspect ratios (1.6, 0.67, 4.0) so that
switching between them exercises different fit and zoom behaviour.

`tiled.dzi` is a real Deep Zoom pyramid — 11 levels, 256 px tiles, 1 px
overlap, 25 PNG tiles — so the DZI branch of `openImage` is exercised by the
dev app and by the E2E suite without reaching the network. It is 800×600
because the specs that measure overlay alignment probe the corners of an
800×600 image.

## No generator is committed

These are vendored outputs, not build products. The scripts that produced them
are not in the repository, so nothing here is regenerated as part of a build
and nothing depends on being able to re-run them. Treat the files as fixtures:
if a different image is needed, add it and describe it here.

## Do not add remote sources

`apps/dev/tests/e2e/offline.spec.ts` fails if loading the dev app and cycling
every filmstrip image issues any request off localhost. That is the guard for
issue #144, where three remote DZIs on `openseadragon.github.io` made 23 of the
Playwright specs fail wherever that host was unreachable.

`apps/docs` keeps its remote DZIs on purpose — that site is deployed and read
online, and a live deep-zoom demo is the library's headline capability.

`apps/dev-react/sample-data/` carries byte-identical copies of these assets;
each app's Vite root serves its own.
