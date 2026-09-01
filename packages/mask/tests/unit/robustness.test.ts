import { describe, expect, it } from 'vitest';
import {
  BoundedDenseMaskBuffer,
  MaskCapacityExceededError,
  decodeCanonical,
  encodeCanonical,
  cocoCountsToSnapshot,
  cocoRleCodec,
  cocoRleUncompressedCodec,
  decodeCocoCountsString,
  encodeCocoCountsString,
  fromRuns,
  snapshotToCocoCounts,
  stampCircle,
  strokeSegment,
  toRuns,
} from '../../src/index.js';
import { decodeVarints, encodeVarints } from '../../src/binary.js';

describe('varints', () => {
  it('round-trips values beyond 32 bits', () => {
    const values = [0, 1, 127, 128, 2 ** 32, 2 ** 40, 5_000_000_000];
    expect(decodeVarints(encodeVarints(values))).toEqual(values);
  });

  it('rejects non-integer and negative values', () => {
    expect(() => encodeVarints([1.5])).toThrow(RangeError);
    expect(() => encodeVarints([-1])).toThrow(RangeError);
    expect(() => encodeVarints([NaN])).toThrow(RangeError);
  });

  it('rejects a stream that ends mid-value', () => {
    // A lone continuation byte promises a following byte that never arrives.
    expect(() => decodeVarints(Uint8Array.from([0x80]))).toThrow(/ended mid-value/);
  });

  it('rejects a varint too large to represent exactly', () => {
    const bytes = Uint8Array.from(Array.from({ length: 12 }, () => 0xff));
    expect(() => decodeVarints(bytes)).toThrow(/safe integer range/);
  });
});

describe('fromRuns', () => {
  it('round-trips through toRuns', () => {
    const pixels = Uint8Array.from([0, 1, 1, 0, 1, 0]);
    expect(fromRuns(toRuns(pixels), pixels.length)).toEqual(pixels);
  });

  it('rejects runs that do not fill the box', () => {
    expect(() => fromRuns([1, 2], 10)).toThrow(/sum to 3/);
    expect(() => fromRuns([1, 20], 10)).toThrow(/sum to 21/);
  });

  it('rejects malformed run lengths', () => {
    expect(() => fromRuns([1, -2], 10)).toThrow(RangeError);
    expect(() => fromRuns([1.5], 10)).toThrow(RangeError);
  });
});

describe('decodeCanonical', () => {
  it('rejects a payload whose counts disagree with its box', () => {
    // Counts for a 4-pixel mask, but the box claims 3x3.
    const good = {
      x: 0,
      y: 0,
      width: 2,
      height: 2,
      imageWidth: 10,
      imageHeight: 10,
      counts: btoa(String.fromCharCode(...encodeVarints([0, 4]))),
    };
    expect(decodeCanonical(good).data).toEqual(Uint8Array.from([1, 1, 1, 1]));
    expect(() => decodeCanonical({ ...good, width: 3, height: 3 })).toThrow(/sum to 4/);
  });

  it('refuses to allocate an absurd box', () => {
    expect(() =>
      decodeCanonical({
        x: 0,
        y: 0,
        width: 1_000_000,
        height: 1_000_000,
        imageWidth: 1_000_000,
        imageHeight: 1_000_000,
        counts: '',
      }),
    ).toThrow(MaskCapacityExceededError);
  });
});

describe('decodeCocoCountsString', () => {
  it('round-trips ordinary counts', () => {
    const counts = [7, 3, 40, 5, 900, 12, 4];
    expect(decodeCocoCountsString(encodeCocoCountsString(counts))).toEqual(counts);
  });

  it('rejects a string that ends mid-value', () => {
    // 0x20 is the continuation flag; offset by 48 it is 'P'.
    expect(() => decodeCocoCountsString('P')).toThrow(/ended mid-value/);
  });

  it('rejects characters outside the 6-bit alphabet', () => {
    expect(() => decodeCocoCountsString('!')).toThrow(/outside its alphabet/);
    expect(() => decodeCocoCountsString('ÿ')).toThrow(/outside its alphabet/);
  });

  it('rejects a delta that resolves to a negative run', () => {
    // Three plain counts, then a delta large enough to drive the fourth below zero.
    // The fourth count is delta-coded against the second. Chunk 22 sign-extends
    // to a delta of -10, which drives that count to -5.
    const encoded = encodeCocoCountsString([5, 5, 5, 5]);
    const tampered = encoded.slice(0, -1) + String.fromCharCode(22 + 48);
    expect(() => decodeCocoCountsString(tampered)).toThrow(/invalid run length/);
  });
});

