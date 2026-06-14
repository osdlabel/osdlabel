import { createContext, useContext, createEffect, on, type JSX, type Accessor } from 'solid-js';
import { produce } from 'solid-js/store';
import type { AnnotationId } from '@osdlabel/annotation';
import type { ImageId, PixelSpacing } from '@osdlabel/viewer-api';
import type { AnnotationState, KeyboardShortcutMap, UIState } from '@osdlabel/viewer-api';
import { getAllAnnotationsFlat } from '@osdlabel/viewer-api';
import type { ConstraintStatus, ContextState } from '@osdlabel/annotation-context';
import type { DecorationProvider, DomDecoration } from '@osdlabel/decoration';
import type { OsdAnnotation, OsdFields, SegmentationProvider, VertexEditConfig } from 'osdlabel';
import {
  DEFAULT_KEYBOARD_SHORTCUTS,
  DEFAULT_VERTEX_EDIT_LONG_PRESS_MS,
  DEFAULT_VERTEX_EDIT_MOVE_TOLERANCE_PX,
} from 'osdlabel';
import { createAnnotationStore } from './annotation-store.js';
import { createUIStore } from './ui-store.js';
import { createContextStore, createConstraintStatus } from './context-store.js';
import { createActions } from './actions.js';
import { useKeyboard } from '../hooks/useKeyboard.js';

export interface ActiveToolKeyHandlerRef {
  handler: ((event: KeyboardEvent) => boolean) | null;
}

interface AnnotatorContextValue {
  annotationState: AnnotationState<OsdFields>;
  uiState: UIState;
  contextState: ContextState;
  constraintStatus: Accessor<ConstraintStatus>;
  actions: ReturnType<typeof createActions>;
  activeToolKeyHandlerRef: ActiveToolKeyHandlerRef;
  shortcuts: KeyboardShortcutMap;
  vertexEditConfig: VertexEditConfig;
  activeImageId: Accessor<ImageId | undefined>;
  testMode: boolean;
  decorationProviders: readonly DecorationProvider<OsdFields>[];
  defaultPixelSpacing: PixelSpacing | undefined;
  renderDomDecoration: ((decoration: DomDecoration) => JSX.Element) | undefined;
  segmentationProvider: SegmentationProvider | undefined;
}

const KeyboardHandler = (props: {
  shortcuts: KeyboardShortcutMap;
  activeToolKeyHandlerRef: ActiveToolKeyHandlerRef;
  shouldSkipTargetPredicate?: ((target: HTMLElement) => boolean) | undefined;
}) => {
  useKeyboard(props.shortcuts, props.activeToolKeyHandlerRef, props.shouldSkipTargetPredicate);
  return null;
};

const AnnotatorContext = createContext<AnnotatorContextValue>();

export interface AnnotatorProviderProps {
  readonly children: JSX.Element;
  /** Pre-existing annotations to load on mount */
  readonly initialAnnotations?: Record<ImageId, Record<AnnotationId, OsdAnnotation>> | undefined;
  /** Called when annotation state changes (after initial mount) */
  readonly onAnnotationsChange?: ((annotations: OsdAnnotation[]) => void) | undefined;
  /** Called when constraint status changes (after initial mount) */
  readonly onConstraintChange?: ((status: ConstraintStatus) => void) | undefined;
  readonly keyboardShortcuts?: Partial<KeyboardShortcutMap> | undefined;
  /**
   * Long-press duration (ms) to enter polygon/polyline vertex-edit mode.
   * Defaults to {@link DEFAULT_VERTEX_EDIT_LONG_PRESS_MS}.
   */
  readonly vertexEditLongPressMs?: number | undefined;
  /**
   * Pointer travel (screen px) that cancels the vertex-edit long-press.
   * Defaults to {@link DEFAULT_VERTEX_EDIT_MOVE_TOLERANCE_PX}.
   */
  readonly vertexEditMoveTolerancePx?: number | undefined;
  /** Optional callback to suppress keyboard shortcuts for specific targets */
  readonly shouldSkipKeyboardShortcutPredicate?: ((target: HTMLElement) => boolean) | undefined;
  /** When true, exposes internal instances on DOM elements for E2E test access */
  readonly testMode?: boolean | undefined;
  /**
   * Decoration providers — pure functions that derive text/line decorations
   * from the visible annotations and pixel-spacing. Composed in array order.
   */
  readonly decorationProviders?: readonly DecorationProvider<OsdFields>[] | undefined;
  /**
   * Fallback pixel spacing used when an `ImageSource` does not specify its own.
   */
  readonly defaultPixelSpacing?: PixelSpacing | undefined;
  /**
   * Renders the content for a DOM decoration into its positioned root element
   * (via a Solid portal, so the tree shares this provider's context). Receives
   * the `DomDecoration` and returns the element to mount.
   */
  readonly renderDomDecoration?: ((decoration: DomDecoration) => JSX.Element) | undefined;
  /**
   * Injected auto-segmentation backend (Segment Anything-style). Required for
   * the `'segmentation'` tool to be active; when omitted, selecting the tool is
   * a no-op.
   */
  readonly segmentationProvider?: SegmentationProvider | undefined;
}

