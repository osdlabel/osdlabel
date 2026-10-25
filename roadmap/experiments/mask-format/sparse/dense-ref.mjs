// Ground truth with the cap lifted: the PoC's real commit math produces the
// dense level-0 snapshot (2.27 GB, which Node can allocate and a browser tab
// realistically cannot), then #149's real encoders run on it.
// Run: node --expose-gc dense-ref.mjs > results/dense-ref.json
import { createHash } from 'node:crypto';
import { buildLogits, FRAME, IMAGE } from './synth.mjs';
import { rasterToMaskSnapshot, rasterImageBounds } from './poc-raster.mjs';
import {
  encodeCanonical,
  snapshotToCocoCounts,
  encodeCocoCountsString,
  snapshotPixelCount,
  DEFAULT_MAX_MASK_PIXELS,
} from './pr149-mask/dist/index.js';

const sha = (s) => createHash('sha256').update(s).digest('hex').slice(0, 16);
const mem = () => {
  globalThis.gc?.();
  const m = process.memoryUsage();
  return {
    rssMB: +(m.rss / 2 ** 20).toFixed(1),
    arrayBuffersMB: +(m.arrayBuffers / 2 ** 20).toFixed(1),
  };
};
const out = { node: process.version, loadavgStart: (await import('node:os')).loadavg() };

const raster = { frame: FRAME, data: buildLogits() };
const box = rasterImageBounds(raster, IMAGE);
out.preCheckBox = {
  ...box,
  area: box.width * box.height,
  capRatio: (box.width * box.height) / DEFAULT_MAX_MASK_PIXELS,
};

let threw = null;
try {
  rasterToMaskSnapshot(raster, IMAGE);
} catch (e) {
  threw = { name: e.name, requested: e.requestedPixels, max: e.maxPixels };
}
out.withDefaultCap = threw;

out.memBefore = mem();
let t = performance.now();
const snap = rasterToMaskSnapshot(raster, IMAGE, { maxPixels: Infinity });
out.rasterToSnapshotMs = +(performance.now() - t).toFixed(0);
out.memAfterSnapshot = mem();
out.snapshot = {
  x: snap.x,
  y: snap.y,
  width: snap.width,
  height: snap.height,
  bytes: snap.data.byteLength,
};

t = performance.now();
out.pixelCount = snapshotPixelCount(snap);
out.pixelCountMs = +(performance.now() - t).toFixed(0);

t = performance.now();
const canon = encodeCanonical(snap);
out.encodeCanonicalMs = +(performance.now() - t).toFixed(0);
out.canonical = {
  countsChars: canon.counts.length,
  jsonBytes: JSON.stringify({ format: 'osdlabel-mask', data: canon }).length,
  countsSha: sha(canon.counts),
};
out.memAfterCanonical = mem();

if (!process.argv.includes('--skip-coco')) {
  t = performance.now();
  const counts = snapshotToCocoCounts(snap);
  out.snapshotToCocoCountsMs = +(performance.now() - t).toFixed(0);
  t = performance.now();
  const str = encodeCocoCountsString(counts);
  out.encodeCocoStringMs = +(performance.now() - t).toFixed(0);
  let maxRun = 0;
  for (const c of counts) if (c > maxRun) maxRun = c;
  out.coco = {
    runs: counts.length,
    maxRun,
    stringChars: str.length,
    stringSha: sha(str),
    uncompressedJsonChars: JSON.stringify(counts).length,
  };
}
out.loadavgEnd = (await import('node:os')).loadavg();
console.log(JSON.stringify(out, null, 2));
