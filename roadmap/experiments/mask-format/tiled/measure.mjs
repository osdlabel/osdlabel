import { TiledMask, T, encodeVarintsB64, decodeVarintsB64 } from './tiled-mask.mjs';
const now = () => performance.now();
const W = 100000,
  H = 80000;
const BOX = { x: 31594, y: 16574, w: 60001, h: 37501 }; // S1 encode region (poc-sam representative.json:1254)
const out = {};

// ---- 1. S1-like synthetic at LEVEL 0 (same shapes as measure-coarse.mjs, analytic) ----
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
let t0 = now();
const runs = [];
let cur = 0,
  len = 0,
  crossings = 0;
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
    if (c) for (let j = 0; j < 1; j++) ivs = subtract(ivs, c);
  }
  for (const [ix, iy] of islands) {
    const s = span(r, cw * ix, ch * iy, cw * 0.008, ch * 0.012);
    if (s) ivs.push(s);
  }
  if (r === 0) ivs.push([0, 1]);
  if (r === ch - 1) ivs.push([cw - 1, cw]);
  ivs = union(ivs);
  crossings += ivs.length;
  let x = 0;
  for (const [a, b] of ivs) {
    app(0, a - x);
    app(1, b - a);
    x = b;
  }
  app(0, cw - x);
}
runs.push(len);
out.s1_level0 = {
  box: `${BOX.w}x${BOX.h}`,
  boxPixels: BOX.w * BOX.h,
  capRatio: +((BOX.w * BOX.h) / 67108864).toFixed(2),
  rowIntervals: crossings,
  runs: runs.length,
  synthMs: +(now() - t0).toFixed(0),
};
t0 = now();
const counts = encodeVarintsB64(runs);
out.s1_level0.canonicalCountsChars = counts.length;
out.s1_level0.varintB64Ms = +(now() - t0).toFixed(1);
let fg = 0;
for (let i = 1; i < runs.length; i += 2) fg += runs[i];
out.s1_level0.foreground = fg;

// ---- 2. decode canonical -> tiles, no dense bbox ----
t0 = now();
const decRuns = decodeVarintsB64(counts);
const tVar = now() - t0;
t0 = now();
const m = TiledMask.fromRowMajorRuns(
  { x: BOX.x, y: BOX.y, width: BOX.w, height: BOX.h },
  decRuns,
  W,
  H,
);
const tDec = now() - t0;
let full = 0;
for (const s of m.state) if (s === 1) full++;
out.decode = {
  varintMs: +tVar.toFixed(0),
  tilesMs: +tDec.toFixed(0),
  fullTiles: full,
  mixedTiles: m.mixedTiles(),
  mixedBytes: m.mixedTiles() * T * T,
  directoryBytes: m.state.length * 3,
  pixelCountExact: m.pixelCount === fg,
  heapMB: +(process.memoryUsage().heapUsed / 2 ** 20).toFixed(0),
  arrayBuffersMB: +(process.memoryUsage().arrayBuffers / 2 ** 20).toFixed(0),
};

// ---- 3. encode from tiles (streamed row-major) and check round trip ----
t0 = now();
const re = m.rowMajorRuns();
const tEnc = now() - t0;
let same = re.runs.length === runs.length;
if (same)
  for (let i = 0; i < runs.length; i++)
    if (re.runs[i] !== runs[i]) {
      same = false;
      break;
    }
out.encode = { runsMs: +tEnc.toFixed(0), roundTripIdentical: same, box: re.box };

// ---- 4. render ----
t0 = now();
const ov = m.renderLevel6({ x: BOX.x, y: BOX.y, width: BOX.w, height: BOX.h });
out.render = { level6OverviewMs: +(now() - t0).toFixed(1), level6Size: `${ov.w}x${ov.h}` };
// a 1000x1000 level-0 window straddling the main ellipse's left edge, mid-height
const ex = BOX.x + Math.round(cw / 2 - cw * 0.46) - 500,
  ey = BOX.y + Math.round(ch / 2) - 500;
t0 = now();
m.renderLevel0({ x: ex, y: ey, width: 1000, height: 1000 });
out.render.level0Window1000Ms = +(now() - t0).toFixed(1);
t0 = now();
m.renderLevel0({
  x: BOX.x + Math.round(cw / 2) - 960,
  y: BOX.y + Math.round(ch / 2) - 540,
  width: 1920,
  height: 1080,
});
out.render.level0InteriorFullHDMs = +(now() - t0).toFixed(1);

// ---- 5. COCO column-major over the full image, from tiles ----
t0 = now();
const coco = m.cocoColumnMajorRuns();
out.coco = { runs: coco.length, ms: +(now() - t0).toFixed(0) };
let tot = 0;
for (const r of coco) tot += r;
out.coco.sumIsImageArea = tot === W * H;

// ---- 6. brush at overview: screen-relative radius on a fresh mask ----
// 60001 px box in a ~1000 css px cell -> d ~ 60 level-0 px per css px.
const d = 60,
  rCss = 20,
  stepCss = 10;
const b = new TiledMask(W, H);
const r = rCss * d,
  step = stepCss * d;
const per = [];
let px = 40000,
  py = 30000;
// scribble-fill a 30000 x 20000 region in horizontal passes spaced 1.5 r
for (let y = 30000; y <= 50000; y += 1.5 * r) {
  const dir = Math.round((y - 30000) / (1.5 * r)) % 2 === 0 ? 1 : -1;
  const xs = dir > 0 ? 40000 : 70000,
    xe = dir > 0 ? 70000 : 40000;
  for (let x = xs; dir > 0 ? x < xe : x > xe; x += dir * step) {
    const s = now();
    b.fillCapsule(px, py, x, y, r, 1);
    per.push(now() - s);
    px = x;
    py = y;
  }
}
per.sort((a, c) => a - c);
const pct = (p) => +per[Math.floor(per.length * p)].toFixed(2);
out.brushOverview = {
  radiusL0: r,
  segmentL0: step,
  segments: per.length,
  msP50: pct(0.5),
  msP95: pct(0.95),
  msMax: +per[per.length - 1].toFixed(2),
  mixedTiles: b.mixedTiles(),
  pixelCount: b.pixelCount,
};
t0 = now();
const br = b.rowMajorRuns();
const tbr = now() - t0;
const bc = encodeVarintsB64(br.runs);
out.brushOverview.box = `${br.box.width}x${br.box.height}`;
out.brushOverview.boxPixels = br.box.width * br.box.height;
out.brushOverview.canonicalCountsChars = bc.length;
out.brushOverview.encodeRunsMs = +tbr.toFixed(0);
// fine refinement at high zoom on the same mask: r = 12, 10 px segments along the edge
const per2 = [];
let qx = 41000,
  qy = 29000;
for (let k = 0; k < 500; k++) {
  const nx = qx + 10,
    ny = qy + Math.sin(k / 10) * 5;
  const s = now();
  b.fillCapsule(qx, qy, nx, ny, 12, k % 2);
  per2.push(now() - s);
  qx = nx;
  qy = ny;
}
per2.sort((a, c) => a - c);
out.brushFine = {
  radiusL0: 12,
  segments: per2.length,
  msP50: +per2[250].toFixed(3),
  msMax: +per2[499].toFixed(3),
};
console.log(JSON.stringify(out, null, 1));
