// Level-0 sparse tiled storage vs #149's canonical RLE vs a downsample field,
// for a SAM-like overview mask on the S1 frame (see synth.mjs).
//
// The level-0 mask is produced row by row with the exact arithmetic of
// origin/claude/poc-sam:packages/segmentation/src/raster.ts:139-167
// (bilinear on logits, threshold 0) or 169-177 (nearest on binary), so the
// 2.27 Gpx dense box is never allocated here.
//
// Run: node --expose-gc measure.mjs            (MODE=bilinear, REPS=3)
//      MODE=nearest REPS=1 node --expose-gc measure.mjs
//      ROWS_LIMIT=2048 for a quick dry run.
import os from 'node:os';
import zlib from 'node:zlib';
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { buildLogits, FRAME, IMAGE, topology } from './synth.mjs';
import { rasterImageBounds } from './poc-raster.mjs';
import { encodeVarints, bytesToBase64 } from './pr149-mask/dist/binary.js';
import {
  encodeCanonical,
  encodeCocoCountsString,
  DEFAULT_MAX_MASK_PIXELS,
} from './pr149-mask/dist/index.js';

const MODE = process.env.MODE ?? 'bilinear';
const REPS = +(process.env.REPS ?? 3);
const ROWS_LIMIT = process.env.ROWS_LIMIT ? +process.env.ROWS_LIMIT : Infinity;
const GRID_SCALES = [8, 64, 128, 256];
const T = 256; // tile side, level-0 px
const TT = T * T;
const VW = 1024;
const VH = 768;
const EMPTY = 0;
const FULL = 1;
const MIXED = 2;

const out = {
  mode: MODE,
  reps: REPS,
  node: process.version,
  cpu: os.cpus()[0]?.model,
  loadavgStart: os.loadavg(),
};
const sha = (x) => createHash('sha256').update(x).digest('hex').slice(0, 16);
const abuf = () => {
  globalThis.gc?.();
  return process.memoryUsage().arrayBuffers;
};
const MB = (b) => +(b / 2 ** 20).toFixed(2);
const r1 = (x) => +x.toFixed(1);
function timeit(fn, reps = REPS) {
  const ts = [];
  let result;
  for (let i = 0; i < reps; i++) {
    result = undefined;
    globalThis.gc?.();
    const t = performance.now();
    result = fn();
    ts.push(performance.now() - t);
  }
  ts.sort((a, b) => a - b);
  return {
    result,
    ms: {
      median: r1(ts[Math.floor(ts.length / 2)]),
      min: r1(ts[0]),
      max: r1(ts[ts.length - 1]),
      n: reps,
    },
  };
}
const varintBytes = (v) =>
  v < 128 ? 1 : v < 16384 ? 2 : v < 2097152 ? 3 : v < 268435456 ? 4 : v < 34359738368 ? 5 : 6;
const b64 = (n) => 4 * Math.ceil(n / 3);

// ── The model result ──────────────────────────────────────────────────────
const f = FRAME;
const W = f.width;
const H = f.height;
const L = buildLogits();
const BIN = new Uint8Array(W * H);
for (let i = 0; i < W * H; i++) BIN[i] = L[i] > 0 ? 1 : 0;
out.modelRaster = {
  width: W,
  height: H,
  cellPx: [f.pixelWidth, f.pixelHeight],
  topology: topology(BIN, W, H),
};
const bilinearBox = rasterImageBounds({ frame: f, data: L }, IMAGE);
const nearestBox = rasterImageBounds({ frame: f, data: BIN }, IMAGE);
const preBox = MODE === 'bilinear' ? bilinearBox : nearestBox;
out.preCheckBox = {
  ...preBox,
  area: preBox.width * preBox.height,
  capRatio: r1((preBox.width * preBox.height) / DEFAULT_MAX_MASK_PIXELS),
};
out.nearestPreCheckBox = { ...nearestBox, area: nearestBox.width * nearestBox.height };

