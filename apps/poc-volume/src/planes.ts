import {
  centredPlane,
  orthogonalPlane,
  rotateAbout,
  volumeCentre,
  type PlaneFrame,
  type Vec3,
  type VolumeGrid,
} from '@osdlabel/spatial';

export type PlaneKind = 'axial' | 'coronal' | 'sagittal' | 'oblique';

/**
 * The oblique view: a fixed 512 x 512 field of view at 0.7 mm (the axial
 * pixel count, so costs compare like for like) through the volume centre,
 * tilted `tiltDeg` about the patient x axis and spun `spinDeg` about z.
 */
export function obliquePlane(grid: VolumeGrid, tiltDeg: number, spinDeg = 0): PlaneFrame {
  const t = (tiltDeg * Math.PI) / 180;
  const s = (spinDeg * Math.PI) / 180;
  const z: Vec3 = [0, 0, 1];
  const xAxis: Vec3 = [1, 0, 0];
  let row: Vec3 = [1, 0, 0];
  let col: Vec3 = [0, 1, 0];
  row = rotateAbout(rotateAbout(row, xAxis, t), z, s);
  col = rotateAbout(rotateAbout(col, xAxis, t), z, s);
  return centredPlane(volumeCentre(grid), row, col, 0.7, 512, 512, 0.7);
}

export function planeFor(
  grid: VolumeGrid,
  kind: PlaneKind,
  index?: number,
  tiltDeg = 30,
  spinDeg = 20,
): PlaneFrame {
  const [nx, ny, nz] = grid.dimensions;
  switch (kind) {
    case 'axial':
      return orthogonalPlane(grid, 'axial', index ?? Math.floor(nz / 2));
    case 'coronal':
      return orthogonalPlane(grid, 'coronal', index ?? Math.floor(ny / 2));
    case 'sagittal':
      return orthogonalPlane(grid, 'sagittal', index ?? Math.floor(nx / 2));
    case 'oblique':
      return obliquePlane(grid, tiltDeg, spinDeg);
  }
}
