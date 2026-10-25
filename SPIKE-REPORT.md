# Spike: a `downsample` field on #149's masks

Branch `claude/spike-mask-resolution`, one commit on top of #149
(`origin/claude/segmentation-brush-tool` @ `58a379f`). A spike, not a PR: the
code is real and tested, but it skips docs, binding parity tests, and an E2E for
the new path (see "Not done").

## 1. The problem with #149's mask format

#149 stores a mask only at level 0, the image's full resolution. The payload
has no resolution field: `MaskRawData` is `{x, y, width, height, imageWidth,
imageHeight, counts, fill?}` (`packages/annotation/src/raw-annotation.ts:53-70`
@ 58a379f). Every runtime path then holds the mask's level-0 bounding box as a
dense one-byte-per-pixel array, capped at 64 Mi pixels:

| Where            | What it does with the level-0 box                                   | file:line @ 58a379f                                        |
| ---------------- | ------------------------------------------------------------------- | ---------------------------------------------------------- |
| Brush buffer     | allocates the box; above the cap throws `MaskCapacityExceededError` | `packages/mask/src/bounded-dense-mask-buffer.ts:29, 295`   |
| Canonical decode | `assertDecodableArea(width, height)` before it allocates            | `packages/mask/src/canonical-codec.ts:190`                 |
| COCO decode      | the same check, then `new Uint8Array(width * height)`               | `packages/mask/src/coco-rle-codec.ts:172-173`              |
| Schema           | `width * height <= MAX_MASK_PIXELS`                                 | `packages/validation/src/schemas/mask-data.ts:57`          |
| Renderer         | one canvas pixel per mask pixel (`canvas.width = snapshot.width`)   | `packages/fabric-annotations/src/mask-fabric-object.ts:56` |
| Host cap         | `maxPixels` can only lower the cap, never raise it                  | `packages/osdlabel/src/brush-config.ts:104`                |

So **no mask whose level-0 bounding box exceeds 64 Mi px can exist**, however
it was made. 64 Mi px is 8192 x 8192: about 2 x 2 mm at 0.25 um/px.

- **SAM is not the only case.** The brush radius is in image pixels
  (`segmentation-brush-tool.ts:44`), and a stroke that grows the box past the
  cap is abandoned (`segmentation-brush-tool.ts:369-380`; the docs say so at
  `segmentation-brush.mdx:417`). Measured: tracing the outline of a
  12,000 px-diameter circle (3 mm at 0.25 um/px) with a 200 px brush fails
  partway, at a requested 67,587,584 px against the 67,108,864 cap. Nothing is
  committed.
- **The wire encoding is not what breaks.** The canonical row-major RLE of the
  SAM-like overview mask below at level 0 would be 270,498 bytes (360,664 base64
  chars, 113,171 runs), which is small. What breaks is that nothing can decode,
  paint, or render it without a dense 2.27 Gpx array.
- **"Re-encode a finer crop at commit" does not fix it.** The object's level-0
  bounding box is the same however finely it is segmented, so a finer crop has
  the same box and fails the same check.
- **A sparse or tiled level-0 buffer does not fix it either.** The painted area
  alone is 430,077,733 level-0 px, 6.4x the cap.

The only fixes are a coarser grid (this spike) or a vector geometry
(polygon-with-holes or multipolygon).

## 2. What the spike does

