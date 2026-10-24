import { describe, expect, it } from 'vitest';
import type { EncodeView } from '@osdlabel/segmentation';
import {
  createRemoteEncoder,
  decodeWire,
  encodeWire,
  float16ToFloat32,
  float32ToFloat16,
} from '../../src/index.js';

const view: EncodeView = {
  imageKey: 'img',
  imageSize: { width: 100_000, height: 80_000 },
  region: { x: 10_000, y: 20_000, width: 16_384, height: 9_216 },
  scale: 1024 / 16_384,
};

describe('wire format', () => {
  it('round-trips float32, float16 and uint8 blobs with metadata', () => {
    const a = Float32Array.from([0, 1.5, -2.25, 1000, 3.14159]);
    const b = new Uint8Array([1, 0, 1]);
    const bytes = encodeWire(
      [
        { name: 'a32', dims: [5], data: a },
        { name: 'a16', dims: [5], data: a, dtype: 'float16' },
        { name: 'b', dims: [3], data: b },
      ],
      { hello: 'world' },
    );
    const { blobs, meta } = decodeWire<{ hello: string }>(bytes.slice().buffer);
    expect(meta.hello).toBe('world');
    expect(Array.from(blobs[0]!.data)).toEqual(Array.from(a));
    const half = blobs[1]!.data as Float32Array;
    for (let i = 0; i < a.length; i++)
      expect(Math.abs(half[i]! - a[i]!)).toBeLessThan(Math.abs(a[i]!) * 1e-3 + 1e-6);
    expect(Array.from(blobs[2]!.data)).toEqual([1, 0, 1]);
  });

  it('float16 keeps SAM embedding magnitudes within 0.1% relative error', () => {
    const x = Float32Array.from({ length: 1000 }, (_, i) => Math.sin(i) * 3);
    const y = float16ToFloat32(float32ToFloat16(x));
    for (let i = 0; i < x.length; i++)
      expect(Math.abs(y[i]! - x[i]!)).toBeLessThanOrEqual(Math.abs(x[i]!) * 1e-3 + 1e-4);
  });
});

describe('remote encoder', () => {
  it('posts the view and decodes the embedding from the wire', async () => {
    const emb = new Float32Array(256 * 64 * 64).fill(0.25);
    let posted: unknown = null;
    const fakeFetch: typeof fetch = async (_url, init) => {
      posted = JSON.parse(String(init?.body));
      const body = encodeWire(
        [{ name: 'image_embeddings', dims: [1, 256, 64, 64], data: emb, dtype: 'float16' }],
        {
          timings: { serverEncode: 12 },
        },
      );
      return new Response(body.slice().buffer);
    };
    const enc = createRemoteEncoder({
      url: '/api/sam/encode',
      inputSize: 1024,
      fetch: fakeFetch,
      // The app passes the decoder package's builder here (segmentation-onnx's
      // samEmbeddingFromTensors); this package never knows the model family.
      toEmbedding: (blobs, v) => ({ view: v, tensor: blobs[0]! }),
      bytesOf: (e) => e.tensor.data.byteLength,
    });
    const out = await enc.encode(view, new AbortController().signal);
    expect(posted).toMatchObject({ view: { imageKey: 'img' }, dtype: 'float16' });
    expect(out.embedding.view).toBe(view);
    expect(out.embedding.tensor.name).toBe('image_embeddings');
    expect(out.embedding.tensor.data[10]).toBe(0.25);
    expect(out.bytes).toBe(4 * 256 * 64 * 64);
    expect(out.timings?.['serverEncode']).toBe(12);
    expect(out.timings?.['wireBytes']).toBeGreaterThan(2 * 256 * 64 * 64);
  });
});
