// UX/interop probe for the spike's downsample field (70dd415 packages/mask/src, compiled).
import {
  BoundedDenseMaskBuffer,
  chooseMaskDownsample,
  stampCircle,
  strokeSegment,
  encodeCanonical,
  decodeCanonical,
  snapshotImageBox,
  snapshotPixelCount,
  upsampleSnapshot,
  cocoRleCodec,
  isCocoInteropSafe,
  MaskCapacityExceededError,
  DEFAULT_MAX_MASK_PIXELS,
} from '../out/index.js';

const W = 100_000,
  H = 80_000;
const CAP = DEFAULT_MAX_MASK_PIXELS;
const out = {};

// Same padding the tool uses: visible region padded by radius, marginCells 2.
function chooseForView(zoom, cw, ch, r = 12, cx = W / 2, cy = H / 2) {
  const vw = cw / zoom,
    vh = ch / zoom;
  return chooseMaskDownsample(
    { x: cx - vw / 2 - r, y: cy - vh / 2 - r, width: vw + 2 * r, height: vh + 2 * r },
    W,
    H,
    CAP,
    2,
  );
}

// 1. d as a function of zoom and monitor (cell) size.
const zooms = {
  '1.25x(0.03125)': 0.03125,
  '2x(0.05)': 0.05,
  '4x(0.1)': 0.1,
  '5x(0.125)': 0.125,
  '10x(0.25)': 0.25,
};
const cells = { '1000x800': [1000, 800], '1920x1080': [1920, 1080], '3840x2160': [3840, 2160] };
out.dByZoomAndCell = {};
for (const [zn, z] of Object.entries(zooms)) {
  out.dByZoomAndCell[zn] = {};
  for (const [cn, [cw, ch]] of Object.entries(cells))
    out.dByZoomAndCell[zn][cn] = chooseForView(z, cw, ch);
}
// whole slide in view in a 1000x800 cell
out.dWholeSlide1000x800 = chooseForView(Math.min(1000 / W, 800 / H), 1000, 800);

// helpers
function circlePath(cx, cy, R, stepPx) {
  const n = Math.ceil((2 * Math.PI * R) / stepPx);
  const pts = [];
  for (let i = 0; i <= n; i++) {
    const t = (2 * Math.PI * i) / n;
    pts.push([cx + R * Math.cos(t), cy + R * Math.sin(t)]);
  }
  return pts;
}
function drag(buf, pts, r, value) {
  stampCircle(buf, pts[0][0], pts[0][1], r, value);
  for (let i = 1; i < pts.length; i++)
    strokeSegment(buf, pts[i - 1][0], pts[i - 1][1], pts[i][0], pts[i][1], r, value);
}
// level-0 membership test of a snapshot (cells)
function inMask(s, px, py) {
  const d = s.downsample ?? 1;
  const cx = Math.floor(px / d) - s.x,
    cy = Math.floor(py / d) - s.y;
  if (cx < 0 || cy < 0 || cx >= s.width || cy >= s.height) return 0;
  return s.data[cy * s.width + cx];
}
// IoU of a snapshot vs a predicate over a level-0 window
function iouVs(s, pred, x0, y0, x1, y1) {
  let inter = 0,
    uni = 0,
    a = 0,
    b = 0;
  for (let y = y0; y < y1; y++)
    for (let x = x0; x < x1; x++) {
      const m = inMask(s, x + 0.5 - 0.5, y),
        t = pred(x + 0.5, y + 0.5) ? 1 : 0;
      if (m) a++;
      if (t) b++;
      if (m && t) inter++;
      if (m || t) uni++;
    }
  return { iou: inter / uni, maskPx: a, truthPx: b, xor: uni - inter };
}
// Refine through the tool's real path: encode -> decode -> fromSnapshot.
function reopen(s) {
  return BoundedDenseMaskBuffer.fromSnapshot(decodeCanonical(encodeCanonical(s)));
}

