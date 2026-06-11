import { describe, expect, it } from 'vitest';
import type { ToolType } from '@osdlabel/annotation';
import type { ViewerControlId } from '@osdlabel/viewer-api';
import { applyUIAction } from '../../src/actions.js';
import { createInitialUIState } from '../../src/initial-state.js';

const RECTANGLE: ToolType = 'rectangle';
const EXPOSURE: ViewerControlId = 'exposure';

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
});
