import { describe, expect, it } from 'vitest';
import type { AnnotationId, ToolType } from '@osdlabel/annotation';
import type { ViewerControlId } from '@osdlabel/viewer-api';
import { createImageId, DEFAULT_CELL_TRANSFORM } from '@osdlabel/viewer-api';
import { applyUIAction } from '../../src/actions.js';
import { createInitialUIState } from '../../src/initial-state.js';

const RECTANGLE: ToolType = 'rectangle';
const TONE: ViewerControlId = 'tone';

describe('applyUIAction — tool / viewer-control mutual exclusivity', () => {
  it('SET_ACTIVE_VIEWER_CONTROL clears an active tool', () => {
    const state = createInitialUIState();
    applyUIAction(state, { type: 'SET_ACTIVE_TOOL', payload: RECTANGLE });
    expect(state.activeTool).toBe(RECTANGLE);

    applyUIAction(state, { type: 'SET_ACTIVE_VIEWER_CONTROL', payload: TONE });
    expect(state.activeViewerControl).toBe(TONE);
    expect(state.activeTool).toBeNull();
  });

  it('SET_ACTIVE_TOOL clears an active viewer control', () => {
    const state = createInitialUIState();
    applyUIAction(state, { type: 'SET_ACTIVE_VIEWER_CONTROL', payload: TONE });
    expect(state.activeViewerControl).toBe(TONE);

    applyUIAction(state, { type: 'SET_ACTIVE_TOOL', payload: RECTANGLE });
    expect(state.activeTool).toBe(RECTANGLE);
    expect(state.activeViewerControl).toBeNull();
  });

  it('clearing the tool to null leaves the viewer control untouched', () => {
    const state = createInitialUIState();
    applyUIAction(state, { type: 'SET_ACTIVE_VIEWER_CONTROL', payload: TONE });

    applyUIAction(state, { type: 'SET_ACTIVE_TOOL', payload: null });
    expect(state.activeTool).toBeNull();
    expect(state.activeViewerControl).toBe(TONE);
  });

  it('clearing the viewer control to null leaves the tool untouched', () => {
    const state = createInitialUIState();
    applyUIAction(state, { type: 'SET_ACTIVE_TOOL', payload: RECTANGLE });

    applyUIAction(state, { type: 'SET_ACTIVE_VIEWER_CONTROL', payload: null });
    expect(state.activeViewerControl).toBeNull();
    expect(state.activeTool).toBe(RECTANGLE);
  });

  it('selecting the select tool also clears the viewer control', () => {
    const state = createInitialUIState();
    applyUIAction(state, { type: 'SET_ACTIVE_VIEWER_CONTROL', payload: TONE });

    applyUIAction(state, { type: 'SET_ACTIVE_TOOL', payload: 'select' });
    expect(state.activeTool).toBe('select');
    expect(state.activeViewerControl).toBeNull();
  });
});

describe('applyUIAction — contrast', () => {
  it('INCREASE_CONTRAST steps by 0.1 and clamps at 1', () => {
    const state = createInitialUIState();
    applyUIAction(state, { type: 'INCREASE_CONTRAST', payload: { cellIndex: 0 } });
    expect(state.cellTransforms[0]?.contrast).toBe(0.1);

    applyUIAction(state, { type: 'SET_CONTRAST', payload: { cellIndex: 0, value: 0.95 } });
    applyUIAction(state, { type: 'INCREASE_CONTRAST', payload: { cellIndex: 0 } });
    expect(state.cellTransforms[0]?.contrast).toBe(1);
  });

  it('DECREASE_CONTRAST steps by 0.1 and clamps at -1', () => {
    const state = createInitialUIState();
    applyUIAction(state, { type: 'DECREASE_CONTRAST', payload: { cellIndex: 1 } });
    expect(state.cellTransforms[1]?.contrast).toBe(-0.1);

    applyUIAction(state, { type: 'SET_CONTRAST', payload: { cellIndex: 1, value: -0.95 } });
    applyUIAction(state, { type: 'DECREASE_CONTRAST', payload: { cellIndex: 1 } });
    expect(state.cellTransforms[1]?.contrast).toBe(-1);
  });

  it('SET_CONTRAST clamps to [-1, 1] and keeps the drag control resolution', () => {
    const state = createInitialUIState();
    applyUIAction(state, { type: 'SET_CONTRAST', payload: { cellIndex: 0, value: 0.025 } });
    expect(state.cellTransforms[0]?.contrast).toBe(0.025);

    applyUIAction(state, { type: 'SET_CONTRAST', payload: { cellIndex: 0, value: 2 } });
    expect(state.cellTransforms[0]?.contrast).toBe(1);

    applyUIAction(state, { type: 'SET_CONTRAST', payload: { cellIndex: 0, value: -2 } });
    expect(state.cellTransforms[0]?.contrast).toBe(-1);
  });

  it('contrast and exposure are independent, and RESET_VIEW clears both', () => {
    const state = createInitialUIState();
    applyUIAction(state, { type: 'SET_CONTRAST', payload: { cellIndex: 2, value: 0.4 } });
    applyUIAction(state, { type: 'SET_EXPOSURE', payload: { cellIndex: 2, value: -0.3 } });
    expect(state.cellTransforms[2]?.contrast).toBe(0.4);
    expect(state.cellTransforms[2]?.exposure).toBe(-0.3);

    applyUIAction(state, { type: 'RESET_VIEW', payload: { cellIndex: 2 } });
    expect(state.cellTransforms[2]?.contrast).toBe(0);
    expect(state.cellTransforms[2]?.exposure).toBe(0);
  });
});

