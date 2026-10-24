import { describe, expect, it } from 'vitest';
import {
  centredPlane,
  imageToPatient,
  orthogonalPlane,
  patientToIndex,
  planeIndexMapping,
  rotateAbout,
  volumeCentre,
  type PlaneFrame,
  type VolumeGrid,
} from '@osdlabel/spatial';
import {
  allocateLabelVolume,
  BrickedLabelVolume,
  allocateScalarVolume,
  applyWindowLut,
  buildWindowLut,
  contiguousVoxels,
  fillDisc,
  fillSheppLoganPhantom,
  forEachSpanInDisc,
  permuteGrid,
  permuteVolume,
  SAGITTAL_MAJOR,
  forEachVoxelInDisc,
  paintDisc,
  reslice,
  resliceLabels,
  volumeByteLength,
  type ScalarVolume,
} from '../../src/index.js';

const grid: VolumeGrid = {
  dimensions: [12, 10, 8],
  spacing: [0.7, 0.7, 1.25],
  origin: [-4, -3, -5],
  direction: [
    [1, 0, 0],
    [0, 1, 0],
    [0, 0, 1],
  ],
};

/** A volume whose value is linear in the index, so any linear interpolation is exact. */
function ramp(): ScalarVolume {
  const v = allocateScalarVolume(grid);
  const [nx, ny, nz] = grid.dimensions;
  for (let k = 0; k < nz; k++)
    for (let j = 0; j < ny; j++)
      for (let i = 0; i < nx; i++) v.slices[k]![j * nx + i] = i + 10 * j + 100 * k;
  return v;
}

const analytic = (frame: PlaneFrame, x: number, y: number): number | null => {
  const [i, j, k] = patientToIndex(grid, imageToPatient(frame, { x: x + 0.5, y: y + 0.5 }));
  const [nx, ny, nz] = grid.dimensions;
  const e = 1e-9;
  if (i < -e || j < -e || k < -e || i > nx - 1 + e || j > ny - 1 + e || k > nz - 1 + e) return null;
  return Math.round(i + 10 * j + 100 * k);
};

function check(
  volume: ScalarVolume,
  frame: PlaneFrame,
  interpolation: 'linear' | 'nearest' = 'linear',
) {
  const out = new Int16Array(frame.width * frame.height);
  const path = reslice(volume, planeIndexMapping(grid, frame), frame.width, frame.height, out, {
    interpolation,
    background: -999,
  });
  let compared = 0;
  for (let y = 0; y < frame.height; y++)
    for (let x = 0; x < frame.width; x++) {
      const want = analytic(frame, x, y);
      if (want === null) {
        expect(out[y * frame.width + x]).toBe(-999);
        continue;
      }
      if (interpolation === 'linear')
        expect(Math.abs(out[y * frame.width + x]! - want)).toBeLessThanOrEqual(1);
      compared++;
    }
  return { path, compared, out };
}

describe('reslice', () => {
  const vol = ramp();

  it('takes the gather path for an axial plane on voxel centres', () => {
    const r = check(vol, orthogonalPlane(grid, 'axial', 3));
    expect(r.path).toBe('gather');
    expect(r.compared).toBe(120);
    expect(r.out[0]).toBe(300);
  });

  it('interpolates along k for square-pixel coronal and sagittal planes', () => {
    const c = check(vol, orthogonalPlane(grid, 'coronal', 4));
    expect(c.path).toBe('separable');
    expect(c.compared).toBeGreaterThan(0);
    const s = check(vol, orthogonalPlane(grid, 'sagittal', 5));
    expect(s.path).toBe('separable');
  });

  it('samples oblique planes trilinearly, background outside', () => {
    const f = centredPlane(
      volumeCentre(grid),
      rotateAbout([1, 0, 0], [0, 0, 1], 0.5),
      rotateAbout([0, 1, 0], [1, 0, 0], 0.4),
      0.5,
      24,
      24,
      0.5,
    );
    const r = check(vol, f);
    expect(r.path).toBe('trilinear');
    expect(r.compared).toBeGreaterThan(50);
    expect(r.compared).toBeLessThan(24 * 24);
  });

  it('nearest picks the closest voxel', () => {
    const f = orthogonalPlane(grid, 'coronal', 4);
    const out = new Int16Array(f.width * f.height);
    const m = planeIndexMapping(grid, f);
    // Skewed so the plane is not axis-aligned and the generic nearest loop runs.
    const skew = { ...m, stepX: [m.stepX[0], 1e-6, m.stepX[2]] as const };
    expect(reslice(vol, skew, f.width, f.height, out, { interpolation: 'nearest' })).toBe(
      'nearest',
    );
    const [i, j, k] = patientToIndex(grid, imageToPatient(f, { x: 3.5, y: 2.5 }));
    expect(out[2 * f.width + 3]).toBe(Math.round(i) + 10 * Math.round(j) + 100 * Math.round(k));
  });

  it('row ranges partition one plane exactly (worker split)', () => {
    const f = centredPlane(volumeCentre(grid), [1, 0.2, 0], [0, 0.1, -1], 0.6, 16, 16, 0.6);
    const m = planeIndexMapping(grid, f);
    const whole = new Int16Array(256);
    reslice(vol, m, 16, 16, whole);
    const split = new Int16Array(256);
    reslice(vol, m, 16, 16, split, { rowStart: 0, rowEnd: 5 });
    reslice(vol, m, 16, 16, split, { rowStart: 5, rowEnd: 16 });
    expect(split).toEqual(whole);
  });
});

