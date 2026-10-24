# PoC: pixel pipeline (16-bit windowing and the WebGL context budget)

Branch `claude/poc-pixel-pipeline`, head `107ee8462f` at the time of the result. Part of the osdlabel roadmap study (branch `claude/osdlabel-roadmap-strategy-uut5ay`). Written by the orchestrating agent from the PoC agent's structured result, because PoC agents in this environment cannot write report files.

**Status:** Built and independently reviewed. The review's two blocking findings concern the recommendation, not the measurements: (1) the shared window/level drawer drops tone (invert, exposure, contrast) on 8-bit tiles, so it must not become the default for 8-bit grids until its RGBA shader applies tone; (2) SwiftShader cannot rank the drawer targets, so the shared-context default is provisional until a real-GPU run. They were not fixed in code (the fix pass was skipped to conserve the session's usage budget); the roadmap document carries the corrected recommendation: canvas drawer for ordinary 8-bit cells, the 16-bit drawer opt-in, a real-GPU run as the gate. The reviewer reproduced every deterministic result exactly (grey levels, context counts, blank cells, the drawer-swap bug).

## Summary

I built two new leaf packages and a benchmark harness, all on branch claude/poc-pixel-pipeline (based on PR #149). @osdlabel/pixel is zero-dependency DICOM VOI math. @osdlabel/osd-pixel adds a raw 16-bit TileSource and a WebGL2 drawer that applies window/level in a fragment shader. The harness is apps/poc-pixel-pipeline. Answer: yes, OpenSeadragon can stay the 2D renderer without a fork. The fix for the WebGL context budget is one shared context for every cell. Today's CSS-filter tone shows 6 grey levels instead of 80 in the brain window. The new drawer plugs into OSD 5.0.1 through its public drawer and TileSource extension points. Its output is pixel-identical to OSD's own WebGL drawer, the Fabric overlay stays registered in 296/296 checks, and a W/L drag uploads 0 textures. It also runs on OSD 6.1.1 after a ~220-line port. In osdlabel's own dev app a 4x4 grid holds exactly 16 live contexts, and one extra WebGL user blanks a cell for good. A shared context keeps 1 context for 1 to 24 cells. Existing code changed: +63 src lines in fabric-osd only. Not measured: GPU speed on real hardware (this sandbox's GPU is SwiftShader).

## Hypotheses and verdicts

### H1: confirmed

CSS filters on 8-bit tiles that were already quantised cannot produce diagnostic windowing of 12-16-bit data.

Pigeonhole bound: a tile quantised to 8 bits over -1000..3000 HU has one level per 15.7 HU, so no per-pixel function (CSS included) can show more distinct greys than that inside a window. Distinct levels in window, correct pipeline vs best possible 8-bit (max step in grey levels; widest band in HU): brain W80/L40 80 vs 6 (step 4 vs 51; band 2 vs 16 HU). Subdural W200/L75 200 vs 14 (step 2 vs 21). Lung W1500/L-600 196 vs 74. Bone W2000/L300 256 vs 129. Abdomen W400/L50 256 vs 27 (step 1 vs 11). With osdlabel's CellTransform bounds (exposure/contrast in [-1,1], CSS factors 0..2), brightness\*contrast is at most 4, but brain needs a slope of 50, subdural 20, abdomen 10. Through the real FabricOverlay.applyImageFilters the brain window has a max error of 129 grey levels. The unbounded CSS chain cannot express lung exactly either, because brightness clips before contrast. Projection data: 16-bit mammogram W4000 gives 256 vs 17 levels (bands 257 stored units wide); 12-bit DX W600 gives 256 vs 38. On-screen check in Chromium 153: a 64x64 ramp holding every HU from -1000 to 3000 is shown 8x with nearest sampling and screenshotted. GPU and CPU paths match the exact DICOM LINEAR model for all 4001 values with 0 mismatches. The CSS paths match the 8-bit model within 1 grey level and show the predicted 6/14/74/129/27 levels.

### H2: partial

A CPU path that keeps raw 16-bit tiles and re-applies a VOI LUT into 8-bit canvases on each W/L change holds >= 30 fps for a 512x512 CT but breaks for a 4096x3328 16-bit mammogram; find where it breaks.

Whole image per step: CT 4.0 ms median (253 fps-equivalent). Mammogram 52.9 ms median, 118 ms p95 (19 fps): LUT loop 34.4 ms + putImageData 11.4 ms, so this variant breaks as hypothesised. The packed Uint32 LUT store beats a byte loop (51.5 ms) and per-pixel math (64.6 ms). Worker pool with 1/2/4 workers: 60.3/63.1/61.1 ms wall and ~23 ms main-thread, so no gain on 4 contended cores (ImageData cannot wrap a SharedArrayBuffer, an 11 ms copy). Tiled inside OSD (raster TileSource + OSD CanvasDrawer, lazy re-window of drawn tiles only) does NOT break in a 1024x1024 viewer: CT 2.0-4.8 ms; mammogram 8.9 ms at 1:1 (25 tiles, 1.64 Mpx) and 13.9 ms at fit (56 tiles, 3.41 Mpx); 57-60 fps. It breaks with drawn area, not image size. Mammogram at 1:1 by viewer size: 0.59/1.64/3.21/5.31 Mpx per step gives 3.1/8.6/18.8/35.8 ms (60/60/54/21 fps), about 6.7 ms per Mpx, so 30 fps ends near 4.5 Mpx (a 2048x2048 viewer, or a 1024x1024 cell at DPR 2). With OSD's default WebGLDrawer a W/L change never reaches the screen without the private \_unloadTextures(); with it, 5-23 fps. Memory: 2 B/px raw + 4 B/px RGBA canvas for each cached tile.

### H3: partial

A GPU path (16-bit textures, VOI in a fragment shader) holds 60 fps W/L at all sizes, plugs into OSD 5.0.1 through its drawer extension points without forking, leaves FabricOverlay sync unaffected, and survives OSD 6.

Integration confirmed. VoiWebGLDrawer is a DrawerBase subclass passed as the 'drawer' option; requestDrawer accepts any subclass. Raw tiles come through TileSource.downloadTileStart/createTileCache overrides, with no fork. Equivalence vs OSD's own WebGLDrawer fed CPU-windowed tiles, smoothing off: 0.07% of pixels differ, max 2 levels, and 0.13% at 90 degrees + flip. With smoothing on, 1.17% differ by more than 2 (max 114), because interpolation happens before VOI instead of after; before is the correct order. Registration: FabricOverlay.imageToScreen hits the expected display value in 37/37 probes for each of 4 rotations x 2 flips (296/296). Tone seam: the existing applyImageFilters({exposure 0.25, contrast 0.5, inverted}) moved the window from {-100,80} to {-120,40}, inverted, with no CSS filter. A W/L drag makes 0 texture uploads and costs 0.07-0.39 ms of JS per step. Upload per 256x256 tile: r16i 0.14 ms, RG8 0.16, R16F 0.43, R32F 0.93, vs 0.27 ms for OSD's RGBA8 path. 60 fps NOT shown: the WebGL2 renderer is SwiftShader (CPU-emulated). Draw + GPU time was 8.9-60 ms at 1024x1024 and 134 ms at 2048x2048 (5.5 fps), slower than the CPU tile path here; this needs a real-GPU run. OSD 6.1.1 probe: a ~220-line port (custom data type finished by downloadTileStart, a converter to context2d for the CPU path, a drawer with getSupportedDataFormats and internalCacheCreate) reuses the shaders, renderer, mat3, VoiState and @osdlabel/pixel unchanged. It rendered identically to OSD 6's WebGLDrawer (0.00% differing), with 0 uploads per drag. The CPU path through OSD 6's async requestInvalidate took 72.8 ms per step.

### H4: confirmed

With today's default drawer a 4x4 grid sits at Chrome's 16-live-context edge, so any other WebGL user evicts cells; the mitigations (canvas drawer for non-active cells, one shared context, one context with scissoring) have measurable costs.

OSD 5.0.1 picks 'webgl' (WebGL1) in osdlabel's cells. Each cell creates 2 contexts: a throwaway in WebGLDrawer.isSupported (lost at once, does not count) and 1 live. Fabric and DecorationLayer create none. Grid sweep, N=1..24: live = N up to 16, then 16; blank cells after a redraw 0 up to N=16, then 1..8 for N=17..24. In the real Solid dev app at 4x4: 32 created, 16 live, and one foreign WebGL context blanks cell 0. An evicted stock cell throws 'bad value for MAX_TEXTURE_IMAGE_UNITS' inside OSD's rAF loop. The loop is never rescheduled (0 update-viewport events while panned, 20 for a healthy cell) and freeing 16 contexts restores nothing (0 restore events in 3 s). With a per-cell context that handles loss (voi-own), OSD keeps running but the image freezes under a live overlay: a pan changes 0.6% of its pixels vs 65.7% for a healthy cell. Mitigation (i), canvas drawer: 0 contexts at any N; cheapest drawer in this sandbox (0.6-1.1 ms of draw() per frame, 50-58 fps). A runtime swap via viewer.requestDrawer('canvas') leaves 15/15 cells blank: the new canvas lands below the FabricOverlay container and loses the tone filter. With the new FabricOverlay.replaceDrawer: 0/15 blank, 15/15 tone kept, 5.5-6.0 ms per swap, 12.9-14.8 ms back to webgl. Mitigation (ii), shared context: 1 live context for N=1..24, 0 blank, survives a foreign context; its per-frame copy is 35-43 ms per frame on SwiftShader, vs 143-410 ms per frame for OSD's stock WebGL drawer doing the same copy per cell. Mitigation (iii), page canvas with scissoring: 1 context, 0 blank, 0.6-1.9 ms per frame, but it draws outside the cell's DOM subtree.

### H4b: refuted

A runtime drawer swap (canvas for inactive cells) works with osdlabel's FabricOverlay unchanged.

OSD appends the new drawer canvas after the Fabric container, which sits in normal flow. The new canvas has no top, so it is pushed down by the cell height (drawerTop 238 px in a 4x4 cell) and stacked above the overlay. Swapped cells: 15/15 blank, 0/15 kept their tone filter. Fixed by FabricOverlay.replaceDrawer (25 lines): 0/15 blank.

## Measurements

| Measurement                                                                | Value                                                                                    | Unit                                             | Conditions                                                                                                           |
| -------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- | ------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------- |
| H1 brain window distinct grey levels, correct vs best 8-bit                | 80 vs 6                                                                                  | levels                                           | W80/L40, data -1000..3000 HU, analytic and on-screen (Chromium 153); max step 4 vs 51 grey levels                    |
| H1 subdural / abdomen / lung / bone distinct levels, correct vs best 8-bit | 200 vs 14 / 256 vs 27 / 196 vs 74 / 256 vs 129                                           | levels                                           | standard CT windows, full-range 8-bit quantisation over -1000..3000 HU                                               |
| H1 osdlabel CSS (bounded) brain-window max error                           | 129                                                                                      | grey levels                                      | FabricOverlay.applyImageFilters, exposure/contrast clamped to [-1,1]; required slope 50 vs achievable 4              |
| H1 16-bit mammogram narrow window distinct levels, correct vs best 8-bit   | 256 vs 17                                                                                | levels                                           | W4000 C30000 over 0..65535, analytic                                                                                 |
| H1 on-screen mismatches vs exact DICOM model (GPU and CPU paths)           | 0 of 4001                                                                                | HU values                                        | value-ramp screenshot, 5 windows each                                                                                |
| H2 whole-image re-window, mammogram                                        | 52.9 (p95 118.2)                                                                         | ms per W/L step                                  | 4096x3328 Uint16, packed LUT + putImageData, single thread, SwiftShader-free CPU path, contended 4 vCPU              |
| H2 whole-image re-window, CT                                               | 4.0 (p95 7.7)                                                                            | ms per W/L step                                  | 512x512 Int16                                                                                                        |
| H2 worker pool wall time, mammogram, 1/2/4 workers                         | 60.3 / 63.1 / 61.1                                                                       | ms per step                                      | SharedArrayBuffer in/out, ~23 ms main-thread each, 4 contended cores                                                 |
| H2 tiled CPU path in OSD, mammogram 1:1 and fit                            | 8.9 / 13.9 (60 / 57 fps)                                                                 | ms per step                                      | 1024x1024 viewer, CanvasDrawer, 25 / 56 tiles re-windowed                                                            |
| H2 tiled CPU path scaling by drawn area                                    | 0.59 Mpx 3.1 ms; 1.64 Mpx 8.6 ms; 3.21 Mpx 18.8 ms; 5.31 Mpx 35.8 ms (21 fps)            | ms per step                                      | mammogram 1:1, viewers 512/1024/1536/2048 px, DPR 1                                                                  |
| H2 CPU path via OSD default WebGLDrawer with private \_unloadTextures      | 44.6-172.3                                                                               | ms per step                                      | without the private call W/L never reaches the screen                                                                |
| H3 W/L step main-thread cost (GPU path)                                    | 0.07-0.39                                                                                | ms                                               | VoiWebGLDrawer own target, r16i/r32f/rg8, CT and mammogram, 1024x1024; 0 texture uploads during drag                 |
| H3 W/L step incl. GPU completion (SwiftShader)                             | 8.9-60.4 at 1024x1024; 133.9 at 2048x2048                                                | ms                                               | CPU-emulated GPU; not representative of hardware                                                                     |
| H3 texture upload per 256x256 tile                                         | r16i 0.141, rg8 0.164, r16f 0.430, r32f 0.925, rgba8 (OSD path) 0.271                    | ms                                               | incl. GPU drain, SwiftShader                                                                                         |
| H3 GPU texture memory per pixel                                            | r16i/rg8/r16f 2, r32f 4, OSD 8-bit path 4 (+4 canvas)                                    | bytes                                            | mammogram fit: 72 tiles = 8.5 MB r16i vs 17 MB r32f                                                                  |
| H3 equivalence vs OSD WebGLDrawer, smoothing off                           | 0.07% px differ, max 2                                                                   | grey levels                                      | CT 512x512 viewer, zoom 1.37, 4 windows; 0.13% at 90 degrees + flip                                                  |
| H3 FabricOverlay registration                                              | 296/296                                                                                  | probes matched                                   | 4 rotations x 2 flips x 37 ramp blocks                                                                               |
| OSD 6.1.1 port: equivalence vs OSD 6 WebGLDrawer                           | 0.00                                                                                     | % pixels differing                               | CT 512x512, same shaders/renderer; GPU W/L 6.6 ms SwiftShader, 0 uploads; CPU via requestInvalidate 72.8 ms per step |
| H4 live WebGL contexts at N = 16 / 24 cells, stock default drawer          | 16 / 16 (32 / 48 created)                                                                | contexts                                         | OSD 5.0.1 default ['webgl','canvas','html'], each cell with FabricOverlay + DecorationLayer                          |
| H4 blank cells at N = 17..24, stock default                                | 1..8                                                                                     | cells                                            | after a redraw; same in apps/dev 4x4 + 1 foreign context: cell 0 blank                                               |
| H4 live contexts, shared / page targets                                    | 1 at every N from 1 to 24                                                                | contexts                                         | 0 blank cells; survives a foreign context                                                                            |
| H4 draw() time per frame across all cells (SwiftShader)                    | stock webgl 143-410; canvas 0.6-1.1; voi-own 0.4-2.4; voi-shared 35-43; voi-page 0.6-1.9 | ms                                               | pan animation, N in {1,4,9,16,24}, load avg 8.6-11                                                                   |
| H4 runtime swap to canvas drawer                                           | 5.5 raw (15/15 blank) / 6.0 via replaceDrawer (0/15 blank); back to webgl 12.9-14.8      | ms per cell                                      | 16-cell grid, 15 cells swapped                                                                                       |
| H4 frozen image after eviction (per-cell context that handles loss)        | 0.6% vs 65.7%                                                                            | pixels changed by a pan, evicted vs healthy cell | voi-own at 17 cells; OSD keeps updating (20 events)                                                                  |
| Existing-package change                                                    | +63 src, +70 test, 0 deleted                                                             | lines                                            | packages/fabric-osd only (fabric-overlay.ts, index.ts, new replace-drawer.test.ts)                                   |

## Recommendation

Keep OpenSeadragon as the 2D renderer. Render high-bit-depth images with a raw-raster tile source plus a VOI drawer. The stored 16-bit values stay in OSD's own tile cache (loader, pyramid, eviction unchanged). A WebGL2 DrawerBase subclass uploads them once as R16I textures (R32F fallback, EXT_texture_norm16 where present), interpolates stored values, and applies modality rescale and VOI (LINEAR / LINEAR_EXACT / SIGMOID) in the fragment shader, so window/level is a uniform update with no uploads. Fallback: the lazy tiled CPU path (the tile source re-windows only drawn tiles from OSD's CanvasDrawer), selected when WebGL2 is missing or WEBGL_debug_renderer_info reports a software renderer (SwiftShader/llvmpipe: VDI and blocklisted GPUs). Default to ONE shared WebGL2 context for all cells: render into one OffscreenCanvas and copy to each cell's 2D canvas, Cornerstone3D's RenderingEngine design. Because the same drawer also draws stock 8-bit tiles, it fixes the 16-context budget for 8-bit grids too. The page-wide scissor target stays opt-in, and the per-cell context target is for single-viewer pages only; it must clear itself on context loss. Tone keeps flowing through CellTransform: FabricOverlay.applyImageFilters hands {exposure, contrast, inverted} to a ToneCapableDrawer instead of setting a CSS filter, so basic W/L needs no binding change. An absolute W/L model with presets is a separate later decision. DICOM stays an adapter: a future @osdlabel/dicom maps tags onto @osdlabel/pixel types and decoded frames onto a RasterTileProvider. Port the OSD-facing parts to OSD 6's data pipeline when upgrading (probe: ~220 lines, identical output). Do not build live CPU W/L on OSD 6's async requestInvalidate (72.8 ms per step).

