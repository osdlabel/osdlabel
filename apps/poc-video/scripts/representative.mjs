/**
 * Write results/representative.json (the one committed run) from run files.
 *
 *   node scripts/representative.mjs results/run-A.json [--h2 results/run-B.json]
 *
 * With one file it is that run, compacted. `--h2` replaces the H2 block with
 * another run's (for when the main run's H2 cells ran while the shared host
 * was loaded by other work); the replaced block is kept as `h2Replaced` and
 * `meta.sources` names both runs, so nothing is silently dropped.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const APP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const h2At = argv.indexOf('--h2');
const h2File = h2At === -1 ? null : argv[h2At + 1];
const baseFile = argv.find((a, i) => !a.startsWith('--') && (h2At === -1 || i !== h2At + 1));
if (baseFile === undefined) throw new Error('usage: representative.mjs run.json [--h2 run.json]');

const base = JSON.parse(fs.readFileSync(baseFile, 'utf8'));
const out = { ...base, meta: { ...base.meta, sources: { main: path.basename(baseFile) } } };
if (h2File !== null && h2File !== undefined) {
  const h2Run = JSON.parse(fs.readFileSync(h2File, 'utf8'));
  if (h2Run.h2 === undefined) throw new Error(`${h2File} has no h2 block`);
  out.h2Replaced = base.h2 ?? null;
  out.h2 = h2Run.h2;
  out.meta.sources.h2 = path.basename(h2File);
  out.meta.h2Meta = h2Run.meta;
}
const file = path.join(APP_DIR, 'results', 'representative.json');
fs.writeFileSync(file, JSON.stringify(out));
process.stderr.write(
  `wrote ${path.relative(process.cwd(), file)} (${fs.statSync(file).size} bytes)\n`,
);
