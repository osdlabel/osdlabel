/**
 * Aggregates a results directory (meta.json + one <label>.json per build, plus
 * any trace-*.json) into summary.md, verdicts.json and comparison.json.
 *
 *   node scripts/analyze.mjs [--in <results dir>] [--compare <older results dir>]
 *
 * With two builds in the run, the base build is meta.baseLabel and the head
 * build is meta.headLabel; with one build the tables degrade to single-column
 * and no verdicts are produced (there is nothing to compare against).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const PHASE_LABEL = { pan: 'P1 pan', static: 'P2 static', live: 'P3 live' };

/** Human labels for the scenario matrix in src/bench.js. */
export const SCENARIO_LABEL = {
  S0: 'N=0',
  S1: 'N=10 text',
  S2: 'N=100 text',
  S3: 'N=500 text',
  S4: 'N=100 text + 100 DOM',
  S5: 'N=100 text + 1 HUD',
  S6: 'N=100 text + 4 HUD',
  S7: 'N=500 text + 1 HUD',
};

const med = (a) => {
  const s = [...a].sort((x, y) => x - y);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};
const p95of = (a) => {
  const s = [...a].sort((x, y) => x - y);
  return s[Math.min(s.length - 1, Math.floor(0.95 * s.length))];
};
// A zero baseline against a measurable head is an unbounded regression, not
// 0% — returning 0 here would let `--fail-on-regression` wave through a cell
// that went from unmeasurable to measurable.
const pct = (a, b) => (a === 0 ? (b === 0 ? 0 : Infinity) : ((b - a) / a) * 100);
const f = (n, d = 1) => (Number.isFinite(n) ? n.toFixed(d) : '—');
const sign = (n) => (n >= 0 ? '+' : '');
/** A signed percentage for the tables; a zero-baseline delta reads `+∞`. */
const signedPct = (n) => (n === Infinity ? '+∞' : Number.isFinite(n) ? sign(n) + f(n) : '—');
/** p95 / median of per-rep values, the run-to-run spread; 1 when unmeasurable. */
const spreadOf = (a) => (med(a) > 0 ? p95of(a) / med(a) : 1);

/**
 * The timed methods a verdict can be computed for. `_reposition` runs in every
 * phase; `setDecorations` only where the phase calls it (P3 live), and there
 * its timing includes the DOM diff as well as the `_reposition` it triggers.
 */
export const METRICS = ['reposition', 'setDecorations'];
export const METRIC_LABEL = { reposition: '_reposition', setDecorations: 'setDecorations' };

/** Aggregate one timed method across the repetitions of a (scenario, phase). */
function metricOf(runs, phase, metric) {
  const perRepMedian = runs.map((r) => r.phases[phase][metric].median);
  const perRepMean = runs.map((r) => r.phases[phase][metric].mean);
  return {
    median: med(perRepMedian),
    mean: med(perRepMean),
    p95: med(runs.map((r) => r.phases[phase][metric].p95)),
    // run-to-run spread of the per-rep medians, and of the per-rep means for
    // the cells whose verdict compares means (see usesMean)
    spread: spreadOf(perRepMedian),
    meanSpread: spreadOf(perRepMean),
    calls: Math.round(med(runs.map((r) => r.phases[phase][metric].n))),
    // Raw per-rep values in run order, which the paired gate (#198) matches
    // up across builds by rep.
    perRep: {
      rep: runs.map((r) => r.rep),
      // Interleave position, which tells which build of a pair ran first.
      seq: runs.map((r) => r.seq),
      median: perRepMedian,
      mean: perRepMean,
    },
  };
}

function cellOf(rows, scenario, phase) {
  const runs = rows.filter((r) => r.scenario === scenario && r.phases[phase]);
  if (runs.length === 0) return null;
  const repo = metricOf(runs, phase, 'reposition');
  const setDecorations = metricOf(runs, phase, 'setDecorations');
  return {
    ...repo,
    setDeco: setDecorations.median,
    metrics: { reposition: repo, setDecorations },
    writes: Math.round(med(runs.map((r) => r.phases[phase].transformWrites))),
    raf: med(runs.map((r) => r.phases[phase].meanRafMs)),
    windowMs: med(runs.map((r) => r.phases[phase].windowMs)),
  };
}

/** The metrics both sides of a (scenario, phase) actually called. */
function gatedMetrics(baseCell, headCell) {
  return METRICS.filter((m) => baseCell.metrics[m].calls > 0 && headCell.metrics[m].calls > 0);
}

/**
 * A median within this many timer quanta is too coarse to compare: one quantum
 * step is then at least 1/20 = 5% of it, the noise band's floor, so identical
 * code can read as a ±5–20% change purely from where the samples round.
 */
