import type { CoarsenStrategy } from './coarsen.js';
import { maskGridSize } from './downsample.js';
import {
  denseRaster,
  forEachCheckedSpan,
  rasterToRuns,
  runRaster,
  type MaskRaster,
} from './mask-raster.js';
import { refineRaster } from './regrid.js';

/** The most violations reported per rule: enough to see the pattern. */
const MAX_PER_RULE = 3;

/**
 * Checks a {@link CoarsenStrategy} against the contract the brush relies on,
 * on generated masks, and returns the violations found — empty when it holds.
 *
 * 1. **Deterministic:** the same raster, or an equal one, coarsens the same.
 * 2. **Valid:** the result is at twice the downsample, on the same image,
 *    inside the coarse grid, keeps the span contract, and sets no cell outside
 *    the source's box rounded out to the coarse grid.
 * 3. **Undoes re-gridding:** coarsening a mask just re-gridded one step finer
 *    ({@link refineRaster}) returns it. Without this, refining at a closer zoom
 *    and overflowing again would erode the mask a little every cycle.
 *
 * The masks cover odd image sizes, boxes against the image's edges, noise at
 * several densities, discs, checkerboards (every coarse cell a tie) and the
 * empty mask, at downsamples 1, 2 and 4, from a fixed seed. Passing does not
 * prove a strategy correct; failing proves it is not.
 */
export function verifyCoarsenStrategy(strategy: CoarsenStrategy): readonly string[] {
  const found = new Map<string, string[]>();
  const report = (rule: string, message: string) => {
    const list = found.get(rule) ?? [];
    if (list.length < MAX_PER_RULE) list.push(`${rule}: ${message}`);
    found.set(rule, list);
  };
  const run = (raster: MaskRaster, label: string): MaskRaster | null => {
    try {
      return strategy(raster);
    } catch (error) {
      report('valid', `${label}: threw ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
  };

  const random = mulberry32(0x5eed);
  for (const [imageWidth, imageHeight] of [
    [64, 48],
    [65, 47],
    [33, 77],
  ] as const) {
    for (const d of [1, 2, 4]) {
      for (const [kind, mask] of generateMasks(imageWidth, imageHeight, d, random)) {
        const label = `${kind} on ${imageWidth}x${imageHeight} at d=${d}`;

        // 1. Deterministic, on the same raster and on an equal copy.
        const first = run(mask, label);
        const again = run(mask, label);
        const copy = run(runRaster(mask, rasterToRuns(mask)), label);
        if (!first) continue;
        if ((again && !sameCells(first, again)) || (copy && !sameCells(first, copy))) {
          report('deterministic', `${label}: two runs disagree`);
        }

        // 2. Valid.
        const problem = invalidity(mask, first);
        if (problem) report('valid', `${label}: ${problem}`);

        // 3. Undoes re-gridding: the mask at 2d, refined to d, coarsened.
        if (d * 4 > 1 << 16) continue;
        const coarse = asCoarse(mask);
        const back = run(refineRaster(coarse, d), `${label}, re-gridded`);
        if (back && !sameCells(back, coarse)) {
          report('undoes re-gridding', `${label}: re-gridded then coarsened differs`);
        }
      }
    }
  }
  return [...found.values()].flat();
}

/** Why `result` is not a valid coarsening of `source`, or `null`. */
function invalidity(source: MaskRaster, result: MaskRaster): string | null {
  const d = source.downsample * 2;
  if (result.downsample !== d) return `downsample ${result.downsample}, not ${d}`;
  if (result.imageWidth !== source.imageWidth || result.imageHeight !== source.imageHeight) {
    return 'a different image size';
  }
  const { x, y, width, height } = result.cells;
  const grid = maskGridSize(source.imageWidth, source.imageHeight, d);
  if (![x, y, width, height].every(Number.isInteger) || x < 0 || y < 0 || width < 0 || height < 0) {
    return `box ${JSON.stringify(result.cells)} is not on the grid`;
  }
  if (width > 0 && height > 0 && (x + width > grid.width || y + height > grid.height)) {
    return `box ${JSON.stringify(result.cells)} leaves the ${grid.width}x${grid.height} grid`;
  }
  const s = source.cells;
  const cover =
    s.width === 0 || s.height === 0
      ? null
      : {
          x0: Math.floor(s.x / 2),
          y0: Math.floor(s.y / 2),
          x1: Math.ceil((s.x + s.width) / 2),
          y1: Math.ceil((s.y + s.height) / 2),
        };
  let outside: string | null = null;
  try {
    forEachCheckedSpan(result, (cy, x0, x1) => {
      if (outside) return;
      if (!cover || cy < cover.y0 || cy >= cover.y1 || x0 < cover.x0 || x1 > cover.x1) {
        outside = `sets cells [${x0}, ${x1}) on row ${cy}, outside the source's box`;
      }
    });
  } catch (error) {
    return `breaks the span contract: ${error instanceof Error ? error.message : String(error)}`;
  }
  return outside;
}

