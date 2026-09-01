import { describe, it, expect } from 'vitest';
import { createAnnotationId } from '@osdlabel/annotation';
import { createAnnotationContextId } from '@osdlabel/annotation-context';
import { createImageId } from '@osdlabel/viewer-api';
import { BoundedDenseMaskBuffer } from '@osdlabel/mask';
import { canAddAnnotation, computeConstraintStatus } from '../../src/constraints.js';
import { createMaskAnnotation } from '../../src/create-mask-annotation.js';
import {
  createInitialAnnotationState,
  createInitialContextState,
} from '../../src/initial-state.js';
import type { OsdAnnotation } from '../../src/types.js';

/**
 * The brush edits in place, so its `enabled` is not "may add" the way every
 * vector tool's is: at its limit it stays usable while a mask it can refine is
 * selected, and `canAddAnnotation` is what says whether a new mask may start.
 * Reading `enabled` for that locked the brush out of refining the moment the
 * limit was reached (#154).
 */

const imageId = createImageId('img-1');
const otherImage = createImageId('img-2');
const contextId = createAnnotationContextId('ctx-1');
const otherContext = createAnnotationContextId('ctx-2');

function mask(id: string, image = imageId, context = contextId): OsdAnnotation {
  const buffer = new BoundedDenseMaskBuffer({ imageWidth: 100, imageHeight: 100 });
  buffer.set(5, 5, 1);
  return createMaskAnnotation(buffer.snapshot(), {
    id: createAnnotationId(id),
    imageId: image,
    contextId: context,
  });
}

const rectangle: OsdAnnotation = {
  id: createAnnotationId('r1'),
  imageId,
  contextId,
  toolType: 'rectangle',
  geometry: { type: 'rectangle', origin: { x: 0, y: 0 }, width: 5, height: 5, rotation: 0 },
  rawAnnotationData: { format: 'fabric', fabricVersion: 'test', data: { type: 'Rect' } },
  createdAt: 'now',
  updatedAt: 'now',
};

function states(annotations: readonly OsdAnnotation[]) {
  const annotationState = createInitialAnnotationState();
  for (const a of annotations) {
    (annotationState.byImage[a.imageId] ??= {})[a.id] = a;
  }
  const contextState = {
    ...createInitialContextState(),
    contexts: [
      {
        id: contextId,
        label: 'One',
        tools: [
          { type: 'segmentationBrush' as const, maxCount: 1 },
          { type: 'rectangle' as const, maxCount: 1 },
        ],
      },
      { id: otherContext, label: 'Other', tools: [{ type: 'segmentationBrush' as const }] },
    ],
    activeContextId: contextId,
  };
  return { annotationState, contextState };
}

describe('the brush at its limit', () => {
  const m1 = mask('m1');
  const { annotationState, contextState } = states([m1, rectangle, mask('m2', otherImage)]);
  const status = (selected: string | null) =>
    computeConstraintStatus(
      contextState,
      annotationState,
      imageId,
      selected === null ? null : createAnnotationId(selected),
    );

  it('is disabled with nothing refinable selected, as any tool at its limit is', () => {
    expect(status(null).segmentationBrush.enabled).toBe(false);
    expect(status('r1').segmentationBrush.enabled).toBe(false);
    // A mask on another image, or one the context does not own, is not refinable here.
    expect(status('m2').segmentationBrush.enabled).toBe(false);
  });

  it('stays enabled while a mask it can refine is selected', () => {
    // The count is over the limit, not merely at it: the default global scope
    // counts the other image's mask too.
    expect(status('m1').segmentationBrush).toEqual({ enabled: true, currentCount: 2, maxCount: 1 });
  });

  it('may still not start another mask', () => {
    expect(canAddAnnotation(status('m1'), 'segmentationBrush')).toBe(false);
    expect(canAddAnnotation(status(null), 'segmentationBrush')).toBe(false);
  });

  it('does not change what the selection means to a vector tool', () => {
    expect(status('r1').rectangle.enabled).toBe(false);
    expect(canAddAnnotation(status('r1'), 'rectangle')).toBe(false);
  });

  it('is not refinable from another context, even when that context owns the mask', () => {
    const inOther = states([mask('m3', imageId, otherContext), m1]);
    const s = computeConstraintStatus(
      inOther.contextState,
      inOther.annotationState,
      imageId,
      createAnnotationId('m3'),
    );
    expect(s.segmentationBrush.enabled).toBe(false);
  });
});

describe('canAddAnnotation', () => {
  it('follows enabled and the limit for tools under it', () => {
    const { annotationState, contextState } = states([]);
    const s = computeConstraintStatus(contextState, annotationState, imageId);
    expect(canAddAnnotation(s, 'segmentationBrush')).toBe(true);
    expect(canAddAnnotation(s, 'rectangle')).toBe(true);
    // A tool the context does not offer.
    expect(canAddAnnotation(s, 'circle')).toBe(false);
  });
});
