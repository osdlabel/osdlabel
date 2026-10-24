import { describe, expect, it } from 'vitest';
import {
  centredPlane,
  orthogonalPlane,
  planeIndexMapping,
  rotateAbout,
  volumeCentre,
  type PlaneFrame,
  type VolumeGrid,
} from '@osdlabel/spatial';
import { allocateLabelVolume, fillDisc, paintDisc, resliceLabels } from '@osdlabel/volume';
import { SliceMaskStack } from '../../src/slice-mask-stack.js';

// The dense-vs-per-slice-mask comparison the benchmark times: both
// representations must hold exactly the same voxels and reslice identically.
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

describe('label maps: dense volume vs per-slice masks', () => {
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
    it(`paints the same voxels from the ${name} view`, () => {
      const dense = allocateLabelVolume(g);
      const stack = new SliceMaskStack(g);
      const centre = { x: frame.width / 2 + 0.3, y: frame.height / 2 - 0.2 };
      const changed = paintDisc(dense, frame, centre, 6, 1);
      stack.paintDisc(frame, centre, 6);
      expect(changed).toBeGreaterThan(50);
      expect(stack.voxelCount()).toBe(changed);
      for (let k = 0; k < 30; k++) {
        const m = stack.masks.get(k);
        for (let j = 0; j < 40; j++)
          for (let i = 0; i < 40; i++) {
            expect(m ? m.get(i, j) : 0).toBe(dense.slices[k]![j * 40 + i]);
          }
      }
      // Both reslice the painted disc back into the view it was drawn on.
      const mapping = planeIndexMapping(g, frame);
      const a = new Uint8Array(frame.width * frame.height);
      const b = new Uint8Array(frame.width * frame.height);
      resliceLabels(dense, mapping, frame.width, frame.height, a);
      stack.reslice(mapping, frame.width, frame.height, b);
      expect(b).toEqual(a);
      // Every view pixel well inside the brush shows the label (no holes).
      expect(discCoverage(a, frame, centre, 5)).toBe(1);
    });
  }

  for (const [name, frame] of planes) {
    it(`span and voxel painters agree in both representations (${name})`, () => {
      const centre = { x: frame.width / 2 + 0.3, y: frame.height / 2 - 0.2 };
      const voxels = allocateLabelVolume(g);
      const spans = allocateLabelVolume(g);
      const changed = paintDisc(voxels, frame, centre, 6, 1);
      expect(fillDisc(spans, frame, centre, 6, 1)).toBe(changed);
      const s1 = new SliceMaskStack(g);
      const s2 = new SliceMaskStack(g);
      s1.paintDiscVoxels(frame, centre, 6);
      s2.paintDiscSpans(frame, centre, 6);
      expect(s1.voxelCount()).toBe(changed);
      expect(s2.voxelCount()).toBe(changed);
      for (let k = 0; k < 30; k++) {
        expect(spans.slices[k]).toEqual(voxels.slices[k]);
        const m1 = s1.masks.get(k);
        const m2 = s2.masks.get(k);
        for (let j = 0; j < 40; j++)
          for (let i = 0; i < 40; i++) {
            const v = voxels.slices[k]![j * 40 + i];
            expect(m1 ? m1.get(i, j) : 0).toBe(v);
            expect(m2 ? m2.get(i, j) : 0).toBe(v);
          }
      }
    });

    it(`hoisted label reslices match a per-pixel lookup (${name})`, () => {
      const dense = allocateLabelVolume(g);
      const stack = new SliceMaskStack(g);
      // Paint from every view so the reslice crosses several slices.
      for (const [, f] of planes) {
        paintDisc(dense, f, { x: 18.2, y: 21.7 }, 7, 1);
        stack.paintDiscVoxels(f, { x: 18.2, y: 21.7 }, 7);
      }
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
      const b = new Uint8Array(want.length);
      resliceLabels(dense, m, frame.width, frame.height, a);
      stack.reslice(m, frame.width, frame.height, b);
      expect(a).toEqual(want);
      expect(b).toEqual(want);
    });
  }
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
