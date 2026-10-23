export interface Stats {
  readonly n: number;
  readonly median: number;
  readonly min: number;
  readonly max: number;
  readonly p90: number;
  readonly samples: readonly number[];
}

export function stats(samples: readonly number[]): Stats {
  const s = [...samples].sort((a, b) => a - b);
  const q = (p: number): number => {
    if (s.length === 0) return NaN;
    const i = (s.length - 1) * p;
    const lo = Math.floor(i);
    const hi = Math.ceil(i);
    return s[lo]! + (s[hi]! - s[lo]!) * (i - lo);
  };
  const r = (x: number): number => Math.round(x * 100) / 100;
  return {
    n: s.length,
    median: r(q(0.5)),
    min: r(s[0] ?? NaN),
    max: r(s[s.length - 1] ?? NaN),
    p90: r(q(0.9)),
    samples: samples.map(r),
  };
}

export async function timeIt<T>(fn: () => Promise<T>): Promise<[T, number]> {
  const t0 = performance.now();
  const v = await fn();
  return [v, performance.now() - t0];
}
