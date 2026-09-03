import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  cocoArea,
  cocoBbox,
  cocoRleCodec,
  cocoRleUncompressedCodec,
  snapshotToCocoCounts,
  type MaskSnapshot,
} from '../../src/index.js';

/**
 * Golden values produced by `pycocotools` (and, for the uncompressed form, by a
 * direct numpy computation) — never by this package.
 *
 * These lock in interoperability with the reference implementation. Encoding
 * that merely round-trips through our own decoder could be self-consistently
 * wrong; agreeing byte-for-byte with pycocotools is the real guarantee.
 *
 * To add a case, build the mask as a Fortran-ordered numpy array and take the
 * values from the reference implementation directly:
 *
 * ```python
 * import numpy as np
 * from pycocotools import mask as m
 *
 * a = np.zeros((height, width), dtype=np.uint8, order="F")  # note: (rows, cols)
 * a[y:y + h, x:x + w] = rows                                 # your '0'/'1' block
 * rle = m.encode(np.asfortranarray(a))
 * print(rle["counts"].decode(), m.area(rle), m.toBbox(rle))
 * ```
 *
 * Automating this as a CI job is tracked in
 * https://github.com/osdlabel/osdlabel/issues/150.
 */
interface GoldenCase {
  readonly name: string;
  readonly imageWidth: number;
  readonly imageHeight: number;
  readonly x: number;
  readonly y: number;
  /** Rows of '0'/'1' over the mask's tight bounding box. */
  readonly rows: readonly string[];
  readonly pycocotools: {
    readonly size: readonly [number, number];
    readonly counts: string;
    readonly uncompressedCounts: readonly number[];
    readonly area: number;
    readonly bbox: readonly [number, number, number, number];
  };
}

const golden: GoldenCase[] = JSON.parse(
  readFileSync(
    fileURLToPath(new URL('../fixtures/pycocotools-golden.json', import.meta.url)),
    'utf8',
  ),
);

function toSnapshot(c: GoldenCase): MaskSnapshot {
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

describe('pycocotools golden fixtures', () => {
  it('covers the shapes that stress the encoding', () => {
    expect(golden.map((c) => c.name)).toEqual([
      'hand-fixture',
      'single-pixel-origin',
      'single-pixel-last',
      'blob-with-hole',
      'edge-touching-stroke',
      'full-image-foreground',
      'two-disjoint-blobs',
      'tall-thin-column',
    ]);
  });

  for (const testCase of golden) {
    describe(testCase.name, () => {
      const snapshot = toSnapshot(testCase);

      it('encodes to byte-identical compressed counts', () => {
        const encoded = cocoRleCodec.encode(snapshot);
        expect(encoded.counts).toBe(testCase.pycocotools.counts);
        expect(encoded.size).toEqual(testCase.pycocotools.size);
      });

      it('encodes to identical uncompressed run lengths', () => {
        expect(snapshotToCocoCounts(snapshot)).toEqual(testCase.pycocotools.uncompressedCounts);
        expect(cocoRleUncompressedCodec.encode(snapshot).counts).toEqual(
          testCase.pycocotools.uncompressedCounts,
        );
      });

      it('decodes the reference counts back to the same pixels', () => {
        const [height, width] = testCase.pycocotools.size;
        const decoded = cocoRleCodec.decode!({
          size: [height, width],
          counts: testCase.pycocotools.counts,
        });
        expect(decoded).toEqual(snapshot);
      });

      it('reports the same area and bbox as pycocotools', () => {
        expect(cocoArea(snapshot)).toBe(testCase.pycocotools.area);
        expect(cocoBbox(snapshot)).toEqual(testCase.pycocotools.bbox);
      });
    });
  }
});
