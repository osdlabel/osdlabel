import { describe, it, expect, vi } from 'vitest';
import type { ImageId } from '@osdlabel/viewer-api';
import type { SegmentationImageRef } from '@osdlabel/segmentation';
import { RemoteEmbeddingEncoder } from '../../src/remote-embedding-encoder.js';
import type { SamEmbedding } from '../../src/sam-embedding.js';

const imageRef: SegmentationImageRef = {
  imageId: 'img-1' as ImageId,
  tileSource: 'https://example.test/image.png',
  getViewportCanvas: () => null,
};

function float32ToBase64(arr: Float32Array): string {
  const bytes = new Uint8Array(arr.buffer);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]!);
  return btoa(binary);
}

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    statusText: ok ? 'OK' : 'Error',
    json: async () => body,
  } as unknown as Response;
}

describe('RemoteEmbeddingEncoder', () => {
  it('POSTs the image ref and parses the default JSON embedding payload', async () => {
    const tensor = new Float32Array([0.1, 0.2, 0.3, 0.4]);
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        dims: [1, 256, 64, 64],
        origWidth: 800,
        origHeight: 600,
        inputSize: 1024,
        embedding: float32ToBase64(tensor),
      }),
    );
    const encoder = new RemoteEmbeddingEncoder({ endpoint: '/embed', fetch: fetchImpl });

    const result = await encoder.encode(imageRef, new AbortController().signal);

    expect(fetchImpl).toHaveBeenCalledOnce();
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe('/embed');
    expect(init?.method).toBe('POST');
    expect(JSON.parse(init?.body as string)).toEqual({
      imageId: 'img-1',
      tileSource: 'https://example.test/image.png',
    });
    expect(result.origWidth).toBe(800);
    expect(result.origHeight).toBe(600);
    expect(result.inputSize).toBe(1024);
    expect(result.embedding.dims).toEqual([1, 256, 64, 64]);
    expect(Array.from(result.embedding.data)).toEqual([
      expect.closeTo(0.1),
      expect.closeTo(0.2),
      expect.closeTo(0.3),
      expect.closeTo(0.4),
    ]);
  });

  it('forwards the abort signal and custom headers', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ dims: [1], origWidth: 1, origHeight: 1, inputSize: 1024, embedding: '' }),
    );
    const encoder = new RemoteEmbeddingEncoder({
      endpoint: '/e',
      fetch: fetchImpl,
      headers: { authorization: 'Bearer t' },
    });
    const ac = new AbortController();
    await encoder.encode(imageRef, ac.signal);
    const init = fetchImpl.mock.calls[0]![1];
    expect(init?.signal).toBe(ac.signal);
    expect((init?.headers as Record<string, string>).authorization).toBe('Bearer t');
  });

  it('throws on a non-OK response', async () => {
    const encoder = new RemoteEmbeddingEncoder({
      endpoint: '/e',
      fetch: async () => jsonResponse({}, false, 500),
    });
    await expect(encoder.encode(imageRef, new AbortController().signal)).rejects.toThrow(/500/);
  });

  it('uses a custom parse hook (e.g. binary payloads)', async () => {
    const custom: SamEmbedding = {
      embedding: { data: new Float32Array([9]), dims: [1, 256, 64, 64] },
      origWidth: 10,
      origHeight: 20,
      inputSize: 1024,
    };
    const encoder = new RemoteEmbeddingEncoder({
      endpoint: '/e',
      fetch: async () => jsonResponse({}),
      parse: async () => custom,
    });
    const result = await encoder.encode(imageRef, new AbortController().signal);
    expect(result).toBe(custom);
  });
});
