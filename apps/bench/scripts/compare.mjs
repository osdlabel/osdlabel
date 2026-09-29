/**
 * Compare the working checkout against a base git ref.
 *
 * Creates `apps/bench/.worktrees/<short-sha>` for the base ref, installs and
 * builds it there, runs the matrix interleaved against the working checkout,
 * analyzes the results into `apps/bench/results/<timestamp>/` and removes the
 * worktree again.
 *
 *   node scripts/compare.mjs [--base origin/main] [--label <head label>]
 *                            [--reps 7] [--frames 240] [--scenarios S0,…]
 *                            [--phases pan,static,live] [--trace]
 *                            [--reuse] [--keep-worktree] [--fail-on-regression]
 *                            [--port-base 5390] [--chromium <path>] [--out <dir>]
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  runBench,
  parseCommonArgs,
  arg,
  shortSha,
  timestampDir,
  validateLabels,
  REPO_ROOT,
  BENCH_APP_DIR,
} from './run.mjs';
import { analyze } from './analyze.mjs';

const WORKTREES_DIR = path.join(BENCH_APP_DIR, '.worktrees');

function git(args, cwd = REPO_ROOT) {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim();
}

function run(cmd, args, cwd) {
  execFileSync(cmd, args, { cwd, stdio: 'inherit' });
}

/**
 * Create the base worktree, or reuse it only when it really is a checkout of
 * `fullSha`. `.worktrees/` is gitignored and throwaway, so it is natural to
 * `rm -rf` it, which leaves git's registration behind ("missing but already
 * registered worktree"); an interrupted `git worktree add` leaves a directory
 * that is not a checkout at all. Both are repaired here instead of failing.
 */
export function prepareWorktree(worktree, fullSha) {
  git(['worktree', 'prune']);
  if (fs.existsSync(worktree)) {
    let head = null;
    try {
      head = git(['rev-parse', 'HEAD'], worktree);
    } catch {
      // not a checkout
    }
    // `rev-parse` inside a stray directory would report the enclosing repo's
    // HEAD, so also require the directory to be the worktree's own top level.
    let top = null;
    try {
      top = git(['rev-parse', '--show-toplevel'], worktree);
    } catch {
      // not a checkout
    }
    if (head === fullSha && top && fs.realpathSync(top) === fs.realpathSync(worktree)) {
      console.log(`reusing existing worktree ${worktree}`);
      return;
    }
    console.warn(`discarding stale or incomplete worktree ${worktree}`);
    try {
      git(['worktree', 'remove', '--force', worktree]);
    } catch {
      // not registered with git: a plain directory
    }
    fs.rmSync(worktree, { recursive: true, force: true });
    git(['worktree', 'prune']);
  }
  fs.mkdirSync(WORKTREES_DIR, { recursive: true });
  console.log(`creating worktree ${worktree} @ ${fullSha}`);
  git(['worktree', 'add', '--detach', worktree, fullSha]);
}

function hasDist(root) {
  return fs.existsSync(path.join(root, 'packages', 'fabric-osd', 'dist', 'index.js'));
}

/**
 * Human-readable report of the regression rows in a `comparison.json`, or an
 * empty array when there are none. A zero-baseline regression has no finite
 * percentage (`deltaPct` is null) and is reported as "from zero".
 */
export function regressionLines(comparison) {
  const regressions = comparison.rows.filter((r) => r.verdict === 'regression');
  if (regressions.length === 0) return [];
  const lines = [`\n${regressions.length} regression row(s) beyond their column's noise band:`];
  for (const r of regressions) {
    const delta = r.deltaPct === null ? 'from zero' : `+${r.deltaPct.toFixed(1)}%`;
    const base = r.usedMean ? r.baseMean : r.baseMedian;
    const head = r.usedMean ? r.headMean : r.headMedian;
    lines.push(
      `  ${r.scenario} ${r.phase} ${r.metric}: ${base.toFixed(1)}µs -> ${head.toFixed(1)}µs (${delta}${r.usedMean ? ', from means' : ''}; band ±${r.noiseBandPct.toFixed(1)}%)`,
    );
  }
  return lines;
}

