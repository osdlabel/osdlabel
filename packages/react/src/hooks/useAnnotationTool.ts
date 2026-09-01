import { useEffect } from 'react';
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
  getScenePointFromEvent,
  getToneValue,
  processToolAddAnnotation,
  processToolUpdateAnnotation,
  processObjectModified,
  VIEWER_CONTROL_SPECS,
  canAddAnnotation,
} from 'osdlabel';
import type { DragAxisBehavior, ViewerControlAxisSpec } from 'osdlabel';
import type { ToolCallbacks } from '@osdlabel/fabric-annotations';
import { useAnnotator } from '../state/annotator-context.js';

interface FabricPointerEvent {
  readonly e: MouseEvent | PointerEvent | TouchEvent;
  readonly scenePoint?: { readonly x: number; readonly y: number };
  readonly absolutePointer?: { readonly x: number; readonly y: number };
  readonly target?: FabricObject | null;
}

export function useAnnotationTool(
  overlay: FabricOverlay | undefined,
  imageId: ImageId | undefined,
  isActive: boolean,
) {
  const {
    uiState,
    constraintStatus,
    actions,
    store,
    activeToolKeyHandlerRef,
    shortcuts,
    vertexEditConfig,
    vertexMarkerOptions,
    brushOptions,
  } = useAnnotator();

  // Auto-switch to select tool when active drawing tool becomes disabled
  useEffect(() => {
    const tool = uiState.activeTool;
    if (tool && tool !== 'select') {
      if (!constraintStatus[tool as ToolType].enabled) {
        actions.setActiveTool('select');
      }
    }
  }, [uiState.activeTool, constraintStatus, actions]);

  // The Fabric handlers and tool callbacks below outlive many renders, and a
  // tool can call back into them right after an action it issued itself (add
  // an annotation, then ask whether another is allowed). So they read the
  // store, which already holds every write, not the last rendered state (#217).
  // `store` is stable, so depending on it never rebuilds the tool.

  // Handle object:modified events
  useEffect(() => {
    if (!overlay || !imageId) return;

    const handleObjectModified = (e: { target: FabricObject }) => {
      const result = processObjectModified(e.target, store.getSnapshot().annotationState, imageId);
      if (result) {
        actions.updateAnnotation(result.id, imageId, {
          geometry: result.geometry!,
          rawAnnotationData: result.rawAnnotationData,
        });
      }
    };

    overlay.canvas.on('object:modified', handleObjectModified);
    return () => {
      overlay.canvas.off('object:modified', handleObjectModified);
    };
  }, [overlay, imageId, actions, store]);

  // Main tool lifecycle effect
  useEffect(() => {
    if (!overlay || !imageId) return;

    // A drag-driven viewer control takes precedence over annotation tools: the
    // overlay enters customControl mode and forwards pointer events to the
    // control's handler. This effect is the single authority over setMode, so
    // no second effect can race it. getValue reads the store, not a value
    // captured when the effect ran. Drag parameters come from the shared
    // VIEWER_CONTROL_SPECS registry so React and Solid behave identically.
    const viewerControl = uiState.activeViewerControl;
    const spec = viewerControl ? VIEWER_CONTROL_SPECS[viewerControl] : undefined;
    if (isActive && viewerControl && spec) {
      const axis = (axisSpec: ViewerControlAxisSpec): DragAxisBehavior => ({
        getValue: () => {
          const ui = store.getSnapshot().uiState;
          return getToneValue(
            ui.cellTransforms[ui.activeCellIndex] ?? DEFAULT_CELL_TRANSFORM,
            axisSpec.field,
          );
        },
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
      overlay.setCustomControlHandler(
        createDragVectorControl({
          ...(spec.x ? { x: axis(spec.x) } : {}),
          ...(spec.y ? { y: axis(spec.y) } : {}),
        }),
      );
      overlay.setMode('customControl');
      return () => {
        overlay.setCustomControlHandler(null);
      };
    }

    if (!isActive || !uiState.activeTool) {
      overlay.setMode('navigation');
      return;
    }

    const tool: AnnotationTool | null = createAnnotationTool(uiState.activeTool, {
      vertexEdit: vertexEditConfig,
      vertexMarkers: vertexMarkerOptions,
      // Reads the store, not rendered state: the brush asks for the radius,
      // eraser flag and selection on every pointer event, and must see the
      // write it made a moment ago (#217).
      segmentationBrush: buildSegmentationBrushConfig(
        {
          getBrushRadius: () => store.getSnapshot().uiState.brushRadius,
          isErasing: () => store.getSnapshot().uiState.brushErasing,
          getImageSize: () => overlay.getImageSize(),
          getSelectedAnnotationId: () => store.getSnapshot().uiState.selectedAnnotationId,
          getAnnotationState: () => store.getSnapshot().annotationState,
          getImageId: () => imageId,
          getActiveContextId: () => store.getSnapshot().contextState.activeContextId,
          maxPixels: brushOptions.maxPixels,
        },
        {
          addAnnotation: (annotation) => actions.addAnnotation(annotation),
          updateAnnotation: (id, imageIdArg, patch) =>
            actions.updateAnnotation(id, imageIdArg, patch),
          deleteAnnotation: (id, imageIdArg) => actions.deleteAnnotation(id, imageIdArg),
          setSelectedAnnotation: (id) => actions.setSelectedAnnotation(id),
          adjustBrushRadius: (direction) => actions.adjustBrushRadius(direction),
          // The provider routes the callback through a ref, so `brushOptions`
          // only changes identity when `maxPixels` does.
          onCapacityExceeded: (error) => brushOptions.onCapacityExceeded?.(error),
        },
      ),
    });

    if (!tool) {
      overlay.setMode('navigation');
      return;
    }

    const callbacks: ToolCallbacks = {
      getActiveContextId: () => store.getSnapshot().contextState.activeContextId,
      getToolConstraint: (toolType) => {
        const cs = store.getSnapshot().contextState;
        const activeContextId = cs.activeContextId;
        if (!activeContextId) return undefined;
        const activeContext = cs.contexts.find((c) => c.id === activeContextId);
        return activeContext?.tools.find((t) => t.type === toolType);
      },
      canAddAnnotation: (toolType: ToolType) =>
        canAddAnnotation(store.getConstraintStatus(), toolType),
      addAnnotation: (params: AddAnnotationParams) => {
        const processed = processToolAddAnnotation(params);
        if (!processed) return;
        actions.addAnnotation(processed);
      },
      updateAnnotation: (id: AnnotationId, imageIdArg: ImageId, fabricObject: FabricObject) => {
        const patch = processToolUpdateAnnotation(
          id,
          imageIdArg,
          fabricObject,
          store.getSnapshot().annotationState,
        );
        if (!patch) return;
        actions.updateAnnotation(id, imageIdArg, patch);
      },
      deleteAnnotation: (id, imageIdArg) => actions.deleteAnnotation(id, imageIdArg),
      setSelectedAnnotation: (id) => actions.setSelectedAnnotation(id),
      getAnnotation: (id, imageIdArg) => {
        const imageAnns = store.getSnapshot().annotationState.byImage[imageIdArg];
        return imageAnns?.[id];
      },
    };

    // The brush writes into an annotation rather than transforming one, so
    // objects stay inert while it is active — a stroke over an existing shape
    // must paint, not drag it.
    overlay.setMode(uiState.activeTool === 'segmentationBrush' ? 'paint' : 'annotation');
    tool.activate(overlay, imageId, callbacks, shortcuts);

    const keyHandler = (e: KeyboardEvent) => tool.onKeyDown(e);
    activeToolKeyHandlerRef.handler = keyHandler;

    const isDrawingTool =
      uiState.activeTool !== 'select' && uiState.activeTool !== 'segmentationBrush';
    let suppressedDown = false;

    const handleDown = (opt: FabricPointerEvent) => {
      if (isDrawingTool && opt.target?.id) {
        suppressedDown = true;
        return;
      }
      suppressedDown = false;
      const p = getScenePointFromEvent((pt: Point) => overlay.screenToImage(pt), opt);
      tool.onPointerDown(opt.e as PointerEvent, p);
    };

    const handleMove = (opt: FabricPointerEvent) => {
      if (suppressedDown) return;
      const p = getScenePointFromEvent((pt: Point) => overlay.screenToImage(pt), opt);
      tool.onPointerMove(opt.e as PointerEvent, p);
    };

    const handleUp = (opt: FabricPointerEvent) => {
      if (suppressedDown) {
        suppressedDown = false;
        return;
      }
      const p = getScenePointFromEvent((pt: Point) => overlay.screenToImage(pt), opt);
      tool.onPointerUp(opt.e as PointerEvent, p);
    };

    // Double clicks do not come through Fabric: input is routed by an OSD
    // MouseTracker, so `detail` is 0 on every forwarded pointerdown and the
    // browser's own dblclick never reaches Fabric's canvas (issue #168).
    // Unconditional: a suppressed press adds no vertex, and the tool decides
    // for itself whether the gesture contributed one.
    const unsubscribeDoubleClick = overlay.onDoubleClick((e, p, pressSeqs) => {
      // The pair must be relayed: it is the only way the tool can tell which
      // vertices this gesture's own presses added (#176).
      tool.onDoubleClick?.(e, p, pressSeqs);
    });

    overlay.canvas.on('mouse:down', handleDown);
    overlay.canvas.on('mouse:move', handleMove);
    overlay.canvas.on('mouse:up', handleUp);

    return () => {
      if (activeToolKeyHandlerRef.handler === keyHandler) {
        activeToolKeyHandlerRef.handler = null;
      }
      unsubscribeDoubleClick();
      overlay.canvas.off('mouse:down', handleDown);
      overlay.canvas.off('mouse:move', handleMove);
      overlay.canvas.off('mouse:up', handleUp);
      tool.deactivate();
    };
  }, [
    overlay,
    imageId,
    isActive,
    uiState.activeTool,
    uiState.activeViewerControl,
    shortcuts,
    vertexEditConfig,
    vertexMarkerOptions,
    brushOptions,
    actions,
    store,
    activeToolKeyHandlerRef,
  ]);
}
