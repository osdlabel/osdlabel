import { describe, it, expect } from 'vitest';
import goldenJson from '../fixtures/pycocotools-golden.json';
import {
  BoundedDenseMaskBuffer,
  DEFAULT_MAX_MASK_PIXELS,
  MaskCapacityExceededError,
  canonicalMaskCodec,
  cocoArea,
  cocoBbox,
  cocoRleCodec,
  cocoRleUncompressedCodec,
  decodeCanonical,
  decodeCanonicalRaster,
  denseRaster,
  encodeCanonical,
  rasterPixelCount,
  snapshotImageBox,
  snapshotPixelCount,
  snapshotToCocoCounts,
  stampCircle,
  strokeSegment,
  toDenseSnapshot,
  upsampleSnapshot,
  type MaskRaster,
  type MaskSnapshot,
} from '../../src/index.js';
import { TiledMaskRaster } from './tiled-mask-raster.js';

/**
 * The same round trips the dense snapshot passes, run against a sparse tiled
 * store that implements only the {@link MaskRaster} interface. Every codec
 * must produce byte-identical payloads from either, which is what lets a
 * tiled buffer replace the dense one later without a format or API change.
 */

interface GoldenCase {
  readonly name: string;
  readonly imageWidth: number;
  readonly imageHeight: number;
  readonly x: number;
  readonly y: number;
  readonly rows: readonly string[];
  readonly pycocotools: {
    readonly size: readonly [number, number];
    readonly counts: string;
    readonly uncompressedCounts: readonly number[];
    readonly area: number;
    readonly bbox: readonly [number, number, number, number];
  };
}
const golden = goldenJson as unknown as readonly GoldenCase[];

function goldenSnapshot(c: GoldenCase): MaskSnapshot {
  const height = c.rows.length;
  const width = c.rows[0]?.length ?? 0;
  const data = new Uint8Array(width * height);
  c.rows.forEach((row, r) => {
    for (let col = 0; col < row.length; col++) if (row[col] === '1') data[r * width + col] = 1;
  });
  return {
    x: c.x,
    y: c.y,
    width,
    height,
    data,
    imageWidth: c.imageWidth,
    imageHeight: c.imageHeight,
  };
}

/** Every span a raster visits, for comparing two rasters cell for cell. */
function cellsOf(raster: MaskRaster): string[] {
  const cells: string[] = [];
  raster.forEachSpan((cy, x0, x1) => {
    for (let cx = x0; cx < x1; cx++) cells.push(`${cx},${cy}`);
  });
  return cells;
}

/** Painted fixtures from the dense suites, at downsample 1 and above. */
function paintedFixtures(): { name: string; snapshot: MaskSnapshot }[] {
  const holed = new BoundedDenseMaskBuffer({ imageWidth: 500, imageHeight: 400 });
  stampCircle(holed, 120.5, 90.5, 12, 1);
  stampCircle(holed, 130.5, 95.5, 5, 0);

  const offset = new BoundedDenseMaskBuffer({ imageWidth: 640, imageHeight: 480 });
  stampCircle(offset, 500.5, 400.5, 9, 1);

  const coarse = new BoundedDenseMaskBuffer({ imageWidth: 601, imageHeight: 403, downsample: 16 });
  strokeSegment(coarse, 20, 60, 598, 398, 40, 1);
  stampCircle(coarse, 300, 230, 30, 0);

  const edge = new BoundedDenseMaskBuffer({ imageWidth: 37, imageHeight: 23, downsample: 4 });
  for (const [cx, cy] of [
    [7, 3],
    [8, 3],
    [6, 4],
    [9, 4],
    [6, 5],
    [7, 5],
    [8, 5],
    [9, 5],
  ] as const) {
    edge.set(cx, cy, 1);
  }

  return [
    { name: 'blob with a hole', snapshot: holed.snapshot() },
    { name: 'offset from the origin', snapshot: offset.snapshot() },
    { name: 'stroke at downsample 16', snapshot: coarse.snapshot() },
    { name: 'clipped edge cells at downsample 4', snapshot: edge.snapshot() },
  ];
}

