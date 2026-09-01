import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import OpenSeadragon from 'openseadragon';
import { DecorationLayer, FabricOverlay } from '@osdlabel/fabric-osd';
import type { DomDecorationEntry } from '@osdlabel/fabric-osd';
import { createFabricObjectFromRawData } from '@osdlabel/fabric-annotations';
import type { OverlayMode } from '@osdlabel/fabric-osd';
import type { AnnotationContextId } from '@osdlabel/annotation-context';
import { DEFAULT_CELL_TRANSFORM } from '@osdlabel/viewer-api';
import type { ImageSource } from '@osdlabel/viewer-api';
import { DEFAULT_VIEWER_OPTIONS, isSameTileSource, openImage } from '@osdlabel/osd-helper';
import { useAnnotationTool } from '../hooks/useAnnotationTool.js';
import { useAnnotator } from '../state/annotator-context.js';
import type { Annotation } from '@osdlabel/annotation';
import type { OsdFields } from 'osdlabel';
import {
  enableLiveDecorationUpdates,
  reportAnnotationRenderFailures,
  settleAnnotationObjects,
} from 'osdlabel';

export interface ViewerCellProps {
  readonly imageSource: ImageSource | undefined;
  readonly isActive: boolean;
  readonly cellIndex: number;
  readonly mode?: OverlayMode;
  readonly onActivate: () => void;
  readonly onOverlayReady?: (overlay: FabricOverlay) => void;
}

