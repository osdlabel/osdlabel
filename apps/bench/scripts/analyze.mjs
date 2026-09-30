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
    // Raw per-rep values in run order, so a different gating rule (e.g. a
    // paired head/base ratio, #198) can be swapped in without touching the
    // aggregation or table code.
    perRep: {
      rep: runs.map((r) => r.rep),
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
 * Verdict for one (scenario, phase, metric) cell.
 *
 * `performance.now()` is quantized (5 µs when cross-origin isolated), and so is
 * every per-call median. When either side's median is within
 * MEDIAN_MIN_QUANTA quanta, the mean, which averages the quantization out over
 * the whole window, is compared instead and the row is starred. When every
 * side's mean is within RESOLVE_MIN_QUANTA quanta the cell is not resolvable
 * at all.
 */
export function verdictFor(baseCell, headCell, bandPct, quantumUs = 5) {
  const useMean = usesMean([baseCell, headCell], quantumUs);
  const delta = useMean ? pct(baseCell.mean, headCell.mean) : pct(baseCell.median, headCell.median);
  if (!isResolvable([baseCell, headCell], quantumUs)) {
    return {
      kind: 'not-resolvable',
      delta,
      useMean,
      text: `not resolvable (< ${RESOLVE_MIN_QUANTA} timer quanta)`,
    };
  }
  const kind = delta > bandPct ? 'regression' : delta < -bandPct ? 'improvement' : 'neutral';
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

export function analyze({ inDir, compareDir = null }) {
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
      if (groups.length) columns.push({ phase: p, metric: m, ...noiseBandFor(groups, QUANTUM) });
    }
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
  out += `| Repetitions (R) | ${meta.reps}${BASE ? ', interleaved base/head' : ''}, 1 warm-up run per scenario discarded |\n`;
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
  out += `One band per (phase, timed method). Each build × scenario contributes the run-to-run spread (p95/median across the ${meta.reps} reps) of the statistic its verdict compares — the per-rep means for starred cells, the per-rep medians otherwise. The band is the p95 of those spreads (with fewer than 20 of them, the widest), floored at ±5%.\n\n`;
  out += `| Column | spread median | spread p95 | band |\n|---|---|---|---|\n`;
  for (const c of columns) {
    out += `| ${colHead(c)} | ${sign(c.median)}${f(c.median)}% | ${sign(c.p95)}${f(c.p95)}% | **±${f(c.band)}%** |\n`;
  }
  out += `\n`;

  // ── verdicts + machine-readable comparison ───────────────────────────
  const verdicts = {};
  const comparison = {
    // Bumped when the row shape or the gating rule changes; `gate` names the
    // rule that produced `verdict` / `noiseBandPct` (see README and #198).
    schemaVersion: 1,
    gate: 'column-p95-spread',
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
        const res = verdictFor(bm, hm, col.band, QUANTUM);
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
          verdict: res.kind,
          noiseBandPct: col.band,
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

  fs.writeFileSync(path.join(inDir, 'summary.md'), out);
  fs.writeFileSync(path.join(inDir, 'verdicts.json'), JSON.stringify(verdicts, null, 2));
  fs.writeFileSync(path.join(inDir, 'comparison.json'), JSON.stringify(comparison, null, 2));
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
