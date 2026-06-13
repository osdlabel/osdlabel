import { createEffect, onCleanup } from 'solid-js';
import type { FabricObject } from 'fabric';
import type { FabricOverlay } from '@osdlabel/fabric-osd';
import type { AnnotationTool, AddAnnotationParams } from '@osdlabel/fabric-annotations';
import type { AnnotationId, Point, ToolType } from '@osdlabel/annotation';
import type { ImageId, ImageSource } from '@osdlabel/viewer-api';
import { DEFAULT_CELL_TRANSFORM } from '@osdlabel/viewer-api';
import type { SegmentationImageRef } from 'osdlabel';
import {
  createAnnotationTool,
  createDragValueControl,
  getScenePointFromEvent,
  processToolAddAnnotation,
  processToolUpdateAnnotation,
  processObjectModified,
} from 'osdlabel';
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
  imageSource?: () => ImageSource | undefined,
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
    segmentationProvider,
  } = useAnnotator();

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

  // Handle object modification (resize, rotate, move) globally
  createEffect(() => {
    const ov = overlay();
    const imgId = imageId();

    if (!ov || !imgId) return;

    const handleObjectModified = (e: { target: FabricObject }) => {
      const result = processObjectModified(e.target, annotationState, imgId);
      if (result) {
        actions.updateAnnotation(result.id, imgId, {
          geometry: result.geometry!,
          rawAnnotationData: result.rawAnnotationData,
        });
      }
    };

    ov.canvas.on('object:modified', handleObjectModified);
    onCleanup(() => {
      ov.canvas.off('object:modified', handleObjectModified);
    });
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
    // no second effect that could race it.
    if (active && viewerControl === 'exposure') {
      ov.setCustomControlHandler(
        createDragValueControl({
          getValue: () =>
            (uiState.cellTransforms[uiState.activeCellIndex] ?? DEFAULT_CELL_TRANSFORM).exposure,
          setValue: (value) => actions.setActiveImageExposure(value),
          axis: 'y',
          sensitivity: 0.01,
          step: 0.025,
          min: -1,
          max: 1,
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

    // Build the segmentation tool config only when a provider is injected and
    // the cell has a known image source (needed for the tileSource fallback).
    const src = imageSource?.();
    const segmentation =
      segmentationProvider && src
        ? {
            provider: segmentationProvider,
            getImageRef: (id: ImageId): SegmentationImageRef => ({
              imageId: id,
              tileSource: src.tileSource,
              getViewportCanvas: () => ov.getImageCanvas(),
            }),
          }
        : undefined;

    const tool: AnnotationTool | null = createAnnotationTool(type, {
      vertexEdit: vertexEditConfig,
      ...(segmentation ? { segmentation } : {}),
    });

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
      canAddAnnotation: (toolType: ToolType) => {
        const status = constraintStatus();
        return status[toolType].enabled;
      },
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
    ov.setMode('annotation');
    tool.activate(ov, imgId, callbacks, shortcuts);

    const keyHandler = (e: KeyboardEvent) => tool!.onKeyDown(e);
    activeToolKeyHandlerRef.handler = keyHandler;

    const isDrawingTool = type !== 'select';

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

    ov.canvas.on('mouse:down', handleDown);
    ov.canvas.on('mouse:move', handleMove);
    ov.canvas.on('mouse:up', handleUp);

    onCleanup(() => {
      if (activeToolKeyHandlerRef.handler === keyHandler) {
        activeToolKeyHandlerRef.handler = null;
      }
      ov.canvas.off('mouse:down', handleDown);
      ov.canvas.off('mouse:move', handleMove);
      ov.canvas.off('mouse:up', handleUp);
      if (tool) {
        tool.deactivate();
      }
    });
  });
}
