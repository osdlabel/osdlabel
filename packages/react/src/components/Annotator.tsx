import { useEffect, type ReactNode, type CSSProperties } from 'react';
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
  readonly style?: CSSProperties | undefined;
  /** Whether to show the FPS counter (default: false) */
  readonly showFps?: boolean | undefined;
  /** Other children of the provider. */
  readonly providerChildren?: ReactNode | undefined;
}

function AnnotatorSetup({
  contexts,
  displayedContextIds,
}: {
  readonly contexts: readonly AnnotationContext[];
  readonly displayedContextIds?: readonly AnnotationContextId[] | undefined;
}) {
  const { actions } = useAnnotator();

  // Initialize contexts on mount
  useEffect(() => {
    actions.setContexts([...contexts]);
    if (contexts.length > 0) {
      actions.setActiveContext(contexts[0]!.id);
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps -- mount-only: contexts are initial config, not reactive props

  // Sync displayed context IDs
  useEffect(() => {
    actions.setDisplayedContexts(displayedContextIds ? [...displayedContextIds] : []);
  }, [displayedContextIds]); // eslint-disable-line react-hooks/exhaustive-deps -- actions is stable (useMemo with [])

  return null;
}

function AnnotatorInner({
  images,
  showFilmstrip: showFilmstripProp,
  showGridControls: showGridControlsProp,
  showContextSwitcher: showContextSwitcherProp,
  showViewControls: showViewControlsProp,
  filmstripPosition: filmstripPositionProp,
  maxGridSize,
  style,
  showFps,
}: Omit<AnnotatorProps, keyof AnnotatorProviderProps>) {
  const { uiState } = useAnnotator();

  const activeImageId = uiState.gridAssignments[uiState.activeCellIndex];
  const filmstripPosition = filmstripPositionProp ?? 'left';
  const showFilmstrip = showFilmstripProp !== false;
  const showGridControls = showGridControlsProp === true;
  const showContextSwitcher = showContextSwitcherProp === true;
  const showViewControls = showViewControlsProp !== false;
  const maxCols = maxGridSize?.columns ?? 4;
  const maxRows = maxGridSize?.rows ?? 4;
  const isHorizontalFilmstrip = filmstripPosition === 'bottom';

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        width: '100%',
        height: '100%',
        ...style,
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '12px',
          background: '#1a1a1a',
          padding: '4px 8px',
        }}
      >
        <Toolbar />
        {showViewControls && <ViewControls />}
        {showContextSwitcher && <ContextSwitcher label="Context:" />}
        {showGridControls && (
          <div style={{ marginLeft: 'auto' }}>
            <GridControls maxColumns={maxCols} maxRows={maxRows} />
          </div>
        )}
      </div>
      <div
        style={{
          display: 'flex',
          flexDirection: isHorizontalFilmstrip ? 'column' : 'row',
          flex: '1',
          minHeight: '0',
        }}
      >
        {showFilmstrip && filmstripPosition === 'left' && (
          <Filmstrip images={images} position="left" />
        )}
        <div style={{ flex: '1', minWidth: '0', minHeight: '0' }}>
          <GridView
            columns={uiState.gridColumns}
            rows={uiState.gridRows}
            maxColumns={maxCols}
            maxRows={maxRows}
            images={images}
          />
        </div>
        {showFilmstrip && filmstripPosition === 'right' && (
          <Filmstrip images={images} position="right" />
        )}
        {showFilmstrip && filmstripPosition === 'bottom' && (
          <Filmstrip images={images} position="bottom" />
        )}
      </div>
      <StatusBar imageId={activeImageId} showFps={showFps} />
    </div>
  );
}

export default function Annotator({
  images,
  contexts,
  displayedContextIds,
  showFilmstrip,
  showGridControls,
  showContextSwitcher,
  showViewControls,
  filmstripPosition,
  maxGridSize,
  style,
  showFps,
  providerChildren,
  ...providerProps
}: AnnotatorProps) {
  return (
    <AnnotatorProvider {...providerProps}>
      <AnnotatorSetup contexts={contexts} displayedContextIds={displayedContextIds} />
      <AnnotatorInner
        images={images}
        contexts={contexts}
        showFilmstrip={showFilmstrip}
        showGridControls={showGridControls}
        showContextSwitcher={showContextSwitcher}
        showViewControls={showViewControls}
        filmstripPosition={filmstripPosition}
        maxGridSize={maxGridSize}
        style={style}
        showFps={showFps}
      />
      {providerChildren}
    </AnnotatorProvider>
  );
}
