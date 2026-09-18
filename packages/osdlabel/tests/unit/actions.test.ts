import { describe, expect, it } from 'vitest';
import type { AnnotationId, ToolType } from '@osdlabel/annotation';
import type { ViewerControlId } from '@osdlabel/viewer-api';
import { createImageId, DEFAULT_CELL_TRANSFORM } from '@osdlabel/viewer-api';
import { applyUIAction } from '../../src/actions.js';
import { createInitialUIState } from '../../src/initial-state.js';

const RECTANGLE: ToolType = 'rectangle';
const TONE: ViewerControlId = 'tone';
const annId = (s: string): AnnotationId => s as AnnotationId;

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
    // Delete, not blank. No consumer enumerates this record today — every read
    // is by cell index — but it is public state on a `Record<number, ImageId>`,
    // and an absent cell is what we mean. A key left holding `undefined` would
    // make any future enumerating reader see a cell that is not there.
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
    const selected = annId('ann-1');
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

describe('applyUIAction — SET_GRID_DIMENSIONS keeps the active cell in range', () => {
  it('clamps activeCellIndex to the last cell when the grid shrinks past it', () => {
    const state = createInitialUIState();
    applyUIAction(state, { type: 'SET_GRID_DIMENSIONS', payload: { columns: 3, rows: 3 } });
    applyUIAction(state, { type: 'SET_ACTIVE_CELL', payload: 8 });

    applyUIAction(state, { type: 'SET_GRID_DIMENSIONS', payload: { columns: 2, rows: 2 } });

    // 3 rather than 0: shrinking from 3x3 to 2x2 distinguishes "clamp to the
    // last cell" from "reset to the first", which a 2x1 -> 1x1 shrink cannot.
    // This reducer is the only clamp, so without it a shrink from any caller
    // leaves the active cell offscreen — and every action keyed on it then
    // edits invisible state.
    expect(state.activeCellIndex).toBe(3);
  });

  it('floors the grid at one cell, so the active cell always has one to address', () => {
    const state = createInitialUIState();

    // `setGridDimensions` is public and takes raw numbers. A zero-cell grid
    // would make `maxIndex` -1, and then every clamp lands on cell 0 — a cell
    // that does not exist — which quietly re-breaks the invariant the rest of
    // this file relies on.
    applyUIAction(state, { type: 'SET_GRID_DIMENSIONS', payload: { columns: 0, rows: 0 } });
    expect(state.gridColumns).toBe(1);
    expect(state.gridRows).toBe(1);
    expect(state.activeCellIndex).toBe(0);
  });

  it('floors a negative or fractional dimension too', () => {
    const state = createInitialUIState();

    applyUIAction(state, { type: 'SET_GRID_DIMENSIONS', payload: { columns: -3, rows: 2.7 } });

    expect(state.gridColumns).toBe(1);
    expect(state.gridRows).toBe(2);
  });

  it('leaves activeCellIndex alone when it still fits', () => {
    const state = createInitialUIState();
    applyUIAction(state, { type: 'SET_GRID_DIMENSIONS', payload: { columns: 2, rows: 2 } });
    applyUIAction(state, { type: 'SET_ACTIVE_CELL', payload: 2 });

    applyUIAction(state, { type: 'SET_GRID_DIMENSIONS', payload: { columns: 2, rows: 2 } });

    expect(state.activeCellIndex).toBe(2);
  });

  it('keeps assignments for pruned cells so a shrink/expand round trip restores them', () => {
    const state = createInitialUIState();
    const img = createImageId('img-pruned');
    applyUIAction(state, { type: 'SET_GRID_DIMENSIONS', payload: { columns: 2, rows: 1 } });
    applyUIAction(state, { type: 'ASSIGN_IMAGE_TO_CELL', payload: { cellIndex: 1, imageId: img } });

    applyUIAction(state, { type: 'SET_GRID_DIMENSIONS', payload: { columns: 1, rows: 1 } });
    expect(state.gridAssignments[1]).toBe(img);

    applyUIAction(state, { type: 'SET_GRID_DIMENSIONS', payload: { columns: 2, rows: 1 } });
    expect(state.gridAssignments[1]).toBe(img);
  });
});

