import { add, addScaled, cross, dot, normalize, scale, sub, type Vec3 } from './vec3.js';
import { PIXEL_CENTRE, type PlaneFrame } from './plane-frame.js';

/**
 * The sampling grid of a 3D volume in the patient frame, NIfTI/ITK style:
 * voxel `(i, j, k)` (integers at voxel centres) sits at
 * `origin + i*spacing[0]*direction[0] + j*spacing[1]*direction[1] + k*spacing[2]*direction[2]`.
 *
 * For a volume assembled from a DICOM series, `direction[0]` / `direction[1]`
 * are the series' ImageOrientationPatient row / column cosines, `origin` the
 * first slice's ImagePositionPatient and `direction[2]` the normalized step
 * between consecutive slice positions (which need not be perpendicular to the
 * other two: gantry tilt shears the grid, and the inverse below is general).
 */
export interface VolumeGrid {
  /** Voxel counts along i (columns), j (rows), k (slices). */
  readonly dimensions: readonly [number, number, number];
  /** mm per index step along i, j, k. */
  readonly spacing: Vec3;
  /** Patient position of the centre of voxel (0,0,0). */
  readonly origin: Vec3;
  /** Unit patient-space directions of increasing i, j, k. */
  readonly direction: readonly [Vec3, Vec3, Vec3];
}

/** Continuous voxel index (integers = voxel centres) -> patient mm. */
export function indexToPatient(g: VolumeGrid, ijk: Vec3): Vec3 {
  let p = g.origin;
  p = addScaled(p, g.direction[0], ijk[0] * g.spacing[0]);
  p = addScaled(p, g.direction[1], ijk[1] * g.spacing[1]);
  p = addScaled(p, g.direction[2], ijk[2] * g.spacing[2]);
  return p;
}

/**
 * Columns of the index->patient linear map scaled by spacing, inverted. Kept
 * general (not a transpose) so sheared grids work.
 */
function inverseLinear(g: VolumeGrid): readonly [Vec3, Vec3, Vec3] {
  const a = scale(g.direction[0], g.spacing[0]);
  const b = scale(g.direction[1], g.spacing[1]);
  const c = scale(g.direction[2], g.spacing[2]);
  const det = dot(a, cross(b, c));
  if (Math.abs(det) < 1e-12) throw new RangeError('degenerate volume grid');
  // Rows of the inverse of [a b c] are (b x c, c x a, a x b) / det.
  return [scale(cross(b, c), 1 / det), scale(cross(c, a), 1 / det), scale(cross(a, b), 1 / det)];
}

/** Patient mm -> continuous voxel index. */
export function patientToIndex(g: VolumeGrid, P: Vec3): Vec3 {
  const inv = inverseLinear(g);
  const d = sub(P, g.origin);
  return [dot(inv[0], d), dot(inv[1], d), dot(inv[2], d)];
}

/** A patient-space displacement (not a position) expressed in index steps. */
export function patientDirectionToIndex(g: VolumeGrid, v: Vec3): Vec3 {
  const inv = inverseLinear(g);
  return [dot(inv[0], v), dot(inv[1], v), dot(inv[2], v)];
}

/** Centre of the volume (midpoint of the first and last voxel centres). */
export function volumeCentre(g: VolumeGrid): Vec3 {
  return indexToPatient(g, [
    (g.dimensions[0] - 1) / 2,
    (g.dimensions[1] - 1) / 2,
    (g.dimensions[2] - 1) / 2,
  ]);
}

export type OrthogonalOrientation = 'axial' | 'coronal' | 'sagittal';

/**
 * The canonical axial / coronal / sagittal frame through voxel slice `index`,
 * in the radiological display convention for an LPS grid whose i, j, k run
 * left, posterior, superior: axial looks from the feet (image +x = i,
 * +y = j), coronal from the front (+x = i, +y = -k, superior at the top),
 * sagittal from the patient's left (+x = j, +y = -k).
 *
 * Pixels are square at `pixelSpacing` (default: the finest in-plane voxel
 * spacing), so an anisotropic volume's coronal / sagittal planes are resampled
 * along k. OpenSeadragon and Fabric both assume square image pixels, so this is
 * the output grid an osdlabel cell can show without distortion.
 */
