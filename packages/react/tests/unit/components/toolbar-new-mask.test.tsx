import { describe, it, expect, vi, afterEach } from 'vitest';
import { act } from 'react';
import { createImageId } from '@osdlabel/viewer-api';
import { createAnnotationContextId } from '@osdlabel/annotation-context';
import { createAnnotationId, type AnnotationId } from '@osdlabel/annotation';
import {
  BoundedDenseMaskBuffer,
  createInitialUIState,
  createMaskAnnotation,
  stampCircle,
  type ConstraintStatus,
} from 'osdlabel';
import { mount, unmountAll } from '../mount.js';
import { allEnabled, createMockAnnotator, type MockAnnotator } from '../hooks/mock-annotator.js';

/** Reassigned per render; `useAnnotator` returns whatever it holds. */
let mockState: MockAnnotator = createMockAnnotator();

vi.mock('../../../src/state/annotator-context.js', () => ({
  useAnnotator: () => mockState,
}));

const { default: Toolbar } = await import('../../../src/components/Toolbar.js');

/**
 * The React counterpart of Solid's `components/toolbar-new-mask.test.ts`. A
 * mock re-renders nothing, so each state change is a new mock and a
 * re-render, where Solid's test writes to a store.
 */
const imageId = createImageId('img-1');
const contextId = createAnnotationContextId('ctx-1');
const otherContextId = createAnnotationContextId('ctx-2');
const m1 = createAnnotationId('m1');

function mask() {
  const buffer = new BoundedDenseMaskBuffer({ imageWidth: 100, imageHeight: 100 });
  stampCircle(buffer, 50, 50, 5, 1);
  return createMaskAnnotation(buffer.raster(), { id: m1, imageId, contextId });
}

interface State {
  readonly selected: AnnotationId | null;
  readonly activeContextId: typeof contextId;
  readonly brush: ConstraintStatus['segmentationBrush'];
}
const initial: State = {
  selected: m1,
  activeContextId: contextId,
  brush: { enabled: true, currentCount: 1, maxCount: null },
};

function annotatorFor(state: State): MockAnnotator {
  return createMockAnnotator({
    annotationState: { byImage: { [imageId]: { [m1]: mask() } }, changeCounter: 1 },
    uiState: {
      ...createInitialUIState(),
      activeTool: 'segmentationBrush',
      selectedAnnotationId: state.selected,
    },
    contextState: {
      activeContextId: state.activeContextId,
      contexts: [
        { id: contextId, label: 'One', tools: [{ type: 'segmentationBrush' }] },
        { id: otherContextId, label: 'Two', tools: [{ type: 'segmentationBrush' }] },
      ],
      displayedContextIds: [],
    },
    constraintStatus: allEnabled({ segmentationBrush: state.brush }),
    activeImageId: imageId,
  });
}

describe('Toolbar: New mask', () => {
  afterEach(() => {
    unmountAll();
    mockState = createMockAnnotator();
  });

  function renderWith(state: State) {
    mockState = annotatorFor(state);
    const m = mount(<Toolbar />);
    return {
      button: () => m.container.querySelector<HTMLButtonElement>('[data-testid="brush-new-mask"]')!,
      container: m.container,
      update: (next: Partial<State>) => {
        mockState = annotatorFor({ ...state, ...next });
        m.rerender(<Toolbar />);
      },
    };
  }

  it('sits beside the eraser while the brush is active', () => {
    const t = renderWith(initial);
    expect(t.button()).not.toBeNull();
    expect(t.container.querySelector('[data-testid="brush-eraser"]')).not.toBeNull();
    expect(t.button().title).toBe('New mask (n)');
  });

  it('shows pressed exactly when the next stroke will create a mask', () => {
    const t = renderWith(initial);
    // A refinable mask is selected: the next stroke refines it.
    expect(t.button().getAttribute('aria-pressed')).toBe('false');
    t.update({ selected: null });
    expect(t.button().getAttribute('aria-pressed')).toBe('true');
    // Selected, but in a context the user is not working in.
    t.update({ selected: m1, activeContextId: otherContextId });
    expect(t.button().getAttribute('aria-pressed')).toBe('true');
    t.update({ selected: m1, activeContextId: contextId });
    expect(t.button().getAttribute('aria-pressed')).toBe('false');
  });

  it('deselects and keeps the brush', () => {
    const t = renderWith(initial);
    act(() => t.button().click());
    expect(mockState.actions.setSelectedAnnotation).toHaveBeenCalledWith(null);
    expect(mockState.actions.setActiveTool).not.toHaveBeenCalled();
  });

  it('is disabled at the context limit, saying why', () => {
    const t = renderWith({ ...initial, brush: { enabled: true, currentCount: 1, maxCount: 1 } });
    expect(t.button().disabled).toBe(true);
    expect(t.button().title).toMatch(/limit of 1 masks is reached; select a mask to refine it/);
    t.update({ brush: { enabled: true, currentCount: 1, maxCount: 2 } });
    expect(t.button().disabled).toBe(false);
  });
});
