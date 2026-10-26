// Cost of "is any painted cell within R of point p?" on #149's masks, through
// the MaskRaster contract of 97f1c87. Usage: node proximity-bench.mjs <path to built mask dist/index.js>
import { performance } from 'node:perf_hooks';

const mask = await import(process.argv[2]);
const { encodeCanonical, decodeCanonicalRaster, denseRaster, BoundedDenseMaskBuffer } = mask;

// ── deterministic RNG ──────────────────────────────────────────────────────
let seed = 0x9e3779b9;
const rand = () => {
  seed ^= seed << 13;
  seed >>>= 0;
  seed ^= seed >>> 17;
  seed ^= seed << 5;
  seed >>>= 0;
  return seed / 4294967296;
};

// empty disc around the miss probe; > the largest R tested where the box allows it
const holeFor = (side) => (side >= 8192 ? 2100 : side >= 4096 ? 600 : 200);

function fillDisc(data, side, cx, cy, r, v) {
  const y0 = Math.max(0, Math.ceil(cy - r - 0.5));
  const y1 = Math.min(side - 1, Math.floor(cy + r - 0.5));
  for (let y = y0; y <= y1; y++) {
    const dy = y + 0.5 - cy;
    const h2 = r * r - dy * dy;
    if (h2 < 0) continue;
    const h = Math.sqrt(h2);
    const x0 = Math.max(0, Math.ceil(cx - h - 0.5));
    const x1 = Math.min(side - 1, Math.floor(cx + h - 0.5));
    if (x1 >= x0) data.fill(v, y * side + x0, y * side + x1 + 1);
  }
}

/** Builds a side x side mask box placed at (ox, oy) on a large image. */
function buildShape(kind, side) {
  const data = new Uint8Array(side * side);
  const c = side / 2;
  if (kind === 'blob') {
    fillDisc(data, side, c, c, side * 0.48, 1);
  } else if (kind === 'scatter') {
    // CAMELYON-like: separate lesions inside one mask; ~5% cover
    const target = side * side * 0.05;
    let painted = 0;
    while (painted < target) {
      const r = 8 + rand() * (side / 64);
      fillDisc(data, side, r + rand() * (side - 2 * r), r + rand() * (side - 2 * r), r, 1);
      painted += Math.PI * r * r;
    }
  } else if (kind === 'noise') {
    // pathological: 2x2 specks at ~3% density, so spans number in the millions
    const n = Math.floor((side * side * 0.03) / 4);
    for (let i = 0; i < n; i++) {
      const x = Math.floor(rand() * (side - 2));
      const y = Math.floor(rand() * (side - 2));
      data[y * side + x] = data[y * side + x + 1] = 1;
      data[(y + 1) * side + x] = data[(y + 1) * side + x + 1] = 1;
    }
  }
  // The miss probe: centre of an empty hole well inside the box.
  fillDisc(data, side, c, c, holeFor(side), 0);
  // Keep the box tight-ish: make sure the corners rows/cols are touched so the box is side x side.
  data[0] = 1;
  data[side * side - 1] = 1;
  return data;
}

// ── the queries ────────────────────────────────────────────────────────────
// p and R in cells. "Touches" = a painted cell whose centre is within R of p,
// the same criterion stampCircle uses to paint a cell.

function bboxCheck(box, px, py, R) {
  return (
    px + R >= box.x &&
    px - R <= box.x + box.width &&
    py + R >= box.y &&
    py - R <= box.y + box.height
  );
}

/** Per-cell get() over the disc, early exit on hit. */
function getScan(raster, px, py, R) {
  const y0 = Math.ceil(py - R - 0.5),
    y1 = Math.floor(py + R - 0.5);
  for (let cy = y0; cy <= y1; cy++) {
    const dy = cy + 0.5 - py;
    const h2 = R * R - dy * dy;
    if (h2 < 0) continue;
    const h = Math.sqrt(h2);
    const x0 = Math.ceil(px - h - 0.5),
      x1 = Math.floor(px + h - 0.5);
    for (let cx = x0; cx <= x1; cx++) if (raster.get(cx, cy) === 1) return true;
  }
  return false;
}

