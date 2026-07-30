import { describe, expect, it } from 'vitest';
import type { ToolType } from '@osdlabel/annotation';
import type { ViewerControlId } from '@osdlabel/viewer-api';
import { applyUIAction } from '../../src/actions.js';
import { createInitialUIState } from '../../src/initial-state.js';

const RECTANGLE: ToolType = 'rectangle';
const EXPOSURE: ViewerControlId = 'exposure';
const CONTRAST: ViewerControlId = 'contrast';

describe('applyUIAction — tool / viewer-control mutual exclusivity', () => {
  it('SET_ACTIVE_VIEWER_CONTROL clears an active tool', () => {
    const state = createInitialUIState();
    applyUIAction(state, { type: 'SET_ACTIVE_TOOL', payload: RECTANGLE });
    expect(state.activeTool).toBe(RECTANGLE);

    applyUIAction(state, { type: 'SET_ACTIVE_VIEWER_CONTROL', payload: EXPOSURE });
    expect(state.activeViewerControl).toBe(EXPOSURE);
    expect(state.activeTool).toBeNull();
  });

  it('SET_ACTIVE_TOOL clears an active viewer control', () => {
    const state = createInitialUIState();
    applyUIAction(state, { type: 'SET_ACTIVE_VIEWER_CONTROL', payload: EXPOSURE });
    expect(state.activeViewerControl).toBe(EXPOSURE);

    applyUIAction(state, { type: 'SET_ACTIVE_TOOL', payload: RECTANGLE });
    expect(state.activeTool).toBe(RECTANGLE);
    expect(state.activeViewerControl).toBeNull();
  });

  it('clearing the tool to null leaves the viewer control untouched', () => {
    const state = createInitialUIState();
    applyUIAction(state, { type: 'SET_ACTIVE_VIEWER_CONTROL', payload: EXPOSURE });

    applyUIAction(state, { type: 'SET_ACTIVE_TOOL', payload: null });
    expect(state.activeTool).toBeNull();
    expect(state.activeViewerControl).toBe(EXPOSURE);
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
    applyUIAction(state, { type: 'SET_ACTIVE_VIEWER_CONTROL', payload: EXPOSURE });

    applyUIAction(state, { type: 'SET_ACTIVE_TOOL', payload: 'select' });
    expect(state.activeTool).toBe('select');
    expect(state.activeViewerControl).toBeNull();
  });

  it('switching between drag controls replaces the active one', () => {
    const state = createInitialUIState();
    applyUIAction(state, { type: 'SET_ACTIVE_VIEWER_CONTROL', payload: EXPOSURE });

    applyUIAction(state, { type: 'SET_ACTIVE_VIEWER_CONTROL', payload: CONTRAST });
    expect(state.activeViewerControl).toBe(CONTRAST);
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
