# Proof of concept: stacks and cine through a frame axis

Branch `claude/poc-frame-axis`, head `d7363fe2df` at the time of the result. Part of the osdlabel roadmap study (branch `claude/osdlabel-roadmap-strategy-uut5ay`). Written by the orchestrating agent from the PoC agent's structured result, because PoC agents in this environment cannot write report files.

**Status:** Build, independent review and fix pass complete. The fix pass reversed the annotation keying: a frame axis for pixels and navigation, one image ID per slice for annotations. Timings are from a loaded 4-core machine with a software GPU; a quiet-machine rerun follows.

## Summary

I fixed all four blocking findings from the review on claude/poc-frame-axis (5 commits, ab4b2a6..d7363fe, all pushed fast-forward). I re-measured everything and changed the code and the claims. The fixed comparison reverses part of the PoC's recommendation.

(1) Fair model comparison. I built the alternative on equal footing. A FramedImageSource can now carry `sliceImageIds`, a series grouping with one ImageId per slice. That cell uses the SAME FramePresenter, keeps the user's view, and has one grid assignment (the series id). It keys annotations on byImage[sliceImageIds[frame]] and puts no `frame` field on annotations. Both models were measured in the real Solid binding: 5 repetitions each, median (min-max), canvas drawer, Fabric objectCaching off.

- Scroll throughput ties at 10 and 50 annotations per slice: 52.8-53.1 vs 50.5-53.2 slices/s, and 29.2-32.6 vs 31.2-33.3.
- At 200 per slice the slice-id model scrolls faster: 13.2-16.2 vs 11.2-12.3 slices/s.
- Both models keep the view and show 0 incoherent and 0 blank paints.
- The slice-id model wins on edit cost: 13.6 vs 14.7 ms at 10 per slice, 68.5 vs 82.7 ms at 50, 207 vs 407 ms at 200.
- It wins on per-slice limits. Frame-axis 'per-frame' scrolls at 0.3 slices/s with a 76.6 ms edit; slice ids give 30-32 slices/s and a 3.0 ms edit.
- It also wins on JSON size (5% smaller), on key stability (an ImageId can be the SOPInstanceUID, so there is no reconcile step), on deserialize time, and on needing no annotation schema change.
- Frame-axis keeps three unbuilt advantages: native series-level annotations, per-series limits without listing slice ids, and `time` stored on the annotation.

So H1 is now partial and H1-alt is confirmed. The recommendation becomes: a frame axis for pixels and navigation, and per-slice ImageIds for annotations. That is a maintainer decision.

(2) The binding path is now real. A public provider prop `frameCellOptions` (FrameCellOptions / DEFAULT_FRAME_CELL_OPTIONS in osdlabel) sets three things:

- the OSD drawer for stack cells (default canvas; chosen when the viewer is created, and switched with the public `requestDrawer` when the kind of source changes);
- Fabric objectCaching for annotation objects (default off);
- opt-in object reuse.
  The harness no longer sets globals for the stack models. With these defaults the Solid binding gives 58 / 53 / 30-33 / 11-12 slices/s at 0 / 10 / 50 / 200 annotations per slice. Fabric caching on gives 10.7-11.3 slices/s at 50 per slice. WebGL on SwiftShader gives 7.6-7.8 at 10 per slice.

(3) Cache vs rebuild. Rebuilding each frame's objects with objectCaching off, rendered as soon as the microtask-only revive settles, beats VectorObjectCache plus look-ahead in every pass. Cold-pass medians: 52.8 vs 47.6 slices/s at 10 per slice, 29.2 vs 20.2 at 50, 12.3 vs 6.8 at 200. The rebuild also uses less memory at 10 and 50 per slice. So the cache is off by default and recommended for removal. It stays opt-in only so the comparison can be re-run, and it now evicts objects when a Fabric transform starts; wheel frame steps wait while a transform is active.

(4) Cine stepping now uses the vsync-aligned rAF timestamp with a half-vsync phase. Measured over 3 runs:

- 30 fps passes on every canvas path, 0-1.4% dropped.
- 60 fps passes on the resident paths: RGBA 2.0-3.3%, ImageBitmap 0.7-4.3%.
- 60 fps fails on the decode paths: WebCodecs 5.7-11%, <video> 45%.

The fixes exposed two bugs, both now fixed:

- Before its first frame was presented, a stack cell revived every frame's objects at mount: 60,000 at 200 per slice. That overflowed the stack in canvas.add(...) and made mount take 9.3 s; it now takes 3.3 s.
- The frame index was built through Solid store proxies, about 400 ms per edit at 60,000 annotations. It is now built over plain objects.

Also corrected:

- UIState.cellFrames and the frame shortcuts are now optional, and the reducers no longer throw on a UIState without cellFrames.
- OSD 6.0.0+ does ship viewer.requestInvalidate / TiledImage.requestInvalidate and a 'tile-invalidated' event, and deprecates the hooks createCanvasTileSource uses. I verified this in the 6.1.1 tarball. FramePresenter needs porting and re-validation there.

Both E2E suites pass (172 passed, 1 skipped each), and all 46 typecheck and unit-test tasks pass. Timings are noisy: 1-minute load average 3.7-7.2 on 4 cores, and WebGL is SwiftShader only.

## Hypotheses and verdicts

### H1: partial

A stack is best modelled as ONE ImageSource with a frame axis plus an optional annotation extension field (FrameFields { frame: FrameRef }), as an extension of today's model rather than a rewrite.

Part 1 is confirmed: ONE image source with a frame axis for pixels and navigation (FramedImageSource + FramePresenter + UIState.cellFrames + wheel/keyboard stepping, one grid assignment, view kept). It is an extension, not a rewrite, and both annotation models share it. Part 2 is refuted: FrameFields on annotations is not the better annotation key. On equal footing, with the same presenter, binding and options, the slice-id series grouping (H1-alt) ties or wins on every measured cost.

Solid binding, run R2 at 3e6ded1, 5 reps, median (min-max). Columns are frame-axis vs slice-ids:

- Cold-pass slices/s: 52.8 (51.5-55.7) vs 50.5 (48.5-51.9) at 10 per slice; 29.2 (27.4-29.5) vs 31.2 (28.7-32.1) at 50; 12.3 (11.4-14.0) vs 13.8 (13.4-14.4) at 200.
- Window-pass slices/s at 200 per slice: 12.2 vs 16.2.
- Edit (addAnnotation, synchronous Solid work): 14.7 vs 13.6 ms at 10 per slice, 82.7 vs 68.5 at 50, 407 vs 207 at 200.
- With a per-slice limit at 50 per slice: 0.3 vs 30.2-32.3 slices/s, and edit 76.6 vs 3.0 ms. Frame-axis 'per-frame' recounts the whole series through store proxies on every step, with synchronous work p95 91 ms.

Model bench R1:

- 'per-frame' count 1.05/5.71 ms vs 0.01/0.025 ms. Counted from the bucket index it would be 0.005 ms, but that production change is not built.
- JSON +5.0%.
- Deserialize 91 vs 83 ms and 396 vs 321 ms.
- Frame-axis needs reconcileFrameRefs when the axis is reordered (0.45/3.77 ms). Slice ids are stable keys.
- Pre-frame readers silently strip `frame` and show every annotation on every slice (unit test). Slice-keyed data survives old readers unchanged.

Where frame-axis wins (qualitative, not built for slice ids): series-level annotations (absent frame), per-series limits without enumerating slice ids, and `time` stored on the annotation for cine/video.

### H1-alt: confirmed

Alternative: one ImageId per slice plus a series grouping is as good a model.

The earlier 'refuted' verdict measured today's per-assignment viewer re-open, which is a strawman. That reference path is still measured: 0 slices/s, view reset from 90 deg / 2x to 0 deg / 1x.

Built properly: FramedImageSource.sliceImageIds plus CellFrame.sliceImageIds (registered by SET_CELL_FRAME) plus cellAnnotationImageId(ui, cell). The cell presents pixels through the same FramePresenter, looks up byImage[sliceImageIds[shownFrame]], stamps new annotations with the slice id (no `frame`), and keeps one grid assignment (the series id) and the view.

Measured as good or better in the Solid binding (5 reps, R2):

- Throughput ties at 10 and 50 per slice and is +12-33% at 200 per slice.
- 0 incoherent, 0 blank paints, view kept.
- Edits 1.1-2x cheaper.
- Per-slice limits usable: 30-32 vs 0.3 slices/s.
- Memory is a tie: PSS 222 vs 212, 391 vs 376, 707 vs 681 MB.
- No annotation schema, validation or serialization change.
- JSON 5% smaller.

One fairness change was needed: the constraint memo keys on the grid assignment unless the context is image-scoped (usesImageScope). This mirrors the existing usesPerFrameScope gate. Without it, every step recounted all annotations under the default 'global' scope (12-25 vs 50 slices/s in a quick run).

Not built: showing series-level annotations from byImage[seriesId] alongside the slice's own, and a 'per-series' count scope.

### H2: partial

Scrolling a 300-slice 512x512 stack in one osdlabel cell sustains >= 30 fps (target 60) with per-slice annotations shown.

Solid binding with its new defaults: canvas drawer, objectCaching off, rebuild. Run R2, 5 reps, scripted 60 Hz wheel, view rotated 90 deg and zoomed 2x first (kept). Revisit-pass display fps / slices/s, median (min-max):

- 0 per slice: 59.4 / 58.0.
- 10: 54.8 (50.2-57.4) / 53.1.
- 50: 33.7 (31.5-34.2) / 32.6.
- 200: 12.1 (11.4-13.9) / 11.2 (frame-axis); slice-ids 14.1 / 13.2.

So it holds at 10 per slice, is borderline at 30 fps for 50, and fails at 200 on this loaded 4-core CPU (load 3.7-7.2). The old 59.7 fps / 58 slices/s at 50 per slice was a single sample and does not reproduce: the reviewer got 30.8-41.7, this run 29-33.

Incoherent paints: 0 in every pass. Blank paints: 0.

Fabric object caching on: 10.7-11.3 slices/s at 50 per slice.

