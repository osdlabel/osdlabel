import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  analyze,
  noiseBandFor,
  pairedBandPct,
  pairedStats,
  pooledSigma,
  verdictFor,
  GATE_K,
} from '../scripts/analyze.mjs';
import { regressionLines } from '../scripts/compare.mjs';
import { falsePositiveRate, subsetsOf } from '../scripts/calibrate.mjs';

// ── fixtures ───────────────────────────────────────────────────────────
// Result files mirror what scripts/run.mjs writes: one row per
// (scenario, rep), each phase carrying `reposition` / `setDecorations` stats.

const stat = (median, n = 100) => ({ n, median, p95: median * 1.5, mean: median, total: 0 });
const idle = { n: 0, median: 0, p95: 0, mean: 0, total: 0 };

function phase(name, reposition, setDecorations) {
  return {
    phase: name,
    reposition: stat(reposition),
    setDecorations: setDecorations === null ? idle : stat(setDecorations),
    windowMs: 2000,
    meanRafMs: 16.7,
    transformWrites: 0,
    transformHookOk: true,
    frames: 120,
  };
}

/** `{ pan, static, live, liveSet }` per rep, in µs. */
function rows(scenario, reps) {
  return reps.map((r, rep) => ({
    scenario,
    rep,
    hudMode: 'cell',
    spec: {},
    phases: {
      pan: phase('pan', r.pan, null),
      static: phase('static', r.static, null),
      live: phase('live', r.live, r.liveSet),
    },
  }));
}

const dirs = [];
function resultsDir(base, head, { headExtra = [] } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'osdlabel-bench-'));
  dirs.push(dir);
  const meta = {
    date: '2026-01-01T00:00:00.000Z',
    cpus: 4,
    cpuModel: 'test',
    totalMemGB: 8,
    chromium: 'test',
    headless: true,
    reps: base.length,
    frames: 120,
    scenarios: ['S2', ...headExtra.map((x) => x.scenario)],
    phases: ['pan', 'static', 'live'],
    traced: false,
    labels: ['base', 'head'],
    baseLabel: 'base',
    headLabel: 'head',
    hudMode: { base: 'cell', head: 'cell' },
    cellAnchorSupport: { base: true, head: true },
    transformHookOk: { base: true, head: true },
    crossOriginIsolated: { base: true, head: true },
    timerResolutionUs: { base: 5, head: 5 },
    builds: { base: '/base', head: '/head' },
    commits: { base: 'aaaaaaa', head: 'bbbbbbb' },
  };
  fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify(meta));
  fs.writeFileSync(path.join(dir, 'base.json'), JSON.stringify(rows('S2', base)));
  const headRows = [...rows('S2', head), ...headExtra.flatMap((x) => rows(x.scenario, x.reps))];
  fs.writeFileSync(path.join(dir, 'head.json'), JSON.stringify(headRows));
  return dir;
}

afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

const same = { pan: 400, static: 150, live: 120, liveSet: 500 };
const reps = (r, n = 3) => Array.from({ length: n }, () => ({ ...r }));

// ── verdictFor ─────────────────────────────────────────────────────────

