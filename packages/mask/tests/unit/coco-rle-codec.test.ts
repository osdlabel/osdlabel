import { describe, it, expect } from 'vitest';
import {
  BoundedDenseMaskBuffer,
  cocoArea,
  cocoBbox,
  cocoCountsToSnapshot,
  cocoRleCodec,
  cocoRleUncompressedCodec,
  decodeCocoCountsString,
  encodeCocoCountsString,
  isCocoInteropSafe,
  COCO_MAX_INTEROP_IMAGE_PIXELS,
  snapshotToCocoCounts,
  stampCircle,
  type MaskSnapshot,
} from '../../src/index.js';

/**
 * Hand-computed fixture. A 4x3 image with a 2x2 block at (1,1):
 *
 *   . . . .
 *   . X X .
 *   . X X .
 *
 * COCO walks **columns**, so the sequence is
 *   col0: 0 0 0 | col1: 0 1 1 | col2: 0 1 1 | col3: 0 0 0
 * which run-length encodes (starting with background) to [4, 2, 1, 2, 3].
 */
const FIXTURE: MaskSnapshot = {
  x: 1,
  y: 1,
  width: 2,
  height: 2,
  data: Uint8Array.from([1, 1, 1, 1]),
  imageWidth: 4,
  imageHeight: 3,
};
const FIXTURE_COUNTS = [4, 2, 1, 2, 3];

describe('COCO run lengths', () => {
  it('encodes column-major, starting with a background run', () => {
    const counts = snapshotToCocoCounts(FIXTURE);
    expect(counts).toEqual(FIXTURE_COUNTS);
    // Every pixel of the image is accounted for.
    expect(counts.reduce((a, c) => a + c, 0)).toBe(4 * 3);
  });

  it('emits a leading zero-length run when the mask starts at the origin', () => {
    const counts = snapshotToCocoCounts({
      x: 0,
      y: 0,
      width: 1,
      height: 1,
      data: Uint8Array.from([1]),
      imageWidth: 2,
      imageHeight: 2,
    });
    expect(counts[0]).toBe(0); // odd positions are foreground, so counts[0] must be background
    expect(counts).toEqual([0, 1, 3]);
  });

  it('encodes an empty mask as one background run covering the image', () => {
    const empty = new BoundedDenseMaskBuffer({ imageWidth: 5, imageHeight: 4 }).snapshot();
    expect(snapshotToCocoCounts(empty)).toEqual([20]);
  });

  it('restores the mask at its absolute position', () => {
    const restored = cocoCountsToSnapshot(FIXTURE_COUNTS, 3, 4);
    expect(restored).toEqual(FIXTURE);
  });
});

describe('COCO compressed counts string', () => {
  it('matches the hand-computed pycocotools encoding', () => {
    // Deltas against two positions back kick in from index 3:
    // 4, 2, 1, (2-2)=0, (3-1)=2  ->  '4','2','1','0','2'
    expect(encodeCocoCountsString(FIXTURE_COUNTS)).toBe('42102');
  });

  it('round-trips through decode', () => {
    expect(decodeCocoCountsString(encodeCocoCountsString(FIXTURE_COUNTS))).toEqual(FIXTURE_COUNTS);
  });

  it('handles counts far beyond 32 bits (gigapixel images)', () => {
    // A 100k x 100k image has 10^10 pixels, which overflows the 32-bit
    // coercion that JavaScript's bitwise operators would apply.
    const counts = [10_000_000_000, 5, 3, 12, 7];
    expect(decodeCocoCountsString(encodeCocoCountsString(counts))).toEqual(counts);
  });

  it('handles negative deltas', () => {
    const counts = [100, 200, 300, 5, 4];
    expect(decodeCocoCountsString(encodeCocoCountsString(counts))).toEqual(counts);
  });
});

describe('codecs', () => {
  it('reports size as [height, width] of the full image', () => {
    expect(cocoRleCodec.encode(FIXTURE).size).toEqual([3, 4]);
    expect(cocoRleUncompressedCodec.encode(FIXTURE).size).toEqual([3, 4]);
  });

  it('agrees between the compressed and uncompressed variants', () => {
    const b = new BoundedDenseMaskBuffer({ imageWidth: 300, imageHeight: 200 });
    stampCircle(b, 100.5, 80.5, 15, 1);
    stampCircle(b, 105.5, 85.5, 6, 0);
    const snapshot = b.snapshot();

    const compressed = cocoRleCodec.decode!(cocoRleCodec.encode(snapshot));
    const plain = cocoRleUncompressedCodec.decode!(cocoRleUncompressedCodec.encode(snapshot));

    expect(compressed).toEqual(snapshot);
    expect(plain).toEqual(snapshot);
  });

  it('round-trips a mask that is offset from the origin', () => {
    const b = new BoundedDenseMaskBuffer({ imageWidth: 640, imageHeight: 480 });
    stampCircle(b, 500.5, 400.5, 9, 1);
    const snapshot = b.snapshot();

    const restored = cocoRleCodec.decode!(cocoRleCodec.encode(snapshot));
    expect(restored.x).toBe(snapshot.x);
    expect(restored.y).toBe(snapshot.y);
    expect(restored).toEqual(snapshot);
  });

  it('exposes COCO bbox and exact pixel area', () => {
    expect(cocoBbox(FIXTURE)).toEqual([1, 1, 2, 2]);
    expect(cocoArea(FIXTURE)).toBe(4);
  });
});

describe('pycocotools interop limits', () => {
  it('flags images whose run lengths exceed the reference implementation 32-bit counts', () => {
    // Verified against pycocotools: a mask painted at the centre of a
    // 100000x100000 image decodes with the correct area but at the wrong
    // coordinates, because its leading run is truncated to 32 bits.
    const gigapixel: MaskSnapshot = {
      x: 49996,
      y: 49996,
      width: 1,
      height: 1,
      data: Uint8Array.from([1]),
      imageWidth: 100_000,
      imageHeight: 100_000,
    };
    expect(isCocoInteropSafe(gigapixel)).toBe(false);

    // Our own round-trip is unaffected — the limitation is downstream.
    const restored = cocoRleCodec.decode!(cocoRleCodec.encode(gigapixel));
    expect(restored).toEqual(gigapixel);
  });

  it('accepts ordinary images, including right at the boundary', () => {
    const atLimit: MaskSnapshot = {
      ...FIXTURE,
      imageWidth: 0xffff,
      imageHeight: 0xffff, // 0xFFFE0001 pixels, just inside the bound
    };
    expect(isCocoInteropSafe(atLimit)).toBe(true);
    expect(isCocoInteropSafe(FIXTURE)).toBe(true);
    expect(COCO_MAX_INTEROP_IMAGE_PIXELS).toBe(4_294_967_295);
  });
});
