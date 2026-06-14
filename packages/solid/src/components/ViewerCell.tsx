import { onMount, onCleanup, createEffect, on, createSignal, For } from 'solid-js';
import { Portal } from 'solid-js/web';
import type { Component } from 'solid-js';
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

const ViewerCell: Component<ViewerCellProps> = (props) => {
  const {
    uiState,
    annotationState,
    contextState,
    testMode,
    decorationProviders,
    defaultPixelSpacing,
    renderDomDecoration,
  } = useAnnotator();
  let containerRef: HTMLDivElement | undefined;
  let viewer: OpenSeadragon.Viewer | undefined;
  const [overlay, setOverlay] = createSignal<FabricOverlay>();
  const [decorationLayer, setDecorationLayer] = createSignal<DecorationLayer>();
  const [domEntries, setDomEntries] = createSignal<readonly DomDecorationEntry[]>([]);

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

    viewer.addHandler('open', () => {
      if (!viewer || overlay()) return;
      const ov = new FabricOverlay(viewer, { testMode });
      setOverlay(ov);
      setDecorationLayer(new DecorationLayer(ov));
      props.onOverlayReady?.(ov);
    });

    // Open initial image if provided
    if (props.imageSource) {
      openImage(viewer, props.imageSource);
    }
  });

  onCleanup(() => {
    decorationLayer()?.destroy();
    setDecorationLayer(undefined);
    const ov = overlay();
    ov?.destroy();
    setOverlay(undefined);
    viewer?.destroy();
    viewer = undefined;
  });

  // Watch for image source changes
  createEffect(
    on(
      () => props.imageSource?.tileSource,
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
    () => props.imageSource,
  );

  // Compute visible annotations for the current cell — used by both the
  // annotation sync effect (Fabric objects) and the decoration sync effect
  // (text + line decorations).
  const visibleAnnotations = (): readonly Annotation<OsdFields>[] => {
    const imageId = props.imageSource?.id;
    if (!imageId) return [];
    const activeContextId = contextState.activeContextId;
    const displayedIds = contextState.displayedContextIds;
    const visibleSet = new Set<AnnotationContextId>(displayedIds);
    if (activeContextId) visibleSet.add(activeContextId);
    const imageAnns = annotationState.byImage[imageId] || {};
    return visibleSet.size > 0
      ? Object.values(imageAnns).filter((a) => visibleSet.has(a.contextId))
      : Object.values(imageAnns);
  };

  // Sync annotations from state to canvas (full clear-and-reload)
  createEffect(() => {
    const ov = overlay();
    const imageId = props.imageSource?.id;
    const activeContextId = contextState.activeContextId;
    // Track this as reactive dependencies so the effect re-runs
    void props.isActive;
    void contextState.displayedContextIds;

    if (!ov || !imageId) return;

    const matching = visibleAnnotations();

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

  // Sync decorations from state to canvas. Pure derivation: runs providers
  // over visible annotations + the current image's pixelSpacing.
  createEffect(() => {
    const layer = decorationLayer();
    if (!layer) return;
    // Track dependencies
    void annotationState.changeCounter;
    void contextState.activeContextId;
    void contextState.displayedContextIds;
    const providers = decorationProviders;
    if (!providers || providers.length === 0) {
      layer.setDecorations([]);
      return;
    }
    const annotations = visibleAnnotations();
    const pixelSpacing = props.imageSource?.pixelSpacing ?? defaultPixelSpacing;
    const selectedAnnotationId = uiState.selectedAnnotationId;
    const ctx = { annotations, pixelSpacing, selectedAnnotationId };
    const decorations = providers.flatMap((p) => p(ctx));
    layer.setDecorations(decorations);
  });

  // Live-update decorations during Fabric drag (object:moving/scaling/rotating).
  // The accessors close over reactive state so each rAF tick sees the latest
  // visible annotations, providers, and pixel spacing.
  createEffect(() => {
    const ov = overlay();
    const layer = decorationLayer();
    if (!ov || !layer) return;
    const dispose = enableLiveDecorationUpdates<OsdFields>({
      overlay: ov,
      getVisibleAnnotations: visibleAnnotations,
      getPixelSpacing: () => props.imageSource?.pixelSpacing ?? defaultPixelSpacing,
      getSelectedAnnotationId: () => uiState.selectedAnnotationId,
      getProviders: () => decorationProviders ?? [],
      onDecorations: (decorations) => layer.setDecorations(decorations),
    });
    onCleanup(dispose);
  });

  // Track DOM-decoration roots created by the layer. The subscription fires on
  // membership change only; content is rendered via portals into the stable
  // div the layer owns and positions.
  createEffect(() => {
    const layer = decorationLayer();
    if (!layer) return;
    const unsubscribe = layer.onDomDecorations(setDomEntries);
    onCleanup(unsubscribe);
  });

  return (
    <>
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
      <For each={domEntries()}>
        {(entry) => (
          <Portal mount={entry.element}>{renderDomDecoration?.(entry.decoration)}</Portal>
        )}
      </For>
    </>
  );
};

export default ViewerCell;