// ── Row generators (PoC arithmetic) ───────────────────────────────────────
// gen(y, out, off, x0, x1): writes level-0 pixels [x0, x1) of image row y
// into out[off ...]. Pixels outside `box` are 0, as in the PoC's snapshot.
function makeBilinear(box) {
  const bx = box.x;
  const bw = box.width;
  const ui0 = new Int32Array(bw);
  const ui1 = new Int32Array(bw);
  const fu = new Float32Array(bw);
  for (let c = 0; c < bw; c++) {
    const u = (bx + c + 0.5 - f.originX) / f.pixelWidth - 0.5;
    const u0 = Math.floor(u);
    fu[c] = u - u0;
    ui0[c] = Math.min(W - 1, Math.max(0, u0));
    ui1[c] = Math.min(W - 1, Math.max(0, u0 + 1));
  }
  return function gen(y, o, off, x0, x1) {
    if (y < box.y || y >= box.y + box.height) {
      o.fill(0, off, off + (x1 - x0));
      return;
    }
    const v = (y + 0.5 - f.originY) / f.pixelHeight - 0.5;
    const v0 = Math.floor(v);
    const fv = v - v0;
    const row0 = Math.min(H - 1, Math.max(0, v0)) * W;
    const row1 = Math.min(H - 1, Math.max(0, v0 + 1)) * W;
    const c0 = Math.max(x0, bx) - bx;
    const c1 = Math.min(x1, bx + bw) - bx;
    if (x0 < bx) o.fill(0, off, off + Math.min(bx, x1) - x0);
    if (x1 > bx + bw) o.fill(0, off + Math.max(bx + bw, x0) - x0, off + (x1 - x0));
    const shift = off + bx - x0;
    for (let c = c0; c < c1; c++) {
      const a = L[row0 + ui0[c]];
      const b = L[row0 + ui1[c]];
      const cc = L[row1 + ui0[c]];
      const d = L[row1 + ui1[c]];
      const t = fu[c];
      const top = a + (b - a) * t;
      const bottom = cc + (d - cc) * t;
      o[shift + c] = top + (bottom - top) * fv > 0 ? 1 : 0;
    }
  };
}
function makeNearest(box) {
  const bx = box.x;
  const bw = box.width;
  const nu = new Int32Array(bw);
  for (let c = 0; c < bw; c++) {
    const u = Math.floor((bx + c + 0.5 - f.originX) / f.pixelWidth);
    nu[c] = u >= 0 && u < W ? u : -1;
  }
  return function gen(y, o, off, x0, x1) {
    const v = Math.floor((y + 0.5 - f.originY) / f.pixelHeight);
    if (y < box.y || y >= box.y + box.height || v < 0 || v >= H) {
      o.fill(0, off, off + (x1 - x0));
      return;
    }
    const rb = v * W;
    const c0 = Math.max(x0, bx) - bx;
    const c1 = Math.min(x1, bx + bw) - bx;
    if (x0 < bx) o.fill(0, off, off + Math.min(bx, x1) - x0);
    if (x1 > bx + bw) o.fill(0, off + Math.max(bx + bw, x0) - x0, off + (x1 - x0));
    const shift = off + bx - x0;
    for (let c = c0; c < c1; c++) {
      const u = nu[c];
      o[shift + c] = u >= 0 && BIN[rb + u] !== 0 ? 1 : 0;
    }
  };
}
const makeGen = MODE === 'bilinear' ? makeBilinear : makeNearest;
// Value at a continuous image point (cell centre of a downsampled grid).
function sampleAt(X, Y) {
  if (MODE === 'bilinear') {
    const u = (X - f.originX) / f.pixelWidth - 0.5;
    const u0 = Math.floor(u);
    const t = Math.fround(u - u0);
    const a0 = Math.min(W - 1, Math.max(0, u0));
    const a1 = Math.min(W - 1, Math.max(0, u0 + 1));
    const v = (Y - f.originY) / f.pixelHeight - 0.5;
    const v0 = Math.floor(v);
    const fv = v - v0;
    const row0 = Math.min(H - 1, Math.max(0, v0)) * W;
    const row1 = Math.min(H - 1, Math.max(0, v0 + 1)) * W;
    const top = L[row0 + a0] + (L[row0 + a1] - L[row0 + a0]) * t;
    const bottom = L[row1 + a0] + (L[row1 + a1] - L[row1 + a0]) * t;
    return top + (bottom - top) * fv > 0 ? 1 : 0;
  }
  const u = Math.floor((X - f.originX) / f.pixelWidth);
  const v = Math.floor((Y - f.originY) / f.pixelHeight);
  return u >= 0 && u < W && v >= 0 && v < H && BIN[v * W + u] !== 0 ? 1 : 0;
}

// ── (c) downsample grids: evaluate the model at cell centres ──────────────
function buildGrid(s, box) {
  const gx0 = Math.floor(box.x / s);
  const gy0 = Math.floor(box.y / s);
  const GW = Math.ceil((box.x + box.width) / s) - gx0;
  const GH = Math.ceil((box.y + box.height) / s) - gy0;
  const data = new Uint8Array(GW * GH);
  for (let j = 0; j < GH; j++) {
    const Y = (gy0 + j) * s + s / 2;
    for (let i = 0; i < GW; i++) data[j * GW + i] = sampleAt((gx0 + i) * s + s / 2, Y);
  }
  return { s, gx0, gy0, GW, GH, data };
}
const grids = {};
for (const s of GRID_SCALES) grids[s] = buildGrid(s, preBox);

// ── Analysis pass over the pre-check box ──────────────────────────────────
// Tight bbox, pixel count, boundary length, per-column transitions (for COCO),
// IoU vs every downsample grid and vs the other upsampling of the same raster.
function analysis() {
  const box = preBox;
  const BW = box.width;
  const rows = Math.min(box.height, ROWS_LIMIT);
  const gen = makeGen(box);
  const other = MODE === 'bilinear' ? makeNearest(nearestBox) : null;
  const row = new Uint8Array(BW);
  const prev = new Uint8Array(BW);
  const orow = new Uint8Array(BW);
  const colT = Array.from({ length: BW }, () => []);
  const gs = GRID_SCALES.map((s) => {
    const g = grids[s];
    const colMap = new Int32Array(BW);
    for (let c = 0; c < BW; c++) colMap[c] = Math.floor((box.x + c) / s) - g.gx0;
    return { s, g, colMap, inter: 0, union: 0 };
  });
  let oInter = 0;
  let oUnion = 0;
  let count = 0;
  let hEdges = 0;
  let vEdges = 0;
  let minR = Infinity;
  let maxR = -1;
  let minC = Infinity;
  let maxC = -1;
  let boundaryPoint = null;
  const midRow = Math.floor(rows / 2);
  for (let r = 0; r < rows; r++) {
    const y = box.y + r;
    gen(y, row, 0, box.x, box.x + BW);
    let rc = 0;
    let first = -1;
    let last = -1;
    let h = row[0] + row[BW - 1];
    for (let c = 0; c < BW; c++) {
      const a = row[c];
      rc += a;
      if (a !== prev[c]) colT[c].push(y);
      if (c > 0 && a !== row[c - 1]) h++;
    }
    hEdges += h;
    if (rc > 0) {
      for (let c = 0; c < BW; c++)
        if (row[c]) {
          first = c;
          break;
        }
      for (let c = BW - 1; c >= 0; c--)
        if (row[c]) {
          last = c;
          break;
        }
      if (r < minR) minR = r;
      maxR = r;
      if (first < minC) minC = first;
      if (last > maxC) maxC = last;
    }
    if (r === midRow) {
      // Right edge of the rightmost run: the main island's boundary.
      boundaryPoint = { x: box.x + last + 1, y };
    }
    count += rc;
    for (const q of gs) {
      const gRow = (Math.floor(y / q.s) - q.g.gy0) * q.g.GW;
      const gd = q.g.data;
      const cm = q.colMap;
      let inter = 0;
      let uni = 0;
      for (let c = 0; c < BW; c++) {
        const a = row[c];
        const b = gd[gRow + cm[c]];
        inter += a & b;
        uni += a | b;
      }
      q.inter += inter;
      q.union += uni;
    }
    if (other) {
      other(y, orow, 0, box.x, box.x + BW);
      let inter = 0;
      let uni = 0;
      for (let c = 0; c < BW; c++) {
        inter += row[c] & orow[c];
        uni += row[c] | orow[c];
      }
      oInter += inter;
      oUnion += uni;
    }
    prev.set(row);
  }
  for (let c = 0; c < BW; c++) if (prev[c]) colT[c].push(box.y + rows);
  for (let c = 0; c < BW; c++) vEdges += colT[c].length;
  const tight = {
    x: box.x + minC,
    y: box.y + minR,
    width: maxC - minC + 1,
    height: maxR - minR + 1,
  };
  const edges = hEdges + vEdges;
  const iou = {};
  for (const q of gs) {
    const xor = q.union - q.inter;
    iou[`s${q.s}`] = {
      iou: +(q.inter / q.union).toFixed(6),
      xorPx: xor,
      // Mean boundary displacement ~ XOR area / Euclidean boundary length,
      // with length ~ pixel-edge count * pi/4 for an isotropic curve.
      meanDisplacementPx: r1(xor / (edges * (Math.PI / 4))),
    };
  }
  if (other) {
    const xor = oUnion - oInter;
    iou.nearestUpsampleVsBilinear = {
      iou: +(oInter / oUnion).toFixed(6),
      xorPx: xor,
      meanDisplacementPx: r1(xor / (edges * (Math.PI / 4))),
    };
  }
  return {
    tight,
    pixelCount: count,
    boundaryPxEdges: { h: hEdges, v: vEdges },
    iou,
    colT,
    boundaryPoint,
  };
}
let t0 = performance.now();
const A = analysis();
out.analysisMs = r1(performance.now() - t0);
const tb = A.tight;
out.tightBox = {
  ...tb,
  area: tb.width * tb.height,
  capRatio: r1((tb.width * tb.height) / DEFAULT_MAX_MASK_PIXELS),
};
out.pixelCount = A.pixelCount;
out.boundaryPxEdges = A.boundaryPxEdges;
out.precision = A.iou;
out.boundaryPoint = A.boundaryPoint;

