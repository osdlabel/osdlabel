# Proof of concept: SAM-assisted annotation as a provider contract and a tool

Branch `claude/poc-sam`, head `9f7afef10f` at the time of the result. Part of the osdlabel roadmap study (branch `claude/osdlabel-roadmap-strategy-uut5ay`). Written by the orchestrating agent from the PoC agent's structured result, because PoC agents in this environment cannot write report files.

**Status:** Build, independent review and fix pass complete. The fix pass made refinement after pan or zoom work (encode the view plus the prompt, resample the previous mask), adopted MatMul-only int8 for the encoder on quality grounds, measured responsiveness while tiles load (a worker bounds frame gaps; the WebGL drawer on a software GPU was the main cause of the earlier starvation), gated WebGPU, and split the worker and remote clients into their own packages. Timings come from a loaded 4-core machine; a quiet-machine rerun is pending.

## Summary

This is the review-fix pass for the SAM PoC, built on PR #149 (claude/segmentation-brush-tool). First I checked the interrupted WIP commit 3ff8b2b: it builds, typechecks and passes its tests. All three blocking findings are closed. Since the review: 6 commits, all pushed. No existing package changed in this pass; vs #149 the existing-package diff is still 14 files, +38/-5.

Seven private leaf packages:

- mask-contour, region-reader
- segmentation: contract, encode plan, embedding cache, mask/polygon conversion
- segmentation-onnx: SAM graph adapters plus a WebGPU gate
- segmentation-worker (new): worker RPC
- segmentation-remote (new): client adapters only. osdlabel ships no server, and the float16 wire format is optional.
- segmentation-fabric: the tool

Main results (MobileSAM, synthetic 100k x 80k DZI):

1. Refinement after a zoom works. The encode now covers the viewport plus the prompt's points and earlier mask, and the previous mask is resampled onto the new grid. Click, zoom 4x, click: one re-encode, then a cache hit. In the browser, the second mask against the first: IoU 0.992, centroid shift 4.7 px; ground-truth IoU 0.984.
2. int8. MatMul-only dynamic int8 is the browser candidate: encoder 20% faster on WASM at one thread, 2x smaller, masks IoU 0.973-0.998 against fp32. Dynamic int8 over all ops and static QDQ are rejected for quality, not speed. The int8 low-res decoder is 20% faster and 3.5x smaller, but flips the best candidate on 1 of 9 steps.
3. Worker vs main thread. A worker keeps frame gaps at or below 233 ms during cold encodes; the main thread freezes 5.4-7.4 s. Most of the earlier "starvation while tiles load" came from OSD's WebGL drawer running on SwiftShader. With no inference at all, panning ran at 3-4 fps with that drawer and 43 fps with Canvas 2D. Default numThreads to half the cores: 2 threads encoded as fast as 4 here and cost fewer frames.
4. The WebGPU gate rejects this sandbox's SwiftShader adapter, so WebGPU is never chosen here. Real-GPU WebGPU is still unmeasured.

Wall times in this run are about 2x the first run's: different host CPU string, load average 1.7-9.5, and another agent's browser benchmark running. Treat absolute numbers as order of magnitude and comparisons within this run as the evidence.

## Hypotheses and verdicts

### H1a: refuted

The SAM prompt decoder is interactive (<50 ms) on CPU WASM (onnxruntime-web, SIMD, threads via SharedArrayBuffer).

Final run, Chromium 153 headless, 4-core VM, load1 1.7-9.5.

- MobileSAM low-res decoder, one click, median of 20 (min): WASM t=1 401.6 (301.1) ms, t=4 311.3 (162.8) ms.
- int8 suite, median over 3 interleaved rounds [range]: WASM t=1 355.6 [342-375] ms, t=4 358 [133-445] ms.
- Native onnxruntime-node t=1: 105-127 ms.
- The first run measured 137-234 ms on WASM.
  Either way it is well above 50 ms. Thread scaling of the WASM decoder (t=4 vs t=1) was 1.0-2.7x across runs depending on load, so the earlier '1.25x' is withdrawn as not reproducible. The '3.8x WebGPU speedup -> 45-55 ms' estimate applied an RTX 3060 ratio to this CPU's WASM time; it is speculation, not a measurement.

### H1b: confirmed

The SAM ViT-B image encoder costs seconds in the browser.

ViT-B, random weights, 1024 px input.

- WASM t=1: 69,329 ms (n=1; CPU 69,410 ms). The bench now takes one timed encode when the first exceeds 10 s, so this case fits the 240 s timeout; it timed out in the review's rerun.
- WASM t=4: 36,491 ms (n=1).
- Native: t=1 18,146 ms, t=4 6,542 ms.
- First run: WASM t=1 41.4 s, t=4 15.6 s.
  Server-only.

### H1c: partial

Light encoders (MobileSAM, EfficientSAM-Ti, SAM 2-tiny, EdgeSAM, LiteMedSAM) have acceptable encode latency on CPU WASM.

Final run, WASM t=1 / t=4 wall median (n=3 unless noted; load 1.8-8.4):

- EdgeSAM (random weights): 4,032 / 4,379 (min 2,055) ms.
- MobileSAM: 8,933 / 3,187 ms.
- LiteMedSAM (random weights): 7,971 / 2,775 ms.
- EfficientSAM-Ti: 16,351 / 12,100 ms (n=1).
- SAM 2 Hiera-T, real weights: 21,719 (n=1) / 7,300 ms.

First run: MobileSAM 4.4 s / 2.0 s.

In the e2e worker run (4 threads, Canvas 2D drawer), a cold MobileSAM click painted in 6.0-6.8 s; the very first click took 9.2 s. With prepare() on settle, the click after it painted in 314 ms (prepare took 5.5 s).

Acceptable only if encodes overlap the user's think-time: MobileSAM and EdgeSAM (EdgeSAM's license is non-commercial). EfficientSAM-Ti and SAM 2-T are not acceptable on CPU WASM. WASM/native CPU ratio at t=1 was 2.6-4.6x.

### H1d: untested

WebGPU makes in-browser encoding/decoding interactive.

The only adapter here is SwiftShader: {vendor: google, architecture: swiftshader, isFallbackAdapter: true}. The new gate (segmentation-onnx chooseExecutionProvider) rejected it (reason 'fallback-adapter'), so the default bench no longer runs WebGPU cases. The first run's SwiftShader bound stands (MobileSAM first encode 219 s, EdgeSAM 77.5 s). Real-GPU latency must come from desktop Chrome (--chromium <path> --headed).

### H2: confirmed

On deep-zoom images, encoding a viewport crop read from the tile pyramid at model resolution, with an embedding cache and re-encode on pan/zoom beyond a margin, gives correct image-space masks and interactive follow-up clicks, including refinement clicks after a pan or zoom.

Synthetic 100,000x80,000 DZI, MobileSAM, worker with 4 threads, Canvas 2D drawer. The review was right that refinement was broken (4 encodes for 4 clicks, the earlier point outside every encode). Now:

- The plan encodes viewport union prompt extent (points, box, previous foreground) plus margin. reencodeGain stops re-encoding when a fresh encode would not be 1.5x finer. mask_input is resampled onto the new embedding's grid.
- The review's own probe, rerun on the fixed dist: 2 encodes for 4 clicks, every point inside the encoded region.
- Browser R1-R3 (R1 click on the gland's top rim, R2 zoom 4x onto the bottom rim so R1's point leaves the view, R3 a third point on the same view):
  - R1: cache hit, 485 ms.
  - R2: one re-encode (expected MISS: ok), 6,473 ms; 2-point prompt inside the encoded region; mask_input fed. Best mask vs R1's: IoU 0.992, centroid shift 4.7 px (R1 cell 58.6 px, R2 cell 16.5 px). Ground-truth IoU 0.984.
  - R3: cache hit, 335 ms. IoU vs R2 0.997, shift 1.9 px. Ground-truth IoU 0.982.
- Counterfactuals on the same R2 (onnxruntime-web WASM kernels in Node):
  - Copying the previous logits cell for cell (the old code): IoU 0.079 with the previous mask, shifted 556 px. Resampled: 1.000, 0.0 px.
  - Dropping mask_input instead: top-ranked mask's ground-truth IoU 0.271 (vs 0.984).
- Other steps: cache hits S2 582 / S3 245 / S6 391 / S8 314 ms. Re-encodes where expected (S4 pan 70%, S5 zoom 4x, S7 1:1). Ground-truth IoU 0.84 / 0.88 / 0.98 on glands, 0.88 on the nucleus, 0.52 vs 0.99 on the gland-or-lumen ambiguity (S5, S8). The coordinate pipeline is deterministic: the same IoUs as the first run and the review's rerun.

### H3a: partial

SAM output should become a #149 mask annotation (canonical RLE) by default, with polygon conversion as an option.

Committed objects with mask boxes of 2.9-10 Mpx:

- Logit raster to full-res snapshot: 37-187 ms.
- Canonical RLE: 7.8-14.7 KB.
- Fabric render object: 74-189 ms.
- Nucleus: 0.2 ms, 48 B.
- Polygon trace + simplify: 3.4-12 ms for 8-92 vertices; polygon vs mask IoU 0.977-0.998 (0.92 on the nucleus).

At overview zoom the S1 mask box is 2,273,163,669 px. That is 33.9x #149's 67,108,864 px cap (the earlier '35x' was wrong); S4 is 1.0 Gpx. Both fall back to a polygon of the largest ring: 114 vertices, 14 extra rings and 4 holes dropped.

#149 needs multi-resolution masks, or a polygon-with-holes / multipolygon geometry. Refining at commit by re-encoding a finer crop around the object's box is a third option. None of the three was built.

### H3b: partial

One provider contract (box + positive/negative points, multi-mask with predicted IoU/stability) covers worker-hosted, server-encode/browser-decode and all-server backends, and existing services can be wrapped without osdlabel shipping a server.

2D: the three topologies run through the same SegmentationProvider and SegmentationTool. The server is onnxruntime-node t=4 inside the Vite process on the same box, with no network, at load 6.3-7.4.

- Remote-encoder: cold 2,918-3,735 ms (server encode 2,209-2,583 ms, round trip 2,511-2,838 ms, 2,097,412 B float16 embedding); cache hit 488 ms.
- Remote-all: cold 2,698-2,840 ms; hit 318 ms (329 KB response).
- These are 3-4x the first run's 0.76-0.87 s because the server shares a loaded CPU. On a real link, 2 MiB adds about 0.34 s at 50 Mbit/s and SAM 2's 8 MiB about 1.3 s (arithmetic, not measured).

New: @osdlabel/segmentation-remote's SegmentationServiceAdapter<TSession> {capabilities, open, infer, close?} plus createServiceSegmentationProvider. Tested with a fake stateful service only. The MONAI Label and nnInteractive mappings in its doc comment come from their sources (POST /infer/{model}?image=&output=; nninteractive-server's /claim, /release and bbox-only blosc2 results), not from live servers.

3D/video still needs the drafted SegmentationSession.

### H4: partial

Hosting inference in a worker keeps the viewer responsive during cold encodes, including while OSD still loads tiles or the user pans; main-thread inference does not.

Responsiveness suite: MobileSAM, cold encode per click on fresh views; 3 reps per cell, median [range]; 'pan' is a scripted continuous pan of 8 px per frame. All with the Canvas 2D drawer.

Worker, by numThreads. Each row is: encode with tiles settled / fps with tiles settled / fps while tiles load / fps while panning (worst frame gap).