describe('stroke capacity', () => {
  it('leaves the mask untouched when a stamp cannot fit', () => {
    const buffer = new BoundedDenseMaskBuffer({
      imageWidth: 4096,
      imageHeight: 4096,
      maxPixels: 64 * 64,
    });
    stampCircle(buffer, 32, 32, 4, 1);
    const before = buffer.pixelCount;
    expect(before).toBeGreaterThan(0);

    expect(() => stampCircle(buffer, 2000, 2000, 300, 1)).toThrow(MaskCapacityExceededError);
    expect(buffer.pixelCount).toBe(before);
    expect(buffer.get(2000, 2000)).toBe(0);
  });

  it('leaves the mask untouched when a segment cannot fit', () => {
    const buffer = new BoundedDenseMaskBuffer({
      imageWidth: 4096,
      imageHeight: 4096,
      maxPixels: 64 * 64,
    });
    stampCircle(buffer, 32, 32, 4, 1);
    const before = buffer.pixelCount;

    expect(() => strokeSegment(buffer, 10, 10, 3000, 3000, 5, 1)).toThrow(
      MaskCapacityExceededError,
    );
    expect(buffer.pixelCount).toBe(before);
  });

  it('erasing never grows the buffer', () => {
    const buffer = new BoundedDenseMaskBuffer({
      imageWidth: 4096,
      imageHeight: 4096,
      maxPixels: 64 * 64,
    });
    stampCircle(buffer, 32, 32, 4, 1);
    expect(() => stampCircle(buffer, 3000, 3000, 300, 0)).not.toThrow();
  });
});

describe('reserve', () => {
  it('grows once to cover a whole disc', () => {
    const buffer = new BoundedDenseMaskBuffer({ imageWidth: 4096, imageHeight: 4096 });
    stampCircle(buffer, 2000, 2000, 500, 1);
    const bounds = buffer.bounds;
    expect(bounds.width).toBeGreaterThanOrEqual(1000);
    expect(bounds.height).toBeGreaterThanOrEqual(1000);
    // Pixels are still exact after the single reallocation.
    expect(buffer.get(2000, 2000)).toBe(1);
    expect(buffer.get(2000, 1501)).toBe(1);
    expect(buffer.get(2000, 1400)).toBe(0);
  });

  it('is a no-op for regions already covered, clipped, or degenerate', () => {
    const buffer = new BoundedDenseMaskBuffer({ imageWidth: 100, imageHeight: 100 });
    buffer.set(10, 10, 1);
    const before = buffer.bounds;
    buffer.reserve({ x: 10, y: 10, width: 1, height: 1 });
    expect(buffer.bounds).toEqual(before);
    buffer.reserve({ x: -50, y: -50, width: 10, height: 10 });
    expect(buffer.bounds).toEqual(before);
    buffer.reserve({ x: 0, y: 0, width: 0, height: 0 });
    expect(buffer.bounds).toEqual(before);
    buffer.reserve({ x: NaN, y: 0, width: 10, height: 10 });
    expect(buffer.bounds).toEqual(before);
  });
});

describe('buffer coordinate hygiene', () => {
  it('ignores fractional and non-finite coordinates', () => {
    const buffer = new BoundedDenseMaskBuffer({ imageWidth: 100, imageHeight: 100 });
    buffer.set(1.5, 2, 1);
    buffer.set(NaN, 2, 1);
    buffer.set(2, Infinity, 1);
    expect(buffer.pixelCount).toBe(0);
    expect(buffer.snapshot().width).toBe(0);
  });

  it('rejects non-finite dimensions and caps at construction', () => {
    expect(() => new BoundedDenseMaskBuffer({ imageWidth: NaN, imageHeight: 10 })).toThrow(
      RangeError,
    );
    expect(() => new BoundedDenseMaskBuffer({ imageWidth: 10, imageHeight: -1 })).toThrow(
      RangeError,
    );
    expect(
      () => new BoundedDenseMaskBuffer({ imageWidth: 10, imageHeight: 10, maxPixels: 0 }),
    ).toThrow(RangeError);
  });
});

