import { useEffect, useRef } from 'react';
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
    contextState,
    annotationState,
    constraintStatus,
    actions,
    activeToolKeyHandlerRef,
    shortcuts,
    vertexEditConfig,
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

  // Use refs for values needed in event handlers to avoid stale closures
  const annotationStateRef = useRef(annotationState);
  annotationStateRef.current = annotationState;
  const contextStateRef = useRef(contextState);
  contextStateRef.current = contextState;
  const constraintStatusRef = useRef(constraintStatus);
  constraintStatusRef.current = constraintStatus;
  const uiStateRef = useRef(uiState);
  uiStateRef.current = uiState;
  // Through a ref, not a dependency: `onCapacityExceeded` is a function, so a
  // host passing an inline `brushOptions={{ ... }}` gives it a new identity on
  // every render. As a dependency that tears the tool down and rebuilds it each
  // time — and a render landing mid-drag would discard the stroke in progress.
  const brushOptionsRef = useRef(brushOptions);
  brushOptionsRef.current = brushOptions;

  // Handle object:modified events
  useEffect(() => {
    if (!overlay || !imageId) return;

    const handleObjectModified = (e: { target: FabricObject }) => {
      const result = processObjectModified(e.target, annotationStateRef.current, imageId);
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
  }, [overlay, imageId, actions]);

  // Main tool lifecycle effect
  useEffect(() => {
    if (!overlay || !imageId) return;

    // A drag-driven viewer control takes precedence over annotation tools: the
    // overlay enters customControl mode and forwards pointer events to the
    // control's handler. This effect is the single authority over setMode, so
    // no second effect can race it. getValue reads through a ref to avoid a
    // stale closure across renders. Drag parameters come from the shared
    // VIEWER_CONTROL_SPECS registry so React and Solid behave identically.
    const viewerControl = uiState.activeViewerControl;
    const spec = viewerControl ? VIEWER_CONTROL_SPECS[viewerControl] : undefined;
    if (isActive && viewerControl && spec) {
      const axis = (axisSpec: ViewerControlAxisSpec): DragAxisBehavior => ({
        getValue: () =>
          getToneValue(
            uiStateRef.current.cellTransforms[uiStateRef.current.activeCellIndex] ??
              DEFAULT_CELL_TRANSFORM,
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
      // Reads through refs so the brush always sees current state without the
      // effect resubscribing every time the radius changes.
      segmentationBrush: buildSegmentationBrushConfig(
        {
          getBrushRadius: () => uiStateRef.current.brushRadius,
          isErasing: () => uiStateRef.current.brushErasing,
          getImageSize: () => overlay.getImageSize(),
          getSelectedAnnotationId: () => uiStateRef.current.selectedAnnotationId,
          getAnnotationState: () => annotationStateRef.current,
          getImageId: () => imageId,
          getActiveContextId: () => contextStateRef.current.activeContextId,
          maxPixels: brushOptionsRef.current.maxPixels,
        },
        {
          addAnnotation: (annotation) => actions.addAnnotation(annotation),
          updateAnnotation: (id, imageIdArg, patch) =>
            actions.updateAnnotation(id, imageIdArg, patch),
          deleteAnnotation: (id, imageIdArg) => actions.deleteAnnotation(id, imageIdArg),
          setSelectedAnnotation: (id) => actions.setSelectedAnnotation(id),
          adjustBrushRadius: (direction) => actions.adjustBrushRadius(direction),
          onCapacityExceeded: (error) => brushOptionsRef.current.onCapacityExceeded?.(error),
        },
      ),
    });

    if (!tool) {
      overlay.setMode('navigation');
      return;
    }

    const callbacks: ToolCallbacks = {
      getActiveContextId: () => contextStateRef.current.activeContextId,
      getToolConstraint: (toolType) => {
        const cs = contextStateRef.current;
        const activeContextId = cs.activeContextId;
        if (!activeContextId) return undefined;
        const activeContext = cs.contexts.find((c) => c.id === activeContextId);
        return activeContext?.tools.find((t) => t.type === toolType);
      },
      canAddAnnotation: (toolType: ToolType) => {
        return constraintStatusRef.current[toolType].enabled;
      },
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
          annotationStateRef.current,
        );
        if (!patch) return;
        actions.updateAnnotation(id, imageIdArg, patch);
      },
      deleteAnnotation: (id, imageIdArg) => actions.deleteAnnotation(id, imageIdArg),
      setSelectedAnnotation: (id) => actions.setSelectedAnnotation(id),
      getAnnotation: (id, imageIdArg) => {
        const imageAnns = annotationStateRef.current.byImage[imageIdArg];
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

    overlay.canvas.on('mouse:down', handleDown);
    overlay.canvas.on('mouse:move', handleMove);
    overlay.canvas.on('mouse:up', handleUp);

    return () => {
      if (activeToolKeyHandlerRef.handler === keyHandler) {
        activeToolKeyHandlerRef.handler = null;
      }
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
    // Only the primitive: the callback is read through a ref, so its identity
    // must not drive the effect.
    brushOptions.maxPixels,
    actions,
    activeToolKeyHandlerRef,
  ]);
}
