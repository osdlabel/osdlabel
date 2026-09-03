import { describe, it, expect } from 'vitest';
import {
  BoundedDenseMaskBuffer,
  createMaskCodecRegistry,
  cocoRleCodec,
  cocoRleUncompressedCodec,
  encodeCanonical,
} from '@osdlabel/mask';
// Reached by path: these bounds are internal to `@osdlabel/validation` and
// exporting them would widen the public surface just to test a relationship
// between them.
import {
  MAX_MASK_COUNTS_LENGTH,
  MAX_MASK_PIXELS,
} from '../../../validation/src/schemas/constants.js';
import { deserialize, serialize, SerializationError } from '../../src/serialization-configured.js';
import { createMaskAnnotation } from '../../src/create-mask-annotation.js';

/**
 * `deserialize` is the boundary an untrusted document crosses: annotation JSON
 * routinely comes from another tool, another user, or a file on disk. These
 * cover the shapes that previously got through, and the blast radius when one
 * annotation in a document is bad.
 */

/** Minimal unsigned LEB128, matching the canonical codec's own encoding. */
function encodeLeb(value: number): number[] {
  const out: number[] = [];
  let remaining = value;
  do {
    const byte = remaining % 0x80;
    remaining = Math.floor(remaining / 0x80);
    out.push(remaining !== 0 ? byte | 0x80 : byte);
  } while (remaining !== 0);
  return out;
}

/** A canonical payload for a solid `side`x`side` mask at the origin. */
function solidMask(side: number, imageSide = 4096): Record<string, unknown> {
  return {
    x: 0,
    y: 0,
    width: side,
    height: side,
    imageWidth: imageSide,
    imageHeight: imageSide,
    counts: Buffer.from(Uint8Array.from([0, ...encodeLeb(side * side)])).toString('base64'),
  };
}

