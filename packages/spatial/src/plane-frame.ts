import { addScaled, cross, dot, length, normalize, sub, type Point2, type Vec3 } from './vec3.js';

/**
 * Physical size of one image pixel, in millimetres.
 *
 * `x` is the distance between adjacent **columns** (along `rowDirection`) and
 * `y` the distance between adjacent **rows** (along `columnDirection`). Note the
 * order is the reverse of DICOM's `PixelSpacing` attribute, which lists the row
 * spacing first: `{ x: PixelSpacing[1], y: PixelSpacing[0] }`.
 */
export interface PlaneSpacing {
  readonly x: number;
  readonly y: number;
}

/**
 * A 2D raster image placed in the patient frame: the information DICOM carries
 * in ImagePositionPatient (0020,0032), ImageOrientationPatient (0020,0037),
 * PixelSpacing (0028,0030), Rows / Columns and SliceThickness / spacing.
 *
 * It is what turns an osdlabel image-space point (pixels, `(0,0)` = top-left
 * corner of the image, pixel `(i,j)` covering `[i,i+1) x [j,j+1)`) into a
 * patient-space point and back. Annotations keep their 2D geometry; storing the
 * frame next to it is what makes them comparable across views.
 */
export interface PlaneFrame {
  /** Patient position (mm) of the CENTRE of pixel (0,0) — ImagePositionPatient. */
  readonly origin: Vec3;
  /** Unit vector of increasing column index (image +x) — IOP[0..2]. */
  readonly rowDirection: Vec3;
  /** Unit vector of increasing row index (image +y) — IOP[3..5]. */
  readonly columnDirection: Vec3;
  readonly pixelSpacing: PlaneSpacing;
  /** Image width in pixels (Columns). */
  readonly width: number;
  /** Image height in pixels (Rows). */
  readonly height: number;
  /**
   * Slab thickness in mm. Out-of-plane content within `thickness / 2` of the
   * plane counts as lying on it (a point annotation shows as a marker).
   */
  readonly thickness: number;
}

/** Offset between osdlabel's corner-based pixel coordinates and DICOM's centre-based ones. */
export const PIXEL_CENTRE = 0.5;

/** Tolerance used when validating direction cosines. */
const ORTHONORMAL_EPSILON = 1e-6;

/** Unit normal of the plane: `rowDirection x columnDirection`. */
export function planeNormal(frame: PlaneFrame): Vec3 {
  return cross(frame.rowDirection, frame.columnDirection);
}

/**
 * Throws unless `rowDirection` / `columnDirection` are unit length and
 * mutually perpendicular, and spacing / size / thickness are positive. Every
 * other function assumes this holds.
 */
export function assertValidPlaneFrame(frame: PlaneFrame): void {
  const r = frame.rowDirection;
  const c = frame.columnDirection;
  if (Math.abs(length(r) - 1) > ORTHONORMAL_EPSILON)
    throw new RangeError('rowDirection is not unit');
  if (Math.abs(length(c) - 1) > ORTHONORMAL_EPSILON)
    throw new RangeError('columnDirection is not unit');
  if (Math.abs(dot(r, c)) > ORTHONORMAL_EPSILON)
    throw new RangeError('rowDirection and columnDirection are not perpendicular');
  if (!(frame.pixelSpacing.x > 0 && frame.pixelSpacing.y > 0))
    throw new RangeError('pixelSpacing must be positive');
  if (!(frame.width > 0 && frame.height > 0)) throw new RangeError('size must be positive');
  if (!(frame.thickness > 0)) throw new RangeError('thickness must be positive');
}

/** Image-space point (osdlabel pixels) -> patient-space point (mm). */
export function imageToPatient(frame: PlaneFrame, p: Point2): Vec3 {
  const u = (p.x - PIXEL_CENTRE) * frame.pixelSpacing.x;
  const v = (p.y - PIXEL_CENTRE) * frame.pixelSpacing.y;
  return addScaled(addScaled(frame.origin, frame.rowDirection, u), frame.columnDirection, v);
}

/** A patient point expressed in a plane's image space plus its offset from the plane. */
export interface PlaneProjection {
  /** Orthogonal projection onto the plane, in image-space pixels. */
  readonly point: Point2;
  /** Signed distance from the plane in mm, positive along {@link planeNormal}. */
  readonly distance: number;
}

/** Patient-space point (mm) -> image-space point of its projection, plus signed distance. */
export function patientToImage(frame: PlaneFrame, P: Vec3): PlaneProjection {
  const d = sub(P, frame.origin);
  return {
    point: {
      x: dot(d, frame.rowDirection) / frame.pixelSpacing.x + PIXEL_CENTRE,
      y: dot(d, frame.columnDirection) / frame.pixelSpacing.y + PIXEL_CENTRE,
    },
    distance: dot(d, planeNormal(frame)),
  };
}

/** Signed distance (mm) from the plane, positive along the normal. */
export function signedDistance(frame: PlaneFrame, P: Vec3): number {
  return dot(sub(P, frame.origin), planeNormal(frame));
}

/**
 * Build a frame from DICOM attributes as they appear in a header.
 *
 * @param ipp ImagePositionPatient
 * @param iop ImageOrientationPatient (six direction cosines)
 * @param pixelSpacing DICOM PixelSpacing: `[rowSpacing, columnSpacing]`
 */
export function planeFrameFromDicom(
  ipp: Vec3,
  iop: readonly [number, number, number, number, number, number],
  pixelSpacing: readonly [number, number],
  rows: number,
  columns: number,
  thickness: number,
): PlaneFrame {
  const frame: PlaneFrame = {
    origin: ipp,
    rowDirection: normalize([iop[0], iop[1], iop[2]]),
    columnDirection: normalize([iop[3], iop[4], iop[5]]),
    pixelSpacing: { x: pixelSpacing[1], y: pixelSpacing[0] },
    width: columns,
    height: rows,
    thickness,
  };
  assertValidPlaneFrame(frame);
  return frame;
}

/**
 * Two frames describe the same plane (within `toleranceMm` along the normal and
 * parallel within `angleEpsilon`). Used to decide whether an annotation is
 * native to a view (edit it as a Fabric object) or foreign (show its
 * projection as a decoration).
 */
export function isSamePlane(
  a: PlaneFrame,
  b: PlaneFrame,
  toleranceMm = Math.min(a.thickness, b.thickness) / 2,
  angleEpsilon = 1e-6,
): boolean {
  const na = planeNormal(a);
  const nb = planeNormal(b);
  if (1 - Math.abs(dot(na, nb)) > angleEpsilon) return false;
  return Math.abs(signedDistance(a, b.origin)) <= toleranceMm;
}

/** The four image corners (pixel-edge corners, not centres) in patient space, clockwise from top-left. */
export function planeCorners(frame: PlaneFrame): readonly [Vec3, Vec3, Vec3, Vec3] {
  return [
    imageToPatient(frame, { x: 0, y: 0 }),
    imageToPatient(frame, { x: frame.width, y: 0 }),
    imageToPatient(frame, { x: frame.width, y: frame.height }),
    imageToPatient(frame, { x: 0, y: frame.height }),
  ];
}
