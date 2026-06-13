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
import type {
  ImageId,
  AnnotationState,
  KeyboardShortcutMap,
  PixelSpacing,
  UIState,
} from '@osdlabel/viewer-api';
import { getAllAnnotationsFlat } from '@osdlabel/viewer-api';
import type { ConstraintStatus, ContextState } from '@osdlabel/annotation-context';
import type { DecorationProvider, DomDecoration } from '@osdlabel/decoration';
import type { OsdAnnotation, OsdFields, SegmentationProvider, VertexEditConfig } from 'osdlabel';
import {
  DEFAULT_KEYBOARD_SHORTCUTS,
  DEFAULT_VERTEX_EDIT_LONG_PRESS_MS,
  DEFAULT_VERTEX_EDIT_MOVE_TOLERANCE_PX,
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
  vertexEditConfig: VertexEditConfig;
  activeImageId: ImageId | undefined;
  testMode: boolean;
  decorationProviders: readonly DecorationProvider<OsdFields>[];
  defaultPixelSpacing: PixelSpacing | undefined;
  renderDomDecoration: ((decoration: DomDecoration) => ReactNode) | undefined;
  segmentationProvider: SegmentationProvider | undefined;
}

const AnnotatorContext = createContext<AnnotatorContextValue | null>(null);

export interface AnnotatorProviderProps {
  readonly children: ReactNode;
  readonly initialAnnotations?: Record<ImageId, Record<AnnotationId, OsdAnnotation>> | undefined;
  readonly onAnnotationsChange?: ((annotations: OsdAnnotation[]) => void) | undefined;
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
  readonly shouldSkipKeyboardShortcutPredicate?: ((target: HTMLElement) => boolean) | undefined;
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
   * (via a React portal, so the tree shares this provider's context). Receives
   * the `DomDecoration` and returns the React node to mount.
   */
  readonly renderDomDecoration?: ((decoration: DomDecoration) => ReactNode) | undefined;
  /**
   * Injected auto-segmentation backend (Segment Anything-style). Required for
   * the `'segmentation'` tool to be active; when omitted, selecting the tool is
   * a no-op.
   */
  readonly segmentationProvider?: SegmentationProvider | undefined;
}

export function AnnotatorProvider({
  children,
  initialAnnotations,
  onAnnotationsChange,
  onConstraintChange,
  keyboardShortcuts,
  vertexEditLongPressMs,
  vertexEditMoveTolerancePx,
  shouldSkipKeyboardShortcutPredicate,
  testMode = false,
  decorationProviders,
  defaultPixelSpacing,
  renderDomDecoration,
  segmentationProvider,
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
  const annotationStateRef = useRef(annotationState);
  annotationStateRef.current = annotationState;

  const actions = useMemo(
    () =>
      createActions(
        dispatchAnnotation,
        dispatchUI,
        dispatchContext,
        () => contextStateRef.current,
        () => uiStateRef.current,
        () => annotationStateRef.current,
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
  const vertexEditConfig = useMemo<VertexEditConfig>(
    () => ({
      longPressMs: vertexEditLongPressMs ?? DEFAULT_VERTEX_EDIT_LONG_PRESS_MS,
      moveTolerancePx: vertexEditMoveTolerancePx ?? DEFAULT_VERTEX_EDIT_MOVE_TOLERANCE_PX,
    }),
    [vertexEditLongPressMs, vertexEditMoveTolerancePx],
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

  const stableDecorationProviders = useMemo(() => decorationProviders ?? [], [decorationProviders]);

  const value = useMemo<AnnotatorContextValue>(
    () => ({
      annotationState,
      uiState,
      contextState,
      constraintStatus,
      actions,
      activeToolKeyHandlerRef,
      shortcuts: mergedShortcuts,
      vertexEditConfig,
      activeImageId,
      testMode,
      decorationProviders: stableDecorationProviders,
      defaultPixelSpacing,
      renderDomDecoration,
      segmentationProvider,
    }),
    [
      annotationState,
      uiState,
      contextState,
      constraintStatus,
      actions,
      activeToolKeyHandlerRef,
      mergedShortcuts,
      vertexEditConfig,
      activeImageId,
      testMode,
      stableDecorationProviders,
      defaultPixelSpacing,
      renderDomDecoration,
      segmentationProvider,
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
