import { describe, it, expect } from 'vitest';
import { createImageId, type AnnotationState } from '@osdlabel/viewer-api';
import { createAnnotationContextId } from '@osdlabel/annotation-context';
import {
  BoundedDenseMaskBuffer,
  cocoRleCodec,
  createMaskCodecRegistry,
  decodeCanonical,
  stampCircle,
} from '@osdlabel/mask';
import { MASK_RAW_FORMAT, createAnnotationId } from '@osdlabel/annotation';
import { Rect } from 'fabric';
import { createMaskAnnotation } from '../../src/create-mask-annotation.js';
import { processObjectModified } from '../../src/tool-factory.js';
import { createAnnotationFromGeometry } from '../../src/create-annotation.js';
import { serialize, deserialize } from '../../src/serialization-configured.js';
import type { OsdAnnotation, OsdFields } from '../../src/types.js';

const imageId = createImageId('img-1');
const contextId = createAnnotationContextId('ctx-1');

function paintedSnapshot() {
  const buffer = new BoundedDenseMaskBuffer({ imageWidth: 400, imageHeight: 300 });
  stampCircle(buffer, 120.5, 90.5, 10, 1);
  stampCircle(buffer, 124.5, 92.5, 3, 0); // a hole, so the runs are non-trivial
  return buffer.snapshot();
}

function stateWith(...annotations: OsdAnnotation[]): AnnotationState<OsdFields> {
  const byImage: AnnotationState<OsdFields>['byImage'] = {};
  for (const annotation of annotations) {
    byImage[annotation.imageId] = { ...byImage[annotation.imageId], [annotation.id]: annotation };
  }
  return { byImage, changeCounter: 1 };
}

describe('createMaskAnnotation', () => {
  it('summarises the mask in geometry and carries pixels in the raw envelope', () => {
    const snapshot = paintedSnapshot();
    const annotation = createMaskAnnotation(snapshot, { imageId, contextId });

    expect(annotation.geometry.type).toBe('mask');
    if (annotation.geometry.type !== 'mask') return;
    expect(annotation.geometry.origin).toEqual({ x: snapshot.x, y: snapshot.y });
    expect(annotation.geometry.width).toBe(snapshot.width);
    expect(annotation.geometry.height).toBe(snapshot.height);
    // Exact, not an outline approximation.
    expect(annotation.geometry.pixelCount).toBe(snapshot.data.reduce((a, v) => a + v, 0));

    expect(annotation.toolType).toBe('segmentationBrush');
    expect(annotation.rawAnnotationData.format).toBe(MASK_RAW_FORMAT);
    expect(annotation.imageId).toBe(imageId);
    expect(annotation.contextId).toBe(contextId);
  });

  it('records the pixels losslessly', () => {
    const snapshot = paintedSnapshot();
    const annotation = createMaskAnnotation(snapshot, { imageId, contextId });
    if (annotation.rawAnnotationData.format !== MASK_RAW_FORMAT) throw new Error('expected mask');

    expect(decodeCanonical(annotation.rawAnnotationData.data)).toEqual(snapshot);
  });

  it('records the image dimensions that COCO export needs', () => {
    const annotation = createMaskAnnotation(paintedSnapshot(), { imageId, contextId });
    if (annotation.rawAnnotationData.format !== MASK_RAW_FORMAT) throw new Error('expected mask');
    expect(annotation.rawAnnotationData.data.imageWidth).toBe(400);
    expect(annotation.rawAnnotationData.data.imageHeight).toBe(300);
  });
});

describe('createAnnotationFromGeometry', () => {
  it('does not accept mask geometry', () => {
    // Masks are excluded by the parameter type (`VectorGeometry`), so a
    // TypeScript caller gets a compile error naming `createMaskAnnotation`.
    //
    // The `@ts-expect-error` below records that, but does NOT check it: each
    // package's `tsconfig.json` excludes `tests/`, and Vitest transpiles with
    // esbuild, so nothing type-checks this file. Widening the parameter back
    // to `Geometry` would leave the directive unused and the suite green.
    //
    // What this asserts is the JavaScript caller's experience, which has no
    // compile error at all: a named `TypeError` pointing at the mask helpers,
    // rather than `Cannot read properties of undefined (reading 'toObject')`
    // several frames downstream.
    const callWithMask = (): OsdAnnotation =>
      createAnnotationFromGeometry(
        // @ts-expect-error mask geometry carries no pixels; use createMaskAnnotation
        { type: 'mask', origin: { x: 0, y: 0 }, width: 4, height: 4, pixelCount: 2 },
        { imageId, contextId, toolType: 'segmentationBrush' },
      );
    expect(callWithMask).toThrow(TypeError);
    expect(callWithMask).toThrow(/createMaskAnnotation/);
  });

  it('still accepts vector geometry', () => {
    const annotation = createAnnotationFromGeometry(
      { type: 'rectangle', origin: { x: 1, y: 2 }, width: 10, height: 20, rotation: 0 },
      { imageId, contextId, toolType: 'rectangle' },
    );
    expect(annotation.geometry.type).toBe('rectangle');
  });
});