describe('verdictFor', () => {
  it('treats a zero baseline against a measurable head as a regression', () => {
    const v = verdictFor({ median: 0, mean: 0 }, { median: 40, mean: 40 }, 5);
    expect(v.kind).toBe('regression');
    expect(v.delta).toBe(Infinity);
  });

  it('calls both sides under one timer quantum not resolvable', () => {
    const v = verdictFor({ median: 0, mean: 2 }, { median: 0, mean: 4 }, 5);
    expect(v.kind).toBe('not-resolvable');
  });

  it('needs a zero-baseline head to clear 5 quanta before calling it a regression', () => {
    expect(verdictFor({ median: 0, mean: 0 }, { median: 0, mean: 20 }, 5, 5).kind).toBe(
      'not-resolvable',
    );
    expect(verdictFor({ median: 0, mean: 0 }, { median: 25, mean: 25 }, 5, 5).kind).toBe(
      'regression',
    );
  });

  it('calls means within 5 quanta on every side not resolvable', () => {
    const v = verdictFor({ median: 20, mean: 20 }, { median: 20, mean: 24 }, 5, 5);
    expect(v.kind).toBe('not-resolvable');
  });

  it('still resolves a cell once one side clears 5 quanta', () => {
    const v = verdictFor({ median: 20, mean: 20 }, { median: 40, mean: 40 }, 5, 5);
    expect(v.kind).toBe('regression');
  });

  it('compares means when a median is within 20 timer quanta', () => {
    // Real S1 static cell from a base-vs-head run of identical library code:
    // the medians sit one 5 µs quantum apart (+20%), the means +3.5%.
    const v = verdictFor({ median: 25, mean: 29.54 }, { median: 30, mean: 30.58 }, 12.5, 5);
    expect(v.useMean).toBe(true);
    expect(v.kind).toBe('neutral');
  });

  it('compares medians once both are at least 20 quanta', () => {
    const v = verdictFor({ median: 100, mean: 300 }, { median: 101, mean: 100 }, 5, 5);
    expect(v.useMean).toBe(false);
    expect(v.kind).toBe('neutral');
  });

  it('scales the median threshold with a coarser clock', () => {
    // 100 µs medians clear 20 quanta at 5 µs, but not at a 10 µs clock (the
    // coarsest run.mjs accepts), where the threshold is 200 µs.
    const v = verdictFor({ median: 100, mean: 100 }, { median: 100, mean: 200 }, 5, 10);
    expect(v.useMean).toBe(true);
    expect(v.kind).toBe('regression');
  });

  it('is neutral inside the band and a regression outside it', () => {
    expect(verdictFor({ median: 100, mean: 100 }, { median: 104, mean: 104 }, 5).kind).toBe(
      'neutral',
    );
    expect(verdictFor({ median: 100, mean: 100 }, { median: 120, mean: 120 }, 5).kind).toBe(
      'regression',
    );
  });
});

// ── analyze ────────────────────────────────────────────────────────────

describe('analyze', () => {
  it('gates setDecorations in the live phase, not only _reposition', () => {
    const dir = resultsDir(reps(same), reps({ ...same, liveSet: 1000 }));
    const { comparison } = analyze({ inDir: dir });

    const setRow = comparison.rows.find((r) => r.phase === 'live' && r.metric === 'setDecorations');
    expect(setRow).toBeDefined();
    expect(setRow.verdict).toBe('regression');

    const repoRow = comparison.rows.find((r) => r.phase === 'live' && r.metric === 'reposition');
    expect(repoRow.verdict).toBe('neutral');
  });

  it('emits no setDecorations row for phases that never call it', () => {
    const { comparison } = analyze({ inDir: resultsDir(reps(same), reps(same)) });
    const metrics = comparison.rows.map((r) => `${r.phase}:${r.metric}`).sort();
    expect(metrics).toEqual([
      'live:reposition',
      'live:setDecorations',
      'pan:reposition',
      'static:reposition',
    ]);
    expect(comparison.rows.every((r) => r.verdict === 'neutral')).toBe(true);
  });

  it('identifies the row schema and gating rule', () => {
    const { comparison } = analyze({ inDir: resultsDir(reps(same), reps(same)) });
    expect(comparison.schemaVersion).toBe(2);
    expect(comparison.gate).toBe('paired-log-ratio');
    expect(comparison.gateK).toBe(GATE_K);
    expect(comparison.rows.every((r) => typeof r.noiseBandPct === 'number')).toBe(true);
    expect(comparison.rows.every((r) => r.paired === true && r.pairs === 3)).toBe(true);
  });

  it('writes a zero-baseline regression as deltaPct null', () => {
    const dir = resultsDir(reps({ ...same, static: 0 }), reps(same));
    const { comparison } = analyze({ inDir: dir });
    const row = comparison.rows.find((r) => r.phase === 'static' && r.metric === 'reposition');
    expect(row.verdict).toBe('regression');
    expect(row.deltaPct).toBeNull();
  });
});

