/**
 * Calibrates the paired gate's multiplier (#198) on saved result directories.
 *
 *   node scripts/calibrate.mjs --aa <dir>[,<dir>…] [--slow <dir>[,<dir>…]]
 *                              [--k 2,2.5,3,3.5,4] [--subset <m>]
 *
 * `--aa` dirs are A/A runs: base and head are the same library code (e.g.
 * compare.mjs on a branch that changes only the harness). Every non-neutral
 * verdict there is a false positive. For each k this prints the verdicts of
 * the run as recorded, then re-gates every subset of m of its reps (default:
 * all but two), each as if it were a whole run at R=m, and reports the share
 * of those runs with at least one false positive: the per-run false-positive
 * rate the README's target refers to.
 *
 * Subsets are drawn without replacement on purpose. A bootstrap would repeat
 * reps, and duplicated reps shrink the measured spread (the SD's df
 * correction assumes independent pairs), so it would report false positives
 * the gate does not make.
 *
 * `--slow` dirs are runs with a known slowdown in the head; for each k this
 * prints which cells were caught.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { analyze, MIN_PAIRS } from './analyze.mjs';

const nonNeutral = (comparison) =>
  comparison.rows.filter((r) => r.verdict === 'regression' || r.verdict === 'improvement');

const describeRow = (r) =>
  `${r.scenario} ${r.phase}:${r.metric} ${r.verdict} ${r.deltaPct === null ? 'from zero' : `${r.deltaPct.toFixed(1)}%`} (band ±${r.noiseBandPct.toFixed(1)}%)`;

/** Rep numbers present in a run, from its meta.json. */
function repsOf(dir) {
  const meta = JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8'));
  return Array.from({ length: meta.reps }, (_, i) => i);
}

/** Every m-element subset of `items`, in order. */
export function subsetsOf(items, m) {
  if (m === 0) return [[]];
  if (items.length < m) return [];
  const [first, ...rest] = items;
  return [...subsetsOf(rest, m - 1).map((s) => [first, ...s]), ...subsetsOf(rest, m)];
}

/** Share of m-rep subsets of an A/A run in which the gate flags anything. */
export function falsePositiveRate(dir, gateK, m) {
  const subsets = subsetsOf(repsOf(dir), m);
  const hits = subsets.filter(
    (resample) =>
      nonNeutral(analyze({ inDir: dir, gateK, resample, write: false }).comparison).length,
  ).length;
  return { rate: hits / subsets.length, runs: subsets.length };
}

function list(argv, flag, fallback) {
  const i = argv.indexOf(flag);
  if (i === -1) return fallback;
  const v = argv[i + 1];
  if (v === undefined || v.startsWith('--')) throw new Error(`${flag} expects a value`);
  return v.split(',').filter(Boolean);
}

function main() {
  const argv = process.argv.slice(2);
  const aa = list(argv, '--aa', []).map((d) => path.resolve(d));
  const slow = list(argv, '--slow', []).map((d) => path.resolve(d));
  const ks = list(argv, '--k', ['2', '2.5', '3', '3.5', '4']).map(Number);
  const subsetArg = list(argv, '--subset', [])[0];
  if (!aa.length && !slow.length) throw new Error('pass --aa and/or --slow result directories');
  // A NaN k makes every band NaN, which no delta exceeds: every run would
  // read as free of false positives.
  if (ks.some((k) => !(k > 0))) throw new Error('--k expects positive numbers');

  for (const k of ks) {
    console.log(`\n== k = ${k}`);
    for (const dir of aa) {
      const fp = nonNeutral(analyze({ inDir: dir, gateK: k, write: false }).comparison);
      const reps = repsOf(dir).length;
      const m = subsetArg === undefined ? reps - 2 : Number(subsetArg);
      // Fewer reps than a cell needs to pair would gate nothing and report 0%.
      if (!Number.isInteger(m) || m < MIN_PAIRS || m > reps) {
        throw new Error(`--subset must be an integer from ${MIN_PAIRS} to ${reps} for ${dir}`);
      }
      const { rate, runs } = falsePositiveRate(dir, k, m);
      console.log(
        `A/A ${path.basename(dir)}: ${fp.length} false positive(s) as recorded; ` +
          `${(rate * 100).toFixed(1)}% of ${runs} runs at R=${m} have one`,
      );
      for (const r of fp) console.log(`   ${describeRow(r)}`);
    }
    for (const dir of slow) {
      const { comparison } = analyze({ inDir: dir, gateK: k, write: false });
      const caught = comparison.rows.filter((r) => r.verdict === 'regression');
      const gated = comparison.rows.filter((r) => r.verdict !== 'not-resolvable');
      console.log(
        `slowed ${path.basename(dir)}: ${caught.length}/${gated.length} resolvable cells flagged`,
      );
      for (const r of gated) console.log(`   ${describeRow(r)}`);
    }
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
