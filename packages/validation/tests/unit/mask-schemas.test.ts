import { describe, it, expect } from 'vitest';
import * as v from 'valibot';
import { MAX_IMAGE_DIMENSION, MAX_MASK_COUNTS_LENGTH } from '../../src/schemas/constants.js';
import {
  GeometrySchema,
  MaskGeometrySchema,
  MaskRawAnnotationDataSchema,
  PointSchema,
  ToolTypeSchema,
} from '../../src/index.js';

const validMask = {
  type: 'mask',
  origin: { x: 10, y: 20 },
  width: 30,
  height: 40,
  pixelCount: 500,
};

const validRaw = {
  format: 'osdlabel-mask',
  data: {
    x: 10,
    y: 20,
    width: 30,
    height: 40,
    imageWidth: 800,
    imageHeight: 600,
    counts: 'AAEC',
  },
};

describe('mask geometry schema', () => {
  it('accepts a valid mask and resolves through the geometry variant', () => {
    expect(v.parse(MaskGeometrySchema, validMask)).toEqual(validMask);
    expect(v.parse(GeometrySchema, validMask)).toEqual(validMask);
  });

  it('rejects negative sizes and non-finite numbers', () => {
    // One side negative and the other zero, with `pixelCount: 0`: that is
    // what isolates `minValue(0)` on each side in turn. `-1 * 0` is `-0`, so
    // the `pixelCount <= width * height` cross-check passes and only the
    // bound under test can reject it. With the plain `width: -1` below, the
    // cross-check refuses the value (500 <= -40) whether or not the bound is
    // there at all — that assertion proved nothing about the bound it names.
    expect(() =>
      v.parse(MaskGeometrySchema, { ...validMask, width: -1, height: 0, pixelCount: 0 }),
    ).toThrow();
    expect(() =>
      v.parse(MaskGeometrySchema, { ...validMask, width: 0, height: -1, pixelCount: 0 }),
    ).toThrow();
    expect(() => v.parse(MaskGeometrySchema, { ...validMask, width: -1 })).toThrow();
    expect(() => v.parse(MaskGeometrySchema, { ...validMask, pixelCount: -5 })).toThrow();
    expect(() => v.parse(MaskGeometrySchema, { ...validMask, height: Number.NaN })).toThrow();
  });

  it('rejects more set pixels than the bounding box can hold', () => {
    // Arithmetically impossible, and `area()` reports `pixelCount` verbatim —
    // so an inflated one is a wrong measurement rather than a rendering glitch.
    const capacity = validMask.width * validMask.height;
    expect(() => v.parse(MaskGeometrySchema, { ...validMask, pixelCount: capacity })).not.toThrow();
    expect(() => v.parse(MaskGeometrySchema, { ...validMask, pixelCount: capacity + 1 })).toThrow();
  });
});

describe('mask raw annotation data schema', () => {
  it('accepts a canonical envelope, with or without a tint', () => {
    expect(v.parse(MaskRawAnnotationDataSchema, validRaw)).toEqual(validRaw);
    const tinted = { ...validRaw, data: { ...validRaw.data, fill: 'rgba(1,2,3,0.5)' } };
    expect(v.parse(MaskRawAnnotationDataSchema, tinted)).toEqual(tinted);
  });

  it('rejects a foreign format', () => {
    expect(() =>
      v.parse(MaskRawAnnotationDataSchema, { ...validRaw, format: 'coco-rle' }),
    ).toThrow();
  });

  it('rejects an oversized counts payload', () => {
    const huge = {
      ...validRaw,
      data: { ...validRaw.data, counts: 'a'.repeat(MAX_MASK_COUNTS_LENGTH + 1) },
    };
    expect(() => v.parse(MaskRawAnnotationDataSchema, huge)).toThrow();
  });
});

describe('tool type schema', () => {
  it('accepts the brush tool', () => {
    expect(v.parse(ToolTypeSchema, 'segmentationBrush')).toBe('segmentationBrush');
  });
});

