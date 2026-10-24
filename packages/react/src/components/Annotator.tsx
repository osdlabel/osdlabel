import {
  useCallback,
  useEffect,
  type ComponentType,
  type ReactNode,
  type CSSProperties,
} from 'react';
import { AnnotatorProvider } from '../state/annotator-context.js';
import type { AnnotatorProviderProps } from '../state/annotator-context.js';
import { useAnnotator } from '../state/annotator-context.js';
import Toolbar, { useToolbarSlotProps } from './Toolbar.js';
import StatusBar from './StatusBar.js';
import GridView from './GridView.js';
import Filmstrip from './Filmstrip.js';
import GridControls from './GridControls.js';
import ContextSwitcher from './ContextSwitcher.js';
import { ViewControls } from './ViewControls.js';
import type { ImageSource } from '@osdlabel/viewer-api';
import type { AnnotationContext, AnnotationContextId } from '@osdlabel/annotation-context';
import { OSDLABEL_PARTS, themeVar } from 'osdlabel';
import type { AnnotatorSlotName, AnnotatorSlotPropsMap, ToolbarSlotProps } from 'osdlabel';

/**
 * Replacement components for the stock layout's override points, keyed by the
 * shared slot names; each receives that slot's shared props contract.
 */
export type AnnotatorComponents = {
  readonly [K in AnnotatorSlotName]?: ComponentType<AnnotatorSlotPropsMap[K]> | undefined;
};

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
  /** Whether to show the fullscreen toggle inside the view controls (default: true) */
  readonly showFullscreenControl?: boolean | undefined;
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
  /** Components replacing parts of the stock layout; see {@link AnnotatorComponents}. */
  readonly components?: AnnotatorComponents | undefined;
}

/** Renders an override toolbar with the stock toolbar's model and commands. */
function ToolbarOverride({
  component: Override,
}: {
  readonly component: ComponentType<ToolbarSlotProps>;
}) {
  return <Override {...useToolbarSlotProps()} />;
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
  }, [displayedContextIds]); // eslint-disable-line react-hooks/exhaustive-deps -- actions is stable (memoised on the provider's store)

  return null;
}

function AnnotatorInner({
  images,
  showFilmstrip: showFilmstripProp,
  showGridControls: showGridControlsProp,
  showContextSwitcher: showContextSwitcherProp,
  showViewControls: showViewControlsProp,
  showFullscreenControl,
  filmstripPosition: filmstripPositionProp,
  maxGridSize,
  style,
  showFps,
  components,
}: Omit<AnnotatorProps, keyof AnnotatorProviderProps>) {
  const { uiState, fullscreenTargetRef, activeImageId } = useAnnotator();

  // React calls a ref callback with null on unmount, so no explicit cleanup.
  const setRootRef = useCallback(
    (el: HTMLDivElement | null) => {
      fullscreenTargetRef.element = el;
    },
    [fullscreenTargetRef],
  );

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
      ref={setRootRef}
      data-testid="annotator-root"
      part={OSDLABEL_PARTS.root}
      style={{
        display: 'flex',
        flexDirection: 'column',
        width: '100%',
        height: '100%',
        // The root painted nothing of its own, so in fullscreen the black
        // ::backdrop showed through wherever the flex children did not reach.
        // Matches the toolbar bar so the annotator reads as one surface.
        background: themeVar('surface'),
        ...style,
      }}
    >
      <div
        part={OSDLABEL_PARTS.toolbarBar}
        style={{
          display: 'flex',
          // Wrap rather than overflow: the root does not scroll, so controls
          // pushed past its right edge were clipped and unreachable (#147).
          flexWrap: 'wrap',
          alignItems: 'center',
          gap: '4px 12px',
          background: themeVar('surface'),
          padding: '4px 8px',
        }}
      >
        {components?.Toolbar ? <ToolbarOverride component={components.Toolbar} /> : <Toolbar />}
        {/* Sits next to the tools rather than pinned to the right edge with
            `marginLeft: auto`: its grid popover opens rightward from the
            button, so anchoring it at the edge clipped it whenever the
            annotator container was narrow. */}
        {showGridControls && <GridControls maxColumns={maxCols} maxRows={maxRows} />}
        {showViewControls && <ViewControls showFullscreenControl={showFullscreenControl} />}
        {showContextSwitcher && <ContextSwitcher label="Context:" />}
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
  showFullscreenControl,
  filmstripPosition,
  maxGridSize,
  style,
  showFps,
  providerChildren,
  components,
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
        showFullscreenControl={showFullscreenControl}
        filmstripPosition={filmstripPosition}
        maxGridSize={maxGridSize}
        style={style}
        showFps={showFps}
        components={components}
      />
      {providerChildren}
    </AnnotatorProvider>
  );
}