describe('TiledMaskRaster is a MaskRaster like any other', () => {
  for (const tile of [2, 3, 8]) {
    describe(`tile ${tile}`, () => {
      for (const c of golden) {
        it(`${c.name}: byte-identical to pycocotools and to the dense encoding`, () => {
          const dense = goldenSnapshot(c);
          const tiled = TiledMaskRaster.from(denseRaster(dense), tile);

          expect(cocoRleCodec.encode(tiled).counts).toBe(c.pycocotools.counts);
          expect(cocoRleUncompressedCodec.encode(tiled).counts).toEqual(
            c.pycocotools.uncompressedCounts,
          );
          expect(cocoArea(tiled)).toBe(c.pycocotools.area);
          expect(cocoBbox(tiled)).toEqual(c.pycocotools.bbox);
          expect(encodeCanonical(tiled)).toEqual(encodeCanonical(dense));
          expect(toDenseSnapshot(tiled, Infinity)).toEqual(dense);
        });
      }

      for (const { name, snapshot } of paintedFixtures()) {
        it(`${name}: same payloads, and the canonical round trip is exact`, () => {
          const tiled = TiledMaskRaster.from(denseRaster(snapshot), tile);

          const payload = canonicalMaskCodec.encode(tiled);
          expect(payload).toEqual(encodeCanonical(snapshot));
          expect(snapshotToCocoCounts(tiled)).toEqual(snapshotToCocoCounts(snapshot));
          expect(snapshotToCocoCounts(tiled)).toEqual(
            snapshotToCocoCounts(upsampleSnapshot(snapshot, Infinity)),
          );
          expect(snapshotPixelCount(tiled)).toBe(snapshotPixelCount(snapshot));
          expect(snapshotImageBox(tiled)).toEqual(snapshotImageBox(snapshot));

          // Decoded as runs, re-encoded, decoded dense: nothing moves.
          const decoded = canonicalMaskCodec.decode!(payload);
          expect(canonicalMaskCodec.encode(decoded)).toEqual(payload);
          expect(cellsOf(decoded)).toEqual(cellsOf(tiled));
          expect(decodeCanonical(payload)).toEqual(snapshot);

          // And the buffer refines from a tiled raster as from a dense one.
          const buffer = BoundedDenseMaskBuffer.fromSnapshot(tiled);
          expect(buffer.snapshot()).toEqual(snapshot);
          expect(buffer.pixelCount).toBe(tiled.cellCount);
        });
      }
    });
  }
});

describe('a mask whose box is past the dense cap', () => {
  // A 9000x9000 solid region and a dab 10,000 cells away on a 20,000-square
  // image: 13,000 x 13,000 = 169,000,000 cells of box, 2.5x the cap, and
  // 81,000,000 painted. Two far-apart dabs are exactly what the brush
  // abandons today.
  const box = { x: 0, y: 0, width: 13_000, height: 13_000 } as const;
  const image = { imageWidth: 20_000, imageHeight: 20_000, downsample: 1 } as const;
  const big = new TiledMaskRaster({ ...box, ...image }, 256);
  big.fillRect(0, 0, 9000, 9000);
  big.fillRect(12_990, 12_990, 10, 10);

  it('is past the cap the dense readers apply', () => {
    expect(box.width * box.height).toBeGreaterThan(DEFAULT_MAX_MASK_PIXELS);
    expect(big.cellCount).toBe(81_000_000 + 100);
  });

  it('encodes to an ordinary canonical payload without allocating the box', () => {
    const payload = encodeCanonical(big);
    expect(payload).toMatchObject({ x: 0, y: 0, width: 13_000, height: 13_000 });
    expect(payload.downsample).toBeUndefined();
    // About four runs a row: a few dozen kilobytes for 169 M cells.
    expect(payload.counts.length).toBeLessThan(200_000);

    // The dense decode refuses it — that is a reader's policy, not the format.
    expect(() => decodeCanonical(payload)).toThrow(MaskCapacityExceededError);

    // A reader that keeps runs as runs holds it in O(runs), byte for byte.
    const runs = decodeCanonicalRaster(payload, { maxPixels: Infinity });
    expect(runs.cellCount).toBe(big.cellCount);
    expect(rasterPixelCount(runs)).toBe(81_000_100);
    expect(encodeCanonical(runs)).toEqual(payload);
    for (const [cx, cy] of [
      [0, 0],
      [8999, 8999],
      [9000, 0],
      [12_995, 12_995],
      [12_989, 12_999],
    ]) {
      expect(runs.get(cx!, cy!)).toBe(big.get(cx!, cy!));
    }
  });

  it('exports COCO from spans, never the box', () => {
    const counts = snapshotToCocoCounts(big);
    let total = 0;
    let foreground = 0;
    counts.forEach((run, i) => {
      total += run;
      if (i % 2 === 1) foreground += run;
    });
    expect(total).toBe(20_000 * 20_000);
    expect(foreground).toBe(81_000_100);
    // One foreground run per image column the mask touches: 9000 + 10.
    expect((counts.length - 1) / 2).toBe(9010);
    expect(
      snapshotToCocoCounts(decodeCanonicalRaster(encodeCanonical(big), { maxPixels: Infinity })),
    ).toEqual(counts);
  });
});
