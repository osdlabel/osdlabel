import { describe, expect, it } from 'vitest';
import type { ToolType } from '@osdlabel/annotation';
import type { ViewerControlId } from '@osdlabel/viewer-api';
import { MAX_BRUSH_RADIUS, MIN_BRUSH_RADIUS } from '@osdlabel/viewer-api';
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

describe('applyUIAction — brush state', () => {
  it('starts at the default radius, painting rather than erasing', () => {
    // Fixed literals, not the constants under test: deriving the expectation
    // from the implementation makes the assertion pass for any value.
    const state = createInitialUIState();
    expect(state.brushRadius).toBe(12);
    expect(state.brushErasing).toBe(false);
  });

  it('SET_BRUSH_RADIUS stores a rounded value', () => {
    const state = createInitialUIState();
    applyUIAction(state, { type: 'SET_BRUSH_RADIUS', payload: 7.6 });
    expect(state.brushRadius).toBe(8);
  });

  it('SET_BRUSH_RADIUS clamps to the supported range', () => {
    const state = createInitialUIState();
    applyUIAction(state, { type: 'SET_BRUSH_RADIUS', payload: 100_000 });
    expect(state.brushRadius).toBe(MAX_BRUSH_RADIUS);
    applyUIAction(state, { type: 'SET_BRUSH_RADIUS', payload: -5 });
    expect(state.brushRadius).toBe(MIN_BRUSH_RADIUS);
  });

  it('SET_BRUSH_RADIUS ignores a non-finite value rather than storing it', () => {
    // NaN survives both Math.round and the min/max pair, and a stored NaN is
    // unrecoverable from the keyboard — the resize keys step from the current
    // value. A host binding a text field (`Number(input.value)`) hits this.
    const state = createInitialUIState();
    applyUIAction(state, { type: 'SET_BRUSH_RADIUS', payload: 9 });
    applyUIAction(state, { type: 'SET_BRUSH_RADIUS', payload: Number.NaN });
    expect(state.brushRadius).toBe(9);
  });

  it('SET_BRUSH_ERASING stores what it is given, both ways', () => {
    const state = createInitialUIState();
    applyUIAction(state, { type: 'SET_BRUSH_ERASING', payload: true });
    expect(state.brushErasing).toBe(true);
    applyUIAction(state, { type: 'SET_BRUSH_ERASING', payload: false });
    expect(state.brushErasing).toBe(false);
  });

  it('the brush is a tool like any other for mutual exclusivity', () => {
    const state = createInitialUIState();
    applyUIAction(state, { type: 'SET_ACTIVE_VIEWER_CONTROL', payload: TONE });
    applyUIAction(state, { type: 'SET_ACTIVE_TOOL', payload: 'segmentationBrush' });
    expect(state.activeTool).toBe('segmentationBrush');
    expect(state.activeViewerControl).toBeNull();
  });
});
