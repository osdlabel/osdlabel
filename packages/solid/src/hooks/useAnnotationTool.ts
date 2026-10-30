import { createEffect, createMemo, onCleanup, untrack } from 'solid-js';
import type { FabricObject } from 'fabric';
import type { FabricOverlay } from '@osdlabel/fabric-osd';
import type { AnnotationTool, AddAnnotationParams } from '@osdlabel/fabric-annotations';
import type { AnnotationId, Point, ToolType } from '@osdlabel/annotation';
import type { ImageId } from '@osdlabel/viewer-api';
import { DEFAULT_CELL_TRANSFORM } from '@osdlabel/viewer-api';
import {
  buildSegmentationBrushConfig,
  createAnnotationTool,
  createDragVectorControl,
  enableObjectModifiedCommits,
  getScenePointFromEvent,
  getToneValue,
  processToolAddAnnotation,
  processToolUpdateAnnotation,
  VIEWER_CONTROL_SPECS,
  canAddAnnotation,
} from 'osdlabel';
import type { DragAxisBehavior, MaskObjectSeed, ViewerControlAxisSpec } from 'osdlabel';
import type { ToolCallbacks } from '@osdlabel/fabric-annotations';
import { useAnnotator } from '../state/annotator-context.js';

interface FabricPointerEvent {
  readonly e: MouseEvent | PointerEvent | TouchEvent;
  readonly scenePoint?: { readonly x: number; readonly y: number };
  readonly absolutePointer?: { readonly x: number; readonly y: number };
  readonly target?: FabricObject | null;
}

