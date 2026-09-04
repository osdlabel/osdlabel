import { describe, expect, it } from 'vitest';
import * as v from 'valibot';
import { FabricRawAnnotationDataSchema } from '../../src/index.js';
import {
  MAX_COORDINATE,
  MAX_POINTS_COUNT,
  MAX_STRING_LENGTH,
} from '../../src/schemas/constants.js';

/** Wraps a bare fabric object in the envelope the schema actually validates. */
function envelope(data: Record<string, unknown>): unknown {
  return { format: 'fabric', fabricVersion: '7.1.0', data };
}

const accepts = (data: Record<string, unknown>): boolean =>
  v.safeParse(FabricRawAnnotationDataSchema, envelope(data)).success;

/** A minimally-valid object of each supported fabric type. */
const RECT = { type: 'rect', left: 0, top: 0, width: 10, height: 10 } as const;
const CIRCLE = { type: 'circle', left: 0, top: 0, radius: 5 } as const;
const LINE = { type: 'line', x1: 0, y1: 0, x2: 10, y2: 10 } as const;
const POLYLINE = {
  type: 'polyline',
  points: [
    { x: 0, y: 0 },
    { x: 1, y: 1 },
  ],
} as const;
const POLYGON = { ...POLYLINE, type: 'polygon' } as const;