const genT = makeGen(tb);
const ROWS = Math.min(tb.height, ROWS_LIMIT);

// ── Pass 0: rasterize only (the floor for anything that walks level 0) ────
out.genOnly = timeit(() => {
  const row = new Uint8Array(tb.width);
  let chk = 0;
  for (let r = 0; r < ROWS; r++) {
    genT(tb.y + r, row, 0, tb.x, tb.x + tb.width);
    chk += row[r % tb.width];
  }
  return chk;
}).ms;

// ── (b) #149 canonical: row-major LEB128 runs over the tight box ──────────
function canonicalRuns() {
  const BW = tb.width;
  const row = new Uint8Array(BW);
  let runs = new Float64Array(1 << 20);
  let n = 0;
  let cur = 0;
  let start = 0;
  let bytes = 0;
  const push = (len) => {
    if (n === runs.length) {
      const next = new Float64Array(runs.length * 2);
      next.set(runs);
      runs = next;
    }
    runs[n++] = len;
    bytes += varintBytes(len);
  };
  for (let r = 0; r < ROWS; r++) {
    genT(tb.y + r, row, 0, tb.x, tb.x + BW);
    const base = r * BW;
    for (let c = 0; c < BW; c++) {
      if (row[c] !== cur) {
        push(base + c - start);
        start = base + c;
        cur ^= 1;
      }
    }
  }
  push(ROWS * BW - start);
  return { runs: runs.subarray(0, n), n, bytes };
}
const RLE = timeit(canonicalRuns);
const runs = RLE.result.runs;
{
  const t = performance.now();
  const varints = encodeVarints(Array.from(runs)); // #149's own encoder
  const counts = bytesToBase64(varints); // #149's own base64
  const encMs = performance.now() - t;
  const json = JSON.stringify({
    format: 'osdlabel-mask',
    data: {
      x: tb.x,
      y: tb.y,
      width: tb.width,
      height: tb.height,
      imageWidth: IMAGE.width,
      imageHeight: IMAGE.height,
      counts,
    },
  });
  let maxRun = 0;
  for (const v of runs) if (v > maxRun) maxRun = v;
  out.canonical = {
    streamPassMs: RLE.ms,
    pr149EncodeVarintsPlusBase64Ms: r1(encMs),
    runs: RLE.result.n,
    runsPerRow: r1(RLE.result.n / ROWS),
    maxRun,
    varintBytes: RLE.result.bytes,
    varintBytesCheck: varints.length,
    countsChars: counts.length,
    countsSha: sha(counts),
    jsonBytes: json.length,
    gzipJsonBytes: zlib.gzipSync(json).length,
    deflateVarintBytes: zlib.deflateRawSync(varints).length,
  };
}

// ── (a) sparse tiled buffer, image-aligned 256x256 tiles at level 0 ───────
const txMin = Math.floor(tb.x / T);
const txMax = Math.floor((tb.x + tb.width - 1) / T);
const tyMin = Math.floor(tb.y / T);
const tyMax = Math.floor((tb.y + Math.min(tb.height, ROWS) - 1) / T);
const NTX = txMax - txMin + 1;
const NTY = tyMax - tyMin + 1;
const tileKey = (tx, ty) => ty * 65536 + tx;

function packBits(src, off, stride) {
  const bits = new Uint8Array(TT / 8);
  for (let r = 0; r < T; r++) {
    const base = off + r * stride;
    for (let cb = 0; cb < T / 8; cb++) {
      const p = base + cb * 8;
      bits[r * (T / 8) + cb] =
        src[p] |
        (src[p + 1] << 1) |
        (src[p + 2] << 2) |
        (src[p + 3] << 3) |
        (src[p + 4] << 4) |
        (src[p + 5] << 5) |
        (src[p + 6] << 6) |
        (src[p + 7] << 7);
    }
  }
  return bits;
}
function copyTile(src, off, stride) {
  const t = new Uint8Array(TT);
  for (let r = 0; r < T; r++) t.set(src.subarray(off + r * stride, off + r * stride + T), r * T);
  return t;
}

