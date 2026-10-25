import { TiledMask, encodeVarintsB64, decodeVarintsB64 } from './tiled-mask.mjs';
import { rowMajorRunsFast } from './encode-fast.mjs';
import { readFileSync } from 'node:fs';
// rebuild S1-like payload exactly as measure.mjs does, by importing its generator would re-run everything; re-derive quickly:
const W = 100000,
  H = 80000,
  BOX = { x: 31594, y: 16574, w: 60001, h: 37501 };
const span = (r, cx, cy, rx, ry) => {
  const dy = (r + 0.5 - cy) / ry;
  if (Math.abs(dy) > 1) return null;
  const half = rx * Math.sqrt(1 - dy * dy);
  const a = Math.ceil(cx - half - 0.5),
    b = Math.floor(cx + half - 0.5);
  return a <= b ? [a, b + 1] : null;
};
const union = (ivs) => {
  ivs.sort((p, q) => p[0] - q[0]);
  const o = [];
  for (const iv of ivs) {
    const l = o[o.length - 1];
    if (l && iv[0] <= l[1]) l[1] = Math.max(l[1], iv[1]);
    else o.push([iv[0], iv[1]]);
  }
  return o;
};
const subtract = (ivs, cut) => {
  const o = [];
  for (const [a, b] of ivs) {
    if (cut[1] <= a || cut[0] >= b) {
      o.push([a, b]);
      continue;
    }
    if (cut[0] > a) o.push([a, cut[0]]);
    if (cut[1] < b) o.push([cut[1], b]);
  }
  return o;
};
const cw = BOX.w,
  ch = BOX.h;
const holes = [
  [0.35, 0.4],
  [0.62, 0.38],
  [0.45, 0.65],
  [0.7, 0.6],
];
const islands = [];
for (let k = 0; k < 14; k++) {
  const bx = k % 2 === 0 ? 0.02 + (k / 14) * 0.96 : 0.02 + ((k - 1) / 14) * 0.96;
  const by = k % 2 === 0 ? 0.02 : 0.97;
  islands.push([bx + 0.01, by]);
}
const runs = [];
let cur = 0,
  len = 0;
const app = (v, n) => {
  if (n <= 0) return;
  if (v === cur) {
    len += n;
    return;
  }
  runs.push(len);
  cur = v;
  len = n;
};
for (let r = 0; r < ch; r++) {
  let ivs = [];
  const m = span(r, cw / 2, ch / 2, cw * 0.46, ch * 0.45);
  if (m) ivs.push(m);
  for (const [hx, hy] of holes) {
    const c = span(r, cw * hx, ch * hy, cw * 0.05, ch * 0.06);
    if (c) ivs = subtract(ivs, c);
  }
  for (const [ix, iy] of islands) {
    const s = span(r, cw * ix, ch * iy, cw * 0.008, ch * 0.012);
    if (s) ivs.push(s);
  }
  if (r === 0) ivs.push([0, 1]);
  if (r === ch - 1) ivs.push([cw - 1, cw]);
  ivs = union(ivs);
  let x = 0;
  for (const [a, b] of ivs) {
    app(0, a - x);
    app(1, b - a);
    x = b;
  }
  app(0, cw - x);
}
runs.push(len);
const m = TiledMask.fromRowMajorRuns(
  { x: BOX.x, y: BOX.y, width: BOX.w, height: BOX.h },
  runs,
  W,
  H,
);
const res = {};
for (let rep = 0; rep < 3; rep++) {
  let t = performance.now();
  const fast = rowMajorRunsFast(m);
  const tf = performance.now() - t;
  t = performance.now();
  const c = encodeVarintsB64(fast.runs);
  const tb = performance.now() - t;
  let same = fast.runs.length === runs.length;
  if (same)
    for (let i = 0; i < runs.length; i++)
      if (fast.runs[i] !== runs[i]) {
        same = false;
        break;
      }
  t = performance.now();
  const m2 = TiledMask.fromRowMajorRuns(fast.box, decodeVarintsB64(c), W, H);
  const td = performance.now() - t;
  res['rep' + rep] = {
    fastRunsMs: +tf.toFixed(1),
    varintB64Ms: +tb.toFixed(1),
    identical: same,
    decodeToTilesMs: +td.toFixed(1),
    commitRoundTripMs: +(tf + tb + td).toFixed(0),
  };
}
console.log(JSON.stringify(res));
