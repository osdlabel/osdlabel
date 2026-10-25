// Does the cell cap bound COCO export at d>1? Build an alternating-row mask
// (worst case for column-major runs) at d and at d=1 with the same cell grid.
import { pathToFileURL } from 'node:url';
const dir = process.argv[2];
const m = await import(pathToFileURL(dir + '/index.js').href);
function stripes(gw, gh, d, W, H) {
  const data = new Uint8Array(gw * gh);
  for (let r = 0; r < gh; r += 2) data.fill(1, r * gw, (r + 1) * gw);
  return {
    x: 0,
    y: 0,
    width: gw,
    height: gh,
    data,
    imageWidth: W,
    imageHeight: H,
    ...(d > 1 ? { downsample: d } : {}),
  };
}
for (const [gw, gh, d] of [
  [1000, 500, 1],
  [1000, 500, 4],
  [1000, 500, 16],
  [2000, 1000, 16],
]) {
  const W = gw * d,
    H = gh * d;
  const s = stripes(gw, gh, d, W, H);
  const canon = m.encodeCanonical(s);
  const t0 = performance.now();
  const runs = m.snapshotToCocoCounts(s);
  const ms = performance.now() - t0;
  const str = m.encodeCocoCountsString ? m.encodeCocoCountsString(runs).length : NaN;
  console.log(
    JSON.stringify({
      grid: `${gw}x${gh}`,
      d,
      image: `${W}x${H}`,
      cells: gw * gh,
      canonicalCountsChars: canon.counts.length,
      cocoRuns: runs.length,
      cocoChars: str,
      ms: Math.round(ms),
    }),
  );
}
// Extrapolate: whole 100k x 80k slide at d=16 (grid 6250x5000, 31.25M cells) striped
console.log(
  'extrapolated cocoRuns for 6250x5000 grid at d=16 =',
  100000 * 5000,
  '(each column: 5000 runs)',
);