| Decision                | Choice and reason                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Name                    | `downsample`, the word WSI tooling uses for the same factor: OpenSlide `openslide_get_level_downsample` (`src/openslide.h:157` on openslide main); QuPath `RegionRequest.createInstance(path, downsample, x, y, width, height)` (`RegionRequest.java:204` on qupath main).                                                                                                                                                                                                                                                    |
| Values                  | Integer powers of two, 1 to 2^16 (`MAX_MASK_DOWNSAMPLE`). They match Deep Zoom levels, cells nest across them so later conversions are exact, and `x / d` is an exact float. 2^16 is enough because at the image-side bound 2^26 it leaves 1024 x 1024 cells.                                                                                                                                                                                                                                                                 |
| Where it lives          | Optional `downsample?: number` on `MaskGeometry`, `MaskRawData`, `CanonicalMaskData`, `MaskSnapshot`; required `downsample` / `gridWidth` / `gridHeight` on `MaskBuffer`. `mask-wire-format.ts` adds `'downsample'` to the agreed wire fields and asserts `MAX_MASK_DOWNSAMPLE` agrees between `@osdlabel/mask` and `@osdlabel/validation`.                                                                                                                                                                                   |
| origin / width / height | Payload and geometry stay in **level-0 image px** at every `d`. The box is cell-aligned: `x`, `y` are multiples of `d`, and so are the right and bottom edges unless they are the image's. The cell grid is `ceil(width/d) x ceil(height/d)`, the image's is `ceil(W/d) x ceil(H/d)` (Deep Zoom rounding). Cell `(cx, cy)` covers `[cx*d, min((cx+1)*d, W))` and the matching rows.                                                                                                                                           |
| Snapshot / buffer units | `MaskSnapshot.x/y/width/height/data` and `MaskBuffer.get/set/bounds/reserve` are in **cells**; `imageWidth/imageHeight` stay level-0. The codec converts at the wire. `snapshotImageBox()` gives the level-0 box.                                                                                                                                                                                                                                                                                                             |
| `pixelCount`            | Departs from the suggested "grid pixels". It is the **exact count of level-0 pixels covered**, with cells clipped by the image edge counted at their clipped size. So `area()`, COCO `area`, the measurement provider and the schema's `pixelCount <= width*height` check all stay correct with no code change. `snapshotCellCount()` counts cells.                                                                                                                                                                           |
| Cap                     | Applies to **cells** in the buffer, both decoders, the schema (`ceil(w/d)*ceil(h/d) <= MAX_MASK_PIXELS`) and the deserialize budget, since cells are what get allocated.                                                                                                                                                                                                                                                                                                                                                      |
| Format string           | **Unchanged** (`'osdlabel-mask'`). It has never shipped: `git grep osdlabel-mask origin/main` finds nothing, and `npm view @osdlabel/mask` returns 404. Absent means 1 and 1 is never written, so every existing payload keeps its bytes and its meaning. A reader that predates the field fails closed: valibot's `v.object` strips the unknown key, and the runs then sum to the cell grid rather than `width*height`, so `fromRuns` throws (tested). The 1x1-at-the-corner exception decodes correctly at d=1 anyway.      |
| Decode guards           | `downsample` must be a power of two within range; the box must be cell-aligned; the cap and the counts-length bound apply to cells. All are per-annotation `skipped` entries in `deserialize`, not document-wide throws (tested).                                                                                                                                                                                                                                                                                             |
| Stroke rasterization    | `stampCircle` / `strokeSegment` still take image px. They divide by `buffer.downsample` once, rasterize on the cell grid (a cell is painted when its centre is inside the disc), and space stamps in cells. At d=1 they behave exactly as before.                                                                                                                                                                                                                                                                             |
| COCO export             | COCO has no downsample, so `snapshotToCocoCounts` upsamples to level 0 while it generates runs. Each cell column's runs are computed once in image rows and repeated per image column, so level 0 is never allocated. `cocoBbox` / `cocoArea` are level-0. Tested equal to `upsampleSnapshot` + level-0 export, and round-tripped through the COCO decoder.                                                                                                                                                                   |
| Third-party codecs      | New `MaskCodec.encodesDownsampled?: boolean`. `serialize` refuses to hand a `d > 1` snapshot to a codec that has not opted in, because it would read cells as pixels and misplace the mask silently. Canonical and both COCO codecs opt in.                                                                                                                                                                                                                                                                                   |
| Renderer                | `FabricImage` with one canvas pixel per cell, `left = x*d`, `top = y*d`, `scaleX = scaleY = d`, `imageSmoothing: false`. Cells on a clipped image edge are drawn full size, so the mask overhangs the image by less than one cell, outside the image.                                                                                                                                                                                                                                                                         |
| Brush, new mask         | `chooseMaskDownsample(region, W, H, cap, marginCells = 2)` picks the smallest power of two whose aligned, image-clipped cell cover of the region fits the cap. The region is the visible image box (the canvas corners through the inverse `viewportTransform`, so rotation and flip are covered), padded by the brush radius and 2 cells for the rasterizer's reserve slack. While the view covers at most the cap in image px, this gives 1, which is today's behaviour. An overlay with no readable viewport also gives 1. |
| Brush, existing mask    | Paints at the mask's own `d`. The preview uses the same placement as the renderer.                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| Bindings                | Untouched. Everything reaches them through `buildSegmentationBrushConfig`, `createMaskAnnotation` and `buildMaskFabricObject`.                                                                                                                                                                                                                                                                                                                                                                                                |

