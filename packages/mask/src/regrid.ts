import { assertMaskDownsample, maskGridSize } from './downsample.js';
import { MaskCapacityExceededError } from './mask-buffer.js';
import { DEFAULT_MAX_MASK_PIXELS } from './bounded-dense-mask-buffer.js';
import {
  assertRasterOnGrid,
  denseRaster,
  forEachCheckedSpan,
  type MaskRaster,
} from './mask-raster.js';

/**
 * Re-grids a raster to a finer `downsample`, replicating each cell over the
 * finer cells it covers. Lossless: the result covers exactly the image pixels
 * the source does, so coarsening it back by a rule that keeps a block of equal
 * children (as {@link majorityCoarsen} does) returns the source.
 *
 * `downsample` must be a power of two no coarser than the source's. Cells
 * along a clipped image edge replicate only as far as the finer grid reaches.
 * The result is dense; a box of more than `maxCells` cells throws
 * {@link MaskCapacityExceededError}, as any allocation of a mask does.
 */
export function refineRaster(
  source: MaskRaster,
  downsample: number,
  maxCells: number = DEFAULT_MAX_MASK_PIXELS,
): MaskRaster {
  assertMaskDownsample(downsample);
  // An off-grid box was re-gridded as it came, clipped: b6ecb55's 37 x 23
  // example at d=4 came back as {36, 8, 1, 4} (#243 round 2, minor 5).
  if (source.cells.width > 0 && source.cells.height > 0) assertRasterOnGrid(source);
  const d = source.downsample;
  if (downsample > d) {
    throw new RangeError(`refineRaster goes finer: ${downsample} is coarser than ${d}`);
  }
  if (downsample === d) return source;
  const k = d / downsample;
  const grid = maskGridSize(source.imageWidth, source.imageHeight, downsample);
  const { x, y, width, height } = source.cells;
  const left = x * k;
  const top = y * k;
  const right = Math.min((x + width) * k, grid.width);
  const bottom = Math.min((y + height) * k, grid.height);
  const fineWidth = Math.max(0, right - left);
  const fineHeight = Math.max(0, bottom - top);
  if (width === 0 || height === 0 || fineWidth === 0 || fineHeight === 0) {
    return denseRaster({
      cells: { x: 0, y: 0, width: 0, height: 0 },
      data: new Uint8Array(0),
      imageWidth: source.imageWidth,
      imageHeight: source.imageHeight,
      downsample,
    });
  }
  const area = fineWidth * fineHeight;
  if (area > maxCells) throw new MaskCapacityExceededError(area, maxCells, downsample);

  const data = new Uint8Array(area);
  forEachCheckedSpan(source, (cy, x0, x1) => {
    const from = x0 * k - left;
    const to = Math.min(x1 * k, right) - left;
    for (let sub = 0; sub < k; sub++) {
      const row = cy * k + sub;
      if (row >= bottom) break;
      const offset = (row - top) * fineWidth;
      data.fill(1, offset + from, offset + to);
    }
  });
  return denseRaster({
    cells: { x: left, y: top, width: fineWidth, height: fineHeight },
    data,
    imageWidth: source.imageWidth,
    imageHeight: source.imageHeight,
    downsample,
  });
}
