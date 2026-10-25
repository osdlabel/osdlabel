import {
  BoundedDenseMaskBuffer,
  stampCircle,
  encodeCanonical,
  cocoRleCodec,
  snapshotPixelCount,
} from '../out/index.js';
const W2 = 40_000,
  H2 = 30_000;
const b = new BoundedDenseMaskBuffer({ imageWidth: W2, imageHeight: H2, downsample: 16 });
stampCircle(b, 20_000, 15_000, 1500, 1);
const s = b.snapshot();
const before = encodeCanonical(s);
const back = cocoRleCodec.decode(cocoRleCodec.encode(s));
const after = encodeCanonical(back);
console.log(
  JSON.stringify({
    before: {
      downsample: before.downsample ?? 1,
      countsChars: before.counts.length,
      pixelCount: snapshotPixelCount(s),
    },
    afterCocoRoundTrip: {
      downsample: after.downsample ?? 1,
      countsChars: after.counts.length,
      pixelCount: snapshotPixelCount(back),
      cells: back.width * back.height,
    },
  }),
);
