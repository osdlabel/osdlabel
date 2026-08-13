import type { Point } from '@osdlabel/annotation';
import type { SegmentationMask } from './mask.js';

/** Options for {@link maskToContours}. */
export interface MaskToContoursOptions {
  /** Values `>= threshold` are foreground. Default `0.5`. */
  readonly threshold?: number;
  /** Douglas–Peucker tolerance in pixels; `0` disables simplification. Default `1`. */
  readonly simplifyTolerance?: number;
  /** Drop components whose pixel area is below this. Default `0`. */
  readonly minArea?: number;
}

/** Clockwise 8-neighbourhood offsets, starting at North. */
const CW: ReadonlyArray<readonly [number, number]> = [
  [0, -1],
  [1, -1],
  [1, 0],
  [1, 1],
  [0, 1],
  [-1, 1],
  [-1, 0],
  [-1, -1],
];

/**
 * Vectorizes a dense {@link SegmentationMask} into closed contour rings in
 * image-space pixel coordinates, ordered **largest-first** to match the
 * `SegmentationResult.contours` convention the segmentation tool consumes.
 *
 * Connected foreground components (4-connectivity) are found by flood fill, each
 * component's outer boundary is traced with Moore-neighbour tracing, and the
 * resulting ring is simplified with Douglas–Peucker. Inner rings (holes) are not
 * emitted in this version — only the outer boundary of each component.
 */
export function maskToContours(mask: SegmentationMask, options?: MaskToContoursOptions): Point[][] {
  const { width: w, height: h, data } = mask;
  const threshold = options?.threshold ?? 0.5;
  const tolerance = options?.simplifyTolerance ?? 1;
  const minArea = options?.minArea ?? 0;

  const isFg = (x: number, y: number): boolean =>
    x >= 0 && y >= 0 && x < w && y < h && data[y * w + x]! >= threshold;

  const visited = new Uint8Array(w * h);
  const rings: { points: Point[]; area: number }[] = [];

  for (let sy = 0; sy < h; sy++) {
    for (let sx = 0; sx < w; sx++) {
      if (!isFg(sx, sy) || visited[sy * w + sx]) continue;
      // Flood-fill the whole component so we never re-trace it (incl. holes).
      const area = floodFill(sx, sy, w, h, isFg, visited);
      if (area < minArea) continue;
      const boundary = traceBoundary(sx, sy, isFg);
      const points = tolerance > 0 ? simplify(boundary, tolerance) : boundary;
      if (points.length >= 3) rings.push({ points, area: Math.abs(shoelace(points)) });
    }
  }

  rings.sort((a, b) => b.area - a.area);
  return rings.map((r) => r.points);
}

/** Marks every pixel of the 4-connected component as visited; returns its area. */
function floodFill(
  sx: number,
  sy: number,
  w: number,
  h: number,
  isFg: (x: number, y: number) => boolean,
  visited: Uint8Array,
): number {
  let area = 0;
  const stack: number[] = [sx, sy];
  while (stack.length > 0) {
    const y = stack.pop()!;
    const x = stack.pop()!;
    if (x < 0 || y < 0 || x >= w || y >= h) continue;
    const idx = y * w + x;
    if (visited[idx] || !isFg(x, y)) continue;
    visited[idx] = 1;
    area++;
    stack.push(x + 1, y, x - 1, y, x, y + 1, x, y - 1);
  }
  return area;
}

/** Moore-neighbour boundary trace starting from the top-left-most pixel `(sx, sy)`. */
function traceBoundary(sx: number, sy: number, isFg: (x: number, y: number) => boolean): Point[] {
  const boundary: Point[] = [];
  let cx = sx;
  let cy = sy;
  // We reached the start by scanning left→right, so we came from the west.
  let bx = sx - 1;
  let by = sy;
  // Generous guard against pathological non-termination.
  let guard = 0;
  const hardCap = 1_000_000;

  do {
    boundary.push({ x: cx, y: cy });
    const back = neighborIndex(bx - cx, by - cy);
    let found = false;
    for (let i = 1; i <= 8; i++) {
      const idx = (back + i) % 8;
      const nx = cx + CW[idx]![0];
      const ny = cy + CW[idx]![1];
      if (isFg(nx, ny)) {
        const prev = (back + i - 1) % 8;
        bx = cx + CW[prev]![0];
        by = cy + CW[prev]![1];
        cx = nx;
        cy = ny;
        found = true;
        break;
      }
    }
    if (!found) break; // isolated single-pixel component
    guard++;
  } while (!(cx === sx && cy === sy) && guard < hardCap);

  return boundary;
}

/** Index into {@link CW} of the offset `(dx, dy)`. */
function neighborIndex(dx: number, dy: number): number {
  for (let i = 0; i < 8; i++) {
    if (CW[i]![0] === dx && CW[i]![1] === dy) return i;
  }
  return 6; // west fallback (start backtrack may be out of bounds → (-1,0))
}

/** Signed polygon area (shoelace). */
function shoelace(points: readonly Point[]): number {
  let sum = 0;
  for (let i = 0; i < points.length; i++) {
    const a = points[i]!;
    const b = points[(i + 1) % points.length]!;
    sum += a.x * b.y - b.x * a.y;
  }
  return sum / 2;
}

/** Douglas–Peucker simplification of a closed ring. */
function simplify(points: readonly Point[], tolerance: number): Point[] {
  if (points.length < 4) return [...points];
  // Treat as closed: anchor on the point farthest from the first, simplify each half.
  let i1 = 0;
  let maxD = -1;
  for (let i = 1; i < points.length; i++) {
    const d = dist2(points[0]!, points[i]!);
    if (d > maxD) {
      maxD = d;
      i1 = i;
    }
  }
  const first = dpSegment(points, 0, i1, tolerance);
  const second = dpSegment(points, i1, points.length - 1, tolerance);
  // Stitch: first..i1 then i1..end; drop the duplicated joint vertex.
  return [...first.slice(0, -1), ...second];
}

function dpSegment(
  points: readonly Point[],
  start: number,
  end: number,
  tolerance: number,
): Point[] {
  let maxD = -1;
  let idx = -1;
  for (let i = start + 1; i < end; i++) {
    const d = perpDistance(points[i]!, points[start]!, points[end]!);
    if (d > maxD) {
      maxD = d;
      idx = i;
    }
  }
  if (maxD > tolerance && idx !== -1) {
    const left = dpSegment(points, start, idx, tolerance);
    const right = dpSegment(points, idx, end, tolerance);
    return [...left.slice(0, -1), ...right];
  }
  return [points[start]!, points[end]!];
}

function perpDistance(p: Point, a: Point, b: Point): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy);
  if (len === 0) return Math.hypot(p.x - a.x, p.y - a.y);
  return Math.abs((p.x - a.x) * dy - (p.y - a.y) * dx) / len;
}

function dist2(a: Point, b: Point): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return dx * dx + dy * dy;
}