- t=1: 7,695 [7,662-8,113] ms / 60 / 50 [49-51] / 29 [27-30] (102 ms).
- t=2: 4,555 [4,401-4,622] ms / 60 / 45 [39-46] / 26 [23-27] (133 ms).
- t=3: 5,333 [4,927-5,540] ms / 60 / 36 [25-38] / 20 [19-21] (200 ms).
- t=4: 5,468 [4,577-5,815] ms / 59 / 31 [30-31] / 17 [17-19] (183 ms).
- Pan with no inference: 37-44 fps median (24-50 range).
- 'Loading' windows loaded 110-115 tiles; 'settled' windows loaded none.

Main thread, t=4: 1-2 fps, max frame gap 6.2-7.1 s, and the pan got 10 frames per encode.

WebGL drawer (OSD's default), which runs on SwiftShader here:

- Pan with no inference: 3-4 fps and about 4.5 s of long tasks in 4.9 s.
- Tiles never settled within 10 s.
- Worker: 2-4 fps, gaps 0.4-1.2 s, encodes 9.8-13.4 s.
- Main thread: 1 fps, gaps 6.7-7.4 s.

So the review was right that '59-60 fps through a cold encode' held only once tiles had settled. But the attribution changes: most of the earlier starvation was the SwiftShader WebGL drawer, not inference and not load 15-22. Stated relatively: the worker bounds frame gaps at or below 233 ms against 5.4-7.4 s on the main thread, and costs 10-26 fps while tiles load or the user pans, more with more threads.

### H4b: refuted

numThreads <= hardwareConcurrency-1 is the right default for a worker-hosted encoder.

On this 4-core VM, t=2 encoded as fast as or faster than t=3 and t=4 (4.6 vs 5.3 / 5.5 s medians, settled). It also kept more frames while tiles loaded (45 vs 36 / 31 fps) and while panning (26 vs 20 / 17 fps). t=1 was 1.7x slower to encode for only +3-5 fps. Default numThreads = clamp(floor(hardwareConcurrency / 2), 1, 4). This is load-sensitive (another agent used about 1 core) and validated on 4 cores only.

### H5: confirmed

Shipping embeddings as float16 halves transfer without changing masks.

The server re-decoded the S1, S2, S5 and S7 views with float32 and float16-rounded embeddings: mask IoU 1.0000 for all 16 candidates, max |logit diff| 0.0025-0.082. Wire size 2,097,412 B vs 4 MiB float32. The float16 format is now optional, in @osdlabel/segmentation-remote.

### H6: partial

Random-weight exports are a valid latency proxy for real models.

Native, this run: SAM 2.1 Hiera-T own random-weight export vs the production real-weight export, encode t=1 5,317 vs 6,240 ms and t=4 1,911 vs 2,146 ms (within about 15%). First run: 10-27%. Our export still fails in onnxruntime-web 1.30 ('ShapeInferenceError: Can't merge shape info'). Latency-only rows (EdgeSAM, LiteMedSAM, ViT-B) are indicative to about 30%; browser compatibility needs real exports.

### H7: partial

int8 quantisation is a browser win for the MobileSAM encoder and the SAM decoder (speed, size) without hurting masks.

Like for like:

- Same noise input and the same thread counts.
- Encoder variants all use the fp32 low-res decoder; decoder variants use the fp32 encoder and compare low-res with low-res and full with full.
- 3 rounds, interleaved, with the order rotated each round.

WASM t=1 encoder, median [range over rounds]:

- fp32: 8,029 [7,972-8,073] ms.
- Dynamic int8, all default ops including ConvInteger: 6,758 [6,138-6,866] ms (-16%).
- MatMul-only dynamic int8: 6,436 [6,316-6,506] ms (-20%).
- Static QDQ: 7,880 [7,439-7,989] ms (-2%).

WASM t=4: ranges overlap at load 3.4-8 (fp32 5,348 [5,139-5,781], all-ops int8 5,266 [4,805-7,214], MatMul-only 5,778 [4,215-7,612], QDQ 5,371 [3,211-11,680]), so not resolvable here.

Native (median of 3 rounds) t=1 / t=4: all-ops int8 +26% / +42% (slower), MatMul-only -14% / -18%, QDQ +1% / -4%.

Decoders, WASM t=1:

- Low-res: fp32 355.6 [342-375] ms vs int8 285.8 [264-289] ms (-20%).
- Full: fp32 376.8 [374-423] ms vs int8 300.9 [297-318] ms (-20%).
- This replaces the confounded 'int8 full 143.7 vs fp32 low-res 165.5'.

Download sizes: encoder 28.1 MB fp32 vs 11.2 (all-ops), 14.2 (MatMul-only), 8.1 (QDQ); decoder 16.5 vs 4.7 (low-res) / 4.8 (full) MB.

Mask quality: onnxruntime-web WASM kernels, 9 scenario steps with ground truth (S1/S4 too large to measure), best mask vs its fp32 reference on the same prompts:

- All-ops int8: median IoU 0.811 [0.124-0.969]; ground-truth IoU drops above 0.05 on 5 of 9 steps (S2 0.85->0.73, S3 0.89->0.66, S7 0.87->0.67, R2 0.98->0.13, R3 0.98->0.20).
- MatMul-only: 0.997 [0.973-0.998]; 0 of 9.
- QDQ: 0.767 [0.259-0.980]; 5 of 9.
- int8 low-res decoder: 0.997 [0.763-0.999]; 1 of 9 (S3 0.89->0.68, a best-candidate flip).
- fp32 full vs low-res decoder: 1.000 on every step.

The first run's 'refuted: int8 slower or equal' is withdrawn. MatMul-only int8 is faster where measurable, 2x smaller and near-lossless. The quantisation choice matters more than int8 versus fp32.

### H8: partial

A decoder graph without the 1024 px mask upsample (low-res logits only) is materially faster.

Full vs low-res, one click, median over 3 rounds: WASM t=1 376.8 vs 355.6 ms (+6%), native t=1 128.2 vs 105.0 ms (+22%). First run: +14% WASM, +25% native. Masks are identical (IoU 1.000). Worth having, but it is not what puts the decoder over 50 ms.

### H9: confirmed

SAM assistance fits the architecture as new leaf packages with minimal changes to existing packages, one concern per package.

git diff origin/claude/segmentation-brush-tool: existing packages 14 files, +38/-5. This fix pass touched none of them.

The worker RPC moved to @osdlabel/segmentation-worker. The wire format, the all-server client, a generic remote encoder and the service-adapter contract moved to @osdlabel/segmentation-remote. Each depends only on @osdlabel/segmentation. segmentation-onnx no longer contains server or worker code; the app composes the remote encoder with segmentation-onnx's samEmbeddingFromTensors, so neither package depends on the other.

All 7 new packages are leaves.

The stress point is still the closed ToolType union: adding one tool touched annotation, validation, osdlabel and both bindings.

### H10: partial

A WebGPU gate (non-fallback, non-software adapter plus a WASM-vs-WebGPU microbenchmark) never selects SwiftShader and selects WebGPU only when it is faster.

In this sandbox the gate returned {ep: 'wasm', reason: 'fallback-adapter'} for google/swiftshader (isFallbackAdapter true) without running the probe. Five unit tests cover:

- no navigator.gpu, a null adapter, and a throwing requestAdapter;
- this sandbox's SwiftShader info, llvmpipe and Microsoft Basic Render (no probe run);
- both fallback flags;
- a 180 vs 50 ms probe choosing WebGPU and 180 vs 150 ms staying on WASM at minSpeedup 1.5;
- a failing probe, and a WebGPU probe timing out after max(5 s, 4x the WASM time).
  The app's probe times the SAM low-res decoder on both EPs. Its behaviour on real GPUs is unmeasured.

## Measurements

| Measurement                                                                                   | Value                                                                                                                                                                                                                                                                                                                                                                                                                                   | Unit               | Conditions                                                                                                                                                                                                                                                                                |
| --------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Run conditions (final bench run)                                                              | 2026-10-24 17:11-18:51 UTC; host 'Intel(R) Xeon(R) Processor @ 2.80GHz', 4 CPUs, 15.7 GB RAM; load1 1.7 at start, 7.6 at end, 1.7-9.5 per case; another agent's Chromium benchmark (volume PoC) ran throughout                                                                                                                                                                                                                          | -                  | Chromium 153.0.8010.12 headless, crossOriginIsolated=true, onnxruntime-web/-node 1.30.0. Wall times about 2x the first run's, which reported a 2.1 GHz Xeon. Load-sensitive: every wall number below.                                                                                     |
| H1 native encoder wall median (min), t=1 / t=4                                                | MobileSAM 1984 (1758) / 1780 (1394); MobileSAM all-ops int8 2564 / 2181; MatMul-only int8 1721 / 1452; QDQ 1790 / 1700; EfficientSAM-Ti 4233 / 3540; EdgeSAM 1090 / 475; LiteMedSAM 1846 / 1573; SAM 2.1-T own export 5317 / 1911; SAM 2-T real 6240 / 2146; ViT-B 18146 / 6542                                                                                                                                                         | ms                 | onnxruntime-node 1.30, 1024 px noise input, 3 reps after 1 warm-up, load 1.3-7.5                                                                                                                                                                                                          |
| H1 WASM encoder wall median (min), t=1 / t=4                                                  | MobileSAM 8933 (8438) / 3187 (2834); all-ops int8 7213 / 4772; MatMul-only int8 6159 / 2034; QDQ 7948 / 5904; EfficientSAM-Ti 16351 (n=1) / 12100 (n=1); EdgeSAM 4032 / 4379 (min 2055); LiteMedSAM 7971 / 2775; SAM 2-T real 21719 (n=1) / 7300; ViT-B 69329 (n=1) / 36491 (n=1); SAM 2.1-T own export fails (ShapeInferenceError)                                                                                                     | ms                 | Chromium 153 headless, ORT on the page's main thread (proxy=false; the product runs in a worker), fresh page per case, n=3 unless noted (n=1 when the first encode exceeds 10 s), load 1.8-8.4                                                                                            |
| H1 CPU per encode, t=1, native / WASM                                                         | MobileSAM 1986 / 9063; EfficientSAM-Ti 4528 / 16480; EdgeSAM 1157 / 4053; LiteMedSAM 1867 / 7663; SAM 2-T real 6272 / 21730; ViT-B 26394 / 69410                                                                                                                                                                                                                                                                                        | ms CPU             | process.cpuUsage (native), CDP SystemInfo.getProcessInfo summed over browser processes (WASM). Not load-robust: MobileSAM WASM t=1 CPU was 4323 ms in the first run and 7463 in the review's.                                                                                             |
| H1 decoder (one click) wall median (min)                                                      | MobileSAM low-res: native t=1 126.5 (101.7), t=4 173.9 (121.0); WASM t=1 401.6 (301.1), t=4 311.3 (162.8); box+2pt WASM t=4 296.9. Other models' WASM t=1 decoder: 322-374 ms; t=4: 147-394 ms                                                                                                                                                                                                                                          | ms                 | 3 warm-ups, then 20 x (click, box+2pt) alternating, same embedding; models suite, load 1.8-8.4                                                                                                                                                                                            |
| H7 int8 suite: WASM encoder, median of 3 rounds' medians [min-max]                            | t=1: fp32 8029 [7972-8073]; all-ops dynamic int8 6758 [6138-6866] (-16%); MatMul-only dynamic int8 6436 [6316-6506] (-20%); static QDQ 7880 [7439-7989] (-2%). t=4: fp32 5348 [5139-5781]; all-ops 5266 [4805-7214]; MatMul-only 5778 [4215-7612]; QDQ 5371 [3211-11680]                                                                                                                                                                | ms                 | same noise input, fp32 low-res decoder in every case, 3 encodes per round, 3 interleaved rounds with rotated order, browser WASM; t=4 overlaps at load 3.4-8.0 and is not resolvable                                                                                                      |
| H7 int8 suite: CPU per encode, median of rounds                                               | t=1: fp32 8060, all-ops 6440, MatMul-only 6360, QDQ 7863; t=4: 13713, 12960, 12040, 14547                                                                                                                                                                                                                                                                                                                                               | ms CPU             | browser CPU over all processes; t=4 CPU includes ORT thread-pool spinning                                                                                                                                                                                                                 |
| H7 int8 suite: native encoder, median of 3 rounds                                             | t=1: fp32 1856, all-ops 2331 (+26%), MatMul-only 1590 (-14%), QDQ 1870 (+1%); t=4: fp32 1784, all-ops 2541 (+42%), MatMul-only 1457 (-18%), QDQ 1712 (-4%)                                                                                                                                                                                                                                                                              | ms                 | onnxruntime-node, same rounds as the browser cases                                                                                                                                                                                                                                        |
| H7 int8 suite: decoder (one click), median of 3 rounds [min-max]                              | WASM t=1: low-res fp32 355.6 [342.3-374.8], low-res int8 285.8 [263.6-289.0] (-20%); full fp32 376.8 [374.1-422.9], full int8 300.9 [296.9-318.4] (-20%). WASM t=4 (noisy): 358.4 [133-445], 249.8 [107-400], 382.9 [144-454], 352.5 [121-369]. Native t=1: 105.0, 107.8, 128.2, 134.7                                                                                                                                                  | ms                 | fp32 encoder for the embedding, 20 click decodes per round, graph for graph (low-res vs low-res, full vs full)                                                                                                                                                                            |
| H7 download sizes                                                                             | MobileSAM encoder 28.1 fp32 / 11.2 all-ops int8 / 14.2 MatMul-only int8 / 8.1 QDQ; SAM decoder low-res 16.5 fp32 / 4.7 int8; full 16.5 / 4.8                                                                                                                                                                                                                                                                                            | MB                 | scripts/quantize_variants.py (onnxruntime 1.23 quantization); QDQ calibrated with MinMax on 12 synthetic views that are not the scenario's                                                                                                                                                |
| H7 mask quality vs fp32 reference (best mask, image space)                                    | all-ops int8 encoder median 0.811 [0.124-0.969], ground-truth drops >0.05 on 5/9 steps; MatMul-only int8 0.997 [0.973-0.998], 0/9; QDQ 0.767 [0.259-0.980], 5/9; int8 low-res decoder 0.997 [0.763-0.999], 1/9 (S3 0.89->0.68); all-ops int8 + int8 full decoder vs fp32 full 0.813 [0.124-0.969], 5/9; fp32 full vs low-res decoder 1.000 on every step                                                                                | IoU                | scripts/quality-check.mjs, onnxruntime-web 1.30 WASM in Node at t=1 (browser kernels; equality with browser threads is assumed, not measured); scenario S1-S8 and R1-R3 with the tool's prompt semantics; S1/S4 masks too large to measure; deterministic: two runs gave identical values |
| H2 refinement across a 4x zoom (browser e2e)                                                  | R1 hit 485 ms; R2 one re-encode 6473 ms (expected miss: ok), 2-point prompt inside the encoded region (scale 0.2423), mask_input fed, best mask vs R1 IoU 0.992, centroid shift 4.7 px (R1 cell 58.6 px, R2 cell 16.5 px), ground-truth IoU 0.984; R3 hit 335 ms, vs R2 IoU 0.997, shift 1.9 px, ground-truth IoU 0.982                                                                                                                 | ms / IoU / px      | MobileSAM worker, 4 threads, Canvas 2D drawer, load 4.5-5.4, n=1 per step (deterministic)                                                                                                                                                                                                 |
| H2 refinement counterfactuals (R2, WASM kernels in Node)                                      | previous logits resampled onto the new grid (fix): IoU 1.000 with the previous mask, shift 0.0 px; copied cell for cell (old maskInputFeeds): IoU 0.079, shift 556 px; mask_input dropped: top-ranked ground-truth IoU 0.271 (vs 0.984 resampled); review probe (fake encoder): 4 encodes for 4 clicks before, 2 after, every point inside                                                                                              | IoU / px / encodes | quality-check.mjs --steps R1,R2,R3 (--previous-mask drop for the third value); probe-refine.mjs from the review, run on the fixed packages/segmentation/dist                                                                                                                              |
| H2 e2e worker, full scenario                                                                  | S1 miss 9214 (encode 5737; first encode in the worker); S2 hit 582; S3 hit 245; S4 miss 6154; S5 miss 6809; S6 hit 391; S7 miss 6031; S8 prepare() 5452, then hit 314; R1 hit 485; R2 miss 6473; R3 hit 335                                                                                                                                                                                                                             | ms click->painted  | MobileSAM, 4 threads, Canvas 2D drawer, load 4.5-5.4; worker main-thread max frame gap 17-105 ms, 54-60 fps                                                                                                                                                                               |
| H2 ground-truth IoU of the committed mask                                                     | gland 0.844 (S2; 0.615 vs lumen), 0.884 (S3), 0.983 (S6), 0.986 (R1), 0.984 (R2), 0.982 (R3); nucleus 0.881 (S7); gland-or-lumen ambiguity 0.520 vs gland / 0.992 vs lumen (S5), 0.521 (S8)                                                                                                                                                                                                                                             | IoU                | analytic ellipses in the synthetic scene; checks the coordinate pipeline, not pathology quality                                                                                                                                                                                           |
| H2 tile reads for the encode crop                                                             | S1 45 tiles L12 263 ms; S4 30 tiles L12 65 ms; S5 40 tiles L14 237 ms; S7 54 tiles L17 196 ms; R2 20 tiles L15 94 ms                                                                                                                                                                                                                                                                                                                    | ms                 | region-reader in the worker, local Vite server, pre-rendered PNG tiles                                                                                                                                                                                                                    |
| H3 mask commit and polygon costs                                                              | raster->snapshot 37-187 ms, canonical RLE 7.8-14.7 KB, Fabric render object 74-189 ms for 2.9-10 Mpx boxes; nucleus 0.2 ms / 48 B; polygon 3.4-12 ms for 8-92 vertices, polygon vs mask IoU 0.977-0.998 (0.92 nucleus); S1 overview polygon 114 vertices, 15 rings, 4 holes, 19.5 ms                                                                                                                                                    | ms / bytes / IoU   | main thread, e2e run                                                                                                                                                                                                                                                                      |
| H3 overview masks vs #149 cap                                                                 | S1 2,273,163,669 px = 33.9x the 67,108,864 px cap; S4 1,004,256,176 px; both committed as a polygon of the largest ring                                                                                                                                                                                                                                                                                                                 | pixels             | model raster 256x160; #149 stores level-0 masks only                                                                                                                                                                                                                                      |
| H3 remote topologies                                                                          | remote-encoder: S1 3735, S5 2918, S7 2940 cold (server encode 2209-2583, round trip 2511-2838, wire 2,097,412 B f16), S2 hit 488; remote-all: S1 2698, S5 2840, S7 2789 cold, S2 hit 318 (329 KB)                                                                                                                                                                                                                                       | ms click->painted  | server = onnxruntime-node t=4 inside the Vite process on the same machine, no network, load 6.3-7.4; first run: 0.76-0.87 s cold                                                                                                                                                          |
| H5 float16 wire check                                                                         | mask IoU f32 vs f16 = 1.0000 for 16/16 candidates; max \|logit diff\| 0.0025 / 0.019 / 0.015 / 0.082                                                                                                                                                                                                                                                                                                                                    | IoU / logit        | S1, S2, S5, S7 views, server-side re-decode                                                                                                                                                                                                                                               |
| H4 responsiveness, worker, Canvas 2D drawer: settled (encode ms / fps / longest gap ms)       | t=1 7695 [7662-8113] / 60 / 59; t=2 4555 [4401-4622] / 60 / 24; t=3 5333 [4927-5540] / 60 / 43; t=4 5468 [4577-5815] / 59 / 67                                                                                                                                                                                                                                                                                                          | ms / fps / ms      | MobileSAM cold encode per click on fresh gland-zoom views, 3 reps each, median [range]; tiles fully loaded before the click (0 tiles loaded during the window)                                                                                                                            |
| H4 responsiveness, worker, Canvas 2D: tiles still loading (click right after the view change) | fps t=1 50 [49-51], t=2 45 [39-46], t=3 36 [25-38], t=4 31 [30-31]; long-task ms 56 / 162 / 1272 / 2261; max gap 50 / 67 / 150 / 174 ms; encode 8212 / 5757 / 6500 / 7289 ms; 110-115 tiles loaded per window                                                                                                                                                                                                                           | fps / ms           | 3 reps each, median; load 4.8-6.7                                                                                                                                                                                                                                                         |
| H4 responsiveness, worker, Canvas 2D: continuous pan during the encode                        | fps t=1 29 [27-30], t=2 26 [23-27], t=3 20 [19-21], t=4 17 [17-19]; max gap 102 / 133 / 200 / 183 ms; pan frames per encode 285-318 / 180-202 / 174-193 / 151-170; pan with no inference 37-44 fps median (24-50)                                                                                                                                                                                                                       | fps / ms           | scripted pan of 8 px per frame keeps OSD loading tiles (87-186 tiles per window); 3 reps                                                                                                                                                                                                  |
| H4 responsiveness, main-thread inference (t=4)                                                | Canvas 2D: 1-2 fps in every condition, max gap 6215-7130 ms (settled 6715, loading 6854, panning 6161 median), the pan got 10 frames per encode; WebGL: 1 fps, max gap 6665-7232 ms                                                                                                                                                                                                                                                     | fps / ms           | 3 reps per condition; the Long Tasks API reported 0 ms for 2 of 3 'loading' blocks that rAF showed as 6.2-7.1 s gaps, so max frame gap is the primary measure                                                                                                                             |
| H4 responsiveness with OSD's WebGL drawer (SwiftShader)                                       | pan with no inference: 3-4 fps, about 4.5 s of long tasks per 4.9 s; worker t=1-4: 2-4 fps in every condition, max gap 417-1083 ms, encodes 9.8-13.4 s; tiles never settled within 10 s (29-54 tiles loading during 'settled' windows)                                                                                                                                                                                                  | fps / ms           | same suite and reps; a sandbox artifact: WebGL on CPU emulation                                                                                                                                                                                                                           |
| WebGPU gate verdict in this sandbox                                                           | {ep: 'wasm', reason: 'fallback-adapter', adapter: {vendor: 'google', architecture: 'swiftshader', isFallbackAdapter: true}}; probe not run; WebGPU cases skipped                                                                                                                                                                                                                                                                        | -                  | Chromium 153 headless with --enable-unsafe-webgpu --enable-features=Vulkan; chooseExecutionProvider with minSpeedup 1.5                                                                                                                                                                   |
| WebNN availability (missed alternative, not benchmarked)                                      | navigator.ml absent by default; with --enable-features=WebMachineLearningNeuralNetwork, MLContexts for cpu, gpu and npu are created                                                                                                                                                                                                                                                                                                     | -                  | Chromium 153.0.8010.12 headless, secure-context localhost page; ORT's WebNN EP was not run                                                                                                                                                                                                |
| Model session load in the browser                                                             | MobileSAM encoder 1544-2348 ms / decoder 513-831 ms; SAM 2-T real 1809-1939 / 753-953 ms; ViT-B 4594-6446 / 510-669 ms                                                                                                                                                                                                                                                                                                                  | ms                 | InferenceSession.create from a same-origin URL, includes graph optimisation; load 1.8-8.4                                                                                                                                                                                                 |
| Worker cache and JS heap in the e2e run                                                       | up to 7 embeddings, 29.4 MiB (4 MiB each for SAM1); main-thread usedJSHeap 12.6-92.5 MB                                                                                                                                                                                                                                                                                                                                                 | MiB / MB           | default cache budget 64 MiB / 8 entries                                                                                                                                                                                                                                                   |
| Architecture stress diff vs origin/claude/segmentation-brush-tool                             | existing packages 14 files, +38/-5 (no change in this pass). New: 108 files, +26,995, of which 15,155 are results/representative.json, so 11,840 lines. Package src 4,199 (segmentation 1,264, segmentation-onnx 927, segmentation-remote 441, segmentation-worker 248, segmentation-fabric 445, mask-contour 493, region-reader 381); tests 1,857; app src 1,299; app scripts 3,652; configs 833. pnpm-lock +406/-2; pnpm-workspace +4 | files / lines      | git diff --numstat at 9f7afef                                                                                                                                                                                                                                                             |
| Unit tests in the new packages                                                                | 78: segmentation 29, segmentation-onnx 15 (5 for the WebGPU gate), segmentation-remote 5, segmentation-worker 1, segmentation-fabric 12, mask-contour 9, region-reader 7                                                                                                                                                                                                                                                                | tests              | vitest 4.1.8; turbo typecheck+test for segmentation and its dependents, mask-contour, region-reader and poc-sam: 28/28 tasks pass; pnpm lint 17/17 pass; Prettier clean                                                                                                                   |

## Recommendation

Treat assisted segmentation as a provider contract plus a tool, built as new leaf packages that compose with #149 and the Fabric tool stack: one concern per package and a stable dependency graph (every new package is a leaf). OSD keeps rendering tiles, Fabric keeps previews and polygon editing, masks stay #149's.

osdlabel ships no server and no weights, and has no hard dependency on onnxruntime. Remote topologies are client adapters to services a deployment already runs (MONAI Label, nnInteractive's server, a team's own SAM service). They implement, or are wrapped by, SegmentationServiceAdapter in @osdlabel/segmentation-remote. The float16 embedding wire format there is optional: a convenience for servers the app writes itself, not a protocol osdlabel standardises.

Default topology: a worker-hosted provider (@osdlabel/segmentation-worker over segmentation-onnx).

- The worker reads the region at model resolution from the tile pyramid (region-reader), encodes, caches embeddings by (image, variant, region, scale), and decodes per click.
- The encode region is the viewport plus the prompt's extent (points, box, previous mask) and a margin. A refinement after pan/zoom therefore re-encodes at most once and never loses an earlier point.
- The previous result is resampled onto the new embedding's grid before it is fed back as mask_input. Measured: ground-truth IoU 0.984 resampled vs 0.271 dropped vs a 556 px misalignment when copied.
- Call prepare() on viewport settle.
- Default numThreads = clamp(floor(navigator.hardwareConcurrency / 2), 1, 4). On 4 cores, 2 threads encoded as fast as 4 and kept 45 vs 31 fps while tiles loaded.
- Never run inference on the main thread: 5.4-7.4 s freezes per cold encode.

Model and quantisation:

- Default MobileSAM (Apache-2.0).
- Ship the MatMul-only dynamic int8 encoder as the browser default. It is 2x smaller (14.2 vs 28.1 MB), 20% faster on WASM at one thread and 14-18% faster natively, with masks at IoU 0.973-0.998 against fp32.
- Do not use dynamic int8 over all ops (ConvInteger) or static QDQ: both are lossy (best-mask IoU down to 0.12-0.26), and all-ops is slower natively.
- Keep the fp32 low-res decoder as default. The int8 one is 20% faster and 3.5x smaller but flipped the best candidate on 1 of 9 steps: offer it as an option until a MatMul-only int8 decoder is tested.
- EfficientSAM-Ti and SAM 2-T are optional (the latter for video/stacks). EdgeSAM only as a user-supplied model (non-commercial license). ViT-B/H, MedSAM2 and nnInteractive stay server-side.

Execution provider: WASM by default; WebGPU only when chooseExecutionProvider passes. The adapter must be neither a fallback nor a software rasteriser, and WebGPU must beat WASM by 1.5x in a decoder microbenchmark within a time budget. It rejected this sandbox's SwiftShader, which is 40-150x slower than WASM.

Output: a #149 mask annotation by default, polygon as an option or fallback. Coarse masks need one of:

- multi-resolution masks in #149;
- a polygon-with-holes / multipolygon geometry;
- refine-at-commit (re-encode a finer crop around the object's box).
  Today's fallback keeps one ring.

The tool needs candidate cycling: top predicted IoU chose the lumen over the gland on the ambiguous S5/S8 clicks.

For stacks, cine, video and volumes, add the stateful SegmentationSession contract (already drafted), implemented by adapters to SAM 2 video, MedSAM2, nnInteractive or MONAI Label servers.

For first-party demos, note that OSD's default WebGL drawer saturates the main thread on GPU-less machines (3-4 fps panning with no inference here). That is a viewer setting, not a reason to move inference.

### New packages

- @osdlabel/mask-contour: pixel-edge contour tracing with holes, marching-squares iso-contours, closed-ring Douglas-Peucker, even-odd polygon fill, binary IoU; no dependencies
- @osdlabel/region-reader: reads an image region at a requested output size from a tile pyramid (DZI, single image; IIIF/DICOM WSI later), worker-safe planner, OSD tile-source describer; no dependencies
- @osdlabel/segmentation: SegmentationProvider/Encoder/Decoder contract, image-space prompts, RasterMask results placed by a RasterFrame, the encode plan (viewport plus prompt extent, margin, maxScale, maxZoomIn, reencodeGain), EmbeddingCache, composeSegmentationProvider, model-frame helpers (modelGridFrame, sameRasterFrame, resampleLogits), candidate ranking, raster->#149 MaskSnapshot and polygons, draft SegmentationSession; depends on @osdlabel/annotation, @osdlabel/mask, @osdlabel/mask-contour
- @osdlabel/segmentation-onnx: SAM1-family, EfficientSAM and SAM 2 ONNX graph adapters over a structural OrtModuleLike (the app injects onnxruntime-web or -node), mask_input alignment ('resample' default or 'drop'), samEmbeddingFromTensors, and the WebGPU-vs-WASM gate chooseExecutionProvider; depends on @osdlabel/segmentation and @osdlabel/region-reader
- @osdlabel/segmentation-worker: provider-agnostic Worker RPC (serveSegmentationWorker / WorkerSegmentationProvider), rasters transferred not copied; depends on @osdlabel/segmentation only
- @osdlabel/segmentation-remote: client adapters to existing services. SegmentationServiceAdapter<TSession> plus createServiceSegmentationProvider (one session per image, shared by concurrent first prompts, dropped on a failed open, closed on dispose), a generic server-encode / browser-decode createRemoteEncoder<E> (the app passes the embedding builder), the PoC's all-server client, and the optional float16 wire format; depends on @osdlabel/segmentation only
- @osdlabel/segmentation-fabric: SegmentationTool (click / Alt-click / drag-box prompts, mask_input refinement, read-only iso-contour preview, Enter/Escape, commit as #149 mask or polygon with a polygon fallback over the cap); depends on @osdlabel/fabric-annotations, @osdlabel/segmentation, @osdlabel/mask, @osdlabel/mask-contour, @osdlabel/annotation(-context), @osdlabel/viewer-api, peer fabric

### Changes to existing packages

- @osdlabel/annotation: ToolType gains 'segmentation'; toolTypeToGeometryType maps it to 'mask' (done, +4/-2)
- @osdlabel/validation: ToolTypeSchema accepts 'segmentation' (done, +1)
- osdlabel: ALL_TOOL_TYPES includes it; createAnnotationTool gains an injected toolFactories option so osdlabel never depends on segmentation packages; createMaskAnnotation accepts toolType 'segmentation' (done, +10/-1)
- @osdlabel/solid and @osdlabel/react Toolbar: a 'SAM' label (done, +1 each), with tests and mocks updated in both bindings
- Not done, needed for a first-class tool: a KeyboardShortcutMap key (viewer-api), DEFAULT_KEYBOARD_SHORTCUTS and mapKeyEventToActions (osdlabel), a segmentation provider/config prop on Annotator and useAnnotationTool in both bindings, candidate cycling, binding-parity tests and E2E against both dev apps with a deterministic fake provider
- Recommended for #149: multi-resolution masks (an optional downsample factor on MaskGeometry and the raw-data envelope, honoured by @osdlabel/mask buffers/codecs and the Fabric mask renderer), or a polygon-with-holes / multipolygon geometry, so coarse SAM results are not reduced to one ring
- Optional: open the closed ToolType union (a registry of extension tool types)

### API sketch

```ts
// @osdlabel/segmentation
export interface SegmentationTarget {
  readonly imageKey: string;
  readonly variant?: string | undefined;
  readonly imageSize: ImageSize;
  readonly viewport: ImageRegion;
  readonly viewportScale: number;
}
export interface SegmentationPrompt {
  readonly points?: readonly PromptPoint[] | undefined;
  readonly box?: PromptBox | undefined;
  readonly previous?: RasterMask | undefined;
}
export interface RasterFrame {
  readonly originX: number;
  readonly originY: number;
  readonly pixelWidth: number;
  readonly pixelHeight: number;
  readonly width: number;
  readonly height: number;
}
export interface RasterMask {
  readonly frame: RasterFrame;
  readonly data: Float32Array | Uint8Array;
}
export interface MaskCandidate {
  readonly mask: RasterMask;
  readonly predictedIou: number;
  readonly stability?: number | undefined;
}
export interface SegmentationResult {
  readonly candidates: readonly MaskCandidate[];
  readonly view: EncodeView;
  readonly timings?: Readonly<Record<string, number>>;
  readonly cached?: boolean;
}
export interface ProviderCapabilities {
  readonly box: boolean;
  readonly negativePoints: boolean;
  readonly multimask: boolean;
  readonly maskInput: boolean;
  readonly inputSize: number | null;
}
export interface SegmentationProvider {
  readonly capabilities: ProviderCapabilities;
  prepare?(target: SegmentationTarget, signal: AbortSignal): Promise<void>;
  segment(
    target: SegmentationTarget,
    prompt: SegmentationPrompt,
    signal: AbortSignal,
  ): Promise<SegmentationResult>;
  dispose?(imageKey?: string): void;
}
export interface EncodePolicy {
  inputSize: number;
  margin: number /*0.25*/;
  maxScale: number /*1*/;
  maxZoomIn: number /*3*/;
  reencodeGain: number; /*1.5*/
}
export function planEncodeView(
  t: SegmentationTarget,
  p?: EncodePolicy,
  prompt?: SegmentationPrompt | null,
): EncodeView; // viewport union promptExtent, plus margin
export function promptExtent(p: SegmentationPrompt, imageSize: ImageSize): ImageRegion | null;
export function canReuse(
  v: EncodeView,
  t: SegmentationTarget,
  p: SegmentationPrompt | null,
  policy?: EncodePolicy,
):
  | { reuse: true }
  | {
      reuse: false;
      reason: 'other-image' | 'other-variant' | 'panned-out' | 'prompt-outside' | 'too-coarse';
    };
export function sameRasterFrame(a: RasterFrame, b: RasterFrame): boolean;
export function resampleLogits(
  src: Float32Array,
  from: RasterFrame,
  to: RasterFrame,
  outside?: number,
): Float32Array;
export function composeSegmentationProvider<E>(
  enc: SegmentationEncoder<E>,
  dec: SegmentationDecoder<E>,
  o?: { policy?: Partial<EncodePolicy>; cache?: { maxEntries?: number; maxBytes?: number } },
): SegmentationProvider & { readonly cache: EmbeddingCache<E> };
export function rasterToMaskSnapshot(
  r: RasterMask,
  imageSize: ImageSize,
  o?: { threshold?: number; maxPixels?: number },
): MaskSnapshot; // throws MaskCapacityExceededError
export function rasterToPolygons(
  r: RasterMask,
  o?: { threshold?: number; tolerance?: number; minArea?: number },
): PolygonWithHoles[];
export interface SegmentationSession {
  /* draft, 3D/video */ addPrompt(
    frame: number,
    objectId: number,
    p: FramePrompt,
    s: AbortSignal,
  ): Promise<readonly FrameResult[]>;
  propagate(r: PropagateRequest, s: AbortSignal): AsyncIterable<FrameResult>;
  reset(objectId?: number): Promise<void>;
  close(): Promise<void>;
}

// @osdlabel/segmentation-onnx (runtime injected structurally)
export class OnnxSamModel<T extends OrtTensorLike> {
  static load<T>(
    ort: OrtModuleLike<T>,
    spec: {
      family: 'sam1' | 'efficientsam' | 'sam2';
      inputSize: number;
      encoder?: string | Uint8Array;
      decoder: string | Uint8Array;
    },
    o?: {
      encoderSession?: OrtSessionOptionsLike;
      decoderSession?: OrtSessionOptionsLike;
      previousMask?: 'resample' | 'drop';
    },
  ): Promise<OnnxSamModel<T>>;
}
export function createOnnxSamProvider<T>(
  m: OnnxSamModel<T>,
  pyramids: (imageKey: string) => TilePyramid | undefined,
  io: TileIO,
  o?: ComposeOptions,
): SegmentationProvider;
export function samEmbeddingFromTensors(
  family: ModelFamily,
  view: EncodeView,
  inputSize: number,
  tensors: readonly { name: string; dims: readonly number[]; data: ArrayBufferView }[],
): SamEmbedding;
export type EpProbe = (ep: 'webgpu' | 'wasm', signal: AbortSignal) => Promise<number>; // ms per representative run, warm-up excluded
export function chooseExecutionProvider(
  gpu: GpuLike | null | undefined,
  probe: EpProbe,
  o?: {
    minSpeedup?: number /*1.5*/;
    minProbeBudgetMs?: number /*5000*/;
    softwarePatterns?: readonly RegExp[];
  },
): Promise<
  | {
      ep: 'webgpu';
      reason: 'probe-faster';
      adapter: AdapterSummary;
      probe: { wasmMs: number; webgpuMs: number };
    }
  | {
      ep: 'wasm';
      reason:
        | 'no-webgpu'
        | 'no-adapter'
        | 'fallback-adapter'
        | 'software-adapter'
        | 'probe-failed'
        | 'probe-timeout'
        | 'probe-slower';
      adapter?: AdapterSummary;
      probe?: ProbeTimes;
      error?: string;
    }
>;

// @osdlabel/segmentation-worker
export function serveSegmentationWorker<C>(
  scope: MessagePortLike,
  create: (
    config: C,
  ) => Promise<{ provider: SegmentationProvider; info?: unknown; configure?(m: unknown): unknown }>,
): void;
export class WorkerSegmentationProvider<C> implements SegmentationProvider {
  constructor(worker: MessagePortLike);
  init(config: C): Promise<unknown>;
  configure(m: unknown): Promise<unknown>;
}

// @osdlabel/segmentation-remote: client adapters; osdlabel ships no server
export interface ServiceAnswer {
  readonly candidates: readonly MaskCandidate[];
  readonly region?: ImageRegion;
  readonly timings?: Readonly<Record<string, number>>;
}
export interface SegmentationServiceAdapter<TSession> {
  readonly capabilities: ProviderCapabilities;
  open(target: SegmentationTarget, signal: AbortSignal): Promise<TSession>; // MONAI Label: resolve/upload the image id; nnInteractive: POST /claim + set_image/target buffer
  infer(
    session: TSession,
    target: SegmentationTarget,
    prompt: SegmentationPrompt,
    signal: AbortSignal,
  ): Promise<ServiceAnswer>; // MONAI Label: POST /infer/{model}?image=&output=image|json; nnInteractive: add_*_interaction, changed-bbox result
  close?(session: TSession): Promise<void>; // nnInteractive: POST /release
}
export function createServiceSegmentationProvider<TSession>(
  a: SegmentationServiceAdapter<TSession>,
): SegmentationProvider;
export function createRemoteEncoder<E>(o: {
  url: string;
  inputSize: number;
  dtype?: 'float16' | 'float32';
  fetch?: typeof fetch;
  toEmbedding(blobs: readonly WireBlob[], view: EncodeView): E;
  bytesOf(e: E): number;
}): SegmentationEncoder<E>;
export function createRemoteSegmentationProvider(o: {
  url: string;
  capabilities: ProviderCapabilities;
  fetch?: typeof fetch;
}): SegmentationProvider; // PoC wire format
export function encodeWire<M>(
  blobs: readonly {
    name: string;
    dims: readonly number[];
    data: Float32Array | Uint8Array;
    dtype?: WireDType;
  }[],
  meta: M,
): Uint8Array;
export function decodeWire<M>(b: ArrayBuffer): { blobs: WireBlob[]; meta: M };

// app composition
const remote = createRemoteEncoder({
  url,
  inputSize: 1024,
  toEmbedding: (b, v) => samEmbeddingFromTensors('sam1', v, 1024, b),
  bytesOf: embeddingBytes,
});
const verdict = await chooseExecutionProvider(navigator.gpu, probeDecoderOnEachEp);

// @osdlabel/segmentation-fabric
export class SegmentationTool extends BaseTool {
  constructor(
    config: {
      provider: SegmentationProvider;
      getTarget(): SegmentationTarget | null;
      getOutput?(): 'mask' | 'polygon';
      onCommitMask?(c: {
        imageId: ImageId;
        contextId: AnnotationContextId;
        snapshot: MaskSnapshot;
        predictedIou: number;
      }): void;
      fallbackToPolygon?: boolean;
      maxPixels?: number;
      ranking?: 'iou' | 'stability' | 'iou-x-stability';
    },
    toolType?: ToolType,
  );
  prepare(): Promise<void>;
  commit(output?: 'mask' | 'polygon'): 'mask' | 'polygon' | null;
}
// osdlabel: createAnnotationTool('segmentation', { toolFactories: { segmentation: () => new SegmentationTool(cfg) } });
// bindings (proposed): <Annotator segmentation={{ provider, output: 'mask' }} />
```

### Effort

9.5-11 engineer-weeks for production 2D:

- 2 wk: harden segmentation, mask-contour and region-reader (API review, more tile sources, TypeDoc).
- 2 wk: segmentation-onnx (the WebGPU gate is in place; model loading and caching via the Cache API/OPFS, threads policy, MatMul-only int8 assets, plus a MatMul-only int8 decoder trial).
- 1 wk: segmentation-worker and segmentation-remote, including one real adapter (MONAI Label) tested against a running server.
- 2.5 wk: first-class tool wiring in both bindings (shortcut, Annotator props, candidate cycling, parity tests, E2E with a fake provider).
- 1.5 wk: multi-resolution masks or multipolygon geometry in #149.
- 1 wk: guide and demo.

Plus 4-6 wk for session-based 3D/video (SAM 2 video / MedSAM2 / nnInteractive adapters and a propagation UI), after the frame-axis and volume work lands.

### Risks

- The CPU WASM decoder takes 130-400 ms here (never under 50 ms), so hover previews need a real GPU or a server. Real-GPU WebGPU latency is unmeasured; the gate only guarantees SwiftShader is not chosen.
- Encoder latency on low-end CPUs: a cold MobileSAM click took 6-9 s on this loaded 4-core VM (4.4-8.9 s WASM at one thread across runs). Without prepare-on-settle, or on 2-core machines, the first click is slow.
- Thread policy is load-sensitive. floor(cores/2) is validated on 4 cores only; with 4 threads, fps while tiles loaded fell to 31 and while panning to 17.
- OSD's WebGL drawer on software rendering (GPU-less VDI, headless) saturates the main thread with no inference at all (3-4 fps panning). Integrators may need the Canvas 2D drawer there.
- int8 quality depends on the quantisation recipe (all-ops and QDQ masks dropped to IoU 0.12-0.26 on some steps). Quality was measured on WASM kernels in Node at one thread, and with synthetic images only.
- Model licensing and hosting: EdgeSAM non-commercial; nnInteractive weights CC BY-NC-SA. 14-150 MB downloads the library must not bundle; ORT-format models are tied to ORT versions.
- Export fragility: our SAM 2.1 export loads natively but fails ORT-web shape inference.
- Quality on medical and pathology images is not established: synthetic data only, RGBA8 reads only (no DICOM, 16-bit or window/level path), and LiteMedSAM ran with random weights.
- Remote adapters are sketched from the services' source code and tested against a fake: real MONAI Label / nnInteractive protocols, auth and session leases may need more than the contract shows.
- Without multi-resolution masks or multipolygons, overview-zoom results become one-ring polygons.
- The closed ToolType union: every new tool type touches 5 packages and both bindings.
- Memory: 4 MiB per SAM1 embedding and 16 MiB per SAM 2 embedding against a 64 MiB default cache.

## Rejected alternatives

- **PR #133's contract as is (single polygon result plus optional RLE string, image read via getViewportCanvas(), per-image cache)**: Reading the screen canvas leaks overlays and OSD level blending into the embedding and ties resolution to the screen. A single polygon cannot carry SAM's candidates, stability or mask_input refinement, or become a #149 mask. A per-image cache cannot represent deep-zoom crops.
- **Plan the encode from the viewport only, and clip or drop prompts that have left it (the review's other option)**: Dropping the earlier point changes what the user asked for. Encoding viewport union prompt extent cost one re-encode at an 11% coarser scale (0.2423 vs 0.273) and kept every point. The review's probe showed 4 encodes and point A outside every one before the change; with it, 2 encodes.
- **Feed mask_input only when the grids match, otherwise drop it**: Measured on R2: dropping it left the top-ranked mask at ground-truth IoU 0.271; resampling onto the new grid gave 0.984. Copying it unchanged (the old code) misaligned it by 556 px. Resample is the default; 'drop' remains an option.
- **Encode the whole gigapixel image, or re-encode the visible viewport on every pan/zoom**: A 100k x 80k image squeezed into 1024 px leaves glands a few pixels wide, and every re-encode costs 4.6-9 s on this CPU. The margin and maxZoomIn reuse made pans within the margin and 1.5x zooms cache hits (245-582 ms).
- **Run inference on the main thread**: Measured with tiles settled, loading and during a pan: 1-2 fps and 5.4-7.4 s max frame gaps per cold encode; the pan advanced 10 frames. The worker bounds gaps at or below 233 ms.
- **numThreads = hardwareConcurrency or hardwareConcurrency-1**: On 4 cores, 3 or 4 threads were not faster than 2 (5.3 / 5.5 vs 4.6 s) and cost more frames while tiles loaded (36 / 31 vs 45 fps) and while panning (20 / 17 vs 26 fps).
- **Dynamic int8 over all default ops (ConvInteger + MatMulInteger), or static QDQ, as the browser encoder**: Rejected for quality, not speed. All-ops int8 is 16% faster on WASM at one thread but slower natively (+26 / +42%), and its masks fell to IoU 0.12-0.97 against fp32 (ground-truth drops on 5 of 9 steps). QDQ is barely faster (-2%) and also lossy (0.26-0.98). MatMul-only int8 is adopted instead.
- **int8 low-res decoder as the default**: 20% faster and 3.5x smaller, but it flipped the best candidate on 1 of 9 ground-truth steps (S3 0.89 -> 0.68). It stays an option until a MatMul-only int8 decoder is measured.
- **Use the WebGPU EP whenever an adapter exists**: Headless and GPU-less Chromium hands out SwiftShader (isFallbackAdapter true here), 40-150x slower than WASM. Replaced by chooseExecutionProvider: hardware, non-fallback adapter plus a microbenchmark.
- **WebGPU-only inference (as in Annotorious' plugin)**: It fails without hardware acceleration, and software WebGPU is far slower than WASM. WASM stays the fallback.
- **osdlabel ships a segmentation server, or standardises on this PoC's float16 wire format**: Against 'a library your frontend renders, not a deployed system'. Deployments already run MONAI Label, nnInteractive or their own SAM service; SegmentationServiceAdapter wraps them in their own protocols, and the wire format stays an option for app-written servers.
- **Keep the worker RPC and remote clients inside segmentation-onnx**: A MONAI Label or nnInteractive integration would then depend on the ONNX package. Split into segmentation-worker and segmentation-remote, each depending only on @osdlabel/segmentation.
- **SAM ViT-B/H in the browser**: ViT-B WASM encode was 36.5 s at 4 threads and 69 s at 1 thread in this run (15.6 / 41 s in the first). Server-side only.
- **EdgeSAM as the default model**: Fast natively (0.5 s at 4 threads) and strong per its paper, but S-Lab License 1.0 is non-commercial. User-supplied only.
- **Store SAM results only as polygons**: Loses holes and multiple components (the S1 overview polygon dropped 14 rings and 4 holes; SAM 2 dropped 84 holes in the first run). Masks are #149's native currency.
- **Hard dependency on onnxruntime-web, or bundling weights in library packages**: Apps must pick the ORT build and host 14-150 MB of weights. A structural OrtModuleLike keeps segmentation-onnx runtime-agnostic, and the same adapters run on onnxruntime-node.
- **Make osdlabel depend on the segmentation packages to construct the tool**: That would add an edge from a core package to a leaf. The toolFactories injection keeps the graph stable.
- **nnInteractive or MedSAM2 in the browser**: nnInteractive needs an NVIDIA GPU and ships CC BY-NC-SA weights; both are stateful 3D/video models. Integrate them through service adapters and the session contract.

## Architectural stress

Existing files changed: 14; existing lines changed: 43; new lines: 11840.

Existing packages (git diff --numstat origin/claude/segmentation-brush-tool at 9f7afef): 14 files, +38/-5. This review-fix pass changed none of them.

- Source (8 files, +17/-3): annotation annotation-tool.ts and util.ts ('segmentation' -> mask); validation tool.ts; osdlabel constraints.ts, tool-factory.ts (toolFactories injection, +8), create-mask-annotation.ts; solid and react Toolbar.tsx (label).
- Tests (6 files, +21/-2).
- No dependency edge added between existing packages.

New: 108 files, +26,995. 15,155 lines of that are the committed results/representative.json, which leaves 11,840:

- package src 4,199: segmentation 1,264, segmentation-onnx 927, segmentation-remote 441, segmentation-worker 248, segmentation-fabric 445, mask-contour 493, region-reader 381;
- tests 1,857;
- app src 1,299;
- app scripts 3,652;
- configs 833.

Workspace: pnpm-lock +406/-2; pnpm-workspace +4.

The fix pass (2015a6e..9f7afef, 48 files) added two packages, moved code out of segmentation-onnx, and replaced representative.json with one run.

All 7 new packages are private leaves. The worker and remote packages depend only on @osdlabel/segmentation; segmentation-onnx and segmentation-remote do not depend on each other (the app composes them through samEmbeddingFromTensors).

The stress point remains the closed ToolType union. A keyboard shortcut and Annotator props would touch viewer-api, osdlabel and both bindings again (not done).

## Reproduce

```sh
pnpm install && pnpm --filter @osdlabel/poc-sam fetch-models && pnpm --filter @osdlabel/poc-sam bench -- --chromium /opt/pw-browsers/chromium   # one non-interactive command after the models exist (about 100 min on this VM). fetch-models builds the consumed packages and downloads the real-weight models; with onnx+onnxruntime in python (POC_PYTHON) it also derives the low-res decoder and the int8 variants (scripts/calib-inputs.mjs + scripts/quantize_variants.py). bench builds the packages, then runs suites native,models,int8,quality,e2e,responsiveness,remote and writes apps/poc-sam/results/run-<ISO>.json incrementally; it prints the summary tables (reprint: node apps/poc-sam/scripts/summary.mjs <file>). The committed apps/poc-sam/results/representative.json comes from that run via node scripts/representative.mjs <one file>. Useful flags: --suites, --int8-rounds 3, --int8-threads 1,4, --resp-threads 1,2,3,4, --resp-reps 3, --resp-drawers canvas,webgl, --e2e-drawer canvas, --force-webgpu, --chromium '/path/to/Google Chrome' --headed for real hardware. Random-weight rows (EdgeSAM, LiteMedSAM, SAM 2.1 own export, ViT-B) need torch + segment-anything + timm + iopath for export_models.py.
```

## Caveats

- Noisy, shared sandbox: load1 1.7-9.5 during the final run, with another agent's Chromium benchmark running throughout (its SwiftShader GPU process used about 0.7-0.8 core). The host CPU reported 'Xeon @ 2.80GHz' versus the first run's 2.1 GHz, and wall times were about 2x the first run's. Treat absolute numbers as order of magnitude and use within-run comparisons (interleaved rounds for int8, identical views for the thread sweep). A quiet-machine rerun is still needed.
- t=1 CPU time is not load-robust: MobileSAM WASM t=1 CPU per encode was 4,323 ms (first run), 7,463 (review) and 9,063 / 8,060 ms (this run). The earlier claim is withdrawn.
- Sample sizes are small: H1 cases n=3 encodes (n=1 above 10 s) and 20 decodes; int8 3 rounds; responsiveness 3 reps per cell; e2e steps n=1, deterministic for quality but not for latency. No percentile beyond the reported ranges.
- int8 t=4 WASM comparisons overlap under this load and are reported as not resolvable; the like-for-like evidence is t=1 WASM and native.
- int8 mask quality was measured on onnxruntime-web's WASM kernels in Node at one thread. That the browser's multi-threaded WASM matches is assumed. The H1 browser bench runs ORT on the page main thread (proxy=false) while the product runs in a worker.
- WebGPU here is SwiftShader only; the gate rejected it, and no real-GPU WebGPU number exists. WebNN is behind a flag in Chromium 153 (contexts created with --enable-features=WebMachineLearningNeuralNetwork); ORT's WebNN EP was not measured.
- Responsiveness: OSD's default WebGL drawer runs on SwiftShader here and saturates the main thread with no inference (3-4 fps panning), so the e2e and remote suites now default to the Canvas 2D drawer. The Long Tasks API missed some multi-second main-thread blocks that rAF gaps show, so max frame gap is the primary measure.
- Quality on synthetic data only: a procedural H&E-like 100k x 80k DZI with analytic ellipses validates the coordinate pipeline (crop, letterbox/stretch, low-res grid, resampling, refinement alignment), not pathology or medical segmentation quality. No DICOM, 16-bit or window/level path. LiteMedSAM, EdgeSAM, ViT-B and the SAM 2.1 own export use random weights. Medical in-browser viability is not established.
- The QDQ calibration used 12 synthetic views from the same generator as the test scene, chosen away from the scenario's views; real-data calibration could change QDQ quality.
- Remote topologies ran onnxruntime-node inside the Vite process on the same machine: no network and a shared CPU. Real links add transfer time (estimated, not measured). The MONAI Label and nnInteractive adapter mappings come from their source code and docs (MONAILabel endpoints/infer.py, nnInteractive SERVER_CLIENT.md); they were tested against a fake service, not live servers.
- Headless Chromium 153 only; the desktop-Chrome reproduction is documented but was not executed.

## Open questions

- Will #149 accept multi-resolution masks, or a polygon-with-holes / multipolygon geometry, so overview-zoom SAM results are not reduced to one ring? Is refine-at-commit (re-encode a finer crop around the object) acceptable as the alternative?
- Does a MatMul-only int8 decoder keep the best-candidate ranking that the all-ops int8 decoder flipped on S3? And is MatMul-only int8 as lossless on real pathology and medical images as on the synthetic scene?
- What are WebGPU encoder/decoder latencies on the maintainer's real GPUs (desktop-Chrome run), and where does chooseExecutionProvider's probe put integrated GPUs?
- Is ORT's WebNN EP (CPU via XNNPACK, or NPU) a usable middle ground once WebNN ships unflagged? It closes part of the 2.6-4.6x WASM-vs-native gap only if it works with these graphs.
- Does floor(hardwareConcurrency/2) hold on 8-16 core desktops, and on 2-core laptops (t=1)?
- Should the tool cycle candidates (Tab through SAM's 3-4 masks), or rank by click-inside / stability? Top predicted IoU picked the lumen over the gland on the ambiguous clicks.
- Should ToolType become an open, registered union so extension tools do not touch annotation, validation, osdlabel and both bindings each time?
- Which default model: MobileSAM with the MatMul-only int8 encoder, EfficientSAM-Ti (+1.5 mIoU, about 2-4x slower), or SAM 2 Hiera-T (video-ready, 16 MiB embeddings)? Should other permissive light encoders (EfficientViT-SAM, SlimSAM, TinySAM, RepViT-SAM, SAM 2.1-small) or transformers.js's ORT-web SAM wrapper be evaluated first?
- Who hosts the weights, with what caching (Cache API / OPFS)? Should static whole-slide images get server-side, tile-aligned embedding pyramids on a CDN, shared across users, to remove cold encodes?
- Which first real adapter: MONAI Label (/infer/{model}, label image or contours) or nnInteractive's server (lease-based sessions, changed-bbox results)? Do their auth and session leases fit SegmentationServiceAdapter.open/close, or does the contract need a heartbeat?
- For medical images, which windowing does the encoder see (the current display W/L or a model preset), and which medical model is acceptable for quality and license?
- Should prepare() be driven automatically on viewport settle (more CPU, which competes with tile loading), or only while the SAM tool is active?

## How the review was addressed

- B1 (H7 int8 mislabelled, decoder comparison confounded): closed by re-measuring and withdrawing the claim.
- Built a like-for-like set with scripts/quantize_variants.py: the existing all-ops dynamic int8 encoder, a MatMul-only dynamic int8 encoder, a static QDQ encoder (MinMax on 12 synthetic views from calib-inputs.mjs) and an int8 low-res decoder. Each is paired in model-table.json with its fp32 reference.
- Speed: the bench's new int8 suite runs 3 interleaved rounds with a rotating order, on WASM t=1 and t=4 plus native.
  - WASM t=1 encoder: fp32 8,029 [7,972-8,073] ms; all-ops int8 6,758 (-16%); MatMul-only 6,436 (-20%); QDQ 7,880 (-2%).
  - WASM t=4 is not resolvable at load 3.4-8 (overlapping ranges).
  - Native: all-ops +26% / +42% (slower), MatMul-only -14% / -18%.
  - Decoders graph for graph at WASM t=1: low-res fp32 355.6 vs int8 285.8 ms; full fp32 376.8 vs int8 300.9 ms (-20% each). This replaces 'int8 full 143.7 vs fp32 low-res 165.5'.
- Sizes: 28.1 -> 11.2 / 14.2 / 8.1 MB encoders; 16.5 -> 4.7 / 4.8 MB decoders.
- Quality: quality-check.mjs on onnxruntime-web WASM kernels, best mask vs fp32 on the same prompts. All-ops int8 0.124-0.969 (5/9 ground-truth drops); MatMul-only 0.973-0.998 (0/9); QDQ 0.259-0.980 (5/9); int8 decoder 0.763-0.999 (1/9).
- Result: H7 relabelled partial. 'int8 for speed' is removed from rejected_alternatives and replaced with 'all-ops/QDQ rejected for quality'. MatMul-only int8 is now the recommended browser encoder.
- B2 (H4 depended on tile loading; numThreads untested; attribution wrong): closed by a new responsiveness suite.
- Method: per numThreads 1/2/3/4 in a worker, plus main-thread inference at t=4. Each takes 3 cold encodes on fresh views under three conditions (tiles settled, tiles still loading, a continuous scripted pan), plus a pan with no inference. Recorded per window: rAF fps, Long Tasks, max frame gap, tiles loaded. Run with both OSD drawers.
- Canvas 2D, worker:
  - Settled: 59-60 fps at every thread count.
  - Loading: t1 50 / t2 45 / t3 36 / t4 31 fps.
  - Panning: 29 / 26 / 20 / 17 fps against a no-inference pan of 37-44 fps.
  - Max gaps at or below 233 ms.
  - Settled encode: t1 7.7 s, t2 4.6 s, t3 5.3 s, t4 5.5 s.
- Main thread: 1-2 fps with 5.4-7.4 s gaps in every condition.
- WebGL drawer (SwiftShader): even the no-inference pan ran at 3-4 fps, and tiles never settled. So the low-fps samples behind the review's observation were mostly the drawer on CPU emulation, not inference or 'load 15-22'. The caveat's attribution is corrected.
- H4 is now stated relatively, with a new H4b refuting 'hardwareConcurrency-1'. Default numThreads = floor(cores/2), validated on 4 cores. The e2e and remote suites now default to the Canvas 2D drawer.
- B3 (refinement after pan/zoom broken; mask_input misaligned): closed by code, tests and a scripted measurement.
- Code: planEncodeView covers viewport union promptExtent (points, box, previous foreground) plus margin, and reencodeGain (1.5) prevents futile zoom re-encodes. maskInputFeeds feeds mask_input only when sameRasterFrame(prev.frame, modelGridFrame(embedding.frame)), and OnnxSamModel resamples a previous result from another grid by default (resampleLogits), or drops it.
- Unit tests: 5 in encode-plan.test.ts, including the review's probe scenario; 2 in raster.test.ts for sameRasterFrame and resampleLogits; 3 in onnx.test.ts for mask_input.
- The review's probe-refine.mjs on the fixed dist: 2 encodes for 4 clicks (was 4), every point inside.
- Browser e2e R1-R3 (click, zoom 4x so the first point leaves the view, click, click):
  - R2 is one re-encode (asserted), the 2-point prompt lies inside the encoded region, and mask_input is fed.
  - R2's mask vs R1's: IoU 0.992, centroid shift 4.7 px (R1 cell 58.6 px); ground-truth IoU 0.984.
  - R3 is a cache hit: IoU 0.997 vs R2, shift 1.9 px, ground-truth IoU 0.982.
- Counterfactuals on R2: copying the old way gives IoU 0.079 and a 556 px shift; resampled gives 1.000 and 0 px; dropping mask_input gives ground-truth IoU 0.271.
- H2 is confirmed with these numbers instead of being narrowed.
- Non-blocking notes addressed:
- WebGPU: chooseExecutionProvider plus 5 unit tests; it rejected SwiftShader here, and the bench runs WebGPU cases only when it passes.
- Packaging: worker and remote code moved into segmentation-worker and segmentation-remote, with the service-adapter contract.
- representative.json is now one run with no pre-fix frame stats, and representative.mjs no longer merges.
- One-command bench: ViT-B at t=1 now completes (one timed encode above 10 s), SwiftShader cases are gated, and missing int8 files are skipped, not fatal.
- '35x' corrected to 33.9x. The 3.8x WebGPU estimate is labelled speculation. 't=1 CPU load-robust' and the WASM decoder's '1.25x thread scaling' are withdrawn.
- Ranges are now stated with n.
- Remote numbers carry a no-network caveat and a transfer estimate.
- The medical half is stated as not established.
- Missed alternatives (WebNN availability probed, embedding pyramids, candidate cycling, multipolygon, refine-at-commit, other encoders, transformers.js) are recorded as open questions.

## Independent review

A second agent re-ran the benchmark and tried to break the conclusions.

### Blocking findings

- **H7 (int8) is marked 'refuted', and the report says int8 is 'slower or equal on both runtimes, only download size improves'. On WASM, the runtime that matters for the browser, the PoC's own data and my rerun both show the opposite. The decoder comparison quoted in H7 is also confounded.**
  - Evidence: representative.json, WASM t=1 (the metric the report calls load-robust): int8 encoder is 3979 ms wall vs 4441 ms fp32, and 3900 vs 4323 ms CPU, so about 10% faster. My rerun: WASM t=1 CPU 6460 vs 7463 ms (-13%), WASM t=4 wall 2567 vs 3430 ms (-25%). Only native is slower (1754 vs 2654 ms in my run). The decoder figure '143.7 vs 165.5 ms' compares the int8 FULL graph (sam_vit_h_4b8939.decoder.int8.onnx, model-table.json) with the fp32 LOW-RES graph. Full against full in the PoC's data is 187 vs 234 ms at WASM t=1 (-20%). The quantisation is quantize_dynamic(QUInt8) over the default op types (apps/poc-sam/scripts/export_models.py:331-343), so ConvInteger is included. Mask quality under int8 was never measured.
  - Required fix: Relabel H7 as mixed: slower on native; 10-25% faster on WASM; downloads 2.5-3.4x smaller (28.1→11.2 MB, 16.5→4.8 MB). Remove 'int8 for speed' from rejected_alternatives. Add an int8 low-res decoder row. Measure IoU of int8 masks vs fp32 masks on the e2e scenes. Try MatMul-only or static QDQ quantisation before ruling int8 out as a browser default.
- **H4's 'worker: 59-60 fps through a cold encode' depends on whether OpenSeadragon has finished loading tiles. The report blames the low-fps cases on machine load of 15-22 and recommends numThreads ≤ hardwareConcurrency-1, which was never tested.**
  - Evidence: Both runs show the same pattern. Every worker-mode step with view.tilesLoaded=false shows main-thread starvation. PoC e2e-real: SAM2 S1 9.5 fps, S5 7.2 fps; EfficientSAM S1 1.9 fps, S5 1.3 fps. My rerun (one-command bench, MobileSAM, load 3.8-4.8, not 15-22): S1 5.9 fps with 7757 ms of long tasks and a 600 ms max gap; S5 23 fps with 3743 ms of long tasks. Every step where tiles had settled ran at 48-60 fps (my S4/S7: 60 fps, 0 ms long tasks, during 3 s encodes). The quoted 59-60 fps comes from a single sample (run-e2e-main S1) where tilesLoaded=true. In the product, encodes start right after pan/zoom (prepare() on settle), which is exactly when OSD is still loading tiles. That is the unfavourable case.
  - Required fix: Re-measure H4 with tile loading controlled: settled vs still loading. Sweep numThreads over 1, 2, 3 and 4, and report fps, long-task ms and encode latency for each condition. Correct the attribution in the caveat. State the worker benefit as relative: the main thread still freezes for 4-6 s per encode, while the worker case drops to 0.6 s gaps or less. Do not state it as an absolute 60 fps.
- **H2 claims 'interactive follow-up clicks', but refinement clicks after a pan or zoom are broken. Every such click triggers a full re-encode, the decoder gets a prompt point outside the encoded region, and the previous mask is fed back misaligned.**
  - Evidence: SegmentationTool keeps prompt points until commit or cancel (packages/segmentation-fabric/src/segmentation-tool.ts). EmbeddingCache.find rejects any entry that does not contain every prompt point ('prompt-outside', packages/segmentation/src/encode-plan.ts canReuse). But planEncodeView plans from the viewport only, so the fresh encode cannot contain the earlier point either. I ran a probe against the built dist with a fake encoder (/tmp/claude-0/-home-user-osdlabel/d2340e79-db4e-595c-a199-55b42694fb93/scratchpad/review-sam/probe-refine.mjs). Click at overview, zoom 4x, then three more clicks: 4 encodes for 4 clicks, 4 cache entries all covering the same region, and point A outside the encoded region in every decode. Separately, maskInputFeeds (packages/segmentation-onnx/src/families.ts) only checks prev.frame width/height ≤ 256. It never checks that the previous raster's frame matches the new embedding's grid, so after a re-encode or a switch of cache entry, mask_input is misaligned. The e2e scenario never adds a point after a view change, because every step cancels, so this path was never exercised.
  - Required fix: Plan the encode region as the union of the viewport and promptBounds(prompt), or clip/drop prompts that have left the view. Feed mask_input only when prev.frame equals modelGridFrame(embedding.frame). Add an e2e step: click, zoom 4x, add a second point. Assert one encode, and check ground-truth IoU. Until then, narrow H2 to 'second-object clicks on the same or nearby view'.

### Non-blocking findings

- The WebGPU recommendation ('use the WebGPU EP when an adapter exists') would pick SwiftShader. In the PoC's own bench the adapter is {vendor: google, architecture: swiftshader}, and that path is 70-150x slower than WASM: in my rerun the MobileSAM encode exceeded the 240 s timeout against 3.4 s on WASM. Gate WebGPU on adapter.info / isFallbackAdapter plus a startup micro-benchmark. The SwiftShader rows themselves are correctly labelled as a bound, not GPU performance.
- The summary's ranges are narrower than the PoC's own data. 'Cold MobileSAM click 2.1-3.9 s' leaves out S5 at 4678 ms. 'Server-encode/browser-decode 0.76-0.87 s' leaves out S5 at 2110 ms. 'IoU 0.84-0.98' leaves out S8 at 0.52 (which has no alt-GT check, so the lumen explanation is unverified there) and EfficientSAM S2 at 0.60. My rerun gave cold 3.2-8.0 s, remote-encoder 1.27-1.45 s, cache hits 189-308 ms.
- 't=1 CPU time is load-robust' does not hold on this VM. At a similar load average my rerun's t=1 CPU times were 1.5-2x the PoC's: MobileSAM WASM encode 7463 vs 4323 ms, decode 387 vs 217 ms, native encode 1735 vs 1140 ms. 'Threads add only 1.25x' for the WASM decoder did not reproduce: I measured 2.4x for MobileSAM and 1.9-2.8x across models. The H1a verdict (above 50 ms) holds regardless. Absolute numbers have about ±2x run-to-run spread; present them as order of magnitude.
- Sample sizes are thin. Each e2e step is n=1 per run, and ranges across different steps are presented as if they were distributions. Encoders get n=3 (median of 3 under load 3-23). No percentile beyond p90 is computed. That is acceptable for order of magnitude, but should be stated next to every range.
- Packaging does not follow one-concern-per-package. @osdlabel/segmentation-onnx bundles the provider-agnostic worker RPC (serveSegmentationWorker, WorkerSegmentationProvider), the wire format, and createRemoteSegmentationProvider, the all-server client, which contains no ONNX code at all. A MONAI Label or nnInteractive integration would therefore have to depend on the ONNX package. Move the worker RPC and the remote-all client into @osdlabel/segmentation, or into separate segmentation-worker / segmentation-remote packages. The contract package (@osdlabel/segmentation) also depends on @osdlabel/mask and mask-contour for output conversion, so server-side provider authors pull in mask code.
- '#149 requires multi-resolution masks' is presented as the only fix. Alternatives: a polygon-with-holes / multipolygon geometry (polygon-vs-mask IoU is already 0.977-0.99), or refine-at-commit by re-encoding finer crops around the object's bounding box. Today's fallback is lossy because it commits only polys[0].outer as a 'polyline'. Also, 2.27 Gpx is 33.9x the cap, not 35x.
- Remote numbers come from the same 4-core box (native ORT inside the Vite process) with no network. A 2 MiB float16 embedding (8 MiB for SAM 2) per cold click adds 0.3-2 s on real links. The recommendation quotes 0.76-0.87 s without that caveat.
- The medical half of the question is essentially unanswered. region-reader reads RGBA8 only: no DICOM, 16-bit or grayscale/window-level path. LiteMedSAM was measured with random weights only, and no medical image was used. The summary should say in-browser medical viability is not established.
- The published one-command bench cannot reproduce two rows within its own 240 s timeout on this box: the MobileSAM SwiftShader encode and ViT-B WASM t=1 both timed out in my run.
- representative.json merges three runs, with later H1 rows replacing earlier ones. It still contains run-full-2's main-thread frame stats, which were taken before the fix in bc50df5. For example, local-main S1 reports 6 frames in 3.7 s with a 16.7 ms max gap. Strip those stats or mark them invalid.
- The H1 browser bench runs ORT on the page main thread (numThreads=4, proxy=false), while the product runs in a worker. The e2e worker decode times (99-290 ms) are similar, so this did not materially change the result, but the setup should be stated.
- The default ranking (predictedIou) chose the lumen in 2 of 6 MobileSAM ground-truth steps, 1 of 4 for SAM 2 and 2 of 4 for EfficientSAM. Partly this is scenario design, since clicks at the gland centre land on the white lumen. The tool also has no candidate-cycling UI, which every SAM UI needs.
- 'Microsoft reports 3.8x ... would land near 45-55 ms' applies a speed-up ratio measured on an RTX 3060 laptop to this Xeon's WASM number. That is speculation and should be labelled as such.
- Things that check out: the H2 coordinate pipeline is deterministic (my rerun's ground-truth IoUs were bit-identical: 0.844, 0.884, 0.520/0.992, 0.983, 0.881, 0.521); the f16 check reproduced 16/16 candidates at IoU 1.0000; lint, Prettier, typecheck and tests are clean; the existing-package diff is accurate.

### Claims checked

| Claim                                                                                                                                                                                                                    | Verdict    | Note                                                                                                                                                                                                                   |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Architecture diff vs claude/segmentation-brush-tool: existing packages 14 files +38/-5; new 87 files +19,587, of which 10,378 lines are representative.json (9,209 lines of code); no new edge between existing packages | holds      | The merge-base is the brush-tool tip, so the three-dot diff is exactly the PoC. The numstat matches, no existing package.json changed, and region-reader and mask-contour have no dependencies.                        |
| 60 unit tests (22/10/12/9/7); all package test and typecheck tasks pass                                                                                                                                                  | holds      | Test counts match. turbo typecheck+test for the 11 touched packages passed (served from the turbo cache), and eslint and prettier --check on the new code are clean.                                                   |
| H1a: the SAM decoder is not under 50 ms on CPU WASM                                                                                                                                                                      | holds      | My rerun: WASM t=4 127-239 ms and t=1 358-452 ms across models, even slower than the PoC's numbers.                                                                                                                    |
| WASM threads add only 1.25x to the decoder (native 2.9x)                                                                                                                                                                 | wrong      | Not reproduced: MobileSAM went 367→154 ms (2.4x), and other models showed 1.9-2.8x. The PoC's t=1/t=4 pair was taken under shifting load.                                                                              |
| t=1 CPU time is load-robust                                                                                                                                                                                              | wrong      | My t=1 CPU times were 1.5-2x the PoC's at a similar load average (WASM encode 7463 vs 4323 ms, native 1735 vs 1140 ms).                                                                                                |
| WASM/native CPU ratio at t=1 is 2.6-3.8x for every encoder                                                                                                                                                               | overstated | My rerun gave 2.4-4.3x. The order of magnitude holds; the range does not.                                                                                                                                              |
| H1c: MobileSAM WASM t=4 encode about 1.8-2.0 s; EdgeSAM about 1.0 s                                                                                                                                                      | overstated | My rerun: MobileSAM 3.4 s, EdgeSAM 2.4 s, EfficientSAM-Ti 8.1 s, SAM2-T 8.2 s. The ranking and order of magnitude hold.                                                                                                |
| H1d: WebGPU numbers are SwiftShader bounds, not GPU numbers                                                                                                                                                              | holds      | Labelled correctly. My rerun: EdgeSAM encode 110 s, MobileSAM encode over the 240 s timeout, decodes about 23 s. The adapter was google/swiftshader. The resulting recommendation still needs fallback-adapter gating. |
| H2: cache hits paint in 160-255 ms                                                                                                                                                                                       | holds      | My rerun: 189-308 ms on S2, S3, S6 and S8.                                                                                                                                                                             |
| H2: a cold MobileSAM click takes 2.1-3.9 s on WASM                                                                                                                                                                       | overstated | The PoC's own steps span 1.66-4.68 s; my rerun was 3.2-8.0 s.                                                                                                                                                          |
| H2: viewport-crop encoding gives correct image-space masks (ground-truth IoU 0.84-0.98)                                                                                                                                  | holds      | The coordinate pipeline is validated: 0.98-0.99 where the intended structure was chosen, bit-identical in my rerun. The summary omits S8 at 0.52.                                                                      |
| H2: interactive follow-up clicks                                                                                                                                                                                         | wrong      | Holds for second-object clicks. Refinement after a view change re-encodes on every click, sends an out-of-region point, and misaligns mask_input (probe).                                                              |
| H3a: overview masks exceed #149's 64 Mi cap (2.27 Gpx box)                                                                                                                                                               | holds      | Reproduced exactly. The ratio is 33.9x, not 35x.                                                                                                                                                                       |
| H3b: server-encode/browser-decode takes 0.76-0.87 s per cold click                                                                                                                                                       | overstated | The PoC's own S5 was 2110 ms; my rerun was 1.27-1.45 s. Same machine, no network, and a 2 MiB download per encode.                                                                                                     |
| H3b: one contract covers the worker, remote-encoder and all-server topologies                                                                                                                                            | overstated | Shown only against the PoC's own SAM server. MONAI Label and nnInteractive were not exercised. 'partial' is the appropriate verdict.                                                                                   |
| H4: the worker keeps 59-60 fps through a cold encode                                                                                                                                                                     | overstated | True only when OSD tiles had settled. With tiles still loading: 1.3-9.5 fps in the PoC's data and 5.9 fps in mine at load about 4.                                                                                     |
| H5: float16 embeddings leave masks unchanged                                                                                                                                                                             | holds      | Reproduced: 16 of 16 candidates at IoU 1.0000, max logit diff 0.003-0.082.                                                                                                                                             |
| H7: dynamic int8 does not speed up the encoder; only download size improves                                                                                                                                              | wrong      | WASM int8 was 10-25% faster in both runs. The decoder comparison was full graph vs low-res graph.                                                                                                                      |
| H8: the low-res-only decoder is faster                                                                                                                                                                                   | holds      | My rerun: native t=1 101 vs 147 ms; WASM t=1 CPU 387 vs 426 ms.                                                                                                                                                        |
| License claims (EdgeSAM S-Lab non-commercial; MobileSAM, EfficientSAM, SAM 2 Apache-2.0; nnInteractive weights CC BY-NC-SA)                                                                                              | unchecked  | Consistent with my knowledge; not re-verified online.                                                                                                                                                                  |
| Published figures (ORT Web 1.17 blog 19x/3.8x; EdgeSAM-paper mIoU 74.4 vs 77.3)                                                                                                                                          | unchecked  | Not re-verified.                                                                                                                                                                                                       |

### Reviewer's rerun

I ran it once, at HEAD 2015a6e, on detached origin/claude/poc-sam with the provided models copied in. Steps: pnpm install --frozen-lockfile, then `pnpm bench --chromium /opt/pw-browsers/chromium --port 5497 --out /tmp/claude-0/-home-user-osdlabel/d2340e79-db4e-595c-a199-55b42694fb93/scratchpad/review-sam/run.json` in apps/poc-sam. I skipped fetch-models so that nothing was re-exported. It ran about 36 minutes, load1 1.3-6, and the full log is at /tmp/claude-0/-home-user-osdlabel/d2340e79-db4e-595c-a199-55b42694fb93/scratchpad/review-sam/bench.log.

H1, median ms:

- MobileSAM: native encode 1754 (t=1) / 2012 (t=4); WASM encode 7496 / 3430; WASM decode 367 / 154.
- MobileSAM int8: WASM encode 6369 / 2567; WASM decode 360 / 149.
- EfficientSAM-Ti: WASM encode 19637 / 8077.
- EdgeSAM: WASM encode 3846 / 2380.
- LiteMedSAM: WASM encode 7322 / 2541.
- SAM2-T real: WASM encode 22951 / 8236; native t=4 1872.
- ViT-B: WASM t=4 22350; WASM t=1 timed out at 240 s.
- The SAM2.1 own export still fails in ORT-web (ShapeInferenceError).
- SwiftShader: MobileSAM encode timed out at 240 s; EdgeSAM encode 109768; decodes 22982-23648.

E2E, MobileSAM worker t=4, click→painted ms:

- S1 miss 7990; S2 hit 308; S3 hit 189; S4 miss 3435; S5 miss 5622; S6 hit 200; S7 miss 3183; S8 hit 206.
- Ground-truth IoU was identical to the PoC's.
- Worker S1 ran at 5.9 fps with 7757 ms of long tasks (tilesLoaded=false); S4 and S7 ran at 60 fps.
- Main-thread mode: S1 5434 ms at 1.5 fps with a 4063 ms max gap; S2 881 ms.
- Remote-encoder: cold 1270-1449 ms, hit 362 ms.
- Remote-all: cold 958-3603 ms, hit 108 ms.
- f16 check: 16 of 16 candidates at IoU 1.0000.

Probe: /tmp/claude-0/-home-user-osdlabel/d2340e79-db4e-595c-a199-55b42694fb93/scratchpad/review-sam/probe-refine.mjs showed 4 encodes for 4 refinement clicks after a zoom.

### Alternatives the reviewer says were missed

- The WebNN execution provider in onnxruntime-web (CPU via XNNPACK, or an NPU). It could close part of the 3-4x WASM-vs-native gap, and it was not evaluated.
- Server-side precomputed, tile-aligned embedding pyramids at a few fixed levels for static whole-slide images, cached on a CDN and shared across users and sessions. This complements per-session viewport-crop encoding and removes cold encodes.
- Plan the encode region as viewport ∪ promptBounds, or reset or clip the prompt on a view change. This is needed for refinement and is the fix for blocking #3.
- A candidate-cycling UI (Tab through SAM's 3 masks), or ranking by stability or by whether the click falls inside the mask. Top-IoU picked the lumen in 2-3 of 4-6 ground-truth steps.
- A polygon-with-holes / multipolygon geometry, or refine-at-commit by re-encoding finer crops around the object, instead of only multi-resolution #149 masks.
- Static QDQ or MatMul-only int8, an int8 low-res decoder, and fp16 weights for WebGPU. The dynamic QUInt8 tried here quantises Conv as well.
- Gating WebGPU on a non-fallback adapter (adapter.info / isFallbackAdapter) plus a micro-benchmark before choosing it over WASM.
- A numThreads sweep (1, 2, 3) and the trade-off between UI responsiveness and latency while OSD loads tiles. The trade-off was asserted but not measured.
- Other permissively licensed light encoders not tried: EfficientViT-SAM, SlimSAM, TinySAM, RepViT-SAM, SAM 2.1-small. Also transformers.js as an existing ORT-web SAM wrapper, compared with hand-rolled adapters.
