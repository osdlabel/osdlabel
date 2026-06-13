import { describe, it, expect } from 'vitest';
import type { ImageId } from '@osdlabel/viewer-api';
import { composeSegmentationProvider } from '../../src/compose.js';
import type { SegmentationEncoder } from '../../src/encoder.js';
import type { SegmentationDecoder } from '../../src/decoder.js';
import type { SegmentationImageRef, SegmentationResult } from '../../src/segmentation-provider.js';

const img = (s: string): ImageId => s as ImageId;
const ref = (id: string): SegmentationImageRef => ({
  imageId: img(id),
  tileSource: `${id}.png`,
  getViewportCanvas: () => null,
});

const RESULT: SegmentationResult = { contours: [[{ x: 0, y: 0 }]] };

interface TrackedEncoder extends SegmentationEncoder<string> {
  calls: number;
  lastSignal: AbortSignal | null;
  disposed: ImageId[];
}

function trackingEncoder(impl?: (id: ImageId) => Promise<string>): TrackedEncoder {
  return {
    calls: 0,
    lastSignal: null,
    disposed: [],
    async encode(image, signal) {
      this.calls += 1;
      this.lastSignal = signal;
      return impl ? impl(image.imageId) : `emb:${image.imageId}`;
    },
    dispose(id) {
      this.disposed.push(id);
    },
  };
}

function passthroughDecoder(): SegmentationDecoder<string> & { embeddings: string[] } {
  return {
    embeddings: [],
    async decode(embedding) {
      this.embeddings.push(embedding);
      return RESULT;
    },
  };
}

describe('composeSegmentationProvider', () => {
  it('encodes once per image and reuses the cached embedding', async () => {
    const enc = trackingEncoder();
    const dec = passthroughDecoder();
    const provider = composeSegmentationProvider(enc, dec);

    await provider.prepare(ref('a'), new AbortController().signal);
    await provider.prepare(ref('a'), new AbortController().signal);
    await provider.segment(
      ref('a'),
      { points: [{ x: 1, y: 1, label: 1 }] },
      new AbortController().signal,
    );

    expect(enc.calls).toBe(1);
    expect(dec.embeddings).toEqual(['emb:a']);
  });

  it('segment without a prior prepare still triggers (one) encode', async () => {
    const enc = trackingEncoder();
    const dec = passthroughDecoder();
    const provider = composeSegmentationProvider(enc, dec);

    await provider.segment(
      ref('b'),
      { box: { x: 0, y: 0, width: 4, height: 4 } },
      new AbortController().signal,
    );

    expect(enc.calls).toBe(1);
    expect(dec.embeddings).toEqual(['emb:b']);
  });

  it('evicts a failed encode so the next call retries', async () => {
    let attempt = 0;
    const enc = trackingEncoder(async () => {
      attempt += 1;
      if (attempt === 1) throw new Error('boom');
      return 'ok';
    });
    const dec = passthroughDecoder();
    const provider = composeSegmentationProvider(enc, dec);

    await expect(provider.prepare(ref('c'), new AbortController().signal)).rejects.toThrow('boom');
    // Second attempt should re-encode rather than reuse the rejected promise.
    await provider.segment(
      ref('c'),
      { points: [{ x: 1, y: 1, label: 1 }] },
      new AbortController().signal,
    );

    expect(enc.calls).toBe(2);
    expect(dec.embeddings).toEqual(['ok']);
  });

  it('does not cancel the encode when a prompt signal is already aborted', async () => {
    const enc = trackingEncoder();
    const dec = passthroughDecoder();
    const provider = composeSegmentationProvider(enc, dec);

    const aborted = new AbortController();
    aborted.abort();
    await provider.segment(ref('d'), { points: [{ x: 1, y: 1, label: 1 }] }, aborted.signal);

    // The encode ran under the cache's own controller, not the aborted prompt signal.
    expect(enc.calls).toBe(1);
    expect(enc.lastSignal?.aborted).toBe(false);
  });

  it('dispose evicts the cache and forwards to the encoder', async () => {
    const enc = trackingEncoder();
    const dec = passthroughDecoder();
    const provider = composeSegmentationProvider(enc, dec);

    await provider.prepare(ref('e'), new AbortController().signal);
    provider.dispose?.(img('e'));
    await provider.segment(
      ref('e'),
      { points: [{ x: 1, y: 1, label: 1 }] },
      new AbortController().signal,
    );

    expect(enc.disposed).toEqual([img('e')]);
    expect(enc.calls).toBe(2); // re-encoded after disposal
  });
});
