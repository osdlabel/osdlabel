# `@osdlabel/bench` — DecorationLayer performance harness

A real-browser benchmark for the `DecorationLayer` hot path. It is private and
never published. The benchmark itself is not part of `build` / `typecheck` /
`test:e2e`. Only the analysis logic (verdicts, noise bands, the regression
report) and the CLI parsing (flags, labels) have Vitest unit tests in `tests/`,
which run under `pnpm test` without launching a browser.

## What it measures, and why

Every decoration the layer owns is repositioned on every `FabricOverlay.onSync`
callback, i.e. on every OSD `animation` frame, through
[`DecorationLayer._reposition`](../../packages/fabric-osd/src/decoration/decoration-layer.ts)
→ `_positionEl`, which writes `el.style.transform` per element. `setDecorations`
is the second hot path: it diffs text / DOM / line decorations by id and then
calls `_reposition` itself.

That path cannot be measured in jsdom. The costs that matter — CSSOM
reserialization on a `style.transform` write, and the forced layout a
`clientWidth` read pulls into the middle of a pass — only exist in a real
engine's style/layout pipeline. So this harness drives the **built** layer in
headless Chromium and times the real calls.

The instrumented quantities are:

- **`_reposition` per-call cost** (µs), median / mean / p95 within a window.
- **`setDecorations` per-call cost** (µs) in P3 live, which covers the DOM diff
  as well as the `_reposition` it triggers.
- **`style.transform` write count** over a window, counted by hooking each
  decoration element's own `style` object (see "Method" below).

## Quick start

```bash
# measure the working checkout only
pnpm bench

# measure the working checkout against a baseline, with a verdict table
pnpm bench:compare -- --base origin/main

# re-analyze an existing run (rewrites summary.md / verdicts.json / comparison.json);
# pnpm --filter runs it from apps/bench, so --in is relative to that directory
pnpm --filter @osdlabel/bench bench:analyze -- --in results/<timestamp>
```

Both root scripts go through turbo, filtered to `@osdlabel/bench`, whose
`bench` / `bench:compare` tasks `dependsOn: ["^build"]` — the harness loads each
checkout's `dist/`, never its `src/`, so the packages it imports must be built
first. The repo runs turbo in strict env mode, which hands a task only the
variables it declares: the bench tasks list `BENCH_CHROMIUM`, `BENCH_ROOT` and
`PLAYWRIGHT_BROWSERS_PATH` under `passThroughEnv`, and `bench:compare` also
passes the proxy / CA variables (`HTTPS_PROXY`, `NODE_EXTRA_CA_CERTS`,
`npm_config_*`, …) that its nested `pnpm install` needs behind a proxy. A new
environment variable the harness reads must be added there, or it silently
never arrives. Results land in
`apps/bench/results/<timestamp>/` and are gitignored, as are the base-ref
worktrees under `apps/bench/.worktrees/`.

Nothing is fetched off-origin: the sample image is `apps/dev/sample-data/landscape.png`
served through Vite's `/@fs/` prefix, and both builds are fed the identical file.

## Flags

### `scripts/run.mjs` (`pnpm bench`)

