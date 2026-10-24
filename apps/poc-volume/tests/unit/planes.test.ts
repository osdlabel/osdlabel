import { describe, expect, it } from 'vitest';
import { assertValidPlaneFrame, imageToPatient, volumeCentre } from '@osdlabel/spatial';
import { obliquePlane, planeFor } from '../../src/planes.js';

const grid = {
  dimensions: [512, 512, 400] as const,
  spacing: [0.7, 0.7, 1.25] as const,
  origin: [-178.85, -178.85, -249.375] as const,
  direction: [
    [1, 0, 0],
    [0, 1, 0],
    [0, 0, 1],
  ] as const,
};

describe('PoC planes', () => {
  it('keeps the oblique view a constant 512x512 centred on the volume at any angle', () => {
    const c = volumeCentre(grid);
    for (const [tilt, spin] of [
      [0, 0],
      [30, 20],
      [75, 200],
    ] as const) {
      const f = obliquePlane(grid, tilt, spin);
      assertValidPlaneFrame(f);
      expect([f.width, f.height]).toEqual([512, 512]);
      const mid = imageToPatient(f, { x: 256, y: 256 });
      for (let i = 0; i < 3; i++) expect(mid[i]).toBeCloseTo(c[i]!, 9);
    }
  });

  it('gives the orthogonal cells their isotropic sizes', () => {
    expect([planeFor(grid, 'axial').width, planeFor(grid, 'axial').height]).toEqual([512, 512]);
    expect([planeFor(grid, 'coronal').width, planeFor(grid, 'coronal').height]).toEqual([512, 714]);
    expect([planeFor(grid, 'sagittal').width, planeFor(grid, 'sagittal').height]).toEqual([
      512, 714,
    ]);
  });
});
