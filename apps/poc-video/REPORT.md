# Proof of concept: frame-accurate video annotation

Branch `claude/poc-video`, head `ba2d1a21c3` at the time of the result. Part of the osdlabel roadmap study (branch `claude/osdlabel-roadmap-strategy-uut5ay`). Written by the orchestrating agent from the PoC agent's structured result, because PoC agents in this environment cannot write report files.

**Status:** Build, independent review and fix pass complete. The fix pass replaced nearestFrame with reconcileFrame over frame-start times, showed requestVideoFrameCallback is reliable (the earlier failure was a harness timer), withdrew the VideoLayer recommendation (OSD drawing the frame directly is within about 10% and frame-locked), and prototyped keyframes as ordinary annotations. Render numbers are CPU-only; a real-GPU run is pending.

## Summary

osdlabel can annotate video frame-accurately with its existing OSD, Fabric and DOM layers. The fix pass changed three of the original claims:

- rVFC is reliable. The earlier "fires in only 69% of seeks" was a harness artifact.
- The VideoLayer recommendation is withdrawn. OSD drawing the frame directly is within 3-10% of a canvas layer, and both stay frame-locked.
- nearestFrame is replaced. Stored times are now resolved with `reconcileFrame`.

No existing package changed. Only `eslint.config.js` (+5/-1) and `pnpm-lock.yaml` (+115) were touched. Everything else is new: `@osdlabel/temporal` (1,014 src lines), a new decode-only `@osdlabel/video` (521 src lines) and `apps/poc-video`.

**H1: frame accuracy (partial)**

- WebCodecs, through `@osdlabel/video`'s `WebCodecsFrameSource` over the mediabunny Demuxer adapter: exact on 1,920/1,920 ops. That covers 12 synthetic barcode videos (H.264, VP9 and AV1; 30, 29.97 fps and VFR; GOP 1, 30 and 250) in 4 access patterns.
- mediabunny's own `VideoSampleSink.getSample`: also exact, 1,440/1,440. But it has no decode continuation, so a forward step costs p50 11-1,255 ms against 0.5-5.2 ms for `WebCodecsFrameSource`. The hand-written decode loop stays.
- HTMLVideoElement with naive targets:
  - i/fps: 62.6% exact.
  - Stepping by 1/fps from a frame boundary: 23.0%.
  - Nominal mid-frame: 97.1% (VFR 62.5-67.5%).
- HTMLVideoElement seeking to demuxed table midpoints: 1,440/1,440 exact.
- rVFC, after the fix (the 250 ms window now opens at `seeked`): fired on 6,240/6,240 seeks, and its mediaTime matched the frame on screen 6,240/6,240.
- Forward stepping is where WebCodecs wins clearly. Random and backward access are GOP-bound and roughly equal; the WebCodecs advantage there comes from the LRU, which one decode fills.

**H2: render path (re-measured)**

- Setup: a 60 fps 1080p source, 10 host/source/decoration combos x {static, pan+zoom, fast pan at ~2,000-2,400 px/s} x 3 reps.
- Frame lock: every OSD host and the WebCodecs canvas layer were locked in 100% of 24-36 screenshots per cell. The CSS-transformed `<video>` was locked in only 8-25%, 1-4 frames behind.
- Best frame-locked paths (content fps, decorations on):

| Path                                                                                             | Content fps |
| ------------------------------------------------------------------------------------------------ | ----------- |
| OSD canvas drawer drawing the VideoFrame directly through a stand-in tile context (`osd-direct`) | 34.4-35.3   |
| WebCodecs canvas under the overlay                                                               | 35.5-38.0   |
| Old OSD path with a tile copy                                                                    | 24.3-24.8   |

- The canvas layer is about 10% faster static and tied under motion, so no compositor package is needed. Recommendation: OSD as host, with direct draw.
- DOM decorations cost 6-7 ms per frame including style and layout (about 47 → 35 fps when on), against 2.3 ms by the JS timer. That refutes "decorations are not the bottleneck" at 60 fps.
- All of this is CPU-only (SwiftShader, headless). The WebGL drawer managed 3.8-6.3 fps.

**H3: temporal model (confirmed)**

- Cost for 1,000 tracks, warm p50 per frame: rectangles 0.18 ms, mixed shapes 0.49 ms, unequal polygons 1.85 ms. Cold spikes reach 55-102 ms.

**H3-axis: stored times (B1)**

- Contract: `FrameRef.timeUs` is the frame's start pts in integer µs. `reconcileFrame` = at-or-before(t + min(1 ms, frame/4)).
- `reconcileFrame` got 0 wrong for every frame-start writer: 25,200 synthetic, 6,240 rVFC mediaTimes after seeks, and 479/480 paused mediaTimes. It also got 0/4,200 for table-midpoint writers, and 4.0-4.5% for times uniform inside the frame.
- nearestFrame was wrong for 3,211/4,200 midpoints and about 2,250/4,200 in-span times.
- Plain at-or-before was wrong for up to 2,280/4,200 millisecond-truncated starts.
- `video.currentTime` is not a frame identity. After a pause, the frame on screen started after currentTime in 288/480 samples, and every rule failed 33-62%. Store rVFC mediaTime instead.

**Keyframes as ordinary annotations (recommended)**

- Each keyframe is an `OsdAnnotation` plus `KeyframeFields` (`trackId`, `frame: FrameRef`, `visibility`), written by osdlabel's own serialize. It round-trips exactly: 0/300,000 samples differed.
- osdlabel's deserialize strips the keyframe fields, so one extra Valibot pass (36 ms) puts them back.
- It costs 14.8 MB JSON (1.59 MB gzip) against 4.1 MB (1.16 MB) for a complete TrackDocument, and 181 vs 49 ms to validate. 59% of that size is the per-keyframe Fabric payload that the existing schema requires (about 900 B per vector keyframe).

**Packaging**

- `@osdlabel/video` is decode-only over a three-member `Demuxer` interface. mediabunny is an optional peer behind the `@osdlabel/video/mediabunny` subpath, restricted to MP4 and WebM.
- Bundle sizes: core alone 4.8 kB min; core plus adapter 212 kB min / 58 kB gzip, against 338 / 92 kB with ALL_FORMATS.
- No compositor and no FabricOverlay dependency. mp4box.js was not tested.
- The bench now runs on a clean checkout.

## Hypotheses and verdicts

### H1: partial

HTMLVideoElement seeking (currentTime + requestVideoFrameCallback) is not reliably frame-accurate, while WebCodecs (demux + decode from the preceding keyframe) is exact.

representative.json h1 (run-2026-10-24T17-59-37-846Z, Chromium 153 headless, 12 videos x 40 ops per cell).

- WebCodecs (@osdlabel/video WebCodecsFrameSource over MediabunnyDemuxer): 1,920/1,920 exact.
- mediabunny VideoSampleSink.getSample: 1,440/1,440 exact.
- Video element, by seek target:
  - boundary i/fps: 901/1,440 (62.6%; 29.97 fps 30-33%).
  - nominal mid: 1,398/1,440 (97.1%; VFR misses only).
  - increment from boundary: 221/960 (23.0%).
  - increment from mid: 959/960.
  - demuxed table midpoint: 1,440/1,440 after presentation (1,439/1,440 if read at 'seeked').
- 'Not reliably accurate' is confirmed for naive targets and refuted for table-midpoint targets. 'WebCodecs is exact' is confirmed.

### H1-rvfc: refuted

(original claim) requestVideoFrameCallback fails to fire for ~31% of seeks (no callback when a seek re-presents the frame), so the element cannot report which frame it shows.

With the 250 ms window opened at 'seeked' instead of before the seek, rVFC fired on 6,240/6,240 seeks.

- Its mediaTime matched the on-screen barcode in 6,240/6,240.
- The callback ran p50 16.5 ms and p95 3.8 ms BEFORE 'seeked'. Only 87 ran after it, the latest 69 ms after.
- The earlier 4,313/6,240 was the cancel timer cutting off seeks slower than ~250 ms.

### H1-latency: partial

WebCodecs is the faster path for stepping and back-stepping.

Forward one-frame step p50 (ms):

- WebCodecs: 0.5-5.2.
- Element increment@mid (to presented frame): 42-1,092.
- VideoSampleSink: 11.5-1,255.

Back-step without cache p50 is GOP-bound and roughly equal:

- WebCodecs 12-1,441 vs element table-mid 47-1,548. For example, h264 720p GOP 250: 666 vs 683. vp9 1080p: 135 vs 300.
- With a 64-frame LRU, WebCodecs back-steps p50 0 ms. One decode from the key fills the cache with every frame it passes.

Random p50:

- WebCodecs 12-551 vs element 38-755. WebCodecs was lower on all 12 videos in this run, but the review's rerun had the element faster on vp9 GOP 250 and AV1. Treat random access as GOP-bound for both.

Confirmed for forward stepping and cached back-stepping; not a general latency win.

### H1-sink: refuted

mediabunny's VideoSampleSink can replace the hand-rolled WebCodecs decode loop.

