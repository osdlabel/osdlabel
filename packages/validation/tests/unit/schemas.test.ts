import { describe, it, expect } from 'vitest';
import * as v from 'valibot';
import {
  GeometrySchema,
  BaseAnnotationSchema,
  OsdAnnotationSchema,
  FabricRawAnnotationDataSchema,
} from '../../src/index.js';

describe('Validation Schemas', () => {
  // Helper to cleanly check if data passes a schema
  function isValid<T>(schema: v.GenericSchema<unknown, T>, data: unknown): boolean {
    return v.safeParse(schema, data).success;
  }

  describe('GeometrySchema', () => {
    it('accepts valid geometries of all types', () => {
      expect(
        isValid(GeometrySchema, {
          type: 'rectangle',
          origin: { x: 0, y: 0 },
          width: 100,
          height: 50,
          rotation: 0,
        }),
      ).toBe(true);
      expect(isValid(GeometrySchema, { type: 'circle', center: { x: 10, y: 10 }, radius: 5 })).toBe(
        true,
      );
      expect(
        isValid(GeometrySchema, { type: 'line', start: { x: 0, y: 0 }, end: { x: 10, y: 10 } }),
      ).toBe(true);
      expect(isValid(GeometrySchema, { type: 'point', position: { x: 5, y: 5 } })).toBe(true);
      expect(
        isValid(GeometrySchema, {
          type: 'polyline',
          points: [
            { x: 0, y: 0 },
            { x: 10, y: 10 },
          ],
        }),
      ).toBe(true);
      expect(
        isValid(GeometrySchema, {
          type: 'polygon',
          points: [
            { x: 0, y: 0 },
            { x: 10, y: 10 },
            { x: 0, y: 10 },
          ],
        }),
      ).toBe(true);
    });

    it('rejects invalid or incomplete geometries', () => {
      expect(isValid(GeometrySchema, { type: 'unknown' })).toBe(false);
      expect(
        isValid(GeometrySchema, {
          type: 'rectangle',
          origin: { x: NaN, y: 0 },
          width: 100,
          height: 50,
          rotation: 0,
        }),
      ).toBe(false); // NaN coordinate
      expect(isValid(GeometrySchema, { type: 'circle', center: { x: 0, y: 0 } })).toBe(false); // Missing radius
      expect(isValid(GeometrySchema, { type: 'polyline', points: [{ x: 0, y: 0 }] })).toBe(false); // < 2 points
    });
  });

  describe('BaseAnnotationSchema', () => {
    const validBase = {
      id: 'ann-1',
      geometry: { type: 'rectangle', origin: { x: 0, y: 0 }, width: 100, height: 50, rotation: 0 },
      toolType: 'rectangle',
      createdAt: '2024-01-01T00:00:00.000Z',
      updatedAt: '2024-01-01T00:00:00.000Z',
    };

    it('accepts valid base annotations', () => {
      expect(isValid(BaseAnnotationSchema, validBase)).toBe(true);
    });

    it('rejects missing or empty required fields', () => {
      expect(isValid(BaseAnnotationSchema, { ...validBase, id: '' })).toBe(false);
    });

    it('rejects invalid tool types', () => {
      expect(isValid(BaseAnnotationSchema, { ...validBase, toolType: 'unknown-tool' })).toBe(false);
    });
  });

  describe('OsdAnnotationSchema', () => {
    const validOsd = {
      id: 'ann-1',
      imageId: 'img-1',
      contextId: 'ctx-1',
      geometry: { type: 'rectangle', origin: { x: 0, y: 0 }, width: 100, height: 50, rotation: 0 },
      toolType: 'rectangle',
      createdAt: '2024-01-01T00:00:00.000Z',
      updatedAt: '2024-01-01T00:00:00.000Z',
      rawAnnotationData: {
        format: 'fabric',
        fabricVersion: '7.0.0',
        data: { type: 'rect', width: 100, height: 50, left: 0, top: 0 },
      },
    };

    it('accepts a valid OSD annotation', () => {
      expect(isValid(OsdAnnotationSchema, validOsd)).toBe(true);
    });

    it('rejects missing imageId', () => {
      expect(isValid(OsdAnnotationSchema, { ...validOsd, imageId: undefined })).toBe(false);
    });
  });

  describe('RawAnnotationDataSchema', () => {
    const validRaw = {
      format: 'fabric',
      fabricVersion: '7.0.0',
      data: {
        type: 'rect',
        width: 100,
        height: 50,
        left: 0,
        top: 0,
        fill: 'red',
      },
    };

    it('accepts valid fabric data', () => {
      expect(isValid(FabricRawAnnotationDataSchema, validRaw)).toBe(true);
    });

    it('rejects unsupported formats or unknown types', () => {
      expect(isValid(FabricRawAnnotationDataSchema, { ...validRaw, format: 'unknown' })).toBe(
        false,
      );
      expect(
        isValid(FabricRawAnnotationDataSchema, { ...validRaw, data: { type: 'unknown' } }),
      ).toBe(false);
    });

    it('rejects out of bounds or invalid numeric props', () => {
      expect(
        isValid(FabricRawAnnotationDataSchema, {
          ...validRaw,
          data: { ...validRaw.data, left: Infinity }, // Rejects Infinity
        }),
      ).toBe(false);

      expect(
        isValid(FabricRawAnnotationDataSchema, {
          ...validRaw,
          data: { ...validRaw.data, width: -10 }, // Rect width must be >= 0
        }),
      ).toBe(false);
    });
  });
});
