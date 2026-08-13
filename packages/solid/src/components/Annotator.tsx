import { createEffect, Show, type Component, type JSX } from 'solid-js';
import { AnnotatorProvider } from '../state/annotator-context.js';
import type { AnnotatorProviderProps } from '../state/annotator-context.js';
import { useAnnotator } from '../state/annotator-context.js';
import Toolbar from './Toolbar.js';
import StatusBar from './StatusBar.js';
import GridView from './GridView.js';
import Filmstrip from './Filmstrip.js';
import GridControls from './GridControls.js';
import ContextSwitcher from './ContextSwitcher.js';
import { ViewControls } from './ViewControls.js';
import type { ImageSource } from '@osdlabel/viewer-api';
import type { AnnotationContext, AnnotationContextId } from '@osdlabel/annotation-context';

export interface AnnotatorProps extends Omit<AnnotatorProviderProps, 'children'> {
  /** Available images for annotation */
  readonly images: readonly ImageSource[];
  /** Annotation contexts defining tool constraints */
  readonly contexts: readonly AnnotationContext[];
  /** Context IDs whose annotations should be displayed (active context is always displayed) */
  readonly displayedContextIds?: readonly AnnotationContextId[] | undefined;
  /** Whether to show the filmstrip sidebar (default: true) */
  readonly showFilmstrip?: boolean | undefined;
  /** Whether to show the grid controls (default: false) */
  readonly showGridControls?: boolean | undefined;
  /** Whether to show the context switcher (default: false) */
  readonly showContextSwitcher?: boolean | undefined;
  /** Whether to show the view controls (default: true) */
  readonly showViewControls?: boolean | undefined;
  /** Filmstrip position (default: 'left') */
  readonly filmstripPosition?: 'left' | 'right' | 'bottom' | undefined;
  /** Maximum grid dimensions */
  readonly maxGridSize?: { readonly columns: number; readonly rows: number } | undefined;
  /** Custom style for the root container */
  readonly style?: JSX.CSSProperties | undefined;
  /** Whether to show the FPS counter (default: false) */
  readonly showFps?: boolean | undefined;
  /** Other children of the provider. */
  readonly providerChildren?: JSX.Element | undefined;
}

const AnnotatorInner: Component<Omit<AnnotatorProps, keyof AnnotatorProviderProps>> = (props) => {
  const { uiState } = useAnnotator();

  const activeImageId = () => {
    const cellIndex = uiState.activeCellIndex;
    return uiState.gridAssignments[cellIndex];
  };

  const filmstripPosition = () => props.filmstripPosition ?? 'left';
  const showFilmstrip = () => props.showFilmstrip !== false;
  const showGridControls = () => props.showGridControls === true;
  const showContextSwitcher = () => props.showContextSwitcher === true;
  const showViewControls = () => props.showViewControls !== false;
  const maxCols = () => props.maxGridSize?.columns ?? 4;
  const maxRows = () => props.maxGridSize?.rows ?? 4;

  const isHorizontalFilmstrip = () => filmstripPosition() === 'bottom';

  return (
    <div
      style={{
        display: 'flex',
        'flex-direction': 'column',
        width: '100%',
        height: '100%',
        ...props.style,
      }}
    >
      <div
        style={{
          display: 'flex',
          'align-items': 'center',
          gap: '12px',
          background: '#1a1a1a',
          padding: '4px 8px',
        }}
      >
        <Toolbar />
        {showViewControls() && <ViewControls />}
        {showContextSwitcher() && <ContextSwitcher label="Context:" />}
        {showGridControls() && (
          <div style={{ 'margin-left': 'auto' }}>
            <GridControls maxColumns={maxCols()} maxRows={maxRows()} />
          </div>
        )}
      </div>
      <div
        style={{
          display: 'flex',
          'flex-direction': isHorizontalFilmstrip() ? 'column' : 'row',
          flex: '1',
          'min-height': '0',
        }}
      >
        {showFilmstrip() && filmstripPosition() === 'left' && (
          <Filmstrip images={props.images} position="left" />
        )}
        <div style={{ flex: '1', 'min-width': '0', 'min-height': '0' }}>
          <GridView
            columns={uiState.gridColumns}
            rows={uiState.gridRows}
            maxColumns={maxCols()}
            maxRows={maxRows()}
            images={props.images}
          />
        </div>
        {showFilmstrip() && filmstripPosition() === 'right' && (
          <Filmstrip images={props.images} position="right" />
        )}
        {showFilmstrip() && filmstripPosition() === 'bottom' && (
          <Filmstrip images={props.images} position="bottom" />
        )}
      </div>
      <StatusBar imageId={activeImageId()} showFps={props.showFps} />
    </div>
  );
};

const Annotator: Component<AnnotatorProps> = (props) => {
  return (
    <AnnotatorProvider
      initialAnnotations={props.initialAnnotations}
      onAnnotationsChange={props.onAnnotationsChange}
      onConstraintChange={props.onConstraintChange}
      keyboardShortcuts={props.keyboardShortcuts}
      vertexEditLongPressMs={props.vertexEditLongPressMs}
      vertexEditMoveTolerancePx={props.vertexEditMoveTolerancePx}
      shouldSkipKeyboardShortcutPredicate={props.shouldSkipKeyboardShortcutPredicate}
      testMode={props.testMode}
      decorationProviders={props.decorationProviders}
      defaultPixelSpacing={props.defaultPixelSpacing}
      renderDomDecoration={props.renderDomDecoration}
      segmentationProvider={props.segmentationProvider}
    >
      <AnnotatorSetup contexts={props.contexts} displayedContextIds={props.displayedContextIds} />
      <AnnotatorInner
        images={props.images}
        contexts={props.contexts}
        showFilmstrip={props.showFilmstrip}
        showGridControls={props.showGridControls}
        showContextSwitcher={props.showContextSwitcher}
        showViewControls={props.showViewControls}
        filmstripPosition={props.filmstripPosition}
        maxGridSize={props.maxGridSize}
        style={props.style}
        showFps={props.showFps}
      />
      <Show when={props.providerChildren}>{props.providerChildren}</Show>
    </AnnotatorProvider>
  );
};

/** Initializes contexts inside the provider (runs once) */
const AnnotatorSetup: Component<{
  readonly contexts: readonly AnnotationContext[];
  readonly displayedContextIds?: readonly AnnotationContextId[] | undefined;
}> = (props) => {
  const { actions } = useAnnotator();
  actions.setContexts([...props.contexts]);
  if (props.contexts.length > 0) {
    actions.setActiveContext(props.contexts[0]!.id);
  }

  createEffect(() => {
    actions.setDisplayedContexts(props.displayedContextIds ? [...props.displayedContextIds] : []);
  });

  return null;
};

export default Annotator;
