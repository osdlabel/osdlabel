import type { Ring, Vec2 } from './ring.js';

function segmentDistanceSq(p: Vec2, a: Vec2, b: Vec2): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = dx * dx + dy * dy;
  let t = len === 0 ? 0 : ((p.x - a.x) * dx + (p.y - a.y) * dy) / len;
  t = Math.max(0, Math.min(1, t));
  const x = a.x + t * dx - p.x;
  const y = a.y + t * dy - p.y;
  return x * x + y * y;
}

/** Iterative Douglas–Peucker over the open chain points[first..last]; marks kept vertices. */
function douglasPeucker(
  points: Ring,
  first: number,
  last: number,
  tolSq: number,
  keep: Uint8Array,
): void {
  const stack: number[] = [first, last];
  while (stack.length > 0) {
    const hi = stack.pop()!;
    const lo = stack.pop()!;
    let maxD = -1;
    let idx = -1;
    for (let i = lo + 1; i < hi; i++) {
      const d = segmentDistanceSq(points[i]!, points[lo]!, points[hi]!);
      if (d > maxD) {
        maxD = d;
        idx = i;
      }
    }
    if (idx !== -1 && maxD > tolSq) {
      keep[idx] = 1;
      stack.push(lo, idx, idx, hi);
    }
  }
}

/**
 * Douglas–Peucker for a closed ring: no vertex of the input lies farther than
 * `tolerance` from the output. The ring is split at its first vertex and the
 * vertex farthest from it, so the result does not depend on where tracing
 * happened to start. Rings that would collapse below 3 vertices are kept as
 * their 3 most significant vertices rather than dropped.
 */
export function simplifyRing(ring: Ring, tolerance: number): Vec2[] {
  const n = ring.length;
  if (n <= 3 || tolerance <= 0) return ring.slice();
  const a = ring[0]!;
  let far = 1;
  let farD = -1;
  for (let i = 1; i < n; i++) {
    const dx = ring[i]!.x - a.x;
    const dy = ring[i]!.y - a.y;
    const d = dx * dx + dy * dy;
    if (d > farD) {
      farD = d;
      far = i;
    }
  }
  // Closed chain: 0..far and far..n (n wraps to 0).
  const chain: Vec2[] = [...ring, a];
  const keep = new Uint8Array(n + 1);
  keep[0] = 1;
  keep[far] = 1;
  keep[n] = 1;
  const tolSq = tolerance * tolerance;
  douglasPeucker(chain, 0, far, tolSq, keep);
  douglasPeucker(chain, far, n, tolSq, keep);
  const out: Vec2[] = [];
  for (let i = 0; i < n; i++) if (keep[i]) out.push(ring[i]!);
  if (out.length < 3) {
    // Degenerate (a sliver): keep the vertex farthest from the chord as well.
    let best = -1;
    let bestD = -1;
    for (let i = 1; i < n; i++) {
      if (i === far) continue;
      const d = segmentDistanceSq(ring[i]!, a, ring[far]!);
      if (d > bestD) {
        bestD = d;
        best = i;
      }
    }
    return [a, ...(best < far ? [ring[best]!, ring[far]!] : [ring[far]!, ring[best]!])];
  }
  return out;
}
