import { describe, expect, it } from 'vitest';
import type { SegmentationProvider } from '@osdlabel/segmentation';
import {
  WorkerSegmentationProvider,
  serveSegmentationWorker,
  type MessagePortLike,
} from '../../src/index.js';

describe('worker RPC', () => {
  /** An in-memory MessageChannel pair. */
  function channel(): [MessagePortLike, MessagePortLike] {
    const listeners: [((e: MessageEvent) => void)[], ((e: MessageEvent) => void)[]] = [[], []];
    const make = (self: 0 | 1): MessagePortLike => ({
      postMessage: (message) => {
        queueMicrotask(() => {
          for (const l of listeners[self === 0 ? 1 : 0]) l({ data: message } as MessageEvent);
        });
      },
      addEventListener: (_t, l) => listeners[self].push(l),
    });
    return [make(0), make(1)];
  }

  it('proxies segment, propagates errors and aborts', async () => {
    const [main, worker] = channel();
    let aborted = false;
    const provider: SegmentationProvider = {
      capabilities: {
        box: true,
        negativePoints: true,
        multimask: true,
        maskInput: false,
        inputSize: 1024,
      },
      async segment(target, prompt, signal) {
        if (prompt.points?.[0]?.label === 0) throw new Error('nope');
        if (prompt.points?.[0]?.x === 99) {
          await new Promise((r) => setTimeout(r, 20));
          aborted = signal.aborted;
          throw new DOMException('Aborted', 'AbortError');
        }
        return {
          view: {
            imageKey: target.imageKey,
            imageSize: target.imageSize,
            region: target.viewport,
            scale: 1,
          },
          candidates: [
            {
              predictedIou: 0.9,
              mask: {
                frame: {
                  originX: 0,
                  originY: 0,
                  pixelWidth: 1,
                  pixelHeight: 1,
                  width: 1,
                  height: 1,
                },
                data: new Float32Array([1]),
              },
            },
          ],
        };
      },
    };
    serveSegmentationWorker<{ model: string }>(worker, async () => ({
      provider,
      info: { ok: true },
    }));
    const client = new WorkerSegmentationProvider<{ model: string }>(main);
    expect(await client.init({ model: 'x' })).toEqual({ ok: true });
    expect(client.capabilities.inputSize).toBe(1024);
    const target = {
      imageKey: 'a',
      imageSize: { width: 10, height: 10 },
      viewport: { x: 0, y: 0, width: 10, height: 10 },
      viewportScale: 1,
    };
    const r = await client.segment(
      target,
      { points: [{ x: 1, y: 1, label: 1 }] },
      new AbortController().signal,
    );
    expect(r.candidates[0]!.predictedIou).toBe(0.9);
    await expect(
      client.segment(target, { points: [{ x: 1, y: 1, label: 0 }] }, new AbortController().signal),
    ).rejects.toThrow('nope');
    const ctrl = new AbortController();
    const p = client.segment(target, { points: [{ x: 99, y: 1, label: 1 }] }, ctrl.signal);
    ctrl.abort();
    await expect(p).rejects.toMatchObject({ name: 'AbortError' });
    expect(aborted).toBe(true);
  });
});