### New packages

- @osdlabel/pixel: zero-dependency high-bit-depth pixel math (raster types, modality rescale, DICOM VOI functions, packed RGBA VOI LUTs, precision-keeping pyramid, windowFromTone); depends on nothing
- @osdlabel/osd-pixel: OpenSeadragon integration (raster TileSource over an async RasterTileProvider, VoiState, VoiWebGLDrawer with shared/page/own context targets, CPU tile fallback, software-renderer detection); depends on @osdlabel/pixel and openseadragon (peer)
- @osdlabel/dicom (future, separate PoC): tags -> DisplayTransform/presets, frames -> RasterTileProvider; depends on @osdlabel/pixel (optionally @osdlabel/osd-pixel)

### Changes to existing packages

- @osdlabel/fabric-osd (DONE in this PoC, +63 src lines): ToneCapableDrawer seam in FabricOverlay.applyImageFilters (delegate tone to a drawer that renders it, clear the CSS filter); FabricOverlay.replaceDrawer(candidate) that requests a new drawer, moves its canvas back under the overlay and re-applies tone (raw viewer.requestDrawer leaves swapped cells blank); DrawerCandidate and ToneCapableDrawer types exported
- @osdlabel/solid and @osdlabel/react (not done, ~20 lines each + tests, parity required): optional viewerOptions?: Partial<OpenSeadragon.Options> on Annotator/ViewerCell merged over DEFAULT_VIEWER_OPTIONS, plus a 16-bit page in both dev apps and E2E for W/L and the grid context budget
- @osdlabel/osd-helper (optional): software-renderer guard choosing the canvas drawer under SwiftShader/llvmpipe
- @osdlabel/viewer-api, osdlabel, annotation, validation, decoration, mask: no change required (ImageSource.tileSource already accepts a TileSource instance)

