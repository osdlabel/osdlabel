import {
  imageToPatient,
  patientToImage,
  planeCorners,
  planeNormal,
  signedDistance,
  type PlaneFrame,
} from './plane-frame.js';
import { dot, sub, type Point2 } from './vec3.js';

/**
 * Signed distance (mm) from a `view` plane, as an affine function of image-space
 * position in a `source` plane: `d(p) = d0 + gx * p.x + gy * p.y`.
 *
 * Everything a cross-view projection needs follows from it: the zero set is
 * the line where the view cuts the source image, and `|d| <= thickness / 2`
 * is the slab within which source content counts as "on" the view.
 */
export interface DistanceField {
  readonly d0: number;
  readonly gx: number;
  readonly gy: number;
}

export function distanceField(source: PlaneFrame, view: PlaneFrame): DistanceField {
  const n = planeNormal(view);
  const at0 = signedDistance(view, imageToPatient(source, { x: 0, y: 0 }));
  return {
    d0: at0,
    gx: dot(source.rowDirection, n) * source.pixelSpacing.x,
    gy: dot(source.columnDirection, n) * source.pixelSpacing.y,
  };
}

export const evaluateField = (f: DistanceField, p: Point2): number =>
  f.d0 + f.gx * p.x + f.gy * p.y;

/** The planes are parallel when the field has no in-plane gradient. */
export function isParallelField(f: DistanceField, epsilon = 1e-9): boolean {
  return Math.abs(f.gx) <= epsilon && Math.abs(f.gy) <= epsilon;
}

/** A segment in some image's pixel space. */
export interface Segment2 {
  readonly start: Point2;
  readonly end: Point2;
}

/**
 * Where an edge crosses the zero set. Half-open classification (`d > 0` versus
 * `d <= 0`) counts a vertex lying exactly on the line once, never twice, so
 * the even-odd pairing below stays consistent.
 */
function crossing(a: Point2, b: Point2, da: number, db: number): Point2 | null {
  if (da > 0 === db > 0) return null;
  const t = da / (da - db);
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
}

/**
 * The parts of a (possibly concave) polygon's interior that the field's zero
 * line passes through, in the polygon's own image space. Crossings are sorted
 * along the line and paired even-odd, so a concave polygon yields several
 * segments.
 */
export function polygonZeroSegments(points: readonly Point2[], f: DistanceField): Segment2[] {
  const n = points.length;
  if (n < 3 || isParallelField(f)) return [];
  const hits: Point2[] = [];
  for (let i = 0; i < n; i++) {
    const a = points[i]!;
    const b = points[(i + 1) % n]!;
    const c = crossing(a, b, evaluateField(f, a), evaluateField(f, b));
    if (c) hits.push(c);
  }
  // Direction of the zero line: perpendicular to the gradient.
  const ux = -f.gy;
  const uy = f.gx;
  hits.sort((p, q) => p.x * ux + p.y * uy - (q.x * ux + q.y * uy));
  const out: Segment2[] = [];
  for (let i = 0; i + 1 < hits.length; i += 2) out.push({ start: hits[i]!, end: hits[i + 1]! });
  return out;
}

/** Points where an open polyline (or a closed one, with `closed`) crosses the zero line. */
export function polylineZeroCrossings(
  points: readonly Point2[],
  f: DistanceField,
  closed = false,
): Point2[] {
  const out: Point2[] = [];
  const edges = closed ? points.length : points.length - 1;
  if (isParallelField(f)) return out;
  for (let i = 0; i < edges; i++) {
    const a = points[i]!;
    const b = points[(i + 1) % points.length]!;
    const c = crossing(a, b, evaluateField(f, a), evaluateField(f, b));
    if (c) out.push(c);
  }
  return out;
}

/** The chord a circle (in its own image space, square pixels) cuts on the zero line, if any. */
export function circleZeroChord(centre: Point2, radius: number, f: DistanceField): Segment2 | null {
  if (isParallelField(f)) return null;
  const g = Math.hypot(f.gx, f.gy);
  // Distance (pixels) from the centre to the line, signed.
  const dist = evaluateField(f, centre) / g;
  if (Math.abs(dist) > radius) return null;
  const half = Math.sqrt(radius * radius - dist * dist);
  const nx = f.gx / g;
  const ny = f.gy / g;
  // Foot of the perpendicular from the centre onto the line.
  const fx = centre.x - nx * dist;
  const fy = centre.y - ny * dist;
  return {
    start: { x: fx + ny * half, y: fy - nx * half },
    end: { x: fx - ny * half, y: fy + nx * half },
  };
}

/** Map a point from one plane's image space to another's (orthogonal projection). */
export function transferPoint(source: PlaneFrame, view: PlaneFrame, p: Point2): Point2 {
  return patientToImage(view, imageToPatient(source, p)).point;
}

/**
 * Clip a segment to the view's image rectangle `[0, width] x [0, height]`
 * (Liang-Barsky). Returns `null` when nothing is left.
 */
export function clipSegmentToImage(seg: Segment2, view: PlaneFrame): Segment2 | null {
  let t0 = 0;
  let t1 = 1;
  const dx = seg.end.x - seg.start.x;
  const dy = seg.end.y - seg.start.y;
  const tests: readonly (readonly [number, number])[] = [
    [-dx, seg.start.x],
    [dx, view.width - seg.start.x],
    [-dy, seg.start.y],
    [dy, view.height - seg.start.y],
  ];
  for (const [p, q] of tests) {
    if (p === 0) {
      if (q < 0) return null;
      continue;
    }
    const r = q / p;
    if (p < 0) {
      if (r > t1) return null;
      if (r > t0) t0 = r;
    } else {
      if (r < t0) return null;
      if (r < t1) t1 = r;
    }
  }
  return {
    start: { x: seg.start.x + dx * t0, y: seg.start.y + dy * t0 },
    end: { x: seg.start.x + dx * t1, y: seg.start.y + dy * t1 },
  };
}

/**
 * The reference line of `other` in `view`: the part of `other`'s image
 * rectangle that `view`'s plane passes through, drawn in `view`'s image space
 * and clipped to it. This is DICOM's classic "localizer / reference line" and
 * the crosshair of an MPR layout. `null` if the planes are parallel or miss.
 */
export function referenceLine(view: PlaneFrame, other: PlaneFrame): Segment2 | null {
  const corners = planeCorners(other);
  const ds = corners.map((c) => signedDistance(view, c));
  const hits: Point2[] = [];
  for (let i = 0; i < 4; i++) {
    const a = corners[i]!;
    const b = corners[(i + 1) % 4]!;
    const da = ds[i]!;
    const db = ds[(i + 1) % 4]!;
    if (da > 0 === db > 0) continue;
    const t = da / (da - db);
    const P = [
      a[0] + (b[0] - a[0]) * t,
      a[1] + (b[1] - a[1]) * t,
      a[2] + (b[2] - a[2]) * t,
    ] as const;
    hits.push(patientToImage(view, P).point);
  }
  if (hits.length < 2) return null;
  return clipSegmentToImage({ start: hits[0]!, end: hits[1]! }, view);
}

/** Euclidean distance (mm) between two frames' origins projected on `view`'s normal. */
export function sliceOffset(view: PlaneFrame, other: PlaneFrame): number {
  return dot(sub(other.origin, view.origin), planeNormal(view));
}
