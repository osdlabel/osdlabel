// Compare the spike's view-based chooser with a "finest d that fits the mask's own extent"
// policy (start at d=1, coarsen x2 on MaskCapacityExceededError, retry the segment).
import {
  BoundedDenseMaskBuffer,
  chooseMaskDownsample,
  stampCircle,
  strokeSegment,
  snapshotImageBox,
  snapshotCellCount,
  MaskCapacityExceededError,
  DEFAULT_MAX_MASK_PIXELS,
} from '../out/index.js';

const W = 100_000,
  H = 80_000,
  CAP = DEFAULT_MAX_MASK_PIXELS;

function coarsen(s) {
  // OR-reduce by 2 on the cell grid (any child set => parent set).
  const d = (s.downsample ?? 1) * 2;
  const x = Math.floor(s.x / 2),
    y = Math.floor(s.y / 2);
  const right = Math.ceil((s.x + s.width) / 2),
    bottom = Math.ceil((s.y + s.height) / 2);
  const w = right - x,
    h = bottom - y;
  const data = new Uint8Array(w * h);
  for (let r = 0; r < s.height; r++)
    for (let c = 0; c < s.width; c++) {
      if (s.data[r * s.width + c] !== 1) continue;
      data[(Math.floor((s.y + r) / 2) - y) * w + (Math.floor((s.x + c) / 2) - x)] = 1;
    }
  return {
    x,
    y,
    width: w,
    height: h,
    data,
    imageWidth: s.imageWidth,
    imageHeight: s.imageHeight,
    downsample: d,
  };
}

function paintRegion(buf0, lazy) {
  let buf = buf0,
    coarsenMs = 0,
    steps = 0;
  const seg = (x0, y0, x1, y1) => {
    for (;;) {
      try {
        strokeSegment(buf, x0, y0, x1, y1, 512, 1);
        return;
      } catch (e) {
        if (!lazy || !(e instanceof MaskCapacityExceededError)) throw e;
        const t = performance.now();
        buf = BoundedDenseMaskBuffer.fromSnapshot(coarsen(buf.snapshot()));
        coarsenMs += performance.now() - t;
        steps++;
      }
    }
  };
  // fill a 20000 x 16000 region with r=512 sweeps (like the spike's measurement)
  for (let y = 30_000; y <= 46_000; y += 800) seg(40_000, y, 60_000, y);
  return { buf, coarsenMs: Math.round(coarsenMs), steps };
}

const out = {};
// View-based chooser, whole slide in a 1000x800 cell (spike default behaviour).
{
  const z = Math.min(1000 / W, 800 / H),
    vw = 1000 / z,
    vh = 800 / z;
  const d = chooseMaskDownsample(
    { x: W / 2 - vw / 2 - 512, y: H / 2 - vh / 2 - 512, width: vw + 1024, height: vh + 1024 },
    W,
    H,
    CAP,
    2,
  );
  const { buf } = paintRegion(
    new BoundedDenseMaskBuffer({ imageWidth: W, imageHeight: H, downsample: d }),
    false,
  );
  const s = buf.snapshot();
  out.viewChooser = {
    d: buf.downsample,
    cells: snapshotCellCount(s),
    box: snapshotImageBox(s),
    capFraction: +((s.width * s.height) / CAP).toFixed(3),
  };
}
// Extent-based: start at d=1 and coarsen on overflow.
{
  const t = performance.now();
  const { buf, coarsenMs, steps } = paintRegion(
    new BoundedDenseMaskBuffer({ imageWidth: W, imageHeight: H, downsample: 1 }),
    true,
  );
  const s = buf.snapshot();
  out.extentBased = {
    d: buf.downsample,
    coarsenSteps: steps,
    coarsenMs,
    totalMs: Math.round(performance.now() - t),
    cells: snapshotCellCount(s),
    box: snapshotImageBox(s),
    capFraction: +((s.width * s.height) / CAP).toFixed(3),
  };
}
// A 3000 x 3000 object sketched at whole-slide overview: view chooser vs extent-based.
{
  const z = Math.min(1000 / W, 800 / H),
    vw = 1000 / z,
    vh = 800 / z;
  const dView = chooseMaskDownsample(
    { x: W / 2 - vw / 2 - 512, y: H / 2 - vh / 2 - 512, width: vw + 1024, height: vh + 1024 },
    W,
    H,
    CAP,
    2,
  );
  const b = new BoundedDenseMaskBuffer({ imageWidth: W, imageHeight: H, downsample: 1 });
  stampCircle(b, 50_000, 40_000, 1500, 1);
  out.mediumObjectAtOverview = { viewChooserD: dView, extentBasedD: b.downsample };
}
console.log(JSON.stringify(out, null, 1));
