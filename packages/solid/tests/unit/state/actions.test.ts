import { describe, it, expect } from 'vitest';
import { version as FABRIC_VERSION } from 'fabric';
import { createRoot } from 'solid-js';
import { createAnnotationStore } from '../../../src/state/annotation-store';
import { createUIStore } from '../../../src/state/ui-store';
import { createContextStore, createConstraintStatus } from '../../../src/state/context-store';
import { createActions } from '../../../src/state/actions';
import { createAnnotationId } from '@osdlabel/annotation';
import type { OsdAnnotation } from 'osdlabel';
import { createImageId } from '@osdlabel/viewer-api';
import { createAnnotationContextId } from '@osdlabel/annotation-context';
import type { AnnotationContext } from '@osdlabel/annotation-context';

describe('State Management', () => {
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
      // Assign image to cell 0 so constraint status has a currentImageId
      setUIState('gridAssignments', 0, dummyImageId);
      const activeImageId = () => uiState.gridAssignments[uiState.activeCellIndex];
      const constraintStatus = createConstraintStatus(contextState, annotationState, activeImageId);

      return { annotationState, uiState, contextState, actions, constraintStatus, dispose };
    });
  }

  const dummyAnnotationId = createAnnotationId('ann1');
  const dummyImageId = createImageId('img1');
  const dummyContextId = createAnnotationContextId('ctx1');

  const dummyAnnotation: Omit<OsdAnnotation, 'createdAt' | 'updatedAt'> = {
    id: dummyAnnotationId,
    imageId: dummyImageId,
    contextId: dummyContextId,
    toolType: 'rectangle',
    geometry: { type: 'rectangle', origin: { x: 0, y: 0 }, width: 10, height: 10, rotation: 0 },
    rawAnnotationData: {
      format: 'fabric' as const,
      fabricVersion: FABRIC_VERSION,
      data: { type: 'Rect', left: 0, top: 0, width: 10, height: 10 },
    },
  };

  it('addAnnotation adds to the correct image bucket and sets timestamps', () => {
    const { annotationState, actions, dispose } = createTestStore();

    actions.addAnnotation(dummyAnnotation);

    const imgAnns = annotationState.byImage[dummyImageId];
    expect(imgAnns).toBeDefined();
    const ann = imgAnns![dummyAnnotationId];
    expect(ann).toBeDefined();
    expect(ann!.id).toBe(dummyAnnotationId);
    expect(ann!.createdAt).not.toBe('');
    expect(ann!.updatedAt).not.toBe('');

    dispose();
  });

  it('updateAnnotation updates the annotation and sets updatedAt', () => {
    const { annotationState, actions, dispose } = createTestStore();
    actions.addAnnotation(dummyAnnotation);

    const patch = { label: 'Updated Label' };
    actions.updateAnnotation(dummyAnnotationId, dummyImageId, patch);

    const updatedAnn = annotationState.byImage[dummyImageId]![dummyAnnotationId];
    expect(updatedAnn).toBeDefined();
    expect(updatedAnn!.label).toBe('Updated Label');
    expect(updatedAnn!.updatedAt).not.toBe('');

    dispose();
  });

  it('deleteAnnotation removes the annotation', () => {
    const { annotationState, actions, dispose } = createTestStore();
    actions.addAnnotation(dummyAnnotation);

    actions.deleteAnnotation(dummyAnnotationId, dummyImageId);

    // DELETE_ANNOTATION empties the bucket but never removes it, so assert the
    // bucket still exists rather than letting `?.` swallow a regression that
    // wiped the whole image entry.
    const imgAnns = annotationState.byImage[dummyImageId];
    expect(imgAnns).toBeDefined();
    expect(imgAnns![dummyAnnotationId]).toBeUndefined();

    dispose();
  });

  it('setActiveTool updates UI state', () => {
    const { uiState, actions, dispose } = createTestStore();
    actions.setActiveTool('circle');
    expect(uiState.activeTool).toBe('circle');
    dispose();
  });

  it('Constraint logic correctly enables/disables tools', () => {
    const { actions, constraintStatus, dispose } = createTestStore();

    const context: AnnotationContext = {
      id: dummyContextId,
      label: 'Test Context',
      tools: [
        { type: 'rectangle', maxCount: 1 },
        { type: 'circle' }, // unlimited
      ],
    };

    actions.setContexts([context]);
    actions.setActiveContext(dummyContextId);

    // Check initial status
    let status = constraintStatus();
    expect(status.rectangle.enabled).toBe(true);
    expect(status.rectangle.currentCount).toBe(0);
    expect(status.circle.enabled).toBe(true);

    // Add 1 rectangle
    actions.addAnnotation({
      ...dummyAnnotation,
      id: createAnnotationId('rect1'),
      contextId: dummyContextId,
      geometry: { type: 'rectangle', origin: { x: 0, y: 0 }, width: 10, height: 10, rotation: 0 },
    });

    status = constraintStatus();
    expect(status.rectangle.currentCount).toBe(1);
    expect(status.rectangle.enabled).toBe(false); // Max 1 reached
    expect(status.circle.enabled).toBe(true);

    // Delete rectangle
    actions.deleteAnnotation(createAnnotationId('rect1'), dummyImageId);

    status = constraintStatus();
    expect(status.rectangle.currentCount).toBe(0);
    expect(status.rectangle.enabled).toBe(true); // Re-enabled

    dispose();
  });

  it('setActiveCell updates active cell index', () => {
    const { uiState, actions, dispose } = createTestStore();
    actions.setActiveCell(1);
    expect(uiState.activeCellIndex).toBe(1);
    dispose();
  });

  it('assignImageToCell assigns image to cell', () => {
    const { uiState, actions, dispose } = createTestStore();
    actions.assignImageToCell(1, dummyImageId);
    expect(uiState.gridAssignments[1]).toBe(dummyImageId);
    dispose();
  });

  it('setGridDimensions updates grid dimensions', () => {
    const { uiState, actions, dispose } = createTestStore();
    actions.setGridDimensions(2, 2);
    expect(uiState.gridColumns).toBe(2);
    expect(uiState.gridRows).toBe(2);
    dispose();
  });

  it('setSelectedAnnotation updates selected annotation ID', () => {
    const { uiState, actions, dispose } = createTestStore();
    actions.setSelectedAnnotation(dummyAnnotationId);
    expect(uiState.selectedAnnotationId).toBe(dummyAnnotationId);
    dispose();
  });

  it('setContexts updates context state', () => {
    const { contextState, actions, dispose } = createTestStore();
    const context: AnnotationContext = {
      id: dummyContextId,
      label: 'Test Context',
      tools: [],
    };
    actions.setContexts([context]);
    expect(contextState.contexts).toHaveLength(1);
    expect(contextState.contexts[0]).toEqual(context);
    dispose();
  });

  it('updateAnnotation handles non-existent annotation gracefully', () => {
    const { annotationState, actions, dispose } = createTestStore();
    // No annotation added
    actions.updateAnnotation(dummyAnnotationId, dummyImageId, { label: 'New Label' });
    // Should not crash and state should remain unchanged (or empty bucket created if implemented that way)
    expect(annotationState.byImage[dummyImageId]).toBeUndefined();
    dispose();
  });

  it('deleteAnnotation handles non-existent annotation gracefully', () => {
    const { annotationState, actions, dispose } = createTestStore();
    actions.deleteAnnotation(dummyAnnotationId, dummyImageId);
    expect(annotationState.byImage[dummyImageId]).toBeUndefined();
    dispose();
  });

  it('Constraint status handles no active context', () => {
    const { actions, constraintStatus, dispose } = createTestStore();
    actions.setActiveContext(null);
    const status = constraintStatus();
    // All tools should be disabled
    expect(status.rectangle.enabled).toBe(false);
    expect(status.circle.enabled).toBe(false);
    dispose();
  });

  describe('View Controls Actions', () => {
    it('toggleActiveImageNegative toggles the inverted state for the active cell', () => {
      const { uiState, actions, dispose } = createTestStore();
      actions.setActiveCell(0);
      actions.toggleActiveImageNegative();

      expect(uiState.cellTransforms[0]?.inverted).toBe(true);

      actions.toggleActiveImageNegative();
      expect(uiState.cellTransforms[0]?.inverted).toBe(false);
      dispose();
    });

    it('increaseActiveImageExposure increments by 0.1 and clamps to 1 for the active cell', () => {
      const { uiState, actions, dispose } = createTestStore();
      actions.setActiveCell(1);

      // Set to 0.9 first to test clamp at next step
      actions.setActiveImageExposure(0.9);
      actions.increaseActiveImageExposure();
      expect(uiState.cellTransforms[1]?.exposure).toBe(1.0);

      // Clamps to 1
      actions.increaseActiveImageExposure();
      expect(uiState.cellTransforms[1]?.exposure).toBe(1.0);

      dispose();
    });

    it('decreaseActiveImageExposure decrements by 0.1 and clamps to -1 for the active cell', () => {
      const { uiState, actions, dispose } = createTestStore();
      actions.setActiveCell(2);

      // Set to -0.9 first to test clamp at next step
      actions.setActiveImageExposure(-0.9);
      actions.decreaseActiveImageExposure();
      expect(uiState.cellTransforms[2]?.exposure).toBe(-1.0);

      // Clamps to -1
      actions.decreaseActiveImageExposure();
      expect(uiState.cellTransforms[2]?.exposure).toBe(-1.0);

      dispose();
    });

    it('setActiveImageExposure sets specific value and clamps for the active cell', () => {
      const { uiState, actions, dispose } = createTestStore();
      actions.setActiveCell(0);

      actions.setActiveImageExposure(0.5);
      expect(uiState.cellTransforms[0]?.exposure).toBe(0.5);

      actions.setActiveImageExposure(1.5);
      expect(uiState.cellTransforms[0]?.exposure).toBe(1.0);

      actions.setActiveImageExposure(-2.0);
      expect(uiState.cellTransforms[0]?.exposure).toBe(-1.0);

      dispose();
    });

    it('increaseActiveImageContrast increments by 0.1 and clamps to 1 for the active cell', () => {
      const { uiState, actions, dispose } = createTestStore();
      actions.setActiveCell(1);

      actions.setActiveImageContrast(0.9);
      actions.increaseActiveImageContrast();
      expect(uiState.cellTransforms[1]?.contrast).toBe(1.0);

      // Clamps to 1
      actions.increaseActiveImageContrast();
      expect(uiState.cellTransforms[1]?.contrast).toBe(1.0);

      dispose();
    });

    it('decreaseActiveImageContrast decrements by 0.1 and clamps to -1 for the active cell', () => {
      const { uiState, actions, dispose } = createTestStore();
      actions.setActiveCell(2);

      actions.setActiveImageContrast(-0.9);
      actions.decreaseActiveImageContrast();
      expect(uiState.cellTransforms[2]?.contrast).toBe(-1.0);

      // Clamps to -1
      actions.decreaseActiveImageContrast();
      expect(uiState.cellTransforms[2]?.contrast).toBe(-1.0);

      dispose();
    });

    it('setActiveImageContrast sets specific value and clamps for the active cell', () => {
      const { uiState, actions, dispose } = createTestStore();
      actions.setActiveCell(0);

      actions.setActiveImageContrast(0.5);
      expect(uiState.cellTransforms[0]?.contrast).toBe(0.5);

      actions.setActiveImageContrast(1.5);
      expect(uiState.cellTransforms[0]?.contrast).toBe(1.0);

      actions.setActiveImageContrast(-2.0);
      expect(uiState.cellTransforms[0]?.contrast).toBe(-1.0);

      dispose();
    });

    it('contrast and exposure adjust independently for the same cell', () => {
      const { uiState, actions, dispose } = createTestStore();
      actions.setActiveCell(0);

      actions.setActiveImageExposure(0.3);
      actions.setActiveImageContrast(-0.4);

      expect(uiState.cellTransforms[0]?.exposure).toBe(0.3);
      expect(uiState.cellTransforms[0]?.contrast).toBe(-0.4);

      dispose();
    });

    it('resetActiveImageView resets active cell transforms but leaves other cells alone', () => {
      const { uiState, actions, dispose } = createTestStore();

      // Set transforms for cell 0
      actions.setActiveCell(0);
      actions.toggleActiveImageNegative();
      actions.setActiveImageExposure(0.5);

      // Set transforms for cell 1
      actions.setActiveCell(1);
      actions.toggleActiveImageNegative();
      actions.setActiveImageExposure(-0.3);

      // Reset cell 1
      actions.resetActiveImageView();

      expect(uiState.cellTransforms[1]?.exposure).toBe(0);
      expect(uiState.cellTransforms[1]?.inverted).toBe(false);

      // Cell 0 should be untouched
      expect(uiState.cellTransforms[0]?.exposure).toBe(0.5);
      expect(uiState.cellTransforms[0]?.inverted).toBe(true);

      dispose();
    });

    it('setGridDimensions prunes stale cell transforms', () => {
      const { uiState, actions, dispose } = createTestStore();

      // Setup transforms for indices 0, 1, 2 (2x2 grid has indices 0-3)
      actions.setGridDimensions(2, 2);
      actions.setActiveCell(0);
      actions.toggleActiveImageNegative();
      actions.setActiveCell(1);
      actions.toggleActiveImageNegative();
      actions.setActiveCell(2);
      actions.toggleActiveImageNegative();

      expect(Object.keys(uiState.cellTransforms)).toHaveLength(3);

      // Shrink to 1x1 (index 0 only)
      actions.setGridDimensions(1, 1);

      expect(Object.keys(uiState.cellTransforms)).toHaveLength(1);
      expect(uiState.cellTransforms[0]).toBeDefined();
      expect(uiState.cellTransforms[1]).toBeUndefined();
      expect(uiState.cellTransforms[2]).toBeUndefined();

      dispose();
    });

    it('assignImageToCell resets transforms for that cell', () => {
      const { uiState, actions, dispose } = createTestStore();
      const img1 = createImageId('img1');
      const img2 = createImageId('img2');

      actions.setActiveCell(0);
      actions.assignImageToCell(0, img1);
      actions.toggleActiveImageNegative();
      actions.setActiveImageExposure(0.8);

      expect(uiState.cellTransforms[0]?.inverted).toBe(true);
      expect(uiState.cellTransforms[0]?.exposure).toBe(0.8);

      // Reassign cell 0 to img2
      actions.assignImageToCell(0, img2);

      expect(uiState.cellTransforms[0]?.inverted).toBe(false);
      expect(uiState.cellTransforms[0]?.exposure).toBe(0);

      dispose();
    });
  });

  describe('Displayed Contexts Actions', () => {
    const ctxId2 = createAnnotationContextId('ctx2');
    const ctxId3 = createAnnotationContextId('ctx3');

    it('initial state has empty displayedContextIds', () => {
      const { contextState, dispose } = createTestStore();
      expect(contextState.displayedContextIds).toEqual([]);
      dispose();
    });

    it('setDisplayedContexts sets displayed context IDs', () => {
      const { contextState, actions, dispose } = createTestStore();
      actions.setDisplayedContexts([dummyContextId, ctxId2]);
      expect(contextState.displayedContextIds).toEqual([dummyContextId, ctxId2]);
      dispose();
    });

    it('setDisplayedContexts replaces previous IDs', () => {
      const { contextState, actions, dispose } = createTestStore();
      actions.setDisplayedContexts([dummyContextId]);
      actions.setDisplayedContexts([ctxId2, ctxId3]);
      expect(contextState.displayedContextIds).toEqual([ctxId2, ctxId3]);
      dispose();
    });

    it('setDisplayedContexts clears with empty array', () => {
      const { contextState, actions, dispose } = createTestStore();
      actions.setDisplayedContexts([dummyContextId]);
      actions.setDisplayedContexts([]);
      expect(contextState.displayedContextIds).toEqual([]);
      dispose();
    });

    it('displayed contexts are independent of active context', () => {
      const { contextState, actions, dispose } = createTestStore();

      const ctx1: AnnotationContext = { id: dummyContextId, label: 'Ctx 1', tools: [] };
      const ctx2: AnnotationContext = { id: ctxId2, label: 'Ctx 2', tools: [] };
      actions.setContexts([ctx1, ctx2]);

      actions.setActiveContext(dummyContextId);
      actions.setDisplayedContexts([ctxId2]);

      // Changing active context should not affect displayedContextIds
      actions.setActiveContext(ctxId2);
      expect(contextState.displayedContextIds).toEqual([ctxId2]);
      expect(contextState.activeContextId).toBe(ctxId2);

      dispose();
    });

    it('constraint status unaffected by displayed contexts', () => {
      const { actions, constraintStatus, dispose } = createTestStore();

      const ctx1: AnnotationContext = {
        id: dummyContextId,
        label: 'Ctx 1',
        tools: [{ type: 'rectangle', maxCount: 1 }],
      };
      const ctx2: AnnotationContext = {
        id: ctxId2,
        label: 'Ctx 2',
        tools: [{ type: 'circle' }],
      };
      actions.setContexts([ctx1, ctx2]);
      actions.setActiveContext(dummyContextId);

      // Display ctx2 as well
      actions.setDisplayedContexts([ctxId2]);

      // Constraint status should still only reflect active context (ctx1)
      const status = constraintStatus();
      expect(status.rectangle.enabled).toBe(true);
      expect(status.rectangle.currentCount).toBe(0);
      // Circle is not in the active context's tools, so it should be disabled
      expect(status.circle.enabled).toBe(false);

      dispose();
    });
  });
});
