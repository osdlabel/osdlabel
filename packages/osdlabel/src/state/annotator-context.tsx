import { createContext, useContext, createEffect, on, type JSX, type Accessor } from 'solid-js';
import { produce } from 'solid-js/store';
import type { AnnotationId, ImageId } from '@osdlabel/annotation';
import type { AnnotationState, KeyboardShortcutMap, UIState } from '@osdlabel/viewer-api';
import { getAllAnnotationsFlat } from '@osdlabel/viewer-api';
import type { ConstraintStatus, ContextState } from '@osdlabel/annotation-context';
import { createAnnotationStore } from './annotation-store.js';
import { createUIStore } from './ui-store.js';
import { createContextStore, createConstraintStatus } from './context-store.js';
import { createActions } from './actions.js';
import { DEFAULT_KEYBOARD_SHORTCUTS, useKeyboard } from '../hooks/useKeyboard.js';
import type { OsdAnnotation, OsdFields } from '../types.js';

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
  activeImageId: Accessor<ImageId | undefined>;
  testMode: boolean;
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
  /** Optional callback to suppress keyboard shortcuts for specific targets */
  readonly shouldSkipKeyboardShortcutPredicate?: ((target: HTMLElement) => boolean) | undefined;
  /** When true, exposes internal instances on DOM elements for E2E test access */
  readonly testMode?: boolean | undefined;
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
  );
  const activeImageId = () => uiState.gridAssignments[uiState.activeCellIndex];
  const constraintStatus = createConstraintStatus(contextState, annotationState, activeImageId);

  const activeToolKeyHandlerRef: ActiveToolKeyHandlerRef = { handler: null };
  const mergedShortcuts = { ...DEFAULT_KEYBOARD_SHORTCUTS, ...props.keyboardShortcuts };

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
    activeImageId,
    testMode: props.testMode ?? false,
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
