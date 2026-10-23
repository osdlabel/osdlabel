import { describe, expect, it } from 'vitest';
import {
  multiply,
  rotation,
  tileMatrix,
  transformPoint,
  translation,
  viewMatrix,
} from '../../src/mat3.js';

describe('mat3 (OpenSeadragon Mat3 convention)', () => {
  it('multiply composes right-to-left', () => {
    const m = multiply(translation(10, 0), translation(0, 5));
    expect(transformPoint(m, 0, 0)).toEqual({ x: 10, y: 5 });
  });

  it('rotation matches OSD sign (makeRotation(t) turns +x towards -y)', () => {
    const p = transformPoint(rotation(Math.PI / 2), 1, 0);
    expect(p.x).toBeCloseTo(0, 12);
    expect(p.y).toBeCloseTo(-1, 12);
  });

  it('viewMatrix maps the viewport bounds onto clip space, y flipped', () => {
    const v = viewMatrix({ x: 0, y: 0, width: 1, height: 0.5 }, 0, false);
    expect(transformPoint(v, 0, 0)).toEqual({ x: -1, y: 1 });
    expect(transformPoint(v, 1, 0.5)).toEqual({ x: 1, y: -1 });
  });

  it('a horizontal flip mirrors x', () => {
    const v = viewMatrix({ x: 0, y: 0, width: 1, height: 1 }, 0, true);
    expect(transformPoint(v, 0, 0).x).toBe(1);
  });

  it('90° rotation sends the top-left corner to the top-right', () => {
    const v = viewMatrix({ x: 0, y: 0, width: 1, height: 1 }, 90, false);
    const p = transformPoint(v, 0, 0);
    expect(p.x).toBeCloseTo(1, 12);
    expect(p.y).toBeCloseTo(1, 12);
  });

  it('tileMatrix maps the unit quad to the tile rectangle', () => {
    expect(transformPoint(tileMatrix(2, 3, 4, 5), 1, 1)).toEqual({ x: 6, y: 8 });
  });
});