## 3. Numbers

`pnpm --filter @osdlabel/fabric-annotations measure:mask-downsample`
(`packages/fabric-annotations/tests/measure/mask-downsample.measure.ts`). Run
with Node 22.22, vitest jsdom with node-canvas, in a 4-core container at load
0.1-1.4. ms figures are ranges over 4 runs. Renderer and brush ms come from
node-canvas, not a browser.

**Input.** A synthetic SAM-like prediction: a 256x160 raster with one irregular
blob, 4 holes and 14 islands (15 rings and 4 holes, verified). It sits on a
60,000 x 44,000 image with a level-0 box of 56,000 x 40,600 =
**2,273,600,000 px = 33.88x the cap**. The prototype's box was 2,273,163,669 px.
Each raster pixel covers 218.75 x 253.75 image px.

| Case                                                                                                              | Result                                                                                                                                                           |
| ----------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Forced d=1 (`new BoundedDenseMaskBuffer(...).reserve(box)`)                                                       | throws `MaskCapacityExceededError`, requested 2,273,600,000 > 67,108,864                                                                                         |
| `chooseMaskDownsample(box, W, H, 64 Mi)`                                                                          | **d = 8** (grid 7000x5075 = 35,525,000 cells = 0.53 of the cap; at d=4 it would be 14000x10150 = 142 M)                                                          |
| Commit raster to snapshot at d=8 (nearest at cell centres, through the buffer)                                    | 329-591 ms                                                                                                                                                       |
| Canonical payload at d=8                                                                                          | `counts` 35,520 chars; whole envelope JSON 35,668 B                                                                                                              |
| `encodeCanonical` / `decodeCanonical`                                                                             | 165-178 ms / 14.4-17.7 ms (one 90.7 ms GC outlier); decode is byte-identical                                                                                     |
| Exact level-0 area: stored (`pixelCount`) / exact level-0 rasterization / continuous raster area                  | 430,032,768 / 430,077,733 / 430,074,531.25: stored is -1.05e-4 relative to level 0                                                                               |
| IoU vs the exact level-0 rasterization (computed blockwise, no level-0 allocation)                                | **0.99899**; symmetric difference 434,457 px                                                                                                                     |
| Rings / holes stored                                                                                              | **15 / 4, all preserved**                                                                                                                                        |
| Renderer: `buildMaskFabricObject`                                                                                 | 342-374 ms (node-canvas, 35.5 Mpx canvas); `left` 2000, `top` 1696, `scaleX` 8                                                                                   |
| Max placement error of rendered cell centres vs `(cell + 0.5) * d` (28,028 sampled through `calcTransformMatrix`) | **0 image px**                                                                                                                                                   |
| COCO export of the d=8 mask at level 0                                                                            | 263-299 ms, 214,997 chars, `isCocoInteropSafe` true                                                                                                              |
| Polygon fallback (prototype behaviour), ideal version: exact outline of the largest ring, holes filled            | **1 of 15 rings, 0 of 4 holes**; IoU 0.9309; 20,429,019 px of islands dropped, 9,989,622 px of holes filled in. The prototype's traced version had 114 vertices. |

