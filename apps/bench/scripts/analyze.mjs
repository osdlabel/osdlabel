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
const pct = (a, b) => (a === 0 ? 0 : ((b - a) / a) * 100);
const f = (n, d = 1) => (Number.isFinite(n) ? n.toFixed(d) : '—');
const sign = (n) => (n >= 0 ? '+' : '');

function cellOf(rows, scenario, phase) {
  const runs = rows.filter((r) => r.scenario === scenario && r.phases[phase]);
  if (runs.length === 0) return null;
  const perRepMedian = runs.map((r) => r.phases[phase].reposition.median);
  return {
    median: med(perRepMedian),
    mean: med(runs.map((r) => r.phases[phase].reposition.mean)),
    p95: med(runs.map((r) => r.phases[phase].reposition.p95)),
    setDeco: med(runs.map((r) => r.phases[phase].setDecorations.median)),
    // run-to-run spread of the per-rep medians
    spread: med(perRepMedian) > 0 ? p95of(perRepMedian) / med(perRepMedian) : 1,
    writes: Math.round(med(runs.map((r) => r.phases[phase].transformWrites))),
    calls: Math.round(med(runs.map((r) => r.phases[phase].reposition.n))),
    raf: med(runs.map((r) => r.phases[phase].meanRafMs)),
    windowMs: med(runs.map((r) => r.phases[phase].windowMs)),
  };
}

/**
 * Verdict for one (scenario, phase) pair.
 *
 * Below the 5 µs timer quantum the per-call median is all zeros, so the mean —
 * which averages the quantization out over the window — is used instead and
 * the row is starred; when both sides' means are under one quantum the cell is
 * not resolvable at all.
 */
export function verdictFor(baseCell, headCell, bandPct) {
  const useMean = baseCell.median < 10 || headCell.median < 10;
  const delta = useMean ? pct(baseCell.mean, headCell.mean) : pct(baseCell.median, headCell.median);
  if (baseCell.mean < 5 && headCell.mean < 5) {
    return { kind: 'not-resolvable', delta, useMean, text: 'not resolvable (< 1 timer quantum)' };
  }
  const kind = delta > bandPct ? 'regression' : delta < -bandPct ? 'improvement' : 'neutral';
  const text =
    (kind === 'regression'
      ? `regression (+${f(delta)}%)`
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

  // ── noise band ───────────────────────────────────────────────────────
  const spreads = [];
  for (const s of SCENARIOS)
    for (const p of PHASES)
      for (const l of labels) {
        const c = cell(l, s, p);
        if (c) spreads.push(c.spread);
      }
  const observedSpread = (med(spreads) - 1) * 100;
  const worstSpread = (p95of(spreads) - 1) * 100;
  // ±5% floor, widened to the observed p95 run-to-run spread when that is larger.
  const BAND = Math.max(5, worstSpread);

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
        out += `| **${s}** ${label(s)} | ${f(m.median)} | ${f(b.median)} | ${sign(pct(m.median, b.median))}${f(pct(m.median, b.median))} | ${f(m.mean)} | ${f(b.mean)} | ${sign(pct(m.mean, b.mean))}${f(pct(m.mean, b.mean))} | ${f(m.p95)} | ${f(b.p95)} | ${m.writes} | ${b.writes} | ${m.calls} | ${b.calls} |`;
        if (sd)
          out += ` ${f(m.setDeco)} | ${f(b.setDeco)} | ${sign(pct(m.setDeco, b.setDeco))}${f(pct(m.setDeco, b.setDeco))} |`;
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
        out += `| **${s}** ${label(s)} | ${f(mNow.median)} | ${f(bNow.median)} | ${bOld ? f(bOld.median) : '—'} | ${sign(d1)}${f(d1)}% | ${Number.isFinite(d2) ? sign(d2) + f(d2) + '%' : '—'} |\n`;
      }
      out += `\n`;
    }
  }

  out += `## Noise band\n\n`;
  out += `Run-to-run spread of the per-repetition medians (p95/median across the ${meta.reps} reps), aggregated over every build × scenario × phase cell: median **${sign(observedSpread)}${f(observedSpread)}%**, p95 **${sign(worstSpread)}${f(worstSpread)}%**. The noise band used below is therefore **±${f(BAND)}%** (a ±5% floor, widened to the observed p95 spread where that is larger).\n\n`;

  // ── verdicts + machine-readable comparison ───────────────────────────
  const verdicts = {};
  const comparison = {
    date: meta.date,
    baseLabel: BASE,
    headLabel: HEAD,
    noiseBandPct: BAND,
    reps: meta.reps,
    frames: meta.frames,
    rows: [],
  };
  if (BASE) {
    out += `## Verdict\n\n`;
    out += `| Scenario | ${PHASES.map((p) => PHASE_LABEL[p] ?? p).join(' | ')} | Overall |\n|---|${PHASES.map(() => '---').join('|')}|---|\n`;
    for (const s of SCENARIOS) {
      const v = {};
      const kinds = [];
      for (const p of PHASES) {
        const cm = cell(BASE, s, p);
        const cb = cell(HEAD, s, p);
        if (!cm || !cb) continue;
        const res = verdictFor(cm, cb, BAND);
        v[p] = res.text;
        kinds.push(res.kind);
        comparison.rows.push({
          scenario: s,
          phase: p,
          baseMedian: cm.median,
          headMedian: cb.median,
          baseMean: cm.mean,
          headMean: cb.mean,
          deltaPct: res.delta,
          usedMean: res.useMean,
          verdict: res.kind,
          noiseBandPct: BAND,
        });
      }
      const overall = kinds.every((k) => k === 'not-resolvable')
        ? 'not resolvable'
        : kinds.includes('regression')
          ? kinds.includes('improvement')
            ? 'mixed'
            : 'regression'
          : kinds.includes('improvement')
            ? 'improvement'
            : 'neutral';
      verdicts[s] = { ...v, overall };
      out += `| **${s}** ${label(s)} | ${PHASES.map((p) => v[p] ?? '—').join(' | ')} | **${overall}** |\n`;
    }
    out += `\n\\* = computed from the per-call **mean** rather than the median, because at least one side's median sits at or below the 5 µs timer quantum.\n\n`;
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

function main() {
  const argv = process.argv.slice(2);
  const i = argv.indexOf('--in');
  const inDir = i === -1 ? latestResultsDir() : path.resolve(argv[i + 1]);
  const c = argv.indexOf('--compare');
  const compareDir = c === -1 ? null : path.resolve(argv[c + 1]);
  const { summary } = analyze({ inDir, compareDir });
  process.stdout.write(summary);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
