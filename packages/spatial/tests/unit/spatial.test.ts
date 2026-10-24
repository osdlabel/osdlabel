import { describe, expect, it } from 'vitest';
import {
  assertValidPlaneFrame,
  centredPlane,
  circleZeroChord,
  clipSegmentToImage,
  distanceField,
  evaluateField,
  imageToPatient,
  indexToPatient,
  isParallelField,
  isSamePlane,
  orthogonalPlane,
  patientToImage,
  patientToIndex,
  planeFrameFromDicom,
  planeIndexMapping,
  polygonZeroSegments,
  polylineZeroCrossings,
  referenceLine,
  rotateAbout,
  transferPoint,
  volumeCentre,
  type PlaneFrame,
  type Point2,
  type Vec3,
  type VolumeGrid,
} from '../../src/index.js';

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

const close = (a: Vec3, b: Vec3, eps = 1e-9): void => {
  for (let i = 0; i < 3; i++) expect(Math.abs(a[i]! - b[i]!)).toBeLessThan(eps);
};
const close2 = (a: Point2, b: Point2, eps = 1e-9): void => {
  expect(Math.abs(a.x - b.x)).toBeLessThan(eps);
  expect(Math.abs(a.y - b.y)).toBeLessThan(eps);
};

describe('plane frames', () => {
  it('puts the centre of pixel (0,0) — image point (0.5,0.5) — at ImagePositionPatient', () => {
    const f = planeFrameFromDicom([10, 20, 30], [1, 0, 0, 0, 1, 0], [0.5, 0.8], 100, 200, 2);
    close(imageToPatient(f, { x: 0.5, y: 0.5 }), [10, 20, 30]);
    // DICOM PixelSpacing is [row spacing, column spacing]: x steps by 0.8 mm.
    close(imageToPatient(f, { x: 1.5, y: 0.5 }), [10.8, 20, 30]);
    close(imageToPatient(f, { x: 0.5, y: 1.5 }), [10, 20.5, 30]);
    expect(f.width).toBe(200);
    expect(f.height).toBe(100);
  });

  it('round-trips image <-> patient and reports signed distance along the normal', () => {
    const f = planeFrameFromDicom(
      [1, 2, 3],
      [Math.SQRT1_2, Math.SQRT1_2, 0, 0, 0, -1],
      [0.7, 0.7],
      64,
      64,
      1,
    );
    const p = { x: 12.25, y: 40.5 };
    const P = imageToPatient(f, p);
    const back = patientToImage(f, P);
    close2(back.point, p);
    expect(Math.abs(back.distance)).toBeLessThan(1e-9);
    const n = [-Math.SQRT1_2, Math.SQRT1_2, 0] as const; // r x c
    const off = patientToImage(f, [P[0] + n[0] * 3, P[1] + n[1] * 3, P[2]]);
    expect(off.distance).toBeCloseTo(3, 9);
    close2(off.point, p);
  });

  it('rejects non-orthonormal direction cosines', () => {
    expect(() => planeFrameFromDicom([0, 0, 0], [1, 0, 0, 0.1, 1, 0], [1, 1], 10, 10, 1)).toThrow(
      /perpendicular/,
    );
  });

  it('isSamePlane honours the half-thickness tolerance', () => {
    const a = orthogonalPlane(grid, 'axial', 100);
    expect(isSamePlane(a, orthogonalPlane(grid, 'axial', 100))).toBe(true);
    expect(isSamePlane(a, orthogonalPlane(grid, 'axial', 101))).toBe(false);
    expect(isSamePlane(a, orthogonalPlane(grid, 'coronal', 100))).toBe(false);
  });
});

