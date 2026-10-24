import { describe, expect, it } from 'vitest';
import type { SegmentationPrompt, SegmentationTarget } from '@osdlabel/segmentation';
import {
  createServiceSegmentationProvider,
  type SegmentationServiceAdapter,
} from '../../src/index.js';

const target = (imageKey: string): SegmentationTarget => ({
  imageKey,
  imageSize: { width: 50_000, height: 40_000 },
  viewport: { x: 1000, y: 2000, width: 4000, height: 2500 },
  viewportScale: 0.32,
});

/**
 * A stand-in for a stateful service (nnInteractive-like): it keeps the
 * interactions per session and answers with a label raster placed in image
 * space. Records what the provider asked of it.
 */
function fakeService(): {
  adapter: SegmentationServiceAdapter<{ id: number; interactions: number }>;
  log: string[];
} {
  const log: string[] = [];
  let next = 0;
  return {
    log,
    adapter: {
      capabilities: {
        box: true,
        negativePoints: true,
        multimask: false,
        maskInput: false,
        inputSize: null,
      },
      async open(t) {
        log.push(`open ${t.imageKey}`);
        await new Promise((r) => setTimeout(r, 5));
        if (t.imageKey === 'broken') throw new Error('upload failed');
        return { id: next++, interactions: 0 };
      },
      async infer(session, t, prompt: SegmentationPrompt) {
        session.interactions++;
        log.push(
          `infer ${session.id} #${session.interactions} (${prompt.points?.length ?? 0} pts)`,
        );
        return {
          candidates: [
            {
              predictedIou: 1,
              mask: {
                frame: {
                  originX: t.viewport.x,
                  originY: t.viewport.y,
                  pixelWidth: 4,
                  pixelHeight: 4,
                  width: 2,
                  height: 1,
                },
                data: new Uint8Array([1, 0]),
              },
            },
          ],
          timings: { server: 3 },
        };
      },
      async close(session) {
        log.push(`close ${session.id}`);
      },
    },
  };
}

describe('createServiceSegmentationProvider', () => {
  it('opens one session per image, shared by concurrent first prompts, and reuses it', async () => {
    const { adapter, log } = fakeService();
    const provider = createServiceSegmentationProvider(adapter);
    const signal = new AbortController().signal;
    const p = { points: [{ x: 1500, y: 2500, label: 1 as const }] };
    const [a, b] = await Promise.all([
      provider.segment(target('slide'), p, signal),
      provider.segment(target('slide'), p, signal),
    ]);
    const c = await provider.segment(target('slide'), p, signal);
    expect(log.filter((l) => l.startsWith('open'))).toEqual(['open slide']);
    expect([a.cached, b.cached, c.cached]).toEqual([false, true, true]);
    expect(log).toContain('infer 0 #3 (1 pts)');
    // The answer is placed in image space; the view reports its resolution.
    expect(c.candidates[0]!.mask.frame.originX).toBe(1000);
    expect(c.view.scale).toBe(0.25);
    expect(c.view.region).toEqual(target('slide').viewport);
    expect(c.timings?.['server']).toBe(3);
  });

  it('does not keep a failed open, and closes sessions on dispose', async () => {
    const { adapter, log } = fakeService();
    const provider = createServiceSegmentationProvider(adapter);
    const signal = new AbortController().signal;
    const p = { points: [{ x: 1, y: 1, label: 1 as const }] };
    await expect(provider.segment(target('broken'), p, signal)).rejects.toThrow('upload failed');
    await expect(provider.segment(target('broken'), p, signal)).rejects.toThrow('upload failed');
    expect(log.filter((l) => l === 'open broken')).toHaveLength(2);
    await provider.segment(target('a'), p, signal);
    await provider.segment(target('b'), p, signal);
    provider.dispose?.('a');
    await new Promise((r) => setTimeout(r, 0));
    expect(log.filter((l) => l.startsWith('close'))).toEqual(['close 0']);
    provider.dispose?.();
    await new Promise((r) => setTimeout(r, 0));
    expect(log.filter((l) => l.startsWith('close'))).toEqual(['close 0', 'close 1']);
  });
});
