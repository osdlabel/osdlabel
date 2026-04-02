/**
 * Parity tests: run both old manual validators and new Valibot schemas
 * against the same inputs, asserting identical accept/reject behavior.
 */
import { describe, it, expect } from 'vitest';
import * as v from 'valibot';
import { version as FABRIC_VERSION } from 'fabric';
import {
  validateBaseAnnotation,
  validateRawAnnotationData,
  MAX_COORDINATE,
  MAX_STRING_LENGTH,
  MAX_POINTS_COUNT,
  createAnnotationId,
  createImageId,
} from '@osdlabel/annotation';
import { BaseAnnotationSchema, GeometrySchema, RawAnnotationDataSchema } from '../../src/index.js';

// ── Helpers ─────────────────────────────────────────────────────────────

function schemaAccepts<T>(schema: v.GenericSchema<unknown, T>, value: unknown): boolean {
  return v.safeParse(schema, value).success;
}

// ── Geometry Parity ─────────────────────────────────────────────────────

describe('Geometry schema parity', () => {
  const validGeometries = [
    { type: 'rectangle', origin: { x: 10, y: 20 }, width: 100, height: 50, rotation: 0 },
    { type: 'circle', center: { x: 200, y: 300 }, radius: 75 },
    { type: 'line', start: { x: 0, y: 0 }, end: { x: 10, y: 10 } },
    { type: 'point', position: { x: 5, y: 5 } },
    {
      type: 'polyline',
      points: [
        { x: 0, y: 0 },
        { x: 10, y: 10 },
        { x: 20, y: 0 },
      ],
    },
    {
      type: 'polygon',
      points: [
        { x: 0, y: 0 },
        { x: 10, y: 10 },
        { x: 20, y: 0 },
      ],
    },
  ];

  for (const geom of validGeometries) {
    it(`should accept valid ${geom.type} geometry`, () => {
      expect(schemaAccepts(GeometrySchema, geom)).toBe(true);
    });
  }

  const invalidGeometries = [
    { name: 'unknown type', value: { type: 'unknown' } },
    {
      name: 'freeHandPath (tool type, not a geometry type)',
      value: { type: 'freeHandPath', points: [{ x: 0, y: 0 }, { x: 10, y: 10 }] },
    },
    {
      name: 'NaN coordinate',
      value: { type: 'rectangle', origin: { x: NaN, y: 20 }, width: 100, height: 50, rotation: 0 },
    },
    {
      name: 'Infinity coordinate',
      value: { type: 'circle', center: { x: Infinity, y: 0 }, radius: 10 },
    },
    {
      name: 'polyline with <2 points',
      value: { type: 'polyline', points: [{ x: 0, y: 0 }] },
    },
    {
      name: 'missing required field',
      value: { type: 'rectangle', origin: { x: 0, y: 0 }, width: 100 },
    },
  ];

  for (const { name, value } of invalidGeometries) {
    it(`should reject ${name}`, () => {
      expect(schemaAccepts(GeometrySchema, value)).toBe(false);
    });
  }
});

// ── BaseAnnotation Parity ───────────────────────────────────────────────

describe('BaseAnnotation schema parity', () => {
  const annId = createAnnotationId('ann1');
  const imgId = createImageId('img1');

  const validBase = {
    id: annId,
    imageId: imgId,
    geometry: { type: 'rectangle', origin: { x: 10, y: 20 }, width: 100, height: 50, rotation: 0 },
    toolType: 'rectangle',
    createdAt: '2024-01-01T00:00:00.000Z',
    updatedAt: '2024-01-01T00:00:00.000Z',
  };

  it('should accept a valid base annotation (both old and new)', () => {
    expect(validateBaseAnnotation(validBase)).toBe(true);
    expect(schemaAccepts(BaseAnnotationSchema, validBase)).toBe(true);
  });

  it('should accept with extra extension fields', () => {
    const withExtra = {
      ...validBase,
      contextId: 'ctx1',
      rawAnnotationData: {
        format: 'fabric',
        fabricVersion: '7',
        data: { type: 'Rect', width: 1, height: 1 },
      },
    };
    expect(validateBaseAnnotation(withExtra)).toBe(true);
    expect(schemaAccepts(BaseAnnotationSchema, withExtra)).toBe(true);
  });

  const invalidBases = [
    { name: 'null', value: null },
    { name: 'undefined', value: undefined },
    { name: 'string', value: 'string' },
    { name: 'number', value: 42 },
    { name: 'missing id', value: { ...validBase, id: '' } },
    { name: 'missing imageId', value: { ...validBase, imageId: '' } },
    { name: 'invalid geometry', value: { ...validBase, geometry: { type: 'polygon' } } },
    {
      name: 'NaN in geometry',
      value: {
        ...validBase,
        geometry: {
          type: 'rectangle',
          origin: { x: NaN, y: 20 },
          width: 100,
          height: 50,
          rotation: 0,
        },
      },
    },
  ];

  for (const { name, value } of invalidBases) {
    it(`should reject ${name} (both old and new)`, () => {
      expect(validateBaseAnnotation(value)).toBe(false);
      expect(schemaAccepts(BaseAnnotationSchema, value)).toBe(false);
    });
  }
});

