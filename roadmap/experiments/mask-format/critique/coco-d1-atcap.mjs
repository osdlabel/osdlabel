import { pathToFileURL } from 'node:url';
const m = await import(pathToFileURL(process.argv[2] + '/index.js').href);
const gw = 8192,
  gh = 8192;
const data = new Uint8Array(gw * gh);
for (let r = 0; r < gh; r += 2) data.fill(1, r * gw, (r + 1) * gw);
const s = { x: 0, y: 0, width: gw, height: gh, data, imageWidth: 100000, imageHeight: 80000 };
const t0 = performance.now();
const runs = m.snapshotToCocoCounts(s);
console.log(
  JSON.stringify({
    d: 1,
    cells: gw * gh,
    cocoRuns: runs.length,
    ms: Math.round(performance.now() - t0),
  }),
);