describe('storage', () => {
  it('exposes one view over contiguous (shared) slices and none otherwise', () => {
    const shared = allocateScalarVolume(grid, { shared: true });
    const all = contiguousVoxels(shared)!;
    expect(all).not.toBeNull();
    expect(all.buffer).toBeInstanceOf(SharedArrayBuffer);
    expect(all.length).toBe(12 * 10 * 8);
    shared.slices[2]![5] = 77;
    expect(all[2 * 120 + 5]).toBe(77);
    expect(contiguousVoxels(allocateScalarVolume(grid, { contiguous: false }))).toBeNull();
    expect(volumeByteLength(shared)).toBe(12 * 10 * 8 * 2);
  });
});

describe('permuted copies', () => {
  const vol = ramp();

  it('keeps every voxel at the same patient position', () => {
    const p = permuteVolume(vol, SAGITTAL_MAJOR);
    expect(p.grid.dimensions).toEqual([10, 8, 12]);
    expect(p.slices.length).toBe(12);
    const [nx, ny] = grid.dimensions;
    for (const [i, j, k] of [
      [0, 0, 0],
      [11, 9, 7],
      [3, 4, 5],
    ] as const) {
      // Source (i, j, k) is copy (j, k, i).
      expect(p.slices[i]![k * ny + j]).toBe(vol.slices[k]![j * nx + i]);
      expect(p.slices[i]![k * ny + j]).toBe(i + 10 * j + 100 * k);
    }
    expect(permuteGrid(grid, [0, 1, 2])).toEqual(grid);
    expect(() => permuteGrid(grid, [0, 0, 2])).toThrow(RangeError);
  });

  it('reslices the sagittal view identically, through the in-slice path', () => {
    const p = permuteVolume(vol, SAGITTAL_MAJOR);
    for (const f of [
      orthogonalPlane(grid, 'sagittal', 5),
      orthogonalPlane(grid, 'sagittal', 0),
      centredPlane(volumeCentre(grid), [1, 0.2, 0], [0, 0.1, -1], 0.6, 16, 16, 0.6),
    ]) {
      const a = new Int16Array(f.width * f.height);
      const b = new Int16Array(f.width * f.height);
      const pathA = reslice(vol, planeIndexMapping(grid, f), f.width, f.height, a);
      const pathB = reslice(p, planeIndexMapping(p.grid, f), f.width, f.height, b);
      expect(b).toEqual(a);
      expect(pathB).toBe(pathA);
    }
    // In the copy the coronal / axial x axis runs along its slice axis, which
    // the separable path does not take: the copy serves the sagittal view only.
    const cor = orthogonalPlane(grid, 'coronal', 4);
    const out = new Int16Array(cor.width * cor.height);
    expect(reslice(p, planeIndexMapping(p.grid, cor), cor.width, cor.height, out)).toBe(
      'trilinear',
    );
  });
});

describe('window LUT', () => {
  it('maps a window to grey RGBA', () => {
    const lut = buildWindowLut(40, 400);
    const out = new Uint32Array(3);
    applyWindowLut(new Int16Array([-1000, 40, 3000]), lut, out);
    expect(out[0]).toBe(0xff000000);
    expect(out[1]! & 0xff).toBe(128);
    expect(out[2]).toBe(0xffffffff);
  });
});

describe('phantom', () => {
  it('produces air outside, skull at the rim, brain inside', () => {
    const g: VolumeGrid = { ...grid, dimensions: [64, 64, 32] };
    const v = allocateScalarVolume(g);
    fillSheppLoganPhantom(v, 0);
    const mid = v.slices[16]!;
    expect(mid[0]).toBe(-1000);
    expect(mid[32 * 64 + 32]).toBeGreaterThan(-300);
    expect(mid[32 * 64 + 32]).toBeLessThan(200);
    expect(Math.max(...mid)).toBeGreaterThan(900);
  });
});

