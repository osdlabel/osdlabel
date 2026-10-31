import { describe, it, expect } from 'vitest';
import {
  BoundedDenseMaskBuffer,
  denseRaster,
  majorityCoarsen,
  refineRaster,
  rasterToRuns,
  runRaster,
  toDenseSnapshot,
  rasterPixelCount,
  snapshotImageBox,
  stampCircle,
  strokeSegment,
  type MaskRaster,
} from '../../src/index.js';

/** Every set cell of a raster, as `cx,cy` strings. */
function setCells(raster: MaskRaster): Set<string> {
  const out = new Set<string>();
  raster.forEachSpan((cy, x0, x1) => {
    for (let cx = x0; cx < x1; cx++) out.add(`${cx},${cy}`);
  });
  return out;
}

/** A deterministic generator, so a failing case reproduces. */
function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

describe('majorityCoarsen', () => {
  it('halves the resolution and keeps the level-0 box covered', () => {
    const buffer = new BoundedDenseMaskBuffer({ imageWidth: 301, imageHeight: 203 });
    strokeSegment(buffer, 20, 30, 290, 190, 14, 1);
    const fine = buffer.raster();
    const coarse = majorityCoarsen(fine);
    expect(coarse.downsample).toBe(2);
    const fineBox = snapshotImageBox(fine);
    const coarseBox = snapshotImageBox(coarse);
    expect(coarseBox.x).toBeLessThanOrEqual(fineBox.x);
    expect(coarseBox.y).toBeLessThanOrEqual(fineBox.y);
    expect(coarseBox.x + coarseBox.width).toBeGreaterThanOrEqual(fineBox.x + fineBox.width);
    expect(coarseBox.y + coarseBox.height).toBeGreaterThanOrEqual(fineBox.y + fineBox.height);
  });

  it('undoes re-gridding finer exactly, clipped image edges included', () => {
    const next = random(5);
    for (let trial = 0; trial < 20; trial++) {
      // An odd-sized image, so the last coarse column and row have one child.
      const imageWidth = 51 + 2 * Math.floor(next() * 40);
      const imageHeight = 31 + 2 * Math.floor(next() * 40);
      const coarseBuffer = new BoundedDenseMaskBuffer({ imageWidth, imageHeight, downsample: 2 });
      for (let s = 0; s < 4; s++) {
        stampCircle(coarseBuffer, next() * imageWidth, next() * imageHeight, 2 + next() * 12, 1);
        stampCircle(coarseBuffer, next() * imageWidth, next() * imageHeight, 1 + next() * 5, 0);
      }
      stampCircle(coarseBuffer, imageWidth - 1, imageHeight - 1, 4, 1);
      const coarse = coarseBuffer.raster();

      // Replicate each coarse cell to its (clipped) 2x2 block at full resolution.
      const fine = new BoundedDenseMaskBuffer({ imageWidth, imageHeight });
      coarse.forEachSpan((cy, x0, x1) => {
        for (let cx = x0; cx < x1; cx++) {
          for (const [dx, dy] of [
            [0, 0],
            [1, 0],
            [0, 1],
            [1, 1],
          ] as const) {
            fine.set(cx * 2 + dx, cy * 2 + dy, 1);
          }
        }
      });
      expect(setCells(majorityCoarsen(fine.raster())), `trial ${trial}`).toEqual(setCells(coarse));
    }
  });

  it('breaks a 2-of-4 tie, and a 1-of-2 one at the edge, by absolute cell parity', () => {
    // A checkerboard: every full block has exactly two children set, and the
    // edge blocks of an odd-sized image exactly one of two.
    const imageWidth = 21;
    const imageHeight = 13;
    const fine = new BoundedDenseMaskBuffer({ imageWidth, imageHeight });
    for (let y = 0; y < imageHeight; y++) {
      for (let x = 0; x < imageWidth; x++) if ((x + y) % 2 === 0) fine.set(x, y, 1);
    }
    const coarse = majorityCoarsen(fine.raster());
    for (let cy = 0; cy < Math.ceil(imageHeight / 2); cy++) {
      for (let cx = 0; cx < Math.ceil(imageWidth / 2); cx++) {
        const rows = Math.min(2, imageHeight - cy * 2);
        const cols = Math.min(2, imageWidth - cx * 2);
        // The corner's one child, fine (20, 12), is set; every other block is
        // a tie, broken by the coarse cell's parity.
        const expected = rows * cols === 1 ? 1 : (cx + cy) % 2 === 0 ? 1 : 0;
        expect(coarse.get(cx, cy), `cell ${cx},${cy}`).toBe(expected);
      }
    }
  });

  it('breaks ties by absolute parity whatever the box, on dense and run rasters (#243 minor 6)', () => {
    // A checkerboard from an odd origin: relative to the box, every coarse
    // cell's parity is flipped, so a box-relative tie-break sets the others.
    const imageWidth = 40;
    const imageHeight = 30;
    const box = { x: 3, y: 5, width: 30, height: 20 };
    const data = new Uint8Array(box.width * box.height);
    for (let r = 0; r < box.height; r++) {
      for (let c = 0; c < box.width; c++) {
        if ((box.x + c + box.y + r) % 2 === 0) data[r * box.width + c] = 1;
      }
    }
    const tight = denseRaster({ cells: box, data, imageWidth, imageHeight, downsample: 1 });
    const padded = toDenseSnapshot(tight);
    const wide = { x: 0, y: 0, width: imageWidth, height: imageHeight };
    const wideData = new Uint8Array(imageWidth * imageHeight);
    tight.forEachSpan((cy, x0, x1) => wideData.fill(1, cy * imageWidth + x0, cy * imageWidth + x1));
    const sources = [
      tight,
      runRaster(tight, rasterToRuns(tight)),
      denseRaster({ ...padded, cells: wide, data: wideData }),
    ];
    for (const [i, source] of sources.entries()) {
      const coarse = majorityCoarsen(source);
      // The coarse cells whose four children all lie inside the box: ties.
      for (let cy = 3; cy < 12; cy++) {
        for (let cx = 2; cx < 16; cx++) {
          expect(coarse.get(cx, cy), `source ${i}, cell ${cx},${cy}`).toBe(
            (cx + cy) % 2 === 0 ? 1 : 0,
          );
        }
      }
      expect(setCells(coarse), `source ${i}`).toEqual(setCells(majorityCoarsen(tight)));
    }
  });

  it('counts a dense byte only when it is 1, as the span path does (#243 minor 5)', () => {
    const cells = { x: 0, y: 0, width: 2, height: 2 };
    const raster = denseRaster({
      cells,
      data: new Uint8Array([2, 2, 1, 0]),
      imageWidth: 2,
      imageHeight: 2,
      downsample: 1,
    });
    // One child of four is set, as `get` and the spans read it.
    expect(raster.cellCount).toBe(1);
    expect(majorityCoarsen(raster).get(0, 0)).toBe(0);
    expect(majorityCoarsen(runRaster(raster, rasterToRuns(raster))).get(0, 0)).toBe(0);
  });

  it('keeps area unbiased on random discs, through d = 16', () => {
    const next = random(9);
    let relativeErrorSum = 0;
    let n = 0;
    for (let trial = 0; trial < 40; trial++) {
      const buffer = new BoundedDenseMaskBuffer({ imageWidth: 2000, imageHeight: 2000 });
      const radius = 60 + next() * 400;
      stampCircle(buffer, 300 + next() * 1400, 300 + next() * 1400, radius, 1);
      let raster = buffer.raster();
      const area = rasterPixelCount(raster);
      for (const d of [2, 4, 8, 16]) {
        raster = majorityCoarsen(raster);
        expect(raster.downsample).toBe(d);
        const error = (rasterPixelCount(raster) - area) / area;
        // Each disc within a few percent; the cell is at most a sixth of the
        // radius here.
        expect(Math.abs(error), `trial ${trial} d=${d}`).toBeLessThan(0.08);
        if (d === 16) {
          relativeErrorSum += error;
          n++;
        }
      }
    }
    // And no drift across discs: the parity tie-break neither grows nor
    // shrinks them on average.
    expect(Math.abs(relativeErrorSum / n)).toBeLessThan(0.005);
  });

  it('refuses to go past the largest downsample', () => {
    const buffer = new BoundedDenseMaskBuffer({
      imageWidth: 2 ** 20,
      imageHeight: 2 ** 20,
      downsample: 2 ** 16,
    });
    buffer.set(0, 0, 1);
    expect(() => majorityCoarsen(buffer.raster())).toThrow(/power of two/);
  });

  it('refuses an off-grid box when coarsening or re-gridding it (#243 round 2, minor 5)', () => {
    // b6ecb55's example: 37 x 23 at d=4 is a 10 x 6 cell grid, and a box from
    // column 9, two wide, leaves it. Re-gridded, it came back clipped.
    const offGrid = denseRaster({
      cells: { x: 9, y: 2, width: 2, height: 1 },
      data: new Uint8Array([1, 1]),
      imageWidth: 37,
      imageHeight: 23,
      downsample: 4,
    });
    expect(() => refineRaster(offGrid, 1)).toThrow(RangeError);
    expect(() => majorityCoarsen(offGrid)).toThrow(RangeError);
  });
});