export const MEDIAN_MIN_QUANTA = 20;

/**
 * A cell whose compared means are all within this many timer quanta cannot
 * carry a meaningful ratio: at 5 µs, 25 µs means move ±50% or more between reps
 * of identical code (S0, N=0, is the usual case). Such a cell gets no verdict
 * and contributes nothing to its column's noise band.
 */
export const RESOLVE_MIN_QUANTA = 5;

/** Whether some side of a cell is large enough to compare (see RESOLVE_MIN_QUANTA). */
export function isResolvable(cells, quantumUs = 5) {
  return cells.some((c) => c.mean >= RESOLVE_MIN_QUANTA * quantumUs);
}

/** Whether a cell's verdict compares means: some side's median is too coarse. */
export function usesMean(cells, quantumUs = 5) {
  return cells.some((c) => c.median < MEDIAN_MIN_QUANTA * quantumUs);
}

/**
 * Noise band for one (phase, metric) column, in percent.
 *
 * Each (scenario, build) cell contributes the run-to-run spread of the very
 * statistic its verdict compares: the per-rep means where `usesMean`, the
 * per-rep medians otherwise. The band is their p95 (with fewer than 20 cells,
 * that is simply the widest), floored at ±5%. Scoping it per column keeps one
 * noisy method or phase from widening the gate for every other one. Groups
 * that are not resolvable get no verdict, so they do not widen the band
 * either; otherwise S0's sub-quantum jitter would set the gate for S1…S7.
 *
 * @param {Array<Array<object>>} groups metric aggregates of each scenario's
 *   builds, i.e. `[[base, head], …]`, or `[[head], …]` for a single build.
 */
export function noiseBandFor(groups, quantumUs = 5) {
  const spreads = [];
  for (const cells of groups) {
    if (!isResolvable(cells, quantumUs)) continue;
    const mean = usesMean(cells, quantumUs);
    for (const c of cells) spreads.push(mean ? c.meanSpread : c.spread);
  }
  if (spreads.length === 0) return { band: 5, median: 0, p95: 0 };
  const medianPct = (med(spreads) - 1) * 100;
  const p95Pct = (p95of(spreads) - 1) * 100;
  return { band: Math.max(5, p95Pct), median: medianPct, p95: p95Pct };
}

/**
 * Standard errors of the paired median a change must exceed to count: the
 * gate's multiplier, calibrated with A/A runs of identical code (README,
 * "Noise and the gate"). About 32 cells are gated per run, so this sits well
 * above a single-test 95% level.
 */
export const GATE_K = 3;

/** Rounding slack, in percentage points, when a delta is compared with its band. */
const BAND_EPSILON_PCT = 1e-9;

/** Fewer paired reps than this cannot estimate a spread; the cell falls back. */
export const MIN_PAIRS = 3;

/** Standard error of a median, in standard deviations, times √n. */
const MEDIAN_SE = 1.2533;

/**
 * The paired statistic for one cell (#198).
 *
 * run.mjs interleaves the builds within each rep, so the base and head values
 * of the same rep share that rep's machine state. Their log ratio cancels it,
 * and its spread is the variance the verdict actually faces, which neither
 * build's own run-to-run spread measures. Pairs where a side is zero
 * (sub-quantum) are dropped.
 *
 * Whichever build runs second in a pair can be systematically faster or
 * slower: an A/A run showed one scenario 5–8% "faster" for the second build
 * in every phase. run.mjs therefore alternates the order by rep, and the
 * pairs here are split by which build ran first (from `seq`). The estimate is
 * the mean of the two groups' median log ratios, which cancels an order bias
 * exactly; the spread is the standard deviation of each pair's deviation
 * from its own group's median. With every pair in one order (results from
 * before the runner alternated), this reduces to the plain median and the
 * spread around it.
 *
 * @returns `{ n, logMedian, sigma, seFactor }`: how many pairs were usable,
 *   the order-balanced log ratio (head over base), the spread of the log
 *   ratios around it (a standard deviation), and the standard error of the
 *   estimate per unit of spread; or `null` with fewer than MIN_PAIRS pairs.
 */