// ── RawAnnotationData Parity ────────────────────────────────────────────

describe('RawAnnotationData schema parity', () => {
  const validRaw = {
    format: 'fabric' as const,
    fabricVersion: FABRIC_VERSION,
    data: { type: 'Rect', width: 100, height: 50 },
  };

  it('should accept valid rawAnnotationData (both old and new)', () => {
    expect(validateRawAnnotationData(validRaw)).toBe(true);
    expect(schemaAccepts(RawAnnotationDataSchema, validRaw)).toBe(true);
  });

  it('should accept lowercase type (backward compat)', () => {
    const raw = {
      format: 'fabric' as const,
      fabricVersion: FABRIC_VERSION,
      data: { type: 'rect', width: 100, height: 50 },
    };
    expect(validateRawAnnotationData(raw)).toBe(true);
    expect(schemaAccepts(RawAnnotationDataSchema, raw)).toBe(true);
  });

  const invalidRaws = [
    { name: 'null', value: null },
    { name: 'string', value: 'string' },
    {
      name: 'unsupported fabric type',
      value: { format: 'fabric', fabricVersion: FABRIC_VERSION, data: { type: 'malicious-type' } },
    },
    {
      name: 'missing fabricVersion',
      value: { format: 'fabric', data: { type: 'Rect', width: 100, height: 50 } },
    },
    {
      name: 'invalid numeric property',
      value: {
        format: 'fabric',
        fabricVersion: FABRIC_VERSION,
        data: { type: 'Rect', width: 100, height: 50, left: 'invalid' },
      },
    },
    {
      name: 'Rect missing width',
      value: {
        format: 'fabric',
        fabricVersion: FABRIC_VERSION,
        data: { type: 'Rect', height: 50 },
      },
    },
    {
      name: 'Rect missing height',
      value: {
        format: 'fabric',
        fabricVersion: FABRIC_VERSION,
        data: { type: 'Rect', width: 100 },
      },
    },
    {
      name: 'negative Circle radius',
      value: {
        format: 'fabric',
        fabricVersion: FABRIC_VERSION,
        data: { type: 'Circle', radius: -5 },
      },
    },
    {
      name: 'coordinate exceeding MAX_COORDINATE',
      value: {
        format: 'fabric',
        fabricVersion: FABRIC_VERSION,
        data: { type: 'Rect', width: 100, height: 50, left: MAX_COORDINATE + 1 },
      },
    },
    {
      name: 'oversized string property',
      value: {
        format: 'fabric',
        fabricVersion: FABRIC_VERSION,
        data: { type: 'Rect', width: 100, height: 50, fill: 'x'.repeat(MAX_STRING_LENGTH + 1) },
      },
    },
    {
      name: 'Polyline with oversized points',
      value: {
        format: 'fabric',
        fabricVersion: FABRIC_VERSION,
        data: {
          type: 'Polyline',
          points: Array.from({ length: MAX_POINTS_COUNT + 1 }, (_, i) => ({ x: i, y: i })),
        },
      },
    },
  ];

  for (const { name, value } of invalidRaws) {
    it(`should reject ${name} (both old and new)`, () => {
      const oldResult = validateRawAnnotationData(value);
      const newResult = schemaAccepts(RawAnnotationDataSchema, value);
      expect(oldResult).toBe(false);
      expect(newResult).toBe(false);
    });
  }

  // Additional edge cases for full parity
  it('should accept Circle with valid radius', () => {
    const raw = {
      format: 'fabric' as const,
      fabricVersion: FABRIC_VERSION,
      data: { type: 'Circle', radius: 50 },
    };
    expect(validateRawAnnotationData(raw)).toBe(true);
    expect(schemaAccepts(RawAnnotationDataSchema, raw)).toBe(true);
  });

  it('should accept Line with valid coordinates', () => {
    const raw = {
      format: 'fabric' as const,
      fabricVersion: FABRIC_VERSION,
      data: { type: 'Line', x1: 0, y1: 0, x2: 100, y2: 100 },
    };
    expect(validateRawAnnotationData(raw)).toBe(true);
    expect(schemaAccepts(RawAnnotationDataSchema, raw)).toBe(true);
  });

  it('should accept Polyline with valid points', () => {
    const raw = {
      format: 'fabric' as const,
      fabricVersion: FABRIC_VERSION,
      data: {
        type: 'Polyline',
        points: [
          { x: 0, y: 0 },
          { x: 10, y: 10 },
        ],
      },
    };
    expect(validateRawAnnotationData(raw)).toBe(true);
    expect(schemaAccepts(RawAnnotationDataSchema, raw)).toBe(true);
  });

  it('should accept with optional style properties', () => {
    const raw = {
      format: 'fabric' as const,
      fabricVersion: FABRIC_VERSION,
      data: {
        type: 'Rect',
        width: 100,
        height: 50,
        stroke: 'red',
        strokeWidth: 2,
        fill: 'rgba(0,0,255,0.3)',
        opacity: 1,
      },
    };
    expect(validateRawAnnotationData(raw)).toBe(true);
    expect(schemaAccepts(RawAnnotationDataSchema, raw)).toBe(true);
  });
});