async function main() {
  const argv = process.argv.slice(2);
  const common = parseCommonArgs(argv);
  const baseRef = arg(argv, '--base', 'origin/main');
  const reuse = argv.includes('--reuse');
  const keepWorktree = argv.includes('--keep-worktree');
  const failOnRegression = argv.includes('--fail-on-regression');
  const out = path.resolve(arg(argv, '--out', timestampDir()));

  const baseSha = git(['rev-parse', '--short', baseRef]);
  const baseLabel = baseSha;
  let headLabel = arg(argv, '--label', shortSha(REPO_ROOT));
  if (baseLabel === headLabel) {
    // Same commit on both sides (e.g. an uncommitted working tree measured
    // against its own base): keep the labels distinct so the two result files
    // do not collide. The comparison is then working-tree vs a clean checkout
    // of the same commit, which is a legitimate — if usually null — run.
    console.warn(
      `warning: base and head are the same commit (${baseSha}); labelling head '${headLabel}-head'`,
    );
    headLabel = `${headLabel}-head`;
  }

  // Fail on a bad label now, not after the base install and build.
  validateLabels([baseLabel, headLabel]);

  const worktree = path.join(WORKTREES_DIR, baseSha);
  prepareWorktree(worktree, git(['rev-parse', `${baseSha}^{commit}`]));

  let removeWorktree = !keepWorktree;
  try {
    if (!(reuse && hasDist(worktree))) {
      console.log(`installing base build in ${worktree} …`);
      run('pnpm', ['install', '--frozen-lockfile'], worktree);
      // Only the packages the bench page loads: fabric-osd and its workspace
      // dependencies. A full `pnpm build` would also build every app,
      // including the docs site, none of which the harness reads.
      console.log(`building base build (@osdlabel/fabric-osd and its dependencies) …`);
      run('pnpm', ['exec', 'turbo', 'run', 'build', '--filter=@osdlabel/fabric-osd...'], worktree);
    } else {
      console.log('--reuse: base dist already present, skipping install/build');
    }

    const { meta } = await runBench({
      ...common,
      // Base first so it becomes meta.baseLabel; runs are interleaved.
      builds: [
        { name: baseLabel, root: worktree },
        { name: headLabel, root: REPO_ROOT },
      ],
      out,
    });

    const { comparison } = analyze({ inDir: out });
    console.log(`\nsummary:      ${path.join(out, 'summary.md')}`);
    console.log(`comparison:   ${path.join(out, 'comparison.json')}`);
    console.log(`verdicts:     ${path.join(out, 'verdicts.json')}`);
    console.log(
      `base ${meta.baseLabel} (${meta.builds[meta.baseLabel]}) vs head ${meta.headLabel} (${meta.builds[meta.headLabel]})`,
    );

    // Nothing compared means nothing was gated; never report that as a pass.
    if (comparison.rows.length === 0) {
      throw new Error('no (scenario, phase, metric) cell ran on both builds; nothing to compare');
    }
    const lines = regressionLines(comparison);
    if (lines.length > 0) {
      for (const line of lines) console.log(line);
      if (failOnRegression) process.exitCode = 1;
    } else {
      const bands = Object.values(comparison.noiseBandsPct);
      console.log(
        `\nno regressions beyond the noise bands (±${Math.min(...bands).toFixed(1)}–${Math.max(...bands).toFixed(1)}%)`,
      );
    }
  } catch (e) {
    // Leave the worktree in place on failure so the run can be retried with
    // --reuse instead of re-installing from scratch.
    removeWorktree = false;
    throw e;
  } finally {
    if (removeWorktree) {
      console.log(`removing worktree ${worktree}`);
      try {
        git(['worktree', 'remove', '--force', worktree]);
      } catch (e) {
        console.error(`failed to remove worktree: ${e.message}`);
      }
    } else {
      console.log(`worktree kept at ${worktree}`);
    }
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