export function pairedStats(baseMetric, headMetric, useMean) {
  const key = useMean ? 'mean' : 'median';
  const base = baseMetric.perRep;
  const head = headMetric.perRep;
  if (!base || !head) return null;
  const headByRep = new Map(
    head.rep.map((rep, i) => [rep, { value: head[key][i], seq: head.seq?.[i] }]),
  );
  /** Log ratios, by whether the base ran first in its pair. */
  const groups = { baseFirst: [], headFirst: [] };
  base.rep.forEach((rep, i) => {
    const b = base[key][i];
    const h = headByRep.get(rep);
    // Dropping sub-quantum pairs can bias the ratio when only one side has
    // them (its fastest reps go missing); it only touches cells near the
    // resolvability floor, which the starred-mean path already covers.
    if (h === undefined || !(b > 0) || !(h.value > 0)) return;
    const bSeq = base.seq?.[i];
    // Without `seq` (older results) every pair counts as base-first.
    const headFirst = Number.isFinite(bSeq) && Number.isFinite(h.seq) && h.seq < bSeq;
    groups[headFirst ? 'headFirst' : 'baseFirst'].push(Math.log(h.value / b));
  });
  const parts = [groups.baseFirst, groups.headFirst].filter((g) => g.length > 0);
  const n = parts.reduce((sum, g) => sum + g.length, 0);
  if (n < MIN_PAIRS) return null;
  const centres = parts.map((g) => med(g));
  const logMedian = centres.reduce((a, c) => a + c, 0) / centres.length;
  const residuals = parts.flatMap((g, i) => g.map((x) => Math.abs(x - centres[i])));
  // A standard deviation, not a MAD: at R=7 the 5 µs clock leaves many tied
  // values, which collapse a MAD toward zero and made identical code read as
  // significant in A/A runs (README, "Noise and the gate"). The centres are
  // medians, so one slow rep moves the estimate little; it widens only its
  // own cell's spread, never the column's pooled one.
  const sigma = Math.sqrt(
    residuals.reduce((sum, r) => sum + r * r, 0) / Math.max(1, residuals.length - parts.length),
  );
  // SE of a median is MEDIAN_SE·σ/√n; of the mean of the two group medians,
  // half the root-sum-square of theirs.
  const seFactor =
    (MEDIAN_SE / parts.length) * Math.sqrt(parts.reduce((a, g) => a + 1 / g.length, 0));
  return { n, logMedian, sigma, seFactor };
}

/**
 * The ±% the paired estimate must exceed: GATE_K standard errors, where the
 * standard error is `seFactor · sigma` (see pairedStats), floored at ±5%.
 */
export function pairedBandPct(sigma, seFactor, k = GATE_K) {
  return Math.max(5, (Math.exp(k * seFactor * sigma) - 1) * 100);
}

/**
 * The column's pooled spread: the median of its resolvable cells' paired
 * spreads. At R=7 one cell's SD is itself noisy, and one slow rep inflates
 * it; pooling over the column's scenarios steadies it, and a median keeps one
 * unlucky cell from setting it. A cell is still judged against its own spread
 * when that is wider (see analyze), so a genuinely noisy scenario is not held
 * to a quiet column's band.
 *
 * @param {Array<{ sigma: number }>} stats the column's paired stats.
 */
export function pooledSigma(stats) {
  return stats.length === 0 ? 0 : med(stats.map((x) => x.sigma));
}

/**
 * Verdict for one (scenario, phase, metric) cell.
 *
 * `performance.now()` is quantized (5 µs when cross-origin isolated), and so is
 * every per-call median. When either side's median is within
 * MEDIAN_MIN_QUANTA quanta, the mean, which averages the quantization out over
 * the whole window, is compared instead and the row is starred. When every
 * side's mean is within RESOLVE_MIN_QUANTA quanta the cell is not resolvable
 * at all.
 */
export function verdictFor(baseCell, headCell, bandPct, quantumUs = 5, pairedDeltaPct = null) {
  const useMean = usesMean([baseCell, headCell], quantumUs);
  // The paired median ratio when there are enough paired reps (#198), else
  // the ratio of the two builds' aggregates (e.g. a zero baseline, which has
  // no usable pairs).
  const delta =
    pairedDeltaPct ??
    (useMean ? pct(baseCell.mean, headCell.mean) : pct(baseCell.median, headCell.median));
  if (!isResolvable([baseCell, headCell], quantumUs)) {
    return {
      kind: 'not-resolvable',
      delta,
      useMean,
      text: `not resolvable (< ${RESOLVE_MIN_QUANTA} timer quanta)`,
    };
  }
  // Symmetric in percent, so an improvement must move the log ratio slightly
  // further than a regression of the same band (−x% is a larger log step than
  // +x%). That errs toward neutral, which is the side a gate should err on.
  // A change exactly on the band is neutral. The paired delta comes back
  // through exp(log(r)), which lands an exact 105/100 at 5.000000000000004%,
  // just over the ±5% floor, so compare with a tolerance far below any real
  // difference.
  const over = (x) => x - bandPct > BAND_EPSILON_PCT;
  const kind = over(delta) ? 'regression' : over(-delta) ? 'improvement' : 'neutral';
  const text =
    (kind === 'regression'
      ? Number.isFinite(delta)
        ? `regression (+${f(delta)}%)`
        : 'regression (zero baseline, measurable head)'
      : kind === 'improvement'
        ? `improvement (${f(delta)}%)`
        : `neutral (${sign(delta)}${f(delta)}%)`) + (useMean ? ' *' : '');
  return { kind, delta, useMean, text };
}