describe('applyUIAction — SET_ACTIVE_CELL keeps the active cell inside the grid', () => {
  it('activates a cell the grid renders', () => {
    const state = createInitialUIState();
    applyUIAction(state, { type: 'SET_GRID_DIMENSIONS', payload: { columns: 2, rows: 2 } });

    applyUIAction(state, { type: 'SET_ACTIVE_CELL', payload: 3 });

    expect(state.activeCellIndex).toBe(3);
  });

  it('clamps a cell past the end of the grid', () => {
    const state = createInitialUIState();
    applyUIAction(state, { type: 'SET_GRID_DIMENSIONS', payload: { columns: 2, rows: 1 } });

    applyUIAction(state, { type: 'SET_ACTIVE_CELL', payload: 8 });

    // The invariant everything downstream relies on: the active cell always
    // addresses a cell on screen, so reads keyed on it never reach state the
    // user cannot see, and need no scoping of their own.
    expect(state.activeCellIndex).toBe(1);
  });

  it('clamps a negative cell index', () => {
    const state = createInitialUIState();
    applyUIAction(state, { type: 'SET_GRID_DIMENSIONS', payload: { columns: 2, rows: 2 } });

    applyUIAction(state, { type: 'SET_ACTIVE_CELL', payload: -3 });

    expect(state.activeCellIndex).toBe(0);
  });

  it('counts rows as well as columns', () => {
    const state = createInitialUIState();
    applyUIAction(state, { type: 'SET_GRID_DIMENSIONS', payload: { columns: 2, rows: 2 } });

    // Cell 3 exists on a 2x2; a clamp that only looked at columns would reject
    // every cell below the first row.
    applyUIAction(state, { type: 'SET_ACTIVE_CELL', payload: 3 });
    expect(state.activeCellIndex).toBe(3);
  });

  it('lands on a cell that exists even when the grid was asked for zero cells', () => {
    const state = createInitialUIState();
    applyUIAction(state, { type: 'SET_GRID_DIMENSIONS', payload: { columns: 0, rows: 0 } });

    applyUIAction(state, { type: 'SET_ACTIVE_CELL', payload: 4 });

    // Cell 0 is a real cell here only because SET_GRID_DIMENSIONS floored the
    // grid to 1x1. Without that floor this assertion would pass while naming a
    // cell nobody renders — which is exactly how the invariant leaked before.
    expect(state.gridColumns * state.gridRows).toBeGreaterThan(0);
    expect(state.activeCellIndex).toBe(0);
  });

  it('holds the invariant whichever order a host sizes and selects in', () => {
    // The ordering rule this imposes on hosts: size the grid first, or the
    // index is clamped to what currently exists. Both reducers clamp, so
    // neither sequence can leave the active cell outside the grid.
    const sizeThenSelect = createInitialUIState();
    applyUIAction(sizeThenSelect, {
      type: 'SET_GRID_DIMENSIONS',
      payload: { columns: 2, rows: 2 },
    });
    applyUIAction(sizeThenSelect, { type: 'SET_ACTIVE_CELL', payload: 3 });
    expect(sizeThenSelect.activeCellIndex).toBe(3);

    const selectThenSize = createInitialUIState();
    applyUIAction(selectThenSize, { type: 'SET_ACTIVE_CELL', payload: 3 });
    applyUIAction(selectThenSize, {
      type: 'SET_GRID_DIMENSIONS',
      payload: { columns: 2, rows: 2 },
    });
    // Clamped on the way in by the 1x1 grid that existed at the time, so the
    // saved index is not recovered — hence the ordering rule.
    expect(selectThenSize.activeCellIndex).toBe(0);
  });
});

describe('applyUIAction — the active cell is a whole, finite, in-grid index', () => {
  it('truncates a fractional cell index', () => {
    const state = createInitialUIState();
    applyUIAction(state, { type: 'SET_GRID_DIMENSIONS', payload: { columns: 2, rows: 2 } });

    applyUIAction(state, { type: 'SET_ACTIVE_CELL', payload: 1.5 });

    // A clamp alone would leave 1.5 untouched — it is inside the grid by every
    // comparison, yet `gridAssignments[1.5]` and `cellTransforms[1.5]` are both
    // permanently `undefined`, so the active cell would show no image and offer
    // no clear affordance. Whole numbers are what the records are keyed by.
    expect(state.activeCellIndex).toBe(1);
  });

  it('maps a NaN cell index to the first cell', () => {
    const state = createInitialUIState();
    applyUIAction(state, { type: 'SET_GRID_DIMENSIONS', payload: { columns: 2, rows: 2 } });
    applyUIAction(state, { type: 'SET_ACTIVE_CELL', payload: 3 });

    applyUIAction(state, { type: 'SET_ACTIVE_CELL', payload: NaN });

    // NaN is the one value the clamp cannot reject: every Math.min/Math.max
    // involving it yields NaN, so it would sail through and poison every
    // reader keyed on the active cell.
    expect(state.activeCellIndex).toBe(0);
  });

  it('clamps an infinite cell index like any other out-of-range one', () => {
    const state = createInitialUIState();
    applyUIAction(state, { type: 'SET_GRID_DIMENSIONS', payload: { columns: 2, rows: 1 } });

    applyUIAction(state, { type: 'SET_ACTIVE_CELL', payload: Infinity });
    expect(state.activeCellIndex).toBe(1);

    applyUIAction(state, { type: 'SET_ACTIVE_CELL', payload: -Infinity });
    expect(state.activeCellIndex).toBe(0);
  });

  it('floors a NaN grid dimension rather than propagating it', () => {
    const state = createInitialUIState();

    applyUIAction(state, { type: 'SET_GRID_DIMENSIONS', payload: { columns: NaN, rows: 2 } });

    // `Math.max(1, NaN)` is NaN, so a bare floor would leave the grid — and
    // then `maxIndex`, and then every clamp derived from it — NaN.
    expect(state.gridColumns).toBe(1);
    expect(state.gridRows).toBe(2);
    expect(state.activeCellIndex).toBe(0);
  });

  it('floors an infinite grid dimension to a grid that can be rendered', () => {
    const state = createInitialUIState();

    applyUIAction(state, { type: 'SET_GRID_DIMENSIONS', payload: { columns: Infinity, rows: 1 } });

    expect(state.gridColumns).toBe(1);
    expect(Number.isFinite(state.gridColumns * state.gridRows)).toBe(true);
  });

  it('holds the invariant for every value the public API accepts', () => {
    // The whole point of the invariant: whatever a host passes, what comes out
    // addresses a cell the grid renders.
    const payloads = [0, 3, -3, 1.5, -0.5, NaN, Infinity, -Infinity, 1e21];
    for (const payload of payloads) {
      const state = createInitialUIState();
      applyUIAction(state, { type: 'SET_GRID_DIMENSIONS', payload: { columns: 2, rows: 2 } });
      applyUIAction(state, { type: 'SET_ACTIVE_CELL', payload });

      const cellCount = state.gridColumns * state.gridRows;
      expect(Number.isInteger(state.activeCellIndex)).toBe(true);
      expect(state.activeCellIndex).toBeGreaterThanOrEqual(0);
      expect(state.activeCellIndex).toBeLessThan(cellCount);
    }
  });
});
