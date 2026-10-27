import { describe, it, expect } from 'vitest';
import {
  BoundedDenseMaskBuffer,
  CocoRunLimitExceededError,
  DEFAULT_MAX_MASK_PIXELS,
  MAX_COCO_ARRAY_RUNS,
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

  it('answers within 2^29 pixels of image without looking at the runs', () => {
    expect(COCO_MAX_INTEROP_IMAGE_PIXELS).toBe(2 ** 29);
    expect(isCocoInteropSafe(FIXTURE)).toBe(true);
    // 23,170 x 23,170 is just inside: no run can exceed it, no delta fall below -2^29.
    expect(isCocoInteropSafe({ ...FIXTURE, imageWidth: 23_170, imageHeight: 23_170 })).toBe(true);
  });

  /**
   * Three single pixels, `gap` and then `gap + delta` background pixels apart
   * in COCO's column-major order, so the fifth count minus the third is
   * exactly `delta`. Built from runs: the box spans most of the image.
   */
  function threePixels(height: number, width: number, gap: number, delta: number) {
    const a = 5;
    const b = a + 1 + gap;
    const c = b + 1 + gap + delta;
    const pixels = [a, b, c].map((i) => ({ x: Math.floor(i / height), y: i % height }));
    const x0 = Math.min(...pixels.map((p) => p.x));
    const y0 = Math.min(...pixels.map((p) => p.y));
    const boxWidth = Math.max(...pixels.map((p) => p.x)) - x0 + 1;
    const boxHeight = Math.max(...pixels.map((p) => p.y)) - y0 + 1;
    const offsets = pixels.map((p) => (p.y - y0) * boxWidth + (p.x - x0)).sort((u, v) => u - v);
    const runs: number[] = [];
    let at = 0;
    for (const offset of offsets) {
      runs.push(offset - at, 1);
      at = offset + 1;
    }
    runs.push(boxWidth * boxHeight - at);
    const raster = runRaster(
      {
        cells: { x: x0, y: y0, width: boxWidth, height: boxHeight },
        imageWidth: width,
        imageHeight: height,
        downsample: 1,
      },
      runs,
    );
    // The construction itself, checked: these are the COCO runs it stands for.
    expect(snapshotToCocoCounts(raster)).toEqual([
      a,
      1,
      gap,
      1,
      gap + delta,
      1,
      width * height - c - 1,
    ]);
    return raster;
  }

  it('is decided by the runs past that: a delta below -2^29 is misread', () => {
    // Verified against pycocotools 2.0.11 on these exact counts: at -2^29 the
    // box comes back right, one below it the box comes back wrong.
    expect(isCocoInteropSafe(threePixels(50_000, 50_000, 1e9, -(2 ** 29)))).toBe(true);
    expect(isCocoInteropSafe(threePixels(50_000, 50_000, 1e9, -(2 ** 29) - 1))).toBe(false);
    // A reviewer's case: three pixels on a 24,000-square image, a huge gap
    // then a short one. pycocotools keeps the area and loses the box.
    expect(isCocoInteropSafe(threePixels(24_000, 24_000, 560_000_000, -559_999_997))).toBe(false);
  });

  it('is false once a foreground pixel lies at column-major index 2^32 or past it', () => {
    // pycocotools' rleToBbox accumulates the position, and rleArea the area,
    // in a 32-bit uint. Verified against pycocotools 2.0.11: this one-pixel
    // line across a 100,000 x 80,000 image comes back as the box
    // [0, 32704, 53687, 7297], not [0, 40000, 100000, 1]. Its runs and deltas
    // are all in range, so only the position says so.
    const line = runRaster(
      {
        cells: { x: 0, y: 40_000, width: 100_000, height: 1 },
        imageWidth: 100_000,
        imageHeight: 80_000,
        downsample: 1,
      },
      [0, 100_000],
    );
    expect(isCocoInteropSafe(line)).toBe(false);

    // The exact boundary, verified through the compressed string, encoded
    // here and decoded by pycocotools: a line along the bottom row of a
    // 65,537 x 65,536 image. 65,536 pixels long, its last pixel is at index
    // 2^32 - 1 and it reads back right; one pixel longer, the last is at
    // 2^32 + 65,535 and pycocotools drops that column from the box.
    const bottomRow = (width: number) =>
      runRaster(
        {
          cells: { x: 0, y: 65_535, width, height: 1 },
          imageWidth: 65_537,
          imageHeight: 65_536,
          downsample: 1,
        },
        [0, width],
      );
    expect(isCocoInteropSafe(bottomRow(65_536))).toBe(true);
    expect(isCocoInteropSafe(bottomRow(65_537))).toBe(false);
  });

  it('is false once the runs pass the bound the exporter refuses at', { timeout: 60_000 }, () => {
    // Alternating rows of d=16 cells, 2,100 x 4,096 of them on a 65,536-square
    // image: about 137.6 M runs, past MAX_COCO_RUNS, while every run, delta
    // and position stays in pycocotools' range (the last foreground pixel is
    // near index 2.2e9), so only the run bound can say so.
    const rows = 4_096;
    const runs = [0];
    for (let row = 0; row < rows; row++) runs.push(2_100);
    const alternating = runRaster(
      {
        cells: { x: 0, y: 0, width: 2_100, height: rows },
        imageWidth: 65_536,
        imageHeight: 65_536,
        downsample: 16,
      },
      runs,
    );
    expect(isCocoInteropSafe(alternating)).toBe(false);
    // The exporter refuses it too, so "not safe" is the honest answer.
    expect(() => cocoRleCodec.encode(alternating)).toThrow(CocoRunLimitExceededError);
  });

  it('is still unaffected for our own round trip', () => {
    // Compared as counts: the mask's box is far past the cell cap, which a
    // decode applies, though the runs themselves are few.
    const raster = threePixels(24_000, 24_000, 560_000_000, -559_999_997);
    expect(decodeCocoCountsString(cocoRleCodec.encode(raster).counts)).toEqual(
      snapshotToCocoCounts(raster),
    );
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
  /** `width` x `height` cells of alternating rows at downsample 16 on 100k x 80k. */
  function stripes(width: number, height: number) {
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

  it('exports a downsampled mask whose runs are many but within the bound', () => {
    // The reviewer's 6.7 kB payload: 125,000,001 runs, under MAX_COCO_RUNS.
    // Slow, as documented beside the bound, but exported, not refused.
    const { payload, raster } = stripes(3125, 2500);
    expect(payload.counts.length).toBe(6668);
    expect(countCocoRuns(raster)).toBe(125_000_001);
    expect(countCocoRuns(raster)).toBeLessThanOrEqual(MAX_COCO_RUNS);
    const { counts } = cocoRleCodec.encode(raster);
    // Every run but the first and last is 16 pixels, a delta of 0, one
    // character each; measured, the whole string is this long.
    expect(counts.length).toBe(125_300_003);
  }, 120_000);

  it('refuses a downsampled mask past the bound quickly, on every export path', () => {
    // 3,200 x 2,700 alternating d=16 cell rows: about 138 M runs, over
    // MAX_COCO_RUNS, from a payload well inside the cell cap.
    const { raster } = stripes(3200, 2700);
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
      expect(error.runs).toBeGreaterThan(error.maxRuns);
      expect(error.downsample).toBe(16);
      expect(error.message).toMatch(/canonical format/);
    }
  });

  it('refuses past 2^27 runs where they are returned as an array, by name', () => {
    expect(MAX_COCO_ARRAY_RUNS).toBe(2 ** 27);
    // The one extreme legal mask: a one-row box as wide as the cap, every
    // pixel set, on a taller image — exactly MAX_COCO_RUNS, one past 2^27.
    const line = runRaster(
      {
        cells: { x: 0, y: 1, width: DEFAULT_MAX_MASK_PIXELS, height: 1 },
        imageWidth: DEFAULT_MAX_MASK_PIXELS,
        imageHeight: 3,
        downsample: 1,
      },
      [0, DEFAULT_MAX_MASK_PIXELS],
    );
    for (const exportIt of [
      () => snapshotToCocoCounts(line),
      () => cocoRleUncompressedCodec.encode(line),
    ]) {
      let caught: unknown;
      try {
        exportIt();
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(CocoRunLimitExceededError);
      expect((caught as CocoRunLimitExceededError).maxRuns).toBe(2 ** 27);
      expect((caught as CocoRunLimitExceededError).message).toMatch(/compressed COCO codec/);
    }
  });

  it('stops counting at the bound, rather than counting a staircase to the end', () => {
    // Row 2k is set from column k on, odd rows are clear: column x holds x + 1
    // separate rows, so a full count walks about width^2 / 2 intervals, and
    // the export needs about width^2 runs, far past the bound.
    const width = 20_000;
    const height = 2 * width;
    const runs: number[] = [];
    let background = 0;
    for (let row = 0; row < height; row++) {
      if (row % 2 === 0) {
        runs.push(background + row / 2, width - row / 2);
        background = 0;
      } else background += width;
    }
    runs.push(background);
    const raster = runRaster(
      {
        cells: { x: 0, y: 0, width, height },
        imageWidth: width,
        imageHeight: height,
        downsample: 1,
      },
      runs,
    );
    const started = performance.now();
    expect(() => cocoRleCodec.encode(raster)).toThrow(CocoRunLimitExceededError);
    const refused = performance.now() - started;
    // The full count of the same raster, for comparison: the refusal does a
    // fraction of its work.
    const full = performance.now();
    expect(countCocoRuns(raster)).toBeGreaterThan(MAX_COCO_RUNS);
    const counted = performance.now() - full;
    expect(refused).toBeLessThan(counted * 0.6);
  }, 120_000);

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

describe('COCO counts string precision', () => {
  it('round-trips an 11-chunk negative delta exactly', () => {
    // The fourth count minus the second is about -2^51: eleven chunks, whose
    // sign used to be applied after an intermediate sum near 2^55.
    for (const counts of [
      [0, 2 ** 51 + 3, 0, 1],
      [0, 2 ** 50 + 7, 3, 1],
      [5, 2 ** 52 + 1, 2, 9, 4],
    ]) {
      expect(decodeCocoCountsString(encodeCocoCountsString(counts))).toEqual(counts);
    }
  });

  it('matches an exact reference decoder on random counts', () => {
    // BigInt arithmetic as the reference: exact at any size.
    const reference = (encoded: string): number[] => {
      const out: bigint[] = [];
      let p = 0;
      while (p < encoded.length) {
        let x = 0n;
        let k = 0n;
        let more = true;
        while (more) {
          const c = BigInt(encoded.charCodeAt(p++) - 48);
          x |= (c & 0x1fn) << (5n * k);
          more = (c & 0x20n) !== 0n;
          k++;
          if (!more && (c & 0x10n) !== 0n) x -= 1n << (5n * k);
        }
        if (out.length > 2) x += out[out.length - 2]!;
        out.push(x);
      }
      return out.map(Number);
    };
    const next = random(3);
    for (let n = 0; n < 2000; n++) {
      const counts = Array.from({ length: 1 + Math.floor(next() * 8) }, () =>
        Math.floor(next() * 2 ** Math.floor(next() * 53)),
      );
      const encoded = encodeCocoCountsString(counts);
      expect(decodeCocoCountsString(encoded)).toEqual(counts);
      expect(reference(encoded)).toEqual(counts);
    }
  });
});