describe('volume grid', () => {
  it('maps index <-> patient, including a sheared (gantry-tilt) grid', () => {
    const ijk: Vec3 = [10.5, 3.25, 7];
    close(patientToIndex(grid, indexToPatient(grid, ijk)), ijk);
    const tilt = 0.2;
    const sheared: VolumeGrid = {
      ...grid,
      direction: [
        [1, 0, 0],
        [0, 1, 0],
        [0, Math.sin(tilt), Math.cos(tilt)],
      ],
    };
    close(patientToIndex(sheared, indexToPatient(sheared, ijk)), ijk, 1e-9);
  });

  it('axial pixel centres land on voxel centres', () => {
    const f = orthogonalPlane(grid, 'axial', 150);
    assertValidPlaneFrame(f);
    expect([f.width, f.height]).toEqual([512, 512]);
    close(patientToIndex(grid, imageToPatient(f, { x: 100.5, y: 200.5 })), [100, 200, 150], 1e-9);
  });

  it('coronal / sagittal are resampled to square pixels, superior at the top', () => {
    const c = orthogonalPlane(grid, 'coronal', 256);
    expect([c.width, c.height]).toEqual([512, 714]);
    expect(c.pixelSpacing).toEqual({ x: 0.7, y: 0.7 });
    // Top edge of the image is the superior edge of the last slice.
    const top = patientToIndex(grid, imageToPatient(c, { x: 0, y: 0 }));
    expect(top[2]).toBeCloseTo(399.5, 9);
    const s = orthogonalPlane(grid, 'sagittal', 256);
    expect([s.width, s.height]).toEqual([512, 714]);
    const idx = patientToIndex(grid, imageToPatient(s, { x: 10.5, y: 0.5 }));
    expect(idx[0]).toBeCloseTo(256, 9);
    expect(idx[1]).toBeCloseTo(10, 9);
  });

  it('planeIndexMapping agrees with the frame transforms', () => {
    const f = centredPlane(
      volumeCentre(grid),
      rotateAbout([1, 0, 0], [0, 1, 0], 0.4),
      [0, 1, 0.3],
      0.7,
      300,
      200,
      1,
    );
    assertValidPlaneFrame(f);
    const m = planeIndexMapping(grid, f);
    const x = 37;
    const y = 151;
    const viaMapping: Vec3 = [
      m.start[0] + x * m.stepX[0] + y * m.stepY[0],
      m.start[1] + x * m.stepX[1] + y * m.stepY[1],
      m.start[2] + x * m.stepX[2] + y * m.stepY[2],
    ];
    close(viaMapping, patientToIndex(grid, imageToPatient(f, { x: x + 0.5, y: y + 0.5 })), 1e-9);
  });
});

