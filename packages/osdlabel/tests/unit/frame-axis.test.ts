import { describe, it, expect } from 'vitest';
import * as v from 'valibot';
import { createAnnotationId } from '@osdlabel/annotation';
import { createAnnotationContextId } from '@osdlabel/annotation-context';
import { createImageId } from '@osdlabel/viewer-api';
import { BaseAnnotationSchema, FabricRawAnnotationDataSchema } from '@osdlabel/validation';
import { vi } from 'vitest';
import { BoundedDenseMaskBuffer, stampCircle } from '@osdlabel/mask';
import { applyUIAction } from '../../src/actions.js';
import { createFrameThrottle } from '../../src/frame-throttle.js';
import { buildSegmentationBrushConfig } from '../../src/brush-config.js';
import { createMaskAnnotation } from '../../src/create-mask-annotation.js';
import { DEFAULT_KEYBOARD_SHORTCUTS, mapKeyEventToActions } from '../../src/keyboard.js';
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
    expect(ui.cellFrames[0]).toEqual({ index: 299, count: 300 });
    applyUIAction(ui, {
      type: 'SET_CELL_FRAME',
      payload: { cellIndex: 0, frame: -5, frameCount: 300 },
    });
    expect(ui.cellFrames[0]).toEqual({ index: 0, count: 300 });
    applyUIAction(ui, {
      type: 'SET_CELL_FRAME',
      payload: { cellIndex: 0, frame: 42, frameCount: 300 },
    });
    applyUIAction(ui, { type: 'ASSIGN_IMAGE_TO_CELL', payload: { cellIndex: 0, imageId: series } });
    expect(ui.cellFrames[0]?.index).toBe(42); // same image: #212 rule, nothing resets
    applyUIAction(ui, {
      type: 'ASSIGN_IMAGE_TO_CELL',
      payload: { cellIndex: 0, imageId: createImageId('other') },
    });
    expect(ui.cellFrames[0]).toBeUndefined();
  });

  it('steps within the registered axis, and only for a cell that has one', () => {
    const ui = createInitialUIState();
    applyUIAction(ui, { type: 'STEP_CELL_FRAME', payload: { cellIndex: 0, delta: 1 } });
    expect(ui.cellFrames[0]).toBeUndefined();
    applyUIAction(ui, {
      type: 'SET_CELL_FRAME',
      payload: { cellIndex: 0, frame: 298, frameCount: 300 },
    });
    applyUIAction(ui, { type: 'STEP_CELL_FRAME', payload: { cellIndex: 0, delta: 5 } });
    expect(ui.cellFrames[0]).toEqual({ index: 299, count: 300 });
    applyUIAction(ui, { type: 'STEP_CELL_FRAME', payload: { cellIndex: 0, delta: 1, wrap: true } });
    expect(ui.cellFrames[0]).toEqual({ index: 0, count: 300 });
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

describe('frame shortcuts', () => {
  const state = {
    activeTool: null,
    activeCellIndex: 2,
    gridColumns: 2,
    gridRows: 2,
    selectedAnnotationId: null,
    activeImageId: series,
  };
  const status = computeConstraintStatus(
    createInitialContextState(),
    createInitialAnnotationState(),
    undefined,
  );

  it('step the active cell when it shows a multi-frame source', () => {
    const map = (key: string, framed: boolean) =>
      mapKeyEventToActions(
        key,
        false,
        DEFAULT_KEYBOARD_SHORTCUTS,
        { ...state, activeCellHasFrames: framed },
        status,
      );
    expect(map('ArrowDown', true)).toEqual([
      { type: 'STEP_CELL_FRAME', payload: { cellIndex: 2, delta: 1 } },
    ]);
    expect(map('ArrowUp', true)).toEqual([
      { type: 'STEP_CELL_FRAME', payload: { cellIndex: 2, delta: -1 } },
    ]);
    expect(map('ArrowDown', false)).toEqual([]);
  });
});

describe('the brush on a multi-frame source', () => {
  function mask(id: string, frame: number) {
    const buffer = new BoundedDenseMaskBuffer({ imageWidth: 64, imageHeight: 64 });
    stampCircle(buffer, 20.5, 20.5, 4, 1);
    return {
      ...createMaskAnnotation(buffer.snapshot(), {
        id: createAnnotationId(id),
        imageId: series,
        contextId: ctx,
      }),
      frame: { index: frame },
    };
  }

  function harness(selected: OsdAnnotation, frame: number) {
    const addAnnotation = vi.fn();
    const state = createInitialAnnotationState();
    state.byImage[series] = { [selected.id]: selected } as never;
    const config = buildSegmentationBrushConfig(
      {
        getBrushRadius: () => 5,
        isErasing: () => false,
        getImageSize: () => ({ width: 64, height: 64 }),
        getSelectedAnnotationId: () => selected.id,
        getAnnotationState: () => state,
        getImageId: () => series,
        getActiveContextId: () => ctx,
        getFrame: () => ({ index: frame, key: `uid-${frame}` }),
      },
      {
        addAnnotation,
        updateAnnotation: vi.fn(),
        deleteAnnotation: vi.fn(),
        setSelectedAnnotation: vi.fn(),
        adjustBrushRadius: vi.fn(),
      },
    );
    return { config, addAnnotation };
  }

  it('does not refine a mask selected on another slice', () => {
    expect(harness(mask('m', 11), 12).config.getTarget()).toBeNull();
    expect(harness(mask('m', 12), 12).config.getTarget()).not.toBeNull();
  });

  it('places a new mask on the painted frame', () => {
    const { config, addAnnotation } = harness(mask('m', 11), 12);
    const buffer = new BoundedDenseMaskBuffer({ imageWidth: 64, imageHeight: 64 });
    stampCircle(buffer, 30.5, 30.5, 3, 1);
    config.onCommit({
      annotationId: null,
      imageId: series,
      contextId: ctx,
      snapshot: buffer.snapshot(),
    });
    expect(addAnnotation).toHaveBeenCalled();
    expect((addAnnotation.mock.calls[0]![0] as OsdAnnotation).frame).toEqual({
      index: 12,
      key: 'uid-12',
    });
  });
});

describe('createFrameThrottle', () => {
  it('applies the first request now and collapses the rest of the frame to the newest', () => {
    const queue: (() => void)[] = [];
    const applied: number[] = [];
    const t = createFrameThrottle<number>(
      (v) => applied.push(v),
      (cb) => queue.push(cb),
    );
    t.request(1);
    t.request(2);
    t.request(3);
    expect(applied).toEqual([1]);
    queue.shift()!();
    expect(applied).toEqual([1, 3]);
    queue.shift()!();
    expect(queue).toEqual([]);
    t.request(4);
    expect(applied).toEqual([1, 3, 4]);
    t.cancel();
    t.request(5);
    queue.shift()!();
    expect(applied).toEqual([1, 3, 4]);
  });
});