/** Whether two rasters set the same cells at the same downsample, whatever their boxes. */
function sameCells(a: MaskRaster, b: MaskRaster): boolean {
  if (a.downsample !== b.downsample || a.cellCount !== b.cellCount) return false;
  let same = true;
  a.forEachSpan((cy, x0, x1) => {
    if (!same) return;
    for (let cx = x0; cx < x1; cx++) {
      if (b.get(cx, cy) !== 1) {
        same = false;
        return;
      }
    }
  });
  return same;
}

/**
 * A mask at twice `mask`'s downsample with the same pattern of cells, for the
 * re-gridding rule: read cell for cell onto the coarser grid, clipped to it.
 */
function asCoarse(mask: MaskRaster): MaskRaster {
  const d = mask.downsample * 2;
  const grid = maskGridSize(mask.imageWidth, mask.imageHeight, d);
  const { x, y } = mask.cells;
  const width = Math.max(0, Math.min(mask.cells.width, grid.width - x));
  const height = Math.max(0, Math.min(mask.cells.height, grid.height - y));
  const data = new Uint8Array(width * height);
  for (let r = 0; r < height; r++) {
    for (let c = 0; c < width; c++) data[r * width + c] = mask.get(x + c, y + r);
  }
  return denseRaster({
    cells: width > 0 && height > 0 ? { x, y, width, height } : { x: 0, y: 0, width: 0, height: 0 },
    data: width > 0 && height > 0 ? data : new Uint8Array(0),
    imageWidth: mask.imageWidth,
    imageHeight: mask.imageHeight,
    downsample: d,
  });
}

/** The generated masks for one image size and downsample. */
function* generateMasks(
  imageWidth: number,
  imageHeight: number,
  d: number,
  random: () => number,
): Generator<readonly [string, MaskRaster]> {
  const grid = maskGridSize(imageWidth, imageHeight, d);
  const make = (
    box: { x: number; y: number; width: number; height: number },
    cell: (cx: number, cy: number) => boolean,
  ): MaskRaster => {
    const data = new Uint8Array(box.width * box.height);
    for (let r = 0; r < box.height; r++) {
      for (let c = 0; c < box.width; c++) {
        if (cell(box.x + c, box.y + r)) data[r * box.width + c] = 1;
      }
    }
    return denseRaster({ cells: box, data, imageWidth, imageHeight, downsample: d });
  };
  const whole = { x: 0, y: 0, width: grid.width, height: grid.height };
  // A box with odd origin and size, and one against the right and bottom edges.
  const inner = {
    x: 1,
    y: 3,
    width: Math.max(1, grid.width - 4),
    height: Math.max(1, grid.height - 6),
  };
  const corner = {
    x: Math.floor(grid.width / 3),
    y: Math.floor(grid.height / 3),
    width: grid.width - Math.floor(grid.width / 3),
    height: grid.height - Math.floor(grid.height / 3),
  };
  for (const density of [0.3, 0.5, 0.7]) {
    yield [`noise ${density}`, make(inner, () => random() < density)];
    yield [`edge noise ${density}`, make(corner, () => random() < density)];
  }
  const cx = grid.width / 2;
  const cy = grid.height / 2;
  const radius = Math.min(grid.width, grid.height) / 3;
  yield ['disc', make(whole, (x, y) => (x + 0.5 - cx) ** 2 + (y + 0.5 - cy) ** 2 < radius ** 2)];
  yield ['checkerboard', make(inner, (x, y) => ((x + y) & 1) === 0)];
  yield ['edge checkerboard', make(corner, (x, y) => ((x + y) & 1) === 1)];
  yield ['solid edge block', make(corner, () => true)];
  yield [
    'empty',
    denseRaster({
      cells: { x: 0, y: 0, width: 0, height: 0 },
      data: new Uint8Array(0),
      imageWidth,
      imageHeight,
      downsample: d,
    }),
  ];
}

/** A small seeded PRNG, so the check is the same on every run. */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