// Naive: rasterize every level-0 pixel of the box, one 256-row band at a time.
function buildTilesNaive(bits) {
  const tiles = new Map();
  const bandW = NTX * T;
  const band = new Uint8Array(T * bandW);
  const yEnd = tb.y + ROWS;
  for (let ty = tyMin; ty <= tyMax; ty++) {
    const y0 = ty * T;
    for (let r = 0; r < T; r++) {
      const y = y0 + r;
      if (y < tb.y || y >= yEnd) band.fill(0, r * bandW, (r + 1) * bandW);
      else genT(y, band, r * bandW, txMin * T, txMin * T + bandW);
    }
    for (let i = 0; i < NTX; i++) {
      const off = i * T;
      let cnt = 0;
      for (let r = 0; r < T; r++) {
        const b = r * bandW + off;
        for (let c = 0; c < T; c++) cnt += band[b + c];
      }
      if (cnt === 0) continue;
      const key = tileKey(txMin + i, ty);
      if (cnt === TT) tiles.set(key, { state: FULL, data: null, count: cnt });
      else
        tiles.set(key, {
          state: MIXED,
          data: bits ? packBits(band, off, bandW) : copyTile(band, off, bandW),
          count: cnt,
        });
    }
  }
  return tiles;
}

// Smart: classify each tile from the logits that can reach it (a bilinear
// value lies within the min/max of its four samples), rasterize only tiles
// the contour crosses.
function tileRangeMinMax(X0, X1, Y0, Y1) {
  let ua;
  let ub;
  let va;
  let vb;
  if (MODE === 'bilinear') {
    ua = Math.floor((X0 + 0.5 - f.originX) / f.pixelWidth - 0.5);
    ub = Math.floor((X1 - 1 + 0.5 - f.originX) / f.pixelWidth - 0.5) + 1;
    va = Math.floor((Y0 + 0.5 - f.originY) / f.pixelHeight - 0.5);
    vb = Math.floor((Y1 - 1 + 0.5 - f.originY) / f.pixelHeight - 0.5) + 1;
  } else {
    ua = Math.floor((X0 + 0.5 - f.originX) / f.pixelWidth);
    ub = Math.floor((X1 - 1 + 0.5 - f.originX) / f.pixelWidth);
    va = Math.floor((Y0 + 0.5 - f.originY) / f.pixelHeight);
    vb = Math.floor((Y1 - 1 + 0.5 - f.originY) / f.pixelHeight);
  }
  ua = Math.min(W - 1, Math.max(0, ua));
  ub = Math.min(W - 1, Math.max(0, ub));
  va = Math.min(H - 1, Math.max(0, va));
  vb = Math.min(H - 1, Math.max(0, vb));
  let mn = Infinity;
  let mx = -Infinity;
  const src = MODE === 'bilinear' ? L : BIN;
  for (let v = va; v <= vb; v++)
    for (let u = ua; u <= ub; u++) {
      const x = src[v * W + u];
      if (x < mn) mn = x;
      if (x > mx) mx = x;
    }
  return MODE === 'bilinear' ? { mn, mx } : { mn: mn - 0.5, mx: mx - 0.5 };
}
function buildTilesSmart(bits) {
  const tiles = new Map();
  const scratch = new Uint8Array(TT);
  const yEnd = tb.y + ROWS;
  const EPS = 1e-6;
  let rasterized = 0;
  for (let ty = tyMin; ty <= tyMax; ty++) {
    for (let tx = txMin; tx <= txMax; tx++) {
      const X0 = tx * T;
      const Y0 = ty * T;
      // Clip to the box: outside it the snapshot is 0.
      const cx0 = Math.max(X0, tb.x);
      const cx1 = Math.min(X0 + T, tb.x + tb.width);
      const cy0 = Math.max(Y0, tb.y);
      const cy1 = Math.min(Y0 + T, yEnd);
      if (cx1 <= cx0 || cy1 <= cy0) continue;
      const { mn, mx } = tileRangeMinMax(cx0, cx1, cy0, cy1);
      const inside = cx0 === X0 && cx1 === X0 + T && cy0 === Y0 && cy1 === Y0 + T;
      if (mx <= -EPS) continue;
      if (inside && mn > EPS) {
        tiles.set(tileKey(tx, ty), { state: FULL, data: null, count: TT });
        continue;
      }
      rasterized++;
      for (let r = 0; r < T; r++) genT(Y0 + r, scratch, r * T, X0, X0 + T);
      let cnt = 0;
      for (let i = 0; i < TT; i++) cnt += scratch[i];
      if (cnt === 0) continue;
      if (cnt === TT) tiles.set(tileKey(tx, ty), { state: FULL, data: null, count: cnt });
      else
        tiles.set(tileKey(tx, ty), {
          state: MIXED,
          data: bits ? packBits(scratch, 0, T) : scratch.slice(),
          count: cnt,
        });
    }
  }
  tiles.rasterized = rasterized;
  return tiles;
}

// Loading #149's canonical runs straight into tiles: no dense box. Spans are
// filled into a 256-row band; tiles are classified from span arithmetic and
// only mixed ones are copied out.
function decodeRunsToTiles(runsArr) {
  const tiles = new Map();
  const BW = tb.width;
  const bandW = NTX * T;
  const band = new Uint8Array(T * bandW);
  const counts = new Float64Array(NTX);
  const colOff = tb.x - txMin * T;
  let ty = Math.floor(tb.y / T);
  const flush = () => {
    for (let i = 0; i < NTX; i++) {
      const cnt = counts[i];
      if (cnt === 0) continue;
      const key = tileKey(txMin + i, ty);
      if (cnt === TT) tiles.set(key, { state: FULL, data: null, count: cnt });
      else tiles.set(key, { state: MIXED, data: copyTile(band, i * T, bandW), count: cnt });
    }
    band.fill(0);
    counts.fill(0);
  };
  let pos = 0;
  let val = 0;
  for (let k = 0; k < runsArr.length; k++) {
    const len = runsArr[k];
    if (val === 1 && len > 0) {
      let p = pos;
      const end = pos + len;
      while (p < end) {
        const r = Math.floor(p / BW);
        const c = p - r * BW;
        const segEnd = Math.min(end, (r + 1) * BW);
        const y = tb.y + r;
        const rty = Math.floor(y / T);
        while (rty > ty) {
          flush();
          ty++;
        }
        const rowInBand = y - ty * T;
        const a = colOff + c;
        const b = colOff + c + (segEnd - p);
        band.fill(1, rowInBand * bandW + a, rowInBand * bandW + b);
        for (let i = Math.floor(a / T); i <= Math.floor((b - 1) / T); i++) {
          counts[i] += Math.min(b, (i + 1) * T) - Math.max(a, i * T);
        }
        p = segEnd;
      }
    }
    pos += len;
    val ^= 1;
  }
  flush();
  return tiles;
}

