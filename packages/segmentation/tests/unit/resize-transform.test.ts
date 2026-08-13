import { describe, it, expect } from 'vitest';
import { computeResizeTransform, imageToModel, modelToImage } from '../../src/resize-transform.js';

describe('resize-transform', () => {
  it('fits the longest side to the model input (top-left pad by default)', () => {
    const t = computeResizeTransform(2000, 1000, 1024);
    expect(t.scale).toBeCloseTo(1024 / 2000);
    expect(t.offsetX).toBe(0);
    expect(t.offsetY).toBe(0);
    // The longest side maps exactly to inputSize.
    expect(imageToModel({ x: 2000, y: 0 }, t).x).toBeCloseTo(1024);
  });

  it('round-trips image → model → image', () => {
    const t = computeResizeTransform(1280, 720, 1024);
    const p = { x: 813.4, y: 271.9 };
    const back = modelToImage(imageToModel(p, t), t);
    expect(back.x).toBeCloseTo(p.x);
    expect(back.y).toBeCloseTo(p.y);
  });

  it('centers the padding when requested', () => {
    const t = computeResizeTransform(1000, 500, 1000, { pad: 'center' });
    expect(t.scale).toBeCloseTo(1);
    expect(t.offsetX).toBeCloseTo(0);
    expect(t.offsetY).toBeCloseTo(250); // (1000 - 500) / 2
    expect(imageToModel({ x: 0, y: 0 }, t)).toEqual({ x: 0, y: 250 });
  });
});
