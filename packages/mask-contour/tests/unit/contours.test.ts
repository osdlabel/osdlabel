import { describe, expect, it } from 'vitest';
import {
  assembleHoles,
  binaryIou,
  fillRings,
  signedArea,
  simplifyRing,
  traceIsoContours,
  tracePixelContours,
  type Ring,
} from '../../src/index.js';

function grid(rows: readonly string[]): { width: number; height: number; data: Uint8Array } {
  const height = rows.length;
  const width = rows[0]!.length;
  const data = new Uint8Array(width * height);
  rows.forEach((r, y) => {
    for (let x = 0; x < width; x++) data[y * width + x] = r[x] === '#' ? 1 : 0;
  });
  return { width, height, data };
}

/** Deterministic PRNG so the property tests are reproducible. */
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

describe('tracePixelContours', () => {
  it('traces one pixel as a unit square with positive area', () => {
    const contours = tracePixelContours(grid(['.#.', '...']));
    expect(contours).toHaveLength(1);
    expect(contours[0]!.hole).toBe(false);
    expect(signedArea(contours[0]!.ring)).toBe(1);
    expect(contours[0]!.ring).toHaveLength(4);
  });

  it('separates a hole and assigns it to its outer ring', () => {
    const contours = tracePixelContours(grid(['###', '#.#', '###']));
    const outer = contours.filter((c) => !c.hole);
    const holes = contours.filter((c) => c.hole);
    expect(outer).toHaveLength(1);
    expect(holes).toHaveLength(1);
    expect(signedArea(outer[0]!.ring)).toBe(9);
    expect(signedArea(holes[0]!.ring)).toBe(-1);
    const polys = assembleHoles(contours);
    expect(polys).toHaveLength(1);
    expect(polys[0]!.holes).toHaveLength(1);
  });

  it('keeps diagonal-only neighbours apart (4-connected foreground)', () => {
    const contours = tracePixelContours(grid(['#.', '.#']));
    expect(contours.filter((c) => !c.hole)).toHaveLength(2);
  });

  it('round-trips random grids exactly through fillRings', () => {
    const rand = lcg(7);
    for (let trial = 0; trial < 40; trial++) {
      const width = 3 + Math.floor(rand() * 20);
      const height = 3 + Math.floor(rand() * 20);
      const density = 0.2 + rand() * 0.6;
      const data = new Uint8Array(width * height).map(() => (rand() < density ? 1 : 0));
      const contours = tracePixelContours({ width, height, data });
      const filled = fillRings(
        contours.map((c) => c.ring),
        width,
        height,
      );
      expect(Array.from(filled)).toEqual(Array.from(data));
      const total = contours.reduce((s, c) => s + signedArea(c.ring), 0);
      expect(total).toBe(data.reduce((s, v) => s + v, 0));
    }
  });
});

describe('traceIsoContours', () => {
  it('outlines a disc of logits with sub-pixel accuracy', () => {
    const n = 64;
    const r = 20;
    const data = new Float32Array(n * n);
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) data[y * n + x] = r - Math.hypot(x + 0.5 - 32, y + 0.5 - 32);
    }
    const contours = traceIsoContours({ width: n, height: n, data });
    expect(contours).toHaveLength(1);
    expect(contours[0]!.hole).toBe(false);
    const area = signedArea(contours[0]!.ring);
    expect(Math.abs(area - Math.PI * r * r) / (Math.PI * r * r)).toBeLessThan(0.01);
  });

  it('finds the hole of an annulus', () => {
    const n = 64;
    const data = new Float32Array(n * n);
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) {
        const d = Math.hypot(x + 0.5 - 32, y + 0.5 - 32);
        data[y * n + x] = Math.min(25 - d, d - 10);
      }
    }
    const contours = traceIsoContours({ width: n, height: n, data });
    expect(contours.filter((c) => !c.hole)).toHaveLength(1);
    expect(contours.filter((c) => c.hole)).toHaveLength(1);
  });

  it('agrees with the thresholded grid when rasterised (IoU > 0.97)', () => {
    const rand = lcg(11);
    const n = 48;
    for (let trial = 0; trial < 10; trial++) {
      // Smooth random field: sum of a few Gaussian bumps minus a constant.
      const bumps = Array.from({ length: 4 }, () => ({
        x: rand() * n,
        y: rand() * n,
        s: 4 + rand() * 8,
      }));
      const data = new Float32Array(n * n);
      const bin = new Uint8Array(n * n);
      for (let y = 0; y < n; y++) {
        for (let x = 0; x < n; x++) {
          let v = -0.5;
          for (const b of bumps) {
            v += Math.exp(-((x + 0.5 - b.x) ** 2 + (y + 0.5 - b.y) ** 2) / (2 * b.s * b.s));
          }
          data[y * n + x] = v;
          bin[y * n + x] = v > 0 ? 1 : 0;
        }
      }
      const rings = traceIsoContours({ width: n, height: n, data }).map((c) => c.ring);
      const filled = fillRings(rings, n, n);
      expect(binaryIou(filled, bin)).toBeGreaterThan(0.97);
    }
  });
});

describe('simplifyRing', () => {
  it('drops collinear vertices', () => {
    const ring: Ring = [
      { x: 0, y: 0 },
      { x: 5, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 5 },
      { x: 10, y: 10 },
      { x: 0, y: 10 },
    ];
    expect(simplifyRing(ring, 0.1)).toHaveLength(4);
  });

  it('keeps every input vertex within tolerance of the output', () => {
    const ring: { x: number; y: number }[] = [];
    for (let i = 0; i < 200; i++) {
      const t = (i / 200) * Math.PI * 2;
      ring.push({ x: 50 * Math.cos(t) + Math.sin(7 * t), y: 50 * Math.sin(t) });
    }
    const tol = 1.5;
    const out = simplifyRing(ring, tol);
    expect(out.length).toBeLessThan(ring.length / 2);
    for (const p of ring) {
      let best = Infinity;
      for (let i = 0; i < out.length; i++) {
        const a = out[i]!;
        const b = out[(i + 1) % out.length]!;
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / (dx * dx + dy * dy)));
        best = Math.min(best, Math.hypot(a.x + t * dx - p.x, a.y + t * dy - p.y));
      }
      expect(best).toBeLessThanOrEqual(tol + 1e-9);
    }
  });
});
