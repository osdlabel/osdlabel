import { describe, it, expect } from 'vitest';
import { version as FABRIC_VERSION } from 'fabric';
import {
  serialize,
  deserialize,
  validateBaseAnnotation,
  validateRawAnnotationData,
  createAnnotationValidator,
  getAllAnnotationsFlat,
  SerializationError,
} from '../../src/serialization.js';
import type { ExtensionValidator } from '../../src/serialization.js';
import { createAnnotationId, createImageId } from '../../src/types.js';
import type {
  BaseAnnotation,
  Annotation,
  AnnotationState,
  ImageSource,
  AnnotationId,
  ImageId,
  RawAnnotationData,
} from '../../src/types.js';
import { MAX_COORDINATE, MAX_STRING_LENGTH, MAX_POINTS_COUNT } from '../../src/data-sanitizer.js';

/** Extension fields for full annotation tests */
interface TestExtFields {
  readonly contextId: string;
  readonly rawAnnotationData: RawAnnotationData;
}

type TestAnnotation = Annotation<TestExtFields>;

const validateTestExtFields: ExtensionValidator<TestExtFields> = (
  value: unknown,
): value is TestExtFields => {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  if (typeof v.contextId !== 'string' || v.contextId === '') return false;
  if (!validateRawAnnotationData(v.rawAnnotationData)) return false;
  return true;
};

const validateTestAnnotation = createAnnotationValidator(validateTestExtFields);

