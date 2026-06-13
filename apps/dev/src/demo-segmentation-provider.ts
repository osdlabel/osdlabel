import type { Point, SegmentationProvider, SegmentationResult } from '@osdlabel/solid';

/**
 * A stand-in {@link SegmentationProvider} for the dev harness. It runs no real
 * model — it synthesizes a plausible "mask" contour from the prompt so the
 * segmentation tool's full interaction loop (prepare → segment → preview →
 * commit) can be exercised without bundling ONNX/WebGPU weights.
 *
 * - A box prompt yields an ellipse-like ring inscribed in the box.
 * - Point prompts yield a blob centered on the foreground points' centroid.
 */
function ring(cx: number, cy: number, rx: number, ry: number, segments = 24): Point[] {
  return Array.from({ length: segments }, (_, i) => {
    const a = (i / segments) * Math.PI * 2;
    return { x: cx + rx * Math.cos(a), y: cy + ry * Math.sin(a) };
  });
}

export const demoSegmentationProvider: SegmentationProvider = {
  async prepare(_image, signal) {
    // Pretend to compute an image embedding.
    await delay(200, signal);
  },

  async segment(_image, prompt, signal): Promise<SegmentationResult> {
    // Simulate decoder latency so the abort/stale-result path is exercised.
    await delay(120, signal);

    if (prompt.box) {
      const { x, y, width, height } = prompt.box;
      return {
        contours: [ring(x + width / 2, y + height / 2, width / 2, height / 2)],
        score: 0.92,
      };
    }

    const points = prompt.points ?? [];
    const fg = points.filter((p) => p.label === 1);
    const src = fg.length > 0 ? fg : points;
    if (src.length === 0) return { contours: [] };

    const cx = src.reduce((s, p) => s + p.x, 0) / src.length;
    const cy = src.reduce((s, p) => s + p.y, 0) / src.length;
    // Background clicks shrink the blob a little, mimicking refinement.
    const negatives = points.length - fg.length;
    const radius = Math.max(20, 80 - negatives * 15);
    return { contours: [ring(cx, cy, radius, radius)], score: 0.8 };
  },
};

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