/**
 * @param {object} opts
 * @param {string} opts.inDir results directory
 * @param {string | null} [opts.compareDir] an earlier run, for a three-way table
 * @param {number} [opts.gateK] the gate's multiplier (see GATE_K); calibrate.mjs varies it
 * @param {number[] | null} [opts.resample] rep numbers to use, applied to every
 *   build alike so pairs stay intact (calibrate.mjs re-gates subsets of the
 *   reps with it)
 * @param {boolean} [opts.write] write summary.md, verdicts.json and comparison.json
 */
export function analyze({
  inDir,
  compareDir = null,
  gateK = GATE_K,
  resample = null,
  write = true,
}) {
  const meta = JSON.parse(fs.readFileSync(path.join(inDir, 'meta.json'), 'utf8'));
  const labels = meta.labels ?? [meta.headLabel];
  const BASE = meta.baseLabel ?? null;
  const HEAD = meta.headLabel;
  const data = Object.fromEntries(
    labels.map((l) => [l, JSON.parse(fs.readFileSync(path.join(inDir, `${l}.json`), 'utf8'))]),
  );
  // A build with no rows would yield no comparison rows at all, which
  // `--fail-on-regression` would read as a pass.
  for (const l of labels) {
    if (!Array.isArray(data[l]) || data[l].length === 0) {
      throw new Error(`no results for build '${l}' in ${inDir}`);
    }
  }
  if (resample) {
    for (const l of labels) {
      const byRep = data[l];
      data[l] = resample.flatMap((rep, i) =>
        byRep.filter((r) => r.rep === rep).map((r) => ({ ...r, rep: i })),
      );
    }
  }
  const cell = (label, s, p) => cellOf(data[label], s, p);

  // Optional earlier run, for a three-way before/after table.
  let prev = null;
  if (compareDir) {
    const pmeta = JSON.parse(fs.readFileSync(path.join(compareDir, 'meta.json'), 'utf8'));
    prev = {
      meta: pmeta,
      base: pmeta.baseLabel
        ? JSON.parse(fs.readFileSync(path.join(compareDir, `${pmeta.baseLabel}.json`), 'utf8'))
        : null,
      head: JSON.parse(fs.readFileSync(path.join(compareDir, `${pmeta.headLabel}.json`), 'utf8')),
    };
  }

  const SCENARIOS = meta.scenarios;
  const PHASES = meta.phases ?? ['pan', 'static', 'live'];
  const label = (s) => SCENARIO_LABEL[s] ?? '';

  // The coarsest clock of the builds in this run (recorded per build by
  // run.mjs); 5 µs when every page was cross-origin isolated.
  const QUANTUM = Math.max(
    ...labels.map((l) => meta.timerResolutionUs?.[l]).filter((q) => Number.isFinite(q) && q > 0),
    5,
  );

  // ── columns & noise bands ────────────────────────────────────────────
  // One column per (phase, metric) that every build called somewhere in the
  // run: `_reposition` for every phase, plus `setDecorations` for P3. Each
  // column gets its own noise band (see noiseBandFor).
  const compared = BASE ? [BASE, HEAD] : [HEAD];
  const metricCells = (s, p, m) => {
    const cs = compared.map((l) => cell(l, s, p));
    return cs.every((c) => c && c.metrics[m].calls > 0) ? cs.map((c) => c.metrics[m]) : null;
  };
  const columns = [];
  for (const p of PHASES)
    for (const m of METRICS) {
      const groups = SCENARIOS.map((s) => metricCells(s, p, m)).filter(Boolean);
      if (!groups.length) continue;
      // Within-build spread, reported for context; with two builds the gate is
      // the paired statistic below (#198).
      const spread = noiseBandFor(groups, QUANTUM);
      const paired = new Map();
      if (BASE) {
        for (const s of SCENARIOS) {
          const g = metricCells(s, p, m);
          if (!g || !isResolvable(g, QUANTUM)) continue;
          const st = pairedStats(g[0], g[1], usesMean(g, QUANTUM));
          if (st) paired.set(s, st);
        }
      }
      const pooled = pooledSigma([...paired.values()]);
      columns.push({
        phase: p,
        metric: m,
        ...spread,
        spreadBand: spread.band,
        paired,
        pooledSigma: pooled,
        // The column's band at its pooled spread and a typical cell's standard
        // error; a cell's own band can be wider (see cellBand). With no paired
        // cell there is no pooled spread, and the within-build band stands in.
        band: paired.size
          ? pairedBandPct(pooled, med([...paired.values()].map((x) => x.seFactor)), gateK)
          : spread.band,
      });
    }
  /**
   * A cell's band: with enough pairs, its paired band at the wider of its own
   * and the column's spread; without (fewer than MIN_PAIRS usable reps, e.g.
   * a zero baseline or a very short run), the within-build band its
   * aggregate ratio was always judged against.
   */
  const cellBand = (col, s) => {
    const st = col.paired.get(s);
    return st
      ? pairedBandPct(Math.max(st.sigma, col.pooledSigma), st.seFactor, gateK)
      : col.spreadBand;
  };
  // `_reposition` keeps the bare phase key (and header) it always had.
  const colKey = (c) => (c.metric === 'reposition' ? c.phase : `${c.phase}:${c.metric}`);
  const colHead = (c) =>
    (PHASE_LABEL[c.phase] ?? c.phase) +
    (c.metric === 'reposition' ? '' : ` ${METRIC_LABEL[c.metric]}`);

  let out = '';
  out += `# DecorationLayer performance\n\n`;
  if (BASE) {
    out += `Head build **${HEAD}** (\`${meta.builds[HEAD]}\`) vs base build **${BASE}** (\`${meta.builds[BASE]}\`).\n\n`;
  } else {
    out += `Single build **${HEAD}** (\`${meta.builds[HEAD]}\`) — no baseline in this run.\n\n`;
  }

  out += `## Machine & run facts\n\n| | |\n|---|---|\n`;
  out += `| Date | ${meta.date} |\n`;
  out += `| CPU | ${meta.cpuModel} × ${meta.cpus} |\n`;
  out += `| RAM | ${meta.totalMemGB} GB |\n`;
  out += `| Chromium | ${meta.chromium} |\n`;
  out += `| Headless | ${meta.headless ? 'yes' : 'no'} |\n`;
  out += `| Repetitions (R) | ${meta.reps}${BASE ? ', interleaved base/head' : ''}, 1 warm-up run per scenario per build discarded each rep |\n`;
  out += `| Frames per phase | ${meta.frames} rAFs |\n`;
  out += `| Phases | ${PHASES.join(', ')} |\n`;
  out += `| \`performance.now()\` resolution | ${labels.map((l) => `${l}=${f(meta.timerResolutionUs[l], 2)} µs`).join(', ')} (crossOriginIsolated = ${labels.map((l) => `${l}=${meta.crossOriginIsolated[l]}`).join(', ')}) |\n`;
  out += `| transform-write hook verified | ${labels.map((l) => `${l}=${meta.transformHookOk[l]}`).join(', ')} |\n`;
  out += `| cell-anchored HUD supported (feature probe) | ${labels.map((l) => `${l}=${meta.cellAnchorSupport?.[l]}`).join(', ')} |\n`;
  out += `| HUD emission mode | ${labels.map((l) => `${l}=${meta.hudMode?.[l]}`).join(', ')} |\n`;
  if (meta.hostSizeCached) {
    out += `| cached host box active | ${labels.map((l) => `${l}=${meta.hostSizeCached[l]}`).join(', ')} |\n`;
  }
  for (const l of labels)
    out += `| ${l} build | \`${meta.builds[l]}\` @ ${meta.commits?.[l] ?? '—'} |\n`;
  out += `\n`;

  out += `## Per-phase tables\n\n`;
  out += `\`_reposition\` per-call cost in µs. "median" is the median across the ${meta.reps} repetitions of each repetition's own in-window median; "p95" likewise for the in-window p95. "writes" is the number of \`style.transform\` assignments on decoration elements over the whole ${meta.frames}-frame window; "calls" is how many times \`_reposition\` ran in that window.\n\n`;

  for (const phase of PHASES) {
    out += `### ${PHASE_LABEL[phase] ?? phase}\n\n`;
    const sd = phase === 'live';
    if (BASE) {
      out += `| Scenario | ${BASE} median | ${HEAD} median | Δ% | ${BASE} mean | ${HEAD} mean | Δ% mean | ${BASE} p95 | ${HEAD} p95 | ${BASE} writes | ${HEAD} writes | ${BASE} calls | ${HEAD} calls |`;
      if (sd) out += ` ${BASE} setDecorations | ${HEAD} setDecorations | Δ% |`;
      out += `\n|---|---|---|---|---|---|---|---|---|---|---|---|---|`;
      if (sd) out += `---|---|---|`;
      out += `\n`;
      for (const s of SCENARIOS) {
        const m = cell(BASE, s, phase);
        const b = cell(HEAD, s, phase);
        if (!m || !b) continue;
        out += `| **${s}** ${label(s)} | ${f(m.median)} | ${f(b.median)} | ${signedPct(pct(m.median, b.median))} | ${f(m.mean)} | ${f(b.mean)} | ${signedPct(pct(m.mean, b.mean))} | ${f(m.p95)} | ${f(b.p95)} | ${m.writes} | ${b.writes} | ${m.calls} | ${b.calls} |`;
        if (sd)
          out += ` ${f(m.setDeco)} | ${f(b.setDeco)} | ${signedPct(pct(m.setDeco, b.setDeco))} |`;
        out += `\n`;
      }
    } else {
      out += `| Scenario | median | mean | p95 | writes | calls |`;
      if (sd) out += ` setDecorations |`;
      out += `\n|---|---|---|---|---|---|`;
      if (sd) out += `---|`;
      out += `\n`;
      for (const s of SCENARIOS) {
        const c = cell(HEAD, s, phase);
        if (!c) continue;
        out += `| **${s}** ${label(s)} | ${f(c.median)} | ${f(c.mean)} | ${f(c.p95)} | ${c.writes} | ${c.calls} |`;
        if (sd) out += ` ${f(c.setDeco)} |`;
        out += `\n`;
      }
    }
    out += `\n`;
  }

  // ── layout counts (only when a traced pass was run) ───────────────────
  const traceOf = (l, s) => {
    const p = path.join(inDir, `trace-${l}-${s}.json`);
    return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')).counts : null;
  };
  const haveTraces = fs.existsSync(path.join(inDir, `trace-${HEAD}-${SCENARIOS[0]}.json`));
  out += `### Layout / style-recalc event counts\n\n`;
  if (haveTraces) {
    out += `CDP \`disabled-by-default-devtools.timeline\` trace, a single pass per (build, scenario) covering all phases back to back — not R repetitions, so treat these as indicative counts, not timings.\n\n`;
    out += `| Scenario | ${labels.map((l) => `${l} Layout`).join(' | ')} | ${labels.map((l) => `${l} UpdateLayoutTree`).join(' | ')} |\n`;
    out += `|---|${labels.map(() => '---').join('|')}|${labels.map(() => '---').join('|')}|\n`;
    for (const s of SCENARIOS) {
      const t = labels.map((l) => traceOf(l, s));
      out += `| **${s}** | ${t.map((x) => (x ? (x.Layout ?? 0) : '—')).join(' | ')} | ${t.map((x) => (x ? (x.UpdateLayoutTree ?? 0) : '—')).join(' | ')} |\n`;
    }
  } else {
    out += `Not captured in this run (no \`--trace\` pass).\n`;
  }
  out += `\n`;

  out += `### Mean rAF interval (ms) — vsync kept, so ~16.7 ms means the phase never dropped below 60 fps\n\n`;
  out += `| Scenario | ${PHASES.map((p) => `${PHASE_LABEL[p] ?? p} ${labels.join(' / ')}`).join(' | ')} |\n|---|${PHASES.map(() => '---').join('|')}|\n`;
  for (const s of SCENARIOS) {
    out += `| **${s}** | ${PHASES.map((p) => labels.map((l) => f(cell(l, s, p)?.raf, 2)).join(' / ')).join(' | ')} |\n`;
  }
  out += `\n`;

  if (prev && BASE) {
    out += `## Three-way comparison (\`_reposition\` per-call median, µs)\n\n`;
    out += `> The earlier columns come from \`${path.basename(compareDir)}/\` (R=${prev.meta.reps}, ${prev.meta.frames} frames) and were **not interleaved** with this run, so they are weaker evidence than the interleaved pair.\n\n`;
    for (const phase of PHASES) {
      out += `### ${PHASE_LABEL[phase] ?? phase}\n\n`;
      out += `| Scenario | ${BASE} (this run) | ${HEAD} (this run) | ${prev.meta.headLabel} (earlier) | Δ this run | Δ earlier |\n|---|---|---|---|---|---|\n`;
      for (const s of SCENARIOS) {
        const mNow = cell(BASE, s, phase);
        const bNow = cell(HEAD, s, phase);
        const mOld = prev.base ? cellOf(prev.base, s, phase) : null;
        const bOld = cellOf(prev.head, s, phase);
        if (!mNow || !bNow) continue;
        const d1 = pct(mNow.median, bNow.median);
        const d2 = mOld && bOld ? pct(mOld.median, bOld.median) : NaN;
        out += `| **${s}** ${label(s)} | ${f(mNow.median)} | ${f(bNow.median)} | ${bOld ? f(bOld.median) : '—'} | ${signedPct(d1)}% | ${Number.isFinite(d2) || d2 === Infinity ? signedPct(d2) + '%' : '—'} |\n`;
      }
      out += `\n`;
    }
  }

  out += `## Noise bands\n\n`;
  if (BASE) {
    out += `The gate is paired (#198). The builds are interleaved within each rep, so each cell's statistic is built from per-rep log(head / base), which cancels machine drift both builds share. The run alternates which build goes first, and the estimate is the mean of the median log ratio for each order, which cancels a bias toward the first or second build. Its noise is the standard deviation of the log ratios around their order's median, pooled over the column's scenarios by their median; a cell is judged at the wider of its own and the pooled spread. A change counts when the estimate exceeds ${gateK} standard errors, floored at ±5%. "Within-build spread" is each build's own run-to-run spread (p95/median of the per-rep statistic), shown for context only.\n\n`;
    out += `| Column | pooled σ (log) | band at pooled σ | within-build spread median | within-build spread p95 |\n|---|---|---|---|---|\n`;
    for (const c of columns) {
      out += `| ${colHead(c)} | ${f(c.pooledSigma, 3)} | **±${f(c.band)}%** | ${sign(c.median)}${f(c.median)}% | ${sign(c.p95)}${f(c.p95)}% |\n`;
    }
  } else {
    out += `Single build: no gate. The run-to-run spread (p95/median across the ${meta.reps} reps) of each build × scenario's statistic, with its p95 across scenarios:\n\n`;
    out += `| Column | spread median | spread p95 |\n|---|---|---|\n`;
    for (const c of columns) {
      out += `| ${colHead(c)} | ${sign(c.median)}${f(c.median)}% | ${sign(c.p95)}${f(c.p95)}% |\n`;
    }
  }
  out += `\n`;

  // ── verdicts + machine-readable comparison ───────────────────────────
  const verdicts = {};
  const comparison = {
    // Bumped when the row shape or the gating rule changes; `gate` names the
    // rule that produced `verdict` / `noiseBandPct` (see README and #198).
    schemaVersion: 2,
    gate: 'paired-log-ratio',
    gateK,
    date: meta.date,
    baseLabel: BASE,
    headLabel: HEAD,
    noiseBandsPct: Object.fromEntries(columns.map((c) => [colKey(c), c.band])),
    reps: meta.reps,
    frames: meta.frames,
    rows: [],
  };
  if (BASE) {
    out += `## Verdict\n\n`;
    out += `Columns are \`_reposition\` unless they name another method. Every column gates \`--fail-on-regression\`.\n\n`;
    out += `| Scenario | ${columns.map(colHead).join(' | ')} | Overall |\n|---|${columns.map(() => '---').join('|')}|---|\n`;
    for (const s of SCENARIOS) {
      const v = {};
      const kinds = [];
      for (const col of columns) {
        const cm = cell(BASE, s, col.phase);
        const cb = cell(HEAD, s, col.phase);
        if (!cm || !cb || !gatedMetrics(cm, cb).includes(col.metric)) continue;
        const bm = cm.metrics[col.metric];
        const hm = cb.metrics[col.metric];
        const st = col.paired.get(s);
        const band = cellBand(col, s);
        const res = verdictFor(
          bm,
          hm,
          band,
          QUANTUM,
          st ? (Math.exp(st.logMedian) - 1) * 100 : null,
        );
        v[colKey(col)] = res.text;
        kinds.push(res.kind);
        comparison.rows.push({
          scenario: s,
          phase: col.phase,
          metric: col.metric,
          baseMedian: bm.median,
          headMedian: hm.median,
          baseMean: bm.mean,
          headMean: hm.mean,
          // JSON has no Infinity: a zero-baseline regression is `null` here and
          // is still `verdict: 'regression'`.
          deltaPct: Number.isFinite(res.delta) ? res.delta : null,
          usedMean: res.useMean,
          // Whether deltaPct is the paired median ratio (#198) or, with too
          // few usable pairs, the ratio of the aggregates.
          paired: st !== undefined,
          pairs: st?.n ?? 0,
          verdict: res.kind,
          noiseBandPct: band,
        });
      }
      // A scenario with no comparable cell (missing on one side) has no
      // verdict at all, which is not the same as an unresolvable one.
      const overall =
        kinds.length === 0
          ? 'no data'
          : kinds.every((k) => k === 'not-resolvable')
            ? 'not resolvable'
            : kinds.includes('regression')
              ? kinds.includes('improvement')
                ? 'mixed'
                : 'regression'
              : kinds.includes('improvement')
                ? 'improvement'
                : 'neutral';
      verdicts[s] = { ...v, overall };
      out += `| **${s}** ${label(s)} | ${columns.map((c) => v[colKey(c)] ?? '—').join(' | ')} | **${overall}** |\n`;
    }
    out += `\n\\* = computed from the per-call **mean** rather than the median, because at least one side's median is within ${MEDIAN_MIN_QUANTA} timer quanta (${f(MEDIAN_MIN_QUANTA * QUANTUM, 0)} µs at this run's ${f(QUANTUM, 2)} µs resolution), where a single quantum step already exceeds the ±5% band floor. A cell is "not resolvable" when every side's mean is under ${RESOLVE_MIN_QUANTA} quanta (${f(RESOLVE_MIN_QUANTA * QUANTUM, 0)} µs); it gets no verdict and does not widen its column's noise band.\n\n`;
  }

  out += `## Method notes\n\n`;
  out += `- **\`style.transform\` write counting cannot be done by patching \`CSSStyleDeclaration.prototype\`.** Chromium implements CSS property accessors as V8 interceptors, not own accessor properties, so the prototype patch would silently count nothing. A per-instance accessor is installed on each decoration element's own \`style\` object, which does shadow the interceptor. It is self-tested at page load and recorded in \`meta.json\` as \`transformHookOk\`.\n`;
  out += `- **\`performance.now()\` needs cross-origin isolation.** Without it Chromium clamps the clock to 100 µs, coarser than most per-call costs here. The bench Vite server sends COOP/COEP; \`crossOriginIsolated\` and the measured resolution are recorded in \`meta.json\`.\n`;
  out += `- **Tracing is a separate single pass** per (build, scenario), never inside the timing loop: the timeline category emits ~1M events per run and would perturb the timings. Layout counts are therefore n=1.\n`;
  out += `- **P2 triggers the sync listeners via the public \`FabricOverlay.sync()\`**, not the private OSD handler.\n`;
  out += `- **P1 is OSD-redraw-bound**: the harness calls \`panTo\`/\`zoomTo\`/\`forceRedraw\` every frame, so on a small box the mean rAF interval exceeds 16.7 ms. Every build pays this identically and \`_reposition\` is timed per call, so the comparison is unaffected.\n`;
  out += `- **HUD rows** (S5/S6/S7) are emitted as cell-anchored decorations only on builds whose \`DecorationLayer\` supports \`anchorSpace: 'cell'\` (feature-probed at page load); elsewhere the same count is emitted as plain image-space text so N matches exactly. This run: ${labels.map((l) => `${l}=${meta.hudMode?.[l]}`).join(', ')}.\n\n`;

  out += `## Re-running\n\n\`\`\`bash\n`;
  out += `pnpm bench:compare -- --base origin/main --reps ${meta.reps} --frames ${meta.frames}${meta.traced ? ' --trace' : ''}\n`;
  out += `pnpm --filter @osdlabel/bench bench:analyze -- --in ${path.relative(process.cwd(), inDir) || inDir}\n`;
  out += `\`\`\`\n`;

  if (write) {
    fs.writeFileSync(path.join(inDir, 'summary.md'), out);
    fs.writeFileSync(path.join(inDir, 'verdicts.json'), JSON.stringify(verdicts, null, 2));
    fs.writeFileSync(path.join(inDir, 'comparison.json'), JSON.stringify(comparison, null, 2));
  }
  return { summary: out, verdicts, comparison };
}

function latestResultsDir() {
  const base = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'results');
  if (!fs.existsSync(base)) throw new Error(`no results directory at ${base}`);
  const dirs = fs
    .readdirSync(base)
    .map((n) => path.join(base, n))
    .filter((p) => fs.existsSync(path.join(p, 'meta.json')))
    .sort();
  if (dirs.length === 0) throw new Error(`no run directories under ${base}`);
  return dirs[dirs.length - 1];
}

/**
 * `--flag value` lookup. Kept local rather than importing run.mjs's `arg()`,
 * which would load vite and playwright into the analyzer.
 */
function flagValue(argv, flag) {
  const i = argv.indexOf(flag);
  if (i === -1) return null;
  const v = argv[i + 1];
  if (v === undefined || v.startsWith('--')) throw new Error(`${flag} expects a value`);
  return v;
}

function main() {
  const argv = process.argv.slice(2);
  const inArg = flagValue(argv, '--in');
  const inDir = inArg === null ? latestResultsDir() : path.resolve(inArg);
  const compareArg = flagValue(argv, '--compare');
  const compareDir = compareArg === null ? null : path.resolve(compareArg);
  const { summary } = analyze({ inDir, compareDir });
  process.stdout.write(summary);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