export default function ViewerCell({
  imageSource,
  isActive,
  cellIndex,
  onActivate,
  onOverlayReady,
}: ViewerCellProps) {
  const {
    uiState,
    annotationState,
    contextState,
    testMode,
    decorationProviders,
    defaultPixelSpacing,
    renderDomDecoration,
    reportAnnotationRenderError,
  } = useAnnotator();
  const containerRef = useRef<HTMLDivElement>(null);
  const viewerRef = useRef<OpenSeadragon.Viewer | undefined>(undefined);
  const overlayRef = useRef<FabricOverlay | undefined>(undefined);
  const decorationLayerRef = useRef<DecorationLayer | undefined>(undefined);
  const [overlay, setOverlay] = useState<FabricOverlay>();
  const [domEntries, setDomEntries] = useState<readonly DomDecorationEntry[]>([]);

  // Initialize OSD viewer on mount
  useEffect(() => {
    if (!containerRef.current) return;

    const viewer = OpenSeadragon({
      ...DEFAULT_VIEWER_OPTIONS,
      element: containerRef.current,
    });
    viewerRef.current = viewer;

    viewer.addHandler('open', () => {
      if (!viewerRef.current || overlayRef.current) return;
      const ov = new FabricOverlay(viewerRef.current, { testMode });
      overlayRef.current = ov;
      decorationLayerRef.current = new DecorationLayer(ov);
      setOverlay(ov);
      onOverlayReady?.(ov);
    });

    // Open initial image if provided
    if (imageSource) {
      openImage(viewer, imageSource);
    }

    return () => {
      decorationLayerRef.current?.destroy();
      decorationLayerRef.current = undefined;
      overlayRef.current?.destroy();
      overlayRef.current = undefined;
      setOverlay(undefined);
      viewer.destroy();
      viewerRef.current = undefined;
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Watch for image source changes. Compared by value against what is shown,
  // so an equal tile-source object re-created on a host render does not
  // reload the image (#83). As in Solid, the shown source advances only when
  // the image is reloaded.
  const shownTileSourceRef = useRef(imageSource?.tileSource);
  useEffect(() => {
    const tileSource = imageSource?.tileSource;
    if (isSameTileSource(tileSource, shownTileSourceRef.current)) return;
    shownTileSourceRef.current = tileSource;
    if (viewerRef.current) {
      viewerRef.current.close();
      if (imageSource) {
        openImage(viewerRef.current, imageSource);
      }
    }
  }, [imageSource?.tileSource]); // eslint-disable-line react-hooks/exhaustive-deps

  // Sync view transforms
  useEffect(() => {
    if (!overlay || !imageSource?.id) return;
    const cellTransform = uiState.cellTransforms[cellIndex] ?? DEFAULT_CELL_TRANSFORM;
    overlay.applyViewTransform(cellTransform);
    overlay.applyImageFilters(cellTransform);
  }, [overlay, imageSource?.id, cellIndex, uiState.cellTransforms]);

  // Annotation tool hook
  useAnnotationTool(overlay, imageSource?.id, isActive);

  // Track only the annotation dictionary for this cell's image. Immer keeps
  // structural sharing, so this reference only changes when annotations on
  // THIS image mutate — drawing in another cell does not refire the memo
  // or effects below.
  const currentImageAnns = imageSource?.id ? annotationState.byImage[imageSource.id] : undefined;

  // Visible annotations for the current cell — shared by the annotation
  // sync effect (Fabric objects) and the decoration sync effect.
  const visibleAnnotations: readonly Annotation<OsdFields>[] = useMemo(() => {
    if (!currentImageAnns) return [];
    const activeContextId = contextState.activeContextId;
    const displayedIds = contextState.displayedContextIds;
    const visibleSet = new Set<AnnotationContextId>(displayedIds);
    if (activeContextId) visibleSet.add(activeContextId);
    return visibleSet.size > 0
      ? Object.values(currentImageAnns).filter((a) => visibleSet.has(a.contextId))
      : Object.values(currentImageAnns);
  }, [currentImageAnns, contextState.activeContextId, contextState.displayedContextIds]);

  // Sync annotations to canvas
  useEffect(() => {
    if (!overlay || !imageSource?.id) return;

    const activeContextId = contextState.activeContextId;
    const matching = visibleAnnotations;

    // Clear existing annotation objects
    const toRemove = overlay.canvas.getObjects().filter((obj) => obj.id);
    if (toRemove.length > 0) overlay.canvas.remove(...toRemove);

    // Rebuilding is asynchronous, so by the time this run's objects are ready
    // a newer run may have cleared the canvas and started its own rebuild
    // (#160), or the cell may have unmounted and destroyed the overlay (#190).
    // Either way this effect's cleanup has run; adding now would duplicate
    // objects or touch a disposed canvas, so a cancelled run adds nothing.
    let cancelled = false;
    void (async () => {
      const { objects, failures } = await settleAnnotationObjects(matching, async (ann) => {
        const obj = await createFabricObjectFromRawData(ann);
        if (obj) {
          // Only active-context annotations may be interactive; mark the rest
          // `_readOnly` so setMode() keeps them inert too.
          //
          // Interactivity itself is the overlay's call, not ours: the current
          // mode decides. Setting `selectable`/`evented` here directly used to
          // undo `paint` mode on the first rebuild, so a brush stroke over a
          // shape started dragging it again after the first commit.
          const isActiveCtx = ann.contextId === activeContextId;
          obj._readOnly = !isActiveCtx;
          overlay.applyModeToObject(obj, !isActiveCtx);
        }
        return obj;
      });
      if (cancelled) return;
      if (objects.length > 0) {
        overlay.canvas.add(...objects);
      }
      if (containerRef.current) {
        containerRef.current.dataset.annotationCount = String(objects.length);
      }
      overlay.canvas.requestRenderAll();
      // Each annotation is built on its own, so one that cannot be revived is
      // skipped and reported instead of leaving the whole image empty (#209).
      reportAnnotationRenderFailures(failures, reportAnnotationRenderError);
    })();
    return () => {
      cancelled = true;
    };
  }, [
    overlay,
    imageSource?.id,
    contextState.activeContextId,
    contextState.displayedContextIds,
    isActive,
    visibleAnnotations,
    reportAnnotationRenderError,
  ]);

  // Sync decorations to overlay (pure derivation of visible annotations +
  // pixelSpacing + providers).
  useEffect(() => {
    const layer = decorationLayerRef.current;
    if (!layer) return;
    if (!decorationProviders || decorationProviders.length === 0) {
      layer.setDecorations([]);
      return;
    }
    const pixelSpacing = imageSource?.pixelSpacing ?? defaultPixelSpacing;
    const selectedAnnotationId = uiState.selectedAnnotationId;
    const ctx = { annotations: visibleAnnotations, pixelSpacing, selectedAnnotationId };
    const decorations = decorationProviders.flatMap((p) => p(ctx));
    layer.setDecorations(decorations);
  }, [
    overlay,
    visibleAnnotations,
    defaultPixelSpacing,
    imageSource?.pixelSpacing,
    uiState.selectedAnnotationId,
    decorationProviders,
  ]);

  // Live-update decorations during Fabric drag. Accessors close over refs
  // so each rAF tick observes the latest reactive state without resubscribing.
  const visibleAnnotationsRef = useRef(visibleAnnotations);
  visibleAnnotationsRef.current = visibleAnnotations;
  const decorationProvidersRef = useRef(decorationProviders);
  decorationProvidersRef.current = decorationProviders;
  const pixelSpacingRef = useRef<typeof defaultPixelSpacing>(undefined);
  pixelSpacingRef.current = imageSource?.pixelSpacing ?? defaultPixelSpacing;
  const selectedIdRef = useRef(uiState.selectedAnnotationId);
  selectedIdRef.current = uiState.selectedAnnotationId;
  useEffect(() => {
    const layer = decorationLayerRef.current;
    if (!overlay || !layer) return;
    return enableLiveDecorationUpdates<OsdFields>({
      overlay,
      getVisibleAnnotations: () => visibleAnnotationsRef.current,
      getPixelSpacing: () => pixelSpacingRef.current,
      getSelectedAnnotationId: () => selectedIdRef.current,
      getProviders: () => decorationProvidersRef.current ?? [],
      onDecorations: (decorations) => layer.setDecorations(decorations),
    });
  }, [overlay]);

  // Track DOM-decoration roots created by the layer. The subscription fires on
  // membership change only; content is rendered via portals into the stable
  // div the layer owns and positions.
  useEffect(() => {
    const layer = decorationLayerRef.current;
    if (!overlay || !layer) return;
    return layer.onDomDecorations(setDomEntries);
  }, [overlay]);

  return (
    <>
      <div
        ref={containerRef}
        onClick={() => onActivate()}
        style={{
          width: '100%',
          height: '100%',
          position: 'relative',
          boxSizing: 'border-box',
          border: isActive ? '2px solid #2196F3' : '2px solid transparent',
        }}
      />
      {renderDomDecoration &&
        domEntries.map((entry) =>
          createPortal(renderDomDecoration(entry.decoration), entry.element, entry.id),
        )}
    </>
  );
}