describe('FabricRawAnnotationDataSchema', () => {
  describe('supported types', () => {
    it.each([
      ['rect', RECT],
      ['circle', CIRCLE],
      ['line', LINE],
      ['polyline', POLYLINE],
      ['polygon', POLYGON],
    ])('accepts a minimal %s', (_name, data) => {
      expect(accepts(data)).toBe(true);
    });

    it('rejects an unsupported type', () => {
      expect(accepts({ type: 'triangle' })).toBe(false);
    });

    // normalizeType()/isSupportedFabricType() lowercase before comparing. Fabric
    // v7 serializes `type` capitalised ("Rect"), so dropping the toLowerCase()
    // would reject every real payload — but no test used a capitalised type.
    it.each([['Rect'], ['CIRCLE'], ['Line'], ['PolyLine'], ['Polygon']])(
      'accepts the capitalised type %s',
      (type) => {
        const base: Record<string, Record<string, unknown>> = {
          rect: { ...RECT },
          circle: { ...CIRCLE },
          line: { ...LINE },
          polyline: { ...POLYLINE },
          polygon: { ...POLYGON },
        };
        expect(accepts({ ...base[type.toLowerCase()]!, type })).toBe(true);
      },
    );

    it('applies the type-specific rules to a capitalised type too', () => {
      // Guards against a normalizeType() that lowercases for the supported-type
      // check but not for the per-type requirement checks.
      expect(accepts({ type: 'Circle', left: 0, top: 0 })).toBe(false);
      expect(accepts({ type: 'Rect', width: -1, height: 10 })).toBe(false);
    });
  });

  describe('rect requirements', () => {
    it.each([
      ['missing width', { type: 'rect', height: 10 }],
      ['missing height', { type: 'rect', width: 10 }],
      ['non-finite width', { type: 'rect', width: Number.NaN, height: 10 }],
    ])('rejects a rect with %s', (_name, data) => {
      expect(accepts(data)).toBe(false);
    });

    it('accepts a zero-sized rect', () => {
      expect(accepts({ type: 'rect', width: 0, height: 0 })).toBe(true);
    });
  });

  describe('circle requirements', () => {
    it.each([
      ['missing radius', { type: 'circle' }],
      ['a negative radius', { type: 'circle', radius: -1 }],
      ['a non-finite radius', { type: 'circle', radius: Number.POSITIVE_INFINITY }],
      ['a non-numeric radius', { type: 'circle', radius: '5' }],
    ])('rejects a circle with %s', (_name, data) => {
      expect(accepts(data)).toBe(false);
    });

    it('accepts a zero radius', () => {
      expect(accepts({ type: 'circle', radius: 0 })).toBe(true);
    });
  });

  describe('line requirements', () => {
    it.each([['x1'], ['y1'], ['x2'], ['y2']])('rejects a line missing %s', (missing) => {
      const data: Record<string, unknown> = { ...LINE };
      delete data[missing];
      expect(accepts(data)).toBe(false);
    });

    it('rejects a line endpoint beyond MAX_COORDINATE', () => {
      expect(accepts({ ...LINE, x2: MAX_COORDINATE + 1 })).toBe(false);
      expect(accepts({ ...LINE, x2: -(MAX_COORDINATE + 1) })).toBe(false);
    });

    it('accepts a line endpoint exactly at MAX_COORDINATE', () => {
      expect(accepts({ ...LINE, x2: MAX_COORDINATE })).toBe(true);
    });
  });

  describe('polyline / polygon requirements', () => {
    it.each([['polyline'], ['polygon']])('rejects a %s whose points are not an array', (type) => {
      expect(accepts({ type, points: 'nope' })).toBe(false);
      expect(accepts({ type })).toBe(false);
    });

    it.each([['polyline'], ['polygon']])('rejects a %s with a non-object point', (type) => {
      expect(accepts({ type, points: [{ x: 0, y: 0 }, null] })).toBe(false);
      expect(accepts({ type, points: [{ x: 0, y: 0 }, 42] })).toBe(false);
    });

    it.each([['polyline'], ['polygon']])('rejects a %s with a non-finite coordinate', (type) => {
      expect(accepts({ type, points: [{ x: 0, y: Number.NaN }] })).toBe(false);
      expect(accepts({ type, points: [{ x: 0 }] })).toBe(false);
    });

    it('rejects more than MAX_POINTS_COUNT points', () => {
      const tooMany = Array.from({ length: MAX_POINTS_COUNT + 1 }, () => ({ x: 0, y: 0 }));
      expect(accepts({ type: 'polyline', points: tooMany })).toBe(false);
    });

    it('accepts exactly MAX_POINTS_COUNT points', () => {
      const atLimit = Array.from({ length: MAX_POINTS_COUNT }, () => ({ x: 0, y: 0 }));
      expect(accepts({ type: 'polyline', points: atLimit })).toBe(true);
    });

    it('accepts an empty points array', () => {
      expect(accepts({ type: 'polyline', points: [] })).toBe(true);
    });
  });

  describe('numeric bounds', () => {
    it.each([['left'], ['top'], ['scaleX'], ['scaleY'], ['angle'], ['opacity']])(
      'rejects %s beyond MAX_COORDINATE',
      (prop) => {
        expect(accepts({ ...RECT, [prop]: MAX_COORDINATE + 1 })).toBe(false);
        expect(accepts({ ...RECT, [prop]: -(MAX_COORDINATE + 1) })).toBe(false);
      },
    );

    it.each([['left'], ['top'], ['scaleX'], ['scaleY'], ['angle'], ['opacity']])(
      'rejects a non-finite %s',
      (prop) => {
        expect(accepts({ ...RECT, [prop]: Number.POSITIVE_INFINITY })).toBe(false);
        expect(accepts({ ...RECT, [prop]: Number.NaN })).toBe(false);
      },
    );

    it('accepts a value exactly at MAX_COORDINATE', () => {
      expect(accepts({ ...RECT, left: MAX_COORDINATE })).toBe(true);
    });
  });

  describe('dimension bounds', () => {
    // validateDimensionProps applies to every type, not just rect — a circle
    // carrying a negative width is rejected by it alone, so this is the case
    // that distinguishes it from validateRectRequirements.
    it('rejects a negative width on a non-rect type', () => {
      expect(accepts({ ...CIRCLE, width: -1 })).toBe(false);
    });

    it('rejects a width beyond MAX_COORDINATE on a non-rect type', () => {
      expect(accepts({ ...CIRCLE, height: MAX_COORDINATE + 1 })).toBe(false);
    });

    it('accepts a dimension exactly at MAX_COORDINATE', () => {
      expect(accepts({ type: 'rect', width: MAX_COORDINATE, height: 0 })).toBe(true);
    });
  });

  describe('string bounds', () => {
    it.each([['fill'], ['stroke'], ['backgroundColor']])(
      'rejects %s longer than MAX_STRING_LENGTH',
      (prop) => {
        expect(accepts({ ...RECT, [prop]: 'x'.repeat(MAX_STRING_LENGTH + 1) })).toBe(false);
      },
    );

    it('accepts a string exactly at MAX_STRING_LENGTH', () => {
      expect(accepts({ ...RECT, fill: 'x'.repeat(MAX_STRING_LENGTH) })).toBe(true);
    });

    it('accepts a null fill', () => {
      expect(accepts({ ...RECT, fill: null })).toBe(true);
    });
  });

  // These bounds are part of the schema's contract. Asserting them literally
  // matters because every boundary test below builds its input *from* the
  // constant — without this pin, widening a constant would silently widen the
  // tests with it and the mutation would survive.
  describe('bounds constants', () => {
    it('are the documented values', () => {
      expect(MAX_COORDINATE).toBe(1_000_000);
      expect(MAX_STRING_LENGTH).toBe(256);
      expect(MAX_POINTS_COUNT).toBe(10_000);
    });
  });

  describe('envelope', () => {
    it('rejects a non-fabric format', () => {
      expect(v.safeParse(FabricRawAnnotationDataSchema, { ...RECT }).success).toBe(false);
      expect(
        v.safeParse(FabricRawAnnotationDataSchema, {
          format: 'svg',
          fabricVersion: '7.1.0',
          data: RECT,
        }).success,
      ).toBe(false);
    });

    it('requires fabricVersion', () => {
      expect(
        v.safeParse(FabricRawAnnotationDataSchema, { format: 'fabric', data: RECT }).success,
      ).toBe(false);
    });
  });
});
