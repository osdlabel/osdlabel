const B = process.argv[2];
const N = await import(`${B}/new/out/index.js`);
const O = await import(`${B}/old/out/index.js`);
const W = 100000,
  H = 80000,
  CAP = 64 * 1024 * 1024;

// 1. Chooser at overview: whole image visible (1000x800 css canvas, 100 image px per css px)
const view = { x: 0, y: 0, width: W, height: H };
for (const r of [12, 512]) {
  const d = N.chooseMaskDownsample(
    { x: -r, y: -r, width: W + 2 * r, height: H + 2 * r },
    W,
    H,
    CAP,
    2,
  );
  console.log(
    `overview view, r=${r}: d=${d}, grid=${Math.ceil(W / d)}x${Math.ceil(H / d)} = ${Math.ceil(W / d) * Math.ceil(H / d)} cells; brush radius in cells = ${r / d}`,
  );
}
// mid zoom: 8000x6400 view
console.log(
  '8000x6400 view -> d=',
  N.chooseMaskDownsample({ x: 40000, y: 30000, width: 8000 + 24, height: 6400 + 24 }, W, H, CAP, 2),
);
console.log(
  '10000x8000 view -> d=',
  N.chooseMaskDownsample(
    { x: 40000, y: 30000, width: 10000 + 24, height: 8000 + 24 },
    W,
    H,
    CAP,
    2,
  ),
);

// 2. Paint a 20,000 x 16,000 px filled region at d=16 (5 x 4 mm at 0.25um/px) via the buffer, then encode
const d = 16;
const buf = new N.BoundedDenseMaskBuffer({ imageWidth: W, imageHeight: H, downsample: d });
const t0 = performance.now();
for (let y = 30000; y < 46000; y += 400) N.strokeSegment(buf, 40000, y, 60000, y, 512, 1);
const t1 = performance.now();
const snap = buf.snapshot();
const enc = N.encodeCanonical(snap);
const t2 = performance.now();
console.log(
  `d=16 region: strokes ${(t1 - t0).toFixed(0)} ms, encode ${(t2 - t1).toFixed(0)} ms, payload box ${enc.x},${enc.y} ${enc.width}x${enc.height}, counts ${enc.counts.length} chars, downsample=${enc.downsample}, cells=${snap.width * snap.height}, level-0 pixelCount=${N.snapshotPixelCount(snap)}`,
);

// 3. Old (58a379f) reader on that payload
try {
  const s = O.decodeCanonical({ ...enc, downsample: undefined });
  console.log('OLD reader decoded!', s.width, s.height);
} catch (e) {
  console.log('OLD reader, big box:', e.name, '-', e.message.slice(0, 110));
}

// small d=2 payload whose level-0 box is under the cap
const small = new N.BoundedDenseMaskBuffer({ imageWidth: W, imageHeight: H, downsample: 2 });
N.stampCircle(small, 1000, 1000, 300, 1);
const encS = N.encodeCanonical(small.snapshot());
const { downsample: _drop, ...stripped } = encS;
try {
  const s = O.decodeCanonical(stripped);
  console.log('OLD reader decoded small!', s.width, s.height);
} catch (e) {
  console.log(
    `OLD reader, small d=2 box ${encS.width}x${encS.height}:`,
    e.name,
    '-',
    e.message.slice(0, 100),
  );
}

// 4. New reader round trip
const back = N.decodeCanonical(enc);
console.log(
  'new reader round trip: cells',
  back.width,
  'x',
  back.height,
  'd',
  back.downsample,
  'pixelCount',
  N.snapshotPixelCount(back),
);

// 5. A d=1 mask extended at overview (refine keeps d): grows past cap
const fine = new N.BoundedDenseMaskBuffer({ imageWidth: W, imageHeight: H, downsample: 1 });
N.stampCircle(fine, 50000, 40000, 500, 1);
try {
  N.strokeSegment(fine, 50000, 40000, 60000, 40000, 512, 1);
  N.strokeSegment(fine, 60000, 40000, 60000, 48000, 512, 1);
  console.log('d=1 extension ok');
} catch (e) {
  console.log('d=1 mask extended at overview:', e.name, e.message.slice(0, 80));
}

// 6. Wide-but-thin mask at d=1 legal under cap: 70000 x 900 strip
const strip = new N.BoundedDenseMaskBuffer({ imageWidth: W, imageHeight: H, downsample: 1 });
try {
  N.strokeSegment(strip, 5000, 1000, 75000, 1000, 400, 1);
  const s = strip.snapshot();
  console.log(
    `d=1 strip committed: ${s.width} x ${s.height} cells (canvas width > 65535: ${s.width > 65535})`,
  );
} catch (e) {
  console.log('strip:', e.message.slice(0, 80));
}
