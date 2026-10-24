# Proof of concept: volumes, MPR and a 3D cell by composition

Branch `claude/poc-volume`, head `068616a573` at the time of the result. Part of the osdlabel roadmap study (branch `claude/osdlabel-roadmap-strategy-uut5ay`). Written by the orchestrating agent from the PoC agent's structured result, because PoC agents in this environment cannot write report files.

**Status:** Build, independent review and fix pass complete. The fix pass withdrew the label-map speed ratios (bricks are chosen on structure), narrowed the frame-rate claims (sagittal and oblique are borderline on CPU, the linked crosshair misses 30 fps), withdrew "one GPU copy" (Niivue is 3x the volume on the GPU, 4x with the WebGL reslicer), and made plane IDs reversible. GPU numbers are SwiftShader; a real-GPU run is pending.

## Summary

Volume PoC after the review-fix pass. It builds three framework-free leaf packages and one app. @osdlabel/spatial (zero dependencies) holds DICOM-style plane and volume geometry. @osdlabel/volume (depends only on spatial now) holds slice-wise int16 volumes, CPU reslicing, permuted copies and dense or sparse-bricked label maps. @osdlabel/mpr holds cross-view projection and reference lines as ordinary DecorationProviders, plus reversible plane ImageIds. apps/poc-volume adds a one-command Playwright benchmark, 4-cell MPR pages, stock Solid ViewerCells over planes, and a Niivue 3D cell.

Answer: yes by composition, with corrected and narrower numbers. The final run was at 69b4cbc on a 4-core Xeon @ 2.80GHz with no other benchmark running. Every canvas-drawer loop ran 3 times; figures are the median [range], with run 1 in parentheses.

What reaches 30 fps on CPU:

- pan-zoom: 60
- axial scroll: 50.7 [42.9-58.5] (55.4)
- coronal scroll: 43.9 [42.4-49.0] (52.9)
- sagittal scroll with a sagittal-major copy: 38.9 [31.3-51.4] (49.3). The copy costs +200 MiB of CPU memory and takes 1.06 s to build.

Borderline:

- sagittal scroll on slice-major storage: 31.0 [26.7-32.6] (29.4). The reslice takes 18.8 ms.
- oblique rotation: 30.6 [24.5-32.3] (30.8).

Misses:

- linked three-plane crosshair: 21.1 fps (21.2). With workers 21.6 (34.0), so not consistently better. With the sagittal copy 30.5 [25.4-31.2] (28.2), still borderline.
- any crosshair with 118 or more annotations: at most 27 fps.
- axial scroll at 518 annotations when every provider re-runs: 23.5 (26.6). Memoised cross-view plus the DecorationLayer skip brings it to 43.9 (40.7).

Label maps: the fair comparison uses the same span enumerator, a pre-touched dense map, rotated order and 24 reps. Dense, per-slice masks and the new 32^3 bricks paint within noise of each other, at 0.02-0.11 ms per stamp. The earlier "masks 2-8x slower" and "1.5-2.7x slower display" ratios are withdrawn. A committed dense map is 2.5-3.2x slower to display sagittally (26.9 vs 8.5 ms). Bricks use 3.0 MiB for 49,640 voxels against dense's fixed 100 MiB. The runtime label map is therefore bricked, chosen on structural grounds.

Memory: "one GPU copy" is withdrawn for the composition. Niivue alone allocates 3.0x the volume's bytes (R16I plus an RGBA8 gradient texture). Adding the WebGL2 reslicer gives 2 copies of the scalar data and 4.0x. With Niivue's drawing layer the total is 8.0x: 1,679,451,604 B tracked, in 2 contexts.

Context budget: stock ViewerCells use 1 WebGL context each with OSD's default drawer. At 20 cells, 16 contexts are live and 4 cells fail. OpenSeadragon.DEFAULT_SETTINGS.drawer = 'canvas' uses 0 contexts at 3, 8, 16 and 20 cells, at 60-38 fps.

Checks: cross-view 13/13 with both drawers, including the oblique plane-id round trip. The previous commit's check read geom.x where the geometry has geom.origin.x, so 4 of its checks had failed. Solid 10/10.

Existing packages: 6 source files changed, +43/-5. All GPU numbers come from SwiftShader.

## Hypotheses and verdicts

### H1a: partial

A 512x512x400 int16 volume (200 MiB, SharedArrayBuffer) reslices into orthogonal planes in under 10 ms on CPU.

Main-thread median ms, run 2 (run 1), 30 reps, Xeon @ 2.80GHz, no other benchmark on the host.

Same plane every rep (warm caches):

- axial: 1.81 (1.99)
- coronal: 7.66, p95 16.0 (3.90)
- sagittal: 14.09, p95 14.59 (14.85)

Scrolling, a different plane every rep:

- axial: 2.17 (2.26)
- coronal: 4.63 (4.67)
- sagittal: 15.36, p95 29.4 (18.22)

Axial and coronal pass. Sagittal on slice-major storage fails. Its x axis walks j with stride nx, so it is cache-hostile, and its p95 is tight on a quiet host. The earlier claim that sagittal met the target 'only on the quieter run' is withdrawn: this is the host, not contention.

Through a sagittal-major copy (permuteVolume, SAGITTAL_MAJOR), scrolling sagittal takes 6.24 ms (6.54), p95 9.2, with identical output (unit test). The copy is +200 MiB and takes 1.06 s (1.09) to build. 4 workers on slice-major storage give sagittal 12.23 ms (10.55). Absolute CPU numbers are host-dependent: the original report's 2.10 GHz host measured axial 1.16 ms.

### H1b: partial

Oblique planes reslice at interactive rates on CPU (trilinear, optionally in workers) and/or via WebGL2 3D-texture sampling (R16I or R32F).

CPU trilinear 512x512 at 0.7 mm:

- 14.35 ms median, p95 16.7, both runs
- nearest 7.55 ms
- scroll variant 12.29 ms

Worker pool, 1/2/4 workers: 15.75/13.24/9.32 ms (12.19/8.93/7.29), with 0 mismatched pixels.

WebGL2 under SwiftShader, draw+readPixels, axial/coronal/sagittal/oblique ms:

- r16i: 26.1/33.6/44.0/19.4
- r16f: 16.3/20.9/41.8/16.9
- r32f: 10.3/13.7/23.5/12.6
  Output is within 1 grey level of CPU after an 8-bit window (centre 40, width 400). That window cannot verify HU fidelity.

In the MPR cell (canvas drawer, 3 reps), rotate-oblique fps:

- CPU: 30.6 [24.5-32.3] (30.8 [28.3-40.9])
- 3 workers: 34.5 [26.6-41.6] (49.3 [49.0-52.2])
- GL r16f: 17.8 [16.6-25.8] (25.3). The GPU-to-canvas copy alone is 25.8 ms.

CPU is borderline at 30 fps, workers help but noisily on 4 shared cores, and GPU timings on real hardware are untested.

### H1c: partial

Each plane feeds an osdlabel cell (OSD single-tile source + Fabric overlay) at 30 fps or better for scrolling and rotation.

OSD canvas drawer, 4 cells, 120 rAF frames per loop (headless cap 60 Hz), each loop 3 times with the order rotated. fps median [min-max], run 2 (run 1):

- pan-zoom: 60.0 [59.5-60.0] (60.0)
- scroll axial: 50.7 [42.9-58.5] (55.4)
- scroll coronal: 43.9 [42.4-49.0] (52.9)
- scroll sagittal: 31.0 [26.7-32.6] (29.4 [27.2-30.0]); reslice 18.8 ms
- scroll sagittal with the sagittal-major copy: 38.9 [31.3-51.4] (49.3)
- linked crosshair (axial, coronal and sagittal resliced every frame): CPU 21.1 [20.5-21.1] (21.2); 3 workers 21.6 [21.2-29.2] (34.0); with the copy 30.5 [25.4-31.2] (28.2)
- rotate oblique: CPU 30.6, 3 workers 34.5 (49.3)
- GL r16f, SwiftShader: oblique 17.8, axial 25.1

Annotation sweep: up to 500 extra axial 7-gons, 18/118/268/518 annotations in total.

- Scroll axial, every provider re-run each frame ('all'): 56.3/45.0/42.6/23.5 (run 1 at 518: 26.6).
- Scroll axial with cross-view memoised per cell and DecorationLayer skipping unchanged lines ('changed'): 55.8/50.4/52.2/43.9 (40.7).
- Decoration phase at 518: 'all' 18.6 ms median, p95 31.5 (providers 1.9, DecorationLayer 12.8, renderAll 3.3); 'changed' 3.2 ms.
- Crosshair 'changed': 24.1/21.5/17.6/16.6. With the copy: 31.6/26.9/25.7/19.0.

OSD's WebGL drawer under SwiftShader runs 6-18 fps.

Verdict on CPU:

- Reach 30 fps: pan-zoom, axial and coronal scroll, and axial scroll at 518 annotations in 'changed' mode.
- Borderline: sagittal scroll on slice-major storage and oblique rotation.
- Miss: the linked crosshair (21 fps; about 30 only with the copy and few annotations), any crosshair with 118 or more annotations, and 518 annotations in 'all' mode.

The phase table times 2D-canvas recording, not raster; fps includes raster.

### H1d: partial

Memory, including CPU/GPU duplication, is bounded: one CPU copy shared by workers, and at most one GPU copy.

CPU, true:

- The 200 MiB SAB volume (uaMemory 3.1 -> 212.8 MB) is shared without copying by the workers and by Niivue (nv.volumes[0].img === our array).
- The optional sagittal-major copy adds another 200 MiB.

GPU, from a device-independent allocation tracker over texStorage/texImage/bufferData:

- MPR page with the WebGL2 reslicer: 1 R16F texture of 209,715,200 B, 1 context. This is true for the reslice path alone.
- Niivue after the volume: R16I 209,715,200 + RGBA8 gradient 419,430,400 (texStorage3D 512x512x400) + about 1.7 MB small = 630,875,604 B. That is 3.0x the volume.
- After its drawing layer: + two RGBA8 512x512x400 textures = 1,469,736,404 B.
- Adding the shared WebGL2 reslicer on the same page: + R16F 209,715,200 = 1,679,451,604 B in 2 live contexts.

So the composition holds 2 GPU copies of the scalar data: 4.0x the volume's bytes without the drawing layer, 8.0x with it. 'At most one GPU copy' is withdrawn for Niivue plus the WebGL reslicer.

GPU-process PSS (SwiftShader) went 52 -> 687 -> 1890 -> 2125 MiB. Renderer PSS went 363 -> 760 MiB with the drawing layer (uaMemory +522.6 MB).