describe('Serialization', () => {
  const imageId = createImageId('img1');
  const contextId = 'ctx1';
  const annId1 = createAnnotationId('ann1');
  const annId2 = createAnnotationId('ann2');

  // Use capitalized 'Rect' — matches Fabric v7's toObject() output.
  // width/height are required by the stricter validation for Rect type.
  const baseRawAnnotationData: RawAnnotationData = {
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

  const annotation1: TestAnnotation = {
    id: annId1,
    imageId,
    contextId,
    geometry: { type: 'rectangle', origin: { x: 10, y: 20 }, width: 100, height: 50, rotation: 0 },
    toolType: 'rectangle',
    rawAnnotationData: baseRawAnnotationData,
    createdAt: '2024-01-01T00:00:00.000Z',
    updatedAt: '2024-01-01T00:00:00.000Z',
  };

  const annotation2: TestAnnotation = {
    id: annId2,
    imageId,
    contextId,
    geometry: { type: 'circle', center: { x: 200, y: 300 }, radius: 75 },
    toolType: 'circle',
    rawAnnotationData: baseRawAnnotationData,
    createdAt: '2024-01-01T00:00:00.000Z',
    updatedAt: '2024-01-01T00:00:00.000Z',
  };

  const imageSources: ImageSource[] = [
    { id: imageId, tileSource: 'https://example.com/image.dzi', label: 'Test Image' },
  ];

  function createTestState(annotations: TestAnnotation[]): AnnotationState<TestExtFields> {
    const byImage: Record<ImageId, Record<AnnotationId, TestAnnotation>> = {};
    for (const ann of annotations) {
      if (!byImage[ann.imageId]) {
        byImage[ann.imageId] = {};
      }
      byImage[ann.imageId][ann.id] = ann;
    }
    return { byImage, changeCounter: 0 };
  }

  describe('serialize', () => {
    it('should produce a valid AnnotationDocument', () => {
      const state = createTestState([annotation1, annotation2]);
      const doc = serialize(state, imageSources);

      expect(doc.version).toBe('1.0.0');
      expect(doc.exportedAt).toBeDefined();
      expect(doc.images).toHaveLength(1);
      expect(doc.images[0].imageId).toBe(imageId);
      expect(doc.images[0].sourceUrl).toBe('https://example.com/image.dzi');
      expect(doc.images[0].annotations).toHaveLength(2);
    });

    it('should handle empty state', () => {
      const state: AnnotationState<TestExtFields> = { byImage: {}, changeCounter: 0 };
      const doc = serialize(state, imageSources);

      expect(doc.version).toBe('1.0.0');
      expect(doc.images).toHaveLength(1);
      expect(doc.images[0].annotations).toHaveLength(0);
    });

    it('should handle multiple images', () => {
      const imageId2 = createImageId('img2');
      const ann3: TestAnnotation = {
        ...annotation1,
        id: createAnnotationId('ann3'),
        imageId: imageId2,
      };

      const state = createTestState([annotation1, ann3]);
      const sources: ImageSource[] = [
        ...imageSources,
        { id: imageId2, tileSource: 'https://example.com/image2.dzi' },
      ];
      const doc = serialize(state, sources);

      expect(doc.images).toHaveLength(2);
    });
  });

  describe('deserialize', () => {
    it('should round-trip serialize → deserialize preserving all data', () => {
      const state = createTestState([annotation1, annotation2]);
      const doc = serialize(state, imageSources);
      const json = JSON.stringify(doc);
      const parsed: unknown = JSON.parse(json);
      const { byImage: result } = deserialize(parsed, validateTestExtFields);

      expect(result[imageId]).toBeDefined();
      const restoredAnn1 = result[imageId][annId1];
      expect(restoredAnn1.id).toBe(annId1);
      expect(restoredAnn1.imageId).toBe(imageId);
      expect(restoredAnn1.contextId).toBe(contextId);
      expect(restoredAnn1.geometry).toEqual(annotation1.geometry);
      expect(restoredAnn1.rawAnnotationData).toEqual(baseRawAnnotationData);

      const restoredAnn2 = result[imageId][annId2];
      expect(restoredAnn2.geometry).toEqual(annotation2.geometry);
    });

    it('should silently ignore viewTransform in old documents', () => {
      const doc = {
        version: '1.0.0',
        exportedAt: '2024-01-01T00:00:00.000Z',
        images: [
          {
            imageId: 'img1',
            sourceUrl: 'https://example.com',
            annotations: [],
            viewTransform: { rotation: 90, flippedH: true, flippedV: false },
          },
        ],
      };

      const { byImage } = deserialize(doc);
      expect(byImage[createImageId('img1')]).toEqual({});
    });

    it('should reject non-object input', () => {
      expect(() => deserialize('not an object')).toThrow(SerializationError);
      expect(() => deserialize(null)).toThrow(SerializationError);
      expect(() => deserialize(42)).toThrow(SerializationError);
    });

    it('should reject documents with unknown version', () => {
      expect(() =>
        deserialize({
          version: '2.0.0',
          exportedAt: '2024-01-01T00:00:00.000Z',
          images: [],
        }),
      ).toThrow(/Unsupported document version/);
    });

    it('should reject documents with missing version', () => {
      expect(() =>
        deserialize({
          exportedAt: '2024-01-01T00:00:00.000Z',
          images: [],
        }),
      ).toThrow(/Unsupported document version/);
    });

    it('should reject documents with missing images array', () => {
      expect(() =>
        deserialize({
          version: '1.0.0',
          exportedAt: '2024-01-01T00:00:00.000Z',
        }),
      ).toThrow(/Missing or invalid images array/);
    });

    it('should reject documents with missing exportedAt', () => {
      expect(() =>
        deserialize({
          version: '1.0.0',
          images: [],
        }),
      ).toThrow(/Missing or invalid exportedAt/);
    });

    it('should reject images with invalid annotations', () => {
      expect(() =>
        deserialize({
          version: '1.0.0',
          exportedAt: '2024-01-01T00:00:00.000Z',
          images: [
            {
              imageId: 'img1',
              sourceUrl: 'https://example.com',
              annotations: [{ id: 'bad' }], // incomplete annotation
            },
          ],
        }),
      ).toThrow(/Invalid annotation/);
    });
  });

  describe('validateBaseAnnotation', () => {
    const baseAnn: BaseAnnotation = {
      id: annId1,
      imageId,
      geometry: {
        type: 'rectangle',
        origin: { x: 10, y: 20 },
        width: 100,
        height: 50,
        rotation: 0,
      },
      toolType: 'rectangle',
      createdAt: '2024-01-01T00:00:00.000Z',
      updatedAt: '2024-01-01T00:00:00.000Z',
    };

    it('should accept a valid base annotation', () => {
      expect(validateBaseAnnotation(baseAnn)).toBe(true);
    });

    it('should accept with extra extension fields (they are ignored)', () => {
      expect(validateBaseAnnotation(annotation1)).toBe(true);
    });

    it('should reject non-object values', () => {
      expect(validateBaseAnnotation(null)).toBe(false);
      expect(validateBaseAnnotation(undefined)).toBe(false);
      expect(validateBaseAnnotation('string')).toBe(false);
      expect(validateBaseAnnotation(42)).toBe(false);
    });

    it('should reject annotations missing required fields', () => {
      expect(validateBaseAnnotation({ id: 'test' })).toBe(false);
      expect(validateBaseAnnotation({ ...baseAnn, id: '' })).toBe(false);
      expect(validateBaseAnnotation({ ...baseAnn, imageId: '' })).toBe(false);
    });

    it('should reject invalid geometry type', () => {
      const badAnn = { ...baseAnn, geometry: { type: 'polygon' } };
      expect(validateBaseAnnotation(badAnn)).toBe(false);
    });

    it('should reject NaN coordinates', () => {
      const badAnn = {
        ...baseAnn,
        geometry: {
          type: 'rectangle',
          origin: { x: NaN, y: 20 },
          width: 100,
          height: 50,
          rotation: 0,
        },
      };
      expect(validateBaseAnnotation(badAnn)).toBe(false);
    });

    it('should reject Infinity coordinates', () => {
      const badAnn = {
        ...baseAnn,
        geometry: { type: 'circle', center: { x: Infinity, y: 0 }, radius: 10 },
      };
      expect(validateBaseAnnotation(badAnn)).toBe(false);
    });

    it('should reject path with less than 2 points', () => {
      const badAnn = {
        ...baseAnn,
        geometry: { type: 'path', points: [{ x: 0, y: 0 }], closed: false },
      };
      expect(validateBaseAnnotation(badAnn)).toBe(false);
    });

    it('should accept a valid line annotation', () => {
      const lineAnn = {
        ...baseAnn,
        geometry: { type: 'line', start: { x: 0, y: 0 }, end: { x: 10, y: 10 } },
      };
      expect(validateBaseAnnotation(lineAnn)).toBe(true);
    });

    it('should accept a valid point annotation', () => {
      const pointAnn = {
        ...baseAnn,
        geometry: { type: 'point', position: { x: 5, y: 5 } },
      };
      expect(validateBaseAnnotation(pointAnn)).toBe(true);
    });

    it('should accept a valid path annotation', () => {
      const pathAnn = {
        ...baseAnn,
        geometry: {
          type: 'path',
          points: [
            { x: 0, y: 0 },
            { x: 10, y: 10 },
            { x: 20, y: 0 },
          ],
          closed: true,
        },
      };
      expect(validateBaseAnnotation(pathAnn)).toBe(true);
    });
  });

  describe('createAnnotationValidator', () => {
    it('should compose base + extension validation', () => {
      expect(validateTestAnnotation(annotation1)).toBe(true);
    });

    it('should reject when base fields are invalid', () => {
      const bad = { ...annotation1, id: '' };
      expect(validateTestAnnotation(bad)).toBe(false);
    });

    it('should reject when extension fields are invalid', () => {
      const { contextId: _, ...noCtx } = annotation1;
      expect(validateTestAnnotation(noCtx)).toBe(false);
    });

    it('should reject when rawAnnotationData is invalid', () => {
      const bad = { ...annotation1, rawAnnotationData: { format: 'unknown', data: {} } };
      expect(validateTestAnnotation(bad)).toBe(false);
    });
  });

  describe('validateRawAnnotationData', () => {
    it('should accept valid rawAnnotationData', () => {
      expect(validateRawAnnotationData(baseRawAnnotationData)).toBe(true);
    });

    it('should reject non-object', () => {
      expect(validateRawAnnotationData(null)).toBe(false);
      expect(validateRawAnnotationData('string')).toBe(false);
    });

    it('should reject unsupported fabric type', () => {
      expect(
        validateRawAnnotationData({
          format: 'fabric',
          fabricVersion: FABRIC_VERSION,
          data: { type: 'malicious-type' },
        }),
      ).toBe(false);
    });

    it('should reject missing fabricVersion', () => {
      expect(
        validateRawAnnotationData({
          format: 'fabric',
          data: { type: 'Rect', width: 100, height: 50 },
        }),
      ).toBe(false);
    });

    it('should reject invalid numeric properties', () => {
      expect(
        validateRawAnnotationData({
          format: 'fabric',
          fabricVersion: FABRIC_VERSION,
          data: { type: 'Rect', width: 100, height: 50, left: 'invalid' },
        }),
      ).toBe(false);
    });

    it('should accept lowercase type (backward compat)', () => {
      expect(
        validateRawAnnotationData({
          format: 'fabric',
          fabricVersion: FABRIC_VERSION,
          data: { type: 'rect', width: 100, height: 50 },
        }),
      ).toBe(true);
    });

    it('should reject Rect missing width', () => {
      expect(
        validateRawAnnotationData({
          format: 'fabric',
          fabricVersion: FABRIC_VERSION,
          data: { type: 'Rect', height: 50 },
        }),
      ).toBe(false);
    });

    it('should reject Rect missing height', () => {
      expect(
        validateRawAnnotationData({
          format: 'fabric',
          fabricVersion: FABRIC_VERSION,
          data: { type: 'Rect', width: 100 },
        }),
      ).toBe(false);
    });

    it('should reject negative radius in Circle', () => {
      expect(
        validateRawAnnotationData({
          format: 'fabric',
          fabricVersion: FABRIC_VERSION,
          data: { type: 'Circle', radius: -5 },
        }),
      ).toBe(false);
    });

    it('should reject coordinate exceeding MAX_COORDINATE', () => {
      expect(
        validateRawAnnotationData({
          format: 'fabric',
          fabricVersion: FABRIC_VERSION,
          data: { type: 'Rect', width: 100, height: 50, left: MAX_COORDINATE + 1 },
        }),
      ).toBe(false);
    });

    it('should reject oversized string property', () => {
      expect(
        validateRawAnnotationData({
          format: 'fabric',
          fabricVersion: FABRIC_VERSION,
          data: { type: 'Rect', width: 100, height: 50, fill: 'x'.repeat(MAX_STRING_LENGTH + 1) },
        }),
      ).toBe(false);
    });

    it('should reject Polyline with oversized points array', () => {
      expect(
        validateRawAnnotationData({
          format: 'fabric',
          fabricVersion: FABRIC_VERSION,
          data: {
            type: 'Polyline',
            points: Array.from({ length: MAX_POINTS_COUNT + 1 }, (_, i) => ({ x: i, y: i })),
          },
        }),
      ).toBe(false);
    });
  });

  describe('getAllAnnotationsFlat', () => {
    it('should flatten all annotations from store', () => {
      const state = createTestState([annotation1, annotation2]);
      const flat = getAllAnnotationsFlat(state);

      expect(flat).toHaveLength(2);
      expect(flat.map((a) => a.id).sort()).toEqual([annId1, annId2].sort());
    });

    it('should return empty array for empty state', () => {
      const state: AnnotationState<TestExtFields> = { byImage: {}, changeCounter: 0 };
      expect(getAllAnnotationsFlat(state)).toEqual([]);
    });
  });
});
