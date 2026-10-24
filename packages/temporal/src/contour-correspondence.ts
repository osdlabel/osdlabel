import type { Point } from '@osdlabel/annotation';

/**
 * Vertex correspondence between two contours (polygon or polyline keyframes),
 * computed once per keyframe pair and reused for every frame between them.
 *
 * `from` and `to` have the same length; vertex `i` of `from` moves to vertex
 * `i` of `to`. Both reproduce their keyframe's shape exactly (every original
 * vertex is kept; extra vertices only ever sit on existing edges), so the
 * interpolation starts and ends on the drawn shapes.
 */
export interface Correspondence {
  readonly from: readonly Point[];
  readonly to: readonly Point[];
  /** How it was built, for diagnostics and tests. */
  readonly method: 'index' | 'arc-length';
}

/** Samples used to find the best cyclic shift / orientation. */
const ALIGN_SAMPLES = 64;
const PARAM_EPS = 1e-9;

export function signedArea(points: readonly Point[]): number {
  let s = 0;
  for (let i = 0, n = points.length; i < n; i++) {
    const a = points[i]!;
    const b = points[(i + 1) % n]!;
    s += a.x * b.y - b.x * a.y;
  }
  return s / 2;
}

/** Cumulative arc length at each vertex, normalised to [0, 1). Last entry is the total. */
function arcParams(points: readonly Point[], closed: boolean): { params: number[]; total: number } {
  const n = points.length;
  const params: number[] = new Array<number>(n);
  let acc = 0;
  params[0] = 0;
  for (let i = 1; i < n; i++) {
    const a = points[i - 1]!;
    const b = points[i]!;
    acc += Math.hypot(b.x - a.x, b.y - a.y);
    params[i] = acc;
  }
  if (closed) {
    const a = points[n - 1]!;
    const b = points[0]!;
    acc += Math.hypot(b.x - a.x, b.y - a.y);
  }
  const total = acc;
  if (total > 0) for (let i = 0; i < n; i++) params[i] = params[i]! / total;
  else for (let i = 0; i < n; i++) params[i] = closed ? i / n : n === 1 ? 0 : i / (n - 1);
  return { params, total };
}

/** Point at normalised arc parameter `u` (wrapped for closed contours). */
function pointAt(
  points: readonly Point[],
  params: readonly number[],
  closed: boolean,
  u: number,
): Point {
  const n = points.length;
  if (n === 1) return points[0]!;
  if (closed) u = ((u % 1) + 1) % 1;
  else u = Math.min(1, Math.max(0, u));
  // last segment index whose start param <= u
  let lo = 0;
  let hi = n - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (params[mid]! <= u) lo = mid;
    else hi = mid - 1;
  }
  const i = lo;
  const a = points[i]!;
  if (!closed && i === n - 1) return a;
  const b = points[(i + 1) % n]!;
  const u0 = params[i]!;
  const u1 = i + 1 < n ? params[i + 1]! : 1;
  const span = u1 - u0;
  const t = span > 0 ? (u - u0) / span : 0;
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
}

function uniformSamples(
  points: readonly Point[],
  params: readonly number[],
  closed: boolean,
  m: number,
): Point[] {
  const out: Point[] = new Array<Point>(m);
  for (let k = 0; k < m; k++)
    out[k] = pointAt(points, params, closed, closed ? k / m : k / (m - 1));
  return out;
}

function ssd(a: readonly Point[], b: readonly Point[], shift: number): number {
  const m = a.length;
  let s = 0;
  for (let k = 0; k < m; k++) {
    const p = a[k]!;
    const q = b[(k + shift) % m]!;
    const dx = p.x - q.x;
    const dy = p.y - q.y;
    s += dx * dx + dy * dy;
  }
  return s;
}

function reversed(points: readonly Point[], closed: boolean): Point[] {
  // For a closed contour keep vertex 0 first so "reverse" changes only winding.
  if (!closed) return [...points].reverse();
  const out: Point[] = [points[0]!];
  for (let i = points.length - 1; i > 0; i--) out.push(points[i]!);
  return out;
}

