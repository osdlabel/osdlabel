import { describe, it, expect } from 'vitest';
import { createRoot } from 'solid-js';
import { createAnnotationStore } from '../../../src/state/annotation-store';
import { createUIStore } from '../../../src/state/ui-store';
import { createContextStore } from '../../../src/state/context-store';
import { createActions } from '../../../src/state/actions';
import { createImageId } from '@osdlabel/viewer-api';
import { DEFAULT_CELL_TRANSFORM } from '@osdlabel/viewer-api';

describe('View Transform Actions', () => {
  function createTestStore() {
    return createRoot((dispose) => {
      const { state: annotationState, setState: setAnnotationState } = createAnnotationStore();
      const { state: uiState, setState: setUIState } = createUIStore();
      const { state: contextState, setState: setContextState } = createContextStore();

      const actions = createActions(
        setAnnotationState,
        setUIState,
        setContextState,
        contextState,
        uiState,
        annotationState,
      );

      return { annotationState, uiState, setUIState, actions, dispose };
    });
  }

  const dummyImageId = createImageId('img1');

  it('rotateActiveImageCW rotates by 90 degrees', () => {
    const { uiState, setUIState, actions, dispose } = createTestStore();
    setUIState('gridAssignments', 0, dummyImageId);

    actions.rotateActiveImageCW();
    expect(uiState.cellTransforms[0]).toEqual({
      ...DEFAULT_CELL_TRANSFORM,
      rotation: 90,
    });

    actions.rotateActiveImageCW();
    expect(uiState.cellTransforms[0]).toEqual({
      ...DEFAULT_CELL_TRANSFORM,
      rotation: 180,
    });

    actions.rotateActiveImageCW();
    expect(uiState.cellTransforms[0]).toEqual({
      ...DEFAULT_CELL_TRANSFORM,
      rotation: 270,
    });

    actions.rotateActiveImageCW();
    expect(uiState.cellTransforms[0]).toEqual({
      ...DEFAULT_CELL_TRANSFORM,
      rotation: 0,
    });

    dispose();
  });

  it('rotateActiveImageCCW rotates by -90 degrees (270)', () => {
    const { uiState, setUIState, actions, dispose } = createTestStore();
    setUIState('gridAssignments', 0, dummyImageId);

    actions.rotateActiveImageCCW();
    expect(uiState.cellTransforms[0]).toEqual({
      ...DEFAULT_CELL_TRANSFORM,
      rotation: 270,
    });

    actions.rotateActiveImageCCW();
    expect(uiState.cellTransforms[0]).toEqual({
      ...DEFAULT_CELL_TRANSFORM,
      rotation: 180,
    });

    actions.rotateActiveImageCCW();
    expect(uiState.cellTransforms[0]).toEqual({
      ...DEFAULT_CELL_TRANSFORM,
      rotation: 90,
    });

    actions.rotateActiveImageCCW();
    expect(uiState.cellTransforms[0]).toEqual({
      ...DEFAULT_CELL_TRANSFORM,
      rotation: 0,
    });

    dispose();
  });

  it('flipActiveImageH toggles horizontal flip', () => {
    const { uiState, setUIState, actions, dispose } = createTestStore();
    setUIState('gridAssignments', 0, dummyImageId);

    actions.flipActiveImageH();
    expect(uiState.cellTransforms[0]).toEqual({
      ...DEFAULT_CELL_TRANSFORM,
      flippedH: true,
    });

    actions.flipActiveImageH();
    expect(uiState.cellTransforms[0]).toEqual({
      ...DEFAULT_CELL_TRANSFORM,
      flippedH: false,
    });

    dispose();
  });

  it('flipActiveImageV toggles vertical flip', () => {
    const { uiState, setUIState, actions, dispose } = createTestStore();
    setUIState('gridAssignments', 0, dummyImageId);

    actions.flipActiveImageV();
    expect(uiState.cellTransforms[0]).toEqual({
      ...DEFAULT_CELL_TRANSFORM,
      flippedV: true,
    });

    actions.flipActiveImageV();
    expect(uiState.cellTransforms[0]).toEqual({
      ...DEFAULT_CELL_TRANSFORM,
      flippedV: false,
    });

    dispose();
  });

  it('resetActiveImageView resets to default transform', () => {
    const { uiState, setUIState, actions, dispose } = createTestStore();
    setUIState('gridAssignments', 0, dummyImageId);

    actions.rotateActiveImageCW();
    actions.flipActiveImageH();

    actions.resetActiveImageView();
    expect(uiState.cellTransforms[0]).toEqual(DEFAULT_CELL_TRANSFORM);

    dispose();
  });

  it('only affects the active cell', () => {
    const { uiState, setUIState, actions, dispose } = createTestStore();
    setUIState('gridAssignments', 0, dummyImageId);
    setUIState('gridAssignments', 1, dummyImageId);

    // Flip on cell 0
    actions.flipActiveImageH();

    // Switch to cell 1 and rotate
    setUIState('activeCellIndex', 1);
    actions.rotateActiveImageCW();

    expect(uiState.cellTransforms[0]).toEqual({
      ...DEFAULT_CELL_TRANSFORM,
      flippedH: true,
    });
    expect(uiState.cellTransforms[1]).toEqual({
      ...DEFAULT_CELL_TRANSFORM,
      rotation: 90,
    });

    dispose();
  });
});
