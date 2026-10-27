import { maskGridSize, assertMaskDownsample } from './downsample.js';
import {
  denseRaster,
  denseSnapshotOf,
  forEachCheckedSpan,
  type MaskRaster,
} from './mask-raster.js';
import type { MaskSnapshot } from './mask-buffer.js';

/**
 * Halves a raster's resolution: returns a raster at `2 × source.downsample`
 * covering the same level-0 box.
 */
export type CoarsenStrategy = (source: MaskRaster) => MaskRaster;

/**
 * The built-in coarsening rule: a coarse cell takes the majority of its four
 * children, and a 2-of-4 tie is set where `(cx + cy)` is even, in absolute
 * coarse-cell coordinates. At the image's edges a coarse cell has fewer
 * children — two, or one in the corner — and takes their majority the same
 * way, a 1-of-2 tie by the same parity.
 *
 * Chosen by measurement (the #149 plan): on 2,079 CAMELYON16 lesion polygons
 * its pooled Dice at d = 2…16 stays within 0.0006 of sampling each cell's
 * centre once at the final resolution, with a median signed area error (its
 * bias) within ±0.1% and no lesion lost; "any of four" biased area by +8%.
 * The brush's progressive-coarsening test holds it to Dice within 0.001 and
 * that ±0.1%. The parity tie-break is what keeps it unbiased, and because a
 * block of four equal children always keeps their value, coarsening a mask
 * that was just re-gridded finer (each cell replicated 2×2) returns the
 * original exactly.
 *
 * Work is one pass over the source's spans and one over the coarse box; the
 * result is dense, a quarter of the source's box.
 */
export const majorityCoarsen: CoarsenStrategy = (source) => {
  const d = source.downsample;
  const coarseD = d * 2;
  assertMaskDownsample(coarseD);
  const { x, y, width, height } = source.cells;
  const grid = maskGridSize(source.imageWidth, source.imageHeight, d);
  if (width === 0 || height === 0) {
    return denseRaster({
      cells: { x: 0, y: 0, width: 0, height: 0 },
      data: new Uint8Array(0),
      imageWidth: source.imageWidth,
      imageHeight: source.imageHeight,
      downsample: coarseD,
    });
  }
  const cx0 = Math.floor(x / 2);
  const cy0 = Math.floor(y / 2);
  const coarseWidth = Math.ceil((x + width) / 2) - cx0;
  const coarseHeight = Math.ceil((y + height) / 2) - cy0;

  // Set children per coarse cell: read straight from the bytes of a dense
  // raster — the brush's buffer, the one this runs on mid-stroke — and from
  // the spans of any other.
  const dense = denseSnapshotOf(source);
  const counts = dense
    ? countDense(dense, cx0, cy0, coarseWidth, coarseHeight)
    : countSpans(source, cx0, cy0, coarseWidth, coarseHeight);

  const data = new Uint8Array(coarseWidth * coarseHeight);
  for (let r = 0; r < coarseHeight; r++) {
    const ccy = cy0 + r;
    // Children down this coarse row: two, or one at the grid's last odd row.
    const rows = Math.min(2, grid.height - ccy * 2);
    for (let c = 0; c < coarseWidth; c++) {
      const set = counts[r * coarseWidth + c]!;
      if (set === 0) continue;
      const ccx = cx0 + c;
      const cols = Math.min(2, grid.width - ccx * 2);
      const children = rows * cols;
      const twice = set * 2;
      if (twice > children || (twice === children && ((ccx + ccy) & 1) === 0)) {
        data[r * coarseWidth + c] = 1;
      }
    }
  }

  // The box covers the source's, so it is not necessarily tight: readers and
  // encoders take any box on the grid, and a buffer crops on snapshot.
  return denseRaster({
    cells: { x: cx0, y: cy0, width: coarseWidth, height: coarseHeight },
    data,
    imageWidth: source.imageWidth,
    imageHeight: source.imageHeight,
    downsample: coarseD,
  });
};

/** Set children per coarse cell, from a raster's spans. */
function countSpans(
  source: MaskRaster,
  cx0: number,
  cy0: number,
  coarseWidth: number,
  coarseHeight: number,
): Uint8Array {
  const counts = new Uint8Array(coarseWidth * coarseHeight);
  forEachCheckedSpan(source, (cy, x0, x1) => {
    const row = (Math.floor(cy / 2) - cy0) * coarseWidth;
    for (let cx = x0; cx < x1; cx++) counts[row + (cx >> 1) - cx0]!++;
  });
  return counts;
}

/**
 * Set children per coarse cell, from a dense snapshot's bytes: each source row
 * pair once, adding a byte pair per coarse cell, with no span to find: about
 * 300 ms against 400 for the span walk on an 8,180-square buffer, in Node. A
 * byte counts only when it is 1, as `DenseMaskRaster` reads it, so both paths
 * agree on any bytes.
 */
function countDense(
  source: MaskSnapshot,
  cx0: number,
  cy0: number,
  coarseWidth: number,
  coarseHeight: number,
): Uint8Array {
  const { x, y, width, height } = source.cells;
  const data = source.data;
  const counts = new Uint8Array(coarseWidth * coarseHeight);
  for (let row = 0; row < height; row++) {
    const out = ((y + row) >> 1) - cy0;
    const base = out * coarseWidth - cx0;
    const offset = row * width;
    // A leading odd column pairs with nothing to its left in the box.
    let col = 0;
    if ((x & 1) === 1) {
      counts[base + (x >> 1)]! += data[offset] === 1 ? 1 : 0;
      col = 1;
    }
    for (; col + 1 < width; col += 2) {
      counts[base + ((x + col) >> 1)]! +=
        (data[offset + col] === 1 ? 1 : 0) + (data[offset + col + 1] === 1 ? 1 : 0);
    }
    if (col < width) counts[base + ((x + col) >> 1)]! += data[offset + col] === 1 ? 1 : 0;
  }
  return counts;
}
