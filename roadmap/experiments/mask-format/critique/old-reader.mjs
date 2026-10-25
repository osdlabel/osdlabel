import { pathToFileURL } from 'node:url';
const neu = await import(pathToFileURL(process.argv[2] + '/index.js').href);
const old = await import(pathToFileURL(process.argv[3] + '/index.js').href);
function tryOld(label, payload) {
  const { downsample, ...stripped } = payload; // valibot v.object strips it
  try {
    const s = old.decodeCanonical(stripped);
    console.log(label, 'OLD DECODED', s.x, s.y, s.width, s.height);
  } catch (e) {
    console.log(label, 'old refuses:', e.name, e.message.slice(0, 100));
  }
}
// d=2..256 on a range of box sizes, incl. image-edge-clipped boxes
let silent = 0,
  n = 0;
for (const d of [2, 4, 8, 16, 64, 256]) {
  for (const [W, H] of [
    [37, 23],
    [1001, 601],
    [100000, 80000],
    [3, 3],
    [2, 2],
    [d + 1, d + 1],
  ]) {
    const b = new neu.BoundedDenseMaskBuffer({ imageWidth: W, imageHeight: H, downsample: d });
    // paint a dab at several places incl. the far corner
    try {
      for (const [x, y] of [
        [0, 0],
        [W - 1, H - 1],
        [W / 2, H / 2],
      ])
        neu.stampCircle(b, x, y, 1, 1);
    } catch {
      continue;
    }
    const p = neu.encodeCanonical(b.snapshot());
    n++;
    const { downsample, ...stripped } = p;
    try {
      old.decodeCanonical(stripped);
      silent++;
      console.log('SILENT ACCEPT', d, W, H, JSON.stringify(stripped).slice(0, 120));
    } catch {}
  }
}
console.log('payloads', n, 'silently accepted by old reader:', silent);
// single far-corner cell
for (const d of [2, 4]) {
  const W = 2 * d + 1,
    H = 2 * d + 1;
  const b = new neu.BoundedDenseMaskBuffer({ imageWidth: W, imageHeight: H, downsample: d });
  neu.stampCircle(b, W - 0.5, H - 0.5, 0.1, 1);
  const p = neu.encodeCanonical(b.snapshot());
  console.log('corner', JSON.stringify(p));
  tryOld('corner d=' + d, p);
}
