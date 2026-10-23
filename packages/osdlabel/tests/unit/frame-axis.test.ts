import { describe, it, expect } from 'vitest';
import * as v from 'valibot';
import { createAnnotationId } from '@osdlabel/annotation';
import { createAnnotationContextId } from '@osdlabel/annotation-context';
import { createImageId } from '@osdlabel/viewer-api';
import { BaseAnnotationSchema, FabricRawAnnotationDataSchema } from '@osdlabel/validation';
import { applyUIAction } from '../../src/actions.js';
import { computeConstraintStatus } from '../../src/constraints.js';
import {
  createInitialAnnotationState,
  createInitialContextState,
  createInitialUIState,
} from '../../src/initial-state.js';
import { deserialize, serialize } from '../../src/serialization-configured.js';
import type { OsdAnnotation } from '../../src/types.js';

/**
 * PoC (frame-axis): a multi-frame source is ONE ImageId whose annotations carry
 * an optional `frame`. These tests pin what the existing model had to change
 * to support it: a per-cell frame in UIState, a 'per-frame' count scope, and a
 * schema field so that serialization does not drop the frame.
 */

const series = createImageId('ct-series-1');
const ctx = createAnnotationContextId('lesions');

function point(id: string, frame?: number): OsdAnnotation {
  return {
    id: createAnnotationId(id),
    imageId: series,
    contextId: ctx,
    toolType: 'rectangle',
    geometry: { type: 'rectangle', origin: { x: 1, y: 2 }, width: 3, height: 4, rotation: 0 },
    rawAnnotationData: {
      format: 'fabric',
      fabricVersion: '7.4.0',
      data: { type: 'Rect', left: 1, top: 2, width: 3, height: 4 },
    },
    createdAt: 'now',
    updatedAt: 'now',
    ...(frame !== undefined ? { frame: { index: frame, key: `uid-${frame}` } } : {}),
  };
}

describe('SET_CELL_FRAME', () => {
  it('clamps to the axis and is reset by assigning a new image', () => {
    const ui = createInitialUIState();
    applyUIAction(ui, { type: 'ASSIGN_IMAGE_TO_CELL', payload: { cellIndex: 0, imageId: series } });
    applyUIAction(ui, {
      type: 'SET_CELL_FRAME',
      payload: { cellIndex: 0, frame: 400, frameCount: 300 },
    });
    expect(ui.cellFrames[0]).toBe(299);
    applyUIAction(ui, {
      type: 'SET_CELL_FRAME',
      payload: { cellIndex: 0, frame: -5, frameCount: 300 },
    });
    expect(ui.cellFrames[0]).toBe(0);
    applyUIAction(ui, {
      type: 'SET_CELL_FRAME',
      payload: { cellIndex: 0, frame: 42, frameCount: 300 },
    });
    applyUIAction(ui, { type: 'ASSIGN_IMAGE_TO_CELL', payload: { cellIndex: 0, imageId: series } });
    expect(ui.cellFrames[0]).toBe(42); // same image: #212 rule, nothing resets
    applyUIAction(ui, {
      type: 'ASSIGN_IMAGE_TO_CELL',
      payload: { cellIndex: 0, imageId: createImageId('other') },
    });
    expect(ui.cellFrames[0]).toBeUndefined();
  });

  it('ignores an invalid cell index', () => {
    const ui = createInitialUIState();
    applyUIAction(ui, {
      type: 'SET_CELL_FRAME',
      payload: { cellIndex: -1, frame: 3, frameCount: 10 },
    });
    expect(ui.cellFrames).toEqual({});
  });
});

describe("'per-frame' count scope", () => {
  function status(
    annotations: OsdAnnotation[],
    frame: number | undefined,
    scope: 'per-frame' | 'per-image',
  ) {
    const annotationState = createInitialAnnotationState();
    for (const a of annotations) (annotationState.byImage[a.imageId] ??= {})[a.id] = a;
    const contextState = {
      ...createInitialContextState(),
      contexts: [
        {
          id: ctx,
          label: 'L',
          tools: [{ type: 'rectangle' as const, maxCount: 1, countScope: scope }],
        },
      ],
      activeContextId: ctx,
    };
    return computeConstraintStatus(contextState, annotationState, series, null, frame).rectangle;
  }

  it('limits one annotation per slice, not per series', () => {
    const anns = [point('a', 10)];
    expect(status(anns, 10, 'per-frame').enabled).toBe(false);
    expect(status(anns, 11, 'per-frame').enabled).toBe(true);
    expect(status(anns, 11, 'per-image').enabled).toBe(false); // per-image == per-series on a stack
  });

  it('counts a series-level annotation on every frame', () => {
    expect(status([point('s')], 7, 'per-frame').currentCount).toBe(1);
  });

  it("behaves like 'per-image' on a single-frame image", () => {
    expect(status([point('a', 3)], undefined, 'per-frame').currentCount).toBe(1);
  });
});

describe('serialization of frames', () => {
  it('round-trips the frame through serialize/deserialize', () => {
    const state = createInitialAnnotationState();
    state.byImage[series] = { a: point('a', 12), s: point('s') } as Record<
      string,
      OsdAnnotation
    > as never;
    const doc = JSON.parse(JSON.stringify(serialize(state))) as unknown;
    const back = deserialize(doc).byImage[series]!;
    expect(back[createAnnotationId('a')]!.frame).toEqual({ index: 12, key: 'uid-12' });
    expect(back[createAnnotationId('s')]!.frame).toBeUndefined();
  });

  it('rejects a malformed frame instead of dropping it', () => {
    const bad = { ...point('a'), frame: { index: -1 } };
    expect(() => deserialize([bad])).toThrow(/Validation failed/);
  });

  /**
   * The forward-compatibility hazard, measured: the PRE-PoC OsdFieldsSchema
   * used `v.object`, which strips unknown keys. A reader shipped before this
   * change therefore loads a frame-annotated document *without error* and
   * shows every annotation on every slice. Reproduced here with the pre-PoC
   * schema shape.
   */
  it('documents that a pre-frame reader silently strips the frame', () => {
    const PreFrameOsdFields = v.object({
      imageId: v.string(),
      contextId: v.string(),
      rawAnnotationData: FabricRawAnnotationDataSchema,
    });
    const preFrame = v.intersect([BaseAnnotationSchema, PreFrameOsdFields]);
    const parsed = v.parse(preFrame, JSON.parse(JSON.stringify(point('a', 12))));
    expect('frame' in parsed).toBe(false);
  });
});
