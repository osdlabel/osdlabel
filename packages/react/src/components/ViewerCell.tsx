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
import { openImage } from '@osdlabel/osd-helper';
import { useAnnotationTool } from '../hooks/useAnnotationTool.js';
import { useAnnotator } from '../state/annotator-context.js';
import type { Annotation } from '@osdlabel/annotation';
import type { OsdFields } from 'osdlabel';
import { enableLiveDecorationUpdates } from 'osdlabel';

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
      element: containerRef.current,
      prefixUrl: '',
      showNavigationControl: false,
      animationTime: 0.3,
      minZoomLevel: 0.5,
      maxZoomLevel: 40,
      visibilityRatio: 0.5,
      constrainDuringPan: true,
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

  // Watch for image source changes
  const prevTileSourceRef = useRef(imageSource?.tileSource);
  useEffect(() => {
    const url = imageSource?.tileSource;
    if (url !== prevTileSourceRef.current && viewerRef.current) {
      viewerRef.current.close();
      if (imageSource) {
        openImage(viewerRef.current, imageSource);
      }
    }
    prevTileSourceRef.current = url;
  }, [imageSource?.tileSource]); // eslint-disable-line react-hooks/exhaustive-deps

  // Sync view transforms
  useEffect(() => {
    if (!overlay || !imageSource?.id) return;
    const cellTransform = uiState.cellTransforms[cellIndex] ?? DEFAULT_CELL_TRANSFORM;
    overlay.applyViewTransform(cellTransform);
    overlay.applyImageFilters(cellTransform.exposure, cellTransform.inverted);
  }, [overlay, imageSource?.id, cellIndex, uiState.cellTransforms]);

  // Annotation tool hook
  useAnnotationTool(overlay, imageSource?.id, isActive, imageSource);

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

    const imageId = imageSource.id;
    const activeContextId = contextState.activeContextId;
    const matching = visibleAnnotations;

    // Clear existing annotation objects
    const toRemove = overlay.canvas.getObjects().filter((obj) => obj.id);
    if (toRemove.length > 0) overlay.canvas.remove(...toRemove);

    const capturedImageId = imageId;
    void (async () => {
      if (imageSource?.id !== capturedImageId) return;

      const promises = matching.map(async (ann) => {
        const obj = await createFabricObjectFromRawData(ann);
        if (obj) {
          const isActiveCtx = ann.contextId === activeContextId;
          obj._readOnly = !isActiveCtx;
          obj.set({
            selectable: isActiveCtx,
            evented: isActiveCtx,
          });
        }
        return obj;
      });
      const objects = await Promise.all(promises);
      const validObjects = objects.filter((obj) => obj !== null);
      if (validObjects.length > 0) {
        overlay.canvas.add(...validObjects);
      }
      if (containerRef.current) {
        containerRef.current.dataset.annotationCount = String(validObjects.length);
      }
      overlay.canvas.requestRenderAll();
    })();
  }, [
    overlay,
    imageSource?.id,
    contextState.activeContextId,
    contextState.displayedContextIds,
    isActive,
    visibleAnnotations,
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