// 2. Coarse-then-fine workflow on an object that FITS the cap at level 0.
//    Truth: disc R=1500 (0.75 mm at 0.25 um/px). At overview the user over-paints
//    (R=1540), the mask is auto-selected, they zoom to 40x and erase the 40 px
//    overhang with the default r=12 eraser in two passes along the true edge.
const C = [50_003, 40_007],
  R = 1500;
const truth = (x, y) => (x - C[0]) ** 2 + (y - C[1]) ** 2 <= R * R;
out.coarseThenFine = {};
for (const d of [1, out.dWholeSlide1000x800, 4]) {
  const buf = new BoundedDenseMaskBuffer({ imageWidth: W, imageHeight: H, downsample: d });
  stampCircle(buf, C[0], C[1], 1540, 1);
  const sketch = buf.snapshot();
  const sketchIoU = iouVs(sketch, truth, C[0] - 1600, C[1] - 1600, C[0] + 1600, C[1] + 1600).iou;
  const ref = reopen(sketch);
  drag(ref, circlePath(C[0], C[1], R + 12, 4), 12, 0);
  drag(ref, circlePath(C[0], C[1], R + 36, 4), 12, 0);
  const refined = ref.snapshot();
  const m = iouVs(refined, truth, C[0] - 1600, C[1] - 1600, C[0] + 1600, C[1] + 1600);
  out.coarseThenFine[`d=${d}`] = {
    sketchIoU: +sketchIoU.toFixed(5),
    refinedIoU: +m.iou.toFixed(5),
    xorPx: m.xor,
    meanBoundaryErrPx: +(m.xor / (2 * Math.PI * R)).toFixed(2),
    storedDownsample: refined.downsample ?? 1,
  };
}

// 3. WYSIWYG: one eraser dab at 40x on a solid d mask vs the ring the cursor shows.
out.dabFootprint = {};
for (const d of [1, 4, 16, 32]) {
  for (const r of [4, 12, 32]) {
    let sumErased = 0,
      sumIoU = 0,
      minErased = Infinity,
      maxErased = 0,
      N = 200;
    let seed = 12345;
    const rnd = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
    for (let i = 0; i < N; i++) {
      const buf = new BoundedDenseMaskBuffer({ imageWidth: W, imageHeight: H, downsample: d });
      const ox = 40_000,
        oy = 40_000;
      // solid block
      stampCircle(buf, ox, oy, 400, 1);
      const before = buf.snapshot();
      const cx = ox + rnd() * 64,
        cy = oy + rnd() * 64;
      const ref = BoundedDenseMaskBuffer.fromSnapshot(before);
      stampCircle(ref, cx, cy, r, 0);
      const after = ref.snapshot();
      const erased = snapshotPixelCount(before) - snapshotPixelCount(after);
      // IoU between intended disc and erased level-0 pixels
      let inter = 0,
        uni = 0;
      const pad = Math.max(r, d) + d + 2;
      for (let y = Math.floor(cy - pad); y < cy + pad; y++)
        for (let x = Math.floor(cx - pad); x < cx + pad; x++) {
          const intended = (x + 0.5 - cx) ** 2 + (y + 0.5 - cy) ** 2 <= r * r;
          const got = inMask(before, x, y) && !inMask(after, x, y);
          if (intended && got) inter++;
          if (intended || got) uni++;
        }
      sumErased += erased;
      sumIoU += inter / uni;
      minErased = Math.min(minErased, erased);
      maxErased = Math.max(maxErased, erased);
    }
    out.dabFootprint[`d=${d},r=${r}`] = {
      ringAreaPx: Math.round(Math.PI * r * r),
      erasedMean: Math.round(sumErased / N),
      erasedMin: minErased,
      erasedMax: maxErased,
      meanIoUWithRing: +(sumIoU / N).toFixed(3),
    };
  }
}

