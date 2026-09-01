import { describe, it, expect, afterEach, vi } from 'vitest';
import { createAnnotationId } from '@osdlabel/annotation';
import { createImageId } from '@osdlabel/viewer-api';
import { createAnnotationContextId, type AnnotationContext } from '@osdlabel/annotation-context';
import { renderAnnotator, type AnnotatorHarness } from '../render-annotator.js';
import { unmountAll } from '../mount.js';
import { circle, contextId, imageId, rect } from '../fixtures.js';

/**
 * The React counterpart of `packages/solid/tests/unit/state/actions.test.ts`.
 *
 * It drives a real `AnnotatorProvider` rather than calling `createActions` on
 * hand-wired stores: in React the actions read state through
 * `getAnnotationState()` / `getContextState()` / `getUIState()`, which read the
 * provider's external store, while components see the snapshot React last
 * rendered. That split is the part the Solid suite cannot cover, and the part
 * these tests exist for — in particular that an action sees a write made
 * earlier in the same batch, before any render (#217).
 */
describe('State Management', () => {
  afterEach(unmountAll);

  function createTestStore(): AnnotatorHarness {
    const h = renderAnnotator();
    h.run((a) => {
      // Assign image to cell 0 so constraint status has a currentImageId.
      a.assignImageToCell(0, imageId);
      // Size the grid to match what these tests exercise: `SET_ACTIVE_CELL`
      // clamps into the grid that exists, and cells 1 and 2 are used below.
      a.setGridDimensions(3, 1);
    });
    return h;
  }

  const annId = createAnnotationId('ann1');
  const dummyAnnotation = rect('ann1');

  it('addAnnotation adds to the correct image bucket and sets timestamps', () => {
    const h = createTestStore();
    h.run((a) => a.addAnnotation(dummyAnnotation));

    const imgAnns = h.current.annotationState.byImage[imageId];
    expect(imgAnns).toBeDefined();
    const ann = imgAnns![annId];
    expect(ann).toBeDefined();
    expect(ann!.id).toBe(annId);
    expect(ann!.createdAt).not.toBe('');
    expect(ann!.updatedAt).not.toBe('');
  });

  it('updateAnnotation updates the annotation and sets updatedAt', () => {
    const h = createTestStore();
    h.run((a) => a.addAnnotation(dummyAnnotation));
    h.run((a) => a.updateAnnotation(annId, imageId, { label: 'Updated Label' }));

    const updated = h.current.annotationState.byImage[imageId]![annId];
    expect(updated).toBeDefined();
    expect(updated!.label).toBe('Updated Label');
    expect(updated!.updatedAt).not.toBe('');
  });

  it('deleteAnnotation removes the annotation', () => {
    const h = createTestStore();
    h.run((a) => a.addAnnotation(dummyAnnotation));
    h.run((a) => a.deleteAnnotation(annId, imageId));

    // DELETE_ANNOTATION empties the bucket but never removes it.
    const imgAnns = h.current.annotationState.byImage[imageId];
    expect(imgAnns).toBeDefined();
    expect(imgAnns![annId]).toBeUndefined();
  });

  it('setActiveTool updates UI state', () => {
    const h = createTestStore();
    h.run((a) => a.setActiveTool('circle'));
    expect(h.current.uiState.activeTool).toBe('circle');
  });

  it('Constraint logic correctly enables/disables tools', () => {
    const h = createTestStore();
    const context: AnnotationContext = {
      id: contextId,
      label: 'Test Context',
      tools: [{ type: 'rectangle', maxCount: 1 }, { type: 'circle' }],
    };
    h.run((a) => {
      a.setContexts([context]);
      a.setActiveContext(contextId);
    });

    let status = h.current.constraintStatus;
    expect(status.rectangle.enabled).toBe(true);
    expect(status.rectangle.currentCount).toBe(0);
    expect(status.circle.enabled).toBe(true);

    h.run((a) => a.addAnnotation(rect('rect1')));
    status = h.current.constraintStatus;
    expect(status.rectangle.currentCount).toBe(1);
    expect(status.rectangle.enabled).toBe(false);
    expect(status.circle.enabled).toBe(true);

    h.run((a) => a.deleteAnnotation(createAnnotationId('rect1'), imageId));
    status = h.current.constraintStatus;
    expect(status.rectangle.currentCount).toBe(0);
    expect(status.rectangle.enabled).toBe(true);
  });

  it('setActiveCell updates active cell index', () => {
    const h = createTestStore();
    h.run((a) => a.setActiveCell(1));
    expect(h.current.uiState.activeCellIndex).toBe(1);
  });

  it('assignImageToCell assigns image to cell', () => {
    const h = createTestStore();
    h.run((a) => a.assignImageToCell(1, imageId));
    expect(h.current.uiState.gridAssignments[1]).toBe(imageId);
  });

  it('unassignImageFromCell deletes the cell key through Immer', () => {
    const h = createTestStore();
    h.run((a) => a.assignImageToCell(1, imageId));
    expect(h.current.uiState.gridAssignments[1]).toBe(imageId);

    h.run((a) => a.unassignImageFromCell(1));

    // Unlike Solid's store proxy, an Immer draft keeps `delete` and
    // `= undefined` apart, so the key itself must be gone.
    expect(h.current.uiState.gridAssignments[1]).toBeUndefined();
    expect(Object.keys(h.current.uiState.gridAssignments)).not.toContain('1');
    // Cell 0 was seeded by createTestStore and must be untouched.
    expect(h.current.uiState.gridAssignments[0]).toBe(imageId);
  });

  it('unassignImageFromCell preserves annotations for the removed image', () => {
    const h = createTestStore();
    h.run((a) => a.addAnnotation(dummyAnnotation));
    expect(h.current.annotationState.byImage[imageId]).toBeDefined();
    expect(Object.keys(h.current.annotationState.byImage[imageId]!)).toHaveLength(1);

    h.run((a) => a.unassignImageFromCell(0));

    // `byImage` is keyed by ImageId and independent of grid placement.
    expect(h.current.annotationState.byImage[imageId]).toBeDefined();
    expect(Object.keys(h.current.annotationState.byImage[imageId]!)).toHaveLength(1);
    expect(h.current.uiState.gridAssignments[0]).toBeUndefined();

    h.run((a) => a.assignImageToCell(0, imageId));
    expect(h.current.annotationState.byImage[imageId]).toBeDefined();
    expect(Object.keys(h.current.annotationState.byImage[imageId]!)).toHaveLength(1);
  });

  it('setGridDimensions updates grid dimensions', () => {
    const h = createTestStore();
    h.run((a) => a.setGridDimensions(2, 2));
    expect(h.current.uiState.gridColumns).toBe(2);
    expect(h.current.uiState.gridRows).toBe(2);
  });

  it('setBrushRadius stores a rounded, clamped radius', () => {
    const h = createTestStore();
    h.run((a) => a.setBrushRadius(7.6));
    expect(h.current.uiState.brushRadius).toBe(8);
    h.run((a) => a.setBrushRadius(100_000));
    expect(h.current.uiState.brushRadius).toBe(512);
  });

  it('adjustBrushRadius steps proportionally from the current radius', () => {
    // Two steps in one batch: the second must read the first's write (#217).
    const h = createTestStore();
    h.run((a) => a.setBrushRadius(12));
    h.run((a) => {
      a.adjustBrushRadius(1);
      a.adjustBrushRadius(1);
    });
    expect(h.current.uiState.brushRadius).toBe(19);
    h.run((a) => a.adjustBrushRadius(-1));
    expect(h.current.uiState.brushRadius).toBe(14);
  });

  it('setBrushErasing toggles the eraser', () => {
    const h = createTestStore();
    h.run((a) => a.setBrushErasing(true));
    expect(h.current.uiState.brushErasing).toBe(true);
    h.run((a) => a.setBrushErasing(false));
    expect(h.current.uiState.brushErasing).toBe(false);
  });

  it('setSelectedAnnotation updates selected annotation ID', () => {
    const h = createTestStore();
    h.run((a) => a.setSelectedAnnotation(annId));
    expect(h.current.uiState.selectedAnnotationId).toBe(annId);
  });

  it('setContexts updates context state', () => {
    const h = createTestStore();
    const context: AnnotationContext = { id: contextId, label: 'Test Context', tools: [] };
    h.run((a) => a.setContexts([context]));
    expect(h.current.contextState.contexts).toHaveLength(1);
    expect(h.current.contextState.contexts[0]).toEqual(context);
  });

  it('updateAnnotation handles non-existent annotation gracefully', () => {
    const h = createTestStore();
    h.run((a) => a.updateAnnotation(annId, imageId, { label: 'New Label' }));
    expect(h.current.annotationState.byImage[imageId]).toBeUndefined();
  });

  it('deleteAnnotation handles non-existent annotation gracefully', () => {
    const h = createTestStore();
    h.run((a) => a.deleteAnnotation(annId, imageId));
    expect(h.current.annotationState.byImage[imageId]).toBeUndefined();
  });

  it('keeps the actions object stable across renders', () => {
    // `actions` is a dependency of useAnnotationTool's tool-lifecycle effect
    // and of the context value; a new object per render would rebuild the
    // active tool on every state change.
    const h = createTestStore();
    const before = h.current.actions;
    h.run((a) => a.addAnnotation(dummyAnnotation));
    h.run((a) => a.setActiveTool('circle'));
    h.rerender({ testMode: true });
    expect(h.current.actions).toBe(before);
  });

  /**
   * `convertAnnotation` is guard logic, not a thin dispatch: annotation exists,
   * `status.rectangle.enabled`, `processConvertCircleToRectangle` returns a
   * patch, then `updateAnnotation`. Three of the four exits are silent no-ops.
   * In React every guard reads state through a getter (`getAnnotationState()`
   * / `getContextState()`), which is what differs from Solid and what these
   * tests pin (#152, #162).
   */
  describe('convertAnnotation', () => {
    const circleId = createAnnotationId('circle1');

    /** Allows both tools, so the constraint guard is open unless a test closes it. */
    function withOpenContext(h: AnnotatorHarness): void {
      h.run((a) => {
        a.setContexts([
          {
            id: contextId,
            label: 'Test Context',
            tools: [{ type: 'rectangle' }, { type: 'circle' }],
          },
        ]);
        a.setActiveContext(contextId);
      });
    }

    it('converts a circle to its bounding rectangle in place', () => {
      const h = createTestStore();
      withOpenContext(h);
      h.run((a) => a.addAnnotation(circle('circle1')));

      h.run((a) => a.convertAnnotation(circleId, imageId));

      const converted = h.current.annotationState.byImage[imageId]?.[circleId];
      expect(converted).toBeDefined();
      expect(converted!.toolType).toBe('rectangle');
      expect(converted!.id).toBe(circleId);
      expect(converted!.geometry).toEqual({
        type: 'rectangle',
        origin: { x: 40, y: 40 },
        width: 20,
        height: 20,
        rotation: 0,
      });
      expect(converted!.rawAnnotationData.data.type).toBe('Rect');
    });

    it('converts an annotation that only arrived via initialAnnotations', () => {
      // No action has run, so the getter reads the store's seeded state.
      const h = renderAnnotator({
        initialAnnotations: {
          [imageId]: {
            [circleId]: {
              ...circle('circle1'),
              createdAt: '2026-01-01T00:00:00.000Z',
              updatedAt: '2026-01-01T00:00:00.000Z',
            },
          },
        },
      });
      withOpenContext(h);

      h.run((a) => a.convertAnnotation(circleId, imageId));

      expect(h.current.annotationState.byImage[imageId]![circleId]!.toolType).toBe('rectangle');
    });

    it('does nothing when the annotation does not exist', () => {
      const h = createTestStore();
      withOpenContext(h);

      const before = h.current.annotationState.changeCounter;
      h.run((a) => a.convertAnnotation(circleId, imageId));

      expect(h.current.annotationState.byImage[imageId]).toBeUndefined();
      expect(h.current.annotationState.changeCounter).toBe(before);
    });

    it('does nothing when the annotation is not a circle', () => {
      const h = createTestStore();
      withOpenContext(h);
      h.run((a) => a.addAnnotation(dummyAnnotation));

      const before = h.current.annotationState.changeCounter;
      h.run((a) => a.convertAnnotation(annId, imageId));

      const after = h.current.annotationState.byImage[imageId]?.[annId];
      expect(after).toBeDefined();
      expect(after!.geometry).toEqual(dummyAnnotation.geometry);
      // Without the `!patch` guard the update still runs and bumps the change
      // counter that onAnnotationsChange keys off. A no-op must be nothing.
      expect(h.current.annotationState.changeCounter).toBe(before);
    });

    it('does nothing when the context cannot hold another rectangle', () => {
      const h = createTestStore();
      h.run((a) => {
        a.setContexts([
          {
            id: contextId,
            label: 'Test Context',
            tools: [{ type: 'rectangle', maxCount: 1 }, { type: 'circle' }],
          },
        ]);
        a.setActiveContext(contextId);
      });
      h.run((a) => a.addAnnotation(dummyAnnotation));
      h.run((a) => a.addAnnotation(circle('circle1')));
      expect(h.current.constraintStatus.rectangle.enabled).toBe(false);

      const before = h.current.annotationState.changeCounter;
      h.run((a) => a.convertAnnotation(circleId, imageId));

      const after = h.current.annotationState.byImage[imageId]?.[circleId];
      expect(after).toBeDefined();
      expect(after!.toolType).toBe('circle');
      expect(after!.geometry).toEqual(circle('circle1').geometry);
      expect(h.current.annotationState.changeCounter).toBe(before);
    });

    it('re-reads the constraint guard after a context change', () => {
      // The guard reads `getContextState()`, so it must see a limit lifted by
      // a later render, not the one in force when the actions were created.
      const h = createTestStore();
      h.run((a) => {
        a.setContexts([
          {
            id: contextId,
            label: 'Test Context',
            tools: [{ type: 'rectangle', maxCount: 1 }, { type: 'circle' }],
          },
        ]);
        a.setActiveContext(contextId);
      });
      h.run((a) => a.addAnnotation(dummyAnnotation));
      h.run((a) => a.addAnnotation(circle('circle1')));
      h.run((a) =>
        a.setContexts([
          {
            id: contextId,
            label: 'Test Context',
            tools: [{ type: 'rectangle', maxCount: 2 }, { type: 'circle' }],
          },
        ]),
      );

      h.run((a) => a.convertAnnotation(circleId, imageId));

      expect(h.current.annotationState.byImage[imageId]![circleId]!.toolType).toBe('rectangle');
    });
  });

  /**
   * Each case issues every step in one `h.run()`, which is one `act()` and so
   * one React batch: nothing renders until it returns. A state-reading action
   * must still see the writes before it, as it does in Solid, where the same
   * cases run inside `batch` (#217). The getters used to return refs the
   * provider refreshed on render, and so read the pre-batch state.
   */
  describe('within one batch (#217)', () => {
    const circleId = createAnnotationId('circle1');
    const imageId2 = createImageId('img2');

    function openContext(maxRectangles?: number): AnnotationContext {
      return {
        id: contextId,
        label: 'Test Context',
        tools: [
          maxRectangles === undefined
            ? { type: 'rectangle' }
            : { type: 'rectangle', maxCount: maxRectangles },
          { type: 'circle' },
        ],
      };
    }

    it('convertAnnotation finds a circle added earlier in the batch, in one render', () => {
      const h = createTestStore();
      h.run((a) => {
        a.setContexts([openContext()]);
        a.setActiveContext(contextId);
      });
      const renders = h.renderCount;

      h.run((a) => {
        a.addAnnotation(circle('circle1'));
        a.convertAnnotation(circleId, imageId);
      });

      const converted = h.current.annotationState.byImage[imageId]?.[circleId];
      expect(converted).toBeDefined();
      expect(converted!.toolType).toBe('rectangle');
      // Both writes reach the tree in a single commit: the store notifies once
      // per write, and React batches the re-renders those notifications ask for.
      expect(h.renderCount).toBe(renders + 1);
    });

    it('addAnnotation is refused by contexts set earlier in the batch', () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        const h = createTestStore();
        h.run((a) => {
          a.setContexts([{ ...openContext(), imageIds: [imageId2] }]);
          a.setActiveContext(contextId);
          a.addAnnotation(dummyAnnotation);
        });

        expect(h.current.annotationState.byImage[imageId]).toBeUndefined();
        expect(warn).toHaveBeenCalledTimes(1);
      } finally {
        warn.mockRestore();
      }
    });

    it('addAnnotation is accepted by contexts widened earlier in the batch', () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        const h = createTestStore();
        h.run((a) => {
          a.setContexts([{ ...openContext(), imageIds: [imageId2] }]);
          a.setActiveContext(contextId);
        });

        h.run((a) => {
          a.setContexts([{ ...openContext(), imageIds: [imageId, imageId2] }]);
          a.addAnnotation(dummyAnnotation);
        });

        expect(h.current.annotationState.byImage[imageId]?.[annId]).toBeDefined();
        expect(warn).not.toHaveBeenCalled();
      } finally {
        warn.mockRestore();
      }
    });

    it('convertAnnotation counts a rectangle added earlier in the batch', () => {
      // The circle is already committed, so a guard reading the pre-batch
      // state finds it, counts no rectangle yet, and converts it — leaving two
      // rectangles where the context allows one.
      const h = createTestStore();
      h.run((a) => {
        a.setContexts([openContext(1)]);
        a.setActiveContext(contextId);
        a.addAnnotation(circle('circle1'));
      });
      const before = h.current.annotationState.changeCounter;

      h.run((a) => {
        a.addAnnotation(dummyAnnotation);
        a.convertAnnotation(circleId, imageId);
      });

      expect(h.current.annotationState.byImage[imageId]![circleId]!.toolType).toBe('circle');
      expect(h.current.annotationState.changeCounter).toBe(before + 1);
    });

    it('convertAnnotation refuses when the batch itself fills the rectangle limit', () => {
      const h = createTestStore();
      const before = h.current.annotationState.changeCounter;

      h.run((a) => {
        a.setContexts([openContext(1)]);
        a.setActiveContext(contextId);
        a.addAnnotation(dummyAnnotation);
        a.addAnnotation(circle('circle1'));
        // Decisive only if the guard can see the circle at all: a stale read
        // would leave it a circle too, for the wrong reason.
        expect(
          h.current.store.getSnapshot().annotationState.byImage[imageId]![circleId],
        ).toBeDefined();
        a.convertAnnotation(circleId, imageId);
      });

      expect(h.current.annotationState.byImage[imageId]![circleId]!.toolType).toBe('circle');
      expect(h.current.annotationState.changeCounter).toBe(before + 2);
    });

    it('a view action targets the cell made active earlier in the batch', () => {
      const h = createTestStore();
      h.run((a) => {
        a.setActiveCell(1);
        a.rotateActiveImageCW();
      });

      expect(h.current.uiState.cellTransforms[1]?.rotation).toBe(90);
      expect(h.current.uiState.cellTransforms[0]?.rotation ?? 0).toBe(0);
    });

    it('store.getSnapshot() holds a write the tree has not rendered yet', () => {
      const h = createTestStore();
      let rendered: unknown = 'unread';
      let latest: unknown = 'unread';

      h.run((a) => {
        a.setSelectedAnnotation(annId);
        rendered = h.current.uiState.selectedAnnotationId;
        latest = h.current.store.getSnapshot().uiState.selectedAnnotationId;
      });

      expect(rendered).toBeNull();
      expect(latest).toBe(annId);
      // Once the batch commits, the two agree again.
      expect(h.current.uiState.selectedAnnotationId).toBe(annId);
      expect(h.current.store.getSnapshot().uiState).toBe(h.current.uiState);
    });
  });

  it('Constraint status handles no active context', () => {
    const h = createTestStore();
    h.run((a) => a.setActiveContext(null));
    const status = h.current.constraintStatus;
    expect(status.rectangle.enabled).toBe(false);
    expect(status.circle.enabled).toBe(false);
  });

  describe('View Controls Actions', () => {
    it('toggleActiveImageNegative toggles the inverted state for the active cell', () => {
      const h = createTestStore();
      h.run((a) => a.toggleActiveImageNegative());
      expect(h.current.uiState.cellTransforms[0]?.inverted).toBe(true);
      h.run((a) => a.toggleActiveImageNegative());
      expect(h.current.uiState.cellTransforms[0]?.inverted).toBe(false);
    });

    it('increaseActiveImageExposure increments by 0.1 and clamps to 1 for the active cell', () => {
      const h = createTestStore();
      h.run((a) => a.setActiveCell(1));
      h.run((a) => a.setActiveImageExposure(0.9));
      h.run((a) => a.increaseActiveImageExposure());
      expect(h.current.uiState.cellTransforms[1]?.exposure).toBe(1.0);
      h.run((a) => a.increaseActiveImageExposure());
      expect(h.current.uiState.cellTransforms[1]?.exposure).toBe(1.0);
    });

    it('decreaseActiveImageExposure decrements by 0.1 and clamps to -1 for the active cell', () => {
      const h = createTestStore();
      h.run((a) => a.setActiveCell(2));
      h.run((a) => a.setActiveImageExposure(-0.9));
      h.run((a) => a.decreaseActiveImageExposure());
      expect(h.current.uiState.cellTransforms[2]?.exposure).toBe(-1.0);
      h.run((a) => a.decreaseActiveImageExposure());
      expect(h.current.uiState.cellTransforms[2]?.exposure).toBe(-1.0);
    });

    it('setActiveImageExposure sets specific value and clamps for the active cell', () => {
      const h = createTestStore();
      h.run((a) => a.setActiveImageExposure(0.5));
      expect(h.current.uiState.cellTransforms[0]?.exposure).toBe(0.5);
      h.run((a) => a.setActiveImageExposure(1.5));
      expect(h.current.uiState.cellTransforms[0]?.exposure).toBe(1.0);
      h.run((a) => a.setActiveImageExposure(-2.0));
      expect(h.current.uiState.cellTransforms[0]?.exposure).toBe(-1.0);
    });

    it('increaseActiveImageContrast increments by 0.1 and clamps to 1 for the active cell', () => {
      const h = createTestStore();
      h.run((a) => a.setActiveCell(1));
      h.run((a) => a.setActiveImageContrast(0.9));
      h.run((a) => a.increaseActiveImageContrast());
      expect(h.current.uiState.cellTransforms[1]?.contrast).toBe(1.0);
      h.run((a) => a.increaseActiveImageContrast());
      expect(h.current.uiState.cellTransforms[1]?.contrast).toBe(1.0);
    });

    it('decreaseActiveImageContrast decrements by 0.1 and clamps to -1 for the active cell', () => {
      const h = createTestStore();
      h.run((a) => a.setActiveCell(2));
      h.run((a) => a.setActiveImageContrast(-0.9));
      h.run((a) => a.decreaseActiveImageContrast());
      expect(h.current.uiState.cellTransforms[2]?.contrast).toBe(-1.0);
      h.run((a) => a.decreaseActiveImageContrast());
      expect(h.current.uiState.cellTransforms[2]?.contrast).toBe(-1.0);
    });

    it('setActiveImageContrast sets specific value and clamps for the active cell', () => {
      const h = createTestStore();
      h.run((a) => a.setActiveImageContrast(0.5));
      expect(h.current.uiState.cellTransforms[0]?.contrast).toBe(0.5);
      h.run((a) => a.setActiveImageContrast(1.5));
      expect(h.current.uiState.cellTransforms[0]?.contrast).toBe(1.0);
      h.run((a) => a.setActiveImageContrast(-2.0));
      expect(h.current.uiState.cellTransforms[0]?.contrast).toBe(-1.0);
    });

    it('contrast and exposure adjust independently for the same cell', () => {
      const h = createTestStore();
      h.run((a) => a.setActiveImageExposure(0.3));
      h.run((a) => a.setActiveImageContrast(-0.4));
      expect(h.current.uiState.cellTransforms[0]?.exposure).toBe(0.3);
      expect(h.current.uiState.cellTransforms[0]?.contrast).toBe(-0.4);
    });

    it('resetActiveImageView resets active cell transforms but leaves other cells alone', () => {
      const h = createTestStore();
      h.run((a) => a.toggleActiveImageNegative());
      h.run((a) => a.setActiveImageExposure(0.5));
      h.run((a) => a.setActiveCell(1));
      h.run((a) => a.toggleActiveImageNegative());
      h.run((a) => a.setActiveImageExposure(-0.3));

      h.run((a) => a.resetActiveImageView());

      expect(h.current.uiState.cellTransforms[1]?.exposure).toBe(0);
      expect(h.current.uiState.cellTransforms[1]?.inverted).toBe(false);
      expect(h.current.uiState.cellTransforms[0]?.exposure).toBe(0.5);
      expect(h.current.uiState.cellTransforms[0]?.inverted).toBe(true);
    });

    it('setGridDimensions prunes stale cell transforms', () => {
      const h = createTestStore();
      h.run((a) => a.setGridDimensions(2, 2));
      for (const cell of [0, 1, 2]) {
        h.run((a) => a.setActiveCell(cell));
        h.run((a) => a.toggleActiveImageNegative());
      }
      expect(Object.keys(h.current.uiState.cellTransforms)).toHaveLength(3);

      h.run((a) => a.setGridDimensions(1, 1));

      expect(Object.keys(h.current.uiState.cellTransforms)).toHaveLength(1);
      expect(h.current.uiState.cellTransforms[0]).toBeDefined();
      expect(h.current.uiState.cellTransforms[1]).toBeUndefined();
      expect(h.current.uiState.cellTransforms[2]).toBeUndefined();
    });

    it('assignImageToCell resets transforms for that cell', () => {
      const h = createTestStore();
      const img2 = createImageId('img2');
      h.run((a) => a.toggleActiveImageNegative());
      h.run((a) => a.setActiveImageExposure(0.8));
      expect(h.current.uiState.cellTransforms[0]?.inverted).toBe(true);
      expect(h.current.uiState.cellTransforms[0]?.exposure).toBe(0.8);

      h.run((a) => a.assignImageToCell(0, img2));

      expect(h.current.uiState.cellTransforms[0]?.inverted).toBe(false);
      expect(h.current.uiState.cellTransforms[0]?.exposure).toBe(0);
    });
  });

  describe('Displayed Contexts Actions', () => {
    const ctxId2 = createAnnotationContextId('ctx2');
    const ctxId3 = createAnnotationContextId('ctx3');

    it('initial state has empty displayedContextIds', () => {
      const h = createTestStore();
      expect(h.current.contextState.displayedContextIds).toEqual([]);
    });

    it('setDisplayedContexts sets displayed context IDs', () => {
      const h = createTestStore();
      h.run((a) => a.setDisplayedContexts([contextId, ctxId2]));
      expect(h.current.contextState.displayedContextIds).toEqual([contextId, ctxId2]);
    });

    it('setDisplayedContexts replaces previous IDs', () => {
      const h = createTestStore();
      h.run((a) => a.setDisplayedContexts([contextId]));
      h.run((a) => a.setDisplayedContexts([ctxId2, ctxId3]));
      expect(h.current.contextState.displayedContextIds).toEqual([ctxId2, ctxId3]);
    });

    it('setDisplayedContexts clears with empty array', () => {
      const h = createTestStore();
      h.run((a) => a.setDisplayedContexts([contextId]));
      h.run((a) => a.setDisplayedContexts([]));
      expect(h.current.contextState.displayedContextIds).toEqual([]);
    });

    it('displayed contexts are independent of active context', () => {
      const h = createTestStore();
      h.run((a) => {
        a.setContexts([
          { id: contextId, label: 'Ctx 1', tools: [] },
          { id: ctxId2, label: 'Ctx 2', tools: [] },
        ]);
        a.setActiveContext(contextId);
        a.setDisplayedContexts([ctxId2]);
      });
      h.run((a) => a.setActiveContext(ctxId2));
      expect(h.current.contextState.displayedContextIds).toEqual([ctxId2]);
      expect(h.current.contextState.activeContextId).toBe(ctxId2);
    });

    it('constraint status unaffected by displayed contexts', () => {
      const h = createTestStore();
      h.run((a) => {
        a.setContexts([
          { id: contextId, label: 'Ctx 1', tools: [{ type: 'rectangle', maxCount: 1 }] },
          { id: ctxId2, label: 'Ctx 2', tools: [{ type: 'circle' }] },
        ]);
        a.setActiveContext(contextId);
        a.setDisplayedContexts([ctxId2]);
      });

      const status = h.current.constraintStatus;
      expect(status.rectangle.enabled).toBe(true);
      expect(status.rectangle.currentCount).toBe(0);
      expect(status.circle.enabled).toBe(false);
    });
  });
});
