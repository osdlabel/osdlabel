import { describe, expect, it } from 'vitest';
import {
  centredPlane,
  isSamePlane,
  orthogonalPlane,
  rotateAbout,
  volumeCentre,
  type PlaneFrame,
  type Vec3,
  type VolumeGrid,
} from '@osdlabel/spatial';
import { matchOrthogonalPlane, parsePlaneImageId, planeImageId } from '../../src/index.js';

const grid: VolumeGrid = {
  dimensions: [512, 512, 400],
  spacing: [0.7, 0.7, 1.25],
  origin: [-179, -179, -250],
  direction: [
    [1, 0, 0],
    [0, 1, 0],
    [0, 0, 1],
  ],
};
const gridOf = (series: string): VolumeGrid | undefined => (series === 'CT:1/2' ? grid : undefined);

function oblique(tiltDeg: number, spinDeg: number): PlaneFrame {
  const t = (tiltDeg * Math.PI) / 180;
  const s = (spinDeg * Math.PI) / 180;
  const row = rotateAbout(rotateAbout([1, 0, 0], [1, 0, 0], t), [0, 0, 1], s);
  const col = rotateAbout(rotateAbout([0, 1, 0], [1, 0, 0], t), [0, 0, 1], s);
  return centredPlane(volumeCentre(grid), row, col, 0.7, 512, 512, 0.7);
}

const maxDiff = (a: Vec3, b: Vec3): number =>
  Math.max(Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1]), Math.abs(a[2] - b[2]));

describe('planeImageId / parsePlaneImageId', () => {
  it('gives grid-aligned slices the short orthogonal form and decodes them exactly', () => {
    for (const [o, i] of [
      ['axial', 200],
      ['coronal', 0],
      ['sagittal', 511],
    ] as const) {
      const plane = orthogonalPlane(grid, o, i);
      const id = planeImageId('CT:1/2', plane, grid);
      expect(id).toBe(`vol:CT%3A1%2F2:${o}:${i}`);
      expect(matchOrthogonalPlane(grid, plane)).toEqual({ orientation: o, index: i });
      const parsed = parsePlaneImageId(id, gridOf);
      expect(parsed).not.toBeNull();
      expect(parsed!.series).toBe('CT:1/2');
      expect(parsed!.form).toBe('orthogonal');
      expect(parsed!.plane).toEqual(plane);
    }
  });

  it('needs the series grid to decode the orthogonal form', () => {
    const id = planeImageId('CT:1/2', orthogonalPlane(grid, 'axial', 3), grid);
    expect(parsePlaneImageId(id)).toBeNull();
    expect(parsePlaneImageId(id, () => undefined)).toBeNull();
  });

  it('round-trips an oblique plane with no grid and no registry', () => {
    const plane = oblique(30, 20);
    const id = planeImageId('CT:1/2', plane, grid);
    expect(id.startsWith('vol:CT%3A1%2F2:f:')).toBe(true);
    const parsed = parsePlaneImageId(id);
    expect(parsed).not.toBeNull();
    const back = parsed!.plane;
    expect(parsed!.form).toBe('frame');
    expect(maxDiff(back.origin, plane.origin)).toBeLessThanOrEqual(5e-4);
    expect(maxDiff(back.rowDirection, plane.rowDirection)).toBeLessThanOrEqual(5e-7);
    expect(maxDiff(back.columnDirection, plane.columnDirection)).toBeLessThanOrEqual(5e-7);
    expect(back.width).toBe(512);
    expect(back.height).toBe(512);
    expect(isSamePlane(back, plane)).toBe(true);
    // Canonical: the decoded plane re-encodes to the same id, so a reloaded
    // annotation lands in the bucket the viewer derives for that plane.
    expect(planeImageId('CT:1/2', back, grid)).toBe(id);
  });

  it('is deterministic: the same plane reached another way gets the same id', () => {
    const a = oblique(30, 20);
    // Spin 380 degrees: the same plane through a different float path.
    const b = oblique(30, 380);
    expect(maxDiff(a.origin, b.origin)).toBeGreaterThan(0);
    expect(planeImageId('s', b)).toBe(planeImageId('s', a));
    const nudged: PlaneFrame = {
      ...a,
      origin: [a.origin[0] + 1e-9, a.origin[1] - 1e-9, a.origin[2]],
    };
    expect(planeImageId('s', nudged)).toBe(planeImageId('s', a));
    // Different planes get different ids.
    expect(planeImageId('s', oblique(30, 21))).not.toBe(planeImageId('s', a));
    expect(planeImageId('t', a)).not.toBe(planeImageId('s', a));
  });

  it('falls back to the frame form for planes that are not default grid slices', () => {
    const fine = orthogonalPlane(grid, 'coronal', 100, 0.5);
    const id = planeImageId('s', fine, grid);
    expect(id.includes(':f:')).toBe(true);
    expect(parsePlaneImageId(id)!.plane.height).toBe(fine.height);
    expect(planeImageId('s', orthogonalPlane(grid, 'axial', 10))).toContain(':f:');
  });

  it('survives a JSON round trip of an annotation keyed by it', () => {
    const plane = oblique(45, 10);
    const stored = JSON.parse(
      JSON.stringify({ imageId: planeImageId('CT:1/2', plane, grid), geometry: { type: 'point' } }),
    ) as { imageId: string };
    const parsed = parsePlaneImageId(stored.imageId, gridOf);
    expect(parsed).not.toBeNull();
    expect(isSamePlane(parsed!.plane, plane, 1e-3)).toBe(true);
  });

  it('rejects ids that are not plane ids', () => {
    for (const id of [
      'image-1',
      'vol:s',
      'vol:s:axial',
      'vol:s:axial:x',
      'vol:s:oblique:3',
      'vol:s:f:1,2,3',
      'vol:s:f:1,2,3;1,0,0;0,1,0;0.7,0.7;axb;1',
      'vol:%E0%A4%A:f:0,0,0;1,0,0;0,1,0;1,1;1x1;1',
      'dzi:s:axial:3',
    ]) {
      expect(parsePlaneImageId(id, gridOf)).toBeNull();
    }
    expect(parsePlaneImageId('vol:CT%3A1%2F2:axial:400', gridOf)).toBeNull();
  });
});
