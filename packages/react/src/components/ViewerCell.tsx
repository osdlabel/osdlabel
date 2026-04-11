import { useEffect, useRef, useState } from 'react';
import OpenSeadragon from 'openseadragon';
import { FabricOverlay } from '@osdlabel/fabric-osd';
import { createFabricObjectFromRawData } from '@osdlabel/fabric-annotations';
import type { OverlayMode } from '@osdlabel/fabric-osd';
import type { AnnotationContextId } from '@osdlabel/annotation-context';
import { DEFAULT_CELL_TRANSFORM } from '@osdlabel/viewer-api';
import type { ImageSource } from '@osdlabel/viewer-api';
import { openImage } from '@osdlabel/osd-helper';
import { useAnnotationTool } from '../hooks/useAnnotationTool.js';
import { useAnnotator } from '../state/annotator-context.js';

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
  const { uiState, annotationState, contextState, testMode } = useAnnotator();
  const containerRef = useRef<HTMLDivElement>(null);
  const viewerRef = useRef<OpenSeadragon.Viewer | undefined>(undefined);
  const [overlay, setOverlay] = useState<FabricOverlay>();

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
      if (!viewerRef.current) return;
      const ov = new FabricOverlay(viewerRef.current, { testMode });
      setOverlay(ov);
      onOverlayReady?.(ov);
    });

    // Open initial image if provided
    if (imageSource) {
      openImage(viewer, imageSource);
    }

    return () => {
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
  useAnnotationTool(overlay, imageSource?.id, isActive);

  // Sync annotations to canvas
  useEffect(() => {
    if (!overlay || !imageSource?.id) return;

    const imageId = imageSource.id;
    const activeContextId = contextState.activeContextId;
    const displayedIds = contextState.displayedContextIds;

    const visibleSet = new Set<AnnotationContextId>(displayedIds);
    if (activeContextId) visibleSet.add(activeContextId);

    const imageAnns = annotationState.byImage[imageId] || {};
    const matching =
      visibleSet.size > 0
        ? Object.values(imageAnns).filter((a) => visibleSet.has(a.contextId))
        : Object.values(imageAnns);

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
    annotationState,
    contextState.activeContextId,
    contextState.displayedContextIds,
    isActive,
  ]);

  return (
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
  );
}
