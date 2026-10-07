import { describe, it, expect } from 'vitest';
import type { FabricObject } from 'fabric';
import { createAnnotationId } from '@osdlabel/annotation';
import { createImageId } from '@osdlabel/viewer-api';
import { createAnnotationContextId } from '@osdlabel/annotation-context';
import { BoundedDenseMaskBuffer, stampCircle } from '@osdlabel/mask';
import { MaskObjectCache } from '../../src/mask-object-cache.js';
import { createMaskAnnotation, maskAnnotationFields } from '../../src/create-mask-annotation.js';

const imageId = createImageId('img');
const contextId = createAnnotationContextId('ctx');
function mask(id: string, radius = 4) {
  const buffer = new BoundedDenseMaskBuffer({ imageWidth: 100, imageHeight: 100 });
  stampCircle(buffer, 50.5, 50.5, radius, 1);
  return createMaskAnnotation(buffer.snapshot(), {
    id: createAnnotationId(id),
    imageId,
    contextId,
  });
}
const obj = (name: string) => ({ name }) as unknown as FabricObject;

describe('MaskObjectCache', () => {
  it('returns the object for the same payload in the same tint', () => {
    const cache = new MaskObjectCache();
    const m1 = mask('m1');
    const a = obj('a');
    cache.set(m1, undefined, a);
    expect(cache.get(m1, undefined)).toBe(a);
  });

  it('misses when the pixels changed, which every stroke commit does by replacing the payload', () => {
    const cache = new MaskObjectCache();
    const m1 = mask('m1');
    cache.set(m1, undefined, obj('a'));
    const buffer = new BoundedDenseMaskBuffer({ imageWidth: 100, imageHeight: 100 });
    stampCircle(buffer, 50.5, 50.5, 8, 1);
    const refined = { ...m1, ...maskAnnotationFields(buffer.snapshot()) };
    expect(cache.get(refined, undefined)).toBeUndefined();
    // Same pixels, re-wrapped: still a miss, since identity is the key. That
    // costs one decode on a reload, never a stale raster.
    expect(
      cache.get({ ...m1, rawAnnotationData: { ...m1.rawAnnotationData } }, undefined),
    ).toBeUndefined();
  });

  it('misses when the tint changed, so a recoloured selection is never served the old raster', () => {
    const cache = new MaskObjectCache();
    const m1 = mask('m1');
    cache.set(m1, undefined, obj('a'));
    expect(cache.get(m1, '#f00')).toBeUndefined();
    cache.set(m1, '#f00', obj('b'));
    expect(cache.get(m1, '#f00')).toMatchObject({ name: 'b' });
    expect(cache.get(m1, undefined)).toBeUndefined();
  });

  it('retain drops masks no longer on the image, and clear drops everything', () => {
    const cache = new MaskObjectCache();
    cache.set(mask('m1'), undefined, obj('a'));
    cache.set(mask('m2'), undefined, obj('b'));
    cache.retain(new Set(['m2']));
    expect(cache.size).toBe(1);
    expect(cache.get(mask('m2'), undefined)).toBeUndefined(); // a fresh payload object: miss by design
    cache.clear();
    expect(cache.size).toBe(0);
  });
});
