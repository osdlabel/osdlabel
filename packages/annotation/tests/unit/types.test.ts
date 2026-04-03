import { describe, it, expect } from 'vitest';
import { createAnnotationId, createImageId } from '../../src/util.js';
import type { AnnotationId, ImageId, Geometry } from '../../src';

describe('Branded ID types', () => {
  it('createAnnotationId produces a branded value', () => {
    const id = createAnnotationId('ann-1');
    expect(id).toBe('ann-1');
    // The value is usable as a string
    const asString: string = id;
    expect(asString).toBe('ann-1');
  });

  it('createImageId produces a branded value', () => {
    const id = createImageId('img-1');
    expect(id).toBe('img-1');
    const asString: string = id;
    expect(asString).toBe('img-1');
  });

  it('branded types are not assignable from raw strings', () => {
    // @ts-expect-error - raw string cannot be assigned to AnnotationId
    const _annId: AnnotationId = 'raw-string';

    // @ts-expect-error - raw string cannot be assigned to ImageId
    const _imgId: ImageId = 'raw-string';

    // Suppress unused variable warnings
    void _annId;
    void _imgId;
  });

  it('branded types are not interchangeable', () => {
    const annId = createAnnotationId('id-1');
    const imgId = createImageId('id-1');

    // @ts-expect-error - AnnotationId is not assignable to ImageId
    const _asImage: ImageId = annId;

    // @ts-expect-error - ImageId is not assignable to AnnotationId
    const _asAnnotation: AnnotationId = imgId;

    void _asImage;
    void _asAnnotation;
  });
});

describe('Helper functions', () => {
  it('createAnnotationId returns a value that satisfies AnnotationId', () => {
    const id = createAnnotationId('test-id');
    // Can be used where AnnotationId is expected
    const acceptsAnnotationId = (aid: AnnotationId) => aid;
    expect(acceptsAnnotationId(id)).toBe('test-id');
  });

  it('createImageId returns a value that satisfies ImageId', () => {
    const id = createImageId('test-id');
    const acceptsImageId = (iid: ImageId) => iid;
    expect(acceptsImageId(id)).toBe('test-id');
  });
});
