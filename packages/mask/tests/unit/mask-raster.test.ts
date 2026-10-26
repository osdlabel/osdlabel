import { describe, it, expect } from 'vitest';
import {
  BoundedDenseMaskBuffer,
  decodeCanonicalRaster,
  denseRaster,
  emptySnapshot,
  encodeCanonical,
  forEachCheckedSpan,
  forEachLevel0Span,
  rasterPixelCount,
  snapshotPixelCount,
  stampCircle,
  strokeSegment,
  upsampleSnapshot,
  type MaskCellBox,
  type MaskRaster,
} from '../../src/index.js';
import { TiledMaskRaster } from './tiled-mask-raster.js';

type Span = readonly [number, number, number];

/** Every span a raster visits through its own `forEachSpan`, honouring `within` if it does. */
function spansOf(raster: MaskRaster, within?: MaskCellBox): Span[] {
  const spans: Span[] = [];
  raster.forEachSpan((cy, x0, x1) => spans.push([cy, x0, x1]), within);
  return spans;
}

/** The spans `forEachCheckedSpan` delivers. */
function checkedSpansOf(raster: MaskRaster, within?: MaskCellBox): Span[] {
  const spans: Span[] = [];
  forEachCheckedSpan(raster, (cy, x0, x1) => spans.push([cy, x0, x1]), within);
  return spans;
}

/** The full walk clipped to a window by hand: the reference `within` must match. */
function clip(spans: readonly Span[], w: MaskCellBox): Span[] {
  const out: Span[] = [];
  for (const [cy, x0, x1] of spans) {
    if (cy < w.y || cy >= w.y + w.height) continue;
    const left = Math.max(x0, w.x);
    const right = Math.min(x1, w.x + w.width);
    if (right > left) out.push([cy, left, right]);
  }
  return out;
}

/** Touching spans in a row merged, so rasters that split runs differently compare equal. */
function merged(spans: readonly Span[]): Span[] {
  const out: [number, number, number][] = [];
  for (const [cy, x0, x1] of spans) {
    const last = out[out.length - 1];
    if (last && last[0] === cy && last[2] === x0) last[2] = x1;
    else out.push([cy, x0, x1]);
  }
  return out;
}

/** A small deterministic generator, so a failing window reproduces. */
function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

/** The same painted mask behind all three raster kinds. */
function rasters(): { name: string; raster: MaskRaster }[] {
  const buffer = new BoundedDenseMaskBuffer({ imageWidth: 301, imageHeight: 203, downsample: 4 });
  strokeSegment(buffer, 20, 30, 290, 190, 14, 1);
  stampCircle(buffer, 150, 110, 18, 0);
  stampCircle(buffer, 290, 195, 9, 1); // touches the clipped edges
  const dense = buffer.raster();
  return [
    { name: 'dense', raster: dense },
    { name: 'run', raster: decodeCanonicalRaster(encodeCanonical(dense)) },
    { name: 'tiled', raster: TiledMaskRaster.from(dense, 5) },
  ];
}

describe('MaskRaster.forEachSpan within a window', () => {
  for (const { name, raster } of rasters()) {
    describe(name, () => {
      const box = raster.cells;
      const full = spansOf(raster);

      it('visits the whole mask without a window', () => {
        expect(full.length).toBeGreaterThan(10);
        expect(merged(full)).toEqual(merged(spansOf(rasters()[0]!.raster)));
      });

      it('equals the clipped full walk on random windows', () => {
        const next = random(42);
        for (let i = 0; i < 200; i++) {
          const w: MaskCellBox = {
            x: box.x - 5 + Math.floor(next() * (box.width + 10)),
            y: box.y - 5 + Math.floor(next() * (box.height + 10)),
            width: Math.floor(next() * box.width),
            height: Math.floor(next() * box.height),
          };
          expect(merged(spansOf(raster, w))).toEqual(merged(clip(full, w)));
          expect(merged(checkedSpansOf(raster, w))).toEqual(merged(clip(full, w)));
        }
      });

      it('visits nothing for an empty or an outside window', () => {
        expect(spansOf(raster, { x: box.x, y: box.y, width: 0, height: 5 })).toEqual([]);
        expect(spansOf(raster, { x: box.x, y: box.y, width: 5, height: 0 })).toEqual([]);
        const outside = { x: box.x + box.width + 1, y: box.y, width: 10, height: 10 };
        expect(spansOf(raster, outside)).toEqual([]);
        expect(checkedSpansOf(raster, outside)).toEqual([]);
        const above = { x: box.x, y: box.y - 20, width: box.width, height: 20 };
        expect(spansOf(raster, above)).toEqual([]);
      });

      it('visits everything for a window larger than the box', () => {
        const oversized = {
          x: box.x - 100,
          y: box.y - 100,
          width: box.width + 200,
          height: box.height + 200,
        };
        expect(merged(spansOf(raster, oversized))).toEqual(merged(full));
      });
    });
  }
});

