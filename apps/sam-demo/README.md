# @osdlabel/sam-demo

A runnable demo of the **live-weights** auto-segmentation path: real MobileSAM
inference (ONNX) driving the osdlabel `segmentation` tool.

Topology (see the [Auto-Segmentation guide](../docs/src/content/docs/guides/auto-segmentation.md)):

- **Encode (server):** a Vite dev-server middleware (`POST /api/sam/embed`) runs
  the MobileSAM **image encoder** in Node (`sharp` + `onnxruntime-web`) and returns
  the `[1,256,64,64]` embedding.
- **Decode (browser):** `@osdlabel/segmentation-onnx`'s `OnnxSamDecoder` runs the
  MobileSAM **decoder** via `onnxruntime-web` (WebGPU, with WASM fallback), then
  vectorizes the mask to a polygon.

Both halves are composed by `createOnnxSamProvider` — this app adds no new
library code, only wiring + assets.

## Run

1. **Get the models.** Export MobileSAM to ONNX (encoder + decoder) — e.g. with
   [samexporter](https://github.com/vietanhdev/samexporter) — or use a community
   ONNX release, then:

   ```bash
   SAM_ENCODER_URL=<encoder.onnx url> SAM_DECODER_URL=<decoder.onnx url> \
     pnpm --filter @osdlabel/sam-demo fetch-models
   ```

   (Or drop the files directly at `public/models/mobile_sam_encoder.onnx` and
   `public/models/mobile_sam_decoder.onnx`.)

2. **Start it** (copies the ORT WASM into `public/ort/`, then serves):

   ```bash
   pnpm --filter @osdlabel/sam-demo dev
   ```

3. Open the page, pick the **Segment** tool, **drag a box** (or click foreground
   points; Alt-click for background), and press **Enter** to commit the polygon.

## Notes

- **Execution provider:** WebGPU is used when available (fast); otherwise the
  threaded WASM backend, which is why the dev server sets `Cross-Origin-Opener-Policy`
  / `Cross-Origin-Embedder-Policy`. The demo uses a single local image so COEP
  won't block anything.
- **Decoder mask space:** the default `maskSpace: 'original'` assumes the decoder
  export upscales masks to `orig_im_size`. If yours returns model-resolution masks,
  set it to `'model'` in `src/App.tsx`.
- **Tensor names:** override via `SAM_ENCODER_INPUT` / `SAM_ENCODER_OUTPUT` (server)
  or the decoder's `inputNames` / `outputNames` if your export differs from the
  Segment Anything defaults.
- **Node ORT fallback:** if `onnxruntime-web` is unreliable in Node on your
  platform, swap the encoder middleware to `onnxruntime-node`.
- Models and ORT WASM are git-ignored; nothing heavy is committed.
