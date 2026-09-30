import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { analyze, noiseBandFor, verdictFor } from '../scripts/analyze.mjs';
import { regressionLines } from '../scripts/compare.mjs';

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

  it('scopes the band per (phase, metric): a noisy setDecorations does not widen _reposition', () => {
    const dir = resultsDir(reps(same), noisy(same, [500, 700, 500]));
    const { comparison } = analyze({ inDir: dir });
    expect(comparison.noiseBandsPct['live:setDecorations']).toBeCloseTo(40);
    expect(comparison.noiseBandsPct.pan).toBe(5);
    const panRow = comparison.rows.find((r) => r.phase === 'pan');
    expect(panRow.noiseBandPct).toBe(5);
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