describe('image dimensions are bounded separately from the mask', () => {
  const withImage = (imageWidth: number, imageHeight: number) => ({
    ...validRaw,
    data: { ...validRaw.data, imageWidth, imageHeight },
  });

  it('accepts a small mask on a deep-zoom image', () => {
    // Sharing one bound with the mask's own box meant a 9x9 mask painted in the
    // corner of a 1200000x900000 slide could be written by `serialize` and then
    // refused by `deserialize` — as a *schema* failure, which takes every other
    // annotation in the document with it.
    expect(() => v.parse(MaskRawAnnotationDataSchema, withImage(1_200_000, 900_000))).not.toThrow();
  });

  it('still refuses an image too large to index exactly', () => {
    // The COCO decoder walks a running index across the whole image, so the
    // bound has to keep that index inside the exact-integer range.
    expect(() => v.parse(MaskRawAnnotationDataSchema, withImage(2 ** 27, 2 ** 27))).toThrow();
  });

  it('accepts a mask placed in the far corner of a deep-zoom image', () => {
    // The box's *placement* was left at a 1e6 bound when the image bound was
    // widened, so a dab in the corner of a 1200000x900000 slide still
    // serialized and then failed to load — the exact scenario the widening
    // was for. Fixed literals: the assertion has to fail if the bound moves
    // back, which deriving the input from the constant would prevent.
    expect(() =>
      v.parse(MaskRawAnnotationDataSchema, {
        ...validRaw,
        data: {
          ...validRaw.data,
          x: 1_199_986,
          y: 899_986,
          imageWidth: 1_200_000,
          imageHeight: 900_000,
        },
      }),
    ).not.toThrow();
  });

  it('accepts a long thin box that spans a slide', () => {
    // 1047993x3 is 3.1M pixels — 5% of the pixel cap — and the brush produces
    // it from two dabs far apart on one row. A per-side bound below the image
    // bound can only reject boxes the annotator is able to paint.
    expect(() =>
      v.parse(MaskRawAnnotationDataSchema, {
        ...validRaw,
        data: {
          ...validRaw.data,
          width: 1_047_993,
          height: 3,
          imageWidth: 1_200_000,
          imageHeight: 900_000,
        },
      }),
    ).not.toThrow();
  });

  it('still refuses a box larger than any image it could belong to', () => {
    expect(() =>
      v.parse(MaskRawAnnotationDataSchema, {
        ...validRaw,
        data: { ...validRaw.data, width: MAX_IMAGE_DIMENSION + 1, height: 1 },
      }),
    ).toThrow();
    expect(MAX_IMAGE_DIMENSION).toBe(2 ** 26);
  });

  it('rejects a mask whose box area exceeds the pixel cap', () => {
    // Two sides each well inside `MAX_MASK_DIMENSION` still multiply into an
    // allocation big enough to exhaust memory. Nothing else checks that the
    // product check exists — the whole `v.check` could be deleted silently.
    expect(() =>
      v.parse(MaskRawAnnotationDataSchema, {
        ...validRaw,
        data: {
          ...validRaw.data,
          width: 100_000,
          height: 100_000,
          imageWidth: 2 ** 26,
          imageHeight: 2 ** 26,
        },
      }),
    ).toThrow(/pixels/);
  });
});

describe('geometry coordinates reject the infinities', () => {
  it('refuses a non-finite point', () => {
    // `v.number()` already rejects NaN, so `v.finite()` earns its place only
    // here — `PointSchema` has no upper bound to catch Infinity instead, and
    // an infinite coordinate propagates through every geometry that embeds a
    // point.
    expect(() => v.parse(PointSchema, { x: Number.POSITIVE_INFINITY, y: 0 })).toThrow();
    expect(() => v.parse(PointSchema, { x: 0, y: Number.NEGATIVE_INFINITY })).toThrow();
    expect(v.parse(PointSchema, { x: 1.5, y: -2.5 })).toEqual({ x: 1.5, y: -2.5 });
  });
});
