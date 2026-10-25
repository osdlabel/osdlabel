const m = await import(`${process.argv[2]}/index.js`);
const SIDE = 13000;
// rows 0..8999: [0,9000); rows 12990..12999: [12990,13000)
const runs = [];
let cursor = 0;
const fg = [];
for (let r = 0; r < 9000; r++) fg.push([r * SIDE, r * SIDE + 9000]);
for (let r = 12990; r < 13000; r++) fg.push([r * SIDE + 12990, r * SIDE + 13000]);
for (const [s, e] of fg) {
  runs.push(s - cursor, e - s);
  cursor = e;
}
if (cursor < SIDE * SIDE) runs.push(SIDE * SIDE - cursor);
const raster = m.runRaster(
  { x: 0, y: 0, width: SIDE, height: SIDE, imageWidth: 20000, imageHeight: 20000, downsample: 1 },
  runs,
);
let t = performance.now();
const payload = m.encodeCanonical(raster);
console.log(
  'encode ms',
  (performance.now() - t).toFixed(1),
  'counts chars',
  payload.counts.length,
  'cells',
  raster.cellCount,
);
t = performance.now();
const back = m.decodeCanonicalRaster(payload, { maxPixels: Infinity });
console.log('decode-to-runs ms', (performance.now() - t).toFixed(1));
t = performance.now();
const coco = m.snapshotToCocoCounts(back);
console.log('coco ms', (performance.now() - t).toFixed(1), 'coco runs', coco.length);
try {
  m.decodeCanonical(payload);
} catch (e) {
  console.log('dense decode:', e.name, e.message.slice(0, 80));
}
console.log(
  'heap MB',
  (process.memoryUsage().heapUsed / 1e6).toFixed(0),
  'rss MB',
  (process.memoryUsage().rss / 1e6).toFixed(0),
);
