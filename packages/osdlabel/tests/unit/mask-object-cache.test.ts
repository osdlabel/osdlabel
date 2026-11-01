import { describe, it, expect, vi } from 'vitest';
import type { FabricObject } from 'fabric';
import { createAnnotationId } from '@osdlabel/annotation';
import { createImageId } from '@osdlabel/viewer-api';
import { createAnnotationContextId } from '@osdlabel/annotation-context';
import { BoundedDenseMaskBuffer, stampCircle } from '@osdlabel/mask';
import { MaskObjectCache } from '../../src/mask-object-cache.js';
import type { MaskObjectSeed } from '../../src/brush-config.js';
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

  // A transform of a multi-selection holding the mask moved its object while
  // its payload, the cache's key, stayed the same: the displaced raster was
  // handed back on every rebuild until the pixels changed.
  it.each([
    ['moved', { left: 47 }],
    ['scaled', { scaleX: 2, scaleY: 2 }],
    ['rotated', { angle: 30 }],
    ['skewed', { skewX: 10 }],
    ['flipped', { flipX: true }],
  ] as const)('misses, and forgets the entry, when its object was %s', (_name, change) => {
    const cache = new MaskObjectCache();
    const m1 = mask('m1');
    const placed = {
      left: 46,
      top: 46,
      scaleX: 1,
      scaleY: 1,
      angle: 0,
      skewX: 0,
      skewY: 0,
      flipX: false,
      flipY: false,
    };
    const a = { ...placed } as unknown as FabricObject;
    cache.set(m1, undefined, a);
    expect(cache.get(m1, undefined)).toBe(a);
    Object.assign(a, change);
    expect(cache.get(m1, undefined)).toBeUndefined();
    expect(cache.size).toBe(0);
    // Put back exactly, it would not come back: the entry is gone.
    Object.assign(a, placed);
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

describe('MaskObjectCache.seed', () => {
  /** A seed for `annotation` whose object is `width` x `height` canvas pixels, as the brush's preview makes. */
  const seedOf = (
    annotation: ReturnType<typeof mask>,
    width: number,
    height: number,
    fill: string | undefined = undefined,
  ) => {
    const object = { width, height } as unknown as FabricObject;
    return {
      object,
      build: vi.fn(() => object),
      seed(): MaskObjectSeed {
        return {
          annotationId: annotation.id,
          rawAnnotationData: annotation.rawAnnotationData as MaskObjectSeed['rawAnnotationData'],
          fill,
          width,
          height,
          object: this.build,
        };
      },
    };
  };

  it("serves a seed to the store's copy of the payload, matched by content once", () => {
    const cache = new MaskObjectCache();
    const a = mask('m1');
    const seeded = seedOf(a, 10, 10);
    cache.seed(seeded.seed());
    // What a store hands back: an equal payload in a different object.
    const copy = { ...a, rawAnnotationData: structuredClone(a.rawAnnotationData) };
    expect(cache.get(copy, undefined)).toBe(seeded.object);
    expect(cache.get(copy, undefined)).toBe(seeded.object);
    // After that first match it is keyed by identity, like any other entry.
    const another = { ...a, rawAnnotationData: structuredClone(a.rawAnnotationData) };
    expect(cache.get(another, undefined)).toBeUndefined();
  });

  it('does not match a different payload or tint by content', () => {
    const cache = new MaskObjectCache();
    const a = mask('m1');
    cache.seed(seedOf(a, 10, 10).seed());
    expect(cache.get({ ...a, ...mask('m1', 6) }, undefined)).toBeUndefined();
    cache.seed(seedOf(a, 10, 10).seed());
    expect(cache.get(a, 'red')).toBeUndefined();
  });

  it('skips, without building it, an object the cell would draw from a display mip', () => {
    const cache = new MaskObjectCache();
    const a = mask('m1');
    for (const [width, height, budget] of [
      [5_000, 4_000, undefined],
      [40_000, 10, Infinity],
      [100, 100, 9_999],
    ] as const) {
      const seeded = seedOf(a, width, height);
      cache.seed(seeded.seed(), budget);
      expect(cache.size, `${width}x${height}`).toBe(0);
      // Never cropped (#243 minor 10).
      expect(seeded.build).not.toHaveBeenCalled();
    }
    cache.seed(seedOf(a, 5_000, 4_000).seed(), Infinity);
    expect(cache.size).toBe(1);
  });

  it('keeps nothing when the preview cannot be cropped', () => {
    const cache = new MaskObjectCache();
    const a = mask('m1');
    cache.seed({ ...seedOf(a, 10, 10).seed(), object: () => null });
    expect(cache.size).toBe(0);
  });
});
