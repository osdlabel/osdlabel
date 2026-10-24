/**
 * H1 parser evaluation: correctness against pydicom and parse time, for
 * @osdlabel/dicom's own reader, dicom-parser and dcmjs, over every PoC file.
 */
import fs from 'node:fs';
import path from 'node:path';
import { READERS, compareWithTruth } from './parsers.mjs';

function median(xs) {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.floor(s.length / 2)] : NaN;
}

export function listFiles(dataDir) {
  const out = [];
  for (const role of fs.readdirSync(dataDir).sort()) {
    const d = path.join(dataDir, role);
    if (!fs.statSync(d).isDirectory()) continue;
    for (const f of fs.readdirSync(d).sort()) {
      if (f.endsWith('.dcm')) out.push({ role, key: `${role}/${f}`, path: path.join(d, f) });
    }
  }
  return out;
}

/**
 * Times `parse + extract` (the time to answer the mapping's questions), per
 * reader, header-only and full. Reps alternate readers to share drift.
 */
export function runParserBench({ dataDir, truth, reps = 7 }) {
  const files = listFiles(dataDir);
  const perRole = {};
  const correctness = {};
  for (const r of READERS) correctness[r.name] = { files: 0, ok: 0, failures: [], errors: [] };

  for (const file of files) {
    const bytes = new Uint8Array(fs.readFileSync(file.path));
    const t = truth?.[file.key];
    for (const reader of READERS) {
      const c = correctness[reader.name];
      c.files++;
      try {
        const rec = reader.extract(reader.parse(bytes, false));
        if (t) {
          const mm = compareWithTruth(rec, t);
          if (mm.length === 0) c.ok++;
          else c.failures.push({ file: file.key, mismatches: mm.slice(0, 4) });
        }
      } catch (err) {
        c.errors.push({ file: file.key, error: String(err?.message ?? err).slice(0, 160) });
      }
    }
  }

  // Timing: per role, all files of the role, each rep runs every reader.
  const roles = [...new Set(files.map((f) => f.role))];
  for (const role of roles) {
    const rf = files.filter((f) => f.role === role);
    const blobs = rf.map((f) => new Uint8Array(fs.readFileSync(f.path)));
    const bytes = blobs.reduce((n, b) => n + b.length, 0);
    const res = {};
    for (const mode of ['header', 'full']) {
      for (const reader of READERS) res[`${reader.name}|${mode}`] = [];
      // Warm-up (JIT) once per reader.
      for (const reader of READERS) {
        for (const b of blobs) {
          try {
            reader.extract(reader.parse(b, mode === 'header'));
          } catch {
            /* counted above */
          }
        }
      }
      for (let rep = 0; rep < reps; rep++) {
        const order = rep % 2 === 0 ? READERS : [...READERS].reverse();
        for (const reader of order) {
          const t0 = performance.now();
          for (const b of blobs) {
            try {
              reader.extract(reader.parse(b, mode === 'header'));
            } catch {
              /* counted above */
            }
          }
          res[`${reader.name}|${mode}`].push(performance.now() - t0);
        }
      }
    }
    perRole[role] = {
      files: rf.length,
      mb: +(bytes / 1e6).toFixed(2),
      ms: Object.fromEntries(Object.entries(res).map(([k, v]) => [k, +median(v).toFixed(3)])),
    };
  }
  return { reps, correctness, perRole };
}
