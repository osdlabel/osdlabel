/**
 * Aggregates the Solid group's repetitions: per configuration and pass,
 * median and range (min-max) of each metric over the repetitions.
 */

/** Passes recorded per repetition, in order. */
export const SOLID_PASSES = ['cold', 'revisit', 'window'];

const METRICS = {
  fps: (p) => p?.displayFps,
  slicesPerSec: (p) => p?.shownSlicesPerSec,
  incoherent: (p) => p?.incoherentFrames,
  blank: (p) => p?.blankFrames,
  syncMsP95: (p) => p?.applyMs?.p95,
  heapMB: (p) => p?.jsHeapMB,
};

const round = (x, d = 1) => (x === undefined || x === null ? null : Number(x.toFixed(d)));

/** { median, min, max, n } of the finite values in `xs`, or null. */
export function spread(xs, digits = 1) {
  const v = xs.filter((x) => typeof x === 'number' && Number.isFinite(x)).sort((a, b) => a - b);
  if (v.length === 0) return null;
  const m = v.length >> 1;
  const median = v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
  return {
    median: round(median, digits),
    min: round(v[0], digits),
    max: round(v[v.length - 1], digits),
    n: v.length,
  };
}

/** One row per configuration: per pass and metric, the spread over its repetitions. */
export function aggregateSolid(runs) {
  const byName = new Map();
  for (const r of runs) {
    if (!byName.has(r.name)) byName.set(r.name, []);
    byName.get(r.name).push(r);
  }
  return [...byName].map(([name, reps]) => {
    const ok = reps.filter((r) => !r.error);
    const passes = {};
    for (const pass of SOLID_PASSES) {
      const vals = ok.map((r) => r.passes?.[pass]).filter(Boolean);
      if (vals.length === 0) continue;
      passes[pass] = Object.fromEntries(
        Object.entries(METRICS).map(([k, f]) => [
          k,
          spread(vals.map(f), k === 'syncMsP95' ? 2 : 1),
        ]),
      );
      passes[pass].framesVisited = vals[0]?.framesVisited;
      passes[pass].window = vals[0]?.window;
    }
    const first = ok[0];
    return {
      name,
      opts: reps[0]?.opts,
      reps: reps.length,
      errors: reps.filter((r) => r.error).map((r) => r.error),
      setup: first?.setup,
      passes,
      editAddMsP50: spread(
        ok.map((r) => r.edit?.addMs?.p50),
        2,
      ),
      editDeleteMsP50: spread(
        ok.map((r) => r.edit?.deleteMs?.p50),
        2,
      ),
      memDeltaMB: spread(
        ok.map((r) => r.memory?.deltaMB),
        0,
      ),
      viewKept: ok.every(
        (r) =>
          r.viewAfter &&
          r.viewBefore &&
          r.viewAfter.rotation === r.viewBefore.rotation &&
          Math.abs(r.viewAfter.zoomOverHome - r.viewBefore.zoomOverHome) < 0.01,
      ),
      viewBefore: first?.viewBefore,
      viewAfter: first?.viewAfter,
      realWheel: first?.realWheel && {
        fps: round(first.realWheel.displayFps),
        slicesPerSec: round(first.realWheel.shownSlicesPerSec),
        events: first.realWheel.wheelEventsSent,
        incoherent: first.realWheel.incoherentFrames,
      },
      loadAvg: [
        Math.min(...reps.map((r) => r.loadAvgBefore?.[0] ?? Infinity)),
        Math.max(...reps.map((r) => r.loadAvgAfter?.[0] ?? r.loadAvgBefore?.[0] ?? -Infinity)),
      ],
    };
  });
}

/** `median (min-max)` for a table cell. */
export function fmtSpread(s) {
  if (!s) return '-';
  return s.min === s.max ? `${s.median}` : `${s.median} (${s.min}-${s.max})`;
}