describe('stampCircle clipping', () => {
  it('does not iterate beyond the image for an absurd radius', () => {
    // `set` ignores out-of-image writes, but the loops still ran: a radius of
    // 1e6 on a small image iterated trillions of times to no effect. The brush
    // UI clamps to MAX_BRUSH_RADIUS; a caller driving the rasterizer directly
    // does not.
    const buffer = new BoundedDenseMaskBuffer({ imageWidth: 200, imageHeight: 160 });
    const started = Date.now();
    stampCircle(buffer, 100, 80, 1e6, 1);
    expect(Date.now() - started).toBeLessThan(2000);
    // Everything inside the image is covered.
    expect(buffer.pixelCount).toBe(200 * 160);
  });
});

describe('cocoCountsToSnapshot bounds the work before doing it', () => {
  it('refuses an oversized foreground before scanning it', () => {
    // Two independent mechanisms keep this cheap, and this pins the pair
    // rather than either one: `assertDecodableCount` refuses an oversized
    // foreground from a sum over the runs before any scan, and the bounding box
    // is derived from run boundaries rather than by visiting pixels. Remove
    // just one and the payload is still refused quickly — remove both and this
    // decode walks 1e8 pixels first. Verified by mutation in both directions.
    //
    // Elapsed time is the only observable difference (the two guards throw the
    // same error on the same inputs, since foreground > cap implies bbox area >
    // cap). It is not a close call: sub-millisecond against seconds, so the
    // threshold has ~1000x headroom and will not flake on a loaded runner.
    const started = Date.now();
    expect(() => cocoCountsToSnapshot([0, 1e8], 10_000, 10_000)).toThrow(MaskCapacityExceededError);
    expect(Date.now() - started).toBeLessThan(500);
  });

  it('still decodes a large image whose mask is small', () => {
    // The cap is on the foreground, not the image, so a tiny mask on a
    // gigapixel canvas must remain decodable — the guard must not have been
    // implemented by bounding the image area instead.
    const w = 100_000;
    const h = 100_000;
    const lead = 50_000 * h + 500;
    const snapshot = cocoCountsToSnapshot(
      [lead, 4, h - 4, 4, w * h - lead - 4 - (h - 4) - 4],
      h,
      w,
    );
    expect(snapshot).toMatchObject({ width: 2, height: 4 });
  });
});