describe('cross-plane projection', () => {
  const axial = orthogonalPlane(grid, 'axial', 150);
  const sagittal = orthogonalPlane(grid, 'sagittal', 100);
  const coronal = orthogonalPlane(grid, 'coronal', 200);

  it('an axial point shows in the sagittal and coronal views through it', () => {
    const p = { x: 100.5, y: 200.5 }; // voxel (100, 200, 150)
    const f = distanceField(axial, sagittal);
    expect(Math.abs(evaluateField(f, p))).toBeLessThan(1e-9);
    const inSag = transferPoint(axial, sagittal, p);
    // sagittal x = j, y = (399.5 - k) * 1.25 / 0.7
    close2(inSag, { x: 200.5, y: ((399.5 - 150) * 1.25) / 0.7 }, 1e-9);
    const inCor = transferPoint(axial, coronal, p);
    close2(inCor, { x: 100.5, y: ((399.5 - 150) * 1.25) / 0.7 }, 1e-9);
    // One voxel away from the sagittal plane: 0.7 mm, outside its 0.35 mm half-slab.
    expect(Math.abs(evaluateField(f, { x: 101.5, y: 200.5 }))).toBeCloseTo(0.7, 9);
  });

  it('parallel planes have a constant field', () => {
    const f = distanceField(axial, orthogonalPlane(grid, 'axial', 152));
    expect(isParallelField(f)).toBe(true);
    expect(Math.abs(f.d0)).toBeCloseTo(2.5, 9);
  });

  it('cuts a convex polygon into one segment and a concave one into two', () => {
    const square = [
      { x: 50, y: 50 },
      { x: 150, y: 50 },
      { x: 150, y: 150 },
      { x: 50, y: 150 },
    ];
    const f = distanceField(axial, sagittal); // zero line: x = 100.5
    const segs = polygonZeroSegments(square, f);
    expect(segs).toHaveLength(1);
    expect(segs[0]!.start.x).toBeCloseTo(100.5, 9);
    expect(Math.abs(segs[0]!.end.y - segs[0]!.start.y)).toBeCloseTo(100, 9);

    // A "U" open at the top, cut by a horizontal line through both arms.
    const u = [
      { x: 0, y: 0 },
      { x: 40, y: 0 },
      { x: 40, y: 60 },
      { x: 60, y: 60 },
      { x: 60, y: 0 },
      { x: 100, y: 0 },
      { x: 100, y: 100 },
      { x: 0, y: 100 },
    ];
    const horiz = { d0: -30, gx: 0, gy: 1 }; // y = 30
    const two = polygonZeroSegments(u, horiz);
    expect(two).toHaveLength(2);
    const lens = two.map((s) => Math.abs(s.end.x - s.start.x)).sort((a, b) => a - b);
    expect(lens).toEqual([40, 40]);
  });

  it('counts a vertex lying exactly on the cut line once', () => {
    const diamond = [
      { x: 0, y: 50 },
      { x: 50, y: 0 },
      { x: 100, y: 50 },
      { x: 50, y: 100 },
    ];
    const f = { d0: -50, gx: 0, gy: 1 }; // y = 50 passes through two vertices
    const segs = polygonZeroSegments(diamond, f);
    expect(segs).toHaveLength(1);
    expect(Math.abs(segs[0]!.end.x - segs[0]!.start.x)).toBeCloseTo(100, 9);
  });

  it('finds polyline crossings and circle chords', () => {
    const f = { d0: -10, gx: 1, gy: 0 }; // x = 10
    expect(
      polylineZeroCrossings(
        [
          { x: 0, y: 0 },
          { x: 20, y: 0 },
          { x: 0, y: 5 },
        ],
        f,
      ),
    ).toHaveLength(2);
    const chord = circleZeroChord({ x: 13, y: 7 }, 5, f)!;
    expect(chord).not.toBeNull();
    const len = Math.hypot(chord.end.x - chord.start.x, chord.end.y - chord.start.y);
    expect(len).toBeCloseTo(2 * Math.sqrt(25 - 9), 9);
    expect(chord.start.x).toBeCloseTo(10, 9);
    expect(circleZeroChord({ x: 30, y: 0 }, 5, f)).toBeNull();
  });

  it('draws the sagittal reference line on the axial view as a full-height vertical line', () => {
    const line = referenceLine(axial, sagittal)!;
    expect(line).not.toBeNull();
    expect(line.start.x).toBeCloseTo(100.5, 9);
    expect(line.end.x).toBeCloseTo(100.5, 9);
    expect(Math.abs(line.end.y - line.start.y)).toBeCloseTo(512, 9);
    expect(referenceLine(axial, orthogonalPlane(grid, 'axial', 3))).toBeNull();
  });

  it('clips segments to the image rectangle', () => {
    const view: PlaneFrame = { ...axial, width: 100, height: 50 };
    const c = clipSegmentToImage({ start: { x: -50, y: 25 }, end: { x: 150, y: 25 } }, view)!;
    close2(c.start, { x: 0, y: 25 });
    close2(c.end, { x: 100, y: 25 });
    expect(clipSegmentToImage({ start: { x: -5, y: -5 }, end: { x: -1, y: -1 } }, view)).toBeNull();
  });

  it('projects consistently through an oblique view', () => {
    const oblique = centredPlane(
      indexToPatient(grid, [100, 200, 150]),
      rotateAbout([1, 0, 0], [0, 0, 1], 0.3),
      rotateAbout([0, 0, -1], [1, 0, 0], 0.2),
      0.7,
      512,
      512,
      0.7,
    );
    const p = { x: 100.5, y: 200.5 };
    const f = distanceField(axial, oblique);
    expect(Math.abs(evaluateField(f, p))).toBeLessThan(1e-9);
    // The point is the oblique plane's centre.
    close2(transferPoint(axial, oblique, p), { x: 256, y: 256 }, 1e-9);
  });
});