function vectorAnnotation(imageId: string, id: string) {
  return {
    id,
    imageId,
    contextId: 'ctx',
    toolType: 'rectangle',
    geometry: { type: 'rectangle', origin: { x: 0, y: 0 }, width: 1, height: 1, rotation: 0 },
    rawAnnotationData: {
      format: 'fabric',
      fabricVersion: '7.1.0',
      data: { id, type: 'rect', left: 0, top: 0, width: 1, height: 1 },
    },
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

function maskAnnotation(data: Record<string, unknown>, format = 'osdlabel-mask') {
  return {
    id: 'mask-1',
    imageId: 'img-1',
    contextId: 'ctx',
    toolType: 'segmentationBrush',
    geometry: { type: 'mask', origin: { x: 0, y: 0 }, width: 2, height: 2, pixelCount: 4 },
    rawAnnotationData: { format, data },
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

describe('deserialize: prototype safety', () => {
  it('does not let a crafted imageId or id reach Object.prototype', () => {
    deserialize([
      vectorAnnotation('__proto__', 'polluted'),
      vectorAnnotation('__proto__', 'toString'),
    ]);

    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    // A clobbered Object.prototype.toString breaks string coercion everywhere.
    expect(() => String({})).not.toThrow();
    expect(String({})).toBe('[object Object]');
  });

  it('groups by branded ids without inheriting prototype keys', () => {
    const { byImage } = deserialize([vectorAnnotation('img-1', 'ann-1')]);
    expect(Object.keys(byImage)).toEqual(['img-1']);
    expect('toString' in byImage).toBe(false);
  });
});

describe('deserialize: bounding the work a document can demand', () => {
  it('refuses a COCO payload whose declared image would take hours to scan', () => {
    const registry = createMaskCodecRegistry(cocoRleUncompressedCodec);
    const doc = [
      maskAnnotation({ size: [1_000_000, 1_000_000], counts: [0, 1e12] }, 'coco-rle-uncompressed'),
    ];

    // The capacity guard used to run *after* a scan of every foreground pixel,
    // so this payload took an estimated hours. Asserting on the clock would
    // flake on a loaded runner; the outcome is enough, because reaching the
    // guard at all means the scan was skipped — the old code could only reach
    // it by first doing the work.
    const { skipped, byImage } = deserialize(doc, { maskCodecs: registry });
    expect(skipped).toHaveLength(1);
    expect(skipped[0]!.reason).toMatch(/pixel cap/);
    expect(Object.keys(byImage)).toHaveLength(0);
  });

  it('still decodes a small mask on a gigapixel canvas', () => {
    const registry = createMaskCodecRegistry(cocoRleUncompressedCodec);
    const w = 100_000;
    const h = 100_000;
    const lead = 50_000 * h + 500;
    const counts = [lead, 4, h - 4, 4, w * h - lead - 4 - (h - 4) - 4];
    const doc = [maskAnnotation({ size: [h, w], counts }, 'coco-rle-uncompressed')];

    const { byImage } = deserialize(doc, { maskCodecs: registry });
    const ann = byImage['img-1' as never]!['mask-1' as never]!;
    expect(ann.geometry).toMatchObject({ width: 2, height: 4, pixelCount: 8 });
  });

  it('bounds the whole document, not just each mask in it', () => {
    const registry = createMaskCodecRegistry(cocoRleUncompressedCodec);
    // Each mask is 100x100; individually trivial, and any one alone fits the
    // budget. Twenty do not. Without a document-wide budget a per-mask cap
    // bounds nothing, because a document may hold any number of masks.
    const doc = Array.from({ length: 20 }, (_, i) => ({
      ...maskAnnotation({ size: [100, 100], counts: [0, 10_000] }, 'coco-rle-uncompressed'),
      id: `mask-${i}`,
    }));

    expect(() => deserialize(doc, { maskCodecs: registry, maxTotalMaskPixels: 50_000 })).toThrow(
      SerializationError,
    );
    // The same masks load when the budget covers them — the bound is on the
    // document's total, not on any one of them.
    expect(() =>
      deserialize(doc, { maskCodecs: registry, maxTotalMaskPixels: 10_000_000 }),
    ).not.toThrow();
  });

  it('does not reject a zero-cost mask when the budget is exactly spent', () => {
    const registry = createMaskCodecRegistry(cocoRleUncompressedCodec);
    // An empty mask costs nothing, so whether it loads must not depend on how
    // much of the budget the masks before it happened to use.
    const empty = {
      ...maskAnnotation({ size: [10, 10], counts: [100] }, 'coco-rle-uncompressed'),
      id: 'empty',
    };
    const { skipped } = deserialize([empty, empty], {
      maskCodecs: registry,
      maxTotalMaskPixels: 0,
    });
    expect(skipped).toEqual([]);
  });

  it('loads a realistic dense-annotation document', () => {
    // 130 solid 1024x1024 masks: about 50 KB on disk, and exactly the
    // document a too-tight default budget rejected outright. Losing real work
    // is the worse failure, so the default errs generous.
    const doc = Array.from({ length: 130 }, (_, i) => ({
      ...maskAnnotation(solidMask(1024)),
      id: `mask-${i}`,
    }));

    const { byImage, skipped } = deserialize(doc);
    expect(skipped).toEqual([]);
    expect(Object.keys(byImage['img-1' as never]!)).toHaveLength(130);
  });

  it('treats Infinity as "no document budget"', () => {
    // The error raised when the budget is exceeded tells the caller to raise
    // it, so the value that most obviously does must be accepted — rejecting
    // it pointed at a fix the API declined.
    const doc = Array.from({ length: 12 }, (_, i) => ({
      ...maskAnnotation(solidMask(256)),
      id: `mask-${i}`,
    }));

    expect(() => deserialize(doc, { maxTotalMaskPixels: 100_000 })).toThrow(SerializationError);
    expect(deserialize(doc, { maxTotalMaskPixels: Number.POSITIVE_INFINITY }).skipped).toEqual([]);
  });

  it('still rejects a bound that is not a number at all', () => {
    const doc = [maskAnnotation(solidMask(64))];
    expect(() => deserialize(doc, { maxTotalMaskPixels: Number.NaN })).toThrow(SerializationError);
    expect(() => deserialize(doc, { maxMaskPixels: Number.NaN })).toThrow(SerializationError);
    expect(() => deserialize(doc, { maxTotalMaskPixels: -1 })).toThrow(SerializationError);
  });

  it('lets a host tighten the per-mask cap for an untrusted document', () => {
    const registry = createMaskCodecRegistry(cocoRleUncompressedCodec);
    const doc = [
      maskAnnotation({ size: [4000, 4000], counts: [0, 16_000_000] }, 'coco-rle-uncompressed'),
    ];

    expect(deserialize(doc, { maskCodecs: registry, maxMaskPixels: 1000 }).skipped).toHaveLength(1);
    expect(deserialize(doc, { maskCodecs: registry }).skipped).toEqual([]);
  });
});

describe('deserialize: a bad mask does not take the document with it', () => {
  it('drops a canonical payload that cannot be decoded, rather than admitting it', () => {
    // Empty counts against a 2x2 box: the runs cannot fill it. Admitting this
    // deferred the throw to render time, where the cell had already cleared.
    const shortRuns = deserialize([
      maskAnnotation({
        x: 0,
        y: 0,
        width: 2,
        height: 2,
        imageWidth: 8,
        imageHeight: 8,
        counts: '',
      }),
    ]);
    expect(shortRuns.skipped).toHaveLength(1);
    expect(shortRuns.skipped[0]!.id).toBe('mask-1');
    expect(shortRuns.skipped[0]!.reason).toMatch(/sum to 0/);
    expect(Object.keys(shortRuns.byImage)).toHaveLength(0);

    const badBase64 = deserialize([
      maskAnnotation({
        x: 0,
        y: 0,
        width: 2,
        height: 2,
        imageWidth: 8,
        imageHeight: 8,
        counts: '!!!!',
      }),
    ]);
    expect(badBase64.skipped).toHaveLength(1);
    expect(badBase64.skipped[0]!.reason).toMatch(/base64/);
  });

  it('loses only the corrupt mask, not the forty annotations around it', () => {
    const doc: unknown[] = Array.from({ length: 40 }, (_, i) =>
      vectorAnnotation('img-1', `rect-${i}`),
    );
    doc.push(
      maskAnnotation({
        x: 0,
        y: 0,
        width: 2,
        height: 2,
        imageWidth: 8,
        imageHeight: 8,
        counts: '',
      }),
    );

    const { byImage, skipped } = deserialize(doc);
    expect(Object.keys(byImage['img-1' as never]!)).toHaveLength(40);
    expect(skipped).toHaveLength(1);
    expect(skipped[0]!.id).toBe('mask-1');
  });

  it('reports nothing skipped for a clean document', () => {
    expect(deserialize([vectorAnnotation('img-1', 'ann-1')]).skipped).toEqual([]);
  });

  it('drops a COCO payload with a fractional image size', () => {
    const registry = createMaskCodecRegistry(cocoRleUncompressedCodec);
    const { skipped } = deserialize(
      [maskAnnotation({ size: [2.5, 2], counts: [0, 5] }, 'coco-rle-uncompressed')],
      { maskCodecs: registry },
    );
    expect(skipped).toHaveLength(1);
    expect(skipped[0]!.reason).toMatch(/integers/);
  });
});

describe('deserialize: attributing a failure to the right cause', () => {
  const oversized = (side: number, id: string) => ({
    ...maskAnnotation({ size: [side, side], counts: [0, side * side] }, 'coco-rle-uncompressed'),
    id,
  });

  it('gives the same answer whatever order the masks are in', () => {
    const registry = createMaskCodecRegistry(cocoRleUncompressedCodec);
    // Five masks inside the per-mask cap, plus one far outside it. Deciding
    // "whose fault" from the cap that happened to apply made this depend on
    // position: the same six either loaded five, or threw and lost all six.
    const small = [0, 1, 2, 3, 4].map((i) => oversized(1732, `s${i}`));
    const hostile = oversized(30_000, 'hostile');
    const opts = {
      maskCodecs: registry,
      maxMaskPixels: 4_000_000,
      maxTotalMaskPixels: 16_000_000,
    };

    for (const doc of [
      [hostile, ...small],
      [...small, hostile],
    ]) {
      const { byImage, skipped } = deserialize(doc, opts);
      expect(Object.keys(byImage['img-1' as never]!)).toHaveLength(5);
      expect(skipped.map((entry) => entry.id)).toEqual(['hostile']);
    }
  });

  it('still throws when the budget is what ran out', () => {
    const registry = createMaskCodecRegistry(cocoRleUncompressedCodec);
    const doc = [0, 1, 2, 3].map((i) => oversized(1732, `s${i}`));
    expect(() =>
      deserialize(doc, {
        maskCodecs: registry,
        maxMaskPixels: 4_000_000,
        maxTotalMaskPixels: 6_000_000,
      }),
    ).toThrow(SerializationError);
  });

  it('does not mistake a third-party codec failure for a per-mask one', () => {
    // The codec contract names no error type, so attribution cannot be read off
    // the error — a foreign codec's own failure used to look like a skip and
    // quietly load half a document.
    const custom = {
      format: 'custom',
      encode: () => ({}),
      decode: (payload: { readonly side: number }, options?: { readonly maxPixels?: number }) => {
        const px = payload.side * payload.side;
        if (options?.maxPixels !== undefined && px > options.maxPixels) {
          throw new RangeError(`custom codec refuses ${px}`);
        }
        return {
          x: 0,
          y: 0,
          width: payload.side,
          height: payload.side,
          data: new Uint8Array(px).fill(1),
          imageWidth: 4096,
          imageHeight: 4096,
        };
      },
    };
    const registry = createMaskCodecRegistry(custom as never);
    const doc = [0, 1, 2, 3].map((i) => ({
      ...maskAnnotation({ side: 95 }, 'custom'),
      id: `v${i}`,
    }));

    expect(() =>
      deserialize(doc, { maskCodecs: registry, maxMaskPixels: 10_000, maxTotalMaskPixels: 20_000 }),
    ).toThrow(SerializationError);
  });
});

describe('deserialize: the bounds themselves are validated', () => {
  it('rejects a non-finite bound instead of silently removing the bound', () => {
    // `NaN` makes every comparison false, so an unvalidated bound does not
    // misbehave — it disables the only thing bounding this path.
    const doc = [maskAnnotation(solidMask(1024))];
    expect(() => deserialize(doc, { maxTotalMaskPixels: Number.NaN })).toThrow(SerializationError);
    expect(() => deserialize(doc, { maxMaskPixels: Number.NaN })).toThrow(SerializationError);
    expect(() => deserialize(doc, { maxMaskPixels: -1 })).toThrow(SerializationError);
  });
});

describe('deserialize: entries that are not annotations', () => {
  it('lets validation reject a null entry rather than dropping it', () => {
    // `null` is also how the mask pass marks a dropped entry; filtering on it
    // swallowed a document's own nulls, and not even into `skipped`.
    expect(() => deserialize([null])).toThrow(SerializationError);
    expect(() => deserialize([null, vectorAnnotation('img-1', 'a')])).toThrow(SerializationError);
    expect(() => deserialize([undefined])).toThrow(SerializationError);
  });
});

describe('deserialize: geometry is rebuilt from pixels', () => {
  it('recomputes mask geometry for canonical payloads, not just foreign ones', () => {
    // Geometry claims a mask far from the origin; the pixels say otherwise.
    const doc = [
      {
        ...maskAnnotation({
          x: 3,
          y: 5,
          width: 2,
          height: 1,
          imageWidth: 16,
          imageHeight: 16,
          counts: Buffer.from(Uint8Array.from([0, 2])).toString('base64'),
        }),
        geometry: { type: 'mask', origin: { x: 900, y: 900 }, width: 1, height: 1, pixelCount: 1 },
      },
    ];

    const { byImage } = deserialize(doc);
    const ann = byImage['img-1' as never]!['mask-1' as never]!;
    expect(ann.geometry).toMatchObject({
      origin: { x: 3, y: 5 },
      width: 2,
      height: 1,
      pixelCount: 2,
    });
  });
});

describe('the pixel cap and the counts cap agree', () => {
  it('accepts a document holding the longest encoding a real mask can produce', () => {
    // The two constants live in different packages, tied only by a formula.
    // This checks the property they exist for — serialize must never emit a
    // mask its own deserialize refuses — by painting the worst case (every
    // pixel alternating, one single-byte run each) and encoding it for real.
    const width = 1200;
    const height = 900;
    const buffer = new BoundedDenseMaskBuffer({ imageWidth: width, imageHeight: height });
    for (let y = 0; y < height; y++) {
      for (let x = y % 2; x < width; x += 2) buffer.set(x, y, 1);
    }
    const encoded = encodeCanonical(buffer.snapshot());
    expect(encoded.counts.length).toBeGreaterThan(width * height);

    // Painting the full 64-megapixel cap here would allocate gigabytes, so the
    // ratio is measured on this mask and extrapolated. Without this the test
    // exercised under 2% of the range: `MAX_MASK_COUNTS_LENGTH` could be cut
    // to a quarter of its value — the exact regression its derivation exists
    // to prevent — and a 1200x900 mask still fitted comfortably.
    // Measured, so 4/3 is shown to be the real worst case and not an
    // over-estimate: one single-byte run per pixel, base64'd. It lands a hair
    // under because runs merge across row boundaries where the alternation
    // lines up.
    const charsPerPixel = encoded.counts.length / (width * height);
    expect(charsPerPixel).toBeGreaterThan(0.99 * (4 / 3));
    expect(charsPerPixel).toBeLessThanOrEqual(4 / 3);
    // ...and the cap covers that ratio across the *whole* pixel range, which
    // is the property the two constants exist to hold together.
    expect(MAX_MASK_COUNTS_LENGTH).toBeGreaterThanOrEqual(Math.ceil((MAX_MASK_PIXELS * 4) / 3));

    const doc = [
      {
        ...maskAnnotation(encoded as unknown as Record<string, unknown>),
        geometry: {
          type: 'mask',
          origin: { x: encoded.x, y: encoded.y },
          width: encoded.width,
          height: encoded.height,
          pixelCount: 1,
        },
      },
    ];
    expect(deserialize(doc).skipped).toEqual([]);
  });
});

describe('a mask on a deep-zoom slide survives its own serialization', () => {
  /** State holding the given annotations, as the annotator would. */
  const stateOf = (annotations: readonly { id: string }[]) =>
    ({
      byImage: { 'img-1': Object.fromEntries(annotations.map((a) => [a.id, a])) },
      changeCounter: 1,
    }) as never;

  it('round-trips a dab painted in the far corner of a 1200000x900000 image', () => {
    // The bug this pins: the schema bounded the mask's *placement* at 1e6
    // while the image bound was 2^26, so `serialize` wrote a mask that
    // `deserialize` refused — as a schema failure, which throws and loses
    // every other annotation in the document rather than skipping this one.
    //
    // Asserted through serialize/deserialize rather than `v.parse`, because
    // the schema-level test for the image bound passed throughout: it widened
    // `imageWidth` but left the mask at the origin.
    const W = 1_200_000;
    const H = 900_000;
    const far = new BoundedDenseMaskBuffer({ imageWidth: W, imageHeight: H });
    for (let y = H - 14; y < H - 6; y++) for (let x = W - 14; x < W - 6; x++) far.set(x, y, 1);

    const corner = createMaskAnnotation(far.snapshot(), {
      imageId: 'img-1' as never,
      contextId: 'ctx' as never,
      id: 'corner' as never,
    });

    const near = new BoundedDenseMaskBuffer({ imageWidth: W, imageHeight: H });
    near.set(500, 500, 1);
    const middle = createMaskAnnotation(near.snapshot(), {
      imageId: 'img-1' as never,
      contextId: 'ctx' as never,
      id: 'middle' as never,
    });

    const doc = JSON.parse(JSON.stringify(serialize(stateOf([corner, middle]))));
    const { byImage, skipped } = deserialize(doc);

    expect(skipped).toEqual([]);
    const loaded = byImage['img-1' as never]!;
    expect(Object.keys(loaded)).toHaveLength(2);
    expect(loaded['corner' as never]!.geometry).toMatchObject({
      origin: { x: W - 14, y: H - 14 },
      width: 8,
      height: 8,
      pixelCount: 64,
    });
  });

  it('round-trips a long thin mask spanning most of a slide', () => {
    // Two dabs a million pixels apart on one row: the box is 1047993 wide but
    // holds 3.1M pixels, 5% of the cap. Nothing warns the user, so a per-side
    // bound below the image bound makes the document silently unloadable.
    const W = 1_200_000;
    const H = 900_000;
    const buffer = new BoundedDenseMaskBuffer({ imageWidth: W, imageHeight: H });
    for (let x = 10; x < 13; x++) for (let y = 5; y < 8; y++) buffer.set(x, y, 1);
    for (let x = 1_048_000; x < 1_048_003; x++) for (let y = 5; y < 8; y++) buffer.set(x, y, 1);

    const wide = createMaskAnnotation(buffer.snapshot(), {
      imageId: 'img-1' as never,
      contextId: 'ctx' as never,
      id: 'wide' as never,
    });
    expect(wide.geometry).toMatchObject({ width: 1_047_993, height: 3, pixelCount: 18 });

    const doc = JSON.parse(JSON.stringify(serialize(stateOf([wide]))));
    const { byImage, skipped } = deserialize(doc);

    expect(skipped).toEqual([]);
    expect(byImage['img-1' as never]!['wide' as never]!.geometry).toEqual(wide.geometry);
  });
});

describe('serialize: a codec failure stays inside this module', () => {
  it("wraps a codec's encode error rather than leaking it", () => {
    // `encode` is wrapped as well as `decode`, and the two fail for different
    // reasons. Both built-in codecs now refuse an out-of-image box at *encode*
    // time — which `decodeCanonical` also refuses, so that box can no longer
    // reach `encode` at all. What can is a third-party codec: `MaskCodec` is a
    // published extension point, and a format with its own limits (a size cap,
    // an unsupported geometry) raises from `encode` on a mask that is
    // perfectly valid canonically. Leaving that half bare let the foreign error
    // escape a documented API.
    const buffer = new BoundedDenseMaskBuffer({ imageWidth: 16, imageHeight: 16 });
    buffer.set(2, 2, 1);
    const annotation = createMaskAnnotation(buffer.snapshot(), {
      imageId: 'img-1' as never,
      contextId: 'ctx' as never,
    });
    const state = {
      byImage: { 'img-1': { [annotation.id]: annotation } },
      changeCounter: 1,
    } as never;

    const pickyCodec = {
      format: 'picky',
      encode: (): never => {
        throw new RangeError('this format cannot express single-pixel masks');
      },
    };

    // Canonically the mask is fine — the decode half succeeds...
    expect(() => serialize(state)).not.toThrow();
    // ...so only the encode half can be what fails here.
    let thrown: unknown;
    try {
      serialize(state, { maskCodec: pickyCodec });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(SerializationError);
    expect((thrown as Error).message).toMatch(/Could not re-encode mask/);
    expect((thrown as Error).message).toMatch(/cannot express single-pixel masks/);
  });

  it('wraps a decode error on a payload that reached state some other way', () => {
    // The other half. State is taken at face value — it is not the import
    // boundary — so a payload assembled by a host, or carried over from an
    // older document, can be undecodable.
    const annotation = {
      id: 'ann-1',
      geometry: { type: 'mask', origin: { x: 0, y: 0 }, width: 4, height: 4, pixelCount: 1 },
      toolType: 'segmentationBrush',
      imageId: 'img-1',
      contextId: 'ctx',
      rawAnnotationData: {
        format: 'osdlabel-mask',
        // Runs that sum to less than the box they claim to fill.
        data: { x: 0, y: 0, width: 4, height: 4, imageWidth: 16, imageHeight: 16, counts: 'AQE=' },
      },
      createdAt: '2024-01-01T00:00:00.000Z',
      updatedAt: '2024-01-01T00:00:00.000Z',
    };
    const state = {
      byImage: { 'img-1': { 'ann-1': annotation } },
      changeCounter: 1,
    } as never;

    expect(() => serialize(state, { maskCodec: cocoRleCodec })).toThrow(SerializationError);
  });
});

describe('deserialize: the decode bounds reject non-numbers', () => {
  it('refuses a string bound rather than silently having no bound', () => {
    // `Number.isNaN` does not coerce, so a string passed the check, and
    // `Math.min('big', cap)` is NaN — which fails every later comparison and
    // removes the cap entirely. A JS host, or one reading limits from config,
    // reaches this; a TypeScript one does not.
    const doc = [maskAnnotation(solidMask(64))];
    for (const bad of ['big', null, {}, []] as unknown[]) {
      expect(() => deserialize(doc, { maxMaskPixels: bad as number })).toThrow(SerializationError);
      expect(() => deserialize(doc, { maxTotalMaskPixels: bad as number })).toThrow(
        SerializationError,
      );
    }
  });
});

describe('the library can read back what it writes', () => {
  it('round-trips a dense annotation session through the defaults', () => {
    // `serialize` imposes no budget and a document may hold any number of
    // masks, so no finite default makes the two perfectly symmetric — but the
    // default must not refuse an ordinary day's work. 100 solid 3000x2000
    // masks is 40 KB on disk and was refused outright.
    const doc = Array.from({ length: 100 }, (_, i) => ({
      ...maskAnnotation(solidMask(2449, 4000)),
      id: `mask-${i}`,
    }));

    const { byImage, skipped } = deserialize(doc);
    expect(skipped).toEqual([]);
    expect(Object.keys(byImage['img-1' as never]!)).toHaveLength(100);
  });

  it('round-trips a mask painted on a deep-zoom image', () => {
    // The image bound is a schema check, so failing it loses the whole
    // document rather than skipping the one mask.
    const doc = [maskAnnotation(solidMask(9, 1_200_000))];
    expect(() => deserialize(doc)).not.toThrow();
  });
});
