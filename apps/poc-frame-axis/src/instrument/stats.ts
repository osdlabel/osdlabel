/** Small, dependency-free summary statistics for the harness. Pure. */

export interface Summary {
  readonly n: number;
  readonly mean: number;
  readonly p50: number;
  readonly p95: number;
  readonly p99: number;
  readonly max: number;
  readonly min: number;
}

/** Linear-interpolated percentile of an ascending-sorted array. */
export function percentileSorted(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return Number.NaN;
  const pos = (sorted.length - 1) * p;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  const a = sorted[lo] ?? Number.NaN;
  const b = sorted[hi] ?? Number.NaN;
  return a + (b - a) * (pos - lo);
}

export function summarize(values: readonly number[]): Summary {
  const sorted = [...values].sort((a, b) => a - b);
  const n = sorted.length;
  const mean = n === 0 ? Number.NaN : sorted.reduce((s, v) => s + v, 0) / n;
  return {
    n,
    mean,
    p50: percentileSorted(sorted, 0.5),
    p95: percentileSorted(sorted, 0.95),
    p99: percentileSorted(sorted, 0.99),
    max: n === 0 ? Number.NaN : (sorted[n - 1] ?? Number.NaN),
    min: n === 0 ? Number.NaN : (sorted[0] ?? Number.NaN),
  };
}

/** Round every number in a JSON-able value to `digits` decimals (for compact results). */
export function roundDeep<T>(value: T, digits = 3): T {
  const f = 10 ** digits;
  const walk = (v: unknown): unknown => {
    if (typeof v === 'number') return Number.isFinite(v) ? Math.round(v * f) / f : v;
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') {
      return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]));
    }
    return v;
  };
  return walk(value) as T;
}
