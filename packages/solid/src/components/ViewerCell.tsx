import { onMount, onCleanup, createEffect, on, createSignal, untrack, For } from 'solid-js';
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
import { DEFAULT_VIEWER_OPTIONS, isSameTileSource, openImage } from '@osdlabel/osd-helper';
import { useAnnotationTool } from '../hooks/useAnnotationTool.js';
import { useAnnotator } from '../state/annotator-context.js';
import type { Annotation } from '@osdlabel/annotation';
import type { OsdFields } from 'osdlabel';
import {
  applyMaskSelectionStyle,
  desiredMaskTint,
  enableLiveDecorationUpdates,
  MaskObjectCache,
  maskFillFor,
  maskOpacityFor,
  MaskTintState,
  reportAnnotationRenderFailures,
  selectedMaskOn,
  settleAnnotationObjects,
  swapMaskTints,
} from 'osdlabel';
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
    reportAnnotationRenderError,
    brushOptions,
  } = useAnnotator();
  let containerRef: HTMLDivElement | undefined;
  let viewer: OpenSeadragon.Viewer | undefined;
  const [overlay, setOverlay] = createSignal<FabricOverlay>();
  const [decorationLayer, setDecorationLayer] = createSignal<DecorationLayer>();
  const [domEntries, setDomEntries] = createSignal<readonly DomDecorationEntry[]>([]);

  onMount(() => {
    if (!containerRef) return;

    viewer = OpenSeadragon({
      ...DEFAULT_VIEWER_OPTIONS,
      element: containerRef,
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

  // Watch for image source changes. Compared by value against what is shown,
  // so an equal tile-source object re-created by the host does not reload the
  // image (#83). Tracked here rather than with `on`'s previous input: a
  // deferred `on` records none on its skipped first run, so the first change
  // would always compare against `undefined` and reload.
  let shownTileSource = untrack(() => props.imageSource?.tileSource);
  createEffect(
    on(
      () => props.imageSource?.tileSource,
      (tileSource) => {
        if (isSameTileSource(tileSource, shownTileSource)) return;
        shownTileSource = tileSource;
        if (viewer) {
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
    ov.applyImageFilters(cellTransform);
  });

  // Use annotation tool hook
  useAnnotationTool(
    overlay,
    () => props.imageSource?.id,
    () => props.isActive,
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

  /** Rasterized masks reused across rebuilds; see `MaskObjectCache`. */
  const maskObjects = new MaskObjectCache();
  onCleanup(() => maskObjects.clear());
  /** Which mask is drawn in the override tint; shared by the two effects below. */
  const tintState = new MaskTintState();

  // Sync annotations from state to canvas (full clear-and-reload)
  createEffect(() => {
    const ov = overlay();
    const imageId = props.imageSource?.id;
    const activeContextId = contextState.activeContextId;
    // Track this as reactive dependencies so the effect re-runs
    void props.isActive;
    void contextState.displayedContextIds;

    if (!ov || !imageId) {
      // No image means nothing to reuse; without this the previous image's
      // rasters stayed in memory until the cell went away.
      maskObjects.clear();
      return;
    }

    const matching = visibleAnnotations();

    // Clear all existing annotation objects from canvas
    const toRemove = ov.canvas.getObjects().filter((obj) => obj.id);
    if (toRemove.length > 0) ov.canvas.remove(...toRemove);

    // Rebuilding is asynchronous, so by the time this run's objects are ready
    // a newer run may have cleared the canvas and started its own rebuild
    // (#160), or the cell may have unmounted and destroyed the overlay (#190).
    // Either way the effect's cleanup has run; adding now would duplicate
    // objects or touch a disposed canvas, so a cancelled run adds nothing.
    let cancelled = false;
    onCleanup(() => {
      cancelled = true;
    });

    // Async load from rawAnnotationData
    // Selection and mask style are read untracked: the selection effect below
    // owns reacting to them, so a click does not rebuild every annotation.
    const maskIds = new Set(matching.filter((a) => a.geometry.type === 'mask').map((a) => a.id));
    const selectedAtBuild = selectedMaskOn(
      untrack(() => uiState.selectedAnnotationId),
      maskIds,
    );
    const styleAtBuild = untrack(() => brushOptions.maskStyle);
    void (async () => {
      const { objects, failures } = await settleAnnotationObjects(matching, async (ann) => {
        const selectedId = selectedAtBuild;
        const maskStyle = styleAtBuild;
        // A mask's raster is reused while its payload and tint are unchanged;
        // the stroke that changed one mask must not re-rasterize the others.
        const fill = maskFillFor(ann.id, selectedId, maskStyle);
        const isMask = ann.geometry.type === 'mask';
        const cached = isMask ? maskObjects.get(ann, fill) : undefined;
        const obj = cached ?? (await createFabricObjectFromRawData(ann, { maskFill: fill }));
        // Not after this run was superseded: a newer run has already retained
        // its own set, and a write now would outlive that until the next
        // rebuild, which a cell showing a static image never has.
        if (obj && isMask && !cached && !cancelled) maskObjects.set(ann, fill, obj);
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
          ov.applyModeToObject(obj, !isActiveCtx);
          if (ann.geometry.type === 'mask') {
            obj.set('opacity', maskOpacityFor(ann.id, selectedId, maskStyle));
          }
        }
        return obj;
      });
      if (cancelled) return;
      maskObjects.retain(maskIds);
      if (objects.length > 0) {
        ov.canvas.add(...objects);
      }
      // The selection may have moved while the objects were being built. A
      // brush commit adds its mask and then selects it, and this effect runs
      // between the two writes, so the build above saw the old selection — and
      // the selection effect found an empty canvas. Re-apply against the
      // current selection now that the objects exist. The objects carry the
      // tint they were built under; the selection effect takes over from
      // there.
      const selectedMaskNow = selectedMaskOn(
        untrack(() => uiState.selectedAnnotationId),
        maskIds,
      );
      const styleNow = untrack(() => brushOptions.maskStyle);
      applyMaskSelectionStyle(objects, maskIds, selectedMaskNow, styleNow);
      tintState.rebuilt(desiredMaskTint(selectedAtBuild, styleAtBuild));
      swapMaskTints(tintState, desiredMaskTint(selectedMaskNow, styleNow), {
        canvas: ov.canvas,
        applyModeToObject: (obj, readOnly) => ov.applyModeToObject(obj, readOnly),
        cache: maskObjects,
        annotations: new Map(matching.map((a) => [a.id as string, a] as const)),
        opacityFor: (id) => maskOpacityFor(id, selectedMaskNow, styleNow),
        isCancelled: () => cancelled,
      });
      if (containerRef) {
        containerRef.dataset.annotationCount = String(objects.length);
      }
      ov.canvas.requestRenderAll();
      // Each annotation is built on its own, so one that cannot be revived is
      // skipped and reported instead of leaving the whole image empty (#209).
      reportAnnotationRenderFailures(failures, reportAnnotationRenderError);
    })();
  });

  // Selected-mask styling. A selected mask has no handles to show, so the
  // others are dimmed and, if the host asks, the selected one is recoloured.
  // Separate from the rebuild above because it runs on every selection
  // change: dimming is a per-object opacity, free; recolouring re-decodes
  // only the masks whose tint changed. `tintState` is shared with the
  // rebuild, which resets it for the objects it builds.
  createEffect(() => {
    const ov = overlay();
    const selectedId = uiState.selectedAnnotationId;
    const maskStyle = brushOptions.maskStyle;
    if (!ov) return;
    const masks = new Map(
      untrack(visibleAnnotations)
        .filter((a) => a.geometry.type === 'mask')
        .map((a) => [a.id as string, a] as const),
    );
    // Only a mask on *this* image counts: selection is global, and a selected
    // rectangle or a mask in another cell must not dim these.
    const selectedMaskId = selectedMaskOn(selectedId, new Set(masks.keys()));
    if (
      applyMaskSelectionStyle(
        ov.canvas.getObjects(),
        new Set(masks.keys()),
        selectedMaskId,
        maskStyle,
      )
    ) {
      ov.canvas.requestRenderAll();
    }

    let cancelled = false;
    onCleanup(() => {
      cancelled = true;
    });
    swapMaskTints(tintState, desiredMaskTint(selectedMaskId, maskStyle), {
      canvas: ov.canvas,
      applyModeToObject: (obj, readOnly) => ov.applyModeToObject(obj, readOnly),
      cache: maskObjects,
      annotations: masks,
      opacityFor: (id) => maskOpacityFor(id, selectedMaskId, maskStyle),
      isCancelled: () => cancelled,
    });
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
