import {
  onMount,
  onCleanup,
  createEffect,
  createMemo,
  on,
  createSignal,
  untrack,
  For,
} from 'solid-js';
import { Portal } from 'solid-js/web';
import { unwrap } from 'solid-js/store';
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
import { FramePresenter, isFramedImageSource } from '@osdlabel/frame-osd';
import type { FramedImageSource } from '@osdlabel/frame-osd';
import { useAnnotationTool } from '../hooks/useAnnotationTool.js';
import { useAnnotator } from '../state/annotator-context.js';
import type { Annotation } from '@osdlabel/annotation';
import type { FrameRef, OsdFields } from 'osdlabel';
import {
  createFrameThrottle,
  annotationsOnFrame,
  bucketByFrame,
  frameRefAt,
  applyMaskSelectionStyle,
  desiredMaskTint,
  enableLiveDecorationUpdates,
  MaskObjectCache,
  VectorObjectCache,
  maskFillFor,
  maskOpacityFor,
  MaskTintState,
  reportAnnotationRenderFailures,
  selectedMaskOn,
  settleAnnotationObjects,
  swapMaskTints,
} from 'osdlabel';
/** A revived annotation's canvas object (typed without importing Fabric here). */
type AnnotationObject = NonNullable<Awaited<ReturnType<typeof createFabricObjectFromRawData>>>;

export interface ViewerCellProps {
  readonly imageSource: ImageSource | undefined;
  readonly isActive: boolean;
  readonly cellIndex: number;
  readonly mode?: OverlayMode;
  readonly onActivate: () => void;
  readonly onOverlayReady?: (overlay: FabricOverlay) => void;
}

