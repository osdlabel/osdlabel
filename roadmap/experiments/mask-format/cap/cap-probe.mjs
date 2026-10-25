// Probe of #149 (58a379f) @osdlabel/mask: what can the brush paint on a 100,000 x 80,000 slide?
import {
  BoundedDenseMaskBuffer,
  MaskCapacityExceededError,
  DEFAULT_MAX_MASK_PIXELS,
  stampCircle,
  strokeSegment,
  encodeCanonical,
  decodeCanonical,
} from '../out/index.js';

const W = 100_000,
  H = 80_000;
console.log(
  'DEFAULT_MAX_MASK_PIXELS =',
  DEFAULT_MAX_MASK_PIXELS,
  '=> sqrt =',
  Math.sqrt(DEFAULT_MAX_MASK_PIXELS),
);

// Emulates SegmentationBrushTool: a stroke = stampCircle at down, strokeSegment per move;
// a MaskCapacityExceededError abandons the whole stroke (paint() -> endStroke()).
function stroke(buffer, points, r) {
  try {
    stampCircle(buffer, points[0].x, points[0].y, r, 1);
    for (let i = 1; i < points.length; i++)
      strokeSegment(buffer, points[i - 1].x, points[i - 1].y, points[i].x, points[i].y, r, 1);
    return true;
  } catch (e) {
    if (e instanceof MaskCapacityExceededError) return false;
    throw e;
  }
}
function line(x0, y0, x1, y1, n = 50) {
  const p = [];
  for (let i = 0; i <= n; i++) p.push({ x: x0 + ((x1 - x0) * i) / n, y: y0 + ((y1 - y0) * i) / n });
  return p;
}

// Longest single stroke that commits, by binary search on its extent.
function maxStroke(r, dir) {
  let lo = 0,
    hi = 100_000;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    const b = new BoundedDenseMaskBuffer({ imageWidth: W, imageHeight: H });
    const [dx, dy] = dir === 'h' ? [mid, 0] : [mid, mid];
    const ok =
      20_000 + dx < W &&
      20_000 + dy < H &&
      stroke(b, line(20_000, 20_000, 20_000 + dx, 20_000 + dy), r);
    if (ok) lo = mid;
    else hi = mid;
  }
  return lo;
}
for (const r of [12, 512]) {
  console.log(
    `r=${r}: longest horizontal stroke (centre travel) = ${maxStroke(r, 'h')} px; longest 45deg stroke = ${maxStroke(r, 'd')} px per axis`,
  );
}

// Two dabs at opposite corners of a square, the second one refining the first through the
// exact path the tool uses: commit -> encodeCanonical -> decodeCanonical -> fromSnapshot -> stamp.
function twoDabSquare(side, r) {
  const b1 = new BoundedDenseMaskBuffer({ imageWidth: W, imageHeight: H });
  if (!stroke(b1, [{ x: 30_000, y: 30_000 }], r)) return false;
  const payload = encodeCanonical(b1.snapshot());
  try {
    const b2 = BoundedDenseMaskBuffer.fromSnapshot(decodeCanonical(payload));
    if (!stroke(b2, [{ x: 30_000 + side, y: 30_000 + side }], r)) return false;
    const s = b2.snapshot();
    return { w: s.width, h: s.height };
  } catch (e) {
    if (e instanceof MaskCapacityExceededError) return false;
    throw e;
  }
}
for (const r of [12, 512]) {
  let lo = 0,
    hi = 20_000;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (twoDabSquare(mid, r)) lo = mid;
    else hi = mid;
  }
  const box = twoDabSquare(lo, r);
  console.log(
    `r=${r}: largest square mask (two-dab refine) committed: centres ${lo} px apart -> painted bbox ${box.w} x ${box.h} = ${box.w * box.h} px`,
  );
}

// Solid at-cap mask: encode/decode cost and payload size.
{
  const side = 8192;
  const data = new Uint8Array(side * side).fill(1);
  const snap = {
    x: 10_000,
    y: 10_000,
    width: side,
    height: side,
    data,
    imageWidth: W,
    imageHeight: H,
  };
  let t = performance.now();
  const enc = encodeCanonical(snap);
  const tEnc = performance.now() - t;
  t = performance.now();
  const dec = decodeCanonical(enc);
  const tDec = performance.now() - t;
  t = performance.now();
  BoundedDenseMaskBuffer.fromSnapshot(dec);
  const tFrom = performance.now() - t;
  console.log(
    `solid ${side}x${side}: counts ${enc.counts.length} chars; encode ${tEnc.toFixed(0)} ms, decode ${tDec.toFixed(0)} ms, fromSnapshot ${tFrom.toFixed(0)} ms`,
  );
  console.log(
    `  one more pixel: decode of ${side}x${side + 1} ->`,
    (() => {
      try {
        decodeCanonical({ ...enc, height: side + 1 });
        return 'ok';
      } catch (e) {
        return e.constructor.name + ': ' + e.message;
      }
    })(),
  );
}

// The SAM PoC's overview-zoom mask, as a level-0 box (REPORT: 2,273,163,669 px).
try {
  decodeCanonical({
    x: 0,
    y: 0,
    width: 47_677,
    height: 47_678,
    imageWidth: W,
    imageHeight: H,
    counts: '',
  });
} catch (e) {
  console.log('47677x47678 level-0 box ->', e.constructor.name + ':', e.message);
}
