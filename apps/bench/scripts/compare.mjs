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

function hasDist(root) {
  return fs.existsSync(path.join(root, 'packages', 'fabric-osd', 'dist', 'index.js'));
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

  const worktree = path.join(WORKTREES_DIR, baseSha);
  const existed = fs.existsSync(worktree);
  if (!existed) {
    fs.mkdirSync(WORKTREES_DIR, { recursive: true });
    console.log(`creating worktree ${worktree} @ ${baseSha}`);
    git(['worktree', 'add', '--detach', worktree, baseSha]);
  } else {
    console.log(`reusing existing worktree ${worktree}`);
  }

  let removeWorktree = !keepWorktree;
  try {
    if (!(reuse && hasDist(worktree))) {
      console.log(`installing base build in ${worktree} …`);
      run('pnpm', ['install', '--frozen-lockfile'], worktree);
      console.log(`building base build …`);
      run('pnpm', ['build'], worktree);
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

    const regressions = comparison.rows.filter((r) => r.verdict === 'regression');
    if (regressions.length > 0) {
      console.log(
        `\n${regressions.length} regression row(s) beyond ±${comparison.noiseBandPct.toFixed(1)}%:`,
      );
      for (const r of regressions) {
        console.log(
          `  ${r.scenario} ${r.phase}: ${r.baseMedian.toFixed(1)}µs -> ${r.headMedian.toFixed(1)}µs (+${r.deltaPct.toFixed(1)}%${r.usedMean ? ', from means' : ''})`,
        );
      }
      if (failOnRegression) process.exitCode = 1;
    } else {
      console.log(`\nno regressions beyond ±${comparison.noiseBandPct.toFixed(1)}%`);
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