function tileStats(tiles, bits) {
  let full = 0;
  let mixed = 0;
  let dataBytes = 0;
  for (const t of tiles.values()) {
    if (t.state === FULL) full++;
    else {
      mixed++;
      dataBytes += t.data.byteLength;
    }
  }
  const total = NTX * NTY;
  return {
    gridTiles: total,
    gridDims: [NTX, NTY],
    empty: total - full - mixed,
    full,
    mixed,
    dataBytes,
    directoryBytes: total,
    exactBytes: dataBytes + total,
    bits,
  };
}
function tilesSha(tiles) {
  const h = createHash('sha256');
  const keys = [...tiles.keys()].sort((a, b) => a - b);
  for (const k of keys) {
    const t = tiles.get(k);
    h.update(`${k}:${t.state};`);
    if (t.data) h.update(t.data);
  }
  return h.digest('hex').slice(0, 16);
}

{
  let before = abuf();
  const naiveBytes = timeit(() => buildTilesNaive(false));
  const naiveBytesMem = abuf() - before;
  const naiveBits = timeit(() => buildTilesNaive(true));
  const smartBytes = timeit(() => buildTilesSmart(false));
  const smartBits = timeit(() => buildTilesSmart(true));
  const decoded = timeit(() => decodeRunsToTiles(runs));
  out.sparse = {
    naiveBytes: {
      ms: naiveBytes.ms,
      ...tileStats(naiveBytes.result, false),
      sha: tilesSha(naiveBytes.result),
      measuredArrayBuffersMB: MB(naiveBytesMem),
    },
    naiveBits: {
      ms: naiveBits.ms,
      ...tileStats(naiveBits.result, true),
      sha: tilesSha(naiveBits.result),
    },
    smartBytes: {
      ms: smartBytes.ms,
      ...tileStats(smartBytes.result, false),
      sha: tilesSha(smartBytes.result),
      tilesRasterized: smartBytes.result.rasterized,
    },
    smartBits: {
      ms: smartBits.ms,
      ...tileStats(smartBits.result, true),
      sha: tilesSha(smartBits.result),
    },
    decodeCanonicalToTiles: {
      ms: decoded.ms,
      ...tileStats(decoded.result, false),
      sha: tilesSha(decoded.result),
    },
  };
  out.sparse.agree = {
    naiveVsSmartBytes: out.sparse.naiveBytes.sha === out.sparse.smartBytes.sha,
    naiveVsSmartBits: out.sparse.naiveBits.sha === out.sparse.smartBits.sha,
    naiveVsDecodedFromCanonical:
      out.sparse.naiveBytes.sha === out.sparse.decodeCanonicalToTiles.sha,
  };
  globalThis.__tiles = smartBytes.result;
  globalThis.__tilesBits = smartBits.result;
  // pixel count from tiles must match the analysis pass
  let pc = 0;
  for (const t of smartBytes.result.values()) pc += t.count;
  out.sparse.pixelCountMatches = pc === A.pixelCount || ROWS_LIMIT !== Infinity;

  // Serialized forms. Directory: 2 bits per tile of the bbox's tile grid.
  const dirBytes = Math.ceil((NTX * NTY) / 4);
  const mixedTiles = [...smartBytes.result.values()].filter((t) => t.state === MIXED);
  const mixedBits = [...smartBits.result.values()].filter((t) => t.state === MIXED);
  const catBits = new Uint8Array(mixedBits.length * (TT / 8));
  mixedBits.forEach((t, i) => catBits.set(t.data, i * (TT / 8)));
  let perTileRle = 0;
  for (const t of mixedTiles) {
    let cur = 0;
    let start = 0;
    for (let i = 0; i < TT; i++) {
      if (t.data[i] !== cur) {
        perTileRle += varintBytes(i - start);
        start = i;
        cur ^= 1;
      }
    }
    perTileRle += varintBytes(TT - start);
  }
  const deflated = zlib.deflateRawSync(catBits, { level: 9 }).length;
  out.sparseSerialized = {
    directoryBytes: dirBytes,
    rawBytesTiles: {
      bytes: dirBytes + mixedTiles.length * TT,
      base64Chars: b64(dirBytes + mixedTiles.length * TT),
    },
    bitPacked: { bytes: dirBytes + catBits.length, base64Chars: b64(dirBytes + catBits.length) },
    bitPackedDeflate9: { bytes: dirBytes + deflated, base64Chars: b64(dirBytes + deflated) },
    perTileLeb128Rle: { bytes: dirBytes + perTileRle, base64Chars: b64(dirBytes + perTileRle) },
  };
  // Browser-side cost of drawing mixed tiles as one canvas each (RGBA).
  out.sparse.perTileCanvasRGBA_MB = MB(mixedTiles.length * TT * 4);
}

