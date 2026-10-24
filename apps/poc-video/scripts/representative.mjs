/**
 * Write results/representative.json (the one committed run) from run files.
 *
 *   node scripts/representative.mjs results/run-A.json [--h2 results/run-B.json] [--h3 results/run-C.json]
 *
 * With one file it is that run, compacted. `--h2` / `--h3` replace that
 * block with another run's (H2 needs a quiet host and its own run; H3's axis
 * study reads the H1 run's browser times through `--h1-from`). A replaced
 * block is kept as `h2Replaced` / `h3Replaced`, and `meta.sources` names
 * every run, so nothing is silently dropped.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const APP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const flagFile = (name) => {
  const i = argv.indexOf(name);
  return i === -1 ? null : argv[i + 1];
};
const consumed = new Set();
for (const f of ['--h2', '--h3']) {
  const i = argv.indexOf(f);
  if (i !== -1) consumed.add(i).add(i + 1);
}
const baseFile = argv.find((a, i) => !consumed.has(i));
if (baseFile === undefined) {
  throw new Error('usage: representative.mjs run.json [--h2 run.json] [--h3 run.json]');
}

const base = JSON.parse(fs.readFileSync(baseFile, 'utf8'));
const out = { ...base, meta: { ...base.meta, sources: { main: path.basename(baseFile) } } };
for (const part of ['h2', 'h3']) {
  const file = flagFile(`--${part}`);
  if (file === null || file === undefined) continue;
  const run = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (run[part] === undefined) throw new Error(`${file} has no ${part} block`);
  if (base[part] !== undefined) out[`${part}Replaced`] = base[part];
  out[part] = run[part];
  out.meta.sources[part] = path.basename(file);
  out.meta[`${part}Meta`] = run.meta;
}
const file = path.join(APP_DIR, 'results', 'representative.json');
fs.writeFileSync(file, JSON.stringify(out));
process.stderr.write(
  `wrote ${path.relative(process.cwd(), file)} (${fs.statSync(file).size} bytes)\n`,
);