Resolution sweep (same prediction; ms ranges over 3 runs):

| d   | grid      | cells      | counts chars | encode ms | decode ms | IoU vs level 0 | area vs level 0 | rings/holes |
| --- | --------- | ---------- | ------------ | --------- | --------- | -------------- | --------------- | ----------- |
| 8   | 7000x5075 | 35,525,000 | 35,520       | 165-170   | 14.6-17.7 | 0.99899        | -1.05e-4        | 15/4        |
| 16  | 3500x2538 | 8,883,000  | 16,588       | 39-43     | 4.2-6.8   | 0.99800        | +3.43e-4        | 15/4        |
| 32  | 1750x1269 | 2,220,750  | 8,072        | 9.7-10.4  | 1.2       | 0.99618        | -2.64e-4        | 15/4        |
| 64  | 875x634   | 554,750    | 3,868        | 2.5-2.8   | 0.2       | 0.99177        | -3.28e-5        | 15/4        |
| 128 | 437x317   | 138,529    | 1,640        | 0.6-1.1   | 0.1       | 0.98606        | -3.65e-3        | 15/4        |
| 256 | 219x158   | 34,602     | 720          | 0.2-0.4   | 0.0       | 0.96910        | +1.06e-2        | 15/4        |

d=16 is the first grid under iOS Safari's canvas-area limit of about 16 Mpx,
which #149's own docs flag (`segmentation-brush.mdx:407-415`). d=256 is about
the model raster's own resolution. Even there the mask beats the polygon
fallback on IoU (0.969 vs 0.931) and on topology.

**Brush, on the same 60,000 x 44,000 image.** Trace a 12,000 px-diameter circle
with a 200 px brush, in 240 moves:

