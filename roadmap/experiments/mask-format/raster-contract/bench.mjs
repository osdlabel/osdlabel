// Usage: node bench.mjs <dist dir>. Times the dense-snapshot codec paths.
const dir = process.argv[2];
const m = await import(`${dir}/index.js`);
function time(label, reps, fn) {
  const ms = [];
  let out;
  for (let i = 0; i < reps; i++) {
    const t = performance.now();
    out = fn();
    ms.push(performance.now() - t);
  }
  ms.sort((a, b) => a - b);
  console.log(
    `${label}: median ${ms[Math.floor(reps / 2)].toFixed(1)} ms (min ${ms[0].toFixed(1)})`,
  );
  return out;
}
// A filled disc with a ring hole, 8000x8000 box, on a 100k x 80k image.
const W = 8000,
  H = 8000;
const data = new Uint8Array(W * H);
for (let y = 0; y < H; y++)
  for (let x = 0; x < W; x++) {
    const r = Math.hypot(x - 4000, y - 4000);
    if (r < 3990 && !(r > 1500 && r < 1600)) data[y * W + x] = 1;
  }
const snap = {
  x: 20000,
  y: 30000,
  width: W,
  height: H,
  data,
  imageWidth: 100000,
  imageHeight: 80000,
};
const raster = m.denseRaster ? m.denseRaster(snap) : snap;
const enc = time('encodeCanonical(dense)', 5, () => m.encodeCanonical(snap));
console.log('counts chars', enc.counts.length);
time('decodeCanonical -> dense', 5, () => m.decodeCanonical(enc));
if (m.decodeCanonicalRaster)
  time('decodeCanonicalRaster -> runs', 5, () => m.decodeCanonicalRaster(enc));
const coco = time('snapshotToCocoCounts(dense)', 3, () => m.snapshotToCocoCounts(snap));
console.log('coco runs', coco.length);
if (m.decodeCanonicalRaster) {
  const runs = m.decodeCanonicalRaster(enc);
  const c2 = time('snapshotToCocoCounts(run raster)', 3, () => m.snapshotToCocoCounts(runs));
  console.log('coco identical', c2.length === coco.length && c2.every((v, i) => v === coco[i]));
  time('encodeCanonical(run raster)', 5, () => m.encodeCanonical(runs));
}