WebGL objects cannot be shared across contexts. One copy would need one of:

- CPU reslicing for 2D cells whenever a Niivue cell exists (GPU then 3.0x)
- the reslice shader running in Niivue's context against its R16I texture (not public API)
- a single context for 2D and 3D cells

### H1e: partial

A transposed (sagittal-major) copy brings the sagittal reslice under 10 ms and lifts sagittal and crosshair interaction, at the cost of a second CPU copy.

Sagittal scroll reslice: 15.36 -> 6.24 ms (18.22 -> 6.54), p95 29.4 -> 9.2.

MPR fps:

- sagittal scroll: 31.0 -> 38.9 (29.4 -> 49.3)
- crosshair: 21.1 -> 30.5 (21.2 -> 28.2)
- crosshair at 118 annotations ('changed'): 21.5 -> 26.9

Cost: +209,715,200 B CPU and 1.06-1.20 s to build. Output is identical to the slice-major reslice (unit test). In the copy, coronal and axial fall to the trilinear path, so the copy serves the sagittal view only. A bricked or tiled scalar layout serving all three views was not measured.

### H2a: confirmed

Annotations drawn on any plane can be stored as 2D geometry plus a DICOM-style plane frame (IPP/IOP/spacing) and projected into other views by pure, zero-dependency geometry.

@osdlabel/spatial has 0 dependencies and 16 unit tests; @osdlabel/mpr has 14. The browser cross-view check passes 13/13 with both drawers in both runs. It drives real RectangleTool and PointTool through Playwright mouse -> OSD MouseTracker -> FabricOverlay -> providers -> DecorationLayer.

- Coronal and sagittal segment ends equal the committed rectangle's edges (within 0.01 px).
- The committed rectangle lies within 1 px of the drag targets.
- The oblique cell's segment ends map back into the axial plane (dz ~1e-14 mm) on the rectangle's boundary segments, with the midpoint inside it.
- The coronal point shows as an axial marker and is absent 26 voxels away.
- Scrolling one slice removes the native rectangle.
- All four plane ids round-trip.

The fix commit had read geom.x / geom.y on a RectangleGeometry ({ origin, width, height }), so 4 checks failed in its first run; that is now corrected.

### H2b: partial

Projections, crosshairs and reference lines render through the existing DecorationProvider / DecorationLayer without changing them.

The Decoration types are unchanged. Shared providers needed an optional DecorationContext.imageId (+8 lines), passed by the Solid and React ViewerCell and by enableLiveDecorationUpdates. The DecorationLayer gained one optimization: it skips set() / setCoords() when a line decoration object is identical to the last one applied (+8 lines). At 518 annotations that cuts the layer phase from 12.8 to 0.65 ms with memoised providers.

On stock @osdlabel/solid ViewerCells the Solid check passes 10/10, with about 3.0 provider runs per scroll frame. New parity tests in both bindings check that providers see imageSource.id and re-run on a new id with the same tile source. React's tests also cover the live-drag ref, and that an equal re-render does not re-run providers. They are mutation-checked.

Providers still read other cells' planes through closures. A React page re-running them on foreign changes was not built.

### H2c: partial

Compare 3D label maps stored as per-slice @osdlabel/mask buffers versus a dense 3D label volume (and, after review, sparse 32^3 bricks), for painting cost, memory and cross-view display.

Method:

- Every representation paints through the same span or voxel enumerator.
- Dense is pre-touched; order is rotated and alternated.
- 24 warm reps and 20 cold trials; radius 15 px, 20 stamps per stroke.
- 0 voxel mismatches between dense, masks and bricks.

Warm per-stamp median ms, span painter, axial/coronal/sagittal/oblique:

- dense: 0.025/0.022/0.095/0.050
- masks: 0.027/0.031/0.090/0.056
- bricks: 0.025/0.026/0.085/0.049
  The voxel painter gives dense 0.071-0.095 vs masks 0.083-0.113. The ranges overlap, and every value is under 1% of a 16.7 ms frame, so painting speed does not separate them. The earlier '2-8x slower non-axial painting' is withdrawn: it was first-touch and order artefacts plus different algorithms.

Cold first stroke, span: dense 0.04-0.25, masks 0.12-0.24, bricks 0.06-0.16 ms.

Display, nearest reslice ms, axial/coronal/sagittal/oblique:

- committed dense: 5.33/5.92/26.90/9.80 (run 1: 5.13/5.38/13.17/7.04)
- lazily committed dense: 5.29/7.30/9.11/7.26
- masks: 6.19/6.96/8.52/7.21
- bricks: 5.85/7.46/8.45/7.96
  The earlier 'masks 1.5-2.7x slower in every view' is withdrawn. The real outlier is sagittal through a committed 100 MiB dense map: strided reads of real memory, where untouched lazy pages hit the zero page.

Memory for 49,640 voxels: dense 100 MiB fixed (12.5 bit-packed), masks 3.81 MiB in 72 masks, bricks 3.03 MiB (96 of 3,328 bricks).

The choice is therefore structural. Bricks give O(1) voxel access (one index plus shifts) and memory that follows the painted extent. They avoid per-slice mask allocation and grow(), and a stroke on any view touches few bricks. A dense map is only for zero-copy sharing with Niivue's drawing bitmap, which needs a dense array.

### H3a: confirmed

An existing WebGL2 volume renderer (Niivue) can live in one grid cell beside osdlabel cells and reuse the same volume buffer (zero copy or one copy).

Setup used Niivue 1.0.0-rc.37's public API only: createStreamingNVImage for the header, nii2volume with our SAB-backed Int16Array, then addVolume. Afterwards nv.volumes[0].img === our array, so there is no CPU copy.

Times: attach 199 ms, nii2volume 486 ms, addVolume plus 2 frames 13.5 s under SwiftShader. Niivue uses 1 context, and three canvas-drawer osdlabel cells run beside it.

The GPU side is not one copy. Niivue allocates 3.0x the volume's bytes (R16I + RGBA8 gradient); see H1d.

### H3b: partial

The 3D view shows the annotations (points, segments, label map).

Label map: our LabelVolume slices are views of Niivue's drawing bitmap (100 MiB).

- Painting 11,808 voxels took 7.8 ms, and Niivue still held the same bitmap.
- refreshDrawing plus 2 frames took 14.4 s under SwiftShader.
- The drawing layer adds two 400 MiB RGBA8 3D textures and +522.6 MB renderer memory.

Annotations: points and outlines go in an SVG overlay through mmToRenderCanvas. Error against the rendered lesion centroid is 0.57/0.18/0.38/0.95 px.

Limits:

- The overlay is not depth-occluded.
- The accuracy test hides the volume, and lesion and overlay go through the same index -> mm mapping, so it is self-consistent by construction.
- The test cannot detect the known LPS/RAS mirror between the 3D and 2D cells.

### H3c: partial

The composed layout stays within the WebGL context budget (16 per page).

Live contexts:

- Canvas-drawer MPR page: 0, or 1 with the reslicer.
- Niivue page: 1, or 2 with the reslicer.
- MPR with OSD's WebGL drawer: 4 (8 created, 4 isSupported probes released), 5 with the reslicer.

Stock Solid ViewerCells (256 px cells, scrolling cell 0, 60 frames):

- Default WebGL drawer: one live context per cell. 3 -> 3, 8 -> 8 and 16 -> 16 live, at 33.0/28.6/24.5 fps (run 1: 29.0/25.5/21.7). At 20 cells, 40 contexts were created and only 16 are live. 4 cells throw 'WebGL error: bad value for gl parameter MAX_TEXTURE_IMAGE_UNITS (null) ... too many contexts' and do not render, so their reading of 52.9 fps is not comparable.
- OpenSeadragon.DEFAULT_SETTINGS.drawer = 'canvas', set before any cell opens, with no library change: 0 contexts at every N, 60.0/59.0/52.2/38.3 fps (run 1: 60.0/56.3/50.0/39.6).

The recommended composition (canvas-drawer cells + Niivue + an optional reslicer) uses 2 contexts. Default-drawer ViewerCells exceed the budget at 17 cells, or at 15 next to Niivue and a reslicer.

### H3d: untested

The embedded 3D renderer rotates interactively.

Under SwiftShader (CPU-emulated ray casting), the 512x512 canvas rotated at 0.93 fps (run 1: 1.04) over the 512x512x400 volume. These numbers say nothing about real GPUs; a desktop rerun is needed.

### H4: confirmed

Plane ImageIds can be deterministic and reversible, so an annotation saved under a plane id reloads onto the same plane without a host registry.

Scheme (@osdlabel/mpr planeImageId / parsePlaneImageId):

- Grid-aligned slices at the default spacing get vol:<series>:<axial|coronal|sagittal>:<index>. Decoding needs the series grid.
- Every other plane gets vol:<series>:f:<origin>;<rowDir>;<colDir>;<sx,sy>;<w>x<h>;<thickness>. Origin is quantized to 1 um, cosines to 1e-6, spacing to 1e-6 mm, thickness to 1e-4 mm. It decodes with nothing else.
- The series is URI-encoded.
- Encoding is canonical: re-encoding a decoded plane returns the same id.

Evidence:

- 7 unit tests: orthogonal round trip; the grid is needed; oblique round trip within the quantum and isSamePlane; the same plane reached via spin 20 and 380 degrees, or nudged 1e-9 mm, gets the same id; different planes get different ids; fallback for non-default spacing; JSON round trip; 9 malformed ids rejected.
- E2E: all four MPR cells' ids, the oblique included, decode to their planes and re-encode identically.
- The Solid page now derives ids from the scheme and decodes stored ids; each matches the grid slice it was drawn on.

Limit: two frames from different code paths that straddle a rounding boundary would get different ids. Frames from the same path are bit-identical.

## Measurements