VideoSampleSink.getSample(frame's own timestamp) is exact on 1,440/1,440 and random p50 is 10-917 ms (comparable). But each call is an independent keyframe-aware seek with no continuation, so a forward step is a GOP decode:

- h264 720p GOP 30: 115 vs 3.4 ms.
- h264 1080p GOP 250: 1,255 vs 4.7 ms.

The 221-line decode loop is kept, now over a Demuxer interface. mediabunny's samples() iterator (sequential) was not measured.

### H2: partial

Frames shown through OSD with the Fabric overlay and DOM decorations stay frame-locked and in sync during play and pan/zoom, and OSD is a viable host for video.

Setup: run-2026-10-24T18-59-26-790Z, 1080p60 H.264 source, 1280x720, 3 reps x 6 s per cell, load1 median 2.5-4.8, SwiftShader / software raster.

Frame lock (overlay frame code == video frame code on screen):

- 100% of 24-36 screenshots in every OSD cell (canvas copy, direct draw, WebGL; video or WebCodecs source) and in css/webcodecs, including fast pan at 2,049-2,410 px/s.
- Spatial sync <= 1 px everywhere.

Content fps, median (deco on):

- osd-direct: 33.8-36.1.
- osd-canvas copy: 24.3-32.3.
- osd-webgl: 3.8-6.3.

No host reached 60 on this CPU-only host. Main thread 96-100% busy. The WebCodecs players fall 35-158 frames behind the 60 fps clock. Sync and viability are confirmed; real-time 1080p60 is not.

### H2-layer: refuted

(original recommendation) 1080p playback needs a WebCodecs-fed canvas layer under the overlay (VideoLayer) rather than OSD's tile path.

Content fps median (min-max), deco on:

| Motion  | css/webcodecs (canvas under overlay) | osd-direct/webcodecs |
| ------- | ------------------------------------ | -------------------- |
| static  | 38.0 (35.7-39.3)                     | 34.4 (33.7-35.9)     |
| panzoom | 35.5 (34.5-37.5)                     | 34.5 (32.5-35.6)     |
| fastpan | 36.6 (36.3-37.5)                     | 35.3 (34.2-37.6)     |

With deco off: 50.2/45.9/46.6 vs 46.3/46.3/47.4. Both are frame-locked 100%.

The gap is about 10% static and the ranges overlap under motion. The large earlier gap came from the second 1080p blit (osd-canvas copy 24.3-24.8 fps), which drawing the frame directly removes without a new layer. VideoLayer is withdrawn from the package plan. A real-GPU rerun could reopen it.

### H2-decorations: refuted

DOM decorations and the Fabric overlay are not the bottleneck of a 1080p video path.

A/B on the two fastest WebCodecs cells (3 reps each):

- css/webcodecs: 50.2/45.9/46.6 fps off vs 38.0/35.5/36.6 on.
- osd-direct/webcodecs: 46.3/46.3/47.4 off vs 34.4/34.5/35.3 on.

That is +5.9 to +7.4 ms per frame for 100 decoration elements (50 tracks). The JS timer saw only 2.3 ms; the rest is style, layout and paint. The Fabric update itself was 1.5-2.0 ms. At 60 fps decorations take ~40% of the frame budget. Measured at 50 tracks only.

### H3: confirmed

A pure zero-dependency temporal package (tracks = id + keyframes; interpolation; masks held; visibility) composes with the annotation model and serialization and costs little for 1,000 tracks per frame.

Node 22, run-2026-10-24T19-28-51-485Z, 300 frames, keyframe every 30. Per-frame p50 / p95 (ms):

- 1,000 rectangles: 0.178 / 0.262 warm.
- Mixed: 0.492 / 1.06.
- 1,000 unequal polygons (12<->24, redrawn): 1.854 / 3.682.

Cold max frame 3.8 / 55.3 / 102 ms (lazy correspondences).

Area at midpoint: naive index interpolation 0.498 p50 (shifted) and 0 (redrawn), against 1.000 aligned.

Composition with serialization is now shown end to end, see H3-storage. Harness: 15 substantive checks pass and 1 fails (rect origin, a library bug); 2 rows are informational.

Rotation midpoints are now normalised to [0,360) (350->10 gives 0).

### H3-axis: partial

Storing a keyframe's time as the frame's START pts in integer µs and resolving it with at-or-before(t + min(1 ms, frame/4)) (reconcileFrame) is right for every realistic writer, where nearestFrame and plain at-or-before are not.

Axis study: reader axis = mediabunny demux in Node (integer µs, truncated); 13 videos; 4 rate classes. Wrong of n:

| Writer                              | at-or-before | nearest               | reconcile                      |
| ----------------------------------- | ------------ | --------------------- | ------------------------------ |
| start µs (round or trunc)           | 0/4,200      | 0                     | 0                              |
| start s float                       | 49           | 0                     | 0                              |
| start ms round                      | 1,180        | 0                     | 0                              |
| start ms trunc                      | 2,280        | 0                     | 0                              |
| nominal i/fps                       | 387          | 0                     | 0                              |
| rVFC mediaTime after seek (browser) | 131/6,240    | 0                     | 0                              |
| paused rVFC mediaTime               | 9/480        | 1                     | 1                              |
| table-mid s                         | 0            | 3,211/4,200 (67-100%) | 0                              |
| in-span s                           | 0            | 2,254                 | 190 (4.0-7.0%; 7.0% at 60 fps) |
| in-span ms                          | 55           | 2,231                 | 169                            |
| element currentTime after seek      | 463/6,240    | 2,226                 | 1,300                          |
| paused currentTime                  | 288/480      | 161                   | 282                            |

Confirmed for frame-start writers (including browser mediaTime) and midpoints. Partial for in-span times (~1 ms / frame of them land on the next frame). Refuted for currentTime: no rule works, because the browser itself shows a frame that does not contain currentTime.

### H3-storage: confirmed

Track keyframes can be ordinary OsdAnnotations carried by the existing serialize / deserialize / validation path, with tracks a derived grouping, instead of a separate TrackDocument wire format.

keyframes.html, 1,000 mixed tracks x 10 keyframes (50 mask tracks with real pixels), Chromium 153.

- A, keyframe annotations: 14,771,382 B JSON, 1,593,508 B gzip.
  - Timings (ms): build 288, stringify 93, parse 58, validate 181 (osdlabel deserialize 145 + KeyframeFields pass 36), group 6.8.
  - Round trip 0/300,000 samples differ.
- B, complete TrackDocument v2 with a Valibot schema: 4,084,149 B, 1,158,149 B gzip.
  - Timings (ms): build 13, stringify 20, parse 19, validate 49, to tracks 4.6.
  - 0/300,000 differ.
- The existing deserialize does NOT carry the fields: Valibot v.object strips unknown keys (keyframeFieldsSurviveDeserialize=false). A second pass, or a deserialize option, is needed.
- 8,674,668 B of A (59%) is rawAnnotationData. A vector keyframe's serialized Fabric object is 901 B. Works; costs 3.6x size (1.38x gzip) and 3.7x validation.

### H3-caching: partial

(from the frame-axis PoC) Fabric object caching must be off for per-frame annotation swaps.

The frame-axis PoC made it a speed choice, not a correctness claim. This PoC's check (objectCaching=true, in-place set(), 22 frames) painted within 0.40 px of the object box at zoom 1 and 2.5. It did not test rotation or flip, which CLAUDE.md flags as the case that breaks Fabric's caching. Not a correctness requirement for unrotated views; untested for rotated ones.

### H5-packaging: confirmed

The video decoder can be a decode-only leaf (@osdlabel/video) over a small Demuxer interface with a mediabunny adapter, with no compositor and no OSD or Fabric dependency.

packages/video:

- Demuxer interface: decoderConfig, display size, packets, chunk(j), close.
- WebCodecsFrameSource over it; FrameTable; LruCache.
- Subpath @osdlabel/video/mediabunny: MediabunnyDemuxer, MediabunnySampleFrameSource. mediabunny is an optional peer dependency.

The H1 run used it for every WebCodecs op (1,920/1,920 exact). 6 unit tests in Node against a fake decoder with B-frame reordering, covering exact frames, continuation, key restart and cache.

esbuild minified bundles:

- Core: 4,772 B (1,806 gzip).
- Core + adapter (MP4, WEBM): 212,108 / 58,353.
- Core + adapter + sink: 266,586 / 72,103.
- First-PoC equivalent with ALL_FORMATS: 337,733 / 91,624.

The OSD presenter stays in the app (canvas-tile-source.ts), i.e. frame-osd territory. mp4box.js was not implemented or tested.

### X-rect-origin: refuted

(incidental) The stock rectangle tool/builder paints where its geometry says.

Unchanged by this pass. The H3 harness again measured the stock Rect object box 101.0-111.1 px from its geometry box (originX 'center', Fabric 7.4.0 default). A separate fix branch exists for it.

## Measurements

| Measurement                                                                                                                        | Value                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | Unit                             | Conditions                                                                                                                                                                                                                                                                                                                                                        |
| ---------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| H1 WebCodecs exact (WebCodecsFrameSource over MediabunnyDemuxer)                                                                   | 1920/1920 (random 480, forward 480, backward 480, backward+LRU64 480)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | ops exact                        | run-2026-10-24T17-59-37-846Z; 12 synthetic barcode videos (h264/vp9/av1, 720p/1080p, 30/29.97/VFR, GOP 1/30/250, B-frames on/off), 40 ops per cell; headless Chromium 153.0.8010.12; host load 1.9 at start, up to ~9 mid-run from other agents                                                                                                                   |
| H1 mediabunny VideoSampleSink.getSample exact                                                                                      | 1440/1440 (random, forward, backward 480 each)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | ops exact                        | same run; getSample(frame's own demuxed timestamp in seconds), no cache                                                                                                                                                                                                                                                                                           |
| H1 video element exact, pooled per seek target                                                                                     | boundary i/fps 901/1440 (62.6%); nominal mid 1398/1440 (97.1%); table-mid 1440/1440 (1439/1440 if read at 'seeked'); increment@boundary 221/960 (23.0%); increment@mid 959/960                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | ops exact                        | same run; seek currentTime, wait 'seeked', then up to 250 ms after 'seeked' for rVFC; barcode read after presentation. Per video: 29.97 fps boundary 12-13/40; VFR mid 25-27/40                                                                                                                                                                                   |
| H1 rVFC after the window fix                                                                                                       | fired 6240/6240; mediaTime frame == on-screen barcode 6240/6240; callback time relative to 'seeked' p50 -16.5 ms, p95 -3.8 ms, max +69.1 ms (87 of 6240 after 'seeked'); misses on slow seeks 0                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | seeks                            | all video-element ops in the run; previous harness armed a 250 ms cancel timer before the seek and reported 4313/6240                                                                                                                                                                                                                                             |
| H1 forward one-frame step latency p50                                                                                              | WebCodecs 0.5-5.2; VideoSampleSink 11.5-1255; element increment@mid 41.9-1092 (to presented frame)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | ms                               | per-video p50 over 40 steps; extremes h264 720p GOP1 / h264 1080p 29.97 GOP250; host load varying 2-9                                                                                                                                                                                                                                                             |
| H1 latency per video p50: WC random / fwd / back / back-LRU64 \| sink random / fwd / back \| element table-mid random / fwd / back | h264-720p-30-g30-bf 132/3.4/128/0 \| 113/115/107 \| 140/143/131 h264-720p-30-g30-nobf 115/4.0/107/0 \| 128/114/80 \| 134/168/127 h264-720p-30-g1 12/3.9/12/16 \| 10/12/15 \| 38/44/47 h264-720p-30-g250-bf 283/0.7/667/0 \| 434/589/822 \| 477/600/683 h264-720p-2997-g30-bf 92/0.7/85/0 \| 93/83/74 \| 146/152/137 h264-720p-vfr-g30-bf 84/0.8/70/0 \| 86/85/67 \| 110/101/83 h264-1080p-30-g30-bf 185/1.2/137/0 \| 174/159/133 \| 208/197/158 h264-1080p-2997-g250-bf 551/4.7/1441/0 \| 917/1255/1539 \| 714/1148/1548 vp9-720p-30-g30 213/5.2/123/0 \| 173/177/149 \| 242/217/182 vp9-720p-2997-g250 452/3.7/1194/0 \| 758/1030/1290 \| 755/1132/1258 vp9-1080p-30-g30 167/1.5/135/0 \| 185/205/126 \| 420/396/300 av1-720p-30-g30 133/0.5/119/0 \| 133/108/110 \| 146/124/136 | ms                               | same run; element times are to the presented frame (msFrame); noisy shared host, accuracy is load-independent, latency is not                                                                                                                                                                                                                                     |
| Paused playback: currentTime vs frame on screen                                                                                    | currentTime before the shown frame's start in 288/480, inside it in 192/480, after 0; offset of currentTime from shown frame start, in frames: min -1.64, p10 -0.90, p50 -0.17, p90 +0.35, max +0.90; last rVFC mediaTime == shown frame 479/480                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | pauses                           | 12 videos x 40 pauses: seek to a random time, play 80-480 ms, pause, 2 rAF + 50 ms, read currentTime and barcode (drawImage); headless Chromium 153                                                                                                                                                                                                               |
| Demux / timestamp table / LRU                                                                                                      | demux 43-195 ms per 300-frame file; demuxed pts vs ffprobe max 0-0.667 µs (mediabunny truncates to µs); 64-frame LRU peak 57-88 MB (720p), 131-199 MB (1080p)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | ms / µs / MB                     | H1 run, MediabunnyDemuxer whole-file demux, VideoFrame.allocationSize()                                                                                                                                                                                                                                                                                           |
| Decode-path bundle sizes                                                                                                           | @osdlabel/video core 4,772 B min / 1,806 gzip; core + mediabunny adapter (MP4,WEBM) 212,108 / 58,353; + VideoSampleSink source 266,586 / 72,103; first-PoC equivalent (ALL_FORMATS + EncodedPacketSink) 337,733 / 91,624                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | bytes                            | esbuild 0.28.2, minify, ESM, browser platform, gzip -9; scratch script measure.mjs                                                                                                                                                                                                                                                                                |
| H2 content fps per cell (median, min-max of 3 reps), deco on                                                                       | osd-canvas/video: static 32.3 (32.1-33.3), panzoom 31.6, fastpan 32.0 osd-direct/video: 33.8 (32.4-34.7), 36.0, 36.1 osd-webgl/video: 5.6, 6.3, 5.8 css/video: 53.1 (50.1-54.9), 53.1, 55.2 osd-canvas/webcodecs: 24.8 (24.8-27.5), 24.3, 24.4 osd-direct/webcodecs: 34.4 (33.7-35.9), 34.5 (32.5-35.6), 35.3 (34.2-37.6) osd-webgl/webcodecs: 4.2, 4.5, 3.8 css/webcodecs: 38.0 (35.7-39.3), 35.5 (34.5-37.5), 36.6 (36.3-37.5)                                                                                                                                                                                                                                                                                                                                                  | content fps                      | run-2026-10-24T18-59-26-790Z; h264-1080p-60-g60-bf (600 frames, 60 fps), 1280x720 viewport, 6 s per rep, 3 reps (outer loop), 50 interpolated rects + 100 DOM decorations; headless Chromium 153, SwiftShader WebGL / software 2D (CPU-only, pessimistic); load1 median per cell 2.5-4.8; main thread 96-100% busy in every non-css/video cell (css/video 79-84%) |
| H2 frame lock (overlay frame code minus on-screen video frame code), pooled over reps                                              | Every OSD cell (canvas, direct, WebGL; video and WebCodecs) and css/webcodecs: 0 delta in 24/24 (static) and 36/36 (panzoom, fastpan) = 100% locked. css/video: locked 6/24 static (25%), 3/36 panzoom (8.3%), 3/36 fastpan (8.3%); deltas -1 (12/21/26), -2 (6/10/7), -3, -4                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | screenshots                      | 8 (static) or 12 (motion) screenshots per rep x 3 reps; codes read from 4x4 blocks; same run                                                                                                                                                                                                                                                                      |
| H2 spatial sync and pan speed                                                                                                      | syncMax <= 1 px in every cell; marker speed at the shot: panzoom 105-151 px/s, fastpan 1,482-2,410 px/s (WebGL cells lower because of their 4-6 fps rAF)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | px, px/s                         | speed measured over two rAFs immediately before each screenshot; fastpan = zoom 2, +-0.18 viewport units at 5.5 rad/s                                                                                                                                                                                                                                             |
| H2 decorations A/B at the top of the range                                                                                         | css/webcodecs off 50.2/45.9/46.6 vs on 38.0/35.5/36.6 fps (static/panzoom/fastpan); osd-direct/webcodecs off 46.3/46.3/47.4 vs on 34.4/34.5/35.3; per-frame cost +5.9 to +7.4 ms; JS timer for providers + DecorationLayer.setDecorations 2.1-2.5 ms; Fabric update 1.5-2.0 ms                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | content fps / ms per frame       | same run, 3 reps per cell, 50 tracks / 100 decoration elements                                                                                                                                                                                                                                                                                                    |
| H2 WebCodecs clock lag                                                                                                             | median frames behind the 60 fps clock: osd-canvas 151-158, osd-direct 106-109, css 77-113 (deco off 30-61), osd-webgl 35-113                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | frames                           | mean over rAF ticks of (frame the wall clock wants - frame shown); player shows the newest decoded non-future frame and skips ahead when behind; shows that no WebCodecs path plays 1080p60 in real time on this CPU                                                                                                                                              |
| H3 temporal cost per frame (Node)                                                                                                  | 1,000 rectangles warm p50/p95 0.178/0.262, materialize 0.303/0.658, cold max 3.8; mixed 0.492/1.06, materialize 0.682/1.956, no-cache 8.6, cold max 55.3 (2,700 correspondences); 1,000 polygons 12<->24 redrawn 1.854/3.682, materialize 2.677/8.645, no-cache 69.1, cold max 102.0 (9,000 correspondences)                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | ms                               | run-2026-10-24T19-28-51-485Z; Node 22.22, single thread, 300 frames, keyframe every 30, 10% occluded keyframes; load 3.3                                                                                                                                                                                                                                          |
| H3 polygon area at t=0.5 / keyframe area                                                                                           | naive index: shifted start p50 0.498 (min 0, max 0.965), redrawn 0; aligned 1.000 (min 0.999); unequal 16->24 aligned 0.998-1.011                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | ratio                            | 200 random star polygons, deterministic                                                                                                                                                                                                                                                                                                                           |
| H3 axis study: wrong of n, pooled per writer (at-or-before / nearest / reconcile)                                                  | start µs round 0/0/0 of 4,200; start µs trunc 0/0/0; start s float 49/0/0; start ms round 1,180/0/0; start ms trunc 2,280/0/0; nominal i/fps 387/0/0; table-mid s 0/3,211/0; in-span s 0/2,254/190; in-span ms 55/2,231/169; element currentTime after seek 463/2,226/1,300 of 6,240; element rVFC mediaTime after seek 131/0/0 of 6,240; paused currentTime 288/161/282 of 480; paused rVFC mediaTime 9/1/1 of 480                                                                                                                                                                                                                                                                                                                                                               | frames resolved to another frame | reader axis = mediabunny 1.62.1 demux in Node, integer µs (truncated); truth = frame index (synthetic writers, ffprobe pts) or on-screen barcode (browser writers from the H1 run); 13 videos (12 H1 + 1080p60); reconcile = frameAt(t + min(1 ms, frame/4))                                                                                                      |
| H3 axis study by rate class (reconcile % wrong) for the non-zero writers                                                           | in-span s: CFR 29.97 4.0, CFR 30 4.0, CFR 60 7.0, VFR 5.3; in-span ms: 2.9 / 3.8 / 6.8 / 4.0; element currentTime after seek: 27.5 / 19.1 / - / 14.6; paused currentTime: 60.8 / 59.7 / - / 45.0; paused rVFC mediaTime: 0 / 0 / - / 2.5. nearest for table-mid: 66.9 / 75.3 / 99.8 / 67.3. at-or-before for start ms trunc: 64.4 / 50.0 / 66.7 / 33.3                                                                                                                                                                                                                                                                                                                                                                                                                            | % of frames                      | same study; CFR 30 = 8 videos, CFR 29.97 = 3, VFR = 1, CFR 60 = 1 (synthetic writers only)                                                                                                                                                                                                                                                                        |
| Keyframe storage, 1,000 tracks x 10 keyframes                                                                                      | A keyframe annotations: 14,771,382 B, gzip 1,593,508; build 288 ms, stringify 93, parse 58, validate 181 (deserialize 145 + keyframe-field pass 36), group 6.8; round trip 0/300,000. B TrackDocument v2: 4,084,149 B, gzip 1,158,149; build 13, stringify 20, parse 19, validate 49, to tracks 4.6; round trip 0/300,000. B0 first-PoC TrackDocument (no masks/context): 3,640,984 B, gzip 1,139,986                                                                                                                                                                                                                                                                                                                                                                             | bytes / ms (median of 5)         | keyframes.html in headless Chromium 153; mixed fixture with 50 mask tracks carrying real pixels; reader axis = writer's 29.97 fps axis truncated to µs; A's rawAnnotationData 8,674,668 B (901 B per vector keyframe); osdlabel deserialize strips KeyframeFields (keyframeFieldsSurviveDeserialize=false)                                                        |
| H3 scrub harness                                                                                                                   | 15 substantive checks pass, 1 fails (stock Rect object 101.0-111.1 px from its geometry, originX center), 2 informational; 0/81 wrong frames; \|object - lerp\| 0.000 px (object properties, not pixels); painted box vs object box 0.40 px (objectCaching on, zoom 1 and 2.5, no rotation); scrub latency p50/p95/max 8.0/153.0/184.7 ms; Fabric updates 96 in place / 14 rebuilt / 31 unchanged                                                                                                                                                                                                                                                                                                                                                                                 | checks / px / ms                 | tracks.html, 720p H.264 GOP30 B-frames, stock RectangleTool and Fabric drag, 32-frame LRU, OSD canvas drawer                                                                                                                                                                                                                                                      |
| Unit tests                                                                                                                         | @osdlabel/temporal 20 (reconcileFrame, FrameRef, groupKeyframeAnnotations, rotation normalisation added); @osdlabel/video 6 (frame table, LRU, WebCodecsFrameSource over a fake reordering decoder); apps/poc-video 1                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | tests passing                    | vitest; lint, typecheck (src + tests) and prettier clean for temporal, video, poc-video                                                                                                                                                                                                                                                                           |
| Clean-checkout bench                                                                                                               | with packages/temporal/dist and packages/video/dist deleted, `node apps/poc-video/scripts/bench.mjs --only h3` rebuilt them (turbo) and completed in 65 s                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | pass                             | workspace modules are now import()ed after the build step; Vite runs with configFile:false, watch:null, hmr:false                                                                                                                                                                                                                                                 |

## Recommendation

Treat video as one more frame axis. Keep OSD as the host for pixels, viewport and overlay, and add no new renderer or compositor.

1. **@osdlabel/frame** (merge with the frame-axis PoC) holds FrameAxis, FrameRef and frameAt.
   - `FrameRef = { index, timeUs? }`, where `timeUs` is defined as the frame's START presentation timestamp in integer µs.
   - `reconcileFrame(axis, t)` = frameAt(t + min(1 ms, frame/4)) resolves stored times. It got 0 wrong for every frame-start writer and for midpoints, 4-7% for in-span times. `frameAt` stays the answer for 'on screen at t'.
   - Drop `nearestFrame`, which was 53-100% wrong for midpoint and in-span times.
   - Document the rule for writers: store the demuxed start or rVFC mediaTime, never `video.currentTime`. Every lookup rule failed 33-62% of paused currentTime values.
2. **@osdlabel/temporal** keeps interpolation, contour correspondence (precomputed on keyframe edit), the materializer and visibility.
   - Tracks are not stored. A keyframe is an ordinary OsdAnnotation carrying `KeyframeFields` (`trackId`, `frame: FrameRef`, `visibility`). `groupKeyframeAnnotations` derives tracks on load. Round trip exact on 300,000 samples.
   - This reuses the store, reducers, undo, serialize, mask normalisation and validation instead of a parallel TrackDocument entity. The cost is 3.6x JSON (1.38x gzip) and 3.7x validation time, mostly the existing per-annotation Fabric payload.
   - Two small additions to existing packages make the path first-class:
     - `KeyframeFieldsSchema` in @osdlabel/validation.
     - A `deserialize(doc, { fieldsSchema })` option in osdlabel. Today Valibot strips the fields, so the PoC re-validates them in a 36 ms second pass.
3. **@osdlabel/video** is a decode-only leaf:
   - The `Demuxer` interface (decoderConfig, display size, packets, `chunk(j)`, close), `WebCodecsFrameSource` (decode from key, continue forward, byte-bounded LRU) and FrameTable.
   - A subpath `@osdlabel/video/mediabunny` holds the adapter. mediabunny is an optional peer, restricted to MP4 and WebM: 212 kB min / 58 kB gzip.
   - No compositor and no OSD, Fabric or FabricOverlay dependency.
   - Keep the hand-written decode loop. VideoSampleSink is exact but 10-250x slower per forward step.
   - Any other container library (mp4box.js, untested; DICOM-encapsulated MPEG) is another adapter.
4. **Presentation** lives in **@osdlabel/frame-osd**, beside the frame axis: the one-tile presenter.
   - For the 2D drawer, hand OSD the VideoFrame or `<video>` directly through the tile's rendered-context hook (`osd-direct`). That removes the second 1080p blit (24 → 34-35 fps) and stays frame-locked in 100% of screenshots, including fast pan.
   - For the WebGL drawer, a texture re-upload through OSD's private `_TextureMap`.
   - The canvas-under-overlay VideoLayer is withdrawn. It was only ~10% faster static and tied under motion, and it would be a second compositor.
   - Never show the `<video>` element itself under the overlay: it is not frame-locked (75-92% of screenshots 1-4 frames behind).
5. **Bindings** (later): a timeline/scrubber, keyframe and visibility actions, a per-cell current frame, and a ViewerCell that renders materialised annotations for the current frame. Constraints must count tracks, not keyframes.
   - During playback, throttle or simplify DOM decorations. At 60 fps they cost 6-7 ms per frame (the PoC did not test a throttle).

DICOM stays outside: `FrameRef.index` plus `timeUs`, or an adapter key, carry SOP/frame identity. A DICOM-encapsulated H.264 object reaches @osdlabel/video through a Demuxer adapter.

This respects the philosophy:

- frame, temporal and video are leaves, and nothing existing depends on them.
- Best tool per job: WebCodecs decodes, OSD shows pixels and owns the viewport, Fabric holds the vectors, the DOM holds the decorations.
- No monolithic renderer is introduced.

### New packages

- @osdlabel/frame (merged frame axis: FrameAxis, FrameRef {index, timeUs = start pts µs}, frameAt, reconcileFrame, buckets; type-only dep on @osdlabel/annotation)
- @osdlabel/temporal (Keyframe/visibility model, KeyframeFields + groupKeyframeAnnotations, interpolation, contour correspondence, materializer; deps: @osdlabel/frame, @osdlabel/annotation types; no wire format of its own)
- @osdlabel/video (decode only: Demuxer interface, WebCodecsFrameSource, FrameTable, LruCache; subpath ./mediabunny with MediabunnyDemuxer; mediabunny optional peer; no OSD/Fabric deps)
- @osdlabel/frame-osd (from the frame-axis PoC: one-tile presenter with the direct-draw hook for VideoFrame / <video>, WebGL re-upload; depends on openseadragon, structural frame-source type)

### Changes to existing packages

- None made in this PoC: 0 existing package source files changed (only eslint.config.js +5/-1 for poc-video script globals, and pnpm-lock.yaml +115).
- Needed to productise keyframes-as-annotations: @osdlabel/validation adds KeyframeFieldsSchema (trackId, frame {index, timeUs}, visibility); osdlabel's deserialize accepts an extension-fields schema (today v.object strips unknown keys, measured keyframeFieldsSurviveDeserialize=false). About 30-50 lines plus tests.
- Bindings later: osdlabel adds keyframe/visibility actions and per-cell current-frame UI state; @osdlabel/solid and @osdlabel/react add a timeline/scrubber and render materialised annotations per frame, with parity tests and E2E; constraint counting must count tracks, not keyframes.
- Independent bug (unchanged, separate branch): fabric-annotations RectangleTool / buildFabricObjectFromGeometry need originX 'left', originY 'top' (Fabric 7 center default puts the painted box 101-111 px off).

### API sketch

```ts
// @osdlabel/frame (leaf)
export interface FrameRef {
  readonly index: number;
  readonly timeUs?: number;
} // timeUs = frame START pts, integer µs
export function frameAt(axis: FrameAxis, t: number): number; // on screen at t (playback)
export function reconcileFrame(axis: FrameAxis, t: number, capUs = 1000): number; // frameAt(t + min(cap, extent/4)) for STORED times
export function frameRefOf(axis: FrameAxis, i: number): FrameRef; // { index, timeUs: Math.round(start) }
export function resolveFrameRef(axis: FrameAxis, ref: FrameRef): number; // reconcile timeUs, else clamp index

// @osdlabel/temporal
export interface KeyframeFields {
  readonly trackId: TrackId;
  readonly frame: FrameRef;
  readonly visibility: 'visible' | 'occluded' | 'outside';
}
export type KeyframeAnnotation = OsdAnnotation & KeyframeFields; // stored, serialized, validated like any annotation
export function groupKeyframeAnnotations<E>(
  anns: readonly Annotation<KeyframeFields & E>[],
  axis: FrameAxis,
): {
  tracks: TrackBase<Annotation<KeyframeFields & E>>[];
  conflicts: KeyframeConflict[];
  mismatched: Annotation<KeyframeFields & E>[];
};
export function sampleTrack(track, frameIndex, cache?): TrackSample | null;
export function createFrameMaterializer(build): (tracks, frameIndex) => Annotation[]; // identity-preserving

// @osdlabel/validation + osdlabel (small additions)
export const KeyframeFieldsSchema = v.object({
  trackId,
  frame: v.object({ index, timeUs: v.optional(int) }),
  visibility,
});
deserialize(doc, { fieldsSchema: KeyframeFieldsSchema }); // keeps the extension fields instead of stripping them

// @osdlabel/video (decode only)
export interface Demuxer {
  decoderConfig: VideoDecoderConfig;
  displayWidth: number;
  displayHeight: number;
  packets: readonly { timestampUs: number; durationUs: number; key: boolean }[];
  chunk(j: number): EncodedVideoChunk;
  close(): void;
}
export class WebCodecsFrameSource {
  static create(
    demuxer: Demuxer,
    opts: { cacheFrames: number; cacheBytes: number },
  ): Promise<WebCodecsFrameSource>;
  readonly timestampsUs: readonly number[]; // build the FrameAxis from this
  getFrame(i: number): Promise<VideoFrame>; // exact, serialised; caller closes
  close(): void;
}
// @osdlabel/video/mediabunny
export class MediabunnyDemuxer implements Demuxer {
  static open(src: string | Blob, o?: { formats?: InputFormat[] }): Promise<MediabunnyDemuxer>;
}

// @osdlabel/frame-osd (presenter beside the axis, not in video)
export function createFrameTileSource(
  width: number,
  height: number,
  current: () => CanvasImageSource | null,
): OpenSeadragon.TileSource; // canvas drawer draws `current()` directly
```

### Effort

6.5-9 total:

- @osdlabel/frame merge (FrameRef contract, reconcileFrame, docs, tests): 0.5-1.
- Keyframes as annotations (KeyframeFields, grouping, correspondence precompute, validation schema, deserialize option, constraint semantics): 1-1.5.
- @osdlabel/video (Demuxer, frame source, byte LRU, capability checks and fallback, mediabunny adapter, error paths): 1-1.5.
- frame-osd presenter (direct draw, WebGL re-upload, drawer-upgrade guard): 0.5-1.
- Solid + React bindings with parity tests and E2E (timeline, keyframe and visibility actions, per-frame rendering, decoration throttling during playback): 3.5-4.

The rect origin fix (about 0.5 day) is separate.

### Risks

- All render numbers are CPU-only. The sandbox is headless Chromium with SwiftShader WebGL and software 2D. No path reached 60 fps at 1080p60, and the main thread was 96-100% busy. A real-GPU, headed rerun (bench --chromium <Chrome> --headed) could change the osd-direct vs canvas-layer margin and the WebGL drawer's standing.
- The direct-draw host relies on OSD 5's canvas drawer reading only `.canvas` and its width/height from the tile's rendered context. The WebGL path uses the private `_TextureMap`. Both can break on an OSD upgrade.
- DOM decorations cost 6-7 ms per frame at 50 tracks / 100 elements, about 40% of a 60 fps budget. 1,000 tracks was not rendered, and playback needs throttling or hiding (untested).
- Keyframes as annotations cost 3.6x JSON (1.38x gzip) and 3.7x validation time against a TrackDocument, mostly from the 901 B Fabric payload per vector keyframe. They also need constraint semantics: count tracks, not keyframes.
- Apps that store `video.currentTime` cannot be reconciled to the shown frame by any rule: 33-62% wrong after a pause in headless Chromium. The contract and the binding must store the start pts (rVFC mediaTime or the demux table).
- reconcileFrame re-attaches ~1 ms per frame of in-span times to the next frame (4% at 30 fps, 7% at 60 fps). This only matters if a writer ignores the start-time contract.
- mediabunny is MPL-2.0 and moves fast (1.62.x). The adapter is isolated behind a subpath, and mp4box.js is untested.
- WebCodecs players fall behind the clock when decode cannot keep up (35-158 frames at 1080p60 here). Real-time playback may need a Worker decode or the `<video>` element as the playback-only source, which is not frame-locked.
- Long-GOP files make random and backward access GOP-bound (0.3-1.5 s p50 at GOP 250), and the whole-file demux holds every packet in memory.
- Synthetic closed-GOP streams only. Open GOP, edit lists, fragmented MP4, long files and real footage are untested.

## Rejected alternatives

- **HTMLVideoElement currentTime seeking as the frame source for annotation**: Naive targets fail: i/fps 62.6% exact, 1/fps steps from a boundary 23.0%, nominal mid 97.1% (VFR 62.5-67.5%). Table-midpoint seeks are exact (1,440/1,440), but they need the same demux WebCodecs needs, and a forward step costs 42-1,092 ms p50 against 0.5-5.2 ms. As a playback layer under the overlay it is not frame-locked: locked in only 8-25% of screenshots. The old 'rVFC did not fire for 31% of seeks' argument is withdrawn: rVFC fired 6,240/6,240 and its mediaTime matched the shown frame 6,240/6,240.
- **Storing video.currentTime as a keyframe's time**: No lookup recovers the shown frame. After a pause the frame on screen started after currentTime in 288/480 samples, and at-or-before / nearest / reconcile were wrong 288 / 161 / 282 times of 480. After seeks, currentTime was wrong 463 / 2,226 / 1,300 times of 6,240 because the browser itself shows the previous frame at boundary times. rVFC mediaTime of the same events reconciles with 0 wrong (1/480 paused on VFR).
- **nearestFrame for stored times (the first version of this PoC)**: 0 wrong for frame-start writers, but 3,211/4,200 wrong for demuxed table-midpoint times and ~2,250/4,200 for times inside the frame span. reconcileFrame gets 0 and 4.0-4.5% on the same writers, and 0 on every frame-start writer.
- **Plain at-or-before (frameAt / the frame PoC's frameIndexAtTime) for stored times**: Wrong on 2,280/4,200 millisecond-truncated starts, 1,180 ms-rounded, 387 nominal i/fps, 49 float seconds and 131/6,240 browser mediaTimes. Each lands a hair before the frame start. It stays the rule for 'on screen at t'.
- **A canvas VideoLayer under the Fabric overlay inside @osdlabel/video**: Withdrawn. Against OSD drawing the frame directly it was +10% static and tied under motion (35.5 vs 34.5 fps panzoom, 36.6 vs 35.3 fast pan, overlapping per-rep ranges), and both are 100% frame-locked. It would put a second compositor and a FabricOverlay dependency into a decode package. The earlier gap came from the second 1080p blit of the tile-copy path.
- **OSD one-tile source with a tile-canvas copy (the first PoC's osd-canvas path)**: 24.3-24.8 fps with WebCodecs, against 34.4-35.3 when the canvas drawer draws the VideoFrame directly. The copy is a second software 1080p blit.
- **OSD WebGL drawer as the video host**: 3.8-6.3 fps on SwiftShader, and it needs OSD's private \_TextureMap to re-upload. Not usable on CPU-only; to be re-evaluated on a GPU.
- **mediabunny VideoSampleSink.getSample instead of the hand-rolled decode loop**: Exact (1,440/1,440), but it does not continue decoding between calls. A forward step costs 11.5-1,255 ms p50 against 0.5-5.2 ms for WebCodecsFrameSource. The sequential samples() iterator was not measured.
- **A separate TrackDocument wire format (tracks as their own entity)**: Smaller and faster: 4.08 vs 14.77 MB JSON, 1.16 vs 1.59 MB gzip, validation 49 vs 181 ms. Both round-trip exactly. But it duplicates what the annotation path already provides: schema, versioning, mask decoding/normalisation (the v2 schema checks shape only), store, undo and actions. It adds a parallel entity the bindings must manage. Kept only as the comparison baseline.
- **Storing per-frame materialised annotations**: 300 frames x 1,000 tracks = 300,000 annotations against 10,000 keyframes. Materialising costs 0.30-2.7 ms p50 per frame, and identity preservation keeps downstream memos stable.
- **Index-wise vertex interpolation for polygons**: Midpoint area collapses: p50 0.498 for a shifted start vertex and 0 for an opposite-winding redraw, against 1.000 aligned. It cannot handle unequal counts either.
- **Interpolating masks**: Mask geometry is only a bounding summary, and the pixels live in the payload. Morphing is a different raster algorithm. The harness verified that masks are held at the nearest keyframe.
- **mediabunny ALL_FORMATS in the adapter**: 337,733 B min / 91,624 gzip, against 212,108 / 58,353 restricted to MP4 + WebM.
- **mp4box.js as the demuxer**: Not implemented or tested in this PoC; it would be a second Demuxer adapter (BSD-3, MP4 only). No claim is made about it.

## Architectural stress

Existing files changed: 2; existing lines changed: 121; new lines: 7175.

`git diff --stat origin/claude/segmentation-brush-tool...ba2d1a2`: 63 files, +7,295 / -1.

Existing files:

- `eslint.config.js` +5/-1 (poc-video scripts get bench globals; unchanged by this pass).
- `pnpm-lock.yaml` +115 (mediabunny, pngjs, playwright for the app; valibot, mask and validation links; packages/video).
- Zero existing package source files changed.

New files:

- `packages/temporal`: +1,466 lines in 15 files, 1,014 of them src. New this pass: `frame-ref.ts`, `keyframe-annotations.ts`, `reconcileFrame`; 20 tests.
- `packages/video`: +805 lines in 13 files, 521 of them src. The frame table and LRU moved here from the app; new are the Demuxer interface, the decode-only `WebCodecsFrameSource` and the mediabunny adapter subpath; 6 tests.
- `apps/poc-video`: +4,904 lines in 33 files, including the keyframe-storage page and `results/representative.json` (2.5 MB, one line).

Boundaries:

- `@osdlabel/video` has no OSD, Fabric or FabricOverlay import. The presenter (one-tile source with the direct-draw hook) lives in the app's `canvas-tile-source.ts`, i.e. frame-osd territory.
- Keyframes-as-annotations ran entirely through the existing osdlabel serialize / deserialize, `createAnnotationFromGeometry` and `createMaskAnnotation`, unmodified. The one gap (deserialize strips extension fields) is bridged in app code with a second Valibot pass.

The fix pass commits are b0938d1, 8acef3a, 6cc57c5, b74c93a and ba2d1a2, all fast-forward on top of 57263bd.

## Reproduce

```sh
pnpm --filter @osdlabel/poc-video bench (= node apps/poc-video/scripts/bench.mjs). Steps:
1. Builds the workspace deps with turbo.
2. Generates media/ with ffmpeg and numpy on the first run (12 H1 videos plus the 1080p60 H2 source).
3. Serves the pages with cross-origin-isolated Vite on http://localhost:5420 (no file watching, no HMR).
4. Runs H1 (element policies, WebCodecs, VideoSampleSink, paused playback), H2 (10 combos x 3 motions x 3 reps) and H3 (Node cost, axis writer study, keyframe storage, scrub harness) in /opt/pw-browsers/chromium.
5. Writes apps/poc-video/results/run-<stamp>.json.

A full run took about 2 h on this host. Flags: --only h1,h2,h3, --n 40, --pauses 40, --h2-seconds 6, --h2-reps 3, --h2-video, --h2-combos, --h2-motions, --h1-from <run.json>, --chromium <path>, --headed, --no-build.

The committed representative.json was assembled from three runs:
- `bench.mjs --only h1 --n 40 --pauses 40`
- `bench.mjs --only h2 --no-build`
- `bench.mjs --only h3 --h1-from results/run-<h1>.json`

then `node apps/poc-video/scripts/representative.mjs results/run-<h1>.json --h2 results/run-<h2>.json --h3 results/run-<h3>.json`. `node apps/poc-video/scripts/tables.mjs results/representative.json` prints Markdown tables; a copy is at /tmp/claude-0/-home-user-osdlabel/d2340e79-db4e-595c-a199-55b42694fb93/scratchpad/video-fix/tables.md.
```

## Caveats

- Shared 4-core host, other agents running. Load average (1-minute):
- H1 run: 1.9 at start, about 9 at peak (18:47), 2.4 at end.
- H2 run: per-cell load1 median 2.5-4.8; 3 reps as the outer loop.
- H3 run: 3.3.
  Accuracy results (exact or not, frame lock) do not depend on load; latencies and fps do. A quiet-machine rerun is still needed for final timing numbers.
- All rendering is headless Chromium 153 with SwiftShader WebGL and software 2D canvas, with no GPU. The fps ranking between osd-direct and the canvas layer is within ~10% and may change on a GPU. WebGL numbers are CPU-emulated and pessimistic.
- The paused-currentTime result (shown frame ahead of currentTime in 60% of pauses) was measured in headless Chromium 153. Other browsers and headed compositors may choose frames differently. The contract (store the start pts) does not depend on it.
- The browser writers in the axis study come from the H1 run, fed in with --h1-from. The axis study uses a mediabunny Node demux as the reader axis; a reader with another demuxer (rounding instead of truncating) is covered by the 'start µs round' writer.
- Synthetic videos only: barcode bands, closed GOPs, 300 frames (600 for the 60 fps source), 6-12 Mbit/s. Open GOP, edit lists, fragmented MP4, long files and real footage were not tested.
- The VFR case is one pattern (durations 1/30, 1/60, 1/20 s).
- Frame lock is sampled from 8-12 screenshots per rep (24-36 per cell), not a per-frame census.
- Keyframe storage was measured with 50 mask tracks of 64x64 discs. Larger masks shift both formats equally; the Fabric payload difference is per vector keyframe.
- The H3 run (b74c93a) had one uncommitted file, packages/temporal/src/materialize.ts. It was a doc-comment change, committed in ba2d1a2, so no measured code changed. The H1 run (8acef3a) and the H2 run (b74c93a) were clean; gitDirty is now recorded per run.
- Node costs (H3) are single-threaded Node 22, not the browser main thread.
- The decoration cost is measured at 50 tracks / 100 elements. 1,000 rendered tracks were not measured.

## Open questions

- On a real GPU (desktop Chrome, headed: bench --chromium <Chrome> --headed --only h2):
- Does osd-direct reach 1080p60 with headroom?
- Does the canvas-layer margin stay within ~10%?
- Does the WebGL drawer become competitive?
- How should DOM decorations behave during playback, given they cost 6-7 ms per frame at 50 tracks? Options include a 10-15 Hz update, hiding, or simplifying them. Throttling was not tested.
- Should decoding move to a Worker (VideoDecoder plus transferable VideoFrames)? The main thread was 96-100% busy and the WebCodecs players fell 35-158 frames behind at 1080p60.
- Should osdlabel's deserialize take an extension-fields schema, or should @osdlabel/validation export an extensible OsdAnnotationSchema factory? Either one lets keyframe fields avoid the second validation pass.
- How should constraints (ToolConstraint counts) treat keyframe annotations: count tracks, count keyframes on the current frame, or both?
- Can the per-keyframe Fabric payload (901 B) be slimmed for keyframes, for example by deriving it from geometry on load, without breaking the existing rawAnnotationData contract?
- Firefox and Safari: WebCodecs codec coverage, rVFC behaviour, and how far the paused currentTime sits from the shown frame.
- For long or large files: lazy, indexed demux (packet retrieval by timestamp) instead of the whole-file read, and the frame LRU budget at 1080p and 4K.
- Does the OSD direct-draw hook survive OSD 6's drawer changes, or does OSD need a public 'tile content changed / external image' API?
- Should a single-frame annotation on a frame axis be a one-keyframe track (afterLast 'end'), so there is one per-frame model?

## How the review was addressed

- B1 (stored time; nearestFrame was writer-dependent): accepted and fixed.
- Contract: @osdlabel/temporal now defines `FrameRef.timeUs` as the frame's START pts in integer µs (`frameRefOf` writes `Math.round(start)`).
- New lookup: `reconcileFrame(axis, t)` = frameAt(t + min(1 ms, extent/4)), with `resolveFrameRef` on top. nearestFrame is kept only as a documented named alternative.
- Unit tests: 4 new (reconcile, FrameRef, grouping x2).
- The axis study was rewritten (scripts/axis-study.mjs). Reader axis is a real mediabunny demux in Node. Writers: 9 synthetic (start µs round/trunc, start s float, start ms round/trunc, nominal i/fps, table-mid s, in-span s, in-span ms) plus 4 recorded in Chromium (element currentTime after seek, rVFC mediaTime after seek, paused currentTime, paused rVFC mediaTime), over CFR 30, 29.97, 60 and VFR.
- Wrong counts (at-or-before / nearest / reconcile):
  - Frame-start writers: reconcile 0 everywhere; at-or-before up to 2,280/4,200; nearest 0.
  - table-mid: 0 / 3,211 / 0.
  - in-span s: 0 / 2,254 / 190.
  - browser mediaTime after seek: 131 / 0 / 0 of 6,240.
  - paused mediaTime: 9 / 1 / 1 of 480.
  - currentTime writers: every rule fails (paused 288 / 161 / 282 of 480).
- The H3-axis verdict is now stated per writer, and the summary no longer claims 'nearestFrame 0 for every writer'.
- B2 (rVFC harness artifact): accepted and fixed.
- seekOp now requests rVFC before the seek but starts the 250 ms window at 'seeked'. It also records the callback time relative to 'seeked', currentTime and mediaTime.
- Rerun of every H1 element cell (12 videos x 13 cells x 40 ops):
  - rVFC fired 6,240/6,240, and mediaTime matched the on-screen barcode 6,240/6,240.
  - The callback ran p50 16.5 ms before 'seeked'; only 87 ran after, at most 69 ms. So the earlier 4,313/6,240 was the timer.
  - table-mid: 1,440/1,440 exact after presentation, and 1,439/1,440 when read at 'seeked', which matches the reviewer's 1,439.
- The rVFC argument is removed from the rejected alternative. That entry now rests on naive-target accuracy, step latency and frame lock.
- B3 (render-path decision not supported): accepted. The recommendation is withdrawn and replaced with a discriminating measurement.
- H2 re-run with a 60 fps 1080p source (h264-1080p-60-g60-bf), 3 reps per cell and a fast-pan motion (1,482-2,410 px/s at the shot).
- New host osd-direct: OSD's canvas drawer draws the VideoFrame or `<video>` directly through a stand-in tile context, which is the reviewer's duck-typed-context alternative. Frame lock is reported per host for play, pan/zoom and fast pan.
- Frame lock: every OSD host and css/webcodecs were 100% locked; css/video 8-25%.
- osd-direct/webcodecs 34.4/34.5/35.3 fps against the canvas layer at 38.0/35.5/36.6: about 10% static, overlapping ranges under motion. osd-canvas with the tile copy managed 24.3-24.8.
- Conclusion: OSD with direct draw is the recommended host, and VideoLayer is removed from the package plan and the effort estimate.
- @osdlabel/video is now decode-only with no FabricOverlay, OSD or Fabric dependency. The presenter belongs to frame-osd.
- A real GPU was not available (headless SwiftShader), so the margin is stated as CPU-only and listed as an open question.
- The decorations A/B was repeated on cells near the top of the range. Decorations cost 6-7 ms per frame, so H2-decorations is now refuted rather than confirmed.

## Independent review

A second agent re-ran the benchmark and tried to break the conclusions.

### Blocking findings

- **The nearestFrame recommendation and the H3-axis 'refuted' verdict hold only for one storage convention. The axis study tested writers that store a frame's start time plus noise (index/fps, ms-rounded pts, exact pts). It never tested writers that store a time inside the frame's span, which is what an app saving video.currentTime, or the PoC's own recommended table-midpoint seek target, would write. For those writers nearestFrame is far worse than at-or-before.**
  - Evidence: I extended the study (/tmp/claude-0/-home-user-osdlabel/d2340e79-db4e-595c-a199-55b42694fb93/scratchpad/axis-writers.mjs) on the same 12 manifests, 3,600 frames:
- table-mid writer (seconds): at-or-before 0 wrong, nearestFrame 922 wrong (float noise breaks the midpoint tie).
- Paused-currentTime writer, uniform in the frame's span: at-or-before 0, nearest 1,750.
- Same, rounded to ms: at-or-before 41, nearest 1,792.
- At-or-before applied to t + 1 ms: 0 wrong for index/fps, ms, exact and table-mid; 98-137 (~3%) for the uniform in-span writers.
  Two more points. The '6-9 of 300 after a plain float round trip' comes from converting µs → s → µs against ffprobe's fractional-µs axis; the frame-axis PoC compares seconds with seconds and would not hit it. And the PoC's own proposal (integer timeUs on both sides) removes that round trip. - Required fix: Define FrameRef.timeUs in the contract as the frame's start presentation timestamp in integer µs. Add in-span and midpoint writers to axis-study.mjs. Then pick the reconcile lookup from the full writer matrix. At-or-before with a small tolerance, min(1 ms, a quarter frame), dominated nearestFrame above. Reword finding 1 and the H3-axis verdict as writer-dependent instead of 'nearestFrame: 0 for every writer'.
- **The rVFC numbers (fired in 4,313 of 6,240 seeks; 'no callback when the seek re-presents the same frame'), and the 'rVFC did not fire for 31% of seeks' reason under rejected alternatives, are a harness artifact. seekOp starts the 250 ms cancel timer before setting currentTime, so any seek slower than about 250 ms is cancelled before its frame can be presented. In those cases the barcode is also read at 'seeked', not after presentation.**
  - Evidence: apps/poc-video/src/seek-page.ts seekOp: requestVideoFrameCallback plus setTimeout(…, 250) are armed before `video.currentTime = t`.
- representative.json: all 1,927 misses had msSeeked ≥ 240 ms. None is a fast seek that re-presented the same frame.
- The rVFC fire rate is 0% on every forward and backward GOP-250 cell. On 720p GOP-30, increment@boundary re-presents the previous frame in 38 of 40 ops, and rVFC fired in 100%.
- My rerun: 1,846 of 1,846 misses had msSeeked ≥ 240 ms.
- My rerun also had one table-mid miss: vp9-720p-2997-g250, target 135, got 134 after a 1,916 ms seek, read at 'seeked' with no rVFC. So '1440/1440' reproduced as 1439/1440, possibly because of the same read-timing artifact.
  - Required fix: Arm the rVFC timeout after 'seeked', or measure it relative to 'seeked'. Re-run the H1 video-element cells and restate the rVFC rate and the table-mid exactness. Drop the rVFC argument from the rejected alternative unless it survives the rerun.
- **The H2 render-path decision is not supported by the data: 'for 1080p playback the video pixels should go to a WebCodecs-fed canvas under the overlay', which puts VideoLayer and its effort into @osdlabel/video. The two WebCodecs hosts differ by 26 vs 30 fps in one 6 s run per cell, on software raster. The source is 30 fps, so content fps cannot exceed 30 and headroom is not measured. Most of the cost is software I420→RGB conversion plus a second 1080p CPU blit, neither of which exists on a GPU.** - Evidence: representative.json H2: osd-canvas/webcodecs 26.08/26.06 fps, handler 16.7 ms; css/webcodecs 30.04/30.01, handler 14.5 ms; both 85-100% main-thread busy; one 6 s cell each.
  My rerun (load 5-10):
- osd-canvas/webcodecs 22.67 / 22.44 fps.
- css/webcodecs 29.97 static but 19.55 panzoom.
  So the ordering flipped in the panzoom cell. osd-canvas/video was 24.8-26.4, css/video 29.7, osd-webgl 2.2-4.9. The PoC's own h2Replaced block (loaded host) shows the same instability: 13-21 fps on every path. - Required fix: Mark the render-path choice provisional and keep VideoLayer out of the package plan and effort estimate until H2 is re-run:
- on a real GPU (headed),
- with a 60 fps source or playbackRate ≥ 2, so headroom is visible,
- with at least 3 reps per cell.
  Until then, state that the OSD one-tile path and a canvas layer are both viable, and that frame-lock (not fps) is the only environment-independent discriminator found: css/video lags; every other path is locked.

### Non-blocking findings

- The one-command bench fails on a clean checkout. bench.mjs statically imports temporal-bench.mjs and axis-study.mjs, which import @osdlabel/temporal's dist before main() runs the turbo build, so the run ends with ERR_MODULE_NOT_FOUND. It worked after `pnpm exec turbo run build --filter=@osdlabel/poc-video^...`. Fix: import those modules dynamically after the build step.
- H1-latency 'WebCodecs is also faster for back-stepping: confirmed' is overstated. Without the LRU, backward steps and random seeks are GOP-bound and roughly equal; sometimes the element wins. In representative.json, vp9-720p-2997-g250 backward was 1731 ms (WebCodecs) vs 1197 ms (element, table-mid), and av1 random 171 vs 146 ms. In my rerun, vp9 g250 random was 750 vs 442 ms. The real advantage is that one decode from the keyframe fills the cache with every intermediate frame, which the element cannot do. Say that instead.
- H2-decorations 'confirmed' rests mostly on the per-frame timers. The on/off A/B ran on the osd-webgl/webcodecs cell, which is starved at 5 fps, so it cannot show a 2.4 ms cost. In my rerun deco-off was slower (2.2/2.3 vs 3.2/3.8 fps) because of host load. decoMs also excludes the style and layout cost of the DOM writes. And the claim covers 50 tracks / 100 elements only: extrapolating 4-5 ms per 50 tracks to 1,000 tracks gives ~80-100 ms per frame. Scope the claim, and repeat the A/B on a cell near 30 fps (css/webcodecs or osd-canvas/video).
- H3 '17/17 checks' includes two rows hard-coded `pass: true` (scrub latency, update counters), so 15 checks are substantive.
- '|object - lerp| 0.000 px' compares getGeometryFromFabricObject(obj), which reads left/top straight back, against the same lerp, so it is property-level and close to tautological. The same harness paints those rectangles 101-111 px away from their geometry (rect-origin bug).
- The frame-40 drag (300,275)→(700,375) grabbed the painted box at its bottom-right corner, not its centre. It moved, by luck.
- H3-caching argues against a claim the frame-axis PoC did not make. Its REPORT.md turns caching off as a speed choice (rebuild beats cache: 29.2 vs 20.2 slices/s at 50 per slice), which this PoC's own evidence concedes. The 0.40 px pixel check also covers only zoom 1 and 2.5 with no rotation or flip. CLAUDE.md flags rotation as the case that breaks Fabric object caching.
- The sync test has little power: marker speed in the pan/zoom cells is about 76-99 px/s, so a one-frame positional lag is only about 3 px. There are 6 or 12 screenshots per cell. Add a fast-pan cell (≥1000 px/s).
- Architecture: in the API sketch, VideoLayer's constructor takes a FabricOverlay. That makes @osdlabel/video depend on @osdlabel/fabric-osd (and through it fabric and openseadragon). It contradicts 'video is a leaf with the single third-party dependency (mediabunny)' and puts decoding and compositing in one package. A pixel layer under the overlay is a generic compositing concern, useful for cine too, so it belongs in fabric-osd or frame-osd, typed against a structural overlay interface.
- 'Composes with the annotation model and serialization' is only partly shown. The harness bypasses AnnotationState, the reducers, serialize/deserialize and Valibot validation by wiring RectangleTool callbacks straight into tracks. TrackDocument has no schema and no versioned payload contract, and its 3.66 MB size excludes mask payloads (the bench keyframes carry none).
- Provenance:
- Both runs record gitHead 935bdf2, but the measured code had uncommitted edits. I checked 935bdf2..57263bd: the changes are instrumentation only (loadavg capture, representative/tables scripts).
- The main run's metadata has no load average, so 'load 11-21 during the replaced H2 cells' is not in the committed data.
- The rerun's H1 latencies (at host load 4-11) also differ from the committed ones by ±10-70% in places. Accuracy (exact or not) is stable apart from the one table-mid miss.
- Minor model points:
- Rectangles interpolate the top-left origin and rotation independently, so the centre of a rotating box follows a curve. Rotation is not normalised (350→10 gives 360 at the midpoint).
- Unequal-count polygons pass through up to n_a + n_b vertices (36 for 12→24), forcing a Fabric rebuild every in-between frame.
- Open-GOP, MP4 edit lists other than ffmpeg's default B-frame offset, fragmented MP4 and long files are untested (partly in caveats).
- The bundle uses mediabunny ALL_FORMATS (334 kB min / 89 kB gzip, reproduced). Restricting it to the MP4 and WebM inputs would shrink it.
- Repo conventions: packages/temporal has a typedoc.json but no entry in apps/docs/typedoc.config.mjs or the deploy-docs paths. It is private, so this is acceptable for a PoC but needed if it is productised. Lint, typecheck and unit tests pass for packages/temporal and apps/poc-video.

### Claims checked

| Claim                                                                                                                                             | Verdict    | Note                                                                                                                                                                                                                                             |
| ------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| WebCodecs (mediabunny demux, decode from the preceding key) exact on 1,920/1,920 operations across 12 videos and 4 access patterns                | holds      | Reproduced 1920/1920. Exactness is read from barcodes burned into the decoded pixels, so it is not circular. Covers only synthetic closed-GOP streams.                                                                                           |
| Video element boundary i/fps 62.1% (worst 30% at 29.97); nominal mid 97.1% (VFR 65%); increment-from-boundary 23.5%/22.7%                         | holds      | Rerun gave identical counts (298/296/307 boundary; 113/108 increment@boundary).                                                                                                                                                                  |
| Seeking the element to the demuxed table midpoint is exact, 1,440/1,440                                                                           | overstated | Rerun: 1439/1440. vp9-720p-2997-g250 frame 135 came back as 134 after a 1.9 s seek, read at 'seeked' because of the rVFC timer artifact.                                                                                                         |
| rVFC fired in 4,313/6,240 seeks because there is no callback when a seek re-presents the same frame; used to reject the element                   | wrong      | The 250 ms cancel timer is armed before the seek starts. Every miss (1,927 committed, 1,846 in the rerun) had msSeeked ≥ 240 ms. rVFC fired 100% on cells that re-present the same frame.                                                        |
| Forward one-frame step: WebCodecs p50 0.5-9.5 ms vs element 18-1081 ms                                                                            | holds      | Rerun: WebCodecs 0.5-4.4 ms vs element increment@mid 26-1436 ms.                                                                                                                                                                                 |
| WebCodecs is also faster for back-stepping and random seeks (H1-latency confirmed)                                                                | overstated | Without the cache the two are roughly equal and GOP-bound. On vp9 GOP-250 and on AV1 random the element was faster. The win comes from the WebCodecs-filled LRU.                                                                                 |
| OSD canvas drawer plus video element reaches 28.9-29.9 fps at 1080p; WebCodecs into OSD 26 fps; WebGL drawer 5-7 fps; css host 30 fps             | overstated | Directionally reproduced under load 5-10: 24.8-26.4, 22.4-22.7, 2.2-4.9 and 19.6-30. The ordering of the two WebCodecs hosts flipped in the panzoom cell. The 30 fps source caps the metric, and everything is software raster.                  |
| Overlay frame-locked on every OSD path (18/18); css/video one frame behind in 11/18; css/WebCodecs locked                                         | holds      | Rerun: OSD paths 0 delta in every screenshot; css/video behind in 14/18 (one at -2); css/webcodecs 0 delta.                                                                                                                                      |
| Overlay within 1 px of the video during continuous pan and zoom                                                                                   | holds      | Reproduced (≤1 px), but marker speed is only about 80-100 px/s, so the test detects only a ≥3 px lag.                                                                                                                                            |
| SwiftShader / CPU-only numbers are labelled as such, not as GPU performance                                                                       | holds      | WebGL is labelled CPU-emulated throughout, and the cpuGpu column is described as SwiftShader.                                                                                                                                                    |
| DOM decorations and the Fabric overlay are not the bottleneck (H2-decorations confirmed)                                                          | overstated | The per-frame timers (Fabric about 2 ms, decorations about 2.5 ms at 50 tracks) support it. The on/off A/B ran on a starved 5 fps cell, and 1,000-track rendering cost was not measured.                                                         |
| Temporal cost for 1,000 tracks: 0.20 / 0.53 / 1.27 ms warm p50; cold spike up to 109 ms from lazy correspondences                                 | holds      | Rerun: 0.18 / 0.48 / 1.49 ms; cold max 52.7 / 95.9 ms. Single-threaded Node, interpolation only.                                                                                                                                                 |
| Naive index polygon interpolation collapses (area 0.498 shifted, 0 redrawn) vs aligned 1.000                                                      | holds      | Deterministic and reproduced exactly.                                                                                                                                                                                                            |
| At-or-before reconciliation re-attaches 85/699/1,022 of 3,600 frames; nearestFrame 0 for every writer                                             | overstated | The numbers reproduce, but they depend on the writer. For the PoC's own table-midpoint writer nearestFrame gets 922/3600 wrong, and about 1,750 for in-span currentTime writers, where at-or-before gets 0.                                      |
| The stock RectangleTool and buildFabricObjectFromGeometry paint centred on the stored top-left corner under Fabric 7.4.0's center origin          | holds      | Verified independently. fabricObjectDefaultValues has originX/originY 'center'. buildFabricObjectFromGeometry with origin (200,200), 200x150 gives getBoundingRect (99.5,124.5)-(300.5,275.5). The harness check fails as reported (101-111 px). |
| Fabric object caching need not be off for correctness (painted within 0.40 px)                                                                    | overstated | Reproduced 0.40 px, at zoom 1 and 2.5 only, with no rotation or flip. The frame-axis PoC never claimed caching was a correctness issue.                                                                                                          |
| H3 harness passed 17/17 temporal checks; interpolation exact to 0.000 px                                                                          | overstated | Reproduced. Two of the 17 are unconditional passes, and 0.000 px is a property round trip, not a pixel measurement.                                                                                                                              |
| Architecture stress: 45 files, +5245/-1; only eslint.config.js (+5/-1) and pnpm-lock.yaml (+91) existing; 5,149 new lines; temporal 844 src lines | holds      | `git diff --stat origin/claude/segmentation-brush-tool...origin/claude/poc-video` matches exactly. The merge-base is the brush-tool tip.                                                                                                         |
| Frame source bundle 334 kB min / 89 kB gzip                                                                                                       | holds      | A vite build reproduced 333.99 kB / 89.01 kB.                                                                                                                                                                                                    |
| Demuxed pts table within 0-0.667 µs of ffprobe                                                                                                    | holds      | mediabunny rounds to integer µs (0.667 on H.264/AV1, 0 on the VP9 1 ms timebase).                                                                                                                                                                |
| One non-interactive bench command (pnpm --filter @osdlabel/poc-video bench)                                                                       | wrong      | On a fresh checkout it fails with ERR_MODULE_NOT_FOUND before its own build step runs. It works once the dependencies are built.                                                                                                                 |
| The recommendation respects the leaf-package architecture (video is a leaf with mediabunny as its only third-party dependency)                    | overstated | VideoLayer(overlay: FabricOverlay) adds a dependency on fabric-osd and mixes decoding with compositing. frame, temporal and frame-osd are otherwise well separated.                                                                              |

### Reviewer's rerun

I installed and built, then ran `pnpm --filter @osdlabel/poc-video bench` once. The first attempt failed (ERR_MODULE_NOT_FOUND, see non-blocking); the second, after a turbo build, ran the full H1+H2+H3 suite (n=40, H2 6 s per cell, headless Chromium 153, SwiftShader) at host load 4.9 at start and 5-11 during the run. Output: /home/user/osdlabel/.claude/worktrees/wf_3c324346-699-6/apps/poc-video/results/run-2026-10-24T14-23-31-163Z.json (gitignored).

**H1**

- WebCodecs exact 1920/1920.
- Video element: boundary 298/296/307 of 480 (identical to the committed run); table-mid 1439/1440 (one VP9 GOP-250 miss); increment@mid 479 + 480.
- rVFC fired 4394/6240, and every one of the 1,846 misses had a seek ≥ 240 ms (harness artifact).
- Forward step p50: WebCodecs 0.5-4.4 ms vs element 26-1436 ms. Backward and random were mixed.

**H2** (under load)

- osd-canvas/video: 24.8 / 26.4 fps, 100% busy.
- osd-webgl/video: 4.9 / 4.8.
- css/video: 29.8 / 29.7, overlay one frame behind in 14/18 screenshots.
- osd-canvas/webcodecs: 22.7 / 22.4.
- css/webcodecs: 30.0 static / 19.6 panzoom.
- osd-webgl/webcodecs: 3.2-3.8 (deco off 2.2-2.3).
- Spatial sync ≤ 1 px everywhere; OSD paths 0 frame delta.

**H3**

- Node warm p50 0.18 / 0.48 / 1.49 ms; cold max 6 / 53 / 96 ms.
- Area study and axis study identical to the committed run (85/699/1022 vs 0).
- Harness: same 17 passes and 1 fail (rect origin 101-111 px), scrub p50 / p95 / max 8.2 / 178 / 243 ms.

**Separate checks I ran**

- Rect-origin probe of buildFabricObjectFromGeometry: confirmed center origin.
- vite build: bundle sizes reproduced.
- eslint, typecheck and vitest for temporal and poc-video: clean.
- Extended axis study (/tmp/claude-0/-home-user-osdlabel/d2340e79-db4e-595c-a199-55b42694fb93/scratchpad/axis-writers.mjs): nearestFrame gets 922 to 1,792 of 3,600 frames wrong for in-span writers.

**Still needed**

- H1 element cells with the rVFC timeout armed after 'seeked'.
- Axis study with in-span, midpoint and tolerance lookups.
- H2 on a real GPU, headed, with a 60 fps source or playbackRate 2, at least 3 reps per cell, a fast-pan cell, and the deco on/off A/B on a cell near 30 fps.

### Alternatives the reviewer says were missed

- Reconcile with at-or-before plus a small tolerance, frameAt(t + min(1 ms, a quarter frame)), instead of nearestFrame. It got 0 wrong for every start-time writer and for table-mid, and about 3% (vs about 49% for nearest) for paused-currentTime writers. Or store index/key as the authority and timeUs strictly as the frame's start pts.
- mediabunny's own VideoSampleSink / CanvasSink (getSample, the samples() iterator, keyframe-aware seeking) instead of a hand-rolled 221-line WebCodecsFrameSource. Keep only the LRU and index addressing on top.
- Store keyframes as ordinary OsdAnnotations (FrameFields + trackId + visibility) in the existing AnnotationState, with serialize and Valibot validation reused. Tracks become a grouping plus a derived materializer, not a parallel Track entity with its own TrackDocument wire format.
- Avoid the second 1080p blit in the OSD tile path: let the canvas drawer draw the VideoFrame or the video element directly (a duck-typed tile context), or use ImageBitmapRenderingContext.transferFromImageBitmap. Decode in a Worker with OffscreenCanvas. Any of these could close the 26 vs 30 fps gap without a new layer.
- Put the 'pixel layer under the overlay' (VideoLayer) in fabric-osd or frame-osd as a generic frame-source compositor, so @osdlabel/video stays decode-only.
- Measure render-path headroom with a 60 fps source or playbackRate ≥ 2, rather than a 30 fps source that caps content fps at the target.
- For constant-frame-rate content, nominal-mid seeking ((i+0.5)/fps) was exact on every CFR video without any demux; all its misses were on VFR. The rejected-alternatives write-up should say so.