// ── (c) downsample grids: build, memory, canonical RLE via #149's encoder ─
out.downsample = {};
{
  // Cap-derived factor: smallest power of two whose grid fits 64 Mi px.
  let sCap = 1;
  const gridArea = (s) =>
    (Math.ceil((tb.x + tb.width) / s) - Math.floor(tb.x / s)) *
    (Math.ceil((tb.y + tb.height) / s) - Math.floor(tb.y / s));
  while (gridArea(sCap) > DEFAULT_MAX_MASK_PIXELS) sCap *= 2;
  out.downsample.capDerivedS = sCap;
  for (const s of GRID_SCALES) {
    const g = timeit(() => buildGrid(s, tb));
    const grid = g.result;
    // Tight crop then #149's real encodeCanonical on a grid-unit snapshot.
    let minX = grid.GW;
    let minY = grid.GH;
    let maxX = -1;
    let maxY = -1;
    let cnt = 0;
    for (let j = 0; j < grid.GH; j++)
      for (let i = 0; i < grid.GW; i++)
        if (grid.data[j * grid.GW + i]) {
          cnt++;
          if (i < minX) minX = i;
          if (i > maxX) maxX = i;
          if (j < minY) minY = j;
          if (j > maxY) maxY = j;
        }
    const w = maxX - minX + 1;
    const h = maxY - minY + 1;
    const crop = new Uint8Array(w * h);
    for (let j = 0; j < h; j++)
      crop.set(
        grid.data.subarray((minY + j) * grid.GW + minX, (minY + j) * grid.GW + minX + w),
        j * w,
      );
    const t = performance.now();
    const enc = encodeCanonical({
      x: grid.gx0 + minX,
      y: grid.gy0 + minY,
      width: w,
      height: h,
      data: crop,
      imageWidth: Math.ceil(IMAGE.width / s),
      imageHeight: Math.ceil(IMAGE.height / s),
    });
    const encMs = performance.now() - t;
    const json = JSON.stringify({ format: 'osdlabel-mask', data: { ...enc, downsample: s } });
    out.downsample[`s${s}`] = {
      buildMs: g.ms,
      encodeCanonicalMs: r1(encMs),
      grid: [grid.GW, grid.GH],
      gridPx: grid.GW * grid.GH,
      fitsCap: grid.GW * grid.GH <= DEFAULT_MAX_MASK_PIXELS,
      denseBytes: grid.data.byteLength,
      rgbaCanvasMB: MB(grid.GW * grid.GH * 4),
      tightGrid: [w, h],
      pixelCountLevel0Equiv: cnt * s * s,
      countsChars: enc.counts.length,
      jsonBytes: json.length,
    };
    grids[`tb${s}`] = grid;
  }
}
// The model's own output, for scale: what the information content is.
{
  const binJson = JSON.stringify(
    encodeCanonical({ x: 0, y: 0, width: W, height: H, data: BIN, imageWidth: W, imageHeight: H }),
  );
  const q8 = new Int8Array(W * H);
  for (let i = 0; i < W * H; i++) q8[i] = Math.max(-127, Math.min(127, Math.round(L[i] * 4)));
  out.modelNative = {
    binaryRasterCanonicalJsonBytes: binJson.length,
    logitsFloat32Bytes: L.byteLength,
    logitsFloat32Base64Chars: b64(L.byteLength),
    logitsInt8Bytes: q8.byteLength,
    logitsInt8DeflateBytes: zlib.deflateRawSync(Buffer.from(q8.buffer), { level: 9 }).length,
  };
}

// ── COCO RLE at full image resolution (column-major over 100000 x 80000) ──
function cocoFromColumnFlips(columnFlips) {
  // columnFlips: iterable of [x, ys[]] in ascending x; ys ascending absolute rows.
  const flips = [];
  for (const [x, ys] of columnFlips) for (const y of ys) flips.push(x * IMAGE.height + y);
  // Coincident flips cancel (only possible at column seams).
  const merged = [];
  for (const p of flips) {
    if (merged.length && merged[merged.length - 1] === p) merged.pop();
    else merged.push(p);
  }
  const counts = [];
  let last = 0;
  for (const p of merged) {
    counts.push(p - last);
    last = p;
  }
  counts.push(IMAGE.width * IMAGE.height - last);
  return counts;
}
function cocoSummary(counts) {
  const t = performance.now();
  const str = encodeCocoCountsString(counts); // #149's own encoder
  const ms = performance.now() - t;
  let maxRun = 0;
  for (const c of counts) if (c > maxRun) maxRun = c;
  return {
    runs: counts.length,
    maxRun,
    maxRunFitsUint32: maxRun <= 0xffffffff,
    imagePx: IMAGE.width * IMAGE.height,
    stringChars: str.length,
    stringSha: sha(str),
    encodeMs: r1(ms),
    uncompressedJsonChars: JSON.stringify(counts).length,
    gzipStringBytes: zlib.gzipSync(str).length,
  };
}
out.coco = {};
{
  const t = performance.now();
  const counts = cocoFromColumnFlips(
    (function* () {
      for (let c = 0; c < A.colT.length; c++) if (A.colT[c].length) yield [preBox.x + c, A.colT[c]];
    })(),
  );
  out.coco.level0 = { buildMs: r1(performance.now() - t), ...cocoSummary(counts) };
  for (const s of [8, 128]) {
    const g = grids[`tb${s}`];
    const cnts = cocoFromColumnFlips(
      (function* () {
        for (let i = 0; i < g.GW; i++) {
          const ys = [];
          let prev = 0;
          for (let j = 0; j < g.GH; j++) {
            const v = g.data[j * g.GW + i];
            if (v !== prev) ys.push(Math.min(IMAGE.height, (g.gy0 + j) * s));
            prev = v;
          }
          if (prev) ys.push(Math.min(IMAGE.height, (g.gy0 + g.GH) * s));
          if (!ys.length) continue;
          for (let x = (g.gx0 + i) * s; x < Math.min(IMAGE.width, (g.gx0 + i + 1) * s); x++)
            yield [x, ys];
        }
      })(),
    );
    out.coco[`fromDownsample_s${s}`] = cocoSummary(cnts);
  }
}

