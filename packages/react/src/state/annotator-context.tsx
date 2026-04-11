import {
  createContext,
  useContext,
  useReducer,
  useMemo,
  useEffect,
  useRef,
  type ReactNode,
} from 'react';
import { castDraft, produce } from 'immer';
import type { AnnotationId } from '@osdlabel/annotation';
import type { ImageId, AnnotationState, KeyboardShortcutMap, UIState } from '@osdlabel/viewer-api';
import { getAllAnnotationsFlat } from '@osdlabel/viewer-api';
import type { ConstraintStatus, ContextState } from '@osdlabel/annotation-context';
import type { OsdAnnotation, OsdFields } from 'osdlabel';
import {
  DEFAULT_KEYBOARD_SHORTCUTS,
  createInitialAnnotationState,
  createInitialUIState,
  createInitialContextState,
  computeConstraintStatus,
} from 'osdlabel';
import { annotationReducer, uiReducer, contextReducer } from './reducer.js';
import { createActions } from './actions.js';
import { useKeyboard } from '../hooks/useKeyboard.js';

export interface ActiveToolKeyHandlerRef {
  handler: ((event: KeyboardEvent) => boolean) | null;
}

interface AnnotatorContextValue {
  annotationState: AnnotationState<OsdFields>;
  uiState: UIState;
  contextState: ContextState;
  constraintStatus: ConstraintStatus;
  actions: ReturnType<typeof createActions>;
  activeToolKeyHandlerRef: ActiveToolKeyHandlerRef;
  shortcuts: KeyboardShortcutMap;
  activeImageId: ImageId | undefined;
  testMode: boolean;
}

const AnnotatorContext = createContext<AnnotatorContextValue | null>(null);

export interface AnnotatorProviderProps {
  readonly children: ReactNode;
  readonly initialAnnotations?: Record<ImageId, Record<AnnotationId, OsdAnnotation>> | undefined;
  readonly onAnnotationsChange?: ((annotations: OsdAnnotation[]) => void) | undefined;
  readonly onConstraintChange?: ((status: ConstraintStatus) => void) | undefined;
  readonly keyboardShortcuts?: Partial<KeyboardShortcutMap> | undefined;
  readonly shouldSkipKeyboardShortcutPredicate?: ((target: HTMLElement) => boolean) | undefined;
  readonly testMode?: boolean | undefined;
}

export function AnnotatorProvider({
  children,
  initialAnnotations,
  onAnnotationsChange,
  onConstraintChange,
  keyboardShortcuts,
  shouldSkipKeyboardShortcutPredicate,
  testMode = false,
}: AnnotatorProviderProps) {
  const [annotationState, dispatchAnnotation] = useReducer(annotationReducer, undefined, () => {
    const initial = createInitialAnnotationState();
    if (initialAnnotations) {
      return produce(initial, (draft) => {
        for (const [imageId, annMap] of Object.entries(initialAnnotations)) {
          draft.byImage[imageId as ImageId] = castDraft({ ...annMap });
        }
        draft.changeCounter += 1;
      });
    }
    return initial;
  });
  const [uiState, dispatchUI] = useReducer(uiReducer, undefined, createInitialUIState);
  const [contextState, dispatchContext] = useReducer(
    contextReducer,
    undefined,
    createInitialContextState,
  );

  // Refs for current state (needed to avoid stale closures in actions)
  const contextStateRef = useRef(contextState);
  contextStateRef.current = contextState;
  const uiStateRef = useRef(uiState);
  uiStateRef.current = uiState;

  const actions = useMemo(
    () =>
      createActions(
        dispatchAnnotation,
        dispatchUI,
        dispatchContext,
        () => contextStateRef.current,
        () => uiStateRef.current,
      ),
    [],
  );

  const activeImageId = useMemo(
    () => uiState.gridAssignments[uiState.activeCellIndex],
    [uiState.gridAssignments, uiState.activeCellIndex],
  );

  const constraintStatus = useMemo(
    () => computeConstraintStatus(contextState, annotationState, activeImageId),
    [contextState, annotationState, activeImageId],
  );

  const activeToolKeyHandlerRef = useRef<ActiveToolKeyHandlerRef>({ handler: null }).current;
  const mergedShortcuts = useMemo(
    () => ({ ...DEFAULT_KEYBOARD_SHORTCUTS, ...keyboardShortcuts }),
    [keyboardShortcuts],
  );

  // Fire onAnnotationsChange when annotations change (skip initial render)
  const isFirstAnnotationRender = useRef(true);
  useEffect(() => {
    if (isFirstAnnotationRender.current) {
      isFirstAnnotationRender.current = false;
      return;
    }
    onAnnotationsChange?.(getAllAnnotationsFlat(annotationState));
  }, [annotationState.changeCounter]); // eslint-disable-line react-hooks/exhaustive-deps

  // Fire onConstraintChange when constraint status changes (skip initial render)
  const isFirstConstraintRender = useRef(true);
  useEffect(() => {
    if (isFirstConstraintRender.current) {
      isFirstConstraintRender.current = false;
      return;
    }
    onConstraintChange?.(constraintStatus);
  }, [constraintStatus]); // eslint-disable-line react-hooks/exhaustive-deps

  // Keyboard handler
  useKeyboard(
    mergedShortcuts,
    activeToolKeyHandlerRef,
    actions,
    uiState,
    activeImageId,
    constraintStatus,
    shouldSkipKeyboardShortcutPredicate,
  );

  const value = useMemo<AnnotatorContextValue>(
    () => ({
      annotationState,
      uiState,
      contextState,
      constraintStatus,
      actions,
      activeToolKeyHandlerRef,
      shortcuts: mergedShortcuts,
      activeImageId,
      testMode,
    }),
    [
      annotationState,
      uiState,
      contextState,
      constraintStatus,
      actions,
      activeToolKeyHandlerRef,
      mergedShortcuts,
      activeImageId,
      testMode,
    ],
  );

  return <AnnotatorContext.Provider value={value}>{children}</AnnotatorContext.Provider>;
}

export function useAnnotator() {
  const context = useContext(AnnotatorContext);
  if (!context) {
    throw new Error('useAnnotator must be used within an AnnotatorProvider');
  }
  return context;
}
