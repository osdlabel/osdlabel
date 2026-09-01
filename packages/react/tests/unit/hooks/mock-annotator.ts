import { vi } from 'vitest';
import {
  DEFAULT_KEYBOARD_SHORTCUTS,
  DEFAULT_VERTEX_EDIT_LONG_PRESS_MS,
  DEFAULT_VERTEX_EDIT_MOVE_TOLERANCE_PX,
  createInitialAnnotationState,
  createInitialContextState,
  createInitialUIState,
  type ConstraintStatus,
} from 'osdlabel';
import type {
  AnnotatorSnapshot,
  AnnotatorStoreReader,
} from '../../../src/state/annotator-store.js';
import type { AnnotatorValue } from '../render-annotator.js';

export type MockAnnotator = AnnotatorValue;
export type MockActions = MockAnnotator['actions'];

/** Every tool enabled. Typed, so a new tool type breaks this instead of arriving as `undefined`. */
export function allEnabled(overrides: Partial<ConstraintStatus> = {}): ConstraintStatus {
  const enabled = { enabled: true, currentCount: 0, maxCount: null };
  return {
    rectangle: { ...enabled },
    circle: { ...enabled },
    line: { ...enabled },
    point: { ...enabled },
    polyline: { ...enabled },
    freeHandPath: { ...enabled },
    segmentationBrush: { ...enabled },
    ...overrides,
  };
}

/** One `vi.fn()` per action, typed against the real `createActions` result. */
export function createMockActions(): MockActions {
  return {
    addAnnotation: vi.fn(),
    updateAnnotation: vi.fn(),
    convertAnnotation: vi.fn(),
    deleteAnnotation: vi.fn(),
    setActiveTool: vi.fn(),
    setActiveViewerControl: vi.fn(),
    setActiveCell: vi.fn(),
    setSelectedAnnotation: vi.fn(),
    assignImageToCell: vi.fn(),
    unassignImageFromCell: vi.fn(),
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
    setBrushRadius: vi.fn(),
    adjustBrushRadius: vi.fn(),
    setBrushErasing: vi.fn(),
  };
}

/**
 * A read-only store over the mock's own fields: `getSnapshot()` returns its
 * three state slices and `getConstraintStatus()` its `constraintStatus`, so
 * code reading the store sees what code reading the context value sees. It
 * never notifies. The fields are read when called, so a test that reassigns
 * one on the mock object is seen; a test that spreads the mock into a new
 * object should rebuild it with `createMockAnnotator` instead.
 */
function createMockStore(read: () => Omit<MockAnnotator, 'store'>): AnnotatorStoreReader {
  let snapshot: AnnotatorSnapshot | undefined;
  const getSnapshot = (): AnnotatorSnapshot => {
    const mock = read();
    if (
      !snapshot ||
      snapshot.annotationState !== mock.annotationState ||
      snapshot.uiState !== mock.uiState ||
      snapshot.contextState !== mock.contextState
    ) {
      snapshot = {
        annotationState: mock.annotationState,
        uiState: mock.uiState,
        contextState: mock.contextState,
      };
    }
    return snapshot;
  };
  return {
    getSnapshot,
    subscribe: () => () => {},
    getConstraintStatus: () => read().constraintStatus,
  };
}

/**
 * A complete, type-checked stand-in for the annotator context, mirroring
 * `packages/solid/tests/unit/hooks/mock-annotator.ts`.
 *
 * A `vi.mock` factory's return value is not checked against the real module,
 * so a bare object literal passed to `useAnnotator: () => mock` can silently
 * omit a field (#162). Building it here, against `ReturnType<typeof
 * useAnnotator>`, makes the type checker report a missing or mistyped field.
 *
 * Unlike Solid's context, React's carries plain values: `constraintStatus` and
 * `activeImageId` are values, not accessors. A mock does not re-render
 * anything when it changes, so a test that swaps it must also re-render the
 * component under test. Prefer `renderAnnotator` (the real provider) unless the
 * component pulls in OSD/Fabric machinery the test has to stub out anyway.
 */
export function createMockAnnotator(overrides: Partial<MockAnnotator> = {}): MockAnnotator {
  const base: Omit<MockAnnotator, 'store'> = {
    annotationState: createInitialAnnotationState(),
    uiState: createInitialUIState(),
    contextState: createInitialContextState(),
    constraintStatus: allEnabled(),
    actions: createMockActions(),
    activeToolKeyHandlerRef: { handler: null },
    fullscreenTargetRef: { element: null },
    fullscreenTarget: undefined,
    shortcuts: DEFAULT_KEYBOARD_SHORTCUTS,
    vertexEditConfig: {
      longPressMs: DEFAULT_VERTEX_EDIT_LONG_PRESS_MS,
      moveTolerancePx: DEFAULT_VERTEX_EDIT_MOVE_TOLERANCE_PX,
    },
    vertexMarkerOptions: {},
    brushOptions: {},
    activeImageId: undefined,
    testMode: false,
    decorationProviders: [],
    defaultPixelSpacing: undefined,
    renderDomDecoration: undefined,
    reportAnnotationRenderError: vi.fn(),
  };
  const { store, ...rest } = overrides;
  const mock: MockAnnotator = { ...base, ...rest, store: store ?? createMockStore(() => mock) };
  return mock;
}