describe('label maps (dense label volume)', () => {
  const g: VolumeGrid = { ...grid, dimensions: [40, 40, 30] };
  const planes: readonly [string, PlaneFrame][] = [
    ['axial', orthogonalPlane(g, 'axial', 12)],
    ['coronal', orthogonalPlane(g, 'coronal', 20)],
    ['sagittal', orthogonalPlane(g, 'sagittal', 7)],
    // Slab = the voxel diagonal (sqrt(0.7^2 + 0.7^2 + 1.25^2) = 1.6 mm): thinner
    // and an oblique stamp leaves holes when viewed back (next test).
    [
      'oblique',
      centredPlane(
        volumeCentre(g),
        rotateAbout([1, 0, 0], [0, 0, 1], 0.3),
        [0, 0.3, -1],
        0.7,
        40,
        40,
        1.6,
      ),
    ],
  ];

  for (const [name, frame] of planes) {
    it(`paints a disc from the ${name} view that reslices back with no holes`, () => {
      const dense = allocateLabelVolume(g);
      const centre = { x: frame.width / 2 + 0.3, y: frame.height / 2 - 0.2 };
      const changed = paintDisc(dense, frame, centre, 6, 1);
      expect(changed).toBeGreaterThan(50);
      const mapping = planeIndexMapping(g, frame);
      const a = new Uint8Array(frame.width * frame.height);
      resliceLabels(dense, mapping, frame.width, frame.height, a);
      // Every view pixel well inside the brush shows the label (no holes).
      expect(discCoverage(a, frame, centre, 5)).toBe(1);
    });
  }

  it("the span enumerator visits exactly the voxel enumerator's voxels", () => {
    // A sheared, rotated grid too, so no axis is aligned with any plane.
    const sheared: VolumeGrid = {
      dimensions: [40, 40, 30],
      spacing: [0.7, 0.9, 1.25],
      origin: [-14, -18, -18],
      direction: [
        rotateAbout([1, 0, 0], [0, 0, 1], 0.2),
        rotateAbout([0, 1, 0], [0, 0, 1], 0.2),
        [0, 0.26, 0.966],
      ],
    };
    let rows = 0;
    for (const gg of [g, sheared]) {
      const frames: PlaneFrame[] = [
        ...planes.map(([, f]) => f),
        centredPlane(volumeCentre(gg), [0.6, 0.8, 0], [0, 0.6, -0.8], 0.5, 40, 40, 0.9),
        centredPlane(volumeCentre(gg), [0, 1, 0], [0, 0, -1], 0.7, 40, 40, 0.35),
      ];
      for (const frame of frames) {
        for (const [cx, cy, r] of [
          [20.3, 19.8, 6],
          [3.1, 37.6, 9.5],
          [20, 20, 0.6],
          [11.5, 27.25, 14],
        ] as const) {
          const a = new Set<number>();
          const b = new Set<number>();
          forEachVoxelInDisc(gg, frame, { x: cx, y: cy }, r, (i, j, k) =>
            a.add((k * 40 + j) * 40 + i),
          );
          forEachSpanInDisc(gg, frame, { x: cx, y: cy }, r, (k, j, i0, i1) => {
            rows++;
            expect(i1).toBeGreaterThanOrEqual(i0);
            for (let i = i0; i <= i1; i++) {
              expect(b.has((k * 40 + j) * 40 + i)).toBe(false);
              b.add((k * 40 + j) * 40 + i);
            }
          });
          expect([...b].sort((x, y) => x - y)).toEqual([...a].sort((x, y) => x - y));
        }
      }
    }
    expect(rows).toBeGreaterThan(500);
  });

  for (const [name, frame] of planes) {
    it(`span and voxel painters agree (${name})`, () => {
      const centre = { x: frame.width / 2 + 0.3, y: frame.height / 2 - 0.2 };
      const voxels = allocateLabelVolume(g);
      const spans = allocateLabelVolume(g);
      const changed = paintDisc(voxels, frame, centre, 6, 1);
      expect(fillDisc(spans, frame, centre, 6, 1)).toBe(changed);
      for (let k = 0; k < 30; k++) expect(spans.slices[k]).toEqual(voxels.slices[k]);
    });

    it(`the hoisted label reslice matches a per-pixel lookup (${name})`, () => {
      const dense = allocateLabelVolume(g);
      // Paint from every view so the reslice crosses several slices.
      for (const [, f] of planes) paintDisc(dense, f, { x: 18.2, y: 21.7 }, 7, 1);
      const m = planeIndexMapping(g, frame);
      const want = new Uint8Array(frame.width * frame.height);
      const [nx, ny, nz] = g.dimensions;
      for (let y = 0; y < frame.height; y++)
        for (let x = 0; x < frame.width; x++) {
          const i = Math.round(m.start[0] + x * m.stepX[0] + y * m.stepY[0]);
          const j = Math.round(m.start[1] + x * m.stepX[1] + y * m.stepY[1]);
          const k = Math.round(m.start[2] + x * m.stepX[2] + y * m.stepY[2]);
          want[y * frame.width + x] =
            i < 0 || j < 0 || k < 0 || i >= nx || j >= ny || k >= nz
              ? 0
              : dense.slices[k]![j * nx + i]!;
        }
      expect(want.some((v) => v === 1)).toBe(true);
      const a = new Uint8Array(want.length);
      resliceLabels(dense, m, frame.width, frame.height, a);
      expect(a).toEqual(want);
    });
  }

  it('an oblique stamp with a one-pixel slab leaves holes in its own view', () => {
    const thin = centredPlane(
      volumeCentre(g),
      rotateAbout([1, 0, 0], [0, 0, 1], 0.3),
      [0, 0.3, -1],
      0.7,
      40,
      40,
      0.7,
    );
    const dense = allocateLabelVolume(g);
    const centre = { x: 20.3, y: 19.8 };
    paintDisc(dense, thin, centre, 6, 1);
    const a = new Uint8Array(40 * 40);
    resliceLabels(dense, planeIndexMapping(g, thin), 40, 40, a);
    const coverage = discCoverage(a, thin, centre, 5);
    // Measured 0.949 here: about one view pixel in twenty misses its voxel.
    expect(coverage).toBeLessThan(1);
    expect(coverage).toBeGreaterThan(0.5);
  });
});