/** Whole forEachSpan walk (what 97f1c87 offers today), early exit by throw. */
const FOUND = Symbol('found');
function fullSpanScan(raster, px, py, R) {
  const R2 = R * R;
  try {
    raster.forEachSpan((cy, x0, x1) => {
      const dy = cy + 0.5 - py;
      if (dy * dy > R2) return;
      const nx = Math.min(Math.max(px - 0.5, x0), x1 - 1) + 0.5;
      const dx = nx - px;
      if (dx * dx + dy * dy <= R2) throw FOUND;
    });
  } catch (e) {
    if (e === FOUND) return true;
    throw e;
  }
  return false;
}

/**
 * Prototype of the proposed windowed `forEachSpan(visit, within)` on the run
 * raster: binary-search the first run reaching the window's first row, walk
 * runs until past its last row, clip each to the window. Reads the class's
 * private arrays, as an in-class implementation would.
 */
function forEachSpanWithinRuns(raster, win, visit) {
  const { starts, lengths } = raster;
  const w = raster.width;
  const rowA = Math.max(0, win.y - raster.y);
  const rowB = Math.min(raster.height - 1, win.y + win.height - 1 - raster.y);
  if (rowB < rowA) return;
  const colA = Math.max(0, win.x - raster.x);
  const colB = Math.min(w, win.x + win.width - raster.x); // exclusive
  if (colB <= colA) return;
  const lo = rowA * w;
  const hi = (rowB + 1) * w;
  // last run whose start <= lo, it may reach into the window
  let a = 0,
    b = starts.length - 1,
    first = 0;
  while (a <= b) {
    const m = (a + b) >>> 1;
    if (starts[m] <= lo) {
      first = m;
      a = m + 1;
    } else b = m - 1;
  }
  for (let i = first; i < starts.length && starts[i] < hi; i++) {
    let index = Math.max(starts[i], lo);
    const end = Math.min(starts[i] + lengths[i], hi);
    while (index < end) {
      const row = Math.floor(index / w);
      const col = index - row * w;
      const stop = Math.min(end, (row + 1) * w);
      const s = Math.max(col, colA),
        e = Math.min(col + (stop - index), colB);
      if (e > s && visit(raster.y + row, raster.x + s, raster.x + e) === false) return;
      index = stop;
    }
  }
}

/** Same windowed walk over a dense raster: scans the window's bytes. */
function forEachSpanWithinDense(raster, win, visit) {
  const snap = raster.dense;
  const w = snap.width;
  const rowA = Math.max(0, win.y - raster.y);
  const rowB = Math.min(raster.height - 1, win.y + win.height - 1 - raster.y);
  const colA = Math.max(0, win.x - raster.x);
  const colB = Math.min(w, win.x + win.width - raster.x);
  for (let row = rowA; row <= rowB; row++) {
    const off = row * w;
    let col = colA;
    while (col < colB) {
      if (snap.data[off + col] !== 1) {
        col++;
        continue;
      }
      const s = col;
      while (col < colB && snap.data[off + col] === 1) col++;
      if (visit(raster.y + row, raster.x + s, raster.x + col) === false) return;
    }
  }
}

function windowedCheck(raster, px, py, R, within) {
  const R2 = R * R;
  const win = {
    x: Math.floor(px - R - 0.5),
    y: Math.floor(py - R - 0.5),
    width: 2 * Math.ceil(R) + 2,
    height: 2 * Math.ceil(R) + 2,
  };
  let hit = false;
  within(raster, win, (cy, x0, x1) => {
    const dy = cy + 0.5 - py;
    const nx = Math.min(Math.max(px - 0.5, x0), x1 - 1) + 0.5;
    const dx = nx - px;
    if (dx * dx + dy * dy <= R2) {
      hit = true;
      return false;
    }
    return true;
  });
  return hit;
}

// ── timing ────────────────────────────────────────────────────────────────
function time(fn, minMs = 200, maxIters = 2000) {
  // warm
  for (let i = 0; i < 3; i++) fn();
  const samples = [];
  const t0 = performance.now();
  while ((performance.now() - t0 < minMs || samples.length < 5) && samples.length < maxIters) {
    const s = performance.now();
    fn();
    samples.push(performance.now() - s);
  }
  samples.sort((a, b) => a - b);
  return samples[Math.floor(samples.length / 2)];
}
const fmt = (ms) =>
  ms < 0.01
    ? `${(ms * 1000).toFixed(2)} us`
    : ms < 1
      ? `${(ms * 1000).toFixed(0)} us`
      : `${ms.toFixed(1)} ms`;

const IMAGE = 100000; // level-0 image side; box sits at (20000, 30000)
const OX = 20000,
  OY = 30000;
