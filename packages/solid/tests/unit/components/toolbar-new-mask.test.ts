import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { createComponent, createSignal } from 'solid-js';
import { createStore } from 'solid-js/store';
import { render } from 'solid-js/web';
import { createImageId } from '@osdlabel/viewer-api';
import { createAnnotationContextId } from '@osdlabel/annotation-context';
import { createAnnotationId } from '@osdlabel/annotation';
import {
  BoundedDenseMaskBuffer,
  createInitialUIState,
  createMaskAnnotation,
  stampCircle,
  type ConstraintStatus,
} from 'osdlabel';
import { createMockAnnotator } from '../hooks/mock-annotator.js';

/**
 * The brush's New mask button. Mirrored for React in
 * `packages/react/tests/unit/components/toolbar-new-mask.test.tsx`.
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

const [ui, setUi] = createStore({
  ...createInitialUIState(),
  activeTool: 'segmentationBrush' as const,
  selectedAnnotationId: m1 as typeof m1 | null,
});
const [contexts, setContexts] = createStore({
  activeContextId: contextId as typeof contextId | null,
  contexts: [
    { id: contextId, label: 'One', tools: [{ type: 'segmentationBrush' as const }] },
    { id: otherContextId, label: 'Two', tools: [{ type: 'segmentationBrush' as const }] },
  ],
  displayedContextIds: [],
});
const unlimited = (): ConstraintStatus['segmentationBrush'] => ({
  enabled: true,
  currentCount: 1,
  maxCount: null,
});
const [brushStatus, setBrushStatus] = createSignal(unlimited());

const mockState = createMockAnnotator({
  uiState: ui,
  contextState: contexts,
  activeImageId: () => imageId,
});
mockState.annotationState.byImage[imageId] = { [m1]: mask() };
const baseStatus = mockState.constraintStatus;
mockState.constraintStatus = () => ({ ...baseStatus(), segmentationBrush: brushStatus() });

vi.mock('../../../src/state/annotator-context.js', () => ({
  useAnnotator: () => mockState,
}));

const { default: Toolbar } = await import('../../../src/components/Toolbar.js');

describe('Toolbar: New mask', () => {
  let dispose: (() => void) | undefined;
  let container: HTMLDivElement;
  const button = () =>
    container.querySelector<HTMLButtonElement>('[data-testid="brush-new-mask"]')!;

  beforeEach(() => {
    setUi('selectedAnnotationId', m1);
    setContexts('activeContextId', contextId);
    setBrushStatus(unlimited());
    vi.mocked(mockState.actions.setSelectedAnnotation).mockClear();
    vi.mocked(mockState.actions.setActiveTool).mockClear();
    container = document.createElement('div');
    document.body.append(container);
    dispose = render(() => createComponent(Toolbar, {}), container);
  });
  afterEach(() => {
    dispose?.();
    dispose = undefined;
    document.body.innerHTML = '';
  });

  it('sits beside the eraser while the brush is active', () => {
    expect(button()).not.toBeNull();
    expect(container.querySelector('[data-testid="brush-eraser"]')).not.toBeNull();
    expect(button().title).toBe('New mask (n)');
  });

  it('shows pressed exactly when the next stroke will create a mask', () => {
    // A refinable mask is selected: the next stroke refines it.
    expect(button().getAttribute('aria-pressed')).toBe('false');
    setUi('selectedAnnotationId', null);
    expect(button().getAttribute('aria-pressed')).toBe('true');
    // Selected, but in a context the user is not working in.
    setUi('selectedAnnotationId', m1);
    setContexts('activeContextId', otherContextId);
    expect(button().getAttribute('aria-pressed')).toBe('true');
    setContexts('activeContextId', contextId);
    expect(button().getAttribute('aria-pressed')).toBe('false');
  });

  it('deselects and keeps the brush', () => {
    button().click();
    expect(mockState.actions.setSelectedAnnotation).toHaveBeenCalledWith(null);
    expect(mockState.actions.setActiveTool).not.toHaveBeenCalled();
  });

  it('is disabled at the context limit, saying why', () => {
    setBrushStatus({ enabled: true, currentCount: 1, maxCount: 1 });
    expect(button().disabled).toBe(true);
    expect(button().title).toMatch(/limit of 1 masks is reached; select a mask to refine it/);
    setBrushStatus({ enabled: true, currentCount: 1, maxCount: 2 });
    expect(button().disabled).toBe(false);
  });
});
