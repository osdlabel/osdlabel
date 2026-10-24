import { describe, expect, it } from 'vitest';
import type {
  FrameResult,
  PropagateRequest,
  RasterMask,
  SegmentationSession,
  SegmentationSessionBackend,
  SessionCapabilities,
} from '../../src/index.js';

/**
 * The draft session contract has no real backend in the PoC; this fake
 * (a SAM 2-style tracker that shifts the prompted mask by one pixel per frame)
 * checks the shape composes: prompts per frame and object, streamed
 * propagation in both directions, and that aborting stops the stream.
 */
const CAPS: SessionCapabilities = {
  box: true,
  negativePoints: true,
  multimask: false,
  maskInput: true,
  inputSize: 1024,
  axis: 'slice',
  propagate: true,
  volumetric: false,
  scribble: false,
  lasso: false,
  multiObject: true,
};

function square(x: number): RasterMask {
  return {
    frame: { originX: x, originY: 0, pixelWidth: 1, pixelHeight: 1, width: 2, height: 2 },
    data: new Uint8Array([1, 1, 1, 1]),
  };
}

function fakeBackend(frameCount: number): SegmentationSessionBackend {
  return {
    capabilities: CAPS,
    async openSession() {
      const seeds = new Map<number, { frame: number; x: number }>();
      const session: SegmentationSession = {
        capabilities: CAPS,
        async addPrompt(frame, objectId, prompt) {
          const x = prompt.kind === 'points-box' ? (prompt.points?.[0]?.x ?? 0) : 0;
          seeds.set(objectId, { frame, x });
          return [{ frame, objectId, mask: square(x), partial: false }];
        },
        async *propagate(req: PropagateRequest, signal) {
          const ids = req.objectIds ?? [...seeds.keys()];
          const dirs =
            req.direction === 'both' ? [1, -1] : req.direction === 'forward' ? [1] : [-1];
          for (const d of dirs) {
            const end = req.to ?? (d > 0 ? frameCount - 1 : 0);
            for (let f = req.from + d; d > 0 ? f <= end : f >= end; f += d) {
              if (signal.aborted) return;
              await Promise.resolve();
              for (const objectId of ids) {
                const seed = seeds.get(objectId)!;
                yield {
                  frame: f,
                  objectId,
                  mask: square(seed.x + (f - seed.frame)),
                  partial: false,
                };
              }
            }
          }
        },
        async reset(objectId) {
          if (objectId === undefined) seeds.clear();
          else seeds.delete(objectId);
        },
        async close() {},
      };
      return session;
    },
  };
}

describe('SegmentationSession (draft contract)', () => {
  it('prompts one slice, then streams the propagation both ways', async () => {
    const backend = fakeBackend(5);
    const signal = new AbortController().signal;
    const s = await backend.openSession(
      {
        imageKey: 'ct',
        variant: 'wl=40/400',
        frameCount: 5,
        frameSize: { width: 512, height: 512 },
      },
      signal,
    );
    const first = await s.addPrompt(
      2,
      7,
      { kind: 'points-box', points: [{ x: 10, y: 0, label: 1 }] },
      signal,
    );
    expect(first[0]!.frame).toBe(2);
    const seen: FrameResult[] = [];
    for await (const r of s.propagate({ from: 2, direction: 'both' }, signal)) seen.push(r);
    expect(seen.map((r) => r.frame)).toEqual([3, 4, 1, 0]);
    expect(seen.map((r) => r.mask.frame.originX)).toEqual([11, 12, 9, 8]);
  });

  it('stops streaming when aborted', async () => {
    const backend = fakeBackend(100);
    const controller = new AbortController();
    const s = await backend.openSession(
      { imageKey: 'us', frameCount: 100, frameSize: { width: 64, height: 64 } },
      controller.signal,
    );
    await s.addPrompt(
      0,
      1,
      { kind: 'points-box', points: [{ x: 0, y: 0, label: 1 }] },
      controller.signal,
    );
    let n = 0;
    for await (const r of s.propagate({ from: 0, direction: 'forward' }, controller.signal)) {
      void r;
      if (++n === 3) controller.abort();
    }
    expect(n).toBe(3);
  });
});