// ── noise bands ────────────────────────────────────────────────────────

describe('noiseBandFor', () => {
  const m = (median, spread, meanSpread = spread) => ({ median, mean: median, spread, meanSpread });

  it('floors the band at 5%', () => {
    expect(noiseBandFor([[m(200, 1.01), m(200, 1.02)]]).band).toBe(5);
  });

  it('uses the spread of the means for cells whose verdict compares means', () => {
    // 50 µs medians are under 20 quanta, so the verdict compares means and
    // the band must come from the means' spread, not the medians'.
    const band = noiseBandFor([[m(50, 1.2, 1.3), m(50, 1.0, 1.02)]], 5).band;
    expect(band).toBeCloseTo(30);
  });

  it('ignores groups too small to resolve, which get no verdict either', () => {
    // S0-like: means of a few µs with a +90% spread must not set the band that
    // gates the resolvable scenarios.
    const tiny = { median: 0, mean: 4, spread: 1, meanSpread: 1.9 };
    const band = noiseBandFor(
      [
        [tiny, tiny],
        [m(500, 1.08), m(500, 1.02)],
      ],
      5,
    ).band;
    expect(band).toBeCloseTo(8);
  });

  it('uses the spread of the medians otherwise', () => {
    const band = noiseBandFor([[m(500, 1.08, 1.5), m(500, 1.02, 1.02)]], 5).band;
    expect(band).toBeCloseTo(8);
  });
});

describe('analyze noise bands', () => {
  const noisy = (r, set) => set.map((liveSet) => ({ ...r, liveSet }));

  it('one outlier rep does not move the verdict or widen the other columns (#198)', () => {
    // The old gate took the slowest rep over the median as the spread, so this
    // one rep set a ±40% band for every column. The paired gate's spread is an
    // SD, so the outlier does widen its own cell's band (column-level robustness
    // across scenarios is the next describe's concern), but the median ratio is
    // unmoved and no other column is touched.
    const dir = resultsDir(reps(same), noisy(same, [500, 700, 500]));
    const { comparison } = analyze({ inDir: dir });
    expect(comparison.noiseBandsPct.pan).toBe(5);
    const setRow = comparison.rows.find((r) => r.metric === 'setDecorations');
    expect(setRow.verdict).toBe('neutral');
    expect(setRow.deltaPct).toBe(0);
  });

  it('catches a regression in a quiet column that a global band would have hidden', () => {
    // +15% on pan with a 40% spread elsewhere: a single run-wide band would
    // call this neutral.
    const dir = resultsDir(reps(same), noisy({ ...same, pan: 460 }, [500, 700, 500]));
    const { comparison } = analyze({ inDir: dir });
    const panRow = comparison.rows.find((r) => r.phase === 'pan');
    expect(panRow.verdict).toBe('regression');
  });
});

describe('analyze inputs', () => {
  it('refuses a build with no result rows instead of producing an empty, passing comparison', () => {
    const dir = resultsDir([], reps(same));
    expect(() => analyze({ inDir: dir })).toThrow(/no results for build 'base'/);
  });

  it("marks a scenario that ran on only one build 'no data'", () => {
    const dir = resultsDir(reps(same), reps(same), {
      headExtra: [{ scenario: 'S3', reps: reps(same) }],
    });
    const { verdicts, comparison } = analyze({ inDir: dir });
    expect(verdicts.S3.overall).toBe('no data');
    expect(comparison.rows.some((r) => r.scenario === 'S3')).toBe(false);
    expect(verdicts.S2.overall).toBe('neutral');
  });
});

// ── regressionLines ────────────────────────────────────────────────────

