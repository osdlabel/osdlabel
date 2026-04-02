import { describe, it, expect } from 'vitest';
import { version as FABRIC_VERSION } from 'fabric';
import { createRoot } from 'solid-js';
import { createAnnotationStore } from '../../../src/state/annotation-store';
import { createUIStore } from '../../../src/state/ui-store';
import { createContextStore, createConstraintStatus } from '../../../src/state/context-store';
import { createActions } from '../../../src/state/actions';
import { createAnnotationId, createImageId } from '@osdlabel/annotation';
import type { ImageId } from '@osdlabel/annotation';
import { createAnnotationContextId } from '@osdlabel/annotation-context';
import type { AnnotationContext } from '@osdlabel/annotation-context';

describe('Constraint Enforcement', () => {
  function createTestStore(initialImageId: ImageId = imageId) {
    return createRoot((dispose) => {
      const { state: annotationState, setState: setAnnotationState } = createAnnotationStore();
      const { state: uiState, setState: setUIState } = createUIStore();
      const { state: contextState, setState: setContextState } = createContextStore();

      const actions = createActions(setAnnotationState, setUIState, setContextState, contextState);
      // Assign image to cell 0 so constraint status has a currentImageId
      setUIState('gridAssignments', 0, initialImageId);
      const activeImageId = () => uiState.gridAssignments[uiState.activeCellIndex];
      const constraintStatus = createConstraintStatus(contextState, annotationState, activeImageId);

      return { annotationState, uiState, contextState, actions, constraintStatus, dispose };
    });
  }

  const imageId = createImageId('img1');
  const contextId1 = createAnnotationContextId('ctx1');
  const contextId2 = createAnnotationContextId('ctx2');

  const context1: AnnotationContext = {
    id: contextId1,
    label: 'Context 1',
    tools: [
      { type: 'rectangle', maxCount: 2 },
      { type: 'circle' }, // unlimited
    ],
  };

  const context2: AnnotationContext = {
    id: contextId2,
    label: 'Context 2',
    tools: [
      { type: 'line', maxCount: 1 },
      { type: 'polyline', maxCount: 3 },
    ],
  };

  const baseRawData = {
    format: 'fabric' as const,
    fabricVersion: FABRIC_VERSION,
    data: { type: 'Rect', stroke: 'red', strokeWidth: 1, fill: 'transparent', opacity: 1 },
  };

  it('should disable tool when maxCount is reached', () => {
    const { actions, constraintStatus, dispose } = createTestStore();

    actions.setContexts([context1]);
    actions.setActiveContext(contextId1);

    // Initially enabled
    let status = constraintStatus();
    expect(status.rectangle.enabled).toBe(true);
    expect(status.rectangle.currentCount).toBe(0);
    expect(status.rectangle.maxCount).toBe(2);

    // Add first rectangle
    actions.addAnnotation({
      id: createAnnotationId('r1'),
      imageId,
      contextId: contextId1,
      toolType: 'rectangle',
      geometry: { type: 'rectangle', origin: { x: 0, y: 0 }, width: 10, height: 10, rotation: 0 },
      rawAnnotationData: baseRawData,
    });

    status = constraintStatus();
    expect(status.rectangle.enabled).toBe(true);
    expect(status.rectangle.currentCount).toBe(1);

    // Add second rectangle — reaches limit
    actions.addAnnotation({
      id: createAnnotationId('r2'),
      imageId,
      contextId: contextId1,
      toolType: 'rectangle',
      geometry: { type: 'rectangle', origin: { x: 20, y: 20 }, width: 10, height: 10, rotation: 0 },
      rawAnnotationData: baseRawData,
    });

    status = constraintStatus();
    expect(status.rectangle.enabled).toBe(false);
    expect(status.rectangle.currentCount).toBe(2);

    dispose();
  });

  it('should re-enable tool when annotation is deleted', () => {
    const { actions, constraintStatus, dispose } = createTestStore();

    actions.setContexts([context1]);
    actions.setActiveContext(contextId1);

    // Add 2 rectangles
    actions.addAnnotation({
      id: createAnnotationId('r1'),
      imageId,
      contextId: contextId1,
      toolType: 'rectangle',
      geometry: { type: 'rectangle', origin: { x: 0, y: 0 }, width: 10, height: 10, rotation: 0 },
      rawAnnotationData: baseRawData,
    });
    actions.addAnnotation({
      id: createAnnotationId('r2'),
      imageId,
      contextId: contextId1,
      toolType: 'rectangle',
      geometry: { type: 'rectangle', origin: { x: 20, y: 20 }, width: 10, height: 10, rotation: 0 },
      rawAnnotationData: baseRawData,
    });

    let status = constraintStatus();
    expect(status.rectangle.enabled).toBe(false);

    // Delete one
    actions.deleteAnnotation(createAnnotationId('r1'), imageId);

    status = constraintStatus();
    expect(status.rectangle.enabled).toBe(true);
    expect(status.rectangle.currentCount).toBe(1);

    dispose();
  });

  it('should update tool availability when switching contexts', () => {
    const { actions, constraintStatus, dispose } = createTestStore();

    actions.setContexts([context1, context2]);
    actions.setActiveContext(contextId1);

    let status = constraintStatus();
    // Context 1 has rectangle and circle
    expect(status.rectangle.enabled).toBe(true);
    expect(status.circle.enabled).toBe(true);
    // Context 1 does NOT have line or path
    expect(status.line.enabled).toBe(false);
    expect(status.polyline.enabled).toBe(false);

    // Switch to context 2
    actions.setActiveContext(contextId2);

    status = constraintStatus();
    // Context 2 has line and path
    expect(status.line.enabled).toBe(true);
    expect(status.polyline.enabled).toBe(true);
    // Context 2 does NOT have rectangle or circle
    expect(status.rectangle.enabled).toBe(false);
    expect(status.circle.enabled).toBe(false);

    dispose();
  });

  it('should never disable unlimited tools (no maxCount)', () => {
    const { actions, constraintStatus, dispose } = createTestStore();

    actions.setContexts([context1]);
    actions.setActiveContext(contextId1);

    // Circle is unlimited
    let status = constraintStatus();
    expect(status.circle.enabled).toBe(true);
    expect(status.circle.maxCount).toBeNull();

    // Add many circles
    for (let i = 0; i < 100; i++) {
      actions.addAnnotation({
        id: createAnnotationId(`c${i}`),
        imageId,
        contextId: contextId1,
        toolType: 'circle',
        geometry: { type: 'circle', center: { x: i * 10, y: 0 }, radius: 5 },
        rawAnnotationData: baseRawData,
      });
    }

    status = constraintStatus();
    expect(status.circle.enabled).toBe(true);
    expect(status.circle.currentCount).toBe(100);

    dispose();
  });

  it('should disable all tools when no context is active', () => {
    const { actions, constraintStatus, dispose } = createTestStore();

    actions.setContexts([context1]);
    actions.setActiveContext(null);

    const status = constraintStatus();
    expect(status.rectangle.enabled).toBe(false);
    expect(status.circle.enabled).toBe(false);
    expect(status.line.enabled).toBe(false);
    expect(status.point.enabled).toBe(false);
    expect(status.polyline.enabled).toBe(false);

    dispose();
  });

  it('should count annotations per-context correctly', () => {
    const { actions, constraintStatus, dispose } = createTestStore();

    actions.setContexts([context1, context2]);
    actions.setActiveContext(contextId1);

    // Add a rectangle in context1
    actions.addAnnotation({
      id: createAnnotationId('r1'),
      imageId,
      contextId: contextId1,
      toolType: 'rectangle',
      geometry: { type: 'rectangle', origin: { x: 0, y: 0 }, width: 10, height: 10, rotation: 0 },
      rawAnnotationData: baseRawData,
    });

    // Add a line in context2 (should not affect context1's counts)
    actions.addAnnotation({
      id: createAnnotationId('l1'),
      imageId,
      contextId: contextId2,
      toolType: 'line',
      geometry: { type: 'line', start: { x: 0, y: 0 }, end: { x: 10, y: 10 } },
      rawAnnotationData: baseRawData,
    });

    let status = constraintStatus();
    expect(status.rectangle.currentCount).toBe(1);

    // Switch to context2
    actions.setActiveContext(contextId2);
    status = constraintStatus();
    expect(status.line.currentCount).toBe(1);
    expect(status.line.maxCount).toBe(1);
    expect(status.line.enabled).toBe(false);

    dispose();
  });

  it('should gate tool creation via canAddAnnotation callback pattern', () => {
    const { actions, constraintStatus, dispose } = createTestStore();

    actions.setContexts([context2]);
    actions.setActiveContext(contextId2);

    // Simulate the canAddAnnotation check that tools perform
    const canAddLine = () => constraintStatus().line.enabled;

    expect(canAddLine()).toBe(true);

    // Add 1 line (max is 1)
    actions.addAnnotation({
      id: createAnnotationId('l1'),
      imageId,
      contextId: contextId2,
      toolType: 'line',
      geometry: { type: 'line', start: { x: 0, y: 0 }, end: { x: 10, y: 10 } },
      rawAnnotationData: baseRawData,
    });

    expect(canAddLine()).toBe(false);

    dispose();
  });

  // ── Context Scoping Tests ──────────────────────────────────────────────

  const imageId2 = createImageId('img2');
  const imageId3 = createImageId('img3');

  it('should disable all tools when context is not scoped to current image', () => {
    const { actions, constraintStatus, dispose } = createTestStore();

    const scopedContext: AnnotationContext = {
      id: contextId1,
      label: 'Scoped Context',
      imageIds: [imageId2], // only img2, not img1
      tools: [{ type: 'rectangle' }, { type: 'circle' }],
    };

    actions.setContexts([scopedContext]);
    actions.setActiveContext(contextId1);

    const status = constraintStatus();
    expect(status.rectangle.enabled).toBe(false);
    expect(status.circle.enabled).toBe(false);

    dispose();
  });

  it('should enable tools when context is scoped to current image', () => {
    const { actions, constraintStatus, dispose } = createTestStore();

    const scopedContext: AnnotationContext = {
      id: contextId1,
      label: 'Scoped Context',
      imageIds: [imageId, imageId2],
      tools: [{ type: 'rectangle' }, { type: 'circle' }],
    };

    actions.setContexts([scopedContext]);
    actions.setActiveContext(contextId1);

    const status = constraintStatus();
    expect(status.rectangle.enabled).toBe(true);
    expect(status.circle.enabled).toBe(true);

    dispose();
  });

  it('should disable all tools when imageIds is empty array', () => {
    const { actions, constraintStatus, dispose } = createTestStore();

    const emptyContext: AnnotationContext = {
      id: contextId1,
      label: 'Empty Scope',
      imageIds: [],
      tools: [{ type: 'rectangle' }],
    };

    actions.setContexts([emptyContext]);
    actions.setActiveContext(contextId1);

    const status = constraintStatus();
    expect(status.rectangle.enabled).toBe(false);

    dispose();
  });

  it('should behave as before when imageIds is undefined (all images)', () => {
    const { actions, constraintStatus, dispose } = createTestStore();

    // context1 has no imageIds — backward compatible
    actions.setContexts([context1]);
    actions.setActiveContext(contextId1);

    const status = constraintStatus();
    expect(status.rectangle.enabled).toBe(true);
    expect(status.circle.enabled).toBe(true);

    dispose();
  });

  it('should count per-image when countScope is per-image', () => {
    const { actions, constraintStatus, dispose } = createTestStore();

    const perImageContext: AnnotationContext = {
      id: contextId1,
      label: 'Per-Image',
      tools: [{ type: 'rectangle', maxCount: 1, countScope: 'per-image' }],
    };

    actions.setContexts([perImageContext]);
    actions.setActiveContext(contextId1);

    // Add rectangle on img1 (current image)
    actions.addAnnotation({
      id: createAnnotationId('r1'),
      imageId,
      contextId: contextId1,
      toolType: 'rectangle',
      geometry: { type: 'rectangle', origin: { x: 0, y: 0 }, width: 10, height: 10, rotation: 0 },
      rawAnnotationData: baseRawData,
    });

    let status = constraintStatus();
    expect(status.rectangle.currentCount).toBe(1);
    expect(status.rectangle.enabled).toBe(false); // maxCount 1 reached on current image

    // Add rectangle on img2 (different image) — should not affect img1's count
    actions.addAnnotation({
      id: createAnnotationId('r2'),
      imageId: imageId2,
      contextId: contextId1,
      toolType: 'rectangle',
      geometry: { type: 'rectangle', origin: { x: 0, y: 0 }, width: 10, height: 10, rotation: 0 },
      rawAnnotationData: baseRawData,
    });

    // Still on img1 — count should still be 1 (per-image)
    status = constraintStatus();
    expect(status.rectangle.currentCount).toBe(1);
    expect(status.rectangle.enabled).toBe(false);

    dispose();
  });

  it('should count globally across scoped images when countScope is global with imageIds', () => {
    const { actions, constraintStatus, dispose } = createTestStore();

    const globalScopedContext: AnnotationContext = {
      id: contextId1,
      label: 'Global Scoped',
      imageIds: [imageId, imageId2],
      tools: [{ type: 'rectangle', maxCount: 2, countScope: 'global' }],
    };

    actions.setContexts([globalScopedContext]);
    actions.setActiveContext(contextId1);

    // Add rectangle on img1
    actions.addAnnotation({
      id: createAnnotationId('r1'),
      imageId,
      contextId: contextId1,
      toolType: 'rectangle',
      geometry: { type: 'rectangle', origin: { x: 0, y: 0 }, width: 10, height: 10, rotation: 0 },
      rawAnnotationData: baseRawData,
    });

    // Add rectangle on img2
    actions.addAnnotation({
      id: createAnnotationId('r2'),
      imageId: imageId2,
      contextId: contextId1,
      toolType: 'rectangle',
      geometry: { type: 'rectangle', origin: { x: 0, y: 0 }, width: 10, height: 10, rotation: 0 },
      rawAnnotationData: baseRawData,
    });

    // Global count should be 2 (across scoped images)
    const status = constraintStatus();
    expect(status.rectangle.currentCount).toBe(2);
    expect(status.rectangle.enabled).toBe(false);

    // Add rectangle on img3 (out of scope) — should not be counted
    actions.addAnnotation({
      id: createAnnotationId('r3'),
      imageId: imageId3,
      contextId: contextId1,
      toolType: 'rectangle',
      geometry: { type: 'rectangle', origin: { x: 0, y: 0 }, width: 10, height: 10, rotation: 0 },
      rawAnnotationData: baseRawData,
    });

    // Count should still be 2 (img3 not in scoped images)
    const status2 = constraintStatus();
    expect(status2.rectangle.currentCount).toBe(2);

    dispose();
  });

  it('should block addAnnotation on out-of-scope image', () => {
    const { actions, annotationState, dispose } = createTestStore();

    const scopedContext: AnnotationContext = {
      id: contextId1,
      label: 'Scoped',
      imageIds: [imageId], // only img1
      tools: [{ type: 'rectangle' }],
    };

    actions.setContexts([scopedContext]);
    actions.setActiveContext(contextId1);

    // Try to add annotation on img2 (out of scope)
    actions.addAnnotation({
      id: createAnnotationId('r1'),
      imageId: imageId2,
      contextId: contextId1,
      toolType: 'rectangle',
      geometry: { type: 'rectangle', origin: { x: 0, y: 0 }, width: 10, height: 10, rotation: 0 },
      rawAnnotationData: baseRawData,
    });

    // Annotation should not have been added
    expect(annotationState.byImage[imageId2]).toBeUndefined();

    dispose();
  });
});