const sizes = [1024, 4096, 8192];
const kinds = ['blob', 'scatter', 'noise'];
const radii = [12, 64, 512, 2048];

const rows = [];
for (const side of sizes) {
  for (const kind of kinds) {
    seed = 0x9e3779b9 + side;
    const data = buildShape(kind, side);
    const snapshot = {
      x: OX,
      y: OY,
      width: side,
      height: side,
      data,
      imageWidth: IMAGE,
      imageHeight: IMAGE,
    };
    const payload = encodeCanonical(snapshot);
    const runRaster = decodeCanonicalRaster(payload);
    const dense = denseRaster(snapshot);
    let spans = 0;
    runRaster.forEachSpan(() => {
      spans++;
    });
    const tDecode = time(() => decodeCanonicalRaster(payload), 300, 50);
    const tFromSnapshot = time(() => BoundedDenseMaskBuffer.fromSnapshot(runRaster), 300, 20);
    // probes, in cells (d = 1 here, so cells = image px)
    const hitP = (() => {
      // a painted cell well inside the box
      for (let y = Math.floor(side * 0.3); y < side; y++)
        for (let x = Math.floor(side * 0.3); x < side; x++)
          if (data[y * side + x] === 1) return [OX + x + 0.5, OY + y + 0.5];
      throw new Error('no painted cell');
    })();
    const missP = [OX + side / 2, OY + side / 2];
    const outP = [OX - 5000, OY - 5000];
    const box = {
      x: runRaster.x,
      y: runRaster.y,
      width: runRaster.width,
      height: runRaster.height,
    };
    for (const R of radii) {
      for (const [label, [px, py]] of [
        ['hit', hitP],
        ['hole-centre', missP],
        ['outside-box', outP],
      ]) {
        const expect = getScan(dense, px, py, R);
        const r = { side, cells: side * side, kind, spans, R, probe: label };
        r.bbox = time(() => bboxCheck(box, px, py, R), 50, 100000);
        r.bboxSays = bboxCheck(box, px, py, R);
        // correctness
        const g = R > 512 ? expect : getScan(runRaster, px, py, R);
        const f = fullSpanScan(runRaster, px, py, R);
        const wr = windowedCheck(runRaster, px, py, R, forEachSpanWithinRuns);
        const wd = windowedCheck(dense, px, py, R, forEachSpanWithinDense);
        if (new Set([g, f, wr, wd, expect]).size !== 1)
          throw new Error(`disagree ${JSON.stringify(r)} ${g} ${f} ${wr} ${wd}`);
        r.result = expect;
        r.getRuns = R > 512 ? null : time(() => getScan(runRaster, px, py, R), 100, 200);
        r.getDense = R > 512 ? null : time(() => getScan(dense, px, py, R), 100, 200);
        r.fullSpans =
          label === 'outside-box' || R === 12 || R === 2048
            ? time(() => fullSpanScan(runRaster, px, py, R), 200, 30)
            : null;
        r.winRuns = time(
          () => windowedCheck(runRaster, px, py, R, forEachSpanWithinRuns),
          100,
          2000,
        );
        r.winDense = time(() => windowedCheck(dense, px, py, R, forEachSpanWithinDense), 100, 2000);
        r.decode = tDecode;
        r.fromSnapshot = tFromSnapshot;
        rows.push(r);
      }
    }
    console.error(`done ${kind} ${side}`);
  }
}

console.log(
  '| box (cells) | shape | spans | decode | fromSnapshot | R | probe | touches? | bbox | get() runs | get() dense | full forEachSpan | windowed runs | windowed dense |',
);
console.log('|---|---|---|---|---|---|---|---|---|---|---|---|---|---|');
for (const r of rows) {
  console.log(
    `| ${r.side}² = ${r.cells / 1048576} Mi | ${r.kind} | ${r.spans.toLocaleString('en')} | ${fmt(r.decode)} | ${fmt(r.fromSnapshot)} | ${r.R} | ${r.probe} | ${r.result ? 'yes' : 'no'} | ${fmt(r.bbox)} (${r.bboxSays ? 'in' : 'out'}) | ${r.getRuns === null ? '-' : fmt(r.getRuns)} | ${r.getDense === null ? '-' : fmt(r.getDense)} | ${r.fullSpans === null ? '-' : fmt(r.fullSpans)} | ${fmt(r.winRuns)} | ${fmt(r.winDense)} |`,
  );
}