// ── Rendering: 1024x768 view ───────────────────────────────────────────────
const MASK_RGB = [33, 150, 243];
const MASK_A = 115; // DEFAULT_MASK_FILL alpha 0.45 (mask-fabric-object.ts:6)
function addRect(cov, sx0, sy0, sx1, sy1) {
  const px0 = Math.max(0, Math.floor(sx0));
  const py0 = Math.max(0, Math.floor(sy0));
  const px1 = Math.min(VW, Math.ceil(sx1));
  const py1 = Math.min(VH, Math.ceil(sy1));
  for (let py = py0; py < py1; py++) {
    const oy = Math.min(py + 1, sy1) - Math.max(py, sy0);
    for (let px = px0; px < px1; px++)
      cov[py * VW + px] += oy * (Math.min(px + 1, sx1) - Math.max(px, sx0));
  }
}
function covToRGBA(cov) {
  const rgba = new Uint8ClampedArray(VW * VH * 4);
  for (let p = 0; p < VW * VH; p++) {
    const a = cov[p];
    if (a <= 0) continue;
    const o = p * 4;
    rgba[o] = MASK_RGB[0];
    rgba[o + 1] = MASK_RGB[1];
    rgba[o + 2] = MASK_RGB[2];
    rgba[o + 3] = Math.round(Math.min(1, a) * MASK_A);
  }
  return rgba;
}
// Overview: whole tight box fitted into the view (S1's own view scale was 0.017).
const z = Math.min(VW / tb.width, VH / tb.height);
const vx = tb.x + tb.width / 2 - VW / z / 2;
const vy = tb.y + tb.height / 2 - VH / z / 2;
out.render = {
  view: [VW, VH],
  overviewScale: +z.toFixed(5),
  level0PxPerScreenPx: r1(1 / z),
  level0PxInOverview: Math.round((VW / z) * (VH / z)),
};