describe('regressionLines', () => {
  it('reports a zero-baseline regression instead of throwing', () => {
    const dir = resultsDir(reps({ ...same, static: 0 }), reps(same));
    const { comparison } = analyze({ inDir: dir });
    const lines = regressionLines(comparison);
    expect(lines.some((l) => l.includes('S2 static reposition') && l.includes('from zero'))).toBe(
      true,
    );
  });

  it('names the metric of each regression row', () => {
    const dir = resultsDir(reps(same), reps({ ...same, liveSet: 1000 }));
    const lines = regressionLines(analyze({ inDir: dir }).comparison);
    expect(lines.some((l) => l.includes('S2 live setDecorations'))).toBe(true);
  });

  it('returns nothing when there is no regression', () => {
    expect(
      regressionLines(analyze({ inDir: resultsDir(reps(same), reps(same)) }).comparison),
    ).toEqual([]);
  });
});

// ── paired gate (#198) ─────────────────────────────────────────────────

/**
 * A results dir with several scenarios on both builds: `{ S2: { base, head }, … }`.
 * With `alternate`, rows carry the `seq` run.mjs writes when it reverses the
 * build order on odd reps.
 */
function matrixDir(cells, { alternate = false } = {}) {
  const scenarios = Object.keys(cells);
  const dir = resultsDir(cells[scenarios[0]].base, cells[scenarios[0]].head);
  const meta = JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8'));
  meta.scenarios = scenarios;
  meta.reps = cells[scenarios[0]].base.length;
  fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify(meta));
  for (const side of ['base', 'head']) {
    const all = scenarios.flatMap((s, si) =>
      rows(s, cells[s][side]).map((r) => {
        if (!alternate) return r;
        const pair = 2 * (r.rep * scenarios.length + si);
        const first = (r.rep % 2 === 0) === (side === 'base');
        return { ...r, seq: pair + (first ? 0 : 1) };
      }),
    );
    fs.writeFileSync(path.join(dir, `${side}.json`), JSON.stringify(all));
  }
  return dir;
}

/** Seven reps of `same`, with `pan` scaled per rep. */
const panReps = (factors, base = same) => factors.map((k) => ({ ...base, pan: base.pan * k }));

describe('pairedStats', () => {
  const metric = (rep, values) => ({ perRep: { rep, median: values, mean: values } });

  it('pairs by rep number, not by position', () => {
    const st = pairedStats(metric([0, 1, 2], [100, 200, 300]), metric([2, 0, 1], [330, 110, 220]));
    expect(st.n).toBe(3);
    expect(Math.exp(st.logMedian)).toBeCloseTo(1.1);
    expect(st.sigma).toBeCloseTo(0);
  });

  it('drops pairs where a side is zero, and gives up below the minimum', () => {
    expect(pairedStats(metric([0, 1, 2], [0, 100, 100]), metric([0, 1, 2], [10, 100, 100]))).toBe(
      null,
    );
  });

  it('corrects the spread for the centre it estimated', () => {
    // Log ratios +a, −a, 0 around a median of 0: two residuals of a over
    // 3 − 1 degrees of freedom, so the SD is exactly a.
    const st = pairedStats(
      metric([0, 1, 2], [100, 100, 100]),
      metric([0, 1, 2], [110, 100 / 1.1, 100]),
    );
    expect(st.sigma).toBeCloseTo(Math.log(1.1), 10);
  });

  it('measures the spread of the ratio, not of either build', () => {
    // Both builds swing ±30% rep to rep, together: the ratio does not move.
    const swing = [100, 130, 70, 100, 125, 75, 100];
    const st = pairedStats(
      metric([0, 1, 2, 3, 4, 5, 6], swing),
      metric(
        [0, 1, 2, 3, 4, 5, 6],
        swing.map((v) => v * 1.15),
      ),
    );
    expect(Math.exp(st.logMedian)).toBeCloseTo(1.15);
    expect(st.sigma).toBeCloseTo(0);
  });
});

