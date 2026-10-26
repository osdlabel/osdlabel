import { describe, it, expect } from 'vitest';
import {
  BoundedDenseMaskBuffer,
  MaskCapacityExceededError,
  majorityCoarsen,
  rasterPixelCount,
  refineRaster,
  snapshotImageBox,
  stampCircle,
  type MaskRaster,
} from '../../src/index.js';

/** A disc painted at downsample `d` on a `w` x `h` image. */
function disc(w: number, h: number, d: number): MaskRaster {
  const fine = new BoundedDenseMaskBuffer({ imageWidth: w, imageHeight: h });
  stampCircle(fine, w / 2, h / 2, Math.min(w, h) / 3, 1);
  let raster = fine.raster();
  while (raster.downsample < d) raster = majorityCoarsen(raster);
  return raster;
}

describe('refineRaster', () => {
  it('covers exactly the image pixels the source does, at every finer downsample', () => {
    for (const [w, h] of [
      [100, 60],
      [101, 59],
    ] as const) {
      const coarse = disc(w, h, 8);
      for (const d of [4, 2, 1]) {
        const fine = refineRaster(coarse, d);
        expect(fine.downsample).toBe(d);
        expect(rasterPixelCount(fine), `${w}x${h} at d=${d}`).toBe(rasterPixelCount(coarse));
        expect(snapshotImageBox(fine)).toEqual(snapshotImageBox(coarse));
      }
    }
  });

  it('is undone exactly by majorityCoarsen, clipped edges included', () => {
    const coarse = disc(101, 59, 4);
    let back = refineRaster(coarse, 1);
    while (back.downsample < 4) back = majorityCoarsen(back);
    expect(back.cellCount).toBe(coarse.cellCount);
    coarse.forEachSpan((cy, x0, x1) => {
      for (let cx = x0; cx < x1; cx++) expect(back.get(cx, cy)).toBe(1);
    });
  });

  it('returns the source at its own downsample, and refuses to go coarser', () => {
    const coarse = disc(64, 64, 2);
    expect(refineRaster(coarse, 2)).toBe(coarse);
    expect(() => refineRaster(coarse, 4)).toThrow(RangeError);
    expect(() => refineRaster(coarse, 3)).toThrow();
  });

  it('refuses a box past its cap by name', () => {
    const coarse = disc(400, 400, 4);
    expect(() => refineRaster(coarse, 1, 1_000)).toThrow(MaskCapacityExceededError);
  });
});
