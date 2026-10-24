# Plan and hypotheses

What this work sets out to test, and how. Comment on any hypothesis you think is wrong or missing; all seven proofs of concept have finished, so comments now steer the roadmap, not the builds.

## Hypotheses under test

Twenty-two hypotheses across seven proofs of concept. Each proof of concept is a branch named `claude/poc-<name>`, cut from PR #149's head. The Status column updates as verdicts land.

| ID  | Hypothesis                                                                                                            | Proof of concept | Measured by                                                                 | Status           |
| --- | --------------------------------------------------------------------------------------------------------------------- | ---------------- | --------------------------------------------------------------------------- | ---------------- |
| PX1 | CSS filters on 8-bit tiles (today's tonal adjustment) cannot window 12 to 16-bit data diagnostically                  | pixel-pipeline   | Distinct grey levels and banding step for five standard CT windows          | Confirmed        |
| PX2 | Reapplying a window/level lookup on the CPU is fast enough for a 512×512 slice, but not for a 4096×3328 mammogram     | pixel-pipeline   | Frame time while dragging window/level, by image size                       | Partly confirmed |
| PX3 | GPU windowing of 16-bit textures plugs into OpenSeadragon 5 through its drawer API, with no fork                      | pixel-pipeline   | Frame time; the OSD extension points actually used                          | Partly confirmed |
| PX4 | A 4×4 grid sits at Chrome's limit of 16 live WebGL contexts, so any other WebGL user evicts a cell                    | pixel-pipeline   | Contexts per cell; context loss as cells grow from 1 to 24; mitigation cost | Confirmed        |
| FA1 | Stacks (CT/MR series, ultrasound cine, multi-frame) fit as a frame axis plus an extension field, not a new core model | frame-axis       | Lines changed in existing packages vs new; breaking changes                 | Partly confirmed |
| FA2 | One cell scrolls a 300-slice stack at 30 fps or better with per-slice annotations                                     | frame-axis       | Per-slice latency p50/p95 and fps for four OSD strategies                   | Partly confirmed |
| FA3 | An ultrasound cine loop plays at 30 fps with 5% or fewer dropped frames                                               | frame-axis       | Dropped frames at 30 and 60 fps                                             | Confirmed        |
| VI1 | Seeking a video element is not frame-accurate; decoding with WebCodecs is                                             | video            | Share of seeks landing on the requested frame; ms per seek and per step     | Partly confirmed |
| VI2 | OpenSeadragon can host 1080p video at 30 fps with the overlay in sync                                                 | video            | fps and sync error, OSD path vs a plain video/canvas path                   | Confirmed        |
| VI3 | Tracks with keyframes and interpolation fit in a zero-dependency temporal package                                     | video            | Interpolation cost for 1,000 tracks per frame                               | Confirmed        |
| VO1 | The CPU reslices orthogonal planes of a 512×512×400 volume in under 10 ms, and oblique planes at interactive rates    | volume           | ms per reslice by method and orientation; memory                            | Partly confirmed |
| VO2 | Cross-view annotation (markers, intersection lines, crosshairs) renders through today's decoration layer unchanged    | volume           | Changes needed in the decoration packages                                   | Partly confirmed |
| VO3 | Niivue embeds as the 3D view in a grid cell and shares the volume buffer                                              | volume           | Copies of the volume; WebGL contexts used                                   | Partly confirmed |
| DI1 | An adapter derives spacing, windowing, photometric, cine timing and plane geometry from real DICOM                    | dicom            | Correctness on public CT, MR, US, DX and slide-microscopy series            | Confirmed        |
| DI2 | DICOM whole-slide images open in OpenSeadragon through a custom tile source                                           | dicom            | First paint and tile latency                                                | Confirmed        |
| DI3 | Annotations export to DICOM SR and masks to DICOM SEG, and both validate                                              | dicom            | highdicom validation; round-trip fidelity                                   | Partly confirmed |
| SA1 | SAM prompt decoding is interactive on the CPU; light encoders take seconds at most                                    | sam              | Encoder and decoder ms per model, 1 vs 4 threads                            | Partly confirmed |
| SA2 | Gigapixel images need viewport-crop encoding with an embedding cache                                                  | sam              | Click-to-mask latency on a deep-zoom image                                  | Confirmed        |
| SA3 | SAM output maps cleanly onto #149's mask annotations                                                                  | sam              | What the mask package lacks                                                 | Partly confirmed |
| EL1 | One custom element serves Vue, Svelte, Angular and plain HTML                                                         | element          | Rectangle drawn and change event received in each host; bundle size         | Confirmed        |
| EL2 | OpenSeadragon and Fabric work inside a shadow root                                                                    | element          | Breakages found and fixed                                                   | Partly confirmed |
| EL3 | Theme tokens, CSS parts and override slots keep the two bindings in parity                                            | element          | Diff size; tests in both bindings                                           | Partly confirmed |

## Method

Two tracks run in parallel. Every proof of concept passes an independent review before its results reach the Roadmap tab; research claims are checked as described below.

1. **Research.** Ten topics, one agent each: OHIF and Cornerstone3D; other web medical viewers (Niivue, VolView, Slim and more); annotation tools (Annotorious, CVAT, Label Studio and more); SAM-family models; clinical workflow requirements; browser platform limits; OpenSeadragon and Fabric roadmaps; DICOM interoperability; multi-framework and theming strategies; a stress map of osdlabel's own code. A second agent then tries to refute each topic's load-bearing claims.
2. **Proofs of concept.** Seven branches, each cut from #149's head. An agent builds the code and a one-command benchmark. A second agent reruns the benchmark and tries to break the conclusions. A third fixes whatever the reviewer found blocking. The pixel-pipeline and dicom branches skipped this pass, and their review findings were applied to the roadmap by hand.
3. **Quiet rerun.** Once every branch is built, each benchmark is rerun alone on an idle machine. That rerun reproduced the SAM numbers, then hit a time limit during video, so the Evidence tab reports the other timings from the build and fix passes on a shared 4-core machine.

Change on Oct 24: a usage limit stopped the first run partway. Six research topics and the pixel-pipeline build had finished. Interrupted branches resumed from their pushed state rather than starting over. DICOM interoperability and multi-framework strategy are no longer separate research topics, because the dicom and element proofs of concept cover them with working code. Instead of one fact-checker per topic, two agents re-verify the 22 most load-bearing claims.

What the sandbox can and cannot tell us:

- **CPU-side costs are representative.** JavaScript, decoding, typed-array work and data uploads run on a real 4-core machine.
- **GPU timings are a worst case.** There is no GPU, so WebGL2 and WebGPU run in SwiftShader, a software emulator. 16-bit normalized textures are missing here. Chrome 87, Safari 16 and Firefox 159 expose them as a WebGL extension; the share of real GPUs that support it was not measured.
- **Some limits are real browser limits.** Chromium 153 keeps 16 live WebGL contexts per page and evicts the oldest on the 17th. WebCodecs decodes H.264, VP8, VP9 and AV1 in software here; HEVC is not supported. Encoding was not tested: the test videos were made with ffmpeg.
- **Data.** Hugging Face and the GitHub website are blocked from the shell. Real weights for MobileSAM, EfficientSAM-Ti and SAM 2 tiny came from npm packages and raw GitHub files. EdgeSAM, LiteMedSAM and SAM ViT-B ran with random weights. A random-weight SAM 2.1 tiny export differed from the real one by 10 to 27% in encode time, so those rows are indicative to about 30%. Real public DICOM from the Imaging Data Commons is reachable. No patient data is committed to any branch.

Every benchmark also runs in desktop Chrome. For the GPU-bound ones I'll ask you to run them on your own hardware; the command will be in each branch's REPORT.md.