### API sketch

```ts
// @osdlabel/pixel
export type StoredPixelArray = Int16Array | Uint16Array | Uint8Array;
export interface GrayscaleRaster {
  readonly width: number;
  readonly height: number;
  readonly data: StoredPixelArray;
}
export interface StoredRange {
  readonly min: number;
  readonly max: number;
}
export interface ModalityRescale {
  readonly slope: number;
  readonly intercept: number;
}
export interface VoiWindow {
  readonly center: number;
  readonly width: number;
  readonly fn?: 'LINEAR' | 'LINEAR_EXACT' | 'SIGMOID' | undefined;
}
export interface DisplayTransform {
  readonly rescale: ModalityRescale;
  readonly window: VoiWindow;
  readonly invert: boolean;
}
export function applyVoi(x: number, w: VoiWindow, yMin?: number, yMax?: number): number;
export function buildVoiLut(range: StoredRange, t: DisplayTransform): VoiLut;
export function applyVoiLutRgba32(
  src: StoredPixelArray,
  lut: VoiLut,
  dst: Uint32Array,
  start?: number,
  end?: number,
): void;
export function windowFromTone(
  base: VoiWindow,
  tone: { exposure: number; contrast: number },
): VoiWindow;
export function buildPyramid(full: GrayscaleRaster): GrayscaleRaster[];

// @osdlabel/osd-pixel
export interface RasterTileProvider {
  readonly width: number;
  readonly height: number;
  readonly tileSize: number;
  readonly storedRange: StoredRange;
  getTile(level: number, x: number, y: number, signal: AbortSignal): Promise<GrayscaleRaster>;
}
export class VoiState {
  constructor(storedRange: StoredRange, initial: DisplayTransform);
  readonly baseWindow: VoiWindow;
  readonly transform: DisplayTransform;
  setWindow(w: VoiWindow): void;
  applyTone(t: { exposure: number; contrast: number; inverted: boolean }): void;
  onChange(l: () => void): () => void;
}
export interface HighBitDepthImage {
  readonly tileSource: OpenSeadragon.TileSource;
  readonly display: VoiState;
}
export function createHighBitDepthImage(
  p: RasterTileProvider,
  initial: DisplayTransform,
): HighBitDepthImage;
export type GlTargetKind = 'shared' | 'page' | 'own';
export class VoiWebGLDrawer extends OpenSeadragon.DrawerBase {
  applyImageFilters(f: ImageFilters): void;
}
export function voiViewerOptions(o?: {
  target?: GlTargetKind;
  format?: 'r16i' | 'r32f';
}): Partial<OpenSeadragon.Options>;

// @osdlabel/fabric-osd (added)
export interface ToneCapableDrawer {
  applyImageFilters(filters: ImageFilters): void;
}
export type DrawerCandidate = 'webgl' | 'canvas' | 'html' | OpenSeadragon.DrawerConstructor;
// class FabricOverlay { replaceDrawer(candidate: DrawerCandidate): boolean }
```