describe('sparse bricked label volume', () => {
  const g: VolumeGrid = { ...grid, dimensions: [70, 40, 36] };
  const frames: readonly PlaneFrame[] = [
    orthogonalPlane(g, 'axial', 12),
    orthogonalPlane(g, 'coronal', 20),
    orthogonalPlane(g, 'sagittal', 33),
    centredPlane(
      volumeCentre(g),
      rotateAbout([1, 0, 0], [0, 0, 1], 0.3),
      [0, 0.3, -1],
      0.7,
      60,
      60,
      1.6,
    ),
  ];

  it("holds exactly the dense map's voxels and reslices identically", () => {
    const dense = allocateLabelVolume(g);
    const bricked = new BrickedLabelVolume(g);
    expect(bricked.bricksPerAxis).toEqual([3, 2, 2]);
    // Strokes that cross brick boundaries along every axis.
    for (const f of frames)
      for (const [cx, cy, r] of [
        [f.width / 2, f.height / 2, 9],
        [31.6, 30.2, 5],
        [3, 4, 4],
      ] as const) {
        const a = fillDisc(dense, f, { x: cx, y: cy }, r, 1);
        expect(bricked.fillDisc(f, { x: cx, y: cy }, r, 1)).toBe(a);
      }
    const [nx, ny, nz] = g.dimensions;
    let set = 0;
    for (let k = 0; k < nz; k++) {
      // One comparison per slice: per-voxel expect() calls are slow enough to
      // time out under a parallel turbo run.
      const fromBricks = new Uint8Array(nx * ny);
      for (let j = 0; j < ny; j++)
        for (let i = 0; i < nx; i++) fromBricks[j * nx + i] = bricked.get(i, j, k);
      expect(fromBricks).toEqual(dense.slices[k]);
      set += dense.slices[k]!.reduce((n, v) => n + (v ? 1 : 0), 0);
    }
    expect(set).toBeGreaterThan(500);
    for (const f of frames) {
      const m = planeIndexMapping(g, f);
      const a = new Uint8Array(f.width * f.height);
      const b = new Uint8Array(f.width * f.height);
      resliceLabels(dense, m, f.width, f.height, a);
      bricked.reslice(m, f.width, f.height, b);
      expect(b).toEqual(a);
    }
  });

  it('allocates only the bricks a stroke touches, and erasing allocates none', () => {
    const bricked = new BrickedLabelVolume(g);
    bricked.fillDisc(frames[0]!, { x: 10, y: 10 }, 3, 0);
    expect(bricked.allocatedBricks()).toBe(0);
    bricked.fillDisc(frames[0]!, { x: 10, y: 10 }, 3, 2);
    expect(bricked.allocatedBricks()).toBe(1);
    expect(bricked.byteLength()).toBe(32 ** 3 + 12 * 8);
  });
});

/** Fraction of view pixels within `r` px of `centre` whose label is set. */
function discCoverage(
  img: Uint8Array,
  frame: PlaneFrame,
  centre: { x: number; y: number },
  r: number,
): number {
  let inside = 0;
  let set = 0;
  for (let y = 0; y < frame.height; y++)
    for (let x = 0; x < frame.width; x++) {
      if (Math.hypot(x + 0.5 - centre.x, y + 0.5 - centre.y) > r) continue;
      inside++;
      if (img[y * frame.width + x] === 1) set++;
    }
  return set / inside;
}
