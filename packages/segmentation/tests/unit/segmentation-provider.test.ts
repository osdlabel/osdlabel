import { describe, it, expect } from 'vitest';
import type {
  SegmentationProvider,
  SegmentationImageRef,
  SegmentationResult,
} from '../../src/index.js';
import type { ImageId } from '@osdlabel/viewer-api';

const imageId = 'img-1' as ImageId;

function createImageRef(): SegmentationImageRef {
  return {
    imageId,
    tileSource: 'https://example.test/image.png',
    getViewportCanvas: () => null,
  };
}

describe('SegmentationProvider contract', () => {
  it('supports the prepare-then-segment lifecycle', async () => {
    const calls: string[] = [];
    const provider: SegmentationProvider = {
      async prepare(_image, _signal) {
        calls.push('prepare');
      },
      async segment(_image, prompt, _signal): Promise<SegmentationResult> {
        calls.push('segment');
        expect(prompt.box).toEqual({ x: 0, y: 0, width: 10, height: 10 });
        return {
          contours: [
            [
              { x: 0, y: 0 },
              { x: 10, y: 0 },
              { x: 10, y: 10 },
              { x: 0, y: 10 },
            ],
          ],
          score: 0.9,
        };
      },
    };

    const ref = createImageRef();
    const controller = new AbortController();
    await provider.prepare(ref, controller.signal);
    const result = await provider.segment(
      ref,
      { box: { x: 0, y: 0, width: 10, height: 10 } },
      controller.signal,
    );

    expect(calls).toEqual(['prepare', 'segment']);
    expect(result.contours).toHaveLength(1);
    expect(result.contours[0]).toHaveLength(4);
    expect(result.score).toBe(0.9);
  });

  it('rejects when the prompt is aborted', async () => {
    const provider: SegmentationProvider = {
      async prepare() {},
      segment(_image, _prompt, signal): Promise<SegmentationResult> {
        return new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(new Error('aborted')));
        });
      },
    };

    const controller = new AbortController();
    const pending = provider.segment(
      createImageRef(),
      { points: [{ x: 1, y: 1, label: 1 }] },
      controller.signal,
    );
    controller.abort();
    await expect(pending).rejects.toThrow('aborted');
  });
});