// 4. Small object painted at a zoomed-out view, then measured.
//    Gland r=60 px painted with a single r=60 dab at the view's d.
out.smallObject = {};
for (const d of [1, 2, 4, 16]) {
  const G = [30_017, 30_029],
    r = 60;
  const buf = new BoundedDenseMaskBuffer({ imageWidth: W, imageHeight: H, downsample: d });
  stampCircle(buf, G[0], G[1], r, 1);
  const s = buf.snapshot();
  const m = iouVs(
    s,
    (x, y) => (x - G[0]) ** 2 + (y - G[1]) ** 2 <= r * r,
    G[0] - 100,
    G[1] - 100,
    G[0] + 100,
    G[1] + 100,
  );
  out.smallObject[`d=${d}`] = {
    iou: +m.iou.toFixed(4),
    pixelCount: snapshotPixelCount(s),
    exactArea: Math.round(Math.PI * r * r),
    relAreaErr: +((snapshotPixelCount(s) - Math.PI * r * r) / (Math.PI * r * r)).toFixed(4),
  };
}

// 5. COCO round trip of masks that only A makes possible.
function cocoRoundTrip(label, s) {
  const exported = cocoRleCodec.encode(s);
  let result;
  try {
    const back = cocoRleCodec.decode(exported, { maxPixels: CAP });
    result = { ok: true, backDownsample: back.downsample ?? 1, backBox: snapshotImageBox(back) };
  } catch (e) {
    result = { ok: false, error: `${e.constructor.name}: ${e.message}` };
  }
  return {
    label,
    d: s.downsample ?? 1,
    box: snapshotImageBox(s),
    interopSafe: isCocoInteropSafe(s),
    ...result,
  };
}
out.cocoRoundTrip = [];
{
  // whole-slide view region 20000x16000 at d=16
  const buf = new BoundedDenseMaskBuffer({ imageWidth: W, imageHeight: H, downsample: 16 });
  for (let y = 30_000; y <= 46_000; y += 800) strokeSegment(buf, 40_000, y, 60_000, y, 512, 1);
  out.cocoRoundTrip.push(
    cocoRoundTrip('20000x16000 region at d=16 (100k x 80k slide)', buf.snapshot()),
  );
  // smaller image that is COCO interop-safe: 40k x 30k (1.2 Gpx), region 12000x12000 at d=2
  const W2 = 40_000,
    H2 = 30_000;
  const b2 = new BoundedDenseMaskBuffer({ imageWidth: W2, imageHeight: H2, downsample: 2 });
  stampCircle(b2, 20_000, 15_000, 6_000, 1);
  out.cocoRoundTrip.push(cocoRoundTrip('r=6000 disc at d=2 (40k x 30k image)', b2.snapshot()));
  // small d=16 mask (fits at level 0)
  const b3 = new BoundedDenseMaskBuffer({ imageWidth: W2, imageHeight: H2, downsample: 16 });
  stampCircle(b3, 20_000, 15_000, 1500, 1);
  out.cocoRoundTrip.push(cocoRoundTrip('r=1500 disc at d=16 (40k x 30k image)', b3.snapshot()));
}

// 6. Fine-then-coarse: d=1 mask from 40x, extended while zoomed out.
{
  const buf = new BoundedDenseMaskBuffer({ imageWidth: W, imageHeight: H, downsample: 1 });
  stampCircle(buf, 50_000, 40_000, 200, 1);
  const ref = reopen(buf.snapshot());
  try {
    strokeSegment(ref, 50_000, 40_000, 60_000, 48_000, 512, 1);
    out.fineThenCoarse = { ok: true };
  } catch (e) {
    out.fineThenCoarse = { ok: false, error: `${e.constructor.name}: ${e.message}` };
  }
}

// 7. Upsample a d=16 whole-slide-ish mask to level 0 for a level-0-only consumer.
{
  const buf = new BoundedDenseMaskBuffer({ imageWidth: W, imageHeight: H, downsample: 16 });
  stampCircle(buf, 50_000, 40_000, 9_000, 1);
  try {
    upsampleSnapshot(buf.snapshot(), CAP);
    out.upsampleForLevel0Consumer = { ok: true };
  } catch (e) {
    out.upsampleForLevel0Consumer = { ok: false, error: e.message };
  }
}

console.log(JSON.stringify(out, null, 1));
