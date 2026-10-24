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

/** A readable message for whatever a reader threw (dicom-parser throws `{ exception, dataSet }`). */
function errorText(err) {
  if (err && typeof err === 'object' && 'exception' in err) return String(err.exception);
  return String(err?.message ?? err);
}

/**
 * Correctness against pydicom, in both modes each reader offers:
 *
 *   header: stop at Pixel Data (`untilTag`), which is all the mapping needs and
 *           the only mode that makes sense for a Range-fetched header prefix;
 *   full:   parse everything. A file that is a Range prefix (us-ceus) is cut
 *           mid-element, so here each reader is allowed its own documented
 *           recovery: @osdlabel/dicom returns `truncated: true`, dicom-parser
 *           throws `{ exception, dataSet }` with the elements parsed so far
 *           (`recovered` counts those), dcmjs runs with `ignoreErrors`.
 *
 * An earlier version ran only full mode, without recovery, and counted
 * dicom-parser's throw on the Range prefix as a failure; that was a harness
 * artifact, not a dicom-parser limitation.
 */
function checkCorrectness(files, truth) {
  const out = { header: {}, full: {} };
  for (const mode of ['header', 'full'])
    for (const r of READERS)
      out[mode][r.name] = { files: 0, ok: 0, recovered: 0, failures: [], errors: [] };

  for (const file of files) {
    const bytes = new Uint8Array(fs.readFileSync(file.path));
    const t = truth?.[file.key];
    for (const mode of ['header', 'full']) {
      for (const reader of READERS) {
        const c = out[mode][reader.name];
        c.files++;
        let parsed;
        let recovered = false;
        try {
          parsed = reader.parse(bytes, mode === 'header');
        } catch (err) {
          const partial = mode === 'full' ? reader.recover?.(err) : undefined;
          if (partial === undefined) {
            c.errors.push({ file: file.key, error: errorText(err).slice(0, 160) });
            continue;
          }
          parsed = partial;
          recovered = true;
          c.recovered++;
        }
        try {
          const rec = reader.extract(parsed);
          if (!t) continue;
          const mm = compareWithTruth(rec, t);
          if (mm.length === 0) c.ok++;
          else c.failures.push({ file: file.key, recovered, mismatches: mm.slice(0, 4) });
        } catch (err) {
          c.errors.push({ file: file.key, error: errorText(err).slice(0, 160) });
        }
      }
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
  const correctnessByMode = checkCorrectness(files, truth);
  // `correctness` (the headline) is header mode: what the adapter's mapping actually reads.
  const correctness = correctnessByMode.header;

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
  return { reps, correctness, correctnessByMode, perRole };
}
