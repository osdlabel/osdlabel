// Merges benchmark result files into results/representative.json (the one
// run committed to git), dropping per-sample arrays and keeping their stats.
//
//   node scripts/representative.mjs results/run-a.json [results/run-b.json ...]
//   pnpm exec prettier --write results/representative.json   (so `pnpm format` is a no-op)
//
// Later files' e2e / remote runs are appended; their H1 rows replace earlier
// rows of the same configuration.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.resolve(HERE, '..', 'results', 'representative.json');

const strip = (v) => {
  if (Array.isArray(v)) return v.map(strip);
  if (v && typeof v === 'object') {
    const o = {};
    for (const [k, x] of Object.entries(v)) {
      if (k === 'samples') continue;
      o[k] = strip(x);
    }
    return o;
  }
  return typeof v === 'number' && !Number.isInteger(v) ? Math.round(v * 1000) / 1000 : v;
};

const key = (r) => JSON.stringify(r.config);
const merged = { sources: [], native: [], models: [], e2e: [], remote: [], f16check: [] };
for (const file of process.argv.slice(2)) {
  const r = JSON.parse(fs.readFileSync(file, 'utf8'));
  merged.sources.push({ file: path.basename(file), meta: r.meta });
  for (const k of ['native', 'models']) {
    for (const row of r[k] ?? []) {
      const i = merged[k].findIndex((x) => key(x) === key(row));
      if (i === -1) merged[k].push(row);
      else merged[k][i] = row;
    }
  }
  for (const run of r.e2e ?? []) merged.e2e.push({ ...run, source: path.basename(file) });
  for (const run of r.remote ?? []) merged.remote.push({ ...run, source: path.basename(file) });
  merged.f16check.push(...(r.f16check ?? []));
}
fs.writeFileSync(OUT, `${JSON.stringify(strip(merged))}\n`);
console.log(
  `wrote ${path.relative(process.cwd(), OUT)} (${(fs.statSync(OUT).size / 1024).toFixed(0)} KiB)`,
);