function renderTilesOverview(tiles, k, kind) {
  // kind: 'binary' (0/1 bytes), 'bits' (packed), 'coverage' (0..255 bytes)
  const cov = new Float32Array(VW * VH);
  const span = T << k;
  const cell = 1 << k;
  const scol = new Int32Array(T);
  let touched = 0;
  for (const [key, t] of tiles) {
    const tx = key % 65536;
    const ty = Math.floor(key / 65536);
    const X0 = tx * span;
    const Y0 = ty * span;
    if (t.state === FULL) {
      addRect(cov, (X0 - vx) * z, (Y0 - vy) * z, (X0 + span - vx) * z, (Y0 + span - vy) * z);
      continue;
    }
    touched += TT;
    for (let i = 0; i < T; i++) {
      const sx = Math.floor((X0 + (i + 0.5) * cell - vx) * z);
      scol[i] = sx >= 0 && sx < VW ? sx : -1;
    }
    const w = (cell * z) ** 2 * (kind === 'coverage' ? 1 / 255 : 1);
    const d = t.data;
    for (let j = 0; j < T; j++) {
      const sy = Math.floor((Y0 + (j + 0.5) * cell - vy) * z);
      if (sy < 0 || sy >= VH) continue;
      const base = sy * VW;
      if (kind === 'bits') {
        const ro = j * (T / 8);
        for (let cb = 0; cb < T / 8; cb++) {
          const byte = d[ro + cb];
          if (byte === 0) continue;
          for (let b = 0; b < 8; b++)
            if (byte & (1 << b)) {
              const sx = scol[cb * 8 + b];
              if (sx >= 0) cov[base + sx] += w;
            }
        }
      } else {
        const ro = j * T;
        for (let i = 0; i < T; i++) {
          const v = d[ro + i];
          if (v === 0) continue;
          const sx = scol[i];
          if (sx >= 0) cov[base + sx] += v * w;
        }
      }
    }
  }
  return { rgba: covToRGBA(cov), touched };
}
function renderGridOverview(g) {
  const cov = new Float32Array(VW * VH);
  const w = (g.s * z) ** 2;
  for (let j = 0; j < g.GH; j++) {
    const sy = Math.floor(((g.gy0 + j) * g.s + g.s / 2 - vy) * z);
    if (sy < 0 || sy >= VH) continue;
    for (let i = 0; i < g.GW; i++) {
      if (!g.data[j * g.GW + i]) continue;
      const sx = Math.floor(((g.gx0 + i) * g.s + g.s / 2 - vx) * z);
      if (sx >= 0 && sx < VW) cov[sy * VW + sx] += w;
    }
  }
  return covToRGBA(cov);
}
// #149's renderer path for a grid: one RGBA ImageData over the whole mask
// (mask-fabric-object.ts:55-71), here without the canvas.
function buildImageDataLike(data, w, h) {
  const pixels = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < data.length; i++) {
    if (data[i] !== 1) continue;
    const o = i * 4;
    pixels[o] = MASK_RGB[0];
    pixels[o + 1] = MASK_RGB[1];
    pixels[o + 2] = MASK_RGB[2];
    pixels[o + 3] = MASK_A;
  }
  return pixels;
}
// Pyramid over the sparse tiles: level k tile = 256x256 coverage samples of
// (256 * 2^k)^2 level-0 px, uniform tiles stay flags.
function buildPyramid(level0) {
  const levels = [level0];
  let k = 0;
  while (true) {
    const prev = levels[k];
    const parents = new Map();
    for (const key of prev.keys()) {
      const tx = key % 65536;
      const ty = Math.floor(key / 65536);
      const pk = tileKey(tx >> 1, ty >> 1);
      if (!parents.has(pk)) parents.set(pk, true);
    }
    const next = new Map();
    const fromBinary = k === 0;
    for (const pk of parents.keys()) {
      const PX = pk % 65536;
      const PY = Math.floor(pk / 65536);
      const kids = [];
      let allFull = true;
      for (let dy = 0; dy < 2; dy++)
        for (let dx = 0; dx < 2; dx++) {
          const c = prev.get(tileKey(PX * 2 + dx, PY * 2 + dy));
          kids.push([dx, dy, c]);
          if (!c || c.state !== FULL) allFull = false;
        }
      if (allFull) {
        next.set(pk, { state: FULL, data: null });
        continue;
      }
      const d = new Uint8Array(TT);
      for (const [dx, dy, c] of kids) {
        if (!c) continue;
        const qo = dy * 128 * T + dx * 128;
        if (c.state === FULL) {
          for (let r = 0; r < 128; r++) d.fill(255, qo + r * T, qo + r * T + 128);
          continue;
        }
        const s = c.data;
        for (let r = 0; r < 128; r++) {
          const a = 2 * r * T;
          const b = a + T;
          const o = qo + r * T;
          for (let i = 0; i < 128; i++) {
            const sum = s[a + 2 * i] + s[a + 2 * i + 1] + s[b + 2 * i] + s[b + 2 * i + 1];
            d[o + i] = fromBinary ? Math.round((sum * 255) / 4) : (sum + 2) >> 2;
          }
        }
      }
      next.set(pk, { state: MIXED, data: d });
    }
    levels.push(next);
    k++;
    if (next.size <= 1) break;
  }
  return levels;
}
{
  const tiles = globalThis.__tiles;
  const tilesBits = globalThis.__tilesBits;
  const r0 = timeit(() => renderTilesOverview(tiles, 0, 'binary'));
  const r0b = timeit(() => renderTilesOverview(tilesBits, 0, 'bits'));
  let before = abuf();
  const pyr = timeit(() => buildPyramid(tiles));
  const levels = pyr.result;
  const pyrMem = abuf() - before;
  const perLevel = levels.map((m, k) => {
    let mixed = 0;
    let full = 0;
    for (const t of m.values()) t.state === FULL ? full++ : mixed++;
    return { k, tileSpanLevel0Px: T << k, mixed, full, bytes: mixed * TT };
  });
  const extraBytes = perLevel.slice(1).reduce((a, l) => a + l.bytes, 0);
  // Pyramid level for the overview: finest level not finer than ~1 tile px per screen px.
  let kView = 0;
  while (1 << (kView + 1) <= 1 / z) kView++;
  const rk = timeit(() => renderTilesOverview(levels[kView], kView, 'coverage'));
  out.render.overview = {
    sparseLevel0NoPyramid_bytes: { ms: r0.ms, level0PxRasterized: r0.result.touched },
    sparseLevel0NoPyramid_bits: { ms: r0b.ms, level0PxRasterized: r0b.result.touched },
    pyramid: {
      buildMs: pyr.ms,
      levels: perLevel,
      extraBytesOverLevel0: extraBytes,
      extraVsLevel0: r1((100 * extraBytes) / (perLevel[0].mixed * TT)) + '%',
      measuredArrayBuffersMB: MB(pyrMem),
      renderLevel: kView,
      renderMs: rk.ms,
      tilePxTouched: rk.result.touched,
    },
  };
  for (const s of GRID_SCALES) {
    const g = grids[`tb${s}`];
    const ro = timeit(() => renderGridOverview(g));
    const img = timeit(() => buildImageDataLike(g.data, g.GW, g.GH), Math.min(REPS, 2));
    out.render.overview[`downsample_s${s}`] = {
      onTheFlyMs: ro.ms,
      gridPxRead: g.GW * g.GH,
      pr149StyleImageDataMs: img.ms,
      imageDataMB: MB(g.GW * g.GH * 4),
    };
  }
  // A dense level-0 renderer (#149 today) would need one RGBA image of the box.
  out.render.overview.pr149DenseLevel0ImageDataGB = +((tb.width * tb.height * 4) / 2 ** 30).toFixed(
    2,
  );

  // 1:1 on the boundary.
  const bp = A.boundaryPoint;
  const ox = Math.round(bp.x - VW / 2);
  const oy = Math.round(bp.y - VH / 2);
  function render1to1Tiles() {
    const rgba = new Uint8ClampedArray(VW * VH * 4);
    const st = { empty: 0, full: 0, mixed: 0, level0PxRead: 0, wholeTilePx: 0 };
    for (let ty = Math.floor(oy / T); ty <= Math.floor((oy + VH - 1) / T); ty++)
      for (let tx = Math.floor(ox / T); tx <= Math.floor((ox + VW - 1) / T); tx++) {
        const t = tiles.get(tileKey(tx, ty));
        if (!t) {
          st.empty++;
          continue;
        }
        const x0 = Math.max(ox, tx * T);
        const x1 = Math.min(ox + VW, tx * T + T);
        const y0 = Math.max(oy, ty * T);
        const y1 = Math.min(oy + VH, ty * T + T);
        if (t.state === FULL) st.full++;
        else {
          st.mixed++;
          st.wholeTilePx += TT;
        }
        for (let y = y0; y < y1; y++) {
          const so = ((y - oy) * VW - ox) * 4;
          const to = (y - ty * T) * T - tx * T;
          for (let x = x0; x < x1; x++) {
            if (t.state === MIXED) {
              st.level0PxRead++;
              if (!t.data[to + x]) continue;
            }
            const o = so + x * 4;
            rgba[o] = MASK_RGB[0];
            rgba[o + 1] = MASK_RGB[1];
            rgba[o + 2] = MASK_RGB[2];
            rgba[o + 3] = MASK_A;
          }
        }
      }
    return st;
  }
  function render1to1Grid(g) {
    const rgba = new Uint8ClampedArray(VW * VH * 4);
    const cells = new Set();
    for (let sy = 0; sy < VH; sy++) {
      const j = Math.floor((oy + sy) / g.s) - g.gy0;
      if (j < 0 || j >= g.GH) continue;
      for (let sx = 0; sx < VW; sx++) {
        const i = Math.floor((ox + sx) / g.s) - g.gx0;
        if (i < 0 || i >= g.GW) continue;
        cells.add(j * g.GW + i);
        if (!g.data[j * g.GW + i]) continue;
        const o = (sy * VW + sx) * 4;
        rgba[o] = MASK_RGB[0];
        rgba[o + 1] = MASK_RGB[1];
        rgba[o + 2] = MASK_RGB[2];
        rgba[o + 3] = MASK_A;
      }
    }
    return { gridCellsInView: cells.size };
  }
  const v1 = timeit(render1to1Tiles);
  out.render.oneToOne = {
    view: { x: ox, y: oy, w: VW, h: VH },
    level0PxInView: VW * VH,
    sparse: { ms: v1.ms, ...v1.result },
  };
  for (const s of GRID_SCALES) {
    const r = timeit(() => render1to1Grid(grids[`tb${s}`]));
    out.render.oneToOne[`downsample_s${s}`] = { ms: r.ms, ...r.result };
  }
}

out.loadavgEnd = os.loadavg();
const file = `results/measure-${MODE}${ROWS_LIMIT !== Infinity ? '-dry' : ''}.json`;
writeFileSync(file, JSON.stringify(out, null, 2));
console.log(JSON.stringify(out, null, 2));