/** Wheel travel (CSS px) that steps one frame on a multi-frame source. */
const WHEEL_NOTCH_PX = 50;

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
    actions,
  } = useAnnotator();
  let containerRef: HTMLDivElement | undefined;
  let viewer: OpenSeadragon.Viewer | undefined;
  /** Set while the cell shows a multi-frame source: one tile, repainted per frame. */
  let presenter: FramePresenter | undefined;

  const framed = (): FramedImageSource | undefined =>
    isFramedImageSource(props.imageSource) ? props.imageSource : undefined;
  /** The frame the cell is asked to show (state). */
  const frameIndex = (): number | undefined => uiState.cellFrames[props.cellIndex]?.index;
  /**
   * The frame actually presented: follows `frameIndex` at most once per
   * display frame. Solid runs effects synchronously inside the wheel handler,
   * so without this a 120 Hz trackpad would swap pixels, annotations and
   * decorations twice per paint, and a slow swap would queue a backlog.
   *
   * Two signals, because the layers must change in the same paint and are
   * painted by different callbacks. `pixelFrame` drives the presenter: its
   * tile is repainted at once and OSD draws it at its next update.
   * `shownFrame` drives everything drawn over the pixels (annotation objects,
   * decorations, the frame new annotations are stamped with) and follows
   * inside the `update-viewport` handler of that draw, where Fabric then
   * renders synchronously, the rule `FabricOverlay.sync()` follows for pan
   * and zoom. Swapped any earlier, whichever of OSD's and Fabric's
   * animation-frame callbacks happened to run first decided which layer was a
   * paint ahead (3-23 incoherent paints per 2 s scroll before this split).
   */
  const [pixelFrame, setPixelFrame] = createSignal<number | undefined>(untrack(frameIndex));
  const [shownFrame, setShownFrame] = createSignal<number | undefined>(untrack(frameIndex));
  /** Run `cb` right after OSD's next draw, or two frames from now if nothing draws. */
  const onNextDraw = (cb: () => void): void => {
    const v = viewer;
    let done = false;
    const run = (): void => {
      if (done) return;
      done = true;
      v?.removeHandler('update-viewport', run);
      cb();
    };
    v?.addHandler('update-viewport', run);
    requestAnimationFrame(() => requestAnimationFrame(run));
  };
  const presentFrame = (index: number | undefined): void => {
    setPixelFrame(index);
    if (!presenter || index === undefined) {
      setShownFrame(index);
      return;
    }
    onNextDraw(() => {
      setShownFrame(index);
      // Objects reused from the cache were added synchronously just now:
      // render them in this paint. A frame still being revived renders when
      // it lands, a paint or more behind its pixels.
      overlay()?.canvas.renderAll();
    });
  };
  // The throttle releases the next step after the same draw, so a step is
  // never presented before the previous one reached the screen.
  const frameThrottle = createFrameThrottle<number | undefined>(presentFrame, onNextDraw);
  onCleanup(() => frameThrottle.cancel());
  createEffect(() => frameThrottle.request(frameIndex()));
  const frameRef = (): FrameRef | undefined => {
    const source = framed();
    const index = shownFrame();
    return source && index !== undefined ? frameRefAt(source.frameAxis, index) : undefined;
  };

  /** Open the cell's source: a frame presenter for a multi-frame source, else as before. */
  const openSource = (v: OpenSeadragon.Viewer, source: ImageSource): void => {
    presenter = undefined;
    if (!isFramedImageSource(source)) {
      openImage(v, source);
      return;
    }
    const initial = untrack(frameIndex) ?? 0;
    presenter = new FramePresenter(v, source.frameSource, { initialFrame: initial });
    presenter.open();
    // Registers the axis length with the frame, so wheel and keyboard can step it.
    actions.setCellFrame(props.cellIndex, presenter.frame, source.frameSource.count);
  };

  /**
   * On a multi-frame source the plain wheel steps frames (the clinical
   * convention); Ctrl/Cmd+wheel still zooms. Captured on the cell before OSD's
   * and the overlay's trackers see it, in every interaction mode.
   */
  let wheelAccumulator = 0;
  const onWheel = (e: WheelEvent): void => {
    if (!framed() || e.ctrlKey || e.metaKey) return;
    e.preventDefault();
    e.stopPropagation();
    // One frame per mouse notch (any delta of a notch's size, whatever the
    // platform reports for one); a trackpad's many small deltas accumulate.
    const delta = e.deltaMode === 1 ? e.deltaY * WHEEL_NOTCH_PX : e.deltaY;
    if (Math.abs(delta) >= WHEEL_NOTCH_PX) {
      wheelAccumulator = 0;
      actions.stepCellFrame(props.cellIndex, Math.sign(delta));
      return;
    }
    wheelAccumulator += delta;
    if (Math.abs(wheelAccumulator) < WHEEL_NOTCH_PX) return;
    actions.stepCellFrame(props.cellIndex, Math.sign(wheelAccumulator));
    wheelAccumulator = 0;
  };
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

    containerRef.addEventListener('wheel', onWheel, { capture: true, passive: false });

    // Open initial image if provided
    if (props.imageSource) {
      openSource(viewer, props.imageSource);
    }
  });

  onCleanup(() => {
    containerRef?.removeEventListener('wheel', onWheel, { capture: true });
    presenter = undefined;
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
  let shownFrameSource = untrack(() => framed()?.frameSource);
  createEffect(
    on(
      () => [props.imageSource?.tileSource, framed()?.frameSource] as const,
      ([tileSource, frameSource]) => {
        if (isSameTileSource(tileSource, shownTileSource) && frameSource === shownFrameSource) {
          return;
        }
        shownTileSource = tileSource;
        shownFrameSource = frameSource;
        if (viewer) {
          viewer.close();
          if (props.imageSource) {
            openSource(viewer, props.imageSource);
          }
        }
      },
      { defer: true },
    ),
  );

  // Present the cell's frame. One tile repainted in place: the viewport, the
  // world's single item and the overlay's transform are untouched.
  createEffect(() => {
    const index = pixelFrame();
    if (index !== undefined) presenter?.show(index);
  });

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
    frameRef,
  );

  // Per-frame index over this image's bucket: rebuilt when its annotations
  // change, not when the frame changes, so a frame step is an O(1) lookup.
  const frameBuckets = createMemo(() => {
    const imageId = props.imageSource?.id;
    if (!imageId || !framed()) return undefined;
    return bucketByFrame(Object.values(annotationState.byImage[imageId] ?? {}));
  });

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
    const buckets = frameBuckets();
    const index = shownFrame();
    const pool =
      buckets && index !== undefined
        ? annotationsOnFrame(buckets, index)
        : Object.values(annotationState.byImage[imageId] || {});
    return visibleSet.size > 0 ? pool.filter((a) => visibleSet.has(a.contextId)) : pool;
  };

  /** Vector annotation objects reused across rebuilds; see `VectorObjectCache`. */
  const vectorObjects = new VectorObjectCache();
  onCleanup(() => vectorObjects.clear());

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

    // Track only what a rebuild depends on — each annotation's payload, which
    // a store write may replace in place — then read plain objects: the reads
    // below (and in the async revive) otherwise go through the store proxy and
    // create a subscription per field, a large share of a scroll's CPU.
    const tracked = visibleAnnotations();
    for (const a of tracked) void a.rawAnnotationData;
    const matching = tracked.map((a) => unwrap(a));

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

    /** The object this run can use without reviving: a cached raster or a reused vector. */
    const cachedFor = (ann: (typeof matching)[number]): AnnotationObject | undefined =>
      ann.geometry.type === 'mask'
        ? maskObjects.get(ann, maskFillFor(ann.id, selectedAtBuild, styleAtBuild))
        : vectorObjects.get(ann.rawAnnotationData);

    const prepare = (ann: (typeof matching)[number], obj: AnnotationObject): AnnotationObject => {
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
        obj.set('opacity', maskOpacityFor(ann.id, selectedAtBuild, styleAtBuild));
      }
      return obj;
    };

    const finish = (
      objects: readonly AnnotationObject[],
      failures: Parameters<typeof reportAnnotationRenderFailures>[0],
    ): void => {
      maskObjects.retain(maskIds);
      if (objects.length > 0) {
        ov.canvas.add(...objects);
      }
      // The selection may have moved while the objects were being built. A
      // brush commit adds its mask and then selects it, and this effect runs
      // between the two writes, so the build above saw the old selection - and
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
    };

    // Every object already built (a frame scrolled back to, an unrelated edit):
    // add them in this same tick, so they land in the same paint as the frame's
    // pixels. Going through the async revive put them one paint late, and that
    // extra paint doubled the compositor's work per slice.
    const ready = matching.map(cachedFor);
    if (ready.every((o) => o !== undefined)) {
      finish(
        ready.map((o, i) => prepare(matching[i]!, o!)),
        [],
      );
      return;
    }

    void (async () => {
      const { objects, failures } = await settleAnnotationObjects(matching, async (ann) => {
        // A mask's raster is reused while its payload and tint are unchanged;
        // the stroke that changed one mask must not re-rasterize the others.
        const fill = maskFillFor(ann.id, selectedAtBuild, styleAtBuild);
        const isMask = ann.geometry.type === 'mask';
        const cached = cachedFor(ann);
        const obj = cached ?? (await createFabricObjectFromRawData(ann, { maskFill: fill }));
        // Not after this run was superseded: a newer run has already retained
        // its own set, and a write now would outlive that until the next
        // rebuild, which a cell showing a static image never has.
        if (obj && isMask && !cached && !cancelled) maskObjects.set(ann, fill, obj);
        // Keyed by the payload: the object is a function of it alone.
        if (obj && !isMask && !cached) vectorObjects.set(ann.rawAnnotationData, obj);
        return obj ? prepare(ann, obj) : obj;
      });
      if (cancelled) return;
      finish(objects, failures);
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
    void props.imageSource?.id;
    void shownFrame();
    const providers = decorationProviders;
    if (!providers || providers.length === 0) {
      layer.setDecorations([]);
      return;
    }
    // The dependencies above already cover every change; providers read plain
    // objects, untracked, instead of subscribing to each geometry field.
    const annotations = untrack(visibleAnnotations).map((a) => unwrap(a));
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
      getVisibleAnnotations: () => visibleAnnotations().map((a) => unwrap(a)),
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