| Flag                     | Default                                              | Meaning                                                                                                            |
| ------------------------ | ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `--root <path>`          | this repo (resolved from the config file's location) | Checkout whose `dist/` the page loads. Also settable as `BENCH_ROOT`.                                              |
| `--label <name>`         | short sha of that checkout's `HEAD`                  | Label for the build in the output files. Must match `[A-Za-z0-9._-]+` (it becomes a file name), so not `feat/x`.   |
| `--build <label>=<path>` | —                                                    | Repeatable; run several checkouts interleaved. Overrides `--root`/`--label`. The first one is treated as the base. |
| `--reps <n>`             | `7`                                                  | Repetitions of the whole matrix. Builds alternate within each rep, and which goes first flips every rep.           |
| `--frames <n>`           | `240`                                                | rAF frames per measurement window.                                                                                 |
| `--scenarios <list>`     | `S0,…,S7`                                            | Comma-separated scenario filter.                                                                                   |
| `--phases <list>`        | `pan,static,live`                                    | Comma-separated phase filter.                                                                                      |
| `--trace`                | off                                                  | Extra single CDP-traced pass per (build, scenario) for `Layout` / `UpdateLayoutTree` counts.                       |
| `--out <dir>`            | `results/<timestamp>`                                | Output directory.                                                                                                  |
| `--port-base <n>`        | `5390`                                               | First dev-server port; one port per build.                                                                         |
| `--chromium <path>`      | Playwright's own chromium                            | Chromium executable. Also settable as `BENCH_CHROMIUM`.                                                            |
| `--allow-degraded`       | off                                                  | Run even if a measurement prerequisite fails (write hook, cross-origin isolation, timer > 10 µs). Off = abort.     |

### `scripts/compare.mjs` (`pnpm bench:compare`)

Everything above except `--root` / `--build` (the two builds are always the
base worktree and this checkout), plus:

| Flag                   | Default       | Meaning                                                                                                                                                                                                        |
| ---------------------- | ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--base <git ref>`     | `origin/main` | Baseline ref. Checked out into `apps/bench/.worktrees/<short-sha>`, then `pnpm install --frozen-lockfile` and a turbo build of `@osdlabel/fabric-osd` and its dependencies (the only packages the page loads). |
| `--reuse`              | off           | Skip install/build when the worktree already has `packages/fabric-osd/dist/index.js`.                                                                                                                          |
| `--keep-worktree`      | off           | Do not remove the worktree at the end. (A failed run always keeps it, so a retry can use `--reuse`.)                                                                                                           |
| `--fail-on-regression` | off           | Exit 1 when any (scenario, phase, metric) is a regression beyond the noise band. The offending rows are printed either way.                                                                                    |

The head build's label defaults to the short sha of `HEAD`; the base build's
label is the short sha of the commit the base ref resolves to (an annotated tag
is peeled to its commit, so `--base v1.2.3` and `--base <its sha>` share one
worktree).

An existing worktree is reused only if it really is a checkout of the base
commit. A deleted-but-still-registered worktree (e.g. after `rm -rf
apps/bench/.worktrees`), a half-created one from an interrupted run, or one
moved to another commit is discarded and recreated, so the directory is safe to
delete by hand at any time.

All numeric flags must be positive integers and `--scenarios` / `--phases`
entries must be known names; anything else is rejected before a server or
browser starts. A viewer that fails to open the sample image aborts the run
after 60 s instead of hanging.

### `scripts/analyze.mjs` (`pnpm --filter @osdlabel/bench bench:analyze`)

| Flag              | Default                           | Meaning                                           |
| ----------------- | --------------------------------- | ------------------------------------------------- |
| `--in <dir>`      | newest directory under `results/` | Run to analyze.                                   |
| `--compare <dir>` | —                                 | An older run, for a three-way before/after table. |

### `scripts/probe-hud.mjs`

A within-build A/B: the same build, the same number of decorations, the HUD rows
emitted once as cell-anchored decorations and once as plain image-space text.
It isolates the cell-space branch of `_reposition` from the decoration count.
Flags: `--root`, `--scenarios` (default `S2,S5`), `--frames`, `--reps`,
`--port` (default `5398`), `--chromium`. It prints a skip message on builds
without cell-anchor support.

## Scenarios and phases

Scenarios (`src/bench.js`, `SCENARIOS`) vary the decoration mix:

|      | text | dom | hud |
| ---- | ---- | --- | --- |
| `S0` | 0    | 0   | 0   |
| `S1` | 10   | 0   | 0   |
| `S2` | 100  | 0   | 0   |
| `S3` | 500  | 0   | 0   |
| `S4` | 100  | 100 | 0   |
| `S5` | 100  | 0   | 1   |
| `S6` | 100  | 0   | 4   |
| `S7` | 500  | 0   | 1   |

Phases (`runPhase` in `src/bench.js`):

- **P1 `pan`** — `panTo` + `zoomTo` + `forceRedraw` every frame. Every element
  moves, so an idempotence guard can never fire.
- **P2 `static`** — `overlay.sync()` every frame with the viewport and the
  decorations unchanged. Every transform write is a repeat.
- **P3 `live`** — `setDecorations` every frame, with 10% of the texts mutated.
  Geometry never changes; only `textContent` does.

**Adding a scenario**: add a row to `SCENARIOS` in `src/bench.js` (the key is
what `--scenarios` filters on) and a human label to `SCENARIO_LABEL` in
`scripts/analyze.mjs`. `buildDecorations` already covers text / DOM / HUD mixes;
a genuinely new decoration shape goes there, behind the same seeded PRNG so
every build gets byte-identical input.

**Adding a phase**: add a branch to `runPhase` in `src/bench.js` and pass its
name in `--phases`. A phase is just "what to do on each of the N rAF frames";
the window accounting, stats and write counting are shared.

**Measuring a different hot path**: the harness never patches the library. It
wraps the _instance_ after construction — bind the original method, time around
it, push the sample into a per-window accumulator:

```js
const orig = layer._reposition.bind(layer);
layer._reposition = function wrapped() {
  const t0 = performance.now();
  orig();
  repositionSamples.push(performance.now() - t0);
};
```

Any method reached through `this.foo()` on the instance can be measured the same
way. Report the new series in `runPhase`'s return value and add a column in
`scripts/analyze.mjs`.

## Method

- **`style.transform` writes are counted per instance, not on the prototype.**
  Chromium implements CSS property accessors on `CSSStyleDeclaration` as V8
  interceptors, not own accessor properties —
  `Object.getOwnPropertyDescriptor(CSSStyleDeclaration.prototype, 'transform')`
  is `undefined`, so a prototype patch counts nothing. A per-instance accessor
  on each element's own `style` object does shadow the interceptor. This is
  self-tested at page load and recorded as `transformHookOk` in `meta.json`.
- **The dev server sends COOP/COEP.** Without cross-origin isolation Chromium
  clamps `performance.now()` to 100 µs, coarser than most per-call costs here;
  isolated it is ~5 µs. Both the flag and the measured resolution go into
  `meta.json`.
- **Runs are interleaved** within each repetition so thermal and GC drift is
  shared, and one short warm-up run per scenario per build is discarded.
- **The order flips every rep** (base then head, then head then base, …).
  Whichever build runs second in a pair can be systematically faster or
  slower; one A/A run showed a scenario 5–8% "faster" for the second build in
  every phase. Alternating spreads that bias over both builds, and the gate
  (below) cancels it exactly.
- **Every rep gets fresh pages.** After the first rep each build's page and
  browser context are closed and reopened, then warmed up again. A page that
  lives for the whole run carries its own JIT, GC and layout state, and A/A
  runs showed that state as a persistent 7–10% offset between two pages of
  identical code — which no amount of pairing within the run can cancel,
  since it is the same in every pair. The cost is a full warm-up pass per
  rep instead of one per run.
- **The run is long.** At the defaults a two-build comparison takes about
  40 minutes on a 4-core machine, most of it the 8 × 2 × 7 measured runs.
- **HUD rows are feature-probed, never inferred from a build name.**
  `window.__bench.supportsCellAnchor()` places a probe decoration at cell
  `{x:1, y:0}` and checks it landed on the right-hand half of the host. Builds
  whose `DecorationLayer` understands `anchorSpace: 'cell'` get real
  cell-anchored HUD rows; builds that do not get the same _number_ of
  decorations as plain image-space text, so N matches exactly.
- **Tracing is a separate pass.** The timeline category emits ~1M events per run,
  which would perturb the timings it is supposed to explain.

## Reading `summary.md`

- Per-phase tables give `_reposition` median / mean / p95 in µs, the transform
  write count and the call count for the whole window, plus `setDecorations`
  medians in P3.
- Each verdict cell is judged by the **paired gate** (#198); see
  [Noise and the gate](#noise-and-the-gate). Its `noiseBandPct` is the ±% the
  cell's base-vs-head change had to exceed. A delta inside the band is
  `neutral`, not a win or a loss. The noise table under the verdict shows each
  column's band at its pooled spread, next to each build's own run-to-run
  spread ("within-build spread"), which is context only and gates nothing.
- A verdict row starred with `*` was computed from the per-call **mean**
  because at least one side's median was within 20 timer quanta (100 µs at the
  usual 5 µs resolution). Medians are quantized to the clock, so below that a
  single quantum step is already more than the ±5% band floor and identical
  code can read as a ±20% change. The mean averages the quantization out over
  the whole window. When every side's mean is under 5 quanta (25 µs at 5 µs)
  the row is "not resolvable": the ratio of such small means swings ±50% or
  more between reps of identical code (S0, N=0, is the usual case), so it gets
  no verdict and is left out of its column's noise band.
- The **verdict table** has one column per (phase, metric). `_reposition` is
  gated in every phase; `setDecorations` is gated wherever both builds called
  it, which is P3 live. Its timing covers the DOM diff as well as the
  `_reposition` it triggers, so a slowdown in element creation or text updates
  fails the gate even when `_reposition` is flat.
- `comparison.json` carries the same thing machine-readably: one row per
  (scenario, phase, metric) with `metric` (`reposition` or `setDecorations`),
  `baseMedian`, `headMedian`, `baseMean`, `headMean`, `deltaPct`, `usedMean`,
  `verdict`, `noiseBandPct` (the cell's own band), `paired` and `pairs`.
  `paired` says whether `deltaPct` is the paired estimate (true when at least
  3 reps had a non-zero value on both sides; `pairs` is how many) or, failing
  that, the ratio of the two builds' aggregates against the within-build band. The
  top-level `noiseBandsPct` maps each column key to its band at the pooled
  spread, and `gateK` records the multiplier. `deltaPct` is `null` whenever
  the base is zero, since JSON has no `Infinity`: the row is a regression once
  the head's mean clears 5 quanta, and not resolvable below that.
  `schemaVersion` (2) and `gate` (`paired-log-ratio`; 1 was
  `column-p95-spread`) identify the row shape and the rule that produced the
  verdicts. Each result row in
  `<label>.json` also carries `rep`, `seq` (interleave position) and
  `startedAt`.
  `verdicts.json` is the per-scenario rollup, keyed by phase for `_reposition`
  and by `<phase>:setDecorations` for the other metric; a scenario that ran on
  only one build has `overall: "no data"`. A comparison with no rows at all
  (nothing ran on both builds) is an error, never a pass.

## Noise and the gate

A comparison has 32 cells (8 scenarios × `_reposition` in three phases plus
`setDecorations` in P3), about 26 of them large enough to resolve and gate,
so a gate that is right 95% of the time per cell would fail most runs of
identical code. The gate is built to keep that per-run false-positive rate
low without going blind to a real ~15% slowdown.

**The statistic is paired.** The builds run interleaved, so the base and head
values from the same rep share that rep's machine state. For each cell the
gate takes the per-rep `log(head / base)`, splits the pairs by which build ran
first, and averages the two groups' medians: the medians make one slow rep
harmless to the estimate, and averaging the two orders cancels any
first/second bias. The spread is the standard deviation of each pair's
deviation from its group's median.

**The band is k standard errors of that estimate**, k=3, floored at ±5%. A
cell's spread is taken as the wider of its own and its column's pooled spread
(the median of the column's cell spreads): at R=7 one cell's own SD is noisy,
so a quiet cell is not held to a band its handful of pairs happened to make
too narrow, and a genuinely noisy cell is not held to a quiet column's band.

**Why an SD and not a MAD.** `performance.now()` ticks in 5 µs, so many cells'
per-rep values tie. A MAD over tied values collapses toward zero and gives a
band of ±5% to cells whose real spread is several times that.

**Calibration.** `pnpm --filter @osdlabel/bench bench:calibrate` re-gates
saved runs at several values of k:

```bash
pnpm --filter @osdlabel/bench bench:calibrate -- \
  --aa results/<a-a run> --slow results/<injected run> --k 2,2.5,3,3.5,4
```

- `--aa` runs compare identical library code, e.g. `bench:compare` on a branch
  that changes only `apps/bench`. Every non-neutral verdict is a false
  positive. Besides the run as recorded, each is re-gated on every subset of
  `--subset m` of its reps (default: all but two) to estimate the rate at
  lower R. Subsets are drawn without replacement; a bootstrap's duplicated
  reps would shrink the spread and report false positives the gate does not
  make.
- `--slow` runs are a head with a known slowdown injected (a busy-wait in
  `DecorationLayer._reposition` costing 15% of each call); the output lists
  which cells were caught.

With fresh pages per rep and order alternation, on a 4-core container:

| Spread estimator | k   | A/A false positives, R=7 | Runs with any false positive, R=6 subsets | R=5 subsets | +15% `_reposition` cells caught |
| ---------------- | --- | ------------------------ | ----------------------------------------- | ----------- | ------------------------------- |
| MAD              | 3   | 1                        | 57%                                       | 71%         | —                               |
| mean abs. dev.   | 3.5 | 0                        | 14%                                       | 24%         | —                               |
| SD               | 3   | 0                        | 0%                                        | 10%         | 19 of 19, in all 7 scenarios    |

The MAD and mean-absolute-deviation rows were evaluated on the A/A run only,
and were rejected on it. For comparison, the previous gate (each column's p95
within-build spread) gave bands of ±15–75% on an A/A run on the same machine,
too wide to see a 15% slowdown in most columns.

A second A/A run, made after the estimator was settled, confirmed it: no
false positive at R=7 or in any R=6 subset, 1 of 21 R=5 subsets with one,
cell bands of ±5.8–17.6% and no A/A delta beyond 4.9%.

## Known limitations

- **P1 is OSD-redraw-bound on a small box.** The harness forces a redraw every
  frame, so on a 4-core CI-class machine the mean rAF interval in P1 is well
  above 16.7 ms. Every build pays this identically and `_reposition` is timed
  per call, so the comparison holds — but P1's _frame rate_ is not a statement
  about the layer.
- **Traced Layout counts are n=1** per (build, scenario) and indicative only.
- **Timer quantum.** Below ~5 µs per call the median degenerates to zeros; see
  the starred verdicts above.
- **Absolute numbers are machine-specific.** Only the base-vs-head delta from a
  single interleaved run is meaningful; do not compare µs across machines or
  across runs.
- **The gate wants R=7.** At R=7 the calibration above saw no false positive;
  at R=5 identical code still flagged something in 2 of the 21 rep subsets
  of one A/A run, a rough one-in-ten; below 3 usable pairs a cell cannot be paired at all and falls back to the
  within-build band. `compare.mjs` warns below 5 reps.
- **The gate is calibrated on one machine.** k=3 was chosen from A/A and
  injected-slowdown runs on a 4-core cloud container. A quieter machine only
  makes it more conservative; a much noisier one should be re-calibrated with
  `bench:calibrate` before the gate is trusted there.
- **jsdom cannot substitute for this.** CSSOM reserialization and forced layout
  do not exist there, which is the whole reason this harness is a browser.

## CI integration (proposal, not wired up)

Not enabled today — benchmarking on shared CI runners is noisy, and the job is
slow because the base ref has to be installed and built. If it is wired up, the
shape that fits this harness is:

```yaml
- run: pnpm bench:compare -- --base origin/${{ github.base_ref }} \
    --reps 7 --frames 240 --fail-on-regression
- uses: actions/upload-artifact@v4
  if: always()
  with:
    name: bench-${{ github.sha }}
    path: apps/bench/results/
```

Run it on a dedicated, non-shared runner, on a label (`perf`) rather than on
every PR, and treat `comparison.json` as the gate: `--fail-on-regression` exits
1 when any (scenario, phase, metric) is outside the run's own noise band, so the
threshold adapts to the runner instead of being hard-coded. Calibrate on the
runner first (see [Noise and the gate](#noise-and-the-gate)). CI needs no
`--chromium` override — it installs Playwright's browsers normally.