export function AnnotatorProvider(props: AnnotatorProviderProps) {
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
  const activeImageId = () => uiState.gridAssignments[uiState.activeCellIndex];
  const constraintStatus = createConstraintStatus(contextState, annotationState, activeImageId);

  const activeToolKeyHandlerRef: ActiveToolKeyHandlerRef = { handler: null };
  const mergedShortcuts = { ...DEFAULT_KEYBOARD_SHORTCUTS, ...props.keyboardShortcuts };
  const vertexEditConfig: VertexEditConfig = {
    longPressMs: props.vertexEditLongPressMs ?? DEFAULT_VERTEX_EDIT_LONG_PRESS_MS,
    moveTolerancePx: props.vertexEditMoveTolerancePx ?? DEFAULT_VERTEX_EDIT_MOVE_TOLERANCE_PX,
  };

  // Load initial annotations if provided
  if (props.initialAnnotations) {
    setAnnotationState(
      produce((state) => {
        for (const [imageId, annMap] of Object.entries(props.initialAnnotations!)) {
          state.byImage[imageId as ImageId] = { ...annMap };
        }
        state.changeCounter += 1;
      }),
    );
  }

  // Fire onAnnotationsChange when annotations change (defer: skip initial mount)
  createEffect(
    on(
      () => annotationState.changeCounter,
      () => {
        if (props.onAnnotationsChange) {
          const allAnnotations = getAllAnnotationsFlat(annotationState);
          props.onAnnotationsChange(allAnnotations);
        }
      },
      { defer: true },
    ),
  );

  // Fire onConstraintChange when constraint status changes (defer: skip initial mount)
  createEffect(
    on(
      constraintStatus,
      (status) => {
        if (props.onConstraintChange) {
          props.onConstraintChange(status);
        }
      },
      { defer: true },
    ),
  );

  const value: AnnotatorContextValue = {
    annotationState,
    uiState,
    contextState,
    constraintStatus,
    actions,
    activeToolKeyHandlerRef,
    shortcuts: mergedShortcuts,
    vertexEditConfig,
    activeImageId,
    testMode: props.testMode ?? false,
    decorationProviders: props.decorationProviders ?? [],
    defaultPixelSpacing: props.defaultPixelSpacing,
    renderDomDecoration: props.renderDomDecoration,
    segmentationProvider: props.segmentationProvider,
  };

  return (
    <AnnotatorContext.Provider value={value}>
      <KeyboardHandler
        shortcuts={mergedShortcuts}
        activeToolKeyHandlerRef={activeToolKeyHandlerRef}
        shouldSkipTargetPredicate={props.shouldSkipKeyboardShortcutPredicate}
      />
      {props.children}
    </AnnotatorContext.Provider>
  );
}

export function useAnnotator() {
  const context = useContext(AnnotatorContext);
  if (!context) {
    throw new Error('useAnnotator must be used within an AnnotatorProvider');
  }
  return context;
}
