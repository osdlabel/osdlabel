import {
  composeSegmentationProvider,
  maskToContours,
  type Point,
  type SegmentationDecoder,
  type SegmentationEncoder,
  type SegmentationMask,
  type SegmentationProvider,
  type SegmentationResult,
} from '@osdlabel/solid';

/**
 * A stand-in {@link SegmentationProvider} for the dev harness, built via
 * {@link composeSegmentationProvider} to dogfood the modular encode/decode
 * contract. It runs no real model: the "encoder" just simulates latency, and the
 * "decoder" rasterizes a plausible blob from the prompt into a real
 * {@link SegmentationMask}, then runs the library's actual {@link maskToContours}
 * — so the full prepare → segment → vectorize → preview → commit loop (and the
 * helper) are exercised without bundling ONNX/WebGPU weights.
 */
interface DemoEmbedding {
  readonly token: string;
}

const demoEncoder: SegmentationEncoder<DemoEmbedding> = {
  async encode(image, signal) {
    await delay(200, signal); // pretend to compute an image embedding
    return { token: `emb:${image.imageId}` };
  },
};

const demoDecoder: SegmentationDecoder<DemoEmbedding> = {
  async decode(_embedding, _image, prompt, signal) {
    await delay(120, signal); // pretend to run the decoder

    if (prompt.box) {
      const { x, y, width, height } = prompt.box;
      return rasterizeEllipse(x + width / 2, y + height / 2, width / 2, height / 2, 0.92);
    }

    const points = prompt.points ?? [];
    const fg = points.filter((p) => p.label === 1);
    const src = fg.length > 0 ? fg : points;
    if (src.length === 0) return { contours: [] };
    const cx = src.reduce((s, p) => s + p.x, 0) / src.length;
    const cy = src.reduce((s, p) => s + p.y, 0) / src.length;
    // Background clicks shrink the blob a little, mimicking refinement.
    const r = Math.max(20, 80 - (points.length - fg.length) * 15);
    return rasterizeEllipse(cx, cy, r, r, 0.8);
  },
};

export const demoSegmentationProvider: SegmentationProvider = composeSegmentationProvider(
  demoEncoder,
  demoDecoder,
);

/**
 * Rasterizes a filled ellipse into a local mask grid, vectorizes it with the
 * real {@link maskToContours}, and offsets the rings back into image space.
 */
function rasterizeEllipse(
  cx: number,
  cy: number,
  rx: number,
  ry: number,
  score: number,
): SegmentationResult {
  const pad = 2;
  const originX = Math.floor(cx - rx) - pad;
  const originY = Math.floor(cy - ry) - pad;
  const w = Math.ceil(rx * 2) + pad * 2;
  const h = Math.ceil(ry * 2) + pad * 2;
  const data = new Uint8Array(w * h);
  const lcx = cx - originX;
  const lcy = cy - originY;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const nx = (x - lcx) / rx;
      const ny = (y - lcy) / ry;
      if (nx * nx + ny * ny <= 1) data[y * w + x] = 1;
    }
  }
  const mask: SegmentationMask = { width: w, height: h, data };
  const contours = maskToContours(mask, { simplifyTolerance: 1.5 }).map((ring) =>
    ring.map((p): Point => ({ x: p.x + originX, y: p.y + originY })),
  );
  return { contours, score };
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new DOMException('Aborted', 'AbortError'));
      return;
    }
    const id = setTimeout(resolve, ms);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(id);
        reject(new DOMException('Aborted', 'AbortError'));
      },
      { once: true },
    );
  });
}