WebGL drawer (opted in, SwiftShader CPU emulation): 7.6-7.8 slices/s at 10 per slice. Real-GPU WebGL is untested.

### H2a: confirmed

Of the OSD strategies (a) open per slice, (b) persistent TiledImage reset/re-fetch, (c) preloaded TiledImages by opacity, (d) one custom single tile repainted in place, (d) is the one to build on.

Run R1 (7383321), canvas drawer, no annotations, load about 5. Latency is p50 / p95.

- (d) mutable tile: 16.8 / 19.0 ms; 50.9 slices/s at 60.9 fps under 'latest'; 58.3 await-drawn; 0 blank; +121 MB; setup 1,178 ms; pixel check 15/15.
- (c) opacity: 17.0 ms; 44.9 / 58.9 slices/s; +429 MB; setup 4.3 s. On WebGL: +828 MB, 52.6 s setup.
- (b) reset: 33.5 ms; 0.3 slices/s under 'latest'; 29.9 await-drawn with 91 blank paints.
- (a) open: 33.6 ms; 0.3 / 29.6 with 90 blank.
- (a') PNG: 43.5 ms; 0.7 / 19.9 with 58 blank; setup 5.7 s.
- (d') ImageBitmap: 16.9 ms; 58.6 slices/s; +411 MB.
- WebGL (SwiftShader) mutable: 121.9 ms; 8.4 slices/s. Negative control without texture invalidation: 0/15.

OSD 6 note: the internals (d) relies on are replaced in OSD 6 by public requestInvalidate / 'tile-invalidated'. A port is needed and has not been measured.

### H2b: confirmed

FabricOverlay sync stays exact while frames change.

vpt diff 0 and zoom drift 0 for every strategy and drawer (R1). This holds by construction under (d): a frame change never touches the viewport or the world, so it is not evidence beyond that. In the Solid binding the rotated, zoomed view was kept in every frame-axis and slice-ids repetition (5/5 each).

### H2c: partial

The Fabric annotation swap and the decoration recompute per slice fit in a frame at 0/10/50/200 annotations per slice.

Vanilla harness, R1, canvas drawer, load about 4.3-5.3. Per-step p50 at 10 / 50 / 200 per slice, objectCaching off:

- Swap: 0.43 / 1.23 / 7.23 ms with the cache; 0.32 / 0.80 / 3.20 ms with rebuild-async.
- Decorations: 1.0 / 2.6-3.2 / 8.6-9.6 ms.
- Fabric render: 0.42-0.46 / 1.05-1.11 / 3.7-9.6 ms.

Scroll throughput at 10 / 50 / 200: cache-nocache 47.4 / 35.1 / 15.8 slices/s; rebuild-sync-nocache 48.0 / 35.2 / 15.3; rebuild-async-nocache 44.9 / 34.6 / 12.8.

With objectCaching on, render p50 is 7.1 / 31.8 / 299 ms (cache) and 6.8 / 26.4 / 171 ms (rebuild-async).

It fits at 10 per slice. At 50 it fits a 30 fps budget. At 200 the budget is blown by decorations plus swap plus render. Absolute numbers are 2-4x slower than the earlier run C on the same code paths because of machine load.

### H2d: confirmed

Annotations and decorations land in the same paint as their slice's pixels.

0 incoherent paints in every recorded pass of every Solid configuration in R2: frame-axis and slice-ids, rebuild and reuse, 10/50/200 per slice, cold, revisit and window passes, 5 reps (225 passes). Rebuild mode reaches this by rendering synchronously as the microtask-only revive settles, before the paint.

Two caveats on the measurement:

- The paint-landing rule changed in this session. A microtask after a frame's last rAF callback now counts in that frame's paint, per the HTML event loop: a MessageChannel message posted at frame start marks the end of the rendering phase. Before, it counted in the next paint.
- The counter compares JS-side canvas tags with Fabric object ids. It does not read back pixels.

The reference per-assignment path had 46 incoherent paints in its real-wheel run.

### H2e: refuted

Reusing revived objects across frames (VectorObjectCache with a 5,000-object LRU and 4-frame look-ahead) beats rebuilding each frame's objects with Fabric objectCaching off.

Solid binding, R2, 5 reps each, median (min-max) slices/s for the cold / revisit / window passes:

- 10 per slice: rebuild 52.8 / 53.1 / 52.8; reuse 47.6 / 51.5 / 49.6.
- 50 per slice: rebuild 29.2 / 32.6 / 30.5; reuse 20.2 / 22.8 / 29.0.
- 200 per slice: rebuild 12.3 / 11.2 / 12.2; reuse 6.8 / 6.0 / 9.9.

Memory, rebuild vs reuse: PSS 212 vs 304, 376 vs 442 and 681 vs 622 MB; JS heap 97 vs 121, 128 vs 196 and 259 vs 272 MB. Incoherent paints: 0 for both.

The vanilla harness agrees (R1): cache-nocache vs rebuild-sync-nocache 47.4 vs 48.0, 35.1 vs 35.2 and 15.8 vs 15.3 slices/s, with +402 vs +232 MB at 200 per slice.

The window pass, sized to fit the LRU bound (W = 180 / 100 / 25 frames), is reuse's best case, and it still only ties.

## Measurements

| Measurement                                                                    | Value                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | Unit                    | Conditions                                                                                                                                                                                                                                                                                                              |
| ------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| environment                                                                    | HeadlessChrome/153; WebGL2 = ANGLE Vulkan SwiftShader (Subzero); hardwareConcurrency 4; crossOriginIsolated; idle rAF 59.3 fps (R1) / 60.0 fps (R2); idle browser PSS 266 MB                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | -                       | Run R1 = full bench at 7383321, 2026-10-24 11:46-12:34Z, 1-min load 4.1-5.7 (env, model, strategies, layers, cine). Run R2 = env+solid at 3e6ded1, 12:38-13:03Z, load 3.7-7.2. Merged into apps/poc-frame-axis/results/representative.json (commit 9707e3f). 900x900 page, 768x768 cell. Other agents ran concurrently. |
| bench wall time                                                                | R1 47.5 min (of which 32 min Solid group before the mount fix, superseded); R2 Solid group 24.9 min; full matrix at HEAD about 40 min                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | min                     | Defaults: --reps 5, --cine-reps 3                                                                                                                                                                                                                                                                                       |
| Solid: frame-axis vs slice-ids, scroll throughput (binding defaults)           | Cold / revisit / window slices/s, median (min-max). 10 per slice: frame-axis 52.8 (51.5-55.7) / 53.1 (49.5-55.8) / 52.8 (51.8-54.8); slice-ids 50.5 (48.5-51.9) / 52.2 (51.5-52.8) / 53.2 (50.2-55.4). 50 per slice: frame-axis 29.2 (27.4-29.5) / 32.6 (30.5-33.3) / 30.5 (29.4-35.5); slice-ids 31.2 (28.7-32.1) / 33.3 (30.8-35.2) / 32.5 (30.5-37.1). 200 per slice: frame-axis 12.3 (11.4-14.0) / 11.2 (10.5-13.0) / 12.2 (11.2-13.7); slice-ids 13.8 (13.4-14.4) / 13.2 (12.5-13.7) / 16.2 (13.8-17.5). Incoherent paints 0 and blank paints 0 in every pass.                                                                                                                           | slices/s                | R2, real AnnotatorProvider + ViewerCell (built dist), 300 x 512^2 CT phantom, scripted 60 wheel events/s for 3 s per pass, canvas drawer, objectCaching off, rebuild (binding defaults via frameCellOptions). Same FramePresenter for both models. 5 fresh pages each. Window W = 180/100/25 frames. Load 3.8-5.5.      |
| Solid: revisit-pass display fps and synchronous wheel work                     | Display fps, frame-axis / slice-ids: 0 per slice 59.4; 10 per slice 54.8 / 54.4; 50 per slice 33.7 / 34.6; 200 per slice 12.1 / 14.1. Synchronous wheel-handler work p95: 1.06-1.84 ms for both models.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | fps / ms                | R2, medians of 5 (3 for 0 per slice)                                                                                                                                                                                                                                                                                    |
| Solid: edit cost (one addAnnotation on the shown frame)                        | Frame-axis vs slice-ids, median of per-rep p50: 14.7 vs 13.6 ms at 10 per slice; 82.7 vs 68.5 at 50; 406.9 vs 207.4 at 200. With a per-slice limit at 50 per slice: 76.6 vs 3.0 ms.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | ms                      | R2, editProbe (11 adds per rep), synchronous Solid store write including memos and effects. Without a limit, both pay a 'global'-scope constraint recount through store proxies; profiled at about 330-430 ms per edit at 60,000 annotations. Frame-axis also rebuilds its series bucket index.                         |
| Solid: per-slice limit                                                         | Frame-axis 'per-frame': 0.3 (0.2-0.4) slices/s, 0.5 fps, synchronous work p95 91.4 ms. Slice-ids 'per-image' on the slice: 30.2 / 32.3 / 31.9 slices/s, 32.9 fps, p95 2.3 ms.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | slices/s                | R2, 50 per slice, rectangle maxCount 10,000 with countScope per-frame vs per-image, 5 reps. The frame-axis count iterates the whole series through store proxies on every step; counting from the bucket index (model bench: 0.005 ms) is not built.                                                                    |
| Solid: object reuse vs rebuild (objectCaching off)                             | Rebuild vs reuse, cold / revisit / window slices/s. 10 per slice: 52.8 / 53.1 / 52.8 vs 47.6 / 51.5 / 49.6. 50: 29.2 / 32.6 / 30.5 vs 20.2 / 22.8 / 29.0. 200: 12.3 / 11.2 / 12.2 vs 6.8 / 6.0 / 9.9. Incoherent 0 / 0. PSS delta: 212 vs 304, 376 vs 442 and 681 vs 622 MB. JS heap (window pass): 97 vs 121, 128 vs 196 and 259 vs 272 MB.                                                                                                                                                                                                                                                                                                                                                  | slices/s, MB            | R2, frame-axis model, frameCellOptions.reuseObjects false/true, 5 reps; the reuse cache is bounded at 5,000 objects with 4-frame look-ahead                                                                                                                                                                             |
| Solid: other configurations                                                    | Default, 0 per slice: 58.1 / 58.0 / 58.4 slices/s, PSS 126 MB. Fabric objectCaching on at 50 per slice: 10.7 / 11.3 / 10.9 slices/s, 12.3 fps. WebGL drawer opted in at 10 per slice: 7.8 / 7.6 / 7.7 slices/s, 8.4 fps. Today's per-assignment re-open path at 10 per slice: 0 slices/s, 13 ms synchronous p95, view reset rot 90 -> 0 and zoom 2x -> 1x.                                                                                                                                                                                                                                                                                                                                    | slices/s                | R2; 3 reps for 0 per slice, objcache and webgl; 1 rep for re-open. WebGL is SwiftShader CPU emulation and pessimistic.                                                                                                                                                                                                  |
| Solid: real wheel input (rep 1 of each config)                                 | 58.7-59.8 fps and 18.8-21.7 slices/s at 0-50 per slice for both models, 0 incoherent. 200 per slice: 34.3 fps (frame-axis) and 31.3 fps (slice-ids). Frame-axis per-frame limit: 19 fps / 7.6 slices/s. Re-open path: 46 incoherent paints.                                                                                                                                                                                                                                                                                                                                                                                                                                                   | fps / slices/s          | Playwright mouse.wheel for 2 s, bounded by the CDP round trip (15-46 events); checks correctness, not throughput                                                                                                                                                                                                        |
| Solid: mount time                                                              | Frame-axis 200 per slice: 9.3 s before the fix, 3.3-3.5 s after. 50 per slice: 0.65-0.94 s. Slice-ids 200 per slice: 2.7 s.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | s                       | Stack debug run and R2 setup.mountMs; before 3e6ded1 every frame's 60,000 objects were revived at mount, and canvas.add(...) overflowed the stack                                                                                                                                                                       |
| H1 model costs (pure, in page)                                                 | 300x10 / 300x50 annotations per slice: per-frame bucket index build 0.76 / 6.98 ms. Per-step lookup: indexed 0.15 / 0.15 us; naive filter 862 / 6,423 us; slice bucket 0.47 / 8.15 us. Per-slice limit: 'per-frame' 1.05 / 5.71 ms; from the index 0.005 / 0.005 ms; slice 'per-image' 0.010 / 0.025 ms. Per-series limit: frame-axis 'per-image' 1.03 / 5.31 ms; slice ids 'global' over 300 ids 0.22 / 3.14 ms. JSON: 3,604,289 vs 3,431,389 B and 18,271,221 vs 17,406,721 B (+5.0%). Serialize 21.1 vs 34.3 and 144.6 vs 150.8 ms. Deserialize 91.2 vs 82.8 and 396.3 vs 321.0 ms. reconcileFrameRefs: reversed axis 0.45 / 3.77 ms (all move); same order 0.13 / 0.78 ms, identity kept. | ms / us / bytes         | R1, median of 15 reps (5 for serialization), plain objects, no store proxies                                                                                                                                                                                                                                            |
| H2a strategies, canvas drawer                                                  | Latency p50 / p95 ms; slices/s under 'latest'; await-drawn slices/s and blank paints; memory. Mutable (d): 16.8 / 19.0; 50.9 at 60.9 fps; 58.3, 0 blank; +121 MB; setup 1,178 ms. Opacity (c): 17.0 / 18.4; 44.9; 58.9, 0 blank; +429 MB; 4,271 ms. Reset (b): 33.5 / 34.6; 0.3; 29.9, 91 blank. Open (a): 33.6 / 38.0; 0.3; 29.6, 90 blank. Open-PNG (a'): 43.5 / 47.6; 0.7; 19.9, 58 blank; 5,728 ms. Bitmap (d'): 16.9 / 18.3; 58.6; 56.7; +411 MB. Pixel verify 15/15 for all; vpt diff 0.                                                                                                                                                                                                | mixed                   | R1, no annotations, 3 s scripted scroll at 60 events/s, 40-step latency                                                                                                                                                                                                                                                 |
| H2a strategies, WebGL drawer (SwiftShader)                                     | Mutable: 121.9 / 157.1 ms; 8.4 slices/s; static redraw 93.5 ms; +204 MB. Opacity: 52.6 s setup, +828 MB. Negative control without texture invalidation: pixel verify 0/15.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | mixed                   | R1, GPU emulated on the CPU, pessimistic                                                                                                                                                                                                                                                                                |
| H2c vanilla annotation layers, canvas                                          | 10 / 50 / 200 per slice, slices/s (fps), memory. cache-nocache: 47.4 (61.0) / 35.1 (51.4) / 15.8 (25.4); +134 / +222 / +402 MB. rebuild-sync-nocache: 48.0 / 35.2 / 15.3; +134 / +145 / +232 MB. rebuild-async-nocache: 44.9 / 34.6 / 12.8; +134 / +146 / +233 MB. Caching on: cache 35.2 / 13.6 / 1.2; rebuild-async 29.6 / 12.6 / 3.9; visibility 29.0 / 11.3 / 1.6 (+717 MB at 200). Fabric render p50, caching off: 0.42-0.46 / 1.05-1.11 / 3.7-9.6 ms; caching on: 5.8-9.3 / 26-44 / 167-299 ms. Decorations p50 1.0 / 2.6-3.2 / 8.4-9.6 ms. 0 incoherent.                                                                                                                               | slices/s / MB / ms      | R1, vanilla harness (main.ts), mutable tile, measurement + label providers, one 3 s pass per config                                                                                                                                                                                                                     |
| H3 cine, canvas drawer, rAF-timestamp stepping                                 | Dropped %, per run. 30 fps: RGBA 0.3 / 0.3 / 0.3; ImageBitmap 0.3 / 0.7 / 0.3; WebCodecs 0 / 0 / 0; video with calibrated times 1.4 (1 run). 60 fps: RGBA 2.7 / 2.0 / 3.3; ImageBitmap 4.3 / 1.3 / 0.7; WebCodecs 5.7 / 6.0 / 11.0; video calibrated 45.4 (element dropped 69, 146 incoherent). Incoherent paints 0 on every non-video path.                                                                                                                                                                                                                                                                                                                                                  | % dropped of 300 frames | R1, vanilla harness (src/cine.ts), 100-frame 800x600 RGB loop x 3 loops, 3 annotations per frame + live decorations. Measured vsync 16.665 ms. Content frame g = floor((ts - ts0 + vsync/2) / period), from the rAF timestamp. The binding has no play API.                                                             |
| H3 cine, nominal video time and WebGL                                          | Video with nominal floor(t\*fps): 30 fps 0% dropped but 470 incoherent paints and 231 time/pixel mismatches; 60 fps 43.3%. WebGL RGBA (SwiftShader): 70.3% (30 fps), 83.3% (60 fps).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | %                       | R1, 1 run each                                                                                                                                                                                                                                                                                                          |
| architecture stress (git diff origin/claude/segmentation-brush-tool...d7363fe) | 82 files, +12,717 / -71 in total. Pre-existing files: 21 changed, +795 / -71. Model side 13 files +241 / -12; Solid 8 files +554 / -59, of which ViewerCell +453 / -55. New files excluding representative.json (4,947) and pnpm-lock (+108): 6,867 lines. @osdlabel/frame 518; @osdlabel/frame-osd 560; poc app src 3,396 + scripts 1,416 + tests 122; new files in existing packages 223 src + 389 test.                                                                                                                                                                                                                                                                                    | files / lines           | This session: ab4b2a6..d7363fe, 26 files, +5,108 / -1,835 (mostly representative.json)                                                                                                                                                                                                                                  |
| E2E and unit tests at HEAD                                                     | Solid E2E 172 passed, 1 skipped (5.5 min); React E2E 172 passed, 1 skipped (6.0 min). turbo typecheck + test over packages/\* and the PoC app, uncached: 46/46. osdlabel 329 tests, Solid 157. osdlabel#test failed once under parallel turbo load and passed on two reruns.                                                                                                                                                                                                                                                                                                                                                                                                                  | tests                   | Temporary local Playwright configs with executablePath /opt/pw-browsers/chromium (not committed); packages built at 3e6ded1+                                                                                                                                                                                            |
| edit-cost attribution (profile)                                                | Frame-axis, 60,000 annotations, before the plain-object index: about 400 ms per edit in the bucket memo (store-proxy reads) and about 330 ms in the default 'global' constraint recount. After the fix the memo is about 70 ms per edit, and the edit totals 390 ms vs 207 ms for slice-ids.                                                                                                                                                                                                                                                                                                                                                                                                  | ms                      | CDP sampling profile of 3 add + 3 delete edits, scratch diagnostic script (removed)                                                                                                                                                                                                                                     |

## Recommendation

Split the stack feature into two concerns. Treat the PoC's annotation keying as a maintainer decision, because the corrected evidence reverses it.

(1) Pixels and navigation: one image source with a frame axis, as prototyped and confirmed.

- FramedImageSource { frameAxis, frameSource } is presented by FramePresenter: one TiledImage, one tile repainted in place. The viewport, the overlay transform and the user's rotated or zoomed view never change, and the grid holds one assignment.
- Per-cell frame state in UIState.cellFrames, now optional, with SET_CELL_FRAME / STEP_CELL_FRAME.
- Wheel steps frames on a stack; Ctrl/Cmd+wheel zooms; optional ArrowUp/Down shortcuts.
- Two-phase presentation: pixels now, objects and decorations inside OSD's update-viewport of that draw.
- A display-rate frame throttle.

(2) Annotations: key them per slice with ImageIds through a series grouping (FramedImageSource.sliceImageIds, registered in CellFrame), not with a `frame` field.

- The slice id is the SOPInstanceUID, or '<SOPInstanceUID>/frames/<n>' for a frame of a multi-frame instance.
- Measured in the binding on equal footing, slice ids tie on scroll throughput at 10 and 50 per slice and win at 200. They make edits 1.1-2x cheaper and per-slice limits usable (30-32 vs 0.3 slices/s). JSON is 5% smaller, keys need no reconciliation, and old readers keep the data intact.
- No annotation schema, validation or serialization change is needed.
- Still to build for this model: series-level annotations keyed by the series id (the cell shows byImage[seriesId] together with byImage[sliceId], and tools update by each annotation's own imageId), and a 'per-series' count scope resolved through sliceImageIds.
- Keep FrameRef only if `time`-on-annotation or native series-level semantics are judged essential. Cine/video times stay in FrameAxis.times either way.

Rendering: stack cells default to the canvas drawer and Fabric objectCaching off, through the public `frameCellOptions` provider prop. Rebuild each frame's objects and render them synchronously once the revive settles. Drop VectorObjectCache and the look-ahead: they lost in every pass and use more memory.

Production work beyond the PoC:

- Port FramePresenter to OSD 6's public requestInvalidate / 'tile-invalidated' (the OSD 5 hooks are deprecated there) and re-measure same-paint coherence.
- Count constraints from plain data or incrementally. Today a 'global' recount through Solid store proxies costs about 200-400 ms per edit at 60,000 annotations, in both models.
- If FrameRef is kept, count 'per-frame' from the bucket index.
- React parity with an imperative per-frame path.
- Make the slice id visible to the brush and the DICOM adapter.

DICOM stays an edge adapter: it builds FrameAxis / FrameSource and maps slice ImageIds to ReferencedSOPInstanceUID / ReferencedFrameNumber on export.

### New packages

- @osdlabel/frame: zero-dependency frame-axis model (FrameAxis, clamp/step, frameIndexAtTime). FrameRef, bucketByFrame and reconcileFrameRefs are only needed if the FrameRef annotation key is kept. Depends on @osdlabel/annotation only.
- @osdlabel/frame-osd: the FrameSource pixel-provider contract, FramedImageSource (with the optional sliceImageIds grouping), createCanvasTileSource and FramePresenter. Depends on @osdlabel/frame and @osdlabel/viewer-api, with openseadragon as a peer. Needs an OSD 6 port.
- (later, separate PoC) DICOM adapter: builds FrameAxis / FrameSource / sliceImageIds from a DICOMweb series or a multi-frame instance.

### Changes to existing packages

- @osdlabel/viewer-api: optional UIState.cellFrames: Record<number, CellFrame {index, count, sliceImageIds?}>; optional KeyboardShortcutMap.nextFrame / previousFrame (+29 lines in the PoC). Non-breaking now.
- osdlabel: SET_CELL_FRAME (with sliceImageIds) / STEP_CELL_FRAME, guarded against a missing cellFrames; cellAnnotationImageId; usesImageScope; FrameCellOptions + DEFAULT_FRAME_CELL_OPTIONS; createFrameThrottle; keyboard frame shortcuts gated on the active cell having a frame axis. Only with FrameRef: OsdFields &= Partial<FrameFields>, a 'per-frame' scope, frame-aware brush stamping, frame-wire-format. Production: constraint counting off store proxies. Delete VectorObjectCache.
- @osdlabel/annotation-context: a 'per-series' count scope (slice ids), or 'per-frame' if FrameRef is kept (+10/-5 in the PoC).
- @osdlabel/validation: no change for slice ids; FrameRefSchema only if FrameRef is kept (+20).
- @osdlabel/solid: AnnotatorProviderProps.frameCellOptions. ViewerCell opens FramedImageSource through FramePresenter, picks the drawer at creation and switches it with requestDrawer when the source kind changes, sets objectCaching per object in stack cells, looks up byImage[sliceImageIds[frame]], uses two-phase presentation, renders a rebuild synchronously once its revive settles, and blocks wheel frame steps during a Fabric transform. activeImageId is a memo of cellAnnotationImageId. The constraint memo is keyed on the grid assignment unless the context is image-scoped. 8 files +554/-59 in the PoC, ViewerCell +453/-55; the reuse path should be deleted.
- @osdlabel/react: the same as Solid, not implemented. Needs an imperative per-frame path (refs plus a direct Fabric swap in the OSD handler) and store selectors.
- apps/dev and apps/dev-react: a stack sample page plus E2E specs on both bindings (frame scroll, keyboard, per-slice limits, stamping, coherence, view kept).

### API sketch

```ts
// @osdlabel/frame-osd
export interface FrameSource { readonly width: number; readonly height: number; readonly count: number; paint(index: number, ctx: CanvasRenderingContext2D): boolean; prefetch?(indices: readonly number[]): Promise<void> }
export interface FramedImageSource extends ImageSource {
  readonly frameAxis: FrameAxis;            // kind, count, keys?, times?, positions?
  readonly frameSource: FrameSource;
  readonly sliceImageIds?: readonly ImageId[] | undefined; // series grouping: annotations keyed per slice
}
export class FramePresenter { constructor(viewer: OpenSeadragon.Viewer, source: FrameSource, options?: { initialFrame?: number; cacheKey?: string }); open(): void; show(index: number): boolean; invalidate(): void; readonly frame: number; readonly count: number }

// @osdlabel/viewer-api
interface UIState { cellFrames?: Record<number, CellFrame> }
interface CellFrame { readonly index: number; readonly count: number; readonly sliceImageIds?: readonly ImageId[] | undefined }
interface KeyboardShortcutMap { readonly nextFrame?: string | undefined; readonly previousFrame?: string | undefined }

// osdlabel
type UIAction = /* ... */
  | { type: 'SET_CELL_FRAME'; payload: { cellIndex: number; frame: number; frameCount: number; sliceImageIds?: readonly ImageId[] } }
  | { type: 'STEP_CELL_FRAME'; payload: { cellIndex: number; delta: number; wrap?: boolean } };
function cellAnnotationImageId(ui: UIState, cellIndex: number): ImageId | undefined; // slice id under a series grouping
function usesImageScope(ctx: ContextState): boolean;
interface FrameCellOptions { readonly drawer?: 'canvas' | 'webgl'; readonly objectCaching?: boolean; readonly reuseObjects?: boolean /* PoC only; delete */ }
const DEFAULT_FRAME_CELL_OPTIONS = { drawer: 'canvas', objectCaching: false, reuseObjects: false } as const;
function createFrameThrottle<T>(apply: (v: T) => void, schedule?: (release: () => void) => unknown): { request(v: T): void; cancel(): void };

// bindings
<AnnotatorProvider frameCellOptions={{ drawer: 'canvas', objectCaching: false }}>
  <ViewerCell imageSource={{ id: seriesId, tileSource: '', frameAxis, frameSource, sliceImageIds }} cellIndex={0} isActive />
</AnnotatorProvider>
actions.setCellFrame(cellIndex, frame, frameCount, sliceImageIds?); actions.stepCellFrame(cellIndex, delta, wrap?);
// new annotations on a stack: { ...annotation, imageId: sliceImageIds[frame] }  (no `frame` field)
// alternative kept for comparison: annotations carry frame?: { index, key?, time? } on one series ImageId
```

### Effort

About 7 (range 5.5-9):

- @osdlabel/frame slimming and docs: 0.25.
- @osdlabel/frame-osd hardening plus an OSD 6 port and same-paint re-validation: 1.5.
- osdlabel cellFrames, slice-id grouping, a per-series scope, series-level display, and constraint counting off proxies: 1.25.
- Solid production and unit tests (removing the reuse path): 1.0.
- React parity with an imperative per-frame path, plus tests: 1.5.
- Dev-app stack pages and E2E on both bindings: 1.0.
- Guide and API docs: 0.5.
  Keeping FrameRef instead adds about 0.5 for reconcile, the per-frame index count and schema/versioning work.

### Risks

- OSD 6 (6.0.0, 2026-02; 6.1.1 current) deprecates TileSource.createTileCache, destroyTileCache, getTileCacheDataAsContext2D and Tile.getCanvasContext, which createCanvasTileSource and the harness use, and offers a promise-based requestInvalidate / 'tile-invalidated' path. Whether a frame's pixels and its annotations still land in the same paint there is unmeasured.
- WebGL is unmeasured on a real GPU. With SwiftShader the binding reaches 7.6-7.8 slices/s at 10 per slice, so the canvas drawer is the stack default by evidence from emulation only.
- At 200 annotations per slice the binding scrolls at 11-16 slices/s (12-14 fps) on this loaded 4-core CPU. Decorations (about 9 ms p50) plus swap plus render exceed a frame.
- Constraint counting through Solid store proxies costs about 200-400 ms per edit at 60,000 annotations under the default 'global' scope, in both models. This is a pre-existing scaling issue that stacks expose.
- The slice-id model's series-level annotations and per-series scope are not built. Their cost and the tool-routing change (updates by each annotation's own imageId) are estimates.
- The coherence counter compares JS tags, not pixels. Its paint-landing rule for microtasks follows the HTML event-loop spec and is not pixel-verified.
- Drawer switching through requestDrawer re-orders the drawer canvas under the Fabric canvas. It is covered by typecheck and mocked unit tests only; no E2E spec switches a cell between a stack and a plain image.
- Frame steps are blocked during a Fabric transform for the wheel only, not for the keyboard frame shortcuts.
- React parity is unmeasured. A per-notch store write at 60 Hz, and state updates committing after OSD's draw, could reintroduce incoherence.
- Cine at 60 fps through decoders drops 5.7-11% (WebCodecs) and 45% (<video>) on this CPU. Target hardware must be validated, and cine was measured in the vanilla harness, not the binding.

## Rejected alternatives

- **Reusing revived vector objects across frames (VectorObjectCache, 5,000-object LRU, 4-frame look-ahead)**: Measured against rebuild with objectCaching off in the Solid binding (5 reps, 3 passes), reuse was slower or tied in every pass: cold 47.6 vs 52.8 slices/s at 10 per slice, 20.2 vs 29.2 at 50, 6.8 vs 12.3 at 200. It also used more memory at 10 and 50 per slice (PSS 304 vs 212, 442 vs 376 MB). It risks showing an object Fabric mutated during a drag when a scroll returns to its frame or a host undo restores its payload. The vanilla harness agrees: equal throughput, 402 vs 232 MB at 200 per slice. It is kept opt-in in the PoC only so the comparison can be re-run.
- **`frame: FrameRef` on annotations (one ImageId per series) as the annotation key**: This is the PoC's original choice. On equal footing with slice ids it costs more:
- edits 82.7 vs 68.5 ms at 50 per slice, 407 vs 207 ms at 200;
- with a per-frame limit as built, 0.3 vs 30-32 slices/s;
- JSON +5%, deserialize +10-23%;
- reconciliation when the axis is reordered;
- a silent misplacement hazard in pre-frame readers.
  Scroll throughput only ties. It remains the fallback if series-level annotations or `time` on annotations prove essential.
- **Today's per-assignment path: one ImageSource per slice, the host re-assigning the cell per wheel notch (ViewerCell re-opens the viewer)**: Reference only, not a model: 0 slices/s under a 60 Hz scroll, synchronous p95 13 ms, view reset (rotation 90 -> 0, zoom 2x -> 1x), 46 incoherent paints with real wheel input. This is what the earlier 'H1-alt refuted' measured.
- **WebGL drawer for stack cells (OSD 5's default)**: With SwiftShader: 7.6-7.8 slices/s in the binding at 10 per slice, mutable-tile latency 122 ms p50, 70-83% cine drops. Hosts can opt in with frameCellOptions.drawer = 'webgl' for real-GPU testing.
- **Fabric per-object caching on for annotation objects in stack cells (Fabric's default)**: 10.7-11.3 vs 29.2-32.6 slices/s in the binding at 50 per slice. Vanilla render p50 31.8 vs 1.1 ms at 50 per slice and 299 vs 9.6 ms at 200.
- **(a) viewer.open() per slice and (a') a PNG per slice through openImage**: Latency 33.6 / 43.5 ms p50 with a blank paint per step. 0.3 / 0.7 slices/s under the 'latest' policy, 29.6 / 19.9 await-drawn with 90 / 58 blank paints in 3 s. (a') also costs 5.7 s of PNG encoding.
- **(b) one TiledImage with reset() and a re-fetched tile**: 33.5 ms p50; 0.3 slices/s under 'latest'; 29.9 await-drawn with 91 blank paints.
- **(c) 300 preloaded TiledImages toggled by opacity**: Same latency as (d) on canvas (17.0 ms) but +429 MB and 4.3 s setup; on WebGL +828 MB and 52.6 s setup. A bounded sliding window of 2-3 TiledImages (the review's suggestion) was not built.
- **Every frame's objects kept on the canvas, toggled by `visible`**: +717 MB and 5.1 s init at 200 per slice. Render cost grows with the total object count: 1.6 slices/s at 200 per slice.
- **Mapping video time to frames by nominal rate, floor(t \* fps)**: 231 time/pixel mismatches and 470 incoherent paints out of 300 frames at 30 fps. Calibrated per-frame times gave 0 mismatches.
- **Cine stepping from performance.now() inside rAF**: Prone to repeat-then-skip aliasing at slot boundaries. Replaced by the vsync-aligned rAF timestamp with a half-vsync phase: 60 fps RGBA 2.0-3.3% and ImageBitmap 0.7-4.3% dropped across 3 runs.

## Architectural stress

Existing files changed: 21; existing lines changed: 866; new lines: 6867.

Measured with git diff --numstat origin/claude/segmentation-brush-tool...d7363fe: 82 files, +12,717 / -71.

Pre-existing files: 21 changed, +795 / -71 (866 lines touched), excluding pnpm-lock (+108).

- Model side, 13 files, +241 / -12: viewer-api types.ts +29; annotation-context +10 / -5; validation +5; osdlabel package.json, actions (+71), brush-config (+18 / -3), constraints (+50 / -2), index (+34), initial-state, keyboard (+16), types (+6 / -2).
- Solid, 8 files, +554 / -59, of which ViewerCell +453 / -55.
- React: unchanged. Its E2E passes against the changed osdlabel.
- This session reverted the fabric-annotations test helper change: the frame shortcuts are optional now.

New lines (6,867), excluding results/representative.json (4,947 lines) and the lock file:

- New files inside existing packages: osdlabel cell-annotation-image-id 12, frame-cell-options 40, frame-throttle 52, frame-wire-format 23, vector-object-cache 69; validation frame.ts 15; osdlabel test frame-axis.test.ts 389.
- @osdlabel/frame: 518 lines (src 291).
- @osdlabel/frame-osd: 560 lines (src 301).
- apps/poc-frame-axis: src 3,396, scripts 1,416, tests 122, config.

Dependency graph: no edge between existing packages changed. The new edges point only into the new leaves: osdlabel -> @osdlabel/frame, and @osdlabel/solid -> @osdlabel/frame-osd.

Under the recommended slice-id keying, these frame-specific annotation changes would not be needed: annotation-context per-frame scope (+10/-5), validation (+20), OsdFields Partial<FrameFields> (+6/-2), brush frame stamping (+18/-3), frame-wire-format (23), the per-frame constraint parts, useAnnotationTool stamping (+6/-1), and ViewerCell's bucket index. VectorObjectCache (69) and the reuse path in ViewerCell would be deleted as well.

The review's point that the feature is cross-cutting stands: 13 model-side files. The changed core types are additive and optional now: cellFrames?, nextFrame?, previousFrame?, sliceImageIds?.

## Reproduce

```sh
pnpm install && pnpm exec turbo run build --filter='./packages/*' && pnpm --filter @osdlabel/poc-frame-axis bench    # about 40 min at HEAD (non-Solid groups about 15 min, Solid group about 25 min). Writes apps/poc-frame-axis/results/<ISO-timestamp>/results.json and results/latest.json, and prints summary tables (Solid rows as median (min-max) over repetitions per pass). Options: --groups env,model,strategies,layers,cine,solid; --reps <n> (Solid repetitions, default 5); --cine-reps <n> (canvas cine paths, default 3); --only <regex>; --quick; --chromium <path> (default $BENCH_CHROMIUM, else /opt/pw-browsers/chromium); --channel chrome; --headed; --port 5531; --out <dir>. Real GPU: pnpm --filter @osdlabel/poc-frame-axis bench --headed --channel chrome. Compact form: node apps/poc-frame-axis/scripts/summarize.mjs <results.json> --out results/representative.json
```

## Caveats

- Noisy machine: other agents ran at the same time. R1 (full bench) had a 1-minute load average of 4.1-5.7 and R2 (Solid group) 3.7-7.2 on 4 cores. Absolute vanilla numbers are 2-4x slower than the earlier run C on unchanged code paths, for example cache-nocache at 200 per slice: 15.8 vs 39.4 slices/s. Compare configurations within a run; a quiet-machine rerun is still needed.
- The Solid rows in representative.json come from R2 (3e6ded1). R1's own Solid rows (7383321) predate the fix to the mount-time series revive, are superseded, and are not in representative.json. The raw files are in the scratchpad (full1/results.json, solid2/results.json).
- The paint-landing rule of the coherence analysis changed in this session. A microtask that runs after a display frame's last rAF callback now counts in that frame's paint, following the HTML event-loop spec, instead of the next paint. It is detected with a MessageChannel message posted at frame start. The 0 incoherent paints in rebuild mode depend on this rule. The counter compares JS-side tags, not pixels.
- All WebGL numbers are SwiftShader (CPU-emulated, pessimistic). Real-GPU WebGL is untested.
- Edit costs include the default 'global'-scope constraint recount through Solid store proxies, which is pre-existing osdlabel behaviour shared by both models. The frame-axis per-frame limit result (0.3 slices/s) reflects the PoC's O(series) count. The index-based count (0.005 ms in the model bench) is not built.
- The slice-id model as built does not show series-level annotations (byImage[seriesId]) on its slices, and it has no per-series count scope. The comparison covers per-slice annotations only.
- Cine (H3) was measured in the vanilla harness with all frames resident (or decoded on the fly), not through the binding, which has no play/time API.
- The model-fairness gate (usesImageScope) was added in this session. Without it the slice-id model recounted every annotation on every step under the default 'global' scope (12-25 vs about 50 slices/s in a quick run).
- The 60 Hz scroll uses synthetic WheelEvents from timers. Real input through Playwright is CDP-bound to 15-46 events in 2 s and checks correctness only.
- Data is synthetic: a procedural 300x512^2 CT phantom and an 800x600 speckle loop. There is no DICOM decode, windowing, network or streaming.
- The React binding is unchanged. Its E2E suite passes against the changed osdlabel, but React stack support is an estimate.
- Memory is the PSS delta of the whole browser process tree (Linux /proc), including the GPU process, and is noisy at about +-30 MB.
- The OSD 6 facts come from the openseadragon@6.1.1 npm tarball: Viewer.requestInvalidate (line ~9287), TiledImage.requestInvalidate (~29210), the 'tile-invalidated' event, and deprecation errors for TileSource.createTileCache / destroyTileCache / getTileCacheDataAsContext2D and Tile.getCanvasContext. FramePresenter was not run on OSD 6.

## Open questions

- Annotation keying for stacks, a maintainer decision: per-slice ImageIds through a series grouping (measured cheaper, no schema change, safe for old readers), or `frame: FrameRef` on a series ImageId (native series-level annotations and annotation times)? Both share the same pixel and navigation stack.
- For the slice-id model: show series-level annotations from byImage[seriesId] on every slice (tool updates then route by each annotation's own imageId), and add a 'per-series' count scope resolved through sliceImageIds?
- Is OSD 6's promise-based requestInvalidate / 'tile-invalidated' fast enough to keep a frame's pixels and annotations in the same paint? FramePresenter must be ported, since its OSD 5 hooks are deprecated there.
- Should the canvas drawer and objectCaching off stay stack-only defaults, or should objectCaching off become the default for all annotation objects? It was only measured for stack cells.
- Does WebGL on a real GPU change the drawer default? Run: bench --headed --channel chrome.
- Is 200 annotations per slice a realistic clinical upper bound? At 200 the binding reaches 11-16 slices/s on this CPU, limited by decorations plus render.
- Constraint counting at scale: count from plain data or keep incremental counts instead of recounting through store proxies (200-400 ms per edit at 60,000 annotations in both models)?
- Per-cell frame in the shared UIState store (one write per wheel notch), or cell-local with an onFrameChange callback? This matters most for React's re-render cost.
- Should keyboard frame steps also be blocked during an active Fabric transform, as wheel steps now are?
- For multi-frame instances (cine, enhanced CT), are synthetic slice ids '<SOPInstanceUID>/frames/<n>' acceptable to the DICOM adapter, or does it need structured (instance, frame) references?
- MPR and 3D planes remain out of scope for both keyings and need their own extension.

## How the review was addressed

- BLOCKING 1 (H1-alt was a strawman). Fixed by building the alternative on equal footing.

What changed:

- FramedImageSource.sliceImageIds plus CellFrame.sliceImageIds, registered by SET_CELL_FRAME, plus osdlabel cellAnnotationImageId.
- ViewerCell presents pixels through the same FramePresenter, looks up byImage[sliceImageIds[shownFrame]], keeps one grid assignment (the series id) and never resets the transform.
- Tools stamp the slice id; the provider's activeImageId is the slice id.
- usesImageScope keys the constraint memo on the grid assignment for contexts that are not image-scoped. This mirrors the existing usesPerFrameScope gate for frame-axis, so neither model recounts on every step.
- Commit 5a1d570, with the harness model 'slice-ids' in apps/poc-frame-axis/src/solid/main.tsx.

Evidence (R2, Solid, 5 reps, median (min-max)):

- Throughput: 10 per slice 52.8 vs 50.5 cold; 50 per slice 29.2 vs 31.2; 200 per slice 12.3 vs 13.8, window 12.2 vs 16.2 slices/s.
- 0 incoherent and 0 blank paints; view kept in both.
- Edit: 14.7 vs 13.6, 82.7 vs 68.5 and 407 vs 207 ms.
- Per-slice limit: 0.3 vs 30.2-32.3 slices/s, edit 76.6 vs 3.0 ms.
- Model bench: JSON +5.0%; reconcile 0.45/3.77 ms not needed with slice ids.

Outcome: H1-alt is changed to 'confirmed' and H1 to 'partial'. The recommendation now keys annotations by slice ImageId and keeps the frame axis for pixels and navigation, flagged as a maintainer decision. Where frame-axis still wins is stated: native series-level annotations, per-series limits without id lists, and `time` on annotations. The old per-assignment path is kept only as a labelled reference (0 slices/s, view reset).

- BLOCKING 2 (the binding relied on harness globals). Fixed.

What changed:

- New public provider prop frameCellOptions (FrameCellOptions / DEFAULT_FRAME_CELL_OPTIONS in osdlabel, getter-based like brushOptions).
- drawer: default 'canvas' for stack cells. ViewerCell passes it to OpenSeadragon() when the first source is a stack, and switches with the public viewer.requestDrawer when the source kind changes, moving the new drawer canvas under the Fabric canvas.
- objectCaching: default false, set per annotation object in stack cells.
- The harness sets no OSD or Fabric globals for the stack models; only the labelled reference path keeps them. setup() reports drawer 'canvas' and objectCaching false as observed on the objects.
- Commit 5a1d570.

Re-measured with these defaults (R2): 58.0 / 53.1 / 32.6 / 11.2 slices/s revisit at 0 / 10 / 50 / 200 per slice. For contrast: objectCaching on at 50 per slice 10.7-11.3; WebGL opted in at 10 per slice 7.6-7.8 (SwiftShader).

Real-GPU WebGL remains untested and is listed as a risk, with the --headed --channel chrome command.

- BLOCKING 3 (single sample; 'warm' was an LRU thrash; cold incoherence not reported). Fixed.

What changed:

- Every Solid configuration now runs 5 fresh-page repetitions (3 for the reference rows) with three recorded passes.
- cold: first visits.
- revisit: replaces 'warm'. It is documented as overrunning the 5,000-object reuse bound at 50+ per slice.
- window: bounces within W = min(180, floor(5000 / perSlice)) frames after an unrecorded priming pass, so it fits the LRU.
- Median and range are reported for slices/s, fps, incoherent and blank paints, sync p95 and heap in every pass, including cold-pass incoherence (scripts/solid-aggregate.mjs, bench.mjs, summarize.mjs).

Results: cold incoherence is 0 in every configuration.

Trade-off introduced by the look-ahead: with it, cold throughput drops below the rebuild path: 20.2 vs 29.2 slices/s at 50 per slice and 6.8 vs 12.3 at 200. The earlier headline of 59.7 fps / 58.0 slices/s at 50 per slice does not reproduce: 29-33 slices/s at 33.7 fps (load 4-5).

- BLOCKING 4 (cache vs plain rebuild). Compared as asked, and the cache loses.

Rebuild mode in the binding revives each step's objects, sets revivePending so the step's synchronous render is skipped, and renders synchronously in the microtask where the revive settles, before the paint.

Results (Solid, 5 reps), cold / revisit / window slices/s, rebuild vs reuse:

- 10 per slice: 52.8 / 53.1 / 52.8 vs 47.6 / 51.5 / 49.6.
- 50 per slice: 29.2 / 32.6 / 30.5 vs 20.2 / 22.8 / 29.0.
- 200 per slice: 12.3 / 11.2 / 12.2 vs 6.8 / 6.0 / 9.9.
- Both 0 incoherent.
- PSS 212 vs 304, 376 vs 442 and 681 vs 622 MB.
- The vanilla rebuild-\*-nocache layers agree: 48.0 vs 47.4 / 35.2 vs 35.1 / 15.3 vs 15.8 slices/s and 232 vs 402 MB at 200 per slice.

Outcome: reuseObjects defaults to false. The cache and look-ahead now apply only to stack cells that opt in, and are recommended for deletion. The hazard is also fixed for the opt-in path: entries are evicted on Fabric 'before:transform' and 'object:modified' (VectorObjectCache.deleteObject), and wheel frame steps are ignored while a transform is active.

The new runs also exposed a mount-time revive of every frame's objects: 60,000 at 200 per slice, overflowing the stack in canvas.add(...). It was fixed in 3e6ded1 (mount 9.3 s -> 3.3 s), and the Solid group was re-run after that fix.

Cine stepping (priority 4) is locked to the vsync-aligned rAF timestamp in 7383321. 60 fps RGBA drops 2.0-3.3% and ImageBitmap 0.7-4.3% across 3 runs. The resident paths pass at 60 fps and the decode paths fail (WebCodecs 5.7-11%, video 45%).

## Independent review

A second agent re-ran the benchmark and tried to break the conclusions.

### Blocking findings

- **H1-alt ('one ImageId per slice plus a series grouping') is marked refuted, but what was measured is a strawman. It is today's ViewerCell re-opening a viewer per slice, with no series grouping at all. The pixel path and the annotation model are separable, as the PoC's own H2a shows, so the 0 slices/s and the lost view are artefacts of the binding, not of the model.**
  - Evidence: apps/poc-frame-axis/src/solid/main.tsx gives the per-slice model 300 independent ImageSources and a host wheel handler that calls actions.assignImageToCell per notch. That path is ViewerCell's tileSource effect -> viewer.close() -> openImage(), which is strategy (a) and starves under a 60 Hz 'latest' policy (H2a: 0.0-0.3 slices/s). The view loss comes from the ASSIGN_IMAGE_TO_CELL reducer resetting cellTransforms[cellIndex], a one-line choice in packages/osdlabel/src/actions.ts. Nothing here is a series grouping. The vanilla harness opens per slice with preserveViewport: true and keeps the view. The PoC's own model bench favours the alternative on several points: per-slice limit 0.005 vs 0.70/3.45 ms, JSON -5%, and a per-slice lookup of 0.27/5.7 us, which is as cheap as the frame index. A slice ImageId can also be the SOPInstanceUID, so the alternative needs no reconcileFrameRefs step. My rerun reproduces the strawman result: per-slice 0.0-0.3 slices/s, 144-146 blank paints, rotation 90->0, zoom 2x->1x.
  - Required fix: Build the alternative on equal footing: a series-aware cell (a SeriesSource with sliceIds) that presents pixels through the same FramePresenter, looks up byImage[sliceIds[i]] for annotations and does not reset the transform. Then compare model-level costs only. Otherwise change H1-alt to 'not refuted'. Frame-axis is still preferred on qualitative grounds: series-level annotations, temporal axes/times, one grid assignment, per-series limits without imageIds lists. State where the alternative wins: per-slice limits, JSON size, key stability.
- **The recommended production path relies on two settings that the prototype binding does not implement. The binding's actual defaults were measured and fail. The canvas drawer is not OSD 5's default, ViewerCell has no way to select it, and Fabric objectCaching off is set by mutating global class defaults in the harness.**
  - Evidence: OSD 5.0.1 DEFAULT_SETTINGS has drawer: ['webgl','canvas','html'] (node_modules/.pnpm/openseadragon@5.0.1/.../openseadragon.js:1381). The Solid harness forces canvas with `OpenSeadragon.DEFAULT_SETTINGS.drawer = opts.drawer` ('ViewerCell exposes no viewer options'), and forces objectCaching through `ownDefaults['objectCaching']` on Rect/Circle/Line/Polyline/Polygon (src/solid/main.tsx setup()). The binding's real defaults are WebGL with caching on. In the Solid group they measure 12.4 slices/s at 10 per slice in run C, and 4.9 in my rerun (SwiftShader). Canvas with caching on at 50 per slice gives 24.2 warm / 12.1 cold (run C), and 16.4 / 7.7 in my rerun. The recommendation lists 'objectCaching off' as a production change, but makes no drawer decision. Real-GPU WebGL is untested.
  - Required fix: Make both choices part of the recommendation and the binding: a drawer option or a canvas-drawer requirement for stack cells, and objectCaching off for annotation objects in stack cells. Then re-measure the binding with those defaults, not with harness globals. Alternatively, measure WebGL with a real GPU (the bench's --headed --channel chrome) before recommending the default drawer.
- **The 50-per-slice Solid headline (59.7 fps / 58.0 slices/s, 1 incoherent paint) is one 3 s sample per run and did not reproduce. The 'warm (objects reused)' label is also wrong at 50 per slice: the scroll overruns the 5,000-object LRU, so the second pass re-revives almost everything. Cold-pass incoherence is never reported.**
  - Evidence: My rerun at HEAD ab4b2a6 (load 9.4-10.5) gave solid/canvas/50/nocache warm 32.7 fps / 30.8 slices/s with 9 incoherent paints, and cold 41.7 slices/s with 2. solid/canvas/50 (caching on) gave warm 16.4 / cold 7.7 slices/s, with 9 / 8 incoherent. Each pass visits frames 0-180, so 181 x 50 = 9,050 objects against VectorObjectCache's 5,000 bound. A sequential rescan of an LRU smaller than the working set misses on nearly every frame. bench.mjs and summarize.mjs report only scriptedWarm.incoherentFrames. The look-ahead commit (a6c9a71) also cut cold-pass throughput according to representative.json: at 50 per slice with caching on, 49.1 slices/s at 9053a30 vs 12.1 at a6c9a71; with caching off, 56.1 vs 47.0. The report does not attribute this.
  - Required fix: Run at least 5 repetitions per Solid config and report median and range for both passes, including cold-pass incoherence. Rename 'warm' or size the scroll so it fits the LRU bound. Report the throughput/coherence trade-off that the look-ahead introduced.
- **Recommending the per-frame VectorObjectCache plus 4-frame look-ahead is not supported against the simpler alternative: today's rebuild path with Fabric objectCaching off. The measured gain mixes up object reuse with objectCaching off, and the cache adds memory, a cold-pass regression and a stale-object hazard for every cell.**
  - Evidence: The PoC never measures rebuild-sync or rebuild-async with objectCaching off. I ran them through the harness's own window.\_\_poc API (scratch script, canvas drawer, 2 reps, load 12-13). At 50 per slice: rebuild-sync 36.3/41.2, rebuild-async 47.9/38.3, cache 41.2/40.6 slices/s. Fabric render p50 was 0.5-0.65 ms for all three. JS heap was about 100-114 MB for rebuild vs 178-184 MB for cache. At 200 per slice: rebuild-sync 16.7/15.0, rebuild-async 19.2/10.5, cache 21.4/20.5 slices/s; heap 140-157 vs 400-406 MB. objectCaching off is the effect; reuse adds little at 50 per slice. Vanilla rebuild-async had 0 incoherent paints because the revive resolves in microtasks. Solid's late paints came from calling renderAll synchronously before the revive settled, which a render after the microtasks would also fix. The cache is keyed by payload, but Fabric mutates objects during a drag. A frame scroll in the middle of a drag (the capture wheel listener steps in every mode) or a host undo that restores the old payload reference would re-show the mutated object at a position the state does not hold. Before this change, the rebuild revived from JSON and showed the stored position.
  - Required fix: In the Solid binding, compare objectCaching off with no reuse (render after the revive settles, inside the update-viewport handler) against cache plus look-ahead: cold and warm, at 10/50/200 per slice, with repetitions. Keep the cache only if it wins. If it stays, invalidate or bypass entries for objects that were interacted with, and block frame steps during an active Fabric transform.

### Non-blocking findings

- OSD 6 premise: OSD 6.0.0 (2026-02-18; 6.1.1 is current) already has a public 'tile content changed' path, viewer.requestInvalidate() and the 'tile-invalidated' event. It also deprecates TileSource.createTileCache, destroyTileCache and getTileCacheDataAsContext2D, and Tile.getCanvasContext, all of which createCanvasTileSource and the harness's drawnFrame() use (OSD 6.1.1 build, lines ~15044-15100 and 22288). Open question 5 and risk 1 ('upstream a public API') rest on a false premise. FramePresenter also needs re-validating on OSD 6, whose invalidation is promise-based and may not land in the same paint.
- H3 was measured in the vanilla harness (src/cine.ts, with all frames' objects prebuilt and objectCaching on), not through the binding. The binding has no play/time-driven frame API, so 'through the winning path with annotations and live decorations' holds for FramePresenter, not for osdlabel's ViewerCell.
- The cine scheduler computes g = floor((performance.now() - start)/period) inside rAF instead of using the vsync-aligned rAF timestamp. At 60 fps content on a 60 Hz display, callback jitter near a slot boundary produces repeat-then-skip drops. That fits the run-to-run spread for resident paths: RGBA 60 fps 4.7/5.0/2.7% in runs A/B/C and 0.3% in mine; ImageBitmap 9.7/9.0/4.0% and 0.0%. The 60 fps 'borderline/refuted' verdict for resident paths may be a harness artefact. The 30 fps RGBA result is not robust either: 6.0% dropped in my run, above the 5% bar. ImageBitmap at 30 fps passed in all four runs.
- 'Calibrated' video times come from the barcode ground truth in a first pass, so 0-6 mismatches is an oracle best case, as the caveat says. The per-frame barcode readback in the video path also adds CPU work that production code would not have.
- The coherence counter compares JS-side canvas tags (tagCanvas) with Fabric object ids. It does not read pixels. The pixel verifier runs only at rest (8 idle frames per step), so stale WebGL textures during a scroll would not appear as incoherent paints.
- H2b ('overlay sync exact') holds by construction under (d): the viewport and world never change, so vpt minus computeViewportTransform(viewer) is necessarily 0. It is not evidence of anything beyond that.
- The vanilla 'cache' layer prebuilds every frame's objects without a bound (CacheLayer.init). The 200-per-slice figures (39.4 slices/s claimed; 31.7 in my rerun, +396 MB) therefore come from a path the binding does not use. The binding's 5,000-object LRU holds only 25 frames at 200 per slice, and 200 per slice was never run in Solid.
- The claim that changes are 'type-level only' is slightly overstated. applyUIAction is a public reducer, and its ASSIGN/UNASSIGN branches now `delete draft.cellFrames[cellIndex]`. That throws a TypeError at runtime for any host UIState without cellFrames, such as persisted state or JS hosts. Both bindings build state from createInitialUIState, so neither is affected.
- 'Existing packages change additively' is overstated for the Solid binding. The rebuild effect now tracks only rawAnnotationData and works on unwrap()ped objects. The decoration effect reads annotations untracked and relies on changeCounter. The VectorObjectCache applies to every cell, not only stack cells. Solid E2E still passes (172/1 skipped, reproduced), but no dev-app page or E2E spec exercises a stack, and the Solid frame logic has no unit tests.
- Architecture: it largely respects one concern per package. There are two new leaf packages, no edges between existing packages changed, and the duplicated Valibot schema with a compile-time agreement check (frame-wire-format.ts) follows the mask precedent. But the feature is cross-cutting, touching 14 model-side files across viewer-api, annotation-context, validation and osdlabel. Partial<FrameFields> is baked into the core OsdFields and OsdFieldsSchema rather than offered as an opt-in composed type. A Fabric render cache with stack-motivated behaviour (VectorObjectCache) lives in osdlabel and changes non-stack cells. 'Two new leaf packages carry the feature' undersells this.
- Memory: with caching on, the 5,000-object bound per cell measured 1.16-1.18 GB at 10 per slice (run C and my run). A grid of several stack cells would multiply that, so the bound should depend on the objectCaching mode.
- 'per-frame' constraint counting is O(series) per recompute (3.45 ms at 15,000 annotations in my run). This is correctly flagged as a production change.
- React parity (about 300 lines, 1.5 weeks) is an unmeasured estimate. The React provider re-renders through one useSyncExternalStore snapshot, so a per-notch cellFrames write at 60 Hz is a real concern, as the report says.

### Claims checked

| Claim                                                                                                                            | Verdict    | Note                                                                                                                                                                                                                                                                                                                   |
| -------------------------------------------------------------------------------------------------------------------------------- | ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 22 pre-existing files changed, +534/-61 (model side 14 files +196/-12; Solid 8 files +338/-49); new_lines 6,323                  | holds      | git diff --numstat origin/claude/segmentation-brush-tool...HEAD gives 23 modified files including pnpm-lock (+108), so 22 files +534/-61 without the lock file. Added files total +8,789; minus representative.json (2,466) that is 6,323. frame 11 files +518, frame-osd 12 files +544, PoC app src 3,238, all exact. |
| No edge between existing packages changed; new edges only osdlabel -> @osdlabel/frame and @osdlabel/solid -> @osdlabel/frame-osd | holds      | Only those two package.json dependency lines were added to existing packages.                                                                                                                                                                                                                                          |
| Existing packages change only additively, behind optional fields; breaking changes are type-level only                           | overstated | UIState.cellFrames and KeyboardShortcutMap.nextFrame/previousFrame are required, not optional. The public reducer throws at runtime on a UIState without cellFrames. The ViewerCell rebuild and decoration paths changed for all images.                                                                               |
| H1 confirmed: a stack as one ImageSource with a frame axis is an extension, not a rewrite                                        | holds      | It is an extension. The 'best model' half rests on the strawman alternative.                                                                                                                                                                                                                                           |
| H1-alt refuted: 0.0 slices/s, view lost on every slice                                                                           | wrong      | Reproduced (0.0-0.3 slices/s, 144-146 blank, 90->0 / 2x->1x), but it measures ViewerCell's per-assignment viewer.open() and the transform-resetting reducer, not the model. No series grouping was built.                                                                                                              |
| H2a: (d) mutable single tile is the strategy to build on (canvas p50 16.9 ms, 0 blank, 122 MB)                                   | holds      | Rerun on canvas: p50 16.9 / p95 19.3 ms; 49.2 slices/s 'latest', 59.6 await-drawn; +123 MB; 15/15 pixel verify; negative control 0/15. Opacity (c) matched on speed (59.6) at +428 MB.                                                                                                                                 |
| Solid binding 50 per slice, objectCaching off: 59.7 fps / 58.0 slices/s, 1 incoherent                                            | overstated | Rerun under heavier load gave 32.7 fps / 30.8 slices/s with 9 incoherent (warm) and 41.7 slices/s with 2 (cold). The figure is one sample per run, and at 50 per slice the 'warm' pass is an LRU thrash.                                                                                                               |
| Solid binding 10 per slice: 59.7 fps / 58.4 slices/s, 0 incoherent                                                               | holds      | Rerun: 54.5 fps / 52.6 slices/s, 0 incoherent (caching on); 52.2 slices/s with caching off.                                                                                                                                                                                                                            |
| H2b: FabricOverlay sync stays exact (vpt diff 0, zoom drift 0)                                                                   | holds      | Reproduced, but trivially: under (d) the viewport never changes.                                                                                                                                                                                                                                                       |
| H2c: objectCaching off plus per-frame object reuse fits in a frame at 10/50/200 (59/58.6/39.4 slices/s)                          | overstated | Rerun cache-nocache gave 59.7/56.9/31.7 slices/s. My added rebuild-sync and rebuild-async runs with objectCaching off are within noise of cache at 50 per slice with about half the heap, so the benefit of reuse is not shown.                                                                                        |
| H2d: after the fixes, 0/7/0/1 incoherent paints (10/50/10nc/50nc)                                                                | overstated | Rerun gave 0/9/0/9 (warm) and 0/8/0/2 (cold). It holds at 10 per slice and not at 50.                                                                                                                                                                                                                                  |
| OSD 5.0.1 clears forceRedraw after raising update-viewport                                                                       | holds      | openseadragon.js 11720-11727: drawWorld() raises 'update-viewport' at line 11779, then forceRedraw is set to false.                                                                                                                                                                                                    |
| H3: 30 fps confirmed for resident-pixel paths (<=5% dropped)                                                                     | overstated | Rerun: ImageBitmap 0.0% holds, but RGBA dropped 6.0% at 30 fps. WebCodecs 0.3%, video-calibrated 0.3%. Measured in the vanilla harness, not the binding.                                                                                                                                                               |
| H3: 60 fps borderline or refuted                                                                                                 | overstated | Rerun: RGBA 0.3% and ImageBitmap 0.0% at 60 fps (both pass); WebCodecs 7.0%, video 23-27% (fail). Resident-path numbers swing between runs, consistent with clock aliasing in the scheduler.                                                                                                                           |
| WebGL numbers are SwiftShader and labelled as such                                                                               | holds      | The env reports ANGLE Vulkan SwiftShader (Subzero). The report labels every WebGL figure as emulated and does not present them as GPU results. Rerun mutable/webgl: 55.1 ms p50, 19.6 slices/s.                                                                                                                        |
| H1 model costs: index 0.48/3.68 ms, per-frame constraint 0.53/3.29 ms, JSON +5.0%                                                | holds      | Rerun: index 0.54/3.95 ms; constraint 0.70/3.45 vs per-slice 0.005/0.01 ms; JSON 3,519.8 vs 3,351.0 KB and 17,843 vs 16,999 KB (+5.0%); reconcile reversed 0.17/1.18 ms.                                                                                                                                               |
| Solid E2E 172 passed / 1 skipped                                                                                                 | holds      | Reproduced: 172 passed, 1 skipped in 5.6 min, using a scratch Playwright config with executablePath /opt/pw-browsers/chromium. No spec covers a stack.                                                                                                                                                                 |
| React E2E 172 passed / 1 skipped                                                                                                 | unchecked  | Not rerun. The React binding is unchanged, but it consumes the changed osdlabel reducers and keyboard map.                                                                                                                                                                                                             |
| All typecheck and unit-test tasks green                                                                                          | holds      | turbo run typecheck test over packages/\* plus the PoC app: 46/46 successful (36 cached).                                                                                                                                                                                                                              |
| Relying on OSD 5.0.1 internals is the alternative to upstreaming a public 'tile content changed' API                             | wrong      | OSD 6.0.0 (Feb 2026) ships viewer.requestInvalidate() and 'tile-invalidated', and deprecates the TileSource cache hooks that createCanvasTileSource overrides.                                                                                                                                                         |
| 4-frame look-ahead revival fixed coherence (a6c9a71)                                                                             | overstated | Warm incoherence fell, but cold-pass throughput fell too according to representative.json: at 50 per slice, 49.1 -> 12.1 slices/s with caching on and 56.1 -> 47.0 with it off. The report does not attribute this to the look-ahead.                                                                                  |
| React parity about 300 source lines, 1.5 engineer-weeks; total effort 6.5 weeks                                                  | unchecked  | An estimate only; nothing was implemented or measured for React.                                                                                                                                                                                                                                                       |

### Reviewer's rerun

I installed with `pnpm install --frozen-lockfile`. The build was a turbo cache hit, 15/15 packages. Then I ran `pnpm --filter @osdlabel/poc-frame-axis bench --out <scratchpad>/bench/full --port 5547` at HEAD ab4b2a6. It took 11.9 min (06:02-06:13:58Z) and exited 0. The 1-min load average went from 2.4 to 14.5 because of other agents. Environment: HeadlessChrome/153, WebGL2 = ANGLE SwiftShader, 4 cores, idle rAF 60.0 fps.

Model:

- Index build: 0.54 / 3.95 ms.
- Per-step lookup: indexed 0.083 us, naive 370 / 3,243 us, per-slice bucket 0.27 / 5.7 us.
- Constraint with a per-slice limit: 'per-frame' 0.70 / 3.45 ms vs per-slice 0.005 / 0.01 ms.
- JSON: +5.0% in both sizes.

Strategies, canvas drawer:

- Mutable tile: latency p50 16.9 / p95 19.3 ms; 49.2 slices/s 'latest' at 61.2 fps, 59.6 await-drawn; +123 MB; pixel check 15/15.
- Reset: 0.0 slices/s 'latest'; 30.0 await-drawn with 91 blank paints.
- Open: 0.3 / 29.9 slices/s, 91 blank paints.
- Open PNG: 14.3 / 26.0 slices/s, 13.9 s setup.
- Opacity: 59.6 slices/s, +428 MB.
- ImageBitmap: 59.3 slices/s, +412 MB.

Strategies, WebGL drawer (SwiftShader):

- Mutable: 55.1 ms p50, 19.6 slices/s.
- Opacity: 28.4 s setup, +745 MB.
- Mutable without invalidation (negative control): 0/15 pixel check.

Layers, canvas drawer, 10 / 50 / 200 per slice:

- Cache, objectCaching off: 59.7 / 56.9 / 31.7 slices/s; render p50 0.3 / 0.7 / 1.8 ms.
- Cache, caching on: 52.6 / 20.4 / 6.2.
- Rebuild-async: 54.3 / 21.3 / 5.9.

Cine, canvas drawer, 30 / 60 fps:

- RGBA: 6.0% / 0.3% dropped.
- ImageBitmap: 0.0% / 0.0%.
- WebCodecs: 0.3% / 7.0%.
- Video, calibrated times: 0.3% / 23.3%.
- Video, nominal times: 1.4% at 30 fps with 172 incoherent paints and 77 time/pixel mismatches; 26.9% at 60 fps.
- WebGL RGBA: 46.7% / 77.7%.

Solid binding (load 6-14.5):

- 0 per slice: 57.7 slices/s.
- 10 per slice: 52.6 slices/s at 54.5 fps, 0 incoherent.
- 50 per slice, caching on: cold 7.7 / warm 16.4 slices/s, 8 / 9 incoherent.
- 10 per slice, caching off: 52.2 slices/s.
- 50 per slice, caching off: cold 41.7 / warm 30.8 slices/s at 32.7 fps, 2 / 9 incoherent.
- WebGL, 10 per slice: 4.9 slices/s.
- ImageId per slice: 0.0-0.3 slices/s, 144-146 blank paints, view reset (rotation 90 -> 0, zoom 2x -> 1x).

Extra runs I added through the harness API (canvas drawer, objectCaching off, 2 reps, load 12-13):

- 50 per slice: rebuild-sync 36.3 / 41.2, rebuild-async 47.9 / 38.3, cache 41.2 / 40.6 slices/s; render p50 about 0.5-0.65 ms for all; heap about 100-114 MB (rebuild) vs about 180 MB (cache).
- 200 per slice: rebuild-sync 16.7 / 15.0, rebuild-async 19.2 / 10.5, cache 21.4 / 20.5 slices/s; heap about 140-157 MB vs about 400 MB.

Also ran:

- turbo typecheck + test over packages/\* and the PoC app: 46/46 green.
- Solid E2E: 172 passed, 1 skipped (5.6 min).

The worktree is left clean. Results are in /tmp/claude-0/-home-user-osdlabel/d2340e79-db4e-595c-a199-55b42694fb93/scratchpad/bench/full/results.json.

### Alternatives the reviewer says were missed

- A fair version of H1-alt: ImageId per slice plus a SeriesSource grouping, shown by a series-aware cell that reuses FramePresenter for pixels, looks up byImage[sliceIds[i]] for annotations and keeps the cell transform. The pixel path is independent of the model, so this isolates the model question.
- Fabric objectCaching off with today's rebuild path and no VectorObjectCache, LRU or look-ahead, rendering once the microtask-only revive settles inside the update-viewport handler. My vanilla rerun puts it within noise of the cache at 50 per slice with about half the memory.
- OpenSeadragon 6.x (6.0.0, Feb 2026): its public viewer.requestInvalidate() / 'tile-invalidated' pipeline instead of the OSD 5.0.1 internals ('image-unloaded' texture eviction, TileSource cache hooks that OSD 6 deprecates).
- A sliding window of 2-3 preloaded TiledImages swapped by opacity, i.e. strategy (c) with a bounded window: addTiledImage at opacity 0, setOpacity, removeItem. Public OSD API only, bounded memory, and (c) already matched (d)'s speed on canvas (59.6 slices/s, 16.9 ms).
- A cell-local frame index with an onFrameChange callback instead of a per-notch shared-store write. The report raises this as an open question but never measures it. It matters for React re-render cost.
- Cine stepping locked to vsync (advance on the rAF timestamp, or one frame per N vsyncs) instead of floor(performance.now()/period), so 60 fps drop rates measure the pipeline rather than clock aliasing.