describe('pairedBandPct and pooledSigma', () => {
  it('floors at 5% and widens with spread, narrows with reps', () => {
    const se = (n) => 1.2533 / Math.sqrt(n);
    expect(pairedBandPct(0, se(7))).toBe(5);
    expect(pairedBandPct(0.2, se(7))).toBeGreaterThan(pairedBandPct(0.1, se(7)));
    expect(pairedBandPct(0.2, se(21))).toBeLessThan(pairedBandPct(0.2, se(7)));
  });

  it('is GATE_K = 3 standard errors on the log scale', () => {
    // Pinned exactly: changing GATE_K or the band's form needs re-calibrating
    // (README, "Noise and the gate"), so it should not happen silently.
    const se = 1.2533 / Math.sqrt(7);
    expect(GATE_K).toBe(3);
    expect(pairedBandPct(0.05, se)).toBeCloseTo((Math.exp(3 * se * 0.05) - 1) * 100, 10);
  });

  it("pools by the median, so one cell's spread does not set the column's", () => {
    expect(pooledSigma([{ sigma: 0.02 }, { sigma: 0.03 }, { sigma: 0.5 }])).toBe(0.03);
  });
});

describe('analyze with the paired gate (#198)', () => {
  const quiet = [1, 1.01, 0.99, 1, 1.02, 0.98, 1];

  it('one slow rep in one scenario does not widen the band for the column', () => {
    const dir = matrixDir({
      S1: { base: panReps(quiet), head: panReps(quiet) },
      S2: { base: panReps(quiet), head: panReps([1, 1.01, 0.99, 1.6, 1.02, 0.98, 1]) },
      S3: { base: panReps(quiet), head: panReps(quiet) },
    });
    const { comparison } = analyze({ inDir: dir });
    expect(comparison.noiseBandsPct.pan).toBe(5);
    const pan = comparison.rows.filter((r) => r.phase === 'pan');
    expect(pan.every((r) => r.verdict === 'neutral')).toBe(true);
  });

  it('a quiet column of identical code stays neutral when the builds jitter independently', () => {
    // Each build is quiet on its own (±2%), but they jitter apart: the
    // difference carries both, which the old within-build band ignored.
    const dir = matrixDir({
      S1: {
        base: panReps([1, 1.02, 0.98, 1, 1.02, 0.98, 1]),
        head: panReps([1.02, 0.98, 1, 0.98, 1, 1.02, 0.98]),
      },
      S2: {
        base: panReps([0.98, 1, 1.02, 0.98, 1, 1.02, 1]),
        head: panReps([1, 1.02, 0.98, 1.02, 0.98, 1, 1.02]),
      },
    });
    const { comparison } = analyze({ inDir: dir });
    const pan = comparison.rows.filter((r) => r.phase === 'pan');
    expect(pan.every((r) => r.verdict === 'neutral')).toBe(true);
  });

  it('still catches +15% under machine drift both builds share', () => {
    // Every rep runs ±25% fast or slow for both builds; the head is 15% slower
    // in each. The old gate's within-build band (>25%) would call it neutral.
    const drift = [1, 1.25, 0.75, 1.1, 0.9, 1.2, 0.8];
    const dir = matrixDir({
      S1: { base: panReps(drift), head: panReps(drift.map((k) => k * 1.15)) },
      S2: { base: panReps(drift), head: panReps(drift) },
    });
    const { comparison } = analyze({ inDir: dir });
    const s1 = comparison.rows.find((r) => r.scenario === 'S1' && r.phase === 'pan');
    expect(s1.verdict).toBe('regression');
    expect(s1.deltaPct).toBeCloseTo(15);
    const s2 = comparison.rows.find((r) => r.scenario === 'S2' && r.phase === 'pan');
    expect(s2.verdict).toBe('neutral');
  });

  it('judges a noisy cell at its own spread, not the quiet column pooled band', () => {
    const noisyRatio = [1, 1.3, 0.8, 1.25, 0.85, 1.2, 1.12];
    const dir = matrixDir({
      S1: { base: panReps(quiet), head: panReps(quiet) },
      S2: { base: panReps(quiet), head: panReps(quiet) },
      S3: { base: panReps(quiet), head: panReps(noisyRatio) },
    });
    const { comparison } = analyze({ inDir: dir });
    const s3 = comparison.rows.find((r) => r.scenario === 'S3' && r.phase === 'pan');
    expect(s3.noiseBandPct).toBeGreaterThan(comparison.noiseBandsPct.pan);
    expect(s3.verdict).toBe('neutral');
  });

  it('falls back to the aggregate ratio with fewer than three paired reps', () => {
    const dir = matrixDir({
      S1: {
        base: panReps([1, 1]),
        head: panReps([1.3, 1.3]),
      },
    });
    const { comparison } = analyze({ inDir: dir });
    const row = comparison.rows.find((r) => r.phase === 'pan');
    expect(row.paired).toBe(false);
    expect(row.verdict).toBe('regression');
  });

  it('judges an unpaired cell against the within-build band, not the empty pooled one', () => {
    // Each build swings 40% between its two reps; the aggregate moves ~8%.
    const dir = matrixDir({ S1: { base: panReps([1, 1.4]), head: panReps([1.1, 1.5]) } });
    const { comparison } = analyze({ inDir: dir });
    const row = comparison.rows.find((r) => r.phase === 'pan');
    expect(row.paired).toBe(false);
    expect(row.noiseBandPct).toBeGreaterThan(row.deltaPct);
    expect(comparison.noiseBandsPct.pan).toBe(row.noiseBandPct);
    expect(row.verdict).toBe('neutral');
  });

  it('calls a change exactly on the ±5% floor neutral, in both directions', () => {
    // exp(log(1.05)) − 1 is 5.000000000000004%, a hair over the floor: a
    // quantized 400 → 420 µs cell must not read as a regression for it.
    const steady = [1, 1, 1, 1, 1, 1, 1];
    for (const factor of [1.05, 0.95]) {
      const dir = matrixDir({
        S1: { base: panReps(steady), head: panReps(steady.map(() => factor)) },
      });
      const row = analyze({ inDir: dir }).comparison.rows.find((r) => r.phase === 'pan');
      expect(row.noiseBandPct).toBe(5);
      expect(Math.abs(row.deltaPct)).toBeCloseTo(5, 9);
      expect(row.verdict).toBe('neutral');
    }
  });

  it("holds a cell with too few distinct values to its column's spread", () => {
    // S4's pairs happen to agree exactly (own spread 0), but the column's
    // other cells say a 7% move is within the noise.
    const jitter = [1, 1.08, 0.92, 1, 1.08, 0.92, 1];
    const dir = matrixDir({
      S1: { base: panReps(quiet), head: panReps(jitter) },
      S2: { base: panReps(quiet), head: panReps(jitter) },
      S3: { base: panReps(quiet), head: panReps(jitter) },
      S4: { base: panReps(quiet), head: panReps(quiet.map((k) => k * 1.07)) },
    });
    const { comparison } = analyze({ inDir: dir });
    const s4 = comparison.rows.find((r) => r.scenario === 'S4' && r.phase === 'pan');
    expect(s4.deltaPct).toBeCloseTo(7, 5);
    expect(s4.noiseBandPct).toBeGreaterThan(7);
    expect(s4.verdict).toBe('neutral');
  });
});