export function useAnnotationTool(
  overlay: () => FabricOverlay | undefined,
  imageId: () => ImageId | undefined,
  isActive: () => boolean,
  /**
   * The cell's hooks into a brush commit: `seedMaskObject` receives the
   * committed mask's object before the write, so the cell can show it
   * without re-rasterizing (see `BrushConfigDispatchers.seedMaskObject`).
   */
  cell?: { readonly seedMaskObject?: (seed: MaskObjectSeed) => void },
) {
  const annotator = useAnnotator();
  const {
    uiState,
    contextState,
    annotationState,
    constraintStatus,
    actions,
    activeToolKeyHandlerRef,
  } = annotator;

  // The one brush option the tool is built with. A memo, compared by value:
  // reading the provider's getter in the effect tracked the whole
  // `brushOptions` prop, so a host passing a new object — to change only its
  // strategy or a callback — rebuilt the tool and dropped a stroke in progress.
  const brushMaxPixels = createMemo(() => annotator.brushOptions.maxPixels);

  /** The active context's brush constraint, read where it is needed and never tracked. */
  const activeBrushConstraint = () => {
    const context = contextState.contexts.find((c) => c.id === contextState.activeContextId);
    return context?.tools.find((t) => t.type === 'segmentationBrush');
  };

  // Auto-switch to select tool when active drawing tool becomes disabled (limit reached)
  createEffect(() => {
    const tool = uiState.activeTool;
    if (tool && tool !== 'select') {
      const status = constraintStatus();
      if (!status[tool as ToolType].enabled) {
        actions.setActiveTool('select');
      }
    }
  });

  // Save every edit Fabric reports (move, resize, rotate), whatever the tool,
  // of one annotation or of a multi-selection. Shared with React, including
  // why a commit waits for a microtask: see enableObjectModifiedCommits.
  createEffect(() => {
    const ov = overlay();
    const imgId = imageId();

    if (!ov || !imgId) return;

    onCleanup(
      enableObjectModifiedCommits({
        overlay: ov,
        imageId: imgId,
        getAnnotationState: () => annotationState,
        updateAnnotation: (id, patch) => actions.updateAnnotation(id, imgId, patch),
        updateAnnotations: (updates) => actions.updateAnnotations(imgId, updates),
      }),
    );
  });

  createEffect(() => {
    const ov = overlay();
    const active = isActive();
    const viewerControl = uiState.activeViewerControl;
    const type = uiState.activeTool;
    const imgId = imageId();

    if (!ov || !imgId) {
      return;
    }

    // A drag-driven viewer control takes precedence over annotation tools:
    // the overlay enters customControl mode and forwards pointer events to the
    // control's handler. This is the single authority over setMode, so there is
    // no second effect that could race it. Drag parameters come from the shared
    // VIEWER_CONTROL_SPECS registry so Solid and React behave identically.
    const spec = viewerControl ? VIEWER_CONTROL_SPECS[viewerControl] : undefined;
    if (active && viewerControl && spec) {
      const axis = (axisSpec: ViewerControlAxisSpec): DragAxisBehavior => ({
        getValue: () =>
          getToneValue(
            uiState.cellTransforms[uiState.activeCellIndex] ?? DEFAULT_CELL_TRANSFORM,
            axisSpec.field,
          ),
        setValue: (value) =>
          axisSpec.field === 'exposure'
            ? actions.setActiveImageExposure(value)
            : actions.setActiveImageContrast(value),
        invert: axisSpec.invert,
        sensitivity: axisSpec.sensitivity,
        step: axisSpec.step,
        min: axisSpec.min,
        max: axisSpec.max,
      });
      ov.setCustomControlHandler(
        createDragVectorControl({
          ...(spec.x ? { x: axis(spec.x) } : {}),
          ...(spec.y ? { y: axis(spec.y) } : {}),
        }),
      );
      ov.setMode('customControl');
      onCleanup(() => {
        ov.setCustomControlHandler(null);
      });
      return;
    }

    if (!active || !type) {
      ov.setMode('navigation');
      return;
    }

    // Read here, not destructured at setup: the provider's getters are memos,
    // so a changed binding or marker style rebuilds the tool (#219).
    const tool: AnnotationTool | null = createAnnotationTool(type, {
      vertexEdit: annotator.vertexEditConfig,
      vertexMarkers: annotator.vertexMarkerOptions,
      segmentationBrush: buildSegmentationBrushConfig(
        {
          getBrushRadius: () => uiState.brushRadius,
          isErasing: () => uiState.brushErasing,
          getImageSize: () => ov.getImageSize(),
          getSelectedAnnotationId: () => uiState.selectedAnnotationId,
          getAnnotationState: () => annotationState,
          getImageId: () => imgId,
          getActiveContextId: () => contextState.activeContextId,
          maxPixels: brushMaxPixels(),
          // Read per stroke, inside the accessor, so it is not a dependency here.
          getSelectedFill: () => annotator.brushOptions.maskStyle?.selectedFill,
          // Read when a capacity failure is reported, not a dependency here.
          getNewMaskShortcut: () => annotator.shortcuts.newMask,
          canStartNewMask: () => canAddAnnotation(constraintStatus(), 'segmentationBrush'),
          // Read at the press and at an overflow, not dependencies here:
          // changing either never rebuilds the tool or drops a stroke.
          getMaxDownsample: () => activeBrushConstraint()?.brush?.maxDownsample,
          getCoarsenStrategy: () => annotator.brushOptions.coarsen,
        },
        {
          addAnnotation: (annotation) => actions.addAnnotation(annotation),
          updateAnnotation: (id, imageIdArg, patch) =>
            actions.updateAnnotation(id, imageIdArg, patch),
          deleteAnnotation: (id, imageIdArg) => actions.deleteAnnotation(id, imageIdArg),
          setSelectedAnnotation: (id) => actions.setSelectedAnnotation(id),
          adjustBrushRadius: (direction) => actions.adjustBrushRadius(direction),
          // Called through, not read here: reading the getter inside this
          // effect would track it, so a host deriving `brushOptions` from a
          // signal would rebuild the tool — and discard an in-progress stroke —
          // when only the callback changed. React defers it for the same reason.
          onCapacityExceeded: (error) => annotator.brushOptions.onCapacityExceeded?.(error),
          seedMaskObject: (seed) => cell?.seedMaskObject?.(seed),
          onCoarsen: (event) => annotator.brushOptions.onCoarsen?.(event),
        },
      ),
    });
    const shortcuts = annotator.shortcuts;

    if (!tool) {
      ov.setMode('navigation');
      return;
    }

    // Construct callbacks from context
    const callbacks: ToolCallbacks = {
      getActiveContextId: () => contextState.activeContextId,
      getToolConstraint: (toolType) => {
        const activeContextId = contextState.activeContextId;
        if (!activeContextId) return undefined;
        const activeContext = contextState.contexts.find((c) => c.id === activeContextId);
        return activeContext?.tools.find((t) => t.type === toolType);
      },
      canAddAnnotation: (toolType: ToolType) => canAddAnnotation(constraintStatus(), toolType),
      addAnnotation: (params: AddAnnotationParams) => {
        const processed = processToolAddAnnotation(params);
        if (!processed) return;
        actions.addAnnotation(processed);
      },
      updateAnnotation: (id: AnnotationId, imageIdArg: ImageId, fabricObject: FabricObject) => {
        const patch = processToolUpdateAnnotation(id, imageIdArg, fabricObject, annotationState);
        if (!patch) return;
        actions.updateAnnotation(id, imageIdArg, patch);
      },
      deleteAnnotation: (id, imageIdArg) => actions.deleteAnnotation(id, imageIdArg),
      setSelectedAnnotation: (id) => actions.setSelectedAnnotation(id),
      getAnnotation: (id, imageIdArg) => {
        const imageAnns = annotationState.byImage[imageIdArg];
        return imageAnns?.[id];
      },
    };

    // Activate tool
    // The brush writes into an annotation rather than transforming one, so
    // objects stay inert while it is active — a stroke over an existing shape
    // must paint, not drag it.
    ov.setMode(type === 'segmentationBrush' ? 'paint' : 'annotation');
    // Untracked: a tool may read its config accessors during `activate` (the
    // brush sizes its cursor ring from `uiState.brushRadius`), and anything
    // read here becomes a dependency of this effect. That turned a radius
    // change into a full teardown — `onCleanup` → `deactivate()` → `cancel()`
    // — which silently discards a stroke in progress. Resizing mid-stroke is
    // a routine painting gesture, so the whole stroke vanished with no
    // feedback. React is immune only because it reads through refs; this is
    // the structural equivalent.
    untrack(() => tool.activate(ov, imgId, callbacks, shortcuts));

    const keyHandler = (e: KeyboardEvent) => tool!.onKeyDown(e);
    activeToolKeyHandlerRef.handler = keyHandler;

    const isDrawingTool = type !== 'select' && type !== 'segmentationBrush';

    // Track whether we suppressed mouse:down so we also suppress mouse:up
    let suppressedDown = false;

    // Handlers
    const handleDown = (opt: FabricPointerEvent) => {
      if (!tool) return;

      // For drawing tools, skip if the click landed on an existing annotation object.
      if (isDrawingTool && opt.target) {
        if (opt.target.id) {
          suppressedDown = true;
          return;
        }
      }

      suppressedDown = false;
      const p = getScenePointFromEvent((pt: Point) => ov.screenToImage(pt), opt);
      tool.onPointerDown(opt.e as PointerEvent, p);
    };

    const handleMove = (opt: FabricPointerEvent) => {
      if (!tool || suppressedDown) return;
      const p = getScenePointFromEvent((pt: Point) => ov.screenToImage(pt), opt);
      tool.onPointerMove(opt.e as PointerEvent, p);
    };

    const handleUp = (opt: FabricPointerEvent) => {
      if (!tool || suppressedDown) {
        suppressedDown = false;
        return;
      }
      const p = getScenePointFromEvent((pt: Point) => ov.screenToImage(pt), opt);
      tool.onPointerUp(opt.e as PointerEvent, p);
    };

    // Double clicks do not come through Fabric: input is routed by an OSD
    // MouseTracker, so `detail` is 0 on every forwarded pointerdown and the
    // browser's own dblclick never reaches Fabric's canvas (issue #168).
    // Unconditional: a suppressed press adds no vertex, and the tool decides
    // for itself whether the gesture contributed one.
    const unsubscribeDoubleClick = ov.onDoubleClick((e, p, pressSeqs) => {
      // The pair must be relayed: it is the only way the tool can tell which
      // vertices this gesture's own presses added (#176).
      tool.onDoubleClick?.(e, p, pressSeqs);
    });

    // Fabric has no pointercancel handling: the overlay hears a cancelled
    // press, puts back what Fabric was moving, and tells us here, before it
    // ends Fabric's gesture with a release that reaches handleUp. The tool
    // drops what the press began (a preview, a polyline's vertex) first, so
    // that release finds nothing to commit. The sequence names the press.
    const unsubscribePointerCancel = ov.onPointerCancel((e, pressSeq) => {
      tool.onPointerCancel?.(e, pressSeq);
    });

    ov.canvas.on('mouse:down', handleDown);
    ov.canvas.on('mouse:move', handleMove);
    ov.canvas.on('mouse:up', handleUp);

    onCleanup(() => {
      if (activeToolKeyHandlerRef.handler === keyHandler) {
        activeToolKeyHandlerRef.handler = null;
      }
      unsubscribeDoubleClick();
      unsubscribePointerCancel();
      ov.canvas.off('mouse:down', handleDown);
      ov.canvas.off('mouse:move', handleMove);
      ov.canvas.off('mouse:up', handleUp);
      if (tool) {
        tool.deactivate();
      }
    });
  });
}
