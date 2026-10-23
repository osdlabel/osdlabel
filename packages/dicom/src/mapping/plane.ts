import type { DicomDataset } from '../dataset.js';
import { item, nums, str } from '../dataset.js';
import { TAGS } from '../tags.js';

export type Vec3 = readonly [number, number, number];

/** A 2D image-space point; structurally `Point` from `@osdlabel/annotation`. */
export interface Point {
  readonly x: number;
  readonly y: number;
}

/**
 * Where one image plane sits in the patient (or slide) coordinate system.
 * Generic — a volume or MPR feature needs exactly this, DICOM or not.
 */
export interface PlaneGeometry {
  readonly frameOfReferenceUid: string | undefined;
  /** Patient-space (LPS, mm) position of the *centre* of the first pixel. */
  readonly position: Vec3;
  /** Unit vector along increasing column index (image x). */
  readonly rowDirection: Vec3;
  /** Unit vector along increasing row index (image y). */
  readonly columnDirection: Vec3;
  /** rowDirection × columnDirection. */
  readonly normal: Vec3;
  /** mm per pixel along image x (column spacing) and y (row spacing). */
  readonly spacing: { readonly x: number; readonly y: number };
  readonly sliceThickness: number | undefined;
}

export const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const cross = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const norm = (a: Vec3): number => Math.hypot(a[0], a[1], a[2]);

/**
 * Reads Image Position / Orientation (Patient) and Pixel Spacing — from the
 * top level, or from Plane Position / Orientation and Pixel Measures functional
 * groups for one frame of an enhanced multi-frame image.
 */
export function readPlaneGeometry(
  ds: DicomDataset,
  options: { readonly frame?: number } = {},
): PlaneGeometry | undefined {
  const perFrame =
    options.frame !== undefined
      ? ds.sequence(TAGS.PerFrameFunctionalGroupsSequence.tag)?.[options.frame]
      : undefined;
  const shared = item(ds, TAGS.SharedFunctionalGroupsSequence.tag);
  const fg = (seqTag: number): DicomDataset | undefined =>
    (perFrame && item(perFrame, seqTag)) ?? (shared && item(shared, seqTag));
  const ipp =
    nums(ds, TAGS.ImagePositionPatient.tag, 3) ??
    nums(fg(TAGS.PlanePositionSequence.tag) ?? ds, TAGS.ImagePositionPatient.tag, 3);
  const iop =
    nums(ds, TAGS.ImageOrientationPatient.tag, 6) ??
    nums(fg(TAGS.PlaneOrientationSequence.tag) ?? ds, TAGS.ImageOrientationPatient.tag, 6);
  const ps =
    nums(ds, TAGS.PixelSpacing.tag, 2) ??
    nums(fg(TAGS.PixelMeasuresSequence.tag) ?? ds, TAGS.PixelSpacing.tag, 2);
  if (!ipp || !iop || !ps) return undefined;
  const row: Vec3 = [iop[0]!, iop[1]!, iop[2]!];
  const col: Vec3 = [iop[3]!, iop[4]!, iop[5]!];
  const n = cross(row, col);
  const thickness = nums(ds, TAGS.SliceThickness.tag, 1)?.[0];
  return {
    frameOfReferenceUid: str(ds, TAGS.FrameOfReferenceUID.tag),
    position: [ipp[0]!, ipp[1]!, ipp[2]!],
    rowDirection: row,
    columnDirection: col,
    normal: n,
    spacing: { x: ps[1]!, y: ps[0]! },
    sliceThickness: thickness,
  };
}

/**
 * The slide coordinate system of a VL Whole Slide Microscopy image (its Total
 * Pixel Matrix), as a {@link PlaneGeometry}: Total Pixel Matrix Origin gives
 * the position of the top-left pixel on the slide (mm), Image Orientation
 * (Slide) the axes, Pixel Measures the spacing. One shape for patient and
 * slide frames means one `imageToPatient` serves SR, SEG and ANN in 3D.
 */
export function readSlidePlane(ds: DicomDataset): PlaneGeometry | undefined {
  const origin = item(ds, TAGS.TotalPixelMatrixOriginSequence.tag);
  const ios = nums(ds, TAGS.ImageOrientationSlide.tag, 6);
  const shared = item(ds, TAGS.SharedFunctionalGroupsSequence.tag);
  const pm = shared && item(shared, TAGS.PixelMeasuresSequence.tag);
  const ps = pm && nums(pm, TAGS.PixelSpacing.tag, 2);
  if (!origin || !ios || !ps) return undefined;
  const x = nums(origin, TAGS.XOffsetInSlideCoordinateSystem.tag, 1)?.[0];
  const y = nums(origin, TAGS.YOffsetInSlideCoordinateSystem.tag, 1)?.[0];
  const z = nums(origin, TAGS.ZOffsetInSlideCoordinateSystem.tag, 1)?.[0] ?? 0;
  if (x === undefined || y === undefined) return undefined;
  const row: Vec3 = [ios[0]!, ios[1]!, ios[2]!];
  const col: Vec3 = [ios[3]!, ios[4]!, ios[5]!];
  return {
    frameOfReferenceUid: str(ds, TAGS.FrameOfReferenceUID.tag),
    position: [x, y, z],
    rowDirection: row,
    columnDirection: col,
    normal: cross(row, col),
    spacing: { x: ps[1]!, y: ps[0]! },
    sliceThickness: undefined,
  };
}