describe('order balancing (#198)', () => {
  // Whichever build runs second in its pair reads 6% fast: a pure order effect.
  const second = 0.94;
  const reps7 = [0, 1, 2, 3, 4, 5, 6];
  /** Per-rep pan factors for one side, given the true head effect. */
  const sides = (effect) => ({
    base: panReps(reps7.map((rep) => (rep % 2 === 0 ? 1 : second))),
    head: panReps(reps7.map((rep) => effect * (rep % 2 === 0 ? second : 1))),
  });

  it('cancels an order bias in an A/A run once the order alternates', () => {
    const dir = matrixDir({ S1: sides(1), S2: sides(1) }, { alternate: true });
    const { comparison } = analyze({ inDir: dir });
    const pan = comparison.rows.filter((r) => r.phase === 'pan');
    expect(pan.every((r) => r.verdict === 'neutral')).toBe(true);
    for (const r of pan) expect(Math.abs(r.deltaPct)).toBeLessThan(0.5);
  });

  it('measures a real +15% through the same bias', () => {
    const dir = matrixDir({ S1: sides(1.15), S2: sides(1) }, { alternate: true });
    const { comparison } = analyze({ inDir: dir });
    const s1 = comparison.rows.find((r) => r.scenario === 'S1' && r.phase === 'pan');
    expect(s1.verdict).toBe('regression');
    expect(s1.deltaPct).toBeCloseTo(15, 0);
  });

  it('reads the order from seq, and without it treats every pair as base-first', () => {
    const metric = (values, seq) => ({
      perRep: { rep: [0, 1, 2, 3, 4], seq, median: values, mean: values },
    });
    // Three base-first pairs and two head-first ones; the second slot reads
    // 6% fast. The plain median of all five ratios is 0.94.
    const base = [100, 94, 100, 94, 100];
    const head = [94, 100, 94, 100, 94];
    const balanced = pairedStats(
      metric(base, [0, 3, 4, 7, 8]),
      metric(head, [1, 2, 5, 6, 9]),
      false,
    );
    expect(Math.exp(balanced.logMedian)).toBeCloseTo(1, 5);
    // The SE of the mean of two group medians, of sizes 3 and 2.
    expect(balanced.seFactor).toBeCloseTo((1.2533 / 2) * Math.sqrt(1 / 3 + 1 / 2));
    const unordered = pairedStats(metric(base, undefined), metric(head, undefined), false);
    expect(Math.exp(unordered.logMedian)).toBeCloseTo(0.94, 5);
    expect(unordered.seFactor).toBeCloseTo(1.2533 / Math.sqrt(5));
  });
});