describe('an image whose pixels cannot be counted exactly', () => {
  it('refuses it instead of looping forever', () => {
    // A COCO decode walks a running index across the whole image, so the
    // *image's* area bounds that walk — not the mask's, and not the foreground
    // cap. Past Number.MAX_SAFE_INTEGER the increment stops advancing (`i + 1
    // === i` in float64) and the loop never ends: a 379-byte document froze
    // `deserialize` permanently, with every documented bound at its minimum,
    // because the runs summed correctly and every one of them was a safe
    // integer.
    const h = 2 ** 27;
    const w = 2 ** 27;
    const area = h * w;
    const counts = [2 ** 52, 0, 2 ** 52 - 2, 0, 2, 8, area - 2 ** 53 - 8];
    expect(counts.reduce((a, b) => a + b, 0)).toBe(area);
    expect(counts.every(Number.isSafeInteger)).toBe(true);

    const started = Date.now();
    expect(() => cocoCountsToSnapshot(counts, h, w, { maxPixels: 1024 })).toThrow(RangeError);
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it('refuses the variant that returns a silently truncated mask', () => {
    // The same arithmetic, one binade lower: `index + run` rounds back to
    // `index`, the loop body runs zero times, and the decode *succeeds* with
    // the foreground missing. Worse than the hang, because it looks fine.
    expect(() =>
      cocoCountsToSnapshot([2 ** 55, 4, 2 ** 56 - 2 ** 55 - 4], 2 ** 28, 2 ** 28, {
        maxPixels: 1024,
      }),
    ).toThrow(RangeError);
  });

  it('still decodes a mask on a genuine whole-slide image', () => {
    // The bound is five orders of magnitude above anything real, and must not
    // be mistaken for a limit on useful images.
    const w = 200_000;
    const h = 100_000;
    const lead = 100_000 * h + 500;
    const snapshot = cocoCountsToSnapshot(
      [lead, 4, h - 4, 4, w * h - lead - 4 - (h - 4) - 4],
      h,
      w,
    );
    expect(snapshot).toMatchObject({ width: 2, height: 4 });
  });
});

describe('a mask box outside its own image', () => {
  it('is refused at decode rather than truncated on the next stroke', () => {
    // Nothing this package produces can violate it — the buffer clips every
    // write — so such a payload is corrupt. Admitting it destroys data:
    // `fromSnapshot` sizes the buffer from the recorded image and clips the
    // overhang, so one dab commits a truncated mask with no error at all.
    const source = new BoundedDenseMaskBuffer({ imageWidth: 40, imageHeight: 40 });
    for (let y = 0; y < 20; y++) for (let x = 0; x < 20; x++) source.set(x, y, 1);
    // Rewritten on the *payload*, not the snapshot: this is what a corrupt
    // document off disk looks like, and it never passes through `encode`.
    const corrupt = { ...encodeCanonical(source.snapshot()), imageWidth: 10, imageHeight: 10 };

    expect(() => decodeCanonical(corrupt)).toThrow(/lies outside its/);
  });

  it('is refused at encode too, so creation fails where reload would', () => {
    // The host-built path: a snapshot assembled by hand rather than painted.
    // Without this, `createMaskAnnotation` accepts the mask and the *reload*
    // rejects it — the annotation disappears from a session that saved fine.
    const source = new BoundedDenseMaskBuffer({ imageWidth: 40, imageHeight: 40 });
    for (let y = 0; y < 20; y++) for (let x = 0; x < 20; x++) source.set(x, y, 1);

    expect(() =>
      encodeCanonical({ ...source.snapshot(), imageWidth: 10, imageHeight: 10 }),
    ).toThrow(/lies outside its/);
  });

  it('refuses a negative box at encode, as its error message says', () => {
    // Two negative sides multiply out to a positive area, so the data-length
    // check passes them through and no allocation cap catches them. The
    // encoder's error said "non-negative integers" while only checking
    // integrality, so this payload encoded fine and then failed to decode.
    expect(() =>
      encodeCanonical({
        x: 0,
        y: 0,
        width: -1,
        height: -1,
        data: new Uint8Array(1),
        imageWidth: 10,
        imageHeight: 10,
      }),
    ).toThrow(/non-negative integers/);
  });

  it('refuses a snapshot that reopens outside its image', () => {
    // `fromSnapshot` is public: a host can hand it a snapshot it assembled
    // itself. `reserve` clips to the image, so the overhang used to be dropped
    // in silence and the mask came back truncated on its first refining
    // stroke — the failure the decode-side guard exists to prevent.
    expect(() =>
      BoundedDenseMaskBuffer.fromSnapshot({
        x: 80,
        y: 80,
        width: 50,
        height: 50,
        data: new Uint8Array(2500).fill(1),
        imageWidth: 100,
        imageHeight: 100,
      }),
    ).toThrow(/lies outside its/);
  });

  it('refuses a fractional box at encode, which decode would reject', () => {
    // 0.5 x 4 multiplies out to a whole 2, so the data-length check passes it
    // through; only an explicit integer test catches it.
    expect(() =>
      encodeCanonical({
        x: 0,
        y: 0,
        width: 0.5,
        height: 4,
        data: new Uint8Array(2),
        imageWidth: 10,
        imageHeight: 10,
      }),
    ).toThrow(/non-negative integers/);
  });

  it('accepts a box that exactly fills its image', () => {
    const source = new BoundedDenseMaskBuffer({ imageWidth: 8, imageHeight: 8 });
    for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) source.set(x, y, 1);
    const encoded = encodeCanonical(source.snapshot());
    expect(decodeCanonical(encoded).data.filter((v) => v === 1)).toHaveLength(64);
  });
});

describe('decodeCanonical bounds the run lengths by the box', () => {
  const box = { x: 0, y: 0, width: 1, height: 1, imageWidth: 10, imageHeight: 10 };

  it('refuses a payload longer than any encoding of the box, before decoding it', () => {
    // The area cap bounds what is allocated for the pixels, but the runs were
    // decoded in full before being compared with the box: forty megabytes of
    // varints for a one-pixel mask cost seconds and half a gigabyte under a
    // cap of 1. Pinned by elapsed time as the COCO guard is: the decode this
    // skips takes seconds, so the threshold has large headroom.
    const started = Date.now();
    expect(() => decodeCanonical({ ...box, counts: 'AAAA'.repeat(1_000_000) })).toThrow(
      /longer than any encoding of 1 pixels/,
    );
    expect(Date.now() - started).toBeLessThan(500);
  });

  it('still admits the longest legitimate encoding', () => {
    // Every pixel alternating is one single-byte run per pixel, plus the
    // leading background run: the worst case the bound must not refuse.
    const width = 301;
    const runs = [0, ...Array.from({ length: width }, () => 1)];
    const counts = btoa(String.fromCharCode(...encodeVarints(runs)));
    expect(decodeCanonical({ ...box, width, imageWidth: 400, counts }).data[0]).toBe(1);
  });

  it('refuses run lengths that are not a string', () => {
    expect(() => decodeCanonical({ ...box, counts: 123 as unknown as string })).toThrow(
      /base64 string, got number/,
    );
  });
});

describe('the image side bound is applied at encode', () => {
  // The schema in `@osdlabel/validation` caps an image at 2^26 a side, and
  // the product bound alone let the encoder write a (2^26 + 10) x 100 image
  // that the schema then refused: a document `serialize` wrote and
  // `deserialize` threw on. The encoder now refuses it first.
  const dot = (imageWidth: number) => {
    const b = new BoundedDenseMaskBuffer({ imageWidth, imageHeight: 100 });
    b.set(5, 5, 1);
    return b.snapshot();
  };

  it('refuses an image wider than the schema accepts', () => {
    expect(() => encodeCanonical(dot(2 ** 26 + 10))).toThrow(/exceeds 67108864 pixels a side/);
  });

  it('accepts one exactly at the bound', () => {
    expect(encodeCanonical(dot(2 ** 26)).imageWidth).toBe(2 ** 26);
  });
});

describe('a degenerate box encodes as the empty mask', () => {
  it('drops the placement a zero-area box carried', () => {
    // A 5x0 box at the image's right edge is inside the image by the
    // arithmetic and outside it by the box check; decoding returned the empty
    // mask anyway, so write that.
    const encoded = encodeCanonical({
      x: 10,
      y: 3,
      width: 5,
      height: 0,
      data: new Uint8Array(0),
      imageWidth: 10,
      imageHeight: 10,
    });
    expect(encoded).toMatchObject({ x: 0, y: 0, width: 0, height: 0, counts: '' });
    expect(decodeCanonical(encoded).width).toBe(0);
  });
});

describe('COCO decoding refuses what is not run lengths', () => {
  it('refuses fractional runs rather than filling fractional ranges', () => {
    // [1.5, 2.5] filled a plausible two-pixel mask; a different split failed
    // only later, as a fractional bounding-box dimension.
    expect(() => cocoCountsToSnapshot([1.5, 2.5], 2, 2)).toThrow(/non-negative integers, got 1.5/);
    expect(() => cocoCountsToSnapshot([0, 2.5, 1.5], 2, 2)).toThrow(/non-negative integers/);
  });

  it('refuses counts that are not an array, instead of decoding them as empty', () => {
    expect(() => cocoCountsToSnapshot(123 as unknown as number[], 10, 10)).toThrow(
      /array of run lengths, got number/,
    );
    expect(() => decodeCocoCountsString(123 as unknown as string)).toThrow(/string, got number/);
  });

  it('refuses no runs at all for an image that has pixels', () => {
    // The empty mask is one run of the whole image; `[]` sums to nothing.
    expect(() => cocoCountsToSnapshot([], 10, 10)).toThrow(/sum to 0, but the image has 100/);
    expect(cocoCountsToSnapshot([], 0, 0).width).toBe(0);
  });

  it('names a missing size instead of failing on the destructuring', () => {
    const payload = { counts: [0, 4] } as unknown as { size: [number, number]; counts: number[] };
    expect(() => cocoRleUncompressedCodec.decode!(payload)).toThrow(/COCO size must be/);
    expect(() =>
      cocoRleCodec.decode!({ size: [2] as unknown as [number, number], counts: '04' }),
    ).toThrow(/COCO size must be/);
  });
});

describe('the COCO encoder demands a grid-aligned box', () => {
  it('refuses a host-built snapshot placed between pixels', () => {
    // Fractional runs are not COCO; the canonical encoder already refused
    // this, and the two now agree.
    const snapshot = {
      x: 0.5,
      y: 0,
      width: 1,
      height: 1,
      data: Uint8Array.from([1]),
      imageWidth: 4,
      imageHeight: 4,
    };
    expect(() => snapshotToCocoCounts(snapshot)).toThrow(/integer pixel coordinates/);
  });
});
