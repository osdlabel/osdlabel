// Writes results/representative.json (the one run committed to git) from ONE
// benchmark result file: every suite as measured, per-sample timing arrays
// dropped (their stats are kept) and floats rounded. It no longer merges runs:
// a merge mixed rows measured hours apart, and kept frame statistics taken
// before the main-thread measurement was fixed.
//
//   node scripts/representative.mjs results/run-<stamp>.json
//   pnpm exec prettier --write results/representative.json   (so `pnpm format` is a no-op)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.resolve(HERE, '..', 'results', 'representative.json');

const isNumbers = (v) => Array.isArray(v) && v.every((x) => typeof x === 'number');
const strip = (v) => {
  if (Array.isArray(v)) return v.map(strip);
  if (v && typeof v === 'object') {
    const o = {};
    for (const [k, x] of Object.entries(v)) {
      // Stats.samples (raw timings); the responsiveness suite's records, also
      // called samples, are objects and stay.
      if (k === 'samples' && isNumbers(x)) continue;
      o[k] = strip(x);
    }
    return o;
  }
  return typeof v === 'number' && !Number.isInteger(v) ? Math.round(v * 1000) / 1000 : v;
};

const files = process.argv.slice(2);
if (files.length !== 1)
  throw new Error('usage: node scripts/representative.mjs <one results file>');
const run = JSON.parse(fs.readFileSync(files[0], 'utf8'));
fs.writeFileSync(OUT, `${JSON.stringify(strip({ source: path.basename(files[0]), ...run }))}\n`);
console.log(
  `wrote ${path.relative(process.cwd(), OUT)} (${(fs.statSync(OUT).size / 1024).toFixed(0)} KiB)`,
);