describe('calibration helpers', () => {
  it('resamples reps as pairs, so drift both builds share still cancels', () => {
    const drift = [1, 1.25, 0.75, 1.1, 0.9, 1.2, 0.8];
    const dir = matrixDir({ S1: { base: panReps(drift), head: panReps(drift) } });
    const { comparison } = analyze({
      inDir: dir,
      resample: [1, 1, 2, 6, 6, 0, 3],
      write: false,
    });
    const row = comparison.rows.find((r) => r.phase === 'pan');
    expect(row.pairs).toBe(7);
    expect(row.deltaPct).toBeCloseTo(0);
    expect(row.verdict).toBe('neutral');
  });

  it('does not write result files when asked not to', () => {
    const dir = resultsDir(reps(same), reps(same));
    analyze({ inDir: dir, write: false });
    expect(fs.existsSync(path.join(dir, 'comparison.json'))).toBe(false);
  });

  it('reports no false positives for an A/A run with shared drift only', () => {
    const drift = [1, 1.25, 0.75, 1.1, 0.9, 1.2, 0.8];
    const dir = matrixDir({ S1: { base: panReps(drift), head: panReps(drift) } });
    expect(falsePositiveRate(dir, GATE_K, 5)).toEqual({ rate: 0, runs: 21 });
  });

  it('enumerates subsets without replacement', () => {
    expect(subsetsOf([0, 1, 2, 3], 2)).toEqual([
      [0, 1],
      [0, 2],
      [0, 3],
      [1, 2],
      [1, 3],
      [2, 3],
    ]);
    expect(subsetsOf([0, 1, 2, 3, 4, 5, 6], 5)).toHaveLength(21);
  });
});
