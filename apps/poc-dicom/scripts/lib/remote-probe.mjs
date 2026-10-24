/**
 * H2, real network: open the GTEx slide's base level straight from IDC's
 * public bucket (storage.googleapis.com) with HTTP Range requests — "DICOM
 * on static hosting", no DICOMweb server — using the same
 * createRangeFrameSource the browser uses. Runs in Node (no CORS), so it
 * measures latency and bytes, not rendering.
 */
import { createRangeFrameSource, describePyramid, frameNumberFor } from '@osdlabel/dicom-wsi';

const pct = (xs, p) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? +s[Math.min(s.length - 1, Math.floor(p * s.length))].toFixed(1) : null;
};

export async function remoteProbe(manifest, { frames = 24, concurrency = 6 } = {}) {
  const series = manifest.series.find((s) => s.role === 'sm-jpeg');
  const urls = series.files.map((k) => `${manifest.bucket_base_url}/${k}`);
  let requests = 0;
  let bytes = 0;
  const fetchCounted = async (u, init) => {
    requests++;
    const res = await fetch(u, init);
    const buf = await res.arrayBuffer();
    bytes += buf.byteLength;
    return new Response(buf, { status: res.status, headers: res.headers });
  };
  const src = createRangeFrameSource({ urls, fetch: fetchCounted });
  const t0 = performance.now();
  const instances = await src.instances();
  const metadataMs = performance.now() - t0;
  const metadataRequests = requests;
  const metadataBytes = bytes;
  const pyramid = describePyramid(instances);
  const base = pyramid.levels[pyramid.levels.length - 1];
  // A 6 × 4 block of base-level tiles near the slide centre (a 1:1 viewport).
  const c0 = Math.floor(base.tilesAcross * 0.8);
  const r0 = Math.floor(base.tilesDown * 0.4);
  const tiles = [];
  for (let r = 0; r < 4; r++) for (let c = 0; c < 6; c++) tiles.push(frameNumberFor(base, c0 + c, r0 + r));
  const pick = tiles.slice(0, frames);
  const seq = [];
  for (const n of pick.slice(0, 8)) {
    const t = performance.now();
    await src.frame(base.sopInstanceUid, n);
    seq.push(performance.now() - t);
  }
  const t1 = performance.now();
  const queue = [...pick];
  const par = [];
  await Promise.all(
    Array.from({ length: concurrency }, async () => {
      for (let n = queue.shift(); n !== undefined; n = queue.shift()) {
        const t = performance.now();
        await src.frame(base.sopInstanceUid, n);
        par.push(performance.now() - t);
      }
    }),
  );
  const parallelWallMs = performance.now() - t1;
  return {
    host: new URL(urls[0]).host,
    instances: urls.length,
    metadataMs: +metadataMs.toFixed(1),
    metadataRequests,
    metadataBytes,
    sequentialFrameMs: { median: pct(seq, 0.5), p90: pct(seq, 0.9), n: seq.length },
    parallel: { frames: pick.length, concurrency, wallMs: +parallelWallMs.toFixed(1), perFrameMedianMs: pct(par, 0.5), perFrameP90Ms: pct(par, 0.9) },
    totalRequests: requests,
    totalBytes: bytes,
  };
}
