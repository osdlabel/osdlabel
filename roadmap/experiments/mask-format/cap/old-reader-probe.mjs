// What a #149 reader does with a hypothetical downsampled payload written under the SAME
// 'osdlabel-mask' string: a k=4 grid mask covering level-0 (10000..18000)^2, stored in grid units.
import { encodeCanonical, decodeCanonical, snapshotPixelCount } from '../out/index.js';
const k = 4,
  W = 100_000,
  H = 80_000;
const g = 2000; // grid cells per side
const grid = {
  x: 10_000 / k,
  y: 10_000 / k,
  width: g,
  height: g,
  data: new Uint8Array(g * g).fill(1),
  imageWidth: W,
  imageHeight: H,
};
const payload = { ...encodeCanonical(grid), scale: k }; // new writer adds a field
const snap = decodeCanonical(payload); // old reader: unknown field ignored, no error
console.log(
  'old reader box:',
  snap.x,
  snap.y,
  snap.width,
  'x',
  snap.height,
  '| pixelCount',
  snapshotPixelCount(snap),
  '| true level-0 box: 10000 10000 8000 x 8000, area',
  8000 * 8000,
);
