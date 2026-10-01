import { describe, expect, it } from 'vitest';
import type { Geometry } from '@osdlabel/annotation';
import type { PixelSpacing } from '@osdlabel/viewer-api';
import {
  formatMeasurement,
  measureDistance,
  measureLength,
  measurePerimeter,
  toPhysicalArea,
  toPhysicalLength,
} from '../../src/measurement.js';

describe('toPhysicalLength', () => {
  it('returns pixels when no spacing is provided', () => {
    expect(toPhysicalLength(100, undefined)).toEqual({ value: 100, unit: 'px' });
  });
  it('uses mean spacing by default', () => {
    expect(toPhysicalLength(10, { x: 0.5, y: 0.7, unit: 'mm' })).toEqual({
      value: 6,
      unit: 'mm',
    });
  });
  it('honors axis="x"', () => {
    expect(toPhysicalLength(10, { x: 0.5, y: 0.7, unit: 'mm' }, 'x')).toEqual({
      value: 5,
      unit: 'mm',
    });
  });
  it('honors axis="y"', () => {
    expect(toPhysicalLength(10, { x: 0.5, y: 0.7, unit: 'mm' }, 'y')).toEqual({
      value: 7,
      unit: 'mm',
    });
  });
});

describe('toPhysicalArea', () => {
  it('returns px² when no spacing is provided', () => {
    expect(toPhysicalArea(50, undefined)).toEqual({ value: 50, unit: 'px²' });
  });
  it('multiplies by x*y product (anisotropic-safe)', () => {
    expect(toPhysicalArea(100, { x: 0.5, y: 0.4, unit: 'mm' })).toEqual({
      value: 20,
      unit: 'mm²',
    });
  });
});

describe('formatMeasurement', () => {
  it('default precision is 2 with a space separator', () => {
    expect(formatMeasurement({ value: 12.34567, unit: 'mm' })).toBe('12.35 mm');
  });
  it('honors precision option', () => {
    expect(formatMeasurement({ value: 1 / 3, unit: 'mm' }, { precision: 4 })).toBe('0.3333 mm');
  });
  it('honors unitSeparator', () => {
    expect(formatMeasurement({ value: 5, unit: 'px' }, { unitSeparator: '' })).toBe('5.00px');
  });
});

// The example from #187: 0.1 mm/px horizontally, 0.2 mm/px vertically. Mean
// spacing labelled both 100 px lines below "15.00 mm".
const ANISO: PixelSpacing = { x: 0.1, y: 0.2, unit: 'mm' };
const ISO: PixelSpacing = { x: 0.5, y: 0.5, unit: 'mm' };

const line = (x1: number, y1: number, x2: number, y2: number): Geometry => ({
  type: 'line',
  start: { x: x1, y: y1 },
  end: { x: x2, y: y2 },
});

describe('measureDistance', () => {
  it('returns the pixel distance when no spacing is provided', () => {
    expect(measureDistance({ x: 0, y: 0 }, { x: 3, y: 4 }, undefined)).toEqual({
      value: 5,
      unit: 'px',
    });
  });

  it('converts each axis with its own spacing (#187)', () => {
    const h = measureDistance({ x: 0, y: 0 }, { x: 100, y: 0 }, ANISO);
    const v = measureDistance({ x: 0, y: 0 }, { x: 0, y: 100 }, ANISO);
    expect(h.unit).toBe('mm');
    expect(h.value).toBeCloseTo(10, 10);
    expect(v.value).toBeCloseTo(20, 10);
  });

  it('is exact for a diagonal: hypot(dx·sx, dy·sy)', () => {
    // dx·sx = 30·0.1 = 3, dy·sy = 20·0.2 = 4
    expect(measureDistance({ x: 10, y: 10 }, { x: 40, y: 30 }, ANISO).value).toBeCloseTo(5, 10);
  });

  it('agrees with mean conversion when spacing is isotropic', () => {
    const d = measureDistance({ x: 0, y: 0 }, { x: 6, y: 8 }, ISO);
    expect(d.value).toBeCloseTo(toPhysicalLength(10, ISO).value, 10);
  });
});