| Setup                                                   | d   | Outcome                                                                     | ms (jsdom)   |
| ------------------------------------------------------- | --- | --------------------------------------------------------------------------- | ------------ |
| no viewport (= #149 today)                              | 1   | capacity error at 67,587,584 requested, 0 commits                           | 9,348-11,776 |
| zoom 0.1 on a 1600x1000 canvas (16000x10000 px in view) | 2   | committed, grid 6200x6200 (38.4 M cells), box 12400x12400 at (13800, 13800) | 5,655-6,553  |

The ms are jsdom and node-canvas preview work, not browser frame times.

## 4. Tests run (all green)

| Package                       | typecheck | unit tests                                                                            |
| ----------------------------- | --------- | ------------------------------------------------------------------------------------- |
| @osdlabel/annotation          | ok        | 9/9                                                                                   |
| @osdlabel/mask                | ok        | 139/139 (+21 in `downsample.test.ts`)                                                 |
| @osdlabel/geometry            | ok        | 36/36 (+1)                                                                            |
| @osdlabel/validation          | ok        | 96/96 (+3)                                                                            |
| @osdlabel/decoration          | ok        | 66/66                                                                                 |
| @osdlabel/fabric-annotations  | ok        | 192/192 (+2 renderer placement, +5 brush resolution)                                  |
| @osdlabel/fabric-osd          | ok        | 198/198                                                                               |
| osdlabel                      | ok        | 314/314 (+5)                                                                          |
| @osdlabel/solid (untouched)   | ok        | 157/157                                                                               |
| @osdlabel/react (untouched)   | ok        | 218/218                                                                               |
| E2E, Solid dev app, port 5190 | n/a       | `segmentation-brush.spec.ts` 13/13 and `offline.spec.ts` 2/2, against rebuilt `dist/` |

ESLint is clean on the touched packages, and Prettier is applied. The E2E run
used a scratch Playwright config whose `executablePath` points at the
sandbox's chromium-1243, because Playwright 1.60 expects 1223. The dev images
are small, so the E2E exercises the live `viewportTransform` path only at d=1.

## 5. Diff size (vs `origin/claude/segmentation-brush-tool`, excluding this report)

30 files, +2044 / -76:

- **src:** +758 / -71. Of the added lines, about 451 are code and 283 are doc
  comments. New file `packages/mask/src/downsample.ts` is 178 lines.
- **unit tests:** +601 / -4.
- **measurement script and config:** +685.

## 6. Production estimate

| Item                                                                                                                                                                                                                                   | Days                      |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------- |
| Review and polish of the spike's core (naming, `MaskBuffer` contract, `encodesDownsampled`)                                                                                                                                            | 1-2                       |
| Hostile-input tests for downsample in `deserialize-hostile.test.ts` (huge or odd `d`, unaligned boxes, budget in cells) and `robustness.test.ts`                                                                                       | 1                         |
| Binding parity: Solid and React `viewer-cell-mask-*` tests with a d>1 mask (render placement, cache, selection dimming, refine at own d), mirrored file for file                                                                       | 1.5-2                     |
| E2E in both apps: d>1 needs either a large local DZI (offline rule, #144) or a dev-app hook for a small `maxPixels`; brush at overview zoom, commit, reload, COCO export                                                               | 1.5-2                     |
| Docs: `segmentation-brush.mdx` (cap now in cells, resolution choice, codec example must honour `downsample` and `encodesDownsampled`), `serialization.mdx` payload table, mask README, changeset, regenerated `llm.md`, CLAUDE.md note | 1                         |
| **Subtotal: what this spike covers, production-ready**                                                                                                                                                                                 | **6-8 (about 1.5 weeks)** |
| Re-gridding on refine (a coarse mask refined when zoomed in can be re-gridded finer if it fits; a stroke that would overflow can coarsen the mask, which is lossy and needs a UX decision)                                             | 2-3                       |
| Render budget: pick `d` against min(cap, about 16 Mi canvas area), or render a coarser mip of a fine mask                                                                                                                              | 1                         |
| Audit direct `MaskSnapshot` consumers (e.g. the DICOM PoC's `fullFrame`, `packages/dicom-export/src/seg.ts:83-96` @ 85a3f3f, reads `x/y` as image px and would misplace a d>1 mask), plus COCO import into a downsample                | 1                         |
| **With the follow-ons: about 2-2.5 weeks**                                                                                                                                                                                             | **10-13**                 |

## 7. Not done, and open questions

- **No docs and no binding parity tests.** CLAUDE.md's binding-parity rule
  would require the latter. There is also no E2E at d>1 in a real browser, and
  no browser frame-time measurement of the d>1 preview.
- **Refining keeps the mask's `d`.** A mask started at overview stays coarse
  when it is refined at high zoom. A d=1 mask refined at overview still hits
  the cap, as today.
- **The chooser has no floor tied to screen resolution.** A tiny `maxPixels`
  gives absurdly coarse grids: a cap of 2 gives one cell for the whole image.
  A floor such as "never coarser than one screen pixel" is a policy call.
- **Renderer canvas vs iOS.** At d=8 the renderer's canvas is 35.5 Mpx, over
  iOS Safari's about 16 Mpx. The existing advice (set `maxPixels` below it)
  now also coarsens `d` automatically, because the chooser uses the configured
  cap. Whether to default to a render-safe cap is open.
- **COCO import does not decode into a downsample.** A level-0 COCO mask over
  the cap still fails on import.
- **`encodesDownsampled` guards only `serialize`.** Code that calls
  `decodeCanonical` and reads the snapshot itself must handle `d`.
- **DICOM.** Mapping `d` to a SEG at coarser spacing (rather than upsampling)
  looks natural but was not verified here.