| Measurement                                                                     | Value                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | Unit                          | Conditions                                                                                                                                                                                                                                                                                                              |
| ------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| host and run conditions                                                         | Run 2 (committed as apps/poc-volume/results/representative.json): 2026-10-24 17:10 UTC, git 69b4cbc, 16.5 min. Run 1: 16:51 UTC, git b9a9757 (same harness without bricks). Chromium 153.0.8010.12 headless at /opt/pw-browsers/chromium, Intel Xeon @ 2.80GHz, 4 cores, 16 GiB. ps showed no other benchmark during either run.                                                                                                                                                                                                                                                                                                          | -                             | pnpm --filter @osdlabel/poc-volume bench (--mpr-reps 3 default); 512x512x400 int16 Shepp-Logan phantom in HU, 0.7x0.7x1.25 mm, one SharedArrayBuffer (fill 1433 ms)                                                                                                                                                     |
| cpu reslice, same plane each rep (median / p95)                                 | axial 1.81/4.41 (run 1 1.99/6.16); coronal 7.66/16.01 (3.90/8.30); sagittal 14.09/14.59 (14.85/18.90); oblique trilinear 14.35/16.73 (14.35/15.99); oblique nearest 7.55/7.99 (10.11/11.54)                                                                                                                                                                                                                                                                                                                                                                                                                                               | ms                            | main thread, 30 reps after 3 warm-ups, linear interpolation unless stated, coronal and sagittal 512x714 at 0.7 mm square pixels                                                                                                                                                                                         |
| cpu reslice while scrolling (different plane every rep; median / p95)           | axial 2.17/3.54 (2.26/4.18); coronal 4.63/6.20 (4.67/6.67); sagittal 15.36/29.43 (18.22/29.11); sagittal through sagittal-major copy 6.24/9.22 (6.54/9.63); oblique 12.29/19.80 (13.23/21.49)                                                                                                                                                                                                                                                                                                                                                                                                                                             | ms                            | main thread, 30 reps, slice-major and copy alternated in rotated order; copy = permuteVolume(volume, SAGITTAL_MAJOR): 209,715,200 B, built in 1057 ms (1085)                                                                                                                                                            |
| worker reslice, 1/2/4 workers (median)                                          | axial 1.95/3.73/2.84; coronal 6.42/6.16/5.97; sagittal 18.65/16.61/12.23; oblique 15.75/13.24/9.32. Run 1: oblique 12.19/8.93/7.29, sagittal 15.46/13.59/10.55                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | ms                            | row bands of the shared SAB volume, postMessage round trip included, 4 shared cores                                                                                                                                                                                                                                     |
| window LUT + putImageData                                                       | LUT 0.88 ms, putImageData 0.12 ms (run 1)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | ms median                     | 512x512, 65536-entry Uint32 LUT                                                                                                                                                                                                                                                                                         |
| webgl2 reslice draw+readPixels (axial/coronal/sagittal/oblique)                 | r16i 26.06/33.57/43.95/19.39; r16f 16.33/20.88/41.77/16.92; r32f 10.25/13.66/23.46/12.57; upload r16i 1025 ms, r16f 1480 ms, r32f 1159 ms; max 1 grey level vs CPU                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | ms median                     | SwiftShader (CPU-emulated, pessimistic); 8-bit window centre 40 width 400, so HU fidelity is not verified                                                                                                                                                                                                               |
| MPR canvas drawer loops, fps median [min-max] over 3 reps (run 1 median)        | pan-zoom 60.0 [59.5-60.0] (60.0); scroll-axial cpu 50.7 [42.9-58.5] (55.4); scroll-coronal cpu 43.9 [42.4-49.0] (52.9); scroll-sagittal cpu 31.0 [26.7-32.6] (29.4); scroll-sagittal cpu+copy 38.9 [31.3-51.4] (49.3); crosshair cpu 21.1 [20.5-21.1] (21.2); crosshair cpu+copy 30.5 [25.4-31.2] (28.2); rotate-oblique cpu 30.6 [24.5-32.3] (30.8); rotate-oblique 3 workers 34.5 [26.6-41.6] (49.3); scroll-axial workers 54.1 [43.6-57.6] (60.0); scroll-sagittal workers 30.8 [26.9-37.7] (45.3); crosshair workers 21.6 [21.2-29.2] (34.0); rotate-oblique GL r16f 17.8 [16.6-25.8] (25.3); scroll-axial GL 25.1 [18.0-26.3] (27.6) | fps (rAF, headless cap 60 Hz) | 4 cells (axial 512x512, coronal/sagittal 512x714, oblique 512x512) in 512x512 CSS boxes, 18 seeded annotations, 120 frames per loop, plan order rotated each round; GL rows are SwiftShader                                                                                                                             |
| MPR canvas drawer per-frame phases (median, run 2)                              | scroll-axial: update 5.14 (p95 11.24), reslice 2.14, upload 0.83, OSD draw 0.19, Fabric 0.16, decorations 1.70 (31 decorations). scroll-sagittal: reslice 18.83, update 22.00. crosshair cpu: reslice 30.96 (3 planes), update 37.36. crosshair+copy: reslice 15.96. rotate-oblique cpu: reslice 15.68. GL: upload (GPU->2D canvas copy) 23.7-25.8                                                                                                                                                                                                                                                                                        | ms                            | upload = LUT + putImageData + invalidate; OSD draw and renderAll time 2D-canvas recording, not raster (per the review's probe, a forced flush is about 3.6 ms); the fps figures include raster                                                                                                                          |
| MPR annotation-count sweep, fps median [range] (run 1)                          | scroll-axial all: 18 ann 56.3 [53.3-58.5], 118 45.0, 268 42.6 [28.8-44.2], 518 23.5 [23.4-31.2] (26.6). scroll-axial changed: 55.8, 50.4, 52.2, 43.9 [43.1-44.2] (40.7). crosshair cpu all: 25.1, 20.8, 18.9, 16.7; changed: 24.1, 21.5, 17.6, 16.6. crosshair cpu+copy changed: 31.6 [28.8-34.6], 26.9, 25.7, 19.0 (35.8, 31.9, 23.2, 18.9)                                                                                                                                                                                                                                                                                              | fps                           | canvas drawer, 0/100/250/500 extra axial 7-gon polygons (18/118/268/518 total), 3 reps per cell. all = every provider in every cell every frame. changed = a cell's cross-view provider memoised on (plane, annotation version) plus DecorationLayer skipping identical line objects; reference lines always recomputed |
| decoration phase split at 518 annotations, scroll-axial (median / p95)          | all: total 18.63/31.50, providers 1.90, DecorationLayer.setDecorations 12.81, renderAll 3.31 (338 decorations). changed: total 3.22/4.52, providers 0.26, layer 0.65, renderAll 2.31. Run 1: all 14.66 (layer 9.50), changed 2.88 (layer 0.57). Crosshair all at 518: 11.67 (layer 7.91)                                                                                                                                                                                                                                                                                                                                                  | ms                            | canvas drawer, summed over the 4 cells per frame                                                                                                                                                                                                                                                                        |
| MPR with OSD WebGL drawer                                                       | pan-zoom 17.9, scroll-axial 18.0, coronal 17.3, sagittal 9.8, crosshair 6.0, rotate-oblique cpu 13.5, rotate-oblique GL 10.6 fps (run 1: 4.7-14.5); OSD draw 34-116 ms per frame                                                                                                                                                                                                                                                                                                                                                                                                                                                          | fps                           | SwiftShader; 1 rep each; tile refresh through the private WebGLDrawer.\_cleanupImageData                                                                                                                                                                                                                                |
| label paint per stamp, warm (median; min-max)                                   | span painter, dense / masks / bricks: axial 0.025 / 0.027 / 0.025; coronal 0.022 / 0.031 / 0.026; sagittal 0.095 / 0.090 / 0.085; oblique 0.050 / 0.056 / 0.049. Voxel painter, dense / masks: axial 0.079 / 0.098; coronal 0.071 / 0.083; sagittal 0.095 / 0.113; oblique 0.083 / 0.094. @osdlabel/mask stampCircle (axial) 0.013 vs paired dense span 0.021. Example ranges: axial span dense 0.017-0.071, masks 0.020-0.054, bricks 0.020-0.044. Run 1: voxel dense 0.164-0.189 vs masks 0.182-0.203; span dense 0.035-0.185 vs masks 0.047-0.164                                                                                      | ms per stamp                  | radius 15 px, 20 stamps per stroke, 24 reps, dense buffer pre-touched, 4 warm-up strokes per view, view order rotated and representation order alternated every rep, bricks painted through the span enumerator only                                                                                                    |
| label paint, cold first stroke (median)                                         | span dense / masks / bricks: axial 0.043 / 0.123 / 0.070; coronal 0.073 / 0.206 / 0.055; sagittal 0.248 / 0.244 / 0.164; oblique 0.103 / 0.176 / 0.114                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | ms per stamp                  | 20 trials, fresh lazily committed dense buffer, empty mask stack, empty brick table                                                                                                                                                                                                                                     |
| label display reslice (median)                                                  | axial / coronal / sagittal / oblique. committed dense 5.33 / 5.92 / 26.90 / 9.80; lazily committed dense 5.29 / 7.30 / 9.11 / 7.26; slice masks 6.19 / 6.96 / 8.52 / 7.21; bricks 5.85 / 7.46 / 8.45 / 7.96. Run 1 (no bricks): committed 5.13 / 5.38 / 13.17 / 7.04; lazy 5.14 / 5.18 / 5.84 / 4.52; masks 5.32 / 4.61 / 5.20 / 5.00                                                                                                                                                                                                                                                                                                     | ms                            | nearest-neighbour, 512x512 or 512x714, 24 reps rotated, per-slice lookups hoisted in dense and masks                                                                                                                                                                                                                    |
| label memory                                                                    | dense 104,857,600 B fixed (13,107,200 bit-packed); slice masks 3,997,696 B in 72 masks; bricks 3,172,352 B (96 of 3,328 32^3 bricks); 49,640 painted voxels; 0 representation, brick and algorithm mismatches                                                                                                                                                                                                                                                                                                                                                                                                                             | bytes                         | after every warm, cold and reference stroke on the span pair                                                                                                                                                                                                                                                            |
| WebGL allocation tracker, composed layout                                       | Niivue after volume: R16I 209,715,200 + RGBA8 419,430,400 + RGBA/8bit 1,575,048 + buffers 154,952 = 630,875,604 B. After drawing layer: RGBA8 1,258,291,200, total 1,469,736,404 B. Plus shared WebGL2 reslicer (r16f): R16F 209,715,200, total 1,679,451,604 B, 2 live contexts. MPR page reslicer alone: R16F 209,715,200 B, 1 context. Ratios: Niivue 3.0x the volume's bytes; with the reslicer 4.0x; with drawing and reslicer 8.0x                                                                                                                                                                                                  | bytes                         | texStorage*/texImage*/bufferData/renderbufferStorage instrumented before any context, bytes from dimensions x internal format (device-independent); identical in both runs                                                                                                                                              |
| process memory (PSS) around Niivue                                              | GPU process 52 -> 687 (volume) -> 1890 (drawing) -> 2125 MiB (+reslicer); renderer 363 -> 760 MiB with the drawing layer; uaMemory +522.6 MB for the drawing layer                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | MiB / MB                      | /proc smaps_rollup summed by Chromium process type; SwiftShader keeps textures in GPU-process RAM                                                                                                                                                                                                                       |
| stock Solid ViewerCells by OSD drawer and cell count                            | default (WebGL) drawer, cells 3/8/16/20: live contexts 3/8/16/16, created 6/16/32/40, fps 33.0/28.6/24.5/52.9. At 20 cells, 4 cells failed with 'WebGL error ... MAX_TEXTURE_IMAGE_UNITS (null) ... too many contexts' and did not render. canvas drawer via OpenSeadragon.DEFAULT_SETTINGS.drawer: 0 contexts at every N, fps 60.0/59.0/52.2/38.3. Run 1: default 29.0/25.5/21.7/45.6, canvas 60.0/56.3/50.0/39.6                                                                                                                                                                                                                        | contexts, fps                 | 256 px CSS cells, 4 columns, kinds cycle axial/coronal/sagittal, scroll of cell 0 for 60 frames re-runs every cell's providers via Solid tracking; default drawer under SwiftShader; counter 'lost' includes probe releases via WEBGL_lose_context                                                                      |
| stock Solid ViewerCells check (3 cells, 512 px, default drawer)                 | 10/10 checks; scroll 14.3 fps (run 1 11.6); Solid sync per scroll step 1.92 ms median; 3.0 provider runs per frame                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | checks, fps, ms               | ImageId per plane from planeImageId; stored ids decoded with parsePlaneImageId; SwiftShader                                                                                                                                                                                                                             |
| cross-view E2E                                                                  | 13/13 with canvas and WebGL drawers in both runs                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | checks                        | real RectangleTool and PointTool via Playwright mouse; segment ends equal to the rectangle edges within 0.01 px; oblique segment ends within 1e-13 mm of the axial plane and within 0.01 px of the rectangle boundary; plane-id round trip of all four cells                                                            |
| Niivue cell                                                                     | zero copy true (img is our SAB Int16Array); attach 199 ms, nii2volume 486 ms, addVolume + 2 frames 13.5 s; shared labels paint 11,808 voxels in 7.8 ms, refresh + 2 frames 14.4 s, 2D tint 10.8 ms per cell; overlay error 0.57/0.18/0.38/0.95 px at azimuth 30/110/200/290; rotation 0.93 fps (run 1 1.04)                                                                                                                                                                                                                                                                                                                               | ms, px, fps                   | Niivue 1.0.0-rc.37, SwiftShader                                                                                                                                                                                                                                                                                         |
| bundle size (min / gzip)                                                        | niivue-webgl2 1514 / 449 KiB; osdlabel MPR cell (OSD + fabric-osd + new packages) 706 / 173 KiB; new packages alone 31 / 10 KiB                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | KiB                           | Vite 8 production lib build, ES, no externals                                                                                                                                                                                                                                                                           |
| unit tests                                                                      | spatial 16, volume 26, mpr 14, poc-volume 14, decoration 66, fabric-osd 195, osdlabel 309, solid 159, react 222; all pass under one parallel turbo run                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | tests                         | pnpm exec turbo run test over the new and touched packages at 068616a                                                                                                                                                                                                                                                   |
| architectural stress (diff vs origin/claude/segmentation-brush-tool at 068616a) | existing: 10 files, +366/-6. Of those, 6 source files +43/-5; 2 test files +50/-1; pnpm-lock +271; pnpm-workspace +2. new: 71 files, +26,844 (17,863 results JSON, 2,194 package src, 1,527 tests, 4,907 app src/scripts/html, 353 config)                                                                                                                                                                                                                                                                                                                                                                                                | files, lines                  | git diff --numstat; a file counts as existing if it is in the base tree                                                                                                                                                                                                                                                 |

## Recommendation

Grow osdlabel to volumes by composition. New leaf packages, each with one concern, sit under an unchanged 2D pipeline. A volume plane is just an image, and its ImageId comes from the reversible scheme in @osdlabel/mpr:

- vol:<series>:axial:200 for grid slices
- the quantized DICOM frame for oblique and other planes
  A saved annotation therefore reloads onto its plane with no host registry. Tools, the store, serialization and constraints are unchanged, and the per-image bucket means 'annotations on this plane'.

Rendering:

- The 2D cell's image is a stable canvas-backed OSD TileSource that a reslicer rewrites.
- 2D cells use OSD's canvas drawer: 0 WebGL contexts per cell, which keeps grids above 16 cells possible. Until ViewerCell takes viewer options, OpenSeadragon.DEFAULT_SETTINGS.drawer = 'canvas' is a measured stopgap that needs no library change.
- Reslicing is on the CPU by default: gather or separable for orthogonal planes, trilinear for oblique, and row-band worker splits optional.
- An optional sagittal-major copy trades +1x CPU memory for sagittal scrolling under 10 ms.
- The WebGL2 reslicer stays optional and must be re-measured on real GPUs. With Niivue present it is a second GPU copy of the scalar data, so prefer CPU reslicing then.

Cross-view projections, crosshairs and reference lines are DecorationProviders that find their view through DecorationContext.imageId. Large annotation counts need memoised or spatially indexed providers: re-running everything costs 18.6 ms per frame at 518 annotations, against 3.2 ms memoised.

The runtime label map is a sparse bricked LabelVolume (32^3 uint8 bricks allocated on demand). Bricks are chosen structurally, since all representations paint within noise:

- O(1) voxel access
- memory follows the painted extent (3.0 MiB vs 100 MiB dense)
- no per-slice grow()
- display parity with masks
  It is synced to a dense array only where a renderer such as Niivue's drawing layer needs one. Per-slice @osdlabel/mask and COCO RLE stay export formats.

The 3D view is an optional Niivue adapter, zero-copy on the CPU but 3x the volume on the GPU. DICOM stays at the edge: an adapter turns a series into slices plus PlaneFrames.

This respects the maintainer's model: OSD for tiles, Fabric for vectors, the DOM for decorations, Niivue only for 3D, and every new package a leaf. Nothing existing depends on them.

### New packages

- @osdlabel/spatial (spatial math; exists): Vec3, PlaneFrame (IPP/IOP/PixelSpacing, pixel-centre convention), VolumeGrid (index<->patient, sheared grids), orthogonal and centred planes, plane->index mapping, distance fields, polygon/polyline/circle cuts, reference lines. Depends on nothing.
- @osdlabel/volume (volume data; exists, now mask-free): ScalarVolume (slice-wise, optional SAB, contiguousVoxels), CPU reslice with rowStart/rowEnd for worker splits, permuteVolume / SAGITTAL_MAJOR copies, window LUT, LabelVolume (dense) and BrickedLabelVolume (sparse 32^3), paint/fill through a shared span enumerator, label reslice. Proposed: fromSliceStack (sort and validate IOP and spacing), brick<->dense sync. Depends on @osdlabel/spatial only.
- @osdlabel/reslice-webgl (WebGL2 reslicer; proposed, PoC code apps/poc-volume/src/gl-reslicer.ts): 3D texture upload (r16i takes SAB views with no staging; r16f/r32f stage 1 MiB per slice), shader reslice into a canvas, one context for all cells. Depends on @osdlabel/volume and @osdlabel/spatial; no OSD.
- @osdlabel/mpr (MPR decoration providers and plane ids; exists): planeImageId / parsePlaneImageId, cross-view and reference-line providers, PlaneFields for self-describing export. Proposed: pure providers that read other planes' annotations through a cross-image DecorationContext accessor instead of closures, and a per-plane spatial index. Depends on @osdlabel/annotation, @osdlabel/decoration, @osdlabel/spatial and @osdlabel/viewer-api.
- @osdlabel/osd-frame-source (OSD frame source; proposed, PoC code apps/poc-volume/src/canvas-tile-source.ts): a stable canvas-backed TileSource the host rewrites, plus redraw and invalidation. The canvas drawer needs nothing; OSD 5's WebGL drawer needs the private \_cleanupImageData; OSD 6 has requestInvalidate. Depends on openseadragon only. It is not volume-specific: video frames and pixel pipelines can reuse it.
- @osdlabel/niivue (Niivue adapter, optional; proposed, PoC code apps/poc-volume/src/niivue-page.ts): attachNiivueVolume (zero-copy), shared dense label bitmap (or brick->dense sync), patient<->Niivue mm mapping (LPS<->RAS), 3D annotation overlay via mmToRenderCanvas. Depends on @niivue/niivue (peer), @osdlabel/volume, @osdlabel/spatial and @osdlabel/mpr.
- Not packaged, and why. The worker pool is a few lines of bundler-specific glue (worker URL); the pure row-band reslice already lives in @osdlabel/volume. The volume-cell controller (scroll, rotate, linked crosshair, window/level, assignImageToCell per step) is about 100 lines of glue across frame source, reslicer and plane ids. It starts as example code and becomes a binding hook later, with Solid/React parity tests. The earlier sketched @osdlabel/volume-osd mixed reslicer backends, the OSD tile source and the controller, so it is split along those lines.

### Changes to existing packages

- @osdlabel/decoration: DecorationContext gains optional readonly imageId?: ImageId (done, +8/-1). Shared providers need it to know which cell or plane they serve.
- @osdlabel/fabric-osd: public FabricOverlay.viewer getter (done, +10), so a host whose tile pixels change in place can ask OSD to redraw. DecorationLayer skips set() / setCoords() when a line decoration object is identical to the last one applied (done, +8, with a 35-line unit test). With memoised providers at 518 annotations, this cut the layer phase from 12.8 to 0.65 ms.
- osdlabel: enableLiveDecorationUpdates accepts getImageId and forwards it (done, +5/-2).
- @osdlabel/solid and @osdlabel/react ViewerCell pass imageSource.id into the decoration context (done: Solid +2/-1; React +10/-1, including the effect dependency and a ref for live updates). Parity unit tests are done: viewer-cell-decoration-image-id in both bindings, plus a React live-drag ref test. They are mutation-checked.
- Still needed: a public per-cell viewer option on ViewerCell (drawer: 'canvas') to replace the DEFAULT_SETTINGS stopgap; or OSD 6 requestInvalidate for WebGL-drawer cells.
- Still needed: for React, a way to re-run providers when other cells' planes or annotations change, such as a cross-image accessor in DecorationContext.
- Still needed: docs for the ImageId-per-plane pattern, including that a scrolling host calls assignImageToCell on every step.
- pnpm-workspace.yaml: minimumReleaseAgeExclude for @niivue/niivue@1.0.0-rc.37 (PoC only).

### API sketch

```ts
// IMPLEMENTED in this branch unless marked PROPOSED.

// @osdlabel/spatial (zero deps)
export type Vec3 = readonly [number, number, number];
export interface PlaneFrame { readonly origin: Vec3; readonly rowDirection: Vec3; readonly columnDirection: Vec3; readonly pixelSpacing: { readonly x: number; readonly y: number }; readonly width: number; readonly height: number; readonly thickness: number }
export interface VolumeGrid { readonly dimensions: readonly [number, number, number]; readonly spacing: Vec3; readonly origin: Vec3; readonly direction: readonly [Vec3, Vec3, Vec3] }
export function orthogonalPlane(g: VolumeGrid, o: 'axial' | 'coronal' | 'sagittal', index: number, pixelSpacing?: number): PlaneFrame;
export function centredPlane(centre: Vec3, row: Vec3, col: Vec3, spacing: number, w: number, h: number, thickness: number): PlaneFrame;
export function planeIndexMapping(g: VolumeGrid, f: PlaneFrame): PlaneIndexMapping;
export function referenceLine(view: PlaneFrame, other: PlaneFrame): Segment2 | null;
export function isSamePlane(a: PlaneFrame, b: PlaneFrame, toleranceMm?: number): boolean;

// @osdlabel/volume (deps: spatial)
export function allocateScalarVolume(g: VolumeGrid, o?: { shared?: boolean; contiguous?: boolean }): ScalarVolume;
export function reslice(v: ScalarVolume, m: PlaneIndexMapping, w: number, h: number, out: Int16Array, o?: { interpolation?: 'nearest' | 'linear'; rowStart?: number; rowEnd?: number }): ReslicePath;
export const SAGITTAL_MAJOR: AxisOrder; // [1, 2, 0]
export function permuteVolume(v: ScalarVolume, order: AxisOrder): ScalarVolume; // same patient positions, other storage order
export class BrickedLabelVolume { constructor(g: VolumeGrid); get(i: number, j: number, k: number): number; fillDisc(f: PlaneFrame, c: Point2, rPx: number, value: number): number; reslice(m: PlaneIndexMapping, w: number, h: number, out: Uint8Array): void; byteLength(): number }
export function fillDisc(l: LabelVolume, f: PlaneFrame, c: Point2, rPx: number, value: number): number; // dense
export function resliceLabels(l: LabelVolume, m: PlaneIndexMapping, w: number, h: number, out: Uint8Array): void;
// PROPOSED: fromSliceStack(frames), brickToDense(l, target, dirtyBricks)

// @osdlabel/mpr (deps: annotation, decoration, spatial, viewer-api)
export function planeImageId(series: string, plane: PlaneFrame, grid?: VolumeGrid): ImageId; // 'vol:CT1:axial:200' | 'vol:CT1:f:<ipp>;<iop row>;<iop col>;<sx,sy>;<w>x<h>;<t>'
export function parsePlaneImageId(id: ImageId | string, gridOf?: (series: string) => VolumeGrid | undefined): { series: string; plane: PlaneFrame; form: 'orthogonal' | 'frame'; orientation?: ...; index?: number } | null;
export function createCrossViewProvider(getView: () => PlaneFrame, getForeign: () => readonly PlanarAnnotation[], style?: CrossViewStyle): DecorationProvider; // closures today
// PROPOSED: createCrossViewProvider({ planeOf: (id: ImageId) => PlaneFrame | undefined }) reading ctx.imageId and a ctx.annotationsForImage accessor, with a per-plane spatial index

// PROPOSED @osdlabel/osd-frame-source (deps: openseadragon)
export function createCanvasTileSource(canvas: HTMLCanvasElement, ctx: CanvasRenderingContext2D): OpenSeadragon.TileSource;
export function invalidateFrame(viewer: OpenSeadragon.Viewer, canvas: HTMLCanvasElement): void; // canvas drawer: no-op; OSD 6: requestInvalidate

// PROPOSED @osdlabel/reslice-webgl (deps: volume, spatial)
export class GlReslicer { constructor(maxW: number, maxH: number); upload(v: ScalarVolume, format: 'r16i' | 'r16f' | 'r32f'): UploadReport; render(m: PlaneIndexMapping, w: number, h: number, center: number, width: number): void; readonly canvas: HTMLCanvasElement; dispose(): void }

// PROPOSED @osdlabel/niivue (deps: @niivue/niivue peer, volume, spatial, mpr)
export function attachNiivueVolume(nv: NiiVue, v: ScalarVolume): Promise<void>; // zero copy
export function shareLabelBitmap(nv: NiiVue, g: VolumeGrid): LabelVolume; // dense views over nv.drawingVolume.img
export function overlayAnnotations3D(nv: NiiVue, host: SVGSVGElement, anns: () => readonly PlanarAnnotation[]): () => void;

// changed existing API (implemented)
interface DecorationContext<E> { /* ... */ readonly imageId?: ImageId | undefined }
class FabricOverlay { get viewer(): OpenSeadragon.Viewer }
// stopgap with no library change:
OpenSeadragon.DEFAULT_SETTINGS.drawer = 'canvas';
```

### Effort

11-15 engineer-weeks, excluding the DICOM series adapter and real-GPU tuning:

- spatial + volume hardening (fromSliceStack, bricks as the runtime default with brick->dense sync, permuted or tiled scalar layout, volumes over 2 GiB): 3-4
- osd-frame-source plus a ViewerCell drawer option, or OSD 6 invalidation: 1-1.5
- reslice-webgl, validated on real GPUs, with chunked textures: 1-1.5
- mpr (pure providers via a cross-image accessor, spatial index, React invalidation) plus binding integration, with Solid/React parity unit and E2E tests: 2.5-3.5
- Niivue adapter (zero-copy, label sync, overlay, LPS/RAS): 1.5-2
- volume-cell example or hook, docs: 1.5-2

### Risks

- Sagittal and linked-crosshair interaction misses 30 fps on CPU on this host. Sagittal reslice is 14-18 ms; the crosshair runs at 21 fps, about 30 with a sagittal-major copy that doubles CPU memory. A tiled or bricked scalar layout, an OffscreenCanvas worker pipeline or a real-GPU reslicer may be needed; none was measured.
- Decoration cost grows with total annotation count when every provider re-runs: 18.6 ms per frame at 518 annotations in 'all' mode, 3.2 ms when memoised. Production providers need memoisation per plane and a spatial index.
- Composed GPU memory: Niivue alone is 3.0x the volume; with the WebGL2 reslicer 4.0x; with Niivue's drawing layer 8.0x (1.68 GB tracked for a 200 MiB volume). WebGL cannot share textures across contexts, so avoid the GPU reslicer when a Niivue cell exists.
- WebGL context budget: stock ViewerCells use one context each with OSD's default drawer. The 17th cell fails with a page error. The canvas-drawer stopgap goes through a global OpenSeadragon default until ViewerCell takes viewer options.
- Every GPU number is SwiftShader (CPU-emulated): the WebGL2 reslicer, OSD's WebGL drawer and Niivue rendering and upload.
- OSD 5 has no public way to refresh a changed tile under the WebGL drawer (private \_cleanupImageData). OSD 6 adds requestInvalidate but deprecates the TileSource cache hooks the frame source uses.
- Niivue 1.0 is a release candidate. rc.37 needed a pnpm minimumReleaseAge exclusion.
- Plane-id quantization: two frames from different code paths that straddle a rounding boundary get different ids. Hosts must derive planes through one path; frames from the same path are bit-identical.
- React does not re-run cross-view providers on other cells' changes unless given new provider identities or a cross-image accessor. It is unit-tested for imageId only; there is no React volume page.
- Volumes over about 2 GiB hit the per-ArrayBuffer cap and MAX_3D_TEXTURE_SIZE. Bricks or chunked textures are required for scalar data too.
- Niivue's RAS display mirrors radiological LPS under the identity-direction mapping used here.

## Rejected alternatives

- **A Cornerstone3D-style monolithic renderer, with one GPU pipeline drawing every viewport, annotation and overlay**: Rejected on architecture, not measurement: Cornerstone3D was not run. Composition worked: stock OSD + FabricOverlay + DecorationLayer cells, the real tools and the store, three small new packages, and 6 existing source files changed by +43/-5. A monolith would discard OSD tiling, the Fabric tools and DOM decorations, against best-tool-per-job. Using Cornerstone3D or vtk.js only as the volume and streaming engine feeding osdlabel cells remains an untested middle ground (open question).
- **Use Niivue (or vtk.js) for all views, including 2D MPR annotation**: Niivue's multiplanar views and drawing are voxel- and mask-oriented. They would bypass osdlabel's vector tools, decorations, constraints and serialization. Niivue stays in the 3D cell, where it took our buffer without a CPU copy but allocates 3x the volume on the GPU.
- **OSD's default WebGL drawer for 2D cells (reslice cells and stock ViewerCells)**: It uses one WebGL context per cell. At 20 stock ViewerCells only 16 are live and 4 cells fail. On OSD 5 it needs a private API to refresh a tile. Under SwiftShader MPR ran at 6-18 fps, against 21-60 fps with the canvas drawer at 0 contexts. Revisit on real GPUs with OSD 6 requestInvalidate.
- **Per-slice @osdlabel/mask buffers as the runtime 3D label map**: Not rejected on speed: in the fair comparison they paint within noise of dense and bricks, and display at parity. The earlier '2-8x slower' and '1.5-2.7x slower display' ratios are withdrawn. Rejected on structure: a non-axial stroke allocates and grows a mask per slice it crosses, voxel access goes through a Map plus bounds, and they cannot be shared zero-copy with Niivue's dense drawing bitmap. Bricks give the same sparse memory (3.0 vs 3.8 MiB here) with O(1) access. Masks and COCO RLE stay per-slice export formats.
- **A dense uint8 LabelVolume as the default runtime label map**: It costs a fixed 100 MiB at 512x512x400 regardless of what is painted (3.0 MiB as bricks). Once committed, its sagittal display reslice is 2.5-3.2x slower (26.9 vs 8.5 ms) because it reads real memory with stride nx. Kept only where a renderer needs a dense array: Niivue's drawing bitmap.
- **A plane field on every annotation (PlaneFields) as the runtime model**: ImageId-per-plane needs no change to annotation state, tools, serialization or bindings. With reversible plane ids the plane is recoverable from the id alone, so no registry is needed either. PlaneFields stay for self-describing export (DICOM SR/SEG).
- **Opaque plane ids (oblique planes as frame hashes) plus a host registry**: Not reversible: serialize() output could not be reloaded without persisting the registry. Replaced by the quantized-frame id form, which has unit tests and an E2E round trip.
- **One SharedArrayBuffer per volume as the storage contract**: Chrome caps one ArrayBuffer at 2046 MiB. Storage is slice- or brick-wise; contiguousVoxels() offers a zero-copy single view only when slices happen to be contiguous.
- **r32f as the GPU texture format**: It doubles GPU memory (400 vs 200 MiB). All formats agreed with CPU within 1 grey level after an 8-bit window, which cannot verify HU fidelity. r16f's precision limit above 2048 HU is IEEE binary16 arithmetic, not measured here.
- **Encoding each reslice to an image URL (ImageTileSource / data URL) per frame**: Not measured. The canvas-backed TileSource needs no encode or decode; its upload phase (LUT + putImageData + invalidate) is 0.8-1.4 ms median per plane. The 2D-canvas raster (about 3.6 ms flush per the review's probe) is paid on either path.
- **The sketched @osdlabel/volume-osd package (reslicer backends + OSD tile source + cell controller)**: It mixed three concerns with different dependencies. Split instead into @osdlabel/reslice-webgl (no OSD), @osdlabel/osd-frame-source (OSD only, reusable for video), CPU and worker reslicing inside @osdlabel/volume, and the controller as example or binding glue.
- **vtk.js as the first 3D adapter**: Not run. Its size (862/205 KiB) comes from an uncommitted scratch build and is not reproducible from this branch. Niivue was chosen for its typed-array volume API, mmToRenderCanvas and drawing layer; vtk.js remains a possible second adapter on the same seams.

## Architectural stress

Existing files changed: 10; existing lines changed: 372; new lines: 26844.

git diff --numstat origin/claude/segmentation-brush-tool 068616a. A file counts as existing if it is in the base tree.

Existing files: 10, +366/-6. Source is 6 files, +43/-5:

- packages/decoration/src/provider.ts +8/-1 (DecorationContext.imageId)
- packages/fabric-osd/src/decoration/decoration-layer.ts +8 (skip unchanged line objects)
- packages/fabric-osd/src/overlay/fabric-overlay.ts +10 (viewer getter)
- packages/osdlabel/src/live-decoration-updates.ts +5/-2 (getImageId)
- packages/react/src/components/ViewerCell.tsx +10/-1
- packages/solid/src/components/ViewerCell.tsx +2/-1

Tests and config in existing files:

- packages/fabric-osd/tests/unit/decoration/decoration-layer.test.ts +35
- packages/react/tests/unit/components/viewer-cell-live-decorations.test.tsx +15/-1
- pnpm-lock.yaml +271 (new packages; mpr gains viewer-api; volume loses mask)
- pnpm-workspace.yaml +2 (Niivue release-age exclusion, PoC only)

No change to annotation, viewer-api, mask, validation, geometry, fabric-annotations or osd-helper.

New files: 71, +26,844:

- 17,863 results/representative.json (raw per-rep loops)
- 2,194 package src: spatial 687, volume 1,052, mpr 455
- 1,527 tests, including the new Solid and React viewer-cell-decoration-image-id tests
- 4,907 app src, scripts and html
- 353 package and app config

This pass moved SliceMaskStack from @osdlabel/volume into the app, so volume depends only on spatial. It added @osdlabel/viewer-api to mpr for ImageId.

Workarounds kept in app code: the private OSD WebGLDrawer.\_cleanupImageData (WebGL drawer only); OpenSeadragon.DEFAULT_SETTINGS.drawer for stock cells; assignImageToCell on each scroll step.

## Reproduce

```sh
pnpm exec turbo run build --filter='@osdlabel/poc-volume^...' && pnpm --filter @osdlabel/poc-volume bench

The run writes apps/poc-volume/results/<timestamp>.json (or --out <file>) and prints the summary tables. The full run takes about 16.5 min on 4 cores. It peaks at about 2.1 GiB GPU-process plus 0.8 GiB renderer PSS during the Niivue section.

Options:
- --quick: 256x256x200 volume, fewer reps, 1 MPR rep
- --mpr-reps <n>: repetitions of every canvas-drawer MPR loop and sweep cell (default 3)
- --only bench,mpr,solid,niivue,bundle
- --port <n>: scans upward from 5637
- --chromium <path> or POC_CHROMIUM; defaults to /opt/pw-browsers/chromium when present
- --headed

Reprint a saved run with: node apps/poc-volume/scripts/summary.mjs apps/poc-volume/results/representative.json. The loopSummary and sweepSummary fields hold fps medians and ranges.

Unit tests: pnpm exec turbo run test --filter=@osdlabel/spatial --filter=@osdlabel/volume --filter=@osdlabel/mpr --filter=@osdlabel/poc-volume
```

## Caveats

- Every WebGL2 / GPU timing is SwiftShader, CPU-emulated on a 4-core VM: the WebGL2 reslicer, OSD's WebGL drawer and Niivue upload and rendering. The default-drawer Solid fps are SwiftShader-bound too. GPU memory is reported device-independently from the allocation tracker, and separately as SwiftShader GPU-process PSS.
- Absolute CPU numbers depend on the host. Both runs here (Xeon @ 2.80GHz, no other benchmark running) are 1.5-2x slower than the original report's 2.10 GHz host on the same kernels (axial 1.81 vs 1.16 ms). Run-to-run differences reach about 1.4x for worker loops (rotate-oblique workers 34.5 vs 49.3 fps; crosshair workers 21.6 vs 34.0).
- The committed representative.json comes from 69b4cbc. Later commits (068616a) change only unit tests, not benchmark code.
- fps comes from rAF timestamps capped at 60 Hz headless. Per-phase times record 2D-canvas commands but not raster (the review measured about 3.6 ms per forced flush); fps includes raster. In worker and multi-plane frames, the 'reslice' phase sums the planes' times even though workers run them concurrently.
- Same-plane reslice microbenchmarks have warm caches; the scroll rows reslice a different plane every rep. The axial 'linear' reslice sits on voxel centres and is a pure gather.
- GL-vs-CPU agreement is checked after an 8-bit window (centre 40, width 400), so HU fidelity is unverified. r16f precision above 2048 HU is IEEE arithmetic, not a measurement.
- The context counter's 'lost' includes probe contexts released through WEBGL_lose_context. 'live' is the reliable figure. The 20-cell default-drawer fps is not comparable because 4 cells failed to initialise.
- The sagittal-major copy serves only the sagittal view: coronal and axial through it fall to trilinear.
- Synthetic data only: a 3D Shepp-Logan phantom in HU with deterministic noise and identity directions. No real CT or Imaging Data Commons series was loaded.
- The Niivue-to-patient mapping assumes identity grid directions, so Niivue's RAS display mirrors radiological LPS. The 3D overlay is not depth-occluded, and its accuracy test is self-consistent by construction.
- Benchmarks run on the Vite dev server (unbundled, Solid dev build). CPU kernels are unaffected; binding overhead may be slightly inflated.
- React has unit parity tests for DecorationContext.imageId, but no React volume page. React re-running cross-view providers when other cells change was not exercised.
- The vtk.js size came from a scratch build outside the repo; vtk.js was never run. Cornerstone3D was never run.

## Open questions

- Scalar storage for oblique and sagittal speed: is a tiled or bricked scalar layout serving all views worth building, instead of a per-view permuted copy (+1x memory)? Neither the tiled layout nor a WebGPU compute reslicer was measured.
- Would reslice + LUT + raster in a worker with OffscreenCanvas, transferring an ImageBitmap, bring the linked crosshair to 30 fps on CPU? It is untested; today the crosshair runs 21 fps on CPU and about 30 with the sagittal copy.
- Cross-view provider purity: should DecorationContext gain a cross-image accessor (e.g. annotationsForImage), so providers stop reading host state through closures and React re-runs them correctly? And should a per-plane spatial index bound decoration cost? At 518 annotations, re-running everything costs 18.6 ms per frame.
- ViewerCell viewer options: add a per-cell drawer option (canvas for reslice cells) now, or move to OSD 6 and its requestInvalidate? Until then the global DEFAULT_SETTINGS stopgap applies to every viewer on the page.
- Plane-id canonicalisation: is 1 um / 1e-6 quantization the right trade? Should frames be snapped to a canonical form, such as orthonormalised cosines, before encoding, so frames reached by different code paths cannot straddle a rounding boundary?
- Label maps: should bricks be the only runtime form, with a dense sync only for Niivue? Must overlapping labels per voxel be supported, as DICOM SEG binary segments allow, which would mean one brick set per segment or bit planes?
- Is Niivue 1.0 (RC, BSD-2) acceptable as an optional peer dependency at 3x the volume on the GPU, or 8x with its drawing layer? Or should the 3D label map be shown another way, such as an isosurface mesh?
- Is a quiet desktop with a real GPU available? It would settle the WebGL2 reslicer vs CPU workers, OSD WebGL vs canvas drawer, and Niivue rotation.
- Could Cornerstone3D's or vtk.js's volume loading and streaming serve purely as the volume engine feeding osdlabel cells? It was not tried, and it could replace a DICOM series adapter.

## How the review was addressed

- B1 (H2c, dense vs per-slice masks). I re-measured after the fix commit (fd7c439). Both representations now paint through the same span or voxel enumerator, the dense buffer is pre-touched, order is rotated and alternated, and there are 24 warm reps and 20 cold trials. I also added sparse 32^3 bricks (missed alternative 9). Two full runs.

Warm per-stamp median, span painter, dense / masks / bricks:

- axial 0.025 / 0.027 / 0.025
- coronal 0.022 / 0.031 / 0.026
- sagittal 0.095 / 0.090 / 0.085
- oblique 0.050 / 0.056 / 0.049 ms
  The voxel painter gives 0.071-0.095 vs 0.083-0.113, with overlapping ranges. Display: masks and bricks are at parity with lazily committed dense in every view (5.3-9.1 ms). A committed dense map is 2.5-3.2x slower on sagittal (26.9 vs 8.5 ms).

I withdrew the report's '2-8x slower non-axial painting' and '1.5-2.7x slower display' for masks; they were artefacts, as the review said. The runtime choice (sparse bricked; dense only for sharing with Niivue) is now justified structurally: O(1) access, memory that follows the painted extent (3.0 MiB vs 100 MiB), no per-slice grow, and display parity.

I moved SliceMaskStack out of @osdlabel/volume. Evidence: results/representative.json labels.rows and memory; volume and poc-volume unit tests show 0 voxel mismatches across all four representations.

- B2 (H1c, missing scenarios). The plan now includes scroll-sagittal, a linked three-plane crosshair (CPU, 3 workers, and CPU with a sagittal-major copy), and a 0-500 annotation sweep in 'all' and 'changed' modes. The decoration phase is split into providers, DecorationLayer and renderAll. Every canvas-drawer loop runs 3 times, and the medians and ranges are in loopSummary and sweepSummary. Run 2, with run 1 in parentheses:
- sagittal scroll: 31.0 [26.7-32.6] (29.4); with the copy 38.9 [31.3-51.4] (49.3)
- crosshair: CPU 21.1 [20.5-21.1] (21.2); workers 21.6 [21.2-29.2] (34.0); with the copy 30.5 [25.4-31.2] (28.2)
- scroll-axial at 518 annotations: 23.5 'all' / 43.9 'changed' (26.6 / 40.7). Decorations take 18.6 ms in 'all' (DecorationLayer 12.8) and 3.2 ms in 'changed'.

The claim is scoped as follows:

- Reach 30 fps on CPU: pan-zoom, axial and coronal scroll, and annotation-heavy axial scroll in 'changed' mode.
- Borderline: sagittal scroll and oblique rotation.
- Miss: the linked crosshair on CPU (workers inconsistent between runs; about 30 only with a +200 MiB copy), and any crosshair with 118 or more annotations.

The '40-58 fps' headline is withdrawn.

- B3 (H1d, GPU copies). Verdict downgraded to partial. The device-independent allocation tracker is now read on the Niivue page before and after adding the shared WebGL2 reslicer:
- Niivue: R16I 209,715,200 B + RGBA8 gradient 419,430,400 B, about 3.0x the volume.
- Drawing layer: + RGBA8 838,860,800 B.
- Reslicer: + R16F 209,715,200 B, for a total of 1,679,451,604 B in 2 live contexts.
  The composition therefore holds 2 GPU copies of the scalar data: 4.0x the volume's bytes, or 8.0x with the drawing layer. CPU stays one shared copy, except for the optional sagittal-major copy.

I withdrew 'at most one GPU copy' for the composition and stated what sharing would need. WebGL cannot share textures across contexts, so the options are: CPU reslicing whenever a Niivue cell exists (GPU 3.0x); the reslice shader running in Niivue's context against its R16I texture (not public API); or one context for 2D and 3D cells. Evidence: representative.json niivue.setup.glMemoryAfterVolume, niivue.labels.glMemoryAfterDrawing, niivue.composed, and mpr[0].glMemory (1 R16F texture alone).

## Independent review

A second agent re-ran the benchmark and tried to break the conclusions.

### Blocking findings

- **H2c's dense-vs-per-slice-mask comparison mostly measures benchmark artifacts, not the two representations. Those ratios are what rejected_alternatives uses to reject masks ('non-axial painting is 2-8x slower ... display reslicing is 1.5-2.7x slower in every view').**
  - Evidence: bench-page.ts labels() paints the axial view first and always times dense before masks. The 100 MiB dense ArrayBuffer is lazily committed, so its first-touch page faults land in the 'dense axial' bucket. My Node probe (/tmp/claude-0/-home-user-osdlabel/d2340e79-db4e-595c-a199-55b42694fb93/scratchpad/volrev/labels-probe.out): dense axial first rep 1.69 ms as shipped vs 0.26 ms pre-touched; median 0.368 -> 0.088. The two sides also run different algorithms. Axial masks use @osdlabel/mask's span-fill stampCircle; dense uses the generic per-voxel forEachVoxelInDisc callback. SliceMaskStack.reslice does a Map.get plus a method call per pixel even when k is constant (axial). Hoisting that lookup cut masks from 8.7 to 6.5 ms (dense 4.5) and from 16.4 to 8.0 ms on sagittal, where dense measured 16.0 in that noisy run. Non-axial painting does not reproduce. In my full bench run, coronal was dense 0.221 vs masks 0.129 ms; the report has dense 0.069-0.089 vs masks 0.18-0.53. Pre-touched in the probe it was 0.087 vs 0.100, sagittal equal, oblique within 15%. The paint 'p95' is the max of n=5 samples.
  - Required fix: Pre-touch the dense buffer or alternate order and view sequence, use the same stamping algorithm for both, hoist the per-slice lookup in the mask reslice, and take at least 20 samples per cell. Otherwise drop the ratios and justify a dense (bricked) runtime label map on structural grounds: it shares Niivue's drawing buffer, gives O(1) voxel access, and avoids @osdlabel/mask's per-slice grow() reallocation.
- **H1c's headline '40-58 fps scroll and rotate (27.5 worst)' leaves out the slowest orthogonal view and the most common multi-plane MPR interaction. It also covers only 18 annotations. The binding to scrolling and rotation at >=30 fps is overstated.**
  - Evidence: The run.mjs plan loops scroll-axial, scroll-coronal and rotate-oblique, but never scroll-sagittal, even though sagittal is the slowest orthogonal reslice (7.3-15.9 ms in the report, 14.3 ms in my run that started quiet). I added the missing loops temporarily (since reverted) and ran them on the stock mpr.html with the canvas drawer, in the same page as the axial baseline. At load ~2.5: axial 55.8/56.7 fps; sagittal CPU 33.0 fps (reslice 16.2 ms, frame p95 50 ms); linked crosshair (axial+coronal+sagittal resliced per frame) 24.1 fps (CPU) and 25.9 fps (3 workers). At load ~4: sagittal 22.2 fps, crosshair 24.4/26.1 fps. With 500 extra axial polygons (518 annotations, ~250 decorations per frame), axial scroll fell from 56 to 30.8 fps and coronal to 31.3 fps; the decoration phase was 11.6 ms median and 28 ms p95. All four cells re-run their providers every frame. Output: /tmp/claude-0/-home-user-osdlabel/d2340e79-db4e-595c-a199-55b42694fb93/scratchpad/volrev/probe.json and probe2.json.
  - Required fix: Add scroll-sagittal, linked-crosshair (3 planes per frame) and an annotation-count sweep to the MPR plan, and report them under H1c. Scope the summary's fps range to the scenarios measured, and state that the linked crosshair misses 30 fps on CPU here, with workers not helping.
- **H1d's verdict 'confirmed' (one CPU copy, at most one GPU copy) contradicts the report's own evidence for the recommended composition.**
  - Evidence: The same report measures Niivue at about 3.2x the volume in GPU-process memory (my run: 48 -> 685 MiB for the 200 MiB volume). Niivue's source allocates R16I plus R8 and RGBA8 gradient 3D textures, so this is more than one copy-equivalent. Its drawing layer adds an RGBA CPU expansion (renderer +~400 MiB; my run 398 -> 763 MiB). With the 'optional single shared WebGL2 reslicer' that the recommendation keeps, the volume sits on the GPU twice: the reslicer's r16 texture and Niivue's textures.
  - Required fix: Downgrade H1d to partial, or scope it explicitly to the reslice path without Niivue. State the composed-layout GPU and CPU totals.

### Non-blocking findings

- The per-phase budget in H1c (OSD world.draw 0.11 ms, 'putImageData' 0.42 ms) times recording, not raster. Chrome's 2D canvas defers drawImage. My probe (/tmp/claude-0/-home-user-osdlabel/d2340e79-db4e-595c-a199-55b42694fb93/scratchpad/volrev/raster-probe.mjs) timed drawImage of a 512x714 canvas through a transform at 0.10 ms, and the forced flush at 3.6 ms. The fps figures (rAF cadence) still count the raster, but the phase table understates per-frame cost by ~3-4 ms. The data-URL rejection's '0.08 + 0.11 ms' is understated by roughly 30x; its conclusion probably still holds. The 'upload' phase is LUT + putImageData + invalidate, not putImageData alone.
- Absolute CPU numbers depend on the host as well as on contention. My run reported Xeon @ 2.80GHz; the PoC's reported @ 2.10GHz. Started at load 0.5, it gave axial 2.38 ms (claimed 1.16/1.27), sagittal 14.31 ms with p95 14.83 (claimed 7.33 A / 15.88 B) and oblique 11.01 ms (claimed 7.5-7.75). H1a's line that 'sagittal met it only on the quieter run' attributes the gap to contention; a tight 14 ms on a quiet start says otherwise. H1a stays partial.
- The microbenchmarks reslice the same plane every repetition, so caches are warm, and the axial 'reslice' sits on voxel centres, so it is a pure gather/copy. Both are labelled, but they are optimistic relative to scrolling.
- GL-vs-CPU agreement is checked after an 8-bit window (centre 40, width 400). That window saturates outside [-160, 240] HU and quantizes at ~1.6 HU, so it cannot verify HU fidelity. The claim that 'r16f loses 1-2 HU above 2048' is theory, not measurement.
- The E2E cross-view checks assert row plus span for segments, and only a marker count in the Solid check. A mirrored or shifted axis would pass. I checked the actual positions: the coronal segment runs x 153.6..307.2 (= r1.x..r2.x) and the sagittal one 153.6..281.6 (= r1.y..r2.y), so the projection is right and only the assertions are weak. Nothing checks the oblique cell's projections.
- H3b 'confirmed' is better called partial. The SVG overlay has no depth occlusion. The accuracy test hides the volume and is self-consistent by construction: lesion painting and overlay go through the same index -> Niivue mm mapping, so it cannot detect the acknowledged LPS/RAS mirror between the 3D and 2D cells.
- The Niivue '3.2x' and '12x' figures are SwiftShader GPU-process PSS, but the summary calls them 'GPU memory'. 3.2x is plausible from Niivue's own texture allocations. 12x for the drawing layer probably includes SwiftShader staging. Instrumenting texStorage3D/texImage3D bytes would give a device-independent number.
- The api_sketch mixes implemented and proposed APIs without saying which is which. PlaneRegistry, the registry-based createCrossViewProvider that reads ctx.imageId, fromSliceStack, @osdlabel/volume-osd and @osdlabel/niivue do not exist. The tested provider takes closures (getView, getForeign), ignores ctx.annotations and reads global mutable state. That is why it re-runs under Solid's fine-grained tracking, and why React would need extra invalidation. The 'existing DecorationProvider unchanged' story is shown for Solid only.
- The sketched @osdlabel/volume-osd mixes concerns: reslicer backends (CPU, a worker split that duplicates @osdlabel/volume's row bands, and WebGL2), the OSD tile source and an interaction controller. Its VolumeCellController takes PlaneRegistry (mpr) and returns ImageSource (viewer-api), yet its dependency list names neither. Better: CPU/worker reslicing in @osdlabel/volume, WebGL2 in its own package, and volume-osd limited to the tile source, invalidation and the controller. @osdlabel/volume depends on @osdlabel/mask only for the comparison class.
- ImageId-per-plane-position leaves the recommended runtime model incomplete. Oblique ids are frame hashes, so serialize() output cannot be reloaded without the host registry. Tool constraints and context imageIds also become per-slice, and the host has to call assignImageToCell on every scroll step.
- Diff bookkeeping is correct in its totals: 6 existing source files +37/-5, and 63 new files +9794. But pnpm-lock.yaml is a modified existing file (+271) listed under 'new', and the new-line breakdown (1762+768+3483+3462+271) omits 319 lines of package and app config.
- Cornerstone3D is rejected for 'no measured benefit', but nothing was measured. The vtk.js size (862/205 KiB) comes from an uncommitted scratch build and cannot be reproduced. vtk.js never ran.
- Benchmarks run on the Vite dev server (unbundled, Solid dev build), not on a production build. CPU kernels are unaffected; binding overhead may be slightly inflated.
- The binding changes (Solid and React ViewerCell) have no parity unit tests, which CLAUDE.md's binding-parity rule requires (the report acknowledges this). I did not rerun the existing suites. The new packages' tests pass: spatial 16, volume 13, mpr 7.

### Claims checked

| Claim                                                                            | Verdict    | Note                                                                                                                                                                                                                                                    |
| -------------------------------------------------------------------------------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Existing packages changed by +37/-5 lines in 6 files; 63 new files +9794         | holds      | git diff --numstat matches: provider.ts +8/-1, fabric-overlay.ts +10, live-decoration-updates.ts +5/-2, React ViewerCell +10/-1, Solid ViewerCell +2/-1, pnpm-workspace +2. pnpm-lock.yaml (+271) is a 7th modified existing file, counted under 'new'. |
| H1a: orthogonal CPU reslice under 10 ms (partial)                                | overstated | Axial 2.38 and coronal 3.72 ms hold. Sagittal was 14.31 ms (p95 14.83) in my run that started quiet, so blaming run B's 15.9 ms on contention alone is not supported.                                                                                   |
| H1b: oblique trilinear 7.5-7.8 ms; 4 workers 5.2-6.5 ms                          | holds      | Same order of magnitude: 11.01 ms main thread, 5.12 ms with 4 workers in my run. Absolute values depend on the host.                                                                                                                                    |
| WebGL2 numbers are SwiftShader and labelled as such                              | holds      | Labelled everywhere. My run: r16i draw+readPixels 13/18/34/17 ms; all formats within 1 grey level of CPU.                                                                                                                                               |
| H1c: canvas-drawer cells scroll and rotate at 40-58 fps                          | overstated | Reproduced for the planned loops (axial 59.0, coronal 54.5, oblique with workers 54.1, oblique CPU 35.3). Outside them, sagittal ran 22-33 fps, the linked crosshair 24-26 fps, and 518 annotations brought axial to 31-38 fps.                         |
| Per-frame budget: OSD draw 0.11 ms, putImageData 0.42 ms                         | wrong      | These are deferred-recording costs. drawImage records in 0.10 ms; the flush takes 3.6 ms.                                                                                                                                                               |
| H1d: memory bounded, at most one GPU copy (confirmed)                            | overstated | Niivue ~3.2x volume in GPU-process memory, an RGBA CPU copy of the label map, and two GPU copies when the WebGL2 reslicer and Niivue coexist.                                                                                                           |
| H2a: cross-view projection correct, 10/10 real-tool checks                       | holds      | Reproduced 10/10 with both drawers; marker anchor error 1.2e-5 px. The checks are weak (row + span only), but I confirmed the horizontal positions by hand.                                                                                             |
| H2b: Solid stock ViewerCells 8/8; providers re-run 3.0 per frame                 | holds      | Reproduced 8/8 and 3.025 runs per frame. React was not exercised; the closure-based providers rely on Solid's tracking.                                                                                                                                 |
| Stock Solid ViewerCell fps (7.2) is SwiftShader/WebGL-drawer bound               | holds      | The same stock cells reached 55.4 fps with 0 contexts when OpenSeadragon.DEFAULT_SETTINGS.drawer = 'canvas', against 17.2 fps with the default drawer, in the same conditions.                                                                          |
| Canvas drawer for ViewerCell needs a ViewerCell/osd-helper viewer-options change | overstated | A global DEFAULT_SETTINGS override works with no library change. A per-cell option is still cleaner.                                                                                                                                                    |
| H2c: dense wins non-axial painting 2-8x and display 1.5-2.7x                     | wrong      | Painting does not reproduce: in my run coronal was dense 0.221 vs masks 0.129. The numbers are confounded by first-touch faults, different algorithms and per-pixel Map.get; with the lookup hoisted, the display gap mostly closes.                    |
| H3a: Niivue keeps our SAB Int16Array without copying                             | holds      | imgIsOurArray true in my run; renderer PSS shows no second 200 MiB copy.                                                                                                                                                                                |
| Niivue GPU memory 3.2x volume, 12x label bitmap                                  | overstated | Measured as SwiftShader GPU-process PSS. 3.2x is plausible from Niivue's texture allocations; 12x is not separated from SwiftShader staging.                                                                                                            |
| H3b: 3D view shows annotations, overlay error <1 px (confirmed)                  | overstated | Reproduced identical errors (0.57/0.18/0.38/0.95 px). There is no occlusion, and the test is self-consistent by construction, so it cannot detect the LPS/RAS mirror.                                                                                   |
| H3c: within WebGL context budget                                                 | holds      | My run: Niivue page 1 live; canvas MPR 1 (reslicer); WebGL MPR 9 created / 5 live; Solid 6 created / 3 live.                                                                                                                                            |
| H3d: rotation untested on real GPU                                               | holds      | 1.39 fps under SwiftShader in my run; correctly marked untested.                                                                                                                                                                                        |
| Bundle sizes niivue 1514/449, MPR cell 706/173, new packages 31/10 KiB           | holds      | Reproduced exactly.                                                                                                                                                                                                                                     |
| vtk.js minimal volume cell 862/205 KiB                                           | unchecked  | From an uncommitted scratch build; cannot be reproduced from the branch.                                                                                                                                                                                |
| All existing unit tests still pass                                               | unchecked  | Not rerun. The new packages' tests pass (16 + 13 + 7).                                                                                                                                                                                                  |
| Cornerstone3D monolith rejected for 'no measured benefit'                        | overstated | Nothing about Cornerstone3D was measured; the rejection rests on architecture, not data.                                                                                                                                                                |

### Reviewer's rerun

Checked out origin/claude/poc-volume (c3b71f6) detached. pnpm install linked all 655 packages but exited on ERR_PNPM_IGNORED_BUILDS for cbor-extract (a Niivue transitive dependency); that is harmless. `pnpm exec turbo run build --filter='@osdlabel/poc-volume^...'`: 15/15 tasks, all cached. Ran `pnpm --filter @osdlabel/poc-volume bench -- --port 5737 --out <scratch>/volrev/full.json` once, 13:29-13:36 UTC, exit 0. Host reported Xeon @ 2.80GHz (the PoC's reported @ 2.10GHz). Load was 0.5 at start and rose to ~4.8 after another agent's SwiftShader bench started at ~13:34, overlapping my Solid and Niivue sections.

What I got:

- CPU reslice median: axial 2.38, coronal 3.72, sagittal 14.31, oblique trilinear 11.01 ms. 4 workers: oblique 5.12, sagittal 7.82 ms.
- WebGL2 (SwiftShader) r16i/r16f/r32f: draw+readPixels 8-34 ms, max 1 grey level vs CPU.
- Labels: dense axial 0.142 vs masks 0.022 ms; coronal 0.221 vs 0.129 (masks faster, the reverse of the report). Display: dense faster in all four views.
- MPR canvas drawer: pan-zoom 60, axial 59.0, coronal 54.5, oblique CPU 35.3, oblique with workers 54.1, oblique GL 22.9 fps. WebGL drawer: 12-28 fps. Cross-view 10/10 with both drawers.
- Solid: 8/8, 16.2 fps (WebGL drawer).
- Niivue: zero-copy true, 1 context, rotation 1.39 fps, overlay error 0.57/0.18/0.38/0.95 px, GPU-process PSS 48 -> 685 -> 1881 MiB.
- Bundle sizes identical to the report.

Extra probes, with local edits since reverted (the tree is clean):

- Sagittal scroll 33.0 fps at load ~2.5 and 22.2 at ~4. Linked crosshair 24.1/25.9 fps (CPU/workers).
- 518 annotations: axial 30.8 fps, decorations 11.6 ms median.
- Stock Solid ViewerCells with OpenSeadragon.DEFAULT_SETTINGS.drawer = 'canvas': 55.4 fps, against 17.2 fps default.
- 2D drawImage: record 0.10 ms, flush 3.6 ms.
- Node label probe: first-touch and wrapper overhead explain most of the dense-vs-mask gaps.

Artifacts are in /tmp/claude-0/-home-user-osdlabel/d2340e79-db4e-595c-a199-55b42694fb93/scratchpad/volrev/: full.json, full.log, probe.json, probe2.json, labels-probe.out, mpr-probe.mjs, labels-probe.mjs, raster-probe.mjs.

### Alternatives the reviewer says were missed

- Force OSD's canvas drawer for stock ViewerCells through OpenSeadragon.DEFAULT_SETTINGS.drawer with no library change. Measured: 55 fps vs 17 fps, 0 WebGL contexts. It is a stopgap until a per-cell viewer option exists.
- Run reslice, LUT and raster in a worker with OffscreenCanvas and transfer an ImageBitmap, so the main thread and the 2D-canvas raster (~3.6 ms per frame) stay off the critical path.
- Give sagittal and other cache-hostile views a transposed or bricked copy, or a tiled voxel layout. That is the obvious remedy for the 14-16 ms sagittal reslice and the crosshair case; it is named only as a risk.
- Test a WebGPU compute reslicer (the runner already passes --enable-unsafe-webgpu, and Niivue ships a WebGPU build). It was never tried.
- Use Cornerstone3D's volume loading and streaming, or vtk.js ImageReslice, purely as the volume engine feeding osdlabel cells. That is a middle ground between a monolith and writing spatial/volume from scratch, and it reuses DICOM loading and progressive streaming.
- Count GPU memory device-independently by instrumenting texStorage3D/texImage3D/bufferData bytes, instead of reading SwiftShader GPU-process PSS.
- Keep cross-view providers pure: give DecorationContext a cross-image accessor (e.g. annotationsForImage), so React re-runs correctly and providers stop reading global state through closures.
- Index cross-view providers spatially (per-slice buckets or interval lists) and re-run only the cells whose plane changed, so decoration cost does not grow with total annotation count.
- Make plane-encoding ImageIds deterministic and reversible (quantized IPP/IOP in the id), or carry PlaneFields at runtime, so oblique annotations survive serialize/deserialize without a host registry.
- Measure a sparse bricked label volume (e.g. 32^3 bricks allocated on demand) instead of deferring it. It is the likely winner on both memory and access cost.
