import { vi } from 'vitest';
import {
  DEFAULT_VERTEX_EDIT_LONG_PRESS_MS,
  DEFAULT_VERTEX_EDIT_MOVE_TOLERANCE_PX,
  createInitialAnnotationState,
  createInitialContextState,
  createInitialUIState,
  type ConstraintStatus,
} from 'osdlabel';
import type { useAnnotator } from '../../../src/state/annotator-context.js';
import { DEFAULT_KEYBOARD_SHORTCUTS } from '../../../src/hooks/useKeyboard.js';

/**
 * The value `useAnnotator()` hands a component. The interface behind it is not
 * exported, so this derives it rather than duplicating it — which also means it
 * cannot drift from the real one.
 */
export type MockAnnotator = ReturnType<typeof useAnnotator>;

/**
 * A complete, type-checked stand-in for the annotator context.
 *
 * A `vi.mock` factory's return value is **not** checked against the real
 * module's shape, so a hand-written object literal passed straight to
 * `useAnnotator: () => mockState` can silently omit a non-optional field. That
 * had actually happened: the mock omitted `vertexEditConfig`, so
 * `useAnnotationTool` ran with `vertexEdit: undefined` — a state the real app
 * cannot produce (#162).
 *
 * Annotating the object here closes that hole: every field of the real context
 * must be present and correctly typed, and the type checker reports it at this
 * declaration, which *is* checked. The state slices come from the same
 * `createInitial*State` factories the real provider uses, so their shapes
 * cannot drift either — but as plain objects, not Solid stores: store proxies
 * are read-only, and a test that assigned straight into one would silently
 * mutate nothing.
 *
 * `overrides` is applied last, so a test can narrow one slice without
 * restating the rest.
 */
export function createMockAnnotator(overrides: Partial<MockAnnotator> = {}): MockAnnotator {
  const annotationState = createInitialAnnotationState();
  const uiState = createInitialUIState();
  const contextState = createInitialContextState();

  // Every tool enabled. Built from the real `ConstraintStatus` type, so a new
  // tool type breaks this instead of silently arriving as `undefined`.
  const allEnabled = (): ConstraintStatus => ({
    rectangle: { enabled: true, currentCount: 0, maxCount: null },
    circle: { enabled: true, currentCount: 0, maxCount: null },
    line: { enabled: true, currentCount: 0, maxCount: null },
    point: { enabled: true, currentCount: 0, maxCount: null },
    polyline: { enabled: true, currentCount: 0, maxCount: null },
    freeHandPath: { enabled: true, currentCount: 0, maxCount: null },
  });

  const base: MockAnnotator = {
    annotationState,
    uiState,
    contextState,
    constraintStatus: allEnabled,
    actions: {
      addAnnotation: vi.fn(),
      updateAnnotation: vi.fn(),
      convertAnnotation: vi.fn(),
      deleteAnnotation: vi.fn(),
      setActiveTool: vi.fn(),
      setActiveViewerControl: vi.fn(),
      setActiveCell: vi.fn(),
      setSelectedAnnotation: vi.fn(),
      assignImageToCell: vi.fn(),
      setGridDimensions: vi.fn(),
      setContexts: vi.fn(),
      setActiveContext: vi.fn(),
      setDisplayedContexts: vi.fn(),
      loadAnnotations: vi.fn(),
      rotateActiveImageCW: vi.fn(),
      rotateActiveImageCCW: vi.fn(),
      flipActiveImageH: vi.fn(),
      flipActiveImageV: vi.fn(),
      toggleActiveImageNegative: vi.fn(),
      increaseActiveImageExposure: vi.fn(),
      decreaseActiveImageExposure: vi.fn(),
      setActiveImageExposure: vi.fn(),
      increaseActiveImageContrast: vi.fn(),
      decreaseActiveImageContrast: vi.fn(),
      setActiveImageContrast: vi.fn(),
      resetActiveImageView: vi.fn(),
    },
    activeToolKeyHandlerRef: { handler: null },
    fullscreenTargetRef: { element: null },
    fullscreenTarget: undefined,
    shortcuts: DEFAULT_KEYBOARD_SHORTCUTS,
    vertexEditConfig: {
      longPressMs: DEFAULT_VERTEX_EDIT_LONG_PRESS_MS,
      moveTolerancePx: DEFAULT_VERTEX_EDIT_MOVE_TOLERANCE_PX,
    },
    vertexMarkerOptions: {},
    activeImageId: () => undefined,
    testMode: false,
    decorationProviders: [],
    defaultPixelSpacing: undefined,
    renderDomDecoration: undefined,
  };

  return { ...base, ...overrides };
}