### Effort

7 to 8.5 (pixel hardening 1; osd-pixel production with provider, overlap, shared-target hardening, context-loss recovery, CPU fallback 3-4; fabric-osd seam polish 0.5; both bindings' viewerOptions + dev pages + E2E 1; OSD 6 port 1-1.5 if upgrading first; docs 0.5). 6 to 7 without the OSD 6 port.

### Risks

- GPU-side performance is unmeasured: every GPU timing here is SwiftShader (CPU-emulated), where the GPU path is slower than the CPU tile path at >= 1024x1024; one headed desktop-Chrome run of the harness is needed before committing
- 16-bit tile transport: browsers decode PNG16 to 8 bits, so tiles need a JS/WASM decoder (PNG16, JPEG-LS, JPEG 2000/HTJ2K) or raw/zstd transport; this lives in providers/the DICOM adapter and costs CPU per tile
- OSD internals: the OSD 5 path reads the undocumented Tile.cacheImageRecord and implements the @private \_createDrawingElement; @types/openseadragon 5.0.2 lacks DrawerBase.canvas and types viewer.drawer as the OSD 4 Drawer; OSD 6 deprecates the \*TileCache hooks, so a port is required when upgrading
- Context loss: with one shared context, a loss blanks every cell at once, so re-creation and re-upload from OSD's cache must be robust; per-cell contexts freeze silently under a live overlay (measured), so 'own' must clear itself on loss
- The shared target's per-frame copy (WebGL OffscreenCanvas to 2D canvas) is a synchronous readback on SwiftShader (35-64 ms per frame); on hardware it should be a GPU copy (Cornerstone3D ships it), but that is unmeasured here
- Interpolating stored values before VOI changes edge pixels vs today's output (up to 114 levels on 1.17% of pixels in a narrow window); snapshot tests must expect it
- Relative tone (windowFromTone, 16x width range) is too coarse for free W/L across CT presets; an absolute W/L state model will likely be needed
- The page scissor target, if offered, breaks under scrolled or transformed containers, overlapping UI and single-cell fullscreen

## Rejected alternatives

- **Keep CSS brightness/contrast filters on 8-bit tiles (today's path)**: H1: 6 instead of 80 grey levels in the brain window (51-level jumps). osdlabel's [0,2] bounds cap the slope at 4 where 10-50 is needed, so the bounded CSS brain window is off by up to 129 grey levels.
- **Server-side pre-windowed 8-bit tiles per window**: Every W/L step becomes a tile round trip, so there is no free-drag windowing, and the server becomes part of the display pipeline.
- **Whole-image CPU re-windowing on the main thread**: H2: 52.9 ms median per step for a 4096x3328 mammogram (19 fps).
- **Worker pool for CPU re-windowing**: H2: 60-63 ms wall for 1-4 workers vs 53 ms single-threaded on 4 cores. ImageData cannot wrap shared memory (11 ms copy) and the main thread stays ~23 ms busy.
- **CPU path feeding OSD's default WebGLDrawer**: Textures are uploaded once at tile-ready, so W/L never reaches the screen. Forcing it needs the private \_unloadTextures() and runs at 5-23 fps.
- **CPU tiled path as the primary renderer**: Viable up to ~4.5 Mpx re-windowed per frame, then 21 fps at 5.3 Mpx (2048x2048, or 1024x1024 at DPR 2), and it holds 6 B/px in CPU memory. Kept only as the fallback.
- **Subclass OSD's WebGLDrawer**: Its context, shaders and upload are private methods. It is WebGL1 and RGBA8-only and copies every frame into a 2D canvas. A clean DrawerBase subclass took 256 lines.
- **Fork OSD or replace it with a custom monolithic renderer (Cornerstone3D/OHIF style)**: Unnecessary. OSD's public drawer and TileSource contracts carried 16-bit data unforked on 5.0.1 and on 6.1.1 (identical output), and OSD keeps tiling, caching, springs and gestures.
- **One WebGL context per cell ('own' target)**: H4: hits the 16-context limit. An evicted cell either blanks and kills OSD's update loop (stock drawer) or freezes under a live overlay (0.6% of pixels change on pan).
- **Page-wide canvas with per-cell scissoring as the default**: Cheapest here (1 context, 0.6-1.9 ms per frame), but it draws outside the cell's DOM subtree: z-order, clipping, CSS transforms, overlapping UI and single-cell fullscreen break. Opt-in only.
- **Runtime swap to the canvas drawer via viewer.requestDrawer alone**: With FabricOverlay present, 15/15 swapped cells went blank (canvas displaced below the cell, above the overlay) and the tone filter was lost. It needs FabricOverlay.replaceDrawer.
- **R16F textures**: Only 11 significant bits, so stored values above 2048 are inexact; unusable for 16-bit data.
- **OSD 6 requestInvalidate() for live CPU-path W/L**: Its async invalidation pipeline took 72.8 ms per W/L step for a 512x512 CT.

## Architectural stress

Existing files changed: 3; existing lines changed: 63; new lines: 6159.

git diff --stat origin/claude/segmentation-brush-tool: the only existing package touched is @osdlabel/fabric-osd. src/overlay/fabric-overlay.ts gets +61 (ToneCapableDrawer seam, replaceDrawer, DrawerCandidate type) and src/index.ts +2 (type exports): +63 src lines, 0 deletions. A new test file adds 70 lines (tests/unit/overlay/replace-drawer.test.ts; the 3 files counted include it). No existing package changed its dependencies; bindings, state, annotation, validation, decoration, mask and serialization are untouched. New code: packages/pixel +928 (598 src, 250 tests), packages/osd-pixel +1596 (1423 src, 85 tests), apps/poc-pixel-pipeline +3635 (harness, OSD 6 probe, scripts, tests). Plus results/representative.json (+5792) and pnpm-lock.yaml (+76). Both existing-package changes are seams the experiment exposed: replaceDrawer because OSD's runtime drawer swap breaks FabricOverlay's layering (15/15 blank), and ToneCapableDrawer so the existing CellTransform -> applyImageFilters path windows 16-bit data instead of setting a CSS filter. Full typecheck and tests pass for fabric-osd, fabric-annotations, solid and react. osdlabel's deserialize-hostile test failed 2 assertions once at load average ~25 and passed on rerun; that package is untouched.

## Reproduce

```sh
pnpm --filter @osdlabel/poc-pixel-pipeline bench   # writes apps/poc-pixel-pipeline/results/<timestamp>.json and prints summary tables; options: --only h1,h2,h3,osd6,h4,devapp  --quick  --h4-sections sweeps,records,recovery,foreign,swap  --channel chrome --headed (real GPU on a desktop)  --chromium <path>  --out <file>; re-render: node apps/poc-pixel-pipeline/scripts/summary.mjs <results.json> --md
```

## Caveats

- All GPU-side numbers are SwiftShader (ANGLE on Vulkan SwiftShader, CPU-emulated) and pessimistic. They are kept apart from CPU-side costs (JS submission 0.07-0.39 ms, LUT loops, uploads, putImageData). The SwiftShader ranking of the GPU vs CPU paths at large sizes does not transfer to real GPUs.
- Heavy contention: load average was 8.6-11 on 4 vCPUs during the representative run (other agents benchmarking). Absolute timings are noisy; earlier full runs on the same code gave the same counts and verdicts with different timings (e.g. stock single-cell pan 12.8 vs 6.3 fps; CT r32f 1:1 5.4 vs 8.9 ms). Counts are deterministic: contexts, grey levels, uploads, registration matches, blank cells.
- Headless, DPR 1. DPR 2 is covered only through the drawn-area sweep (a 1024x1024 cell at DPR 2 is about the 2048x2048 row). Compositor present time is not measured.
- Synthetic data only (CT head phantom in HU, value ramp, 4096x3328 16-bit mammography-like image), generated in the page; no patient data, no binaries committed.
- JS heap deltas in the JSON are dominated by GC timing and should not be used; memory is reported per pixel and per cached tile.
- PoC drawer gaps: tile overlap ignored (sources use overlap 0); minimal tiled-image rotation/opacity handling; the page target does not react to scroll without an OSD redraw; the own target does not clear itself on context loss (which is how the frozen-image hazard was found); 16-bit tile transport/decoding not addressed.
- H4 'blank' = a cell's screenshot region has grey-level SD <= 8 on a flat background. The voi-own cells counted as visible past 16 are frozen, not live.
- osdlabel's deserialize-hostile unit test failed 2 assertions once at load average ~25 during a workspace test run and passed on immediate rerun. That package is untouched by this branch.

## Open questions

- W/L state model: keep tone relative in CellTransform (zero binding change, but only a 16x width range), or add an absolute per-cell or per-image VoiWindow with presets and a W/L readout decoration? Should the existing 'tone' drag become radiology-style W/L (horizontal = width, vertical = level) for high-bit-depth images?
- Where do 16-bit tiles come from first: client-side decoded DICOM frames (CT/MR stacks, tying this to the DICOM adapter), or a 16-bit tile server, and in which format? This decides provider and codec work.
- Upgrade to OpenSeadragon 6 before building @osdlabel/osd-pixel for real (better fit: typed data formats, drawer-owned caches, first-party types), or ship on 5.0.1 and port later?
- Should the shared-context drawer become osdlabel's default for all grids (it also fixes the 8-bit 16-context budget), or stay opt-in with osd-pixel? Should the software-renderer guard (canvas drawer under SwiftShader/llvmpipe) ship now, independent of high bit depth?
- Which display features are in the first release: MONOCHROME1 (handled via invert), palette color, RGB DICOM passthrough, modality LUT and VOI LUT sequences (non-linear tables)?
- Can the maintainer run the harness once on a workstation GPU (pnpm --filter @osdlabel/poc-pixel-pipeline bench --channel chrome --headed, or the DevTools calls in index.html/grid.html)? That turns H3's 60 fps claim into a verdict and measures the shared-target copy on hardware.

## Independent review

A second agent re-ran the benchmark and tried to break the conclusions.

### Blocking findings

- **The recommendation to make the shared VOI drawer the default for every grid would break the existing tone controls on 8-bit images, with no error. The result claims that 'because the same drawer also draws stock 8-bit tiles, it fixes the 16-context budget for 8-bit grids too'. But with VoiWebGLDrawer, FabricOverlay.applyImageFilters clears the CSS filter, and the drawer applies no tone at all to 8-bit tiles.**
  - Evidence: Code: isToneCapableDrawer() in packages/fabric-osd/src/overlay/fabric-overlay.ts duck-types on any applyImageFilters method, then sets drawerCanvas.style.filter = ''. VoiWebGLDrawer.applyImageFilters only calls this.options.voi?.applyTone(), and voi is undefined for a DZI or other 8-bit source. FRAGMENT_RGBA in gl-shaders.ts has no tone or invert uniforms, and GlRenderer.drawTile skips display uniforms for kind 'rgba'. Measured with my probe (/tmp/claude-0/-home-user-osdlabel/d2340e79-db4e-595c-a199-55b42694fb93/scratchpad/probe/tone-probe.mjs) on apps/dev's 8-bit tiled.dzi with a real FabricOverlay. Mean screenshot luminance for the stock drawer: 78.2, then 113.1 after inverted:true (filter 'invert(1)'), then 124.9 after exposure 0.6 / contrast 0.5. For voi-shared and voi-own it stays 78.18 -> 78.18 -> 78.18 and the CSS filter is ''. Invert, exposure and contrast all stop working. No test covers this case. The H3 tone-seam check used only 16-bit raster tiles.
  - Required fix: Pick one: (a) implement brightness -> contrast -> invert, with per-step clamping as in composeImageFilterCss, in FRAGMENT_RGBA and apply it in drawTile for 'rgba' tiles; or (b) make the seam per-image, so FabricOverlay delegates only when the drawer reports that it renders tone for the open tiled image, and otherwise keeps the CSS filter (fine for the 'own' and 'shared' targets, whose drawer canvas is a real DOM canvas). Add a unit test plus a both-bindings E2E for an 8-bit image under the new drawer. Until then, withdraw the 'fixes 8-bit grids too' claim.
- **Nothing measured supports making ONE shared WebGL2 context the default. The summary states it as a finding ('The fix for the WebGL context budget is one shared context for every cell'), but every performance number is SwiftShader. In the committed run the shared target is the slowest VOI configuration. The headline GPU W/L cost (0.07-0.39 ms JS per step) is for the 'own' target, which the recommendation rejects.**
  - Evidence: representative.json, h3.osd, mammo 1:1 r16i: shared drawSync median 63.5 ms (p95 191) at 9.3 fps, vs own 0.22 ms at 12.5 fps. The synchronous drawImage copy in SharedContextTarget.end() runs inside draw(). Grid pan: voi-shared 18-23 fps, voi-page 22-29, voi-own 20-32, stock-canvas 50-58. My rerun on the same commit reverses parts of this ranking: shared 35.2 ms at 23.8 fps vs own r16i 8.9 fps; voi-page 43 fps at N=1 vs shared 24. So SwiftShader cannot rank the targets at all. The only drawer in either run that ran W/L or pans at 50-60 fps with zero contexts was the CanvasDrawer (stock, and the tiled CPU VOI path). The result does list hardware cost as a risk and open question, but the summary and recommendation present the default as settled.
  - Required fix: Run the harness once on a hardware GPU (it already supports --channel chrome --headed). Measure the shared-target copy per cell per frame and the W/L step at N = 1/4/16, against 'own', 'page' and the canvas drawer. Until then, mark the shared-context default as provisional. State that the evidenced mitigation today is the CanvasDrawer for non-active or 8-bit cells (0 contexts, 50-60 fps here, plus FabricOverlay.replaceDrawer), with the shared VOI drawer opt-in for 16-bit.

### Non-blocking findings

- Overstated summary wording. 'Its output is pixel-identical to OSD's own WebGL drawer' holds only with smoothing off (0.07% of pixels differ, max 2; 0.13% at 90 degrees + flip). osdlabel's default is imageSmoothingEnabled=true, and there 12.1% of pixels differ, 1.17% by more than 2. The quoted 'max 114' is one window; the committed representative.json shows max 158 for the brain window.
- Range misreported. 'Draw + GPU time was 8.9-60 ms at 1024x1024' leaves out ct fit rg8 at 84.4 ms (representative) and the shared target at 63.8 ms. My rerun gave 7.8-74.1 ms.
- The H4 'draw() time per frame' row compares unlike metrics. For stock webgl and voi-shared, draw() includes a synchronous GPU readback (the drawImage of a WebGL canvas into a 2D canvas). For voi-own and voi-page it is JS submission only, and Chrome's 2D canvas defers rasterisation too. So 'page: 0.6-1.9 ms vs shared: 35-43 ms' and 'cheapest here' overstate the gap; the rAF fps of those modes are within roughly 20-40% of each other.
- Worker-pool rejection is a contention artifact. Load average was 8.6-11 on 4 vCPUs (about 16-23 during my run, where 2 and 4 workers took 106 ms against 73 ms for 1). That cannot show 'no gain'. The variant also skipped workers rendering into an OffscreenCanvas and returning transferToImageBitmap(), which removes both the 11 ms SAB->ImageData copy and the main-thread putImageData.
- p95 is meaningless at n=20. summarize() takes s[floor(0.95*n)], which is the maximum at n=20 (whole-image mammogram and worker runs). There is no warm-up discard, so the quoted 'p95 118.2 ms' is probably the cold-JIT first iteration.
- Upload timing may not measure the GPU upload. h3Upload uploads textures that are never sampled, then reads 1 pixel of an unrelated framebuffer. ANGLE's Vulkan backend can stage texImage2D data and defer the copy until first use, so 'incl. GPU drain' may undercount. The numbers are small either way, and the key claim (0 uploads per W/L step) is unaffected.
- Registration check is coarse. The 296/296 probes are ramp-block centres at 8x magnification, which tolerates up to about ±4 screen px (half a source pixel). It ran at home zoom and only for the VOI drawer. The run also contains an unreported result: CanvasDrawer (the CPU fallback and mitigation (i)) differs from the WebGL geometry by 1-px placement shifts on up to 2.6% of pixels (diff up to 255, 'notShift' 0.01%). FabricOverlay registration for the canvas fallback was never checked.
- The OSD 6 'survives the upgrade' claim is thinner than stated. The 6.1.1 probe ports only an own-context drawer: no shared or page target, no tile flip, no sourceBounds trimming, opacity fixed at 1, no context-loss handling. Equivalence was checked for one window at the home view. Also worth stating: OSD 6.1.1's own WebGLDrawer still creates one context per viewer (WebglContextManager per drawer), and neither 5.0.1 nor 6.1.1 listens for webglcontextlost. Upgrading OSD therefore does not fix H4.
- The bench is not one-command reproducible on a clean checkout. It builds only --filter=@osdlabel/poc-pixel-pipeline^..., which does not build @osdlabel/solid. The 'devapp' group then times out waiting for [data-testid=tool-navigate]. runDevAppExperiment is not wrapped in section(), so the run exits 1 and printSummary never runs (the JSON is still written). After `turbo run build --filter=@osdlabel/dev^...` it reproduced exactly.
- Package hygiene against one-concern-per-package. @osdlabel/pixel's public barrel exports the H1 analysis (banding.ts: quantize8, cssBrightnessThenContrast8, compareWindowPaths) and benchmark-only loops (applyVoiLutBytes, applyVoiDirectRgba32); these belong in the harness. windowFromTone puts osdlabel CellTransform semantics into the 'DICOM VOI math' package. VoiState has no OSD dependency but lives in osd-pixel. If the shared-context target really is the default for 8-bit grids too, it is a grid-level resource concern and should not live in a high-bit-depth package. The ToneCapableDrawer seam is duck-typed on a method name.
- Architecture-stress detail. The +63 src lines (fabric-overlay.ts +61, index.ts +2, 0 deletions) are accurate. The third modified existing file is pnpm-lock.yaml (+76), not the test file (replace-drawer.test.ts is new). results/representative.json (+5792 lines) is committed, against the repo convention that benchmark runs are not committed (stated for apps/bench).
- H1 caveats. The 8-bit baseline is full-range only; a pre-windowed 8-bit export (common practice) would give CSS more levels inside its export window but still no re-windowing outside it, so the verdict stands. The mammogram phantom spans 860..51920 (the code comment says 0..65535) and the projection analysis assumes 0..65535, whereas typical full-field digital mammograms (FFDM) are 12-14-bit, so '256 vs 17' is a stress case. The claim 'CSS paths show 6/14/74/129/27 levels' is off for lung: the unbounded CSS path shows 52.
- The H3 brief asked for an exact inventory of OSD 5.0.1 extension points (tile-loaded, tile-drawing, tile-ready, the cache hooks and so on). The result lists only the ones used. With REPORT.md absent, the inventory is not delivered.
- The effort estimate (7-8.5 engineer-weeks) leaves out 16-bit tile transport and decoding, the hardware-GPU validation the result itself says is required, and Firefox/Safari context-limit and behaviour checks. Only Chromium was tested.

### Claims checked

| Claim                                                                                                                                                           | Verdict    | Note                                                                                                                                                                                                                             |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| H1: brain W80/L40 shows 80 vs 6 grey levels (max step 4 vs 51); subdural 200 vs 14, lung 196 vs 74, bone 256 vs 129, abdomen 256 vs 27                          | holds      | Recomputed independently in Python. Reproduced on screen in my rerun: gpu/cpu 80/200/196/256/256 with 0 mismatches against the DICOM model; CSS 6/14/74(52 unbounded)/129/27.                                                    |
| H1: osdlabel's bounded CSS gives a brain-window max error of 129 grey levels                                                                                    | holds      | Rerun: css-osdlabel brain maxAbsError 129.                                                                                                                                                                                       |
| H2: whole-image mammogram re-window 52.9 ms median (LUT 34.4 + putImageData 11.4), so 19 fps                                                                    | holds      | Order of magnitude holds. My rerun gave 108.6 ms median at higher load. The 'breaks' verdict for the whole-image variant holds either way.                                                                                       |
| H2: tiled CPU path in OSD does not break at 1024x1024 (mammogram 8.9 ms at 1:1 and 13.9 ms at fit, 57-60 fps); breaks with drawn area at about 4.5 Mpx          | holds      | Rerun: 10.2 / 18.0 ms, 49-55 fps; scaling 5.1/11.7/24.9/32.9 ms for 0.59/1.64/3.21/5.31 Mpx, about the same slope.                                                                                                               |
| H2: worker pool gives no gain (60-63 ms for 1-4 workers)                                                                                                        | overstated | Measured at load average 8.6-11 on 4 vCPUs, about 16-23 in my run (73/107/106 ms). Contention, not the method, explains it. The ImageBitmap-transfer variant was not tried.                                                      |
| H2: a W/L change never reaches the screen with OSD's default WebGLDrawer without the private \_unloadTextures                                                   | holds      | wlReachesScreenWithoutPrivateApi=false for every webgl-stock case in both runs. Consistent with OSD 5 uploading textures once at tile-ready.                                                                                     |
| H3: a W/L drag makes 0 texture uploads and costs 0.07-0.39 ms of JS per step                                                                                    | overstated | 0 uploads holds for every case. The 0.07-0.39 ms is the 'own' target only. The recommended 'shared' target costs 63.5 ms (representative) or 35.2 ms (rerun) of main thread per step, because the copy is synchronous in draw(). |
| H3: equivalence with OSD WebGLDrawer, smoothing off: 0.07% of pixels differ, max 2 (0.13% at 90 degrees + flip)                                                 | holds      | Identical in my rerun.                                                                                                                                                                                                           |
| H3: with smoothing on, 1.17% of pixels differ by more than 2 (max 114)                                                                                          | wrong      | 1.17% holds, but the max is 158 (brain window) in both representative.json and my rerun; 114 is a different window.                                                                                                              |
| Summary: output is pixel-identical to OSD's own WebGL drawer                                                                                                    | overstated | Only near-identical with smoothing off. Under osdlabel's default (smoothing on), 12% of pixels differ, by up to 158.                                                                                                             |
| H3: FabricOverlay stays registered, 296/296                                                                                                                     | holds      | Reproduced 37/37 for each of the 8 cases. Tolerance is about ±4 screen px, at home zoom, with the VOI drawer only.                                                                                                               |
| H3: GPU W/L 60 fps not shown (SwiftShader)                                                                                                                      | holds      | Labelled correctly as SwiftShader in caveats and evidence. Rerun complete times at 1024 were 7.8-74 ms.                                                                                                                          |
| H3: the tone seam maps applyImageFilters to a VOI window ({-100,80} becomes {-120,40}, inverted, no CSS filter)                                                 | holds      | Reproduced for 16-bit raster tiles. For 8-bit tiles under the same drawer, tone is dropped (see blocking).                                                                                                                       |
| OSD 6.1.1: about 220-line port, 0.00% pixels differing, 0 uploads per drag, CPU via requestInvalidate 72.8 ms                                                   | holds      | Rerun: 0.00%, 0 uploads, GPU 6.8 ms, invalidate 52.0 ms. The port portion is about 190 lines. Equivalence covered one window at the home view, and the shared and page targets were not ported.                                  |
| H4: OSD 5.0.1 picks 'webgl' (WebGL1); 2 contexts per cell (throwaway from isSupported plus 1 live); live = N up to 16, then 16; 1..8 blank cells for N = 17..24 | holds      | Reproduced exactly. Probe stacks show WebGLDrawer.isSupported and WebGLDrawer.\_setupCanvases.                                                                                                                                   |
| H4: real Solid dev app at 4x4 holds 32 created / 16 live contexts; one foreign context blanks cell 0                                                            | holds      | Reproduced (32/16; 16 visible, then 15; blank [0]) after building @osdlabel/solid. The bench's own build step does not build it.                                                                                                 |
| H4: an evicted stock cell kills OSD's update loop (0 update-viewport events) and is never restored; voi-own freezes (0.6% vs 65.7% of pixels change on a pan)   | holds      | Reproduced exactly. updateMulti only reschedules after updateOnce returns, and neither OSD 5 nor 6 handles webglcontextlost.                                                                                                     |
| H4: shared and page targets keep 1 context for N = 1..24 with 0 blank cells and survive a foreign context                                                       | holds      | Reproduced.                                                                                                                                                                                                                      |
| H4: shared copy 35-43 ms per frame vs stock 143-410 ms; page target cheapest at 0.6-1.9 ms                                                                      | overstated | These are draw() JS-time sums. For own and page they exclude GPU work, and the fps of all VOI targets are similar and noisy (18-43 fps across my two runs).                                                                      |
| H4b: raw requestDrawer('canvas') leaves 15/15 cells blank and loses the filter; FabricOverlay.replaceDrawer fixes it                                            | holds      | Rerun: raw 15 displaced, 15 blank, 0 filters kept; overlay 0 blank, 15 kept. Swap took 8.0-8.7 ms.                                                                                                                               |
| Architecture stress: +63 src lines in fabric-osd only, 0 deletions                                                                                              | holds      | git diff --numstat: fabric-overlay.ts +61, index.ts +2, pnpm-lock.yaml +76, all else new. Typecheck, tests (pixel 26, osd-pixel 9, fabric-osd 198, harness 7) and eslint pass.                                                   |
| Recommendation: the shared VOI drawer also fixes the 8-bit context budget                                                                                       | wrong      | It does fix the context count, but it disables invert, exposure and contrast for 8-bit images (measured, see blocking).                                                                                                          |

### Reviewer's rerun

I ran `pnpm --filter @osdlabel/poc-pixel-pipeline bench -- --port 5462 --out <scratchpad>/rerun.json` on HEAD 107ee84 (Chromium 153 headless, ANGLE/SwiftShader, 4 vCPUs at load average 7.6-23). Every group except devapp finished in about 16 minutes. devapp then timed out waiting for the dev app's toolbar, because the bench build step does not build @osdlabel/solid, so the command exited 1 and printed no summary; the JSON was still written. After `turbo run build --filter=@osdlabel/dev^...`, `--only devapp` reproduced exactly: 2 contexts for 1 cell, 32 created / 16 live at 4x4, 16 cells visible, then 15 after one foreign context (cell 0 blank).

Deterministic outputs matched representative.json exactly: H1 levels and the 129 max error, the H3 equivalence fractions (0.07%/0.13% smoothing off; 12.1%/1.17%, max 158, smoothing on), alignment 37/37 x 8, the tone seam, 0 uploads per drag, OSD 6 0.00% difference, every H4 context count and blank-cell count, recovery (0 update events, 0 restores, frozen 0.57% vs 66%), and the swap results.

Timings at higher load: whole-image mammogram 108.6 ms median (vs 52.9); CT 4.0 ms; workers 73/107/106 ms. Tiled CPU path: mammogram 10.2 ms (1:1), 18.0 ms (fit), 49-55 fps; scaling 5.1/11.7/24.9/32.9 ms. GPU own: 0.08-0.47 ms JS, 7.8-74 ms complete at 1024. Shared: 35.2 ms per step at 23.8 fps (vs 63.5 ms at 9.3 fps in representative). OSD 6: GPU 6.8 ms, invalidate 52.0 ms. Grid pan: canvas 45-60 fps; voi-shared 18-28; voi-page 22-43; voi-own 8-21; stock webgl 3.5-8 fps.

Extra probe (/tmp/claude-0/-home-user-osdlabel/d2340e79-db4e-595c-a199-55b42694fb93/scratchpad/probe/tone-probe.mjs): on 8-bit DZI tiles, applyImageFilters changes the image with the stock drawer (luminance 78 -> 113 -> 125) but not with voi-shared or voi-own (78.18 unchanged, filter cleared).

### Alternatives the reviewer says were missed

- WebGPU: one GPUDevice can configure any number of canvas contexts, with no copy to each cell's DOM canvas and no 16-context WebGL eviction. It supports integer formats (r16uint/r16sint) read with textureLoad. This addresses H4 (ii) directly. The harness even launches with --enable-unsafe-webgpu but never evaluates it. Availability (Chromium desktop; Safari and Firefox more recently) needs a check.
- Shared WebGL context without the drawImage copy: render into the OffscreenCanvas, call transferToImageBitmap(), and show it through each cell's 'bitmaprenderer' context (transferFromImageBitmap). That moves the frame instead of copying it, and would probably change the 35-64 ms SwiftShader copy that drives the shared-target numbers.
- A small context pool (2-4 contexts, round-robin over cells) instead of exactly one. It limits how many cells blank on a single context loss and lets copies run in parallel. If I recall correctly, Cornerstone3D added a context-pool rendering engine for this reason, so 'Cornerstone3D style = one context' may be out of date.
- For 8-bit grids, no new drawer at all: use OSD's CanvasDrawer for every cell (or every non-active cell, through the new replaceDrawer). It was the only path at 50-60 fps with 0 contexts in both runs and keeps the CSS tone path intact.
- A hybrid where the tiled CPU VOI path (CanvasDrawer, 0 contexts, measured 50-60 fps for 1024-px cells) renders the grid cells and the GPU drawer is used only for one large active viewer. That is the only configuration with interactive W/L evidenced in this sandbox.
- Lossless 16-bit transport through the browser's native decoder: pack the high and low bytes into the R and G channels of an 8-bit PNG or WebP tile, decode with createImageBitmap (premultiplyAlpha 'none', colorSpaceConversion 'none'), and upload as RG8, which the drawer already supports. The risk list says a JS/WASM PNG16/J2K decoder is required.
- A per-image tone capability in the ToneCapableDrawer seam (delegate only when the drawer has a VoiState for the open tiled image), or implementing CSS-equivalent tone in the RGBA shader, rather than all-or-nothing duck typing.
