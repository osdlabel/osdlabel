/**
 * Fetch the PoC's public DICOM data (see data-manifest.json) into ./data.
 *
 *   node scripts/fetch-data.mjs [--only ct,mr,...]
 *
 * Files come from the NCI Imaging Data Commons public bucket on GCS
 * (storage.googleapis.com/idc-open-data), all CC BY 3.0/4.0. Nothing fetched
 * here is committed: ./data is gitignored. A series whose manifest entry has
 * `fetch.range_bytes` is fetched header-only with an HTTP Range request — the
 * same trick a browser adapter can use to read metadata without the pixels.
 *
 * Idempotent: a file already present with the expected size is skipped.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const APP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DATA_DIR = path.join(APP_DIR, 'data');
export const MANIFEST = JSON.parse(
  fs.readFileSync(path.join(APP_DIR, 'data-manifest.json'), 'utf8'),
);

async function fetchWithRetry(url, init, attempts = 4) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(url, init);
      if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
      return new Uint8Array(await res.arrayBuffer());
    } catch (err) {
      lastErr = err;
      await new Promise((r) => setTimeout(r, 1000 * 2 ** i));
    }
  }
  throw lastErr;
}

/** Local path of a manifest file entry. */
export function localPath(role, key) {
  return path.join(DATA_DIR, role, path.basename(key));
}

export async function fetchAll(onlyRoles) {
  const summary = [];
  for (const s of MANIFEST.series) {
    if (onlyRoles && !onlyRoles.includes(s.role)) continue;
    const dir = path.join(DATA_DIR, s.role);
    fs.mkdirSync(dir, { recursive: true });
    const header = typeof s.fetch === 'object' ? s.fetch : null;
    const files = header ? s.files.slice(0, header.max_instances) : s.files;
    let bytes = 0;
    let fetched = 0;
    // Small concurrency pool: the CT/MR stacks are dozens of small files.
    const queue = [...files];
    const worker = async () => {
      for (let key = queue.shift(); key !== undefined; key = queue.shift()) {
        const dest = localPath(s.role, key);
        if (fs.existsSync(dest) && fs.statSync(dest).size > 0) {
          bytes += fs.statSync(dest).size;
          continue;
        }
        const url = `${MANIFEST.bucket_base_url}/${key}`;
        const init = header ? { headers: { Range: `bytes=0-${header.range_bytes - 1}` } } : {};
        const data = await fetchWithRetry(url, init);
        fs.writeFileSync(dest + '.part', data);
        fs.renameSync(dest + '.part', dest);
        bytes += data.byteLength;
        fetched++;
      }
    };
    await Promise.all([worker(), worker(), worker(), worker()]);
    summary.push({ role: s.role, files: files.length, fetched, mb: +(bytes / 1e6).toFixed(2) });
  }
  return summary;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const i = process.argv.indexOf('--only');
  const only = i === -1 ? undefined : process.argv[i + 1].split(',');
  const summary = await fetchAll(only);
  console.table(summary);
}
