# Browser-platform probes

The research behind [landscape.md](../../landscape.md) and the platform limits in [roadmap.md](../../roadmap.md) measured the browser directly instead of trusting documentation. These are those probes, kept as they ran in a Linux container on October 23 and 24, 2026, with headless Chromium and SwiftShader. Paths inside them point at that container, so adjust them before rerunning.

Only the scripts and their small results are committed. The large or third-party inputs are not: the OpenSeadragon 5.0.1 and 6.1.1 builds and mediabunny (from npm), the Cornerstone codec WebAssembly builds (`@cornerstonejs/codec-*`), and the synthetic test images and videos the pages fetch (`ct512_*`, `dx3072_u16.raw`, `us800*`, `v*_*.mp4`/`.webm`, `big.bin`).

| File                                                                  | What it measures                                                                                                                              |
| --------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `run.mjs`                                                             | Loads a page in Chromium with optional flags, waits for `window.__results` and prints it as JSON                                              |
| `server.mjs`                                                          | Serves `www/` with a cross-origin isolation mode chosen by the first path segment (COOP/COEP, Document-Isolation-Policy)                      |
| `server2.mjs`                                                         | A cross-origin "tile server" without CORP headers, for `xo.html`                                                                              |
| `ctxlimit.cjs`, `ctxblank.cjs`, `ctxblank6.cjs`, `ctxblank6b.cjs`     | How many OpenSeadragon viewers with WebGL drawers a page can hold before cells go blank, on OpenSeadragon 5.0.1 and 6.1.1                     |
| `grid24_openseadragon.min.js.png`, `grid24_openseadragon6.min.js.png` | A 24-cell grid on OpenSeadragon 5.0.1 (8 blank cells) and 6.1.1                                                                               |
| `www/osdgrid.html`, `www/osdgrid2.html`, `www/osdgrid6.html`          | The grid pages those scripts drive                                                                                                            |
| `www/workergl.html`                                                   | WebGL2 contexts created on `OffscreenCanvas` in a worker, and how many are lost                                                               |
| `www/probe.html`, `www/probe.js`                                      | Feature probe: isolation and SharedArrayBuffer, WebGL contexts, WebGPU, the largest ArrayBuffer, codecs, OPFS, range fetches                  |
| `www/abmax.html`, `www/commit.html`                                   | The largest single ArrayBuffer, and how many 1 GiB buffers can be committed                                                                   |
| `www/xo.html`                                                         | Which cross-origin images still load under each isolation mode                                                                                |
| `www/dstream.html`                                                    | `DecompressionStream` speed on a gzipped 3072×3072 16-bit image                                                                               |
| `www/hbd.html`                                                        | Whether 16-bit PNG, lossless JPEG XL and 12-bit AVIF images keep their precision when decoded through a WebGL float texture or `ImageDecoder` |
| `www/codecbench.html`, `codec-bench-node.json`                        | DICOM codecs (HTJ2K, JPEG 2000, JPEG-LS, JPEG) compiled to WebAssembly, in the browser and under Node                                         |
| `www/seek.html`                                                       | Frame-exact seeking with WebCodecs over mediabunny                                                                                            |
| `www/hbdvideo.html`                                                   | Decoding 10- and 12-bit video                                                                                                                 |
| `www/holdframes.html`                                                 | How many decoded `VideoFrame`s a decoder lets the page hold before it stalls                                                                  |
| `interp.mjs`                                                          | How polygon keyframe interpolation depends on vertex correspondence                                                                           |
| `decode-exp.mjs`, `decode-exp-results.json`                           | SAM prompt-decoder latency per click, worker against main thread and 1 against 4 threads, through `claude/poc-sam`'s harness                  |
