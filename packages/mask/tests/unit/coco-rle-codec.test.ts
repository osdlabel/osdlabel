import { describe, it, expect } from 'vitest';
import {
  BoundedDenseMaskBuffer,
  CocoRunLimitExceededError,
  DEFAULT_MAX_MASK_PIXELS,
  MAX_COCO_RUNS,
  MaskCapacityExceededError,
  countCocoRuns,
  decodeCanonicalRaster,
  encodeCanonical,
  runRaster,
  snapshotPixelCount,
  strokeSegment,
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
  denseRaster,
  toDenseSnapshot,
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
  cells: { x: 1, y: 1, width: 2, height: 2 },
  data: Uint8Array.from([1, 1, 1, 1]),
  imageWidth: 4,
  imageHeight: 3,
  downsample: 1,
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
      cells: { x: 0, y: 0, width: 1, height: 1 },
      data: Uint8Array.from([1]),
      imageWidth: 2,
      imageHeight: 2,
      downsample: 1,
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
    expect(cocoRleCodec.encode(denseRaster(FIXTURE)).size).toEqual([3, 4]);
    expect(cocoRleUncompressedCodec.encode(denseRaster(FIXTURE)).size).toEqual([3, 4]);
  });

  it('agrees between the compressed and uncompressed variants', () => {
    const b = new BoundedDenseMaskBuffer({ imageWidth: 300, imageHeight: 200 });
    stampCircle(b, 100.5, 80.5, 15, 1);
    stampCircle(b, 105.5, 85.5, 6, 0);
    const snapshot = b.snapshot();

    const compressed = toDenseSnapshot(cocoRleCodec.decode!(cocoRleCodec.encode(b.raster())));
    const plain = toDenseSnapshot(
      cocoRleUncompressedCodec.decode!(cocoRleUncompressedCodec.encode(b.raster())),
    );

    expect(compressed).toEqual(snapshot);
    expect(plain).toEqual(snapshot);
  });

  it('round-trips a mask that is offset from the origin', () => {
    const b = new BoundedDenseMaskBuffer({ imageWidth: 640, imageHeight: 480 });
    stampCircle(b, 500.5, 400.5, 9, 1);
    const snapshot = b.snapshot();

    const restored = toDenseSnapshot(cocoRleCodec.decode!(cocoRleCodec.encode(b.raster())));
    expect(restored.cells.x).toBe(snapshot.cells.x);
    expect(restored.cells.y).toBe(snapshot.cells.y);
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
      cells: { x: 49996, y: 49996, width: 1, height: 1 },
      data: Uint8Array.from([1]),
      imageWidth: 100_000,
      imageHeight: 100_000,
      downsample: 1,
    };
    expect(isCocoInteropSafe(gigapixel)).toBe(false);

    // Our own round-trip is unaffected — the limitation is downstream.
    const restored = toDenseSnapshot(
      cocoRleCodec.decode!(cocoRleCodec.encode(denseRaster(gigapixel))),
    );
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

/** A deterministic generator, so a failing case reproduces. */
function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

/** Painted masks at several downsamples, on images whose sides are not multiples of them. */
function paintedMasks(): { name: string; snapshot: MaskSnapshot }[] {
  const next = random(11);
  const out: { name: string; snapshot: MaskSnapshot }[] = [];
  for (const downsample of [1, 2, 4, 8, 16]) {
    for (let k = 0; k < 4; k++) {
      const imageWidth = 97 + Math.floor(next() * 300);
      const imageHeight = 61 + Math.floor(next() * 300);
      const buffer = new BoundedDenseMaskBuffer({ imageWidth, imageHeight, downsample });
      for (let s = 0; s < 3; s++) {
        const x0 = next() * imageWidth;
        const y0 = next() * imageHeight;
        strokeSegment(
          buffer,
          x0,
          y0,
          next() * imageWidth,
          next() * imageHeight,
          2 + next() * 30,
          1,
        );
        stampCircle(buffer, x0, y0, 1 + next() * 12, 0);
      }
      // Reach the image's clipped last column and row on some of them.
      if (k === 0) stampCircle(buffer, imageWidth - 1, imageHeight - 1, 3 * downsample, 1);
      out.push({
        name: `d=${downsample} #${k} on ${imageWidth}x${imageHeight}`,
        snapshot: buffer.snapshot(),
      });
    }
  }
  return out;
}

describe('COCO export cost', () => {
  it('counts exactly the runs it emits, without emitting them', () => {
    for (const { name, snapshot } of paintedMasks()) {
      const counts = snapshotToCocoCounts(snapshot);
      expect(countCocoRuns(snapshot), name).toBe(counts.length);
      // The streamed compressed string is the string of those counts.
      expect(cocoRleCodec.encode(denseRaster(snapshot)).counts, name).toBe(
        encodeCocoCountsString(counts),
      );
    }
  });

  /**
   * A reviewer's payload: 3125 x 2500 cells of alternating rows at downsample
   * 16, on a 100,000 x 80,000 image. 6.7 kB of canonical payload, and 125 M
   * level-0 runs: every cell row becomes a run in each of 16 image columns.
   */
  function stripes() {
    const width = 3125;
    const height = 2500;
    const runs = [0, ...Array.from({ length: height }, () => width)];
    const payload = encodeCanonical(
      runRaster(
        {
          cells: { x: 0, y: 0, width, height },
          imageWidth: 100_000,
          imageHeight: 80_000,
          downsample: 16,
        },
        runs,
      ),
    );
    return { payload, raster: decodeCanonicalRaster(payload) };
  }

  it('refuses a downsampled mask whose export would explode, before it allocates', () => {
    const { payload, raster } = stripes();
    expect(payload.counts.length).toBe(6668);
    expect(countCocoRuns(raster)).toBe(125_000_001);

    for (const exportIt of [
      () => cocoRleCodec.encode(raster),
      () => cocoRleUncompressedCodec.encode(raster),
      () => snapshotToCocoCounts(raster),
    ]) {
      const started = performance.now();
      let caught: unknown;
      try {
        exportIt();
      } catch (error) {
        caught = error;
      }
      expect(performance.now() - started).toBeLessThan(100);
      expect(caught).toBeInstanceOf(CocoRunLimitExceededError);
      const error = caught as CocoRunLimitExceededError;
      expect(error.runs).toBe(125_000_001);
      expect(error.maxRuns).toBe(Math.floor(MAX_COCO_RUNS / 16));
      expect(error.message).toMatch(/canonical format/);
    }
  });

  it('bounds a full-resolution mask at its true worst case, so none is refused', () => {
    expect(MAX_COCO_RUNS).toBe(2 * DEFAULT_MAX_MASK_PIXELS + 1);
    // A one-row box as wide as the cap, every pixel set, on a taller image:
    // two transitions a column, so exactly the bound.
    const line = runRaster(
      {
        cells: { x: 0, y: 1, width: DEFAULT_MAX_MASK_PIXELS, height: 1 },
        imageWidth: DEFAULT_MAX_MASK_PIXELS,
        imageHeight: 3,
        downsample: 1,
      },
      [0, DEFAULT_MAX_MASK_PIXELS],
    );
    expect(countCocoRuns(line)).toBe(MAX_COCO_RUNS);
  });

  it('exports the worst full-resolution mask at the cap', () => {
    // 671 x 100,000 = 67,100,000 cells, inset in its image, alternating
    // rows from a set one: each image column alternates every pixel, one
    // transition per row (the last row is clear, so it leaves on the last).
    const width = 671;
    const height = 100_000;
    expect(width * height).toBeLessThanOrEqual(DEFAULT_MAX_MASK_PIXELS);
    const runs = [0, ...Array.from({ length: height }, () => width)];
    const raster = runRaster(
      {
        cells: { x: 500, y: 10_000, width, height },
        imageWidth: 2000,
        imageHeight: 120_000,
        downsample: 1,
      },
      runs,
    );
    const total = countCocoRuns(raster);
    expect(total).toBe(width * height + 1);
    expect(total).toBeLessThanOrEqual(MAX_COCO_RUNS);
    const { counts } = cocoRleCodec.encode(raster);
    // One character a run at least; the decoder agrees on the count.
    expect(counts.length).toBeGreaterThanOrEqual(total);
  }, 120_000);
});

describe('COCO import at a declared downsample', () => {
  it('decodes straight into cells, exactly the mask that was exported', () => {
    for (const { name, snapshot } of paintedMasks()) {
      if (snapshot.downsample === 1) continue;
      const payload = cocoRleCodec.encode(denseRaster(snapshot));
      const decoded = toDenseSnapshot(
        cocoRleCodec.decode!(payload, { downsample: snapshot.downsample }),
      );
      expect({ ...decoded, data: Array.from(decoded.data) }, name).toEqual({
        ...snapshot,
        data: Array.from(snapshot.data),
      });
      const uncompressed = cocoRleUncompressedCodec.encode(denseRaster(snapshot));
      expect(
        toDenseSnapshot(
          cocoRleUncompressedCodec.decode!(uncompressed, { downsample: snapshot.downsample }),
        ).cells,
        name,
      ).toEqual(snapshot.cells);
    }
  });

  it('decodes at full resolution when no downsample is declared, as before', () => {
    const buffer = new BoundedDenseMaskBuffer({ imageWidth: 37, imageHeight: 23, downsample: 4 });
    buffer.set(7, 3, 1);
    buffer.set(9, 5, 1); // clipped: image columns 36..36, rows 20..22
    const payload = cocoRleCodec.encode(buffer.raster());
    const decoded = toDenseSnapshot(cocoRleCodec.decode!(payload));
    expect(decoded.downsample).toBe(1);
    expect(decoded.cells).toEqual({ x: 28, y: 12, width: 9, height: 11 });
    expect(snapshotPixelCount(decoded)).toBe(16 + 3);
  });

  it('allocates cells, not the image pixels they cover', () => {
    // A 21,024 x 17,024-pixel region at downsample 16 on a 100k x 80k slide:
    // 357,912,576 image pixels, 1,314 x 1,064 cells.
    const raster = runRaster(
      {
        cells: { x: 100, y: 200, width: 1314, height: 1064 },
        imageWidth: 100_000,
        imageHeight: 80_000,
        downsample: 16,
      },
      [0, 1314 * 1064],
    );
    const payload = cocoRleCodec.encode(raster);
    expect(21_024 * 17_024).toBeGreaterThan(DEFAULT_MAX_MASK_PIXELS);
    expect(() => cocoRleCodec.decode!(payload)).toThrow(MaskCapacityExceededError);
    const decoded = cocoRleCodec.decode!(payload, { downsample: 16 });
    expect(decoded.downsample).toBe(16);
    expect(decoded.cells).toEqual(raster.cells);
    expect(decoded.cellCount).toBe(1314 * 1064);
  });

  it('refuses a payload that is not constant within each cell, rather than rounding it', () => {
    const at = (cells: [number, number][]) => {
      const buffer = new BoundedDenseMaskBuffer({ imageWidth: 40, imageHeight: 30 });
      for (const [x, y] of cells) buffer.set(x, y, 1);
      return cocoRleCodec.encode(buffer.raster());
    };
    const block = (x0: number, y0: number): [number, number][] =>
      Array.from({ length: 16 }, (_, i) => [x0 + (i % 4), y0 + Math.floor(i / 4)]);
    // A whole 4x4 block decodes; a single pixel, a block off the grid either
    // way, or a block with one pixel missing does not.
    expect(cocoRleCodec.decode!(at(block(8, 4)), { downsample: 4 }).cellCount).toBe(1);
    for (const cells of [
      [[9, 5]] as [number, number][],
      block(9, 4),
      block(8, 5),
      block(8, 4).slice(1),
      block(8, 4).filter(([x, y]) => !(x === 11 && y === 7)),
    ]) {
      expect(() => cocoRleCodec.decode!(at(cells), { downsample: 4 })).toThrow(
        /not constant within each 4x4 block/,
      );
    }
  });

  it('accepts cells clipped by the image edge, at their clipped size', () => {
    // 37 x 23 at downsample 4: the last cell column is 1 image column wide and
    // the last cell row 3 image rows high.
    const buffer = new BoundedDenseMaskBuffer({ imageWidth: 37, imageHeight: 23 });
    for (let x = 32; x < 37; x++) for (let y = 16; y < 23; y++) buffer.set(x, y, 1);
    const decoded = cocoRleCodec.decode!(cocoRleCodec.encode(buffer.raster()), { downsample: 4 });
    expect(decoded.cells).toEqual({ x: 8, y: 4, width: 2, height: 2 });
    expect(decoded.cellCount).toBe(4);
  });

  it('refuses an unusable downsample by name', () => {
    const payload = cocoRleCodec.encode(denseRaster(paintedMasks()[0]!.snapshot));
    for (const downsample of [3, 0, -2, 1.5, 2 ** 17]) {
      expect(() => cocoRleCodec.decode!(payload, { downsample })).toThrow(/power of two/);
    }
  });
});
