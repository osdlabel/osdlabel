import { pathToFileURL } from 'node:url';
const m = await import(pathToFileURL(process.argv[2] + '/index.js').href);
const [gw, gh, d, band] = process.argv.slice(3).map(Number);
const data = new Uint8Array(gw * gh);
for (let r = 0; r < gh; r++) if (Math.floor(r / band) % 2 === 0) data.fill(1, r * gw, (r + 1) * gw);
const s = {
  x: 0,
  y: 0,
  width: gw,
  height: gh,
  data,
  imageWidth: gw * d,
  imageHeight: gh * d,
  downsample: d,
};
const canon = m.encodeCanonical(s);
const t0 = performance.now();
try {
  const runs = m.snapshotToCocoCounts(s);
  console.log(
    JSON.stringify({
      grid: `${gw}x${gh}`,
      d,
      band,
      canonChars: canon.counts.length,
      cocoRuns: runs.length,
      ms: Math.round(performance.now() - t0),
    }),
  );
} catch (e) {
  console.log(
    JSON.stringify({
      grid: `${gw}x${gh}`,
      d,
      band,
      canonChars: canon.counts.length,
      threw: e.message,
      ms: Math.round(performance.now() - t0),
    }),
  );
}