/**
 * Merge two sorted parameter lists, dropping near-duplicates. Each original
 * vertex of either contour becomes a sample, so both shapes are exact.
 */
function unionParams(a: readonly number[], b: readonly number[]): number[] {
  const out: number[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    const v = j >= b.length || (i < a.length && a[i]! <= b[j]!) ? a[i++]! : b[j++]!;
    if (out.length === 0 || v - out[out.length - 1]! > PARAM_EPS) out.push(v);
  }
  return out;
}

/**
 * Correspondence between two polygon keyframes.
 *
 * 1. Same vertex count and the best cyclic alignment is the identity: the
 *    annotator edited the same polygon, so vertex `i` stays vertex `i`.
 * 2. Otherwise (a redraw, a different start vertex, a different winding, or
 *    a different count): normalise winding, find the cyclic offset that
 *    minimises squared distance over arc-length samples, then sample both at
 *    the union of their vertices' arc-length parameters.
 *
 * Naive index-wise interpolation of a redrawn polygon can fold it through
 * itself; see the unit tests for the area it loses.
 */
export function polygonCorrespondence(a: readonly Point[], b: readonly Point[]): Correspondence {
  return contourCorrespondence(a, b, true);
}

/** Polylines: the same, without cyclic shifts; orientation may flip end for end. */
export function polylineCorrespondence(a: readonly Point[], b: readonly Point[]): Correspondence {
  return contourCorrespondence(a, b, false);
}

function contourCorrespondence(
  a: readonly Point[],
  b: readonly Point[],
  closed: boolean,
): Correspondence {
  if (a.length === 0 || b.length === 0) throw new Error('cannot interpolate an empty contour');
  const pa = arcParams(a, closed);

  // Orientation: closed contours by winding sign, open ones by end-to-end fit.
  let bb: readonly Point[] = b;
  if (closed) {
    if (Math.sign(signedArea(a)) !== Math.sign(signedArea(b)) && signedArea(b) !== 0)
      bb = reversed(b, true);
  } else {
    const sa = uniformSamples(a, pa.params, false, ALIGN_SAMPLES);
    const pf = arcParams(b, false);
    const rb = reversed(b, false);
    const pr = arcParams(rb, false);
    const fwd = ssd(sa, uniformSamples(b, pf.params, false, ALIGN_SAMPLES), 0);
    const rev = ssd(sa, uniformSamples(rb, pr.params, false, ALIGN_SAMPLES), 0);
    if (rev < fwd) bb = rb;
  }

  // Fast path: same count, same orientation, identity alignment.
  if (a.length === bb.length) {
    if (!closed && bb === b) return { from: a, to: b, method: 'index' };
    if (closed) {
      const n = a.length;
      const base = ssd(a, bb, 0);
      let best = base;
      for (let s = 1; s < n; s++) best = Math.min(best, ssd(a, bb, s));
      if (base <= best && bb === b) return { from: a, to: b, method: 'index' };
    }
  }

  const pb = arcParams(bb, closed);
  let offset = 0;
  if (closed) {
    const sa = uniformSamples(a, pa.params, true, ALIGN_SAMPLES);
    const sb = uniformSamples(bb, pb.params, true, ALIGN_SAMPLES);
    let best = Infinity;
    let bestShift = 0;
    for (let s = 0; s < ALIGN_SAMPLES; s++) {
      const v = ssd(sa, sb, s);
      if (v < best) {
        best = v;
        bestShift = s;
      }
    }
    offset = bestShift / ALIGN_SAMPLES;
  }

  // b's parameters re-expressed in a's frame: b(u + offset) matches a(u).
  const bInA = pb.params.map((u) => (((u - offset) % 1) + 1) % 1).sort((x, y) => x - y);
  const params = unionParams(pa.params, bInA);
  const from = params.map((u) => pointAt(a, pa.params, closed, u));
  const to = params.map((u) => pointAt(bb, pb.params, closed, u + offset));
  return { from, to, method: 'arc-length' };
}
