import { onMount, onCleanup, createEffect, on, createSignal } from 'solid-js';
import type { Component } from 'solid-js';
import OpenSeadragon from 'openseadragon';
import { FabricOverlay } from '@osdlabel/fabric-osd';
import { createFabricObjectFromRawData } from '@osdlabel/fabric-annotations';
import type { OverlayMode } from '@osdlabel/fabric-osd';
import type { ImageSource } from '@osdlabel/annotation';
import type { AnnotationContextId } from '@osdlabel/annotation-context';
import { DEFAULT_CELL_TRANSFORM } from '@osdlabel/viewer-api';
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

const ViewerCell: Component<ViewerCellProps> = (props) => {
  const { uiState, annotationState, contextState, testMode } = useAnnotator();
  let containerRef: HTMLDivElement | undefined;
  let viewer: OpenSeadragon.Viewer | undefined;
  const [overlay, setOverlay] = createSignal<FabricOverlay>();

  onMount(() => {
    if (!containerRef) return;

    viewer = OpenSeadragon({
      element: containerRef,
      prefixUrl: '',
      showNavigationControl: false,
      animationTime: 0.3,
      minZoomLevel: 0.5,
      maxZoomLevel: 40,
      visibilityRatio: 0.5,
      constrainDuringPan: true,
    });

    // Suppress all OSD built-in keyboard shortcuts (arrows, WASD, +/-, f, r, etc.)
    // The app handles keyboard input via its own useKeyboard hook.
    viewer.addHandler('canvas-key', (event: { preventDefaultAction: boolean }) => {
      event.preventDefaultAction = true;
    });

    if (testMode) {
      (containerRef as unknown as Record<string, unknown>).__osdViewer = viewer;
    }

    viewer.addHandler('open', () => {
      if (!viewer || overlay()) return;
      const ov = new FabricOverlay(viewer);
      setOverlay(ov);
      props.onOverlayReady?.(ov);
    });

    // Open initial image if provided
    if (props.imageSource) {
      openImage(viewer, props.imageSource);
    }
  });

  onCleanup(() => {
    const ov = overlay();
    ov?.destroy();
    setOverlay(undefined);
    viewer?.destroy();
    viewer = undefined;
  });

  // Watch for image source changes
  createEffect(
    on(
      () => props.imageSource?.dziUrl,
      (url, prevUrl) => {
        if (url !== prevUrl && viewer) {
          viewer.close();
          if (props.imageSource) {
            openImage(viewer, props.imageSource);
          }
        }
      },
      { defer: true },
    ),
  );

  // Sync view transforms from state to canvas
  createEffect(() => {
    const ov = overlay();
    if (!ov || !props.imageSource?.id) return;

    const cellTransform = uiState.cellTransforms[props.cellIndex] ?? DEFAULT_CELL_TRANSFORM;

    ov.applyViewTransform(cellTransform);
    ov.applyImageFilters(cellTransform.exposure, cellTransform.inverted);
  });

  // Use annotation tool hook
  useAnnotationTool(
    overlay,
    () => props.imageSource?.id,
    () => props.isActive,
  );

  // Sync annotations from state to canvas (full clear-and-reload)
  createEffect(() => {
    const ov = overlay();
    const imageId = props.imageSource?.id;
    const activeContextId = contextState.activeContextId;
    const displayedIds = contextState.displayedContextIds;
    // Track this as reactive dependencies so the effect re-runs
    void props.isActive;

    if (!ov || !imageId) return;

    // Build set of all context IDs to display (active + explicitly displayed)
    const visibleSet = new Set<AnnotationContextId>(displayedIds);
    if (activeContextId) visibleSet.add(activeContextId);

    // Filter annotations by imageId + visible contexts
    const imageAnns = annotationState.byImage[imageId] || {};
    const matching =
      visibleSet.size > 0
        ? Object.values(imageAnns).filter((a) => visibleSet.has(a.contextId))
        : Object.values(imageAnns);

    // Clear all existing annotation objects from canvas
    const toRemove = ov.canvas.getObjects().filter((obj) => obj.id);
    if (toRemove.length > 0) ov.canvas.remove(...toRemove);

    // Async load from rawAnnotationData
    const capturedImageId = imageId;
    void (async () => {
      if (props.imageSource?.id !== capturedImageId) return; // stale check

      const promises = matching.map(async (ann) => {
        const obj = await createFabricObjectFromRawData(ann);
        if (obj) {
          // Only active context annotations are interactive;
          // mark non-active as _readOnly so setMode() respects it.
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
        ov.canvas.add(...validObjects);
      }
      if (containerRef) {
        containerRef.dataset.annotationCount = String(validObjects.length);
      }
      ov.canvas.requestRenderAll();
    })();
  });

  return (
    <div
      ref={containerRef}
      onClick={() => props.onActivate()}
      style={{
        width: '100%',
        height: '100%',
        position: 'relative',
        'box-sizing': 'border-box',
        border: props.isActive ? '2px solid #2196F3' : '2px solid transparent',
      }}
    />
  );
};

function openImage(viewer: OpenSeadragon.Viewer, source: ImageSource): void {
  const url = source.dziUrl;
  const isSimpleImage = /\.(jpg|jpeg|png|webp|gif|bmp)$/i.test(url);

  if (isSimpleImage) {
    viewer.open({ type: 'image', url });
  } else {
    viewer.open(url);
  }
}

export default ViewerCell;
