import { describe, it, expect } from 'vitest';
import { version as FABRIC_VERSION } from 'fabric';
import {
  serialize,
  deserialize,
  getAllAnnotationsFlat,
  SerializationError,
} from '../../src/serialization.js';
import { createAnnotationId, createImageId } from '../../src';
import type {
  Annotation,
  AnnotationState,
  AnnotationId,
  ImageId,
  RawAnnotationData,
} from '../../src';

/** Extension fields for full annotation tests */
interface TestExtFields {
  readonly contextId: string;
  readonly rawAnnotationData: RawAnnotationData;
}

type TestAnnotation = Annotation<TestExtFields>;

describe('Serialization', () => {
  const imageId = createImageId('img1');
  const contextId = 'ctx1';
  const annId1 = createAnnotationId('ann1');
  const annId2 = createAnnotationId('ann2');

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
    it('should produce a flat array of annotations', () => {
      const state = createTestState([annotation1, annotation2]);
      const doc = serialize(state);

      expect(Array.isArray(doc)).toBe(true);
      expect(doc).toHaveLength(2);
      expect(doc).toContainEqual(annotation1);
      expect(doc).toContainEqual(annotation2);
    });

    it('should handle empty state', () => {
      const state: AnnotationState<TestExtFields> = { byImage: {}, changeCounter: 0 };
      const doc = serialize(state);

      expect(Array.isArray(doc)).toBe(true);
      expect(doc).toHaveLength(0);
    });

    it('should flatten multiple images', () => {
      const imageId2 = createImageId('img2');
      const ann3: TestAnnotation = {
        ...annotation1,
        id: createAnnotationId('ann3'),
        imageId: imageId2,
      };

      const state = createTestState([annotation1, ann3]);
      const doc = serialize(state);

      expect(doc).toHaveLength(2);
      expect(doc).toContainEqual(annotation1);
      expect(doc).toContainEqual(ann3);
    });
  });

  describe('deserialize', () => {
    it('should round-trip serialize → deserialize preserving all data', () => {
      const state = createTestState([annotation1, annotation2]);
      const doc = serialize(state);
      const json = JSON.stringify(doc);
      const parsed: unknown = JSON.parse(json);
      const { byImage: result } = deserialize<TestExtFields>(parsed);

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

    it('should reject non-array input', () => {
      expect(() => deserialize('not an array')).toThrow(SerializationError);
      expect(() => deserialize(null)).toThrow(SerializationError);
      expect(() => deserialize(42)).toThrow(SerializationError);
      expect(() => deserialize({})).toThrow(SerializationError);
    });

    it('should reject invalid annotation objects inside array', () => {
      expect(() => deserialize([null])).toThrow(SerializationError);
      expect(() => deserialize(['string'])).toThrow(SerializationError);
    });

    it('should reject annotations missing id or imageId', () => {
      expect(() => deserialize([{ imageId: 'img1' }])).toThrow(SerializationError);
      expect(() => deserialize([{ id: 'ann1' }])).toThrow(SerializationError);
      expect(() => deserialize([{ id: '', imageId: 'img1' }])).toThrow(SerializationError);
      expect(() => deserialize([{ id: 'ann1', imageId: '' }])).toThrow(SerializationError);
    });
  });

  describe('getAllAnnotationsFlat', () => {
    it('should return a flat array of all annotations', () => {
      const state = createTestState([annotation1, annotation2]);
      const flat = getAllAnnotationsFlat(state);
      expect(flat).toHaveLength(2);
      expect(flat).toContainEqual(annotation1);
      expect(flat).toContainEqual(annotation2);
    });
  });
});