describe('applyUIAction — UNASSIGN_IMAGE_FROM_CELL', () => {
  const IMG_A = createImageId('img-a');
  const IMG_B = createImageId('img-b');

  it('returns the cell to the empty state, deleting the key rather than blanking it', () => {
    const state = createInitialUIState();
    applyUIAction(state, {
      type: 'ASSIGN_IMAGE_TO_CELL',
      payload: { cellIndex: 0, imageId: IMG_A },
    });
    expect(state.gridAssignments[0]).toBe(IMG_A);

    applyUIAction(state, { type: 'UNASSIGN_IMAGE_FROM_CELL', payload: { cellIndex: 0 } });

    expect(state.gridAssignments[0]).toBeUndefined();
    // The distinction matters: `GridView` renders the placeholder on falsiness,
    // but `Object.values(gridAssignments)` drives the filmstrip highlight, and a
    // key left behind holding `undefined` would still be enumerated.
    expect(Object.keys(state.gridAssignments)).toHaveLength(0);
    expect(0 in state.gridAssignments).toBe(false);
  });

  it('drops the cell transform, mirroring the reset ASSIGN_IMAGE_TO_CELL performs', () => {
    const state = createInitialUIState();
    applyUIAction(state, {
      type: 'ASSIGN_IMAGE_TO_CELL',
      payload: { cellIndex: 0, imageId: IMG_A },
    });
    applyUIAction(state, { type: 'TOGGLE_NEGATIVE', payload: { cellIndex: 0 } });
    expect(state.cellTransforms[0]!.inverted).toBe(true);

    applyUIAction(state, { type: 'UNASSIGN_IMAGE_FROM_CELL', payload: { cellIndex: 0 } });

    expect(state.cellTransforms[0]).toBeUndefined();
  });

  it('leaves other cells untouched', () => {
    const state = createInitialUIState();
    applyUIAction(state, {
      type: 'ASSIGN_IMAGE_TO_CELL',
      payload: { cellIndex: 0, imageId: IMG_A },
    });
    applyUIAction(state, {
      type: 'ASSIGN_IMAGE_TO_CELL',
      payload: { cellIndex: 1, imageId: IMG_B },
    });

    applyUIAction(state, { type: 'UNASSIGN_IMAGE_FROM_CELL', payload: { cellIndex: 0 } });

    expect(state.gridAssignments[0]).toBeUndefined();
    expect(state.gridAssignments[1]).toBe(IMG_B);
    expect(state.cellTransforms[1]).toBeDefined();
  });

  it('is a no-op on a cell that is already empty', () => {
    const state = createInitialUIState();

    expect(() =>
      applyUIAction(state, { type: 'UNASSIGN_IMAGE_FROM_CELL', payload: { cellIndex: 3 } }),
    ).not.toThrow();

    expect(state.gridAssignments[3]).toBeUndefined();
  });

  it('leaves selectedAnnotationId alone, since another cell may still show that image', () => {
    const state = createInitialUIState();
    const selected = 'ann-1' as AnnotationId;
    applyUIAction(state, {
      type: 'ASSIGN_IMAGE_TO_CELL',
      payload: { cellIndex: 0, imageId: IMG_A },
    });
    applyUIAction(state, { type: 'SET_SELECTED_ANNOTATION', payload: selected });

    applyUIAction(state, { type: 'UNASSIGN_IMAGE_FROM_CELL', payload: { cellIndex: 0 } });

    expect(state.selectedAnnotationId).toBe(selected);
  });

  it('round-trips: a re-assigned cell is indistinguishable from a freshly assigned one', () => {
    const state = createInitialUIState();
    applyUIAction(state, {
      type: 'ASSIGN_IMAGE_TO_CELL',
      payload: { cellIndex: 0, imageId: IMG_A },
    });
    applyUIAction(state, { type: 'UNASSIGN_IMAGE_FROM_CELL', payload: { cellIndex: 0 } });
    applyUIAction(state, {
      type: 'ASSIGN_IMAGE_TO_CELL',
      payload: { cellIndex: 0, imageId: IMG_A },
    });

    expect(state.gridAssignments[0]).toBe(IMG_A);
    expect(state.cellTransforms[0]).toEqual(DEFAULT_CELL_TRANSFORM);
  });
});