describe('a raster that ignores the window', () => {
  // The window is a hint: a host raster that visits every span regardless is
  // still valid, and the checked walk must clip for it rather than refuse.
  const ignoring = (raster: MaskRaster): MaskRaster => ({
    cells: raster.cells,
    imageWidth: raster.imageWidth,
    imageHeight: raster.imageHeight,
    downsample: raster.downsample,
    get cellCount() {
      return raster.cellCount;
    },
    get: (cx, cy) => raster.get(cx, cy),
    forEachSpan: (visit) => raster.forEachSpan(visit),
  });

  for (const { name, raster } of rasters()) {
    it(`${name}: gives the same results as one that honours it`, () => {
      const lazy = ignoring(raster);
      const box = raster.cells;
      const next = random(7);
      for (let i = 0; i < 100; i++) {
        const w: MaskCellBox = {
          x: box.x - 3 + Math.floor(next() * (box.width + 6)),
          y: box.y - 3 + Math.floor(next() * (box.height + 6)),
          width: 1 + Math.floor(next() * box.width),
          height: 1 + Math.floor(next() * box.height),
        };
        expect(merged(checkedSpansOf(lazy, w))).toEqual(merged(checkedSpansOf(raster, w)));
      }
      // Whole-mask readers are unaffected by the window either way.
      expect(encodeCanonical(lazy)).toEqual(encodeCanonical(raster));
      expect(rasterPixelCount(lazy)).toBe(rasterPixelCount(raster));
    });
  }

  it('is still checked against the contract outside the window', () => {
    const base = rasters()[0]!.raster;
    const bad: MaskRaster = {
      ...ignoring(base),
      cellCount: 0,
      // A span outside the box, far from the window asked for.
      forEachSpan: (visit) => visit(base.cells.y, base.cells.x - 10, base.cells.x - 5),
    };
    const window = { x: base.cells.x + 1, y: base.cells.y + 1, width: 2, height: 2 };
    expect(() => checkedSpansOf(bad, window)).toThrow(/outside/);
  });
});

describe('forEachLevel0Span', () => {
  /** The level-0 spans of the fully expanded mask, the reference. */
  function level0Reference(raster: MaskRaster): Span[] {
    const expanded = denseRaster(upsampleSnapshot(raster, Infinity));
    return merged(spansOf(expanded));
  }
  function level0Spans(raster: MaskRaster): Span[] {
    const spans: Span[] = [];
    forEachLevel0Span(raster, (y, x0, x1) => spans.push([y, x0, x1]));
    return spans;
  }

  for (const { name, raster } of rasters()) {
    it(`${name}: equals the expanded mask, clipped edges included`, () => {
      const spans = level0Spans(raster);
      expect(spans).toEqual(level0Reference(raster));
      // Maximal: no two spans in a row touch.
      expect(merged(spans)).toEqual(spans);
      let pixels = 0;
      for (const [, x0, x1] of spans) pixels += x1 - x0;
      expect(pixels).toBe(snapshotPixelCount(raster));
    });
  }

  it('is the identity on a full-resolution mask', () => {
    const buffer = new BoundedDenseMaskBuffer({ imageWidth: 64, imageHeight: 48 });
    stampCircle(buffer, 30, 20, 9, 1);
    const raster = buffer.raster();
    expect(level0Spans(raster)).toEqual(merged(spansOf(raster)));
  });

  it('visits nothing for an empty mask', () => {
    expect(level0Spans(denseRaster(emptySnapshot(10, 10)))).toEqual([]);
  });
});

describe('the cell box is nested', () => {
  it('makes reading a cell box as image pixels a compile error', () => {
    const snapshot = emptySnapshot(10, 10);
    const raster = denseRaster(snapshot);
    // @ts-expect-error -- the box is `snapshot.cells`, in cells, not a top-level image box
    expect(snapshot.x).toBeUndefined();
    // @ts-expect-error -- likewise on a raster
    expect(raster.width).toBeUndefined();
    expect(snapshot.cells).toEqual({ x: 0, y: 0, width: 0, height: 0 });
  });
});