/**
 * osdlabel image space → patient space. osdlabel puts (0,0) at the top-left
 * *corner* of the top-left pixel; DICOM's Image Position is that pixel's
 * *centre* — hence the half-pixel shift. Getting this wrong moves every
 * exported 3D coordinate by half a pixel diagonally.
 */
export function imageToPatient(plane: PlaneGeometry, p: Point): Vec3 {
  const u = (p.x - 0.5) * plane.spacing.x;
  const v = (p.y - 0.5) * plane.spacing.y;
  return [
    plane.position[0] + u * plane.rowDirection[0] + v * plane.columnDirection[0],
    plane.position[1] + u * plane.rowDirection[1] + v * plane.columnDirection[1],
    plane.position[2] + u * plane.rowDirection[2] + v * plane.columnDirection[2],
  ];
}

/** Patient space → osdlabel image space, plus the signed distance off the plane (mm). */
export function patientToImage(
  plane: PlaneGeometry,
  q: Vec3,
): Point & { readonly offPlane: number } {
  const d = sub(q, plane.position);
  return {
    x: dot(d, plane.rowDirection) / plane.spacing.x + 0.5,
    y: dot(d, plane.columnDirection) / plane.spacing.y + 0.5,
    offPlane: dot(d, plane.normal),
  };
}

export interface StackSlice<T> {
  readonly item: T;
  readonly plane: PlaneGeometry;
  /** Position along the stack normal (mm). */
  readonly location: number;
}

export interface StackGeometry<T> {
  readonly slices: readonly StackSlice<T>[];
  readonly normal: Vec3 | undefined;
  readonly frameOfReferenceUid: string | undefined;
  /** Gaps between consecutive slice locations (mm). */
  readonly gaps: readonly number[];
  readonly uniform: boolean;
  readonly sameOrientation: boolean;
  readonly sameFrameOfReference: boolean;
  /** Items without plane geometry, which cannot be placed. */
  readonly unplaced: readonly T[];
  readonly notes: readonly string[];
}

/**
 * Orders a set of single-frame images into a stack by projecting each Image
 * Position onto the shared normal — never by Instance Number or Slice
 * Location, which are not guaranteed to be geometric. Reports what a volume
 * consumer must check before treating the stack as a regular grid.
 */
export function buildStack<T>(
  items: readonly T[],
  planeOf: (item: T) => PlaneGeometry | undefined,
  tolerance = 1e-3,
): StackGeometry<T> {
  const placed: { item: T; plane: PlaneGeometry }[] = [];
  const unplaced: T[] = [];
  for (const it of items) {
    const p = planeOf(it);
    if (p) placed.push({ item: it, plane: p });
    else unplaced.push(it);
  }
  const notes: string[] = [];
  const first = placed[0]?.plane;
  if (!first) {
    return {
      slices: [],
      normal: undefined,
      frameOfReferenceUid: undefined,
      gaps: [],
      uniform: false,
      sameOrientation: false,
      sameFrameOfReference: false,
      unplaced,
      notes: ['no image carries plane geometry'],
    };
  }
  const normal = first.normal;
  const sameOrientation = placed.every(
    (s) =>
      norm(sub(s.plane.rowDirection, first.rowDirection)) < tolerance &&
      norm(sub(s.plane.columnDirection, first.columnDirection)) < tolerance,
  );
  const sameFrameOfReference = placed.every(
    (s) => s.plane.frameOfReferenceUid === first.frameOfReferenceUid,
  );
  if (!sameOrientation) notes.push('slices differ in orientation: not a single stack');
  if (!sameFrameOfReference) notes.push('slices span frames of reference');
  const slices = placed
    .map((s) => ({ ...s, location: dot(s.plane.position, normal) }))
    .sort((a, b) => a.location - b.location);
  const gaps: number[] = [];
  for (let i = 1; i < slices.length; i++) gaps.push(slices[i]!.location - slices[i - 1]!.location);
  const mean = gaps.length ? gaps.reduce((a, b) => a + b, 0) / gaps.length : 0;
  const uniform = gaps.every(
    (g) => Math.abs(g - mean) <= Math.max(tolerance, 0.01 * Math.abs(mean)),
  );
  if (gaps.some((g) => Math.abs(g) < tolerance)) notes.push('duplicate slice positions');
  if (!uniform) notes.push('non-uniform slice spacing: resampling needed for a regular volume');
  return {
    slices,
    normal,
    frameOfReferenceUid: first.frameOfReferenceUid,
    gaps,
    uniform,
    sameOrientation,
    sameFrameOfReference,
    unplaced,
    notes,
  };
}