describe('measureLength', () => {
  it('returns pixel length when no spacing is provided', () => {
    expect(measureLength(line(0, 0, 3, 4), undefined)).toEqual({ value: 5, unit: 'px' });
  });

  it('converts a line per axis', () => {
    expect(measureLength(line(0, 0, 100, 0), ANISO).value).toBeCloseTo(10, 10);
    expect(measureLength(line(0, 0, 0, 100), ANISO).value).toBeCloseTo(20, 10);
  });

  it('sums polyline segments, each converted per axis', () => {
    const polyline: Geometry = {
      type: 'polyline',
      points: [
        { x: 0, y: 0 },
        { x: 100, y: 0 },
        { x: 100, y: 100 },
      ],
    };
    // 100 px across (10 mm) then 100 px down (20 mm)
    expect(measureLength(polyline, ANISO).value).toBeCloseTo(30, 10);
  });

  it('is the perimeter for closed shapes and 0 for a point', () => {
    const square: Geometry = {
      type: 'rectangle',
      origin: { x: 0, y: 0 },
      width: 10,
      height: 10,
      rotation: 0,
    };
    expect(measureLength(square, ANISO)).toEqual(measurePerimeter(square, ANISO));
    expect(measureLength({ type: 'point', position: { x: 1, y: 1 } }, ANISO)).toEqual({
      value: 0,
      unit: 'mm',
    });
  });
});

describe('measurePerimeter', () => {
  it('returns the pixel perimeter when no spacing is provided', () => {
    const circle: Geometry = { type: 'circle', center: { x: 0, y: 0 }, radius: 2 };
    expect(measurePerimeter(circle, undefined)).toEqual({ value: 4 * Math.PI, unit: 'px' });
  });

  it('converts an axis-aligned rectangle per edge', () => {
    const rect: Geometry = {
      type: 'rectangle',
      origin: { x: 0, y: 0 },
      width: 100,
      height: 50,
      rotation: 0,
    };
    // 2·(100·0.1 + 50·0.2) = 2·(10 + 10)
    expect(measurePerimeter(rect, ANISO).value).toBeCloseTo(40, 10);
  });

  it('follows a rotated rectangle: at 90° its width runs vertically', () => {
    const rect: Geometry = {
      type: 'rectangle',
      origin: { x: 0, y: 0 },
      width: 100,
      height: 50,
      rotation: 90,
    };
    // 2·(100·0.2 + 50·0.1) = 2·(20 + 5)
    expect(measurePerimeter(rect, ANISO).value).toBeCloseTo(50, 10);
  });

  it('matches the equivalent polygon for a rotated rectangle', () => {
    const theta = (30 * Math.PI) / 180;
    const [w, h] = [80, 30];
    const rect: Geometry = {
      type: 'rectangle',
      origin: { x: 5, y: 7 },
      width: w,
      height: h,
      rotation: 30,
    };
    const corner = (lx: number, ly: number) => ({
      x: 5 + lx * Math.cos(theta) - ly * Math.sin(theta),
      y: 7 + lx * Math.sin(theta) + ly * Math.cos(theta),
    });
    const polygon: Geometry = {
      type: 'polygon',
      points: [corner(0, 0), corner(w, 0), corner(w, h), corner(0, h)],
    };
    expect(measurePerimeter(rect, ANISO).value).toBeCloseTo(
      measurePerimeter(polygon, ANISO).value,
      10,
    );
  });

  it('closes a polygon, converting every edge per axis', () => {
    const triangle: Geometry = {
      type: 'polygon',
      points: [
        { x: 0, y: 0 },
        { x: 30, y: 0 },
        { x: 30, y: 20 },
      ],
    };
    // 3 mm across, 4 mm down, 5 mm back along the hypotenuse
    expect(measurePerimeter(triangle, ANISO).value).toBeCloseTo(12, 10);
  });

  it('is exactly 2πr·s for a circle under isotropic spacing', () => {
    const circle: Geometry = { type: 'circle', center: { x: 0, y: 0 }, radius: 4 };
    expect(measurePerimeter(circle, ISO).value).toBeCloseTo(2 * Math.PI * 4 * 0.5, 12);
  });

  it('treats a circle as an ellipse under anisotropic spacing', () => {
    const circle: Geometry = { type: 'circle', center: { x: 0, y: 0 }, radius: 100 };
    // Semi-axes 10 mm and 20 mm; the exact circumference is 96.88448…
    expect(measurePerimeter(circle, ANISO).value).toBeCloseTo(96.884482, 5);
  });

  it('stays within the documented 1e-6 relative error at a 1:5 spacing ratio', () => {
    const circle: Geometry = { type: 'circle', center: { x: 0, y: 0 }, radius: 100 };
    const spacing: PixelSpacing = { x: 0.1, y: 0.5, unit: 'mm' };
    // Semi-axes 10 mm and 50 mm. Reference from Simpson integration of the
    // ellipse arc length (2M intervals), independent of the code under test.
    const exact = 210.10044539689932;
    const relError = Math.abs(measurePerimeter(circle, spacing).value - exact) / exact;
    // Ramanujan II is 8.5e-7 off here: inside the bound the JSDoc, the
    // measurements guide and the changeset state, with little headroom.
    expect(relError).toBeLessThan(1e-6);
  });

  it('is 0 for open shapes', () => {
    expect(measurePerimeter(line(0, 0, 10, 10), ANISO)).toEqual({ value: 0, unit: 'mm' });
  });
});