describe('mask serialization', () => {
  it('round-trips through serialize/deserialize in the canonical encoding', () => {
    const snapshot = paintedSnapshot();
    const annotation = createMaskAnnotation(snapshot, { imageId, contextId });

    const doc = serialize(stateWith(annotation));
    const restored = deserialize(JSON.parse(JSON.stringify(doc)));
    const back = restored.byImage[imageId]?.[annotation.id];

    expect(back).toBeDefined();
    expect(back?.geometry).toEqual(annotation.geometry);
    if (back?.rawAnnotationData.format !== MASK_RAW_FORMAT) throw new Error('expected mask');
    expect(decodeCanonical(back.rawAnnotationData.data)).toEqual(snapshot);
  });

  it('exports mask pixels through a codec without touching vector annotations', () => {
    const snapshot = paintedSnapshot();
    const mask = createMaskAnnotation(snapshot, { imageId, contextId });
    const rect = createAnnotationFromGeometry(
      { type: 'rectangle', origin: { x: 5, y: 5 }, width: 20, height: 10, rotation: 0 },
      { imageId, contextId, toolType: 'rectangle' },
    );

    const doc = serialize(stateWith(mask, rect), { maskCodec: cocoRleCodec });

    const exportedMask = doc.find((a) => a.id === mask.id);
    expect(exportedMask?.rawAnnotationData.format).toBe('coco-rle');
    // COCO reports [height, width] of the full image.
    expect(exportedMask?.rawAnnotationData.data.size).toEqual([300, 400]);
    expect(typeof exportedMask?.rawAnnotationData.data.counts).toBe('string');

    // The vector annotation is passed through untouched.
    expect(doc.find((a) => a.id === rect.id)?.rawAnnotationData.format).toBe('fabric');
  });

  it('re-imports a COCO-encoded document back to canonical pixels', () => {
    const snapshot = paintedSnapshot();
    const mask = createMaskAnnotation(snapshot, { imageId, contextId });

    const exported = JSON.parse(
      JSON.stringify(serialize(stateWith(mask), { maskCodec: cocoRleCodec })),
    );
    const restored = deserialize(exported, {
      maskCodecs: createMaskCodecRegistry(cocoRleCodec),
    });

    const back = restored.byImage[imageId]?.[mask.id];
    expect(back).toBeDefined();
    if (back?.rawAnnotationData.format !== MASK_RAW_FORMAT) throw new Error('expected mask');
    expect(decodeCanonical(back.rawAnnotationData.data)).toEqual(snapshot);
  });

  it('rejects an exported document when no codec is supplied to decode it', () => {
    const mask = createMaskAnnotation(paintedSnapshot(), { imageId, contextId });
    const exported = JSON.parse(
      JSON.stringify(serialize(stateWith(mask), { maskCodec: cocoRleCodec })),
    );
    // Validation only accepts envelopes the annotator itself reads.
    expect(() => deserialize(exported)).toThrow(/Validation failed/);
  });
});

describe('processObjectModified with a mask annotation', () => {
  /**
   * The invariant, not the guard that currently implements it.
   *
   * `object:modified` fires for any Fabric object the user touches, and the
   * handler rewrites the annotation from that object. For a mask that would
   * replace the pixel envelope with a serialized Fabric image — permanent,
   * silent data loss, and the quietest failure in this feature.
   *
   * `getGeometryFromFabricObject` has an explicit `type === 'mask'` guard, but
   * it happens to be unfalsifiable today: no branch below it matches `'mask'`
   * either, so removing it changes nothing. Testing the guard would therefore
   * prove nothing. What is worth pinning is that `processObjectModified`
   * returns nothing for a mask however that comes about — which is what breaks
   * if someone later adds a fall-through branch.
   */
  it('never rewrites a mask from its rendered object', () => {
    const mask = createMaskAnnotation(paintedSnapshot(), { imageId, contextId });
    const state = stateWith(mask);

    // The object a mask actually renders as, carrying its annotation id.
    const rendered = new Rect({ left: 0, top: 0, width: 20, height: 20 });
    rendered.id = mask.id;

    expect(processObjectModified(rendered, state, imageId)).toBeNull();
  });

  it('still rewrites a vector annotation from its object', () => {
    const rect = createAnnotationFromGeometry(
      { type: 'rectangle', origin: { x: 0, y: 0 }, width: 10, height: 10, rotation: 0 },
      { id: createAnnotationId('rect-1'), imageId, contextId, toolType: 'rectangle' },
    );
    const moved = new Rect({ left: 40, top: 50, width: 10, height: 10 });
    moved.id = rect.id;

    const result = processObjectModified(moved, stateWith(rect), imageId);
    expect(result?.geometry).toMatchObject({ origin: { x: 40, y: 50 } });
  });
});
