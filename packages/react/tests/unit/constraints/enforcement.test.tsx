import { describe, it, expect, afterEach, vi } from 'vitest';
import { createAnnotationId } from '@osdlabel/annotation';
import { createImageId, type ImageId } from '@osdlabel/viewer-api';
import { createAnnotationContextId, type AnnotationContext } from '@osdlabel/annotation-context';
import type { ConstraintStatus } from 'osdlabel';
import { useConstraints } from '../../../src/hooks/useConstraints.js';
import { renderAnnotator, type AnnotatorHarness } from '../render-annotator.js';
import { unmountAll } from '../mount.js';
import { imageId, type NewAnnotation, rect } from '../fixtures.js';

/**
 * The React counterpart of Solid's `constraints/enforcement.test.ts`.
 *
 * Solid derives the status with `createMemo`; React with a `useMemo` over
 * `[contextState, annotationState, activeImageId]`, where `activeImageId` is
 * itself a memo over `[gridAssignments, activeCellIndex]`. These tests read
 * the status from the provider's context value after each committed action,
 * so a missing dependency shows up as a stale status.
 */
describe('Constraint Enforcement', () => {
  afterEach(unmountAll);

  function createTestStore(initialImageId: ImageId = imageId): AnnotatorHarness {
    const h = renderAnnotator();
    h.run((a) => a.assignImageToCell(0, initialImageId));
    return h;
  }

  const status = (h: AnnotatorHarness): ConstraintStatus => h.current.constraintStatus;

  const contextId1 = createAnnotationContextId('ctx1');
  const contextId2 = createAnnotationContextId('ctx2');
  const imageId2 = createImageId('img2');
  const imageId3 = createImageId('img3');

  const context1: AnnotationContext = {
    id: contextId1,
    label: 'Context 1',
    tools: [{ type: 'rectangle', maxCount: 2 }, { type: 'circle' }],
  };

  const context2: AnnotationContext = {
    id: contextId2,
    label: 'Context 2',
    tools: [
      { type: 'line', maxCount: 1 },
      { type: 'polyline', maxCount: 3 },
    ],
  };

  function activate(h: AnnotatorHarness, contexts: AnnotationContext[], active = contextId1) {
    h.run((a) => {
      a.setContexts(contexts);
      a.setActiveContext(active);
    });
  }

  const add = (h: AnnotatorHarness, annotation: NewAnnotation) =>
    h.run((a) => a.addAnnotation(annotation));

  function line(id: string, contextId = contextId2): NewAnnotation {
    return {
      ...rect(id, { contextId }),
      toolType: 'line',
      geometry: { type: 'line', start: { x: 0, y: 0 }, end: { x: 10, y: 10 } },
    };
  }

  function circleAt(i: number): NewAnnotation {
    return {
      ...rect(`c${i}`, { contextId: contextId1 }),
      toolType: 'circle',
      geometry: { type: 'circle', center: { x: i * 10, y: 0 }, radius: 5 },
    };
  }

  it('should disable tool when maxCount is reached', () => {
    const h = createTestStore();
    activate(h, [context1]);

    expect(status(h).rectangle.enabled).toBe(true);
    expect(status(h).rectangle.currentCount).toBe(0);
    expect(status(h).rectangle.maxCount).toBe(2);

    add(h, rect('r1', { contextId: contextId1 }));
    expect(status(h).rectangle.enabled).toBe(true);
    expect(status(h).rectangle.currentCount).toBe(1);

    add(h, rect('r2', { contextId: contextId1 }));
    expect(status(h).rectangle.enabled).toBe(false);
    expect(status(h).rectangle.currentCount).toBe(2);
  });

  it('should re-enable tool when annotation is deleted', () => {
    const h = createTestStore();
    activate(h, [context1]);
    add(h, rect('r1', { contextId: contextId1 }));
    add(h, rect('r2', { contextId: contextId1 }));
    expect(status(h).rectangle.enabled).toBe(false);

    h.run((a) => a.deleteAnnotation(createAnnotationId('r1'), imageId));

    expect(status(h).rectangle.enabled).toBe(true);
    expect(status(h).rectangle.currentCount).toBe(1);
  });

  it('should update tool availability when switching contexts', () => {
    const h = createTestStore();
    activate(h, [context1, context2]);

    expect(status(h).rectangle.enabled).toBe(true);
    expect(status(h).circle.enabled).toBe(true);
    expect(status(h).line.enabled).toBe(false);
    expect(status(h).polyline.enabled).toBe(false);

    h.run((a) => a.setActiveContext(contextId2));

    expect(status(h).line.enabled).toBe(true);
    expect(status(h).polyline.enabled).toBe(true);
    expect(status(h).rectangle.enabled).toBe(false);
    expect(status(h).circle.enabled).toBe(false);
  });

  it('should never disable unlimited tools (no maxCount)', () => {
    const h = createTestStore();
    activate(h, [context1]);
    expect(status(h).circle.enabled).toBe(true);
    expect(status(h).circle.maxCount).toBeNull();

    // One commit for all of them: addAnnotation reads only the context state,
    // which this batch does not change.
    h.run((a) => {
      for (let i = 0; i < 100; i++) a.addAnnotation(circleAt(i));
    });

    expect(status(h).circle.enabled).toBe(true);
    expect(status(h).circle.currentCount).toBe(100);
  });

  it('should disable all tools when no context is active', () => {
    const h = createTestStore();
    h.run((a) => {
      a.setContexts([context1]);
      a.setActiveContext(null);
    });

    const s = status(h);
    expect(s.rectangle.enabled).toBe(false);
    expect(s.circle.enabled).toBe(false);
    expect(s.line.enabled).toBe(false);
    expect(s.point.enabled).toBe(false);
    expect(s.polyline.enabled).toBe(false);
  });

  it('should count annotations per-context correctly', () => {
    const h = createTestStore();
    activate(h, [context1, context2]);
    add(h, rect('r1', { contextId: contextId1 }));
    add(h, line('l1'));

    expect(status(h).rectangle.currentCount).toBe(1);

    h.run((a) => a.setActiveContext(contextId2));
    expect(status(h).line.currentCount).toBe(1);
    expect(status(h).line.maxCount).toBe(1);
    expect(status(h).line.enabled).toBe(false);
  });

  it('should gate tool creation via canAddAnnotation callback pattern', () => {
    const h = createTestStore();
    activate(h, [context2], contextId2);
    const canAddLine = () => status(h).line.enabled;

    expect(canAddLine()).toBe(true);
    add(h, line('l1'));
    expect(canAddLine()).toBe(false);
  });

  // ── Context Scoping Tests ──────────────────────────────────────────────

  it('should disable all tools when context is not scoped to current image', () => {
    const h = createTestStore();
    activate(h, [
      {
        id: contextId1,
        label: 'Scoped Context',
        imageIds: [imageId2],
        tools: [{ type: 'rectangle' }, { type: 'circle' }],
      },
    ]);
    expect(status(h).rectangle.enabled).toBe(false);
    expect(status(h).circle.enabled).toBe(false);
  });

  it('should enable tools when context is scoped to current image', () => {
    const h = createTestStore();
    activate(h, [
      {
        id: contextId1,
        label: 'Scoped Context',
        imageIds: [imageId, imageId2],
        tools: [{ type: 'rectangle' }, { type: 'circle' }],
      },
    ]);
    expect(status(h).rectangle.enabled).toBe(true);
    expect(status(h).circle.enabled).toBe(true);
  });

  it('should disable all tools when imageIds is empty array', () => {
    const h = createTestStore();
    activate(h, [
      { id: contextId1, label: 'Empty Scope', imageIds: [], tools: [{ type: 'rectangle' }] },
    ]);
    expect(status(h).rectangle.enabled).toBe(false);
  });

  it('should behave as before when imageIds is undefined (all images)', () => {
    const h = createTestStore();
    activate(h, [context1]);
    expect(status(h).rectangle.enabled).toBe(true);
    expect(status(h).circle.enabled).toBe(true);
  });

  it('should count per-image when countScope is per-image', () => {
    const h = createTestStore();
    activate(h, [
      {
        id: contextId1,
        label: 'Per-Image',
        tools: [{ type: 'rectangle', maxCount: 1, countScope: 'per-image' }],
      },
    ]);

    add(h, rect('r1', { contextId: contextId1 }));
    expect(status(h).rectangle.currentCount).toBe(1);
    expect(status(h).rectangle.enabled).toBe(false);

    add(h, rect('r2', { contextId: contextId1, imageId: imageId2 }));
    expect(status(h).rectangle.currentCount).toBe(1);
    expect(status(h).rectangle.enabled).toBe(false);
  });

  it('should count globally across scoped images when countScope is global with imageIds', () => {
    const h = createTestStore();
    activate(h, [
      {
        id: contextId1,
        label: 'Global Scoped',
        imageIds: [imageId, imageId2],
        tools: [{ type: 'rectangle', maxCount: 2, countScope: 'global' }],
      },
    ]);

    add(h, rect('r1', { contextId: contextId1 }));
    add(h, rect('r2', { contextId: contextId1, imageId: imageId2 }));
    expect(status(h).rectangle.currentCount).toBe(2);
    expect(status(h).rectangle.enabled).toBe(false);

    // img3 is out of scope; the scope guard refuses it and it is not counted.
    add(h, rect('r3', { contextId: contextId1, imageId: imageId3 }));
    expect(status(h).rectangle.currentCount).toBe(2);
  });

  it('should block addAnnotation on out-of-scope image', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const h = createTestStore();
    activate(h, [
      { id: contextId1, label: 'Scoped', imageIds: [imageId], tools: [{ type: 'rectangle' }] },
    ]);

    add(h, rect('r1', { contextId: contextId1, imageId: imageId2 }));

    expect(h.current.annotationState.byImage[imageId2]).toBeUndefined();
    warn.mockRestore();
  });

  // ── React-specific: the memo's inputs ──────────────────────────────────

  describe('derivation follows every input of the memo', () => {
    const perImage: AnnotationContext = {
      id: contextId1,
      label: 'Per-Image',
      tools: [{ type: 'rectangle', maxCount: 1, countScope: 'per-image' }],
    };

    it('recomputes when the active cell moves to another image', () => {
      // `activeImageId` is derived from `activeCellIndex` + `gridAssignments`;
      // a per-image count is the only status that reads it.
      const h = createTestStore();
      h.run((a) => {
        a.setGridDimensions(2, 1);
        a.assignImageToCell(1, imageId2);
      });
      activate(h, [perImage]);
      add(h, rect('r1', { contextId: contextId1 }));
      expect(status(h).rectangle.enabled).toBe(false);

      h.run((a) => a.setActiveCell(1));

      expect(status(h).rectangle.currentCount).toBe(0);
      expect(status(h).rectangle.enabled).toBe(true);
    });

    it('recomputes when the active cell is given a different image', () => {
      const h = createTestStore();
      activate(h, [perImage]);
      add(h, rect('r1', { contextId: contextId1 }));
      expect(status(h).rectangle.enabled).toBe(false);

      h.run((a) => a.assignImageToCell(0, imageId2));

      expect(status(h).rectangle.enabled).toBe(true);
    });

    it('keeps the same status object across unrelated UI updates', () => {
      // `constraintStatus` feeds the auto-switch effect in useAnnotationTool
      // and useKeyboard's handler, so it should only change when its inputs do.
      const h = createTestStore();
      activate(h, [context1]);
      const before = status(h);

      h.run((a) => a.setActiveTool('rectangle'));
      h.run((a) => a.rotateActiveImageCW());

      expect(status(h)).toBe(before);
    });
  });

  describe('onConstraintChange', () => {
    it('reports each change, but not the initial status', () => {
      const onConstraintChange = vi.fn();
      const h = renderAnnotator({ onConstraintChange });
      expect(onConstraintChange).not.toHaveBeenCalled();

      h.run((a) => {
        a.assignImageToCell(0, imageId);
        a.setContexts([context1]);
        a.setActiveContext(contextId1);
      });
      expect(onConstraintChange).toHaveBeenCalledTimes(1);
      expect(onConstraintChange).toHaveBeenLastCalledWith(h.current.constraintStatus);

      add(h, rect('r1', { contextId: contextId1 }));
      expect(onConstraintChange).toHaveBeenCalledTimes(2);
      expect(onConstraintChange.mock.calls[1]![0].rectangle.currentCount).toBe(1);
    });
  });

  describe('useConstraints', () => {
    function Probe({ onRender }: { readonly onRender: (enabled: boolean) => void }) {
      const { isToolEnabled, canAddAnnotation } = useConstraints();
      // The two are documented as the same predicate.
      expect(canAddAnnotation('rectangle')).toBe(isToolEnabled('rectangle'));
      onRender(isToolEnabled('rectangle'));
      return null;
    }

    it('reads the provider’s current status', () => {
      const seen: boolean[] = [];
      const h = renderAnnotator({}, <Probe onRender={(e) => seen.push(e)} />);
      h.run((a) => {
        a.assignImageToCell(0, imageId);
        a.setContexts([
          { id: contextId1, label: 'One', tools: [{ type: 'rectangle', maxCount: 1 }] },
        ]);
        a.setActiveContext(contextId1);
      });
      expect(seen.at(-1)).toBe(true);

      add(h, rect('r1', { contextId: contextId1 }));

      expect(seen.at(-1)).toBe(false);
    });
  });
});