export function orthogonalPlane(
  g: VolumeGrid,
  orientation: OrthogonalOrientation,
  index: number,
  pixelSpacing?: number,
): PlaneFrame {
  const [nx, ny, nz] = g.dimensions;
  const [sx, sy, sz] = g.spacing;
  const [di, dj, dk] = g.direction;
  switch (orientation) {
    case 'axial': {
      const s = pixelSpacing ?? Math.min(sx, sy);
      return planeOverExtent(
        indexToPatient(g, [-0.5, -0.5, index]),
        di,
        dj,
        s,
        nx * sx,
        ny * sy,
        sz,
      );
    }
    case 'coronal': {
      const s = pixelSpacing ?? Math.min(sx, sz);
      return planeOverExtent(
        indexToPatient(g, [-0.5, index, nz - 0.5]),
        di,
        scale(dk, -1),
        s,
        nx * sx,
        nz * sz,
        sy,
      );
    }
    case 'sagittal': {
      const s = pixelSpacing ?? Math.min(sy, sz);
      return planeOverExtent(
        indexToPatient(g, [index, -0.5, nz - 0.5]),
        dj,
        scale(dk, -1),
        s,
        ny * sy,
        nz * sz,
        sx,
      );
    }
  }
}

/**
 * A frame whose top-left pixel EDGE corner is `corner` and that covers
 * `extentX x extentY` mm at square `spacing`.
 */
function planeOverExtent(
  corner: Vec3,
  rowDirection: Vec3,
  columnDirection: Vec3,
  spacing: number,
  extentX: number,
  extentY: number,
  thickness: number,
): PlaneFrame {
  const width = Math.max(1, Math.round(extentX / spacing));
  const height = Math.max(1, Math.round(extentY / spacing));
  const origin = addScaled(
    addScaled(corner, rowDirection, PIXEL_CENTRE * spacing),
    columnDirection,
    PIXEL_CENTRE * spacing,
  );
  return {
    origin,
    rowDirection,
    columnDirection,
    pixelSpacing: { x: spacing, y: spacing },
    width,
    height,
    thickness,
  };
}

/**
 * A `width x height` frame centred on `centre` with the given in-plane axes
 * (orthonormalized: `columnDirection` is made perpendicular to
 * `rowDirection`). The size does not depend on the orientation, so an
 * interactively rotated oblique view keeps a constant image size — which is
 * what lets one OpenSeadragon tile source serve every angle.
 */
export function centredPlane(
  centre: Vec3,
  rowDirection: Vec3,
  columnDirection: Vec3,
  spacing: number,
  width: number,
  height: number,
  thickness: number,
): PlaneFrame {
  const r = normalize(rowDirection);
  const c = normalize(sub(columnDirection, scale(r, dot(columnDirection, r))));
  const origin = add(
    centre,
    add(
      scale(r, -(width / 2 - PIXEL_CENTRE) * spacing),
      scale(c, -(height / 2 - PIXEL_CENTRE) * spacing),
    ),
  );
  return {
    origin,
    rowDirection: r,
    columnDirection: c,
    pixelSpacing: { x: spacing, y: spacing },
    width,
    height,
    thickness,
  };
}

/**
 * Affine map from output pixel (x, y) (integer pixel indices, sampled at the
 * pixel centre) to continuous voxel index: `index = start + x*stepX + y*stepY`.
 * This is all a reslicer — CPU or GPU — needs to know about a plane.
 */
export interface PlaneIndexMapping {
  readonly start: Vec3;
  readonly stepX: Vec3;
  readonly stepY: Vec3;
}

export function planeIndexMapping(g: VolumeGrid, frame: PlaneFrame): PlaneIndexMapping {
  return {
    start: patientToIndex(g, frame.origin),
    stepX: patientDirectionToIndex(g, scale(frame.rowDirection, frame.pixelSpacing.x)),
    stepY: patientDirectionToIndex(g, scale(frame.columnDirection, frame.pixelSpacing.y)),
  };
}
