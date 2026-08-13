import { describe, it, expect, vi } from 'vitest';
import type { ImageId } from '@osdlabel/viewer-api';
import type { Point, SegmentationImageRef, SegmentationPrompt } from '@osdlabel/segmentation';
import { OnnxSamDecoder } from '../../src/onnx-sam-decoder.js';
import type { SamEmbedding } from '../../src/sam-embedding.js';
import type { SamSession, SamTensor } from '../../src/sam-tensor.js';

const imageRef: SegmentationImageRef = {
  imageId: 'img' as ImageId,
  tileSource: 'x',
  getViewportCanvas: () => null,
};
const prompt: SegmentationPrompt = { points: [{ x: 5, y: 5, label: 1 }] };

/** A H×W logit plane: `inside` within `[x0,x1)×[y0,y1)`, `outside` elsewhere. */
function squarePlane(
  h: number,
  w: number,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  inside = 1,
  outside = -1,
): Float32Array {
  const a = new Float32Array(h * w).fill(outside);
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) a[y * w + x] = inside;
  return a;
}

function masksTensor(planes: Float32Array[], h: number, w: number): SamTensor {
  const data = new Float32Array(planes.length * h * w);
  planes.forEach((p, i) => data.set(p, i * h * w));
  return { data, dims: [1, planes.length, h, w] };
}

function fakeSession(outputs: Record<string, SamTensor>, dispose = vi.fn()): SamSession {
  return { run: async () => outputs, dispose };
}

function embeddingFor(origWidth: number, origHeight: number, inputSize = 1024): SamEmbedding {
  return {
    embedding: { data: new Float32Array([0]), dims: [1, 256, 64, 64] },
    origWidth,
    origHeight,
    inputSize,
  };
}

const bounds = (pts: readonly Point[]) => ({
  minX: Math.min(...pts.map((p) => p.x)),
  maxX: Math.max(...pts.map((p) => p.x)),
  minY: Math.min(...pts.map((p) => p.y)),
  maxY: Math.max(...pts.map((p) => p.y)),
});

describe('OnnxSamDecoder', () => {
  it('thresholds a logit mask and returns the contour with the IoU score', async () => {
    const masks = masksTensor([squarePlane(12, 12, 3, 3, 9, 9)], 12, 12); // square 3..9
    const session = fakeSession({
      masks,
      iou_predictions: { data: Float32Array.from([0.9]), dims: [1, 1] },
    });
    const decoder = new OnnxSamDecoder({ createSession: async () => session });

    const result = await decoder.decode(
      embeddingFor(12, 12),
      imageRef,
      prompt,
      new AbortController().signal,
    );

    expect(result.contours).toHaveLength(1);
    expect(result.score).toBeCloseTo(0.9);
    const b = bounds(result.contours[0]!);
    expect(b.minX).toBe(3);
    expect(b.maxX).toBe(8);
  });

  it('selects the highest-IoU mask among several', async () => {
    const masks = masksTensor(
      [
        squarePlane(12, 12, 0, 0, 2, 2),
        squarePlane(12, 12, 3, 3, 9, 9),
        squarePlane(12, 12, 5, 5, 7, 7),
      ],
      12,
      12,
    );
    const session = fakeSession({
      masks,
      iou_predictions: { data: Float32Array.from([0.1, 0.9, 0.2]), dims: [1, 3] },
    });
    const decoder = new OnnxSamDecoder({ createSession: async () => session });

    const result = await decoder.decode(
      embeddingFor(12, 12),
      imageRef,
      prompt,
      new AbortController().signal,
    );
    const b = bounds(result.contours[0]!);
    expect(b.minX).toBe(3); // the index-1 square, not the others
    expect(b.maxX).toBe(8);
  });

  it('handles a [1,H,W] masks tensor with no IoU output', async () => {
    const masks: SamTensor = { data: squarePlane(12, 12, 3, 3, 9, 9), dims: [1, 12, 12] };
    const decoder = new OnnxSamDecoder({ createSession: async () => fakeSession({ masks }) });

    const result = await decoder.decode(
      embeddingFor(12, 12),
      imageRef,
      prompt,
      new AbortController().signal,
    );
    expect(result.contours).toHaveLength(1);
    expect(result.score).toBeUndefined();
  });

  it('respects maskThreshold', async () => {
    const masks: SamTensor = {
      data: squarePlane(12, 12, 3, 3, 9, 9, 0.3, -0.3),
      dims: [1, 1, 12, 12],
    };
    const high = new OnnxSamDecoder({
      createSession: async () => fakeSession({ masks }),
      maskThreshold: 0.5,
    });
    const result = await high.decode(
      embeddingFor(12, 12),
      imageRef,
      prompt,
      new AbortController().signal,
    );
    expect(result.contours).toHaveLength(0); // 0.3 logits are below 0.5
  });

  it("maps contours back to image space when maskSpace is 'model'", async () => {
    const masks: SamTensor = { data: squarePlane(12, 12, 2, 2, 10, 10), dims: [1, 1, 12, 12] };
    // origWidth/Height 6, inputSize 12 → scale 2 → modelToImage halves coordinates.
    const decoder = new OnnxSamDecoder({
      createSession: async () => fakeSession({ masks }),
      maskSpace: 'model',
    });
    const result = await decoder.decode(
      embeddingFor(6, 6, 12),
      imageRef,
      prompt,
      new AbortController().signal,
    );
    const b = bounds(result.contours[0]!);
    // Model-space square spans 2..9; image space is that / 2.
    expect(b.minX).toBeCloseTo(1);
    expect(b.maxX).toBeCloseTo(4.5);
  });

  it('throws when the signal is already aborted', async () => {
    const decoder = new OnnxSamDecoder({
      createSession: async () =>
        fakeSession({ masks: masksTensor([squarePlane(4, 4, 0, 0, 2, 2)], 4, 4) }),
    });
    const ac = new AbortController();
    ac.abort();
    await expect(decoder.decode(embeddingFor(4, 4), imageRef, prompt, ac.signal)).rejects.toThrow();
  });

  it('dispose releases the cached session', async () => {
    const dispose = vi.fn();
    const decoder = new OnnxSamDecoder({
      createSession: async () =>
        fakeSession({ masks: masksTensor([squarePlane(4, 4, 0, 0, 2, 2)], 4, 4) }, dispose),
    });
    await decoder.decode(embeddingFor(4, 4), imageRef, prompt, new AbortController().signal);
    decoder.dispose();
    await Promise.resolve();
    expect(dispose).toHaveBeenCalledOnce();
  });
});
