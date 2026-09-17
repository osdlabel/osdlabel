# `@osdlabel/bench` — DecorationLayer performance harness

A real-browser benchmark for the `DecorationLayer` hot path. It is private, never
published, and is not part of `build` / `test` / `typecheck` / `test:e2e`.

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

The two instrumented quantities are:

- **`_reposition` per-call cost** (µs), median / mean / p95 within a window.
- **`style.transform` write count** over a window, counted by hooking each
  decoration element's own `style` object (see "Method" below).

## Quick start

```bash
# measure the working checkout only
pnpm bench

# measure the working checkout against a baseline, with a verdict table
pnpm bench:compare -- --base origin/main

# re-analyze an existing run (rewrites summary.md / verdicts.json / comparison.json)
pnpm --filter @osdlabel/bench bench:analyze -- --in apps/bench/results/<timestamp>
```

Both root scripts go through turbo, whose `bench` / `bench:compare` tasks
`dependsOn: ["^build"]` — the harness loads each checkout's `dist/`, never its
`src/`, so the packages must be built first. Results land in
`apps/bench/results/<timestamp>/` and are gitignored, as are the base-ref
worktrees under `apps/bench/.worktrees/`.

Nothing is fetched off-origin: the sample image is `apps/dev/sample-data/landscape.png`
served through Vite's `/@fs/` prefix, and both builds are fed the identical file.

## Flags

### `scripts/run.mjs` (`pnpm bench`)

| Flag                     | Default                                              | Meaning                                                                                                            |
| ------------------------ | ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `--root <path>`          | this repo (resolved from the config file's location) | Checkout whose `dist/` the page loads. Also settable as `BENCH_ROOT`.                                              |
| `--label <name>`         | short sha of that checkout's `HEAD`                  | Label for the build in the output files.                                                                           |
| `--build <label>=<path>` | —                                                    | Repeatable; run several checkouts interleaved. Overrides `--root`/`--label`. The first one is treated as the base. |
| `--reps <n>`             | `7`                                                  | Repetitions of the whole matrix. Builds alternate within each rep.                                                 |
| `--frames <n>`           | `240`                                                | rAF frames per measurement window.                                                                                 |
| `--scenarios <list>`     | `S0,…,S7`                                            | Comma-separated scenario filter.                                                                                   |
| `--phases <list>`        | `pan,static,live`                                    | Comma-separated phase filter.                                                                                      |
| `--trace`                | off                                                  | Extra single CDP-traced pass per (build, scenario) for `Layout` / `UpdateLayoutTree` counts.                       |
| `--out <dir>`            | `results/<timestamp>`                                | Output directory.                                                                                                  |
| `--port-base <n>`        | `5390`                                               | First dev-server port; one port per build.                                                                         |
| `--chromium <path>`      | Playwright's own chromium                            | Chromium executable. Also settable as `BENCH_CHROMIUM`.                                                            |
| `--allow-degraded`       | off                                                  | Run even if a measurement prerequisite fails (write hook, cross-origin isolation, timer > 10 µs). Off = abort.     |

### `scripts/compare.mjs` (`pnpm bench:compare`)

Everything above, plus:

| Flag                   | Default       | Meaning                                                                                                                   |
| ---------------------- | ------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `--base <git ref>`     | `origin/main` | Baseline ref. Checked out into `apps/bench/.worktrees/<short-sha>`, then `pnpm install --frozen-lockfile` + `pnpm build`. |
| `--reuse`              | off           | Skip install/build when the worktree already has `packages/fabric-osd/dist/index.js`.                                     |
| `--keep-worktree`      | off           | Do not remove the worktree at the end. (A failed run always keeps it, so a retry can use `--reuse`.)                      |
| `--fail-on-regression` | off           | Exit 1 when any (scenario, phase) is a regression beyond the noise band. The offending rows are printed either way.       |

The head build's label defaults to the short sha of `HEAD`; the base build's
label is the short sha the base ref resolves to.

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
- **Runs are interleaved** (base, head, base, head, …) within each repetition so
  thermal and GC drift is shared, and one short warm-up run per scenario per
  build is discarded.
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
- The **noise band** is the run-to-run spread of the per-repetition medians
  (p95 / median across reps, aggregated over every build × scenario × phase):
  a ±5% floor, widened to the observed p95 spread when that is larger. A delta
  inside the band is `neutral`, not a win or a loss.
- A verdict row starred with `*` was computed from the per-call **mean** because
  at least one side's median sat at or below the 5 µs timer quantum; when both
  sides' means are under one quantum the row is "not resolvable" and should not
  be argued about.
- `comparison.json` carries the same thing machine-readably: one row per
  (scenario, phase) with `baseMedian`, `headMedian`, `deltaPct`, `verdict` and
  `noiseBandPct`. `verdicts.json` is the per-scenario rollup.

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
- **jsdom cannot substitute for this.** CSSOM reserialization and forced layout
  do not exist there, which is the whole reason this harness is a browser.

## CI integration (proposal, not wired up)

Not enabled today — benchmarking on shared CI runners is noisy, and the job is
slow because the base ref has to be installed and built. If it is wired up, the
shape that fits this harness is:

```yaml
- run: pnpm bench:compare -- --base origin/${{ github.base_ref }} \
    --reps 5 --frames 240 --fail-on-regression
- uses: actions/upload-artifact@v4
  if: always()
  with:
    name: bench-${{ github.sha }}
    path: apps/bench/results/
```

Run it on a dedicated, non-shared runner, on a label (`perf`) rather than on
every PR, and treat `comparison.json` as the gate: `--fail-on-regression` exits
1 when any (scenario, phase) is outside the run's own noise band, so the
threshold adapts to the runner instead of being hard-coded. CI needs no
`--chromium` override — it installs Playwright's browsers normally.
