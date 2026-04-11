import type { AnnotationId, Point, ToolType } from '@osdlabel/annotation';
import { toolTypeToGeometryType } from '@osdlabel/annotation';
import type { ImageId, AnnotationState } from '@osdlabel/viewer-api';
import type {
  AnnotationContextId,
  ConstraintStatus,
  ContextState,
} from '@osdlabel/annotation-context';
import type {
  AnnotationTool,
  ToolCallbacks,
  AddAnnotationParams,
} from '@osdlabel/fabric-annotations';
import {
  RectangleTool,
  CircleTool,
  LineTool,
  PointTool,
  PolylineTool,
  FreeHandPathTool,
  SelectTool,
  getGeometryFromFabricObject,
  serializeFabricObject,
} from '@osdlabel/fabric-annotations';
import type { FabricObject } from 'fabric';
import type { OsdFields } from './types.js';

/**
 * Creates an annotation tool instance for the given tool type.
 * Returns null for unrecognized types.
 */
export function createAnnotationTool(type: ToolType | 'select'): AnnotationTool | null {
  switch (type) {
    case 'rectangle':
      return new RectangleTool();
    case 'circle':
      return new CircleTool();
    case 'line':
      return new LineTool();
    case 'point':
      return new PointTool();
    case 'polyline':
      return new PolylineTool();
    case 'freeHandPath':
      return new FreeHandPathTool();
    case 'select':
      return new SelectTool();
    default:
      return null;
  }
}

/**
 * Accessors that the tool callbacks read from to get current state.
 * Framework wrappers provide these (e.g., reading from SolidJS stores or React state).
 */
export interface ToolCallbackAccessors {
  readonly getContextState: () => ContextState;
  readonly getAnnotationState: () => AnnotationState<OsdFields>;
  readonly getConstraintStatus: () => ConstraintStatus;
}

/**
 * Dispatchers that the tool callbacks call to mutate state.
 */
export interface ToolCallbackDispatchers {
  readonly addAnnotation: (annotation: Parameters<ToolCallbacks['addAnnotation']>[0]) => void;
  readonly updateAnnotation: (
    id: AnnotationId,
    imageId: ImageId,
    fabricObject: FabricObject,
  ) => void;
  readonly deleteAnnotation: (id: AnnotationId, imageId: ImageId) => void;
  readonly setSelectedAnnotation: (id: AnnotationId | null) => void;
}

/**
 * Builds a ToolCallbacks object from accessors and dispatchers.
 * Both SolidJS and React wrappers use this to create the callbacks that tools need.
 */
export function buildToolCallbacks(
  accessors: ToolCallbackAccessors,
  dispatchers: ToolCallbackDispatchers,
): ToolCallbacks {
  return {
    getActiveContextId: () => accessors.getContextState().activeContextId,
    getToolConstraint: (toolType) => {
      const contextState = accessors.getContextState();
      const activeContextId = contextState.activeContextId;
      if (!activeContextId) return undefined;
      const activeContext = contextState.contexts.find((c) => c.id === activeContextId);
      return activeContext?.tools.find((t) => t.type === toolType);
    },
    canAddAnnotation: (toolType: ToolType) => {
      const status = accessors.getConstraintStatus();
      return status[toolType].enabled;
    },
    addAnnotation: (params: AddAnnotationParams) => {
      dispatchers.addAnnotation(params);
    },
    updateAnnotation: (id: AnnotationId, imageId: ImageId, fabricObject: FabricObject) => {
      dispatchers.updateAnnotation(id, imageId, fabricObject);
    },
    deleteAnnotation: (id, imageId) => dispatchers.deleteAnnotation(id, imageId),
    setSelectedAnnotation: (id) => dispatchers.setSelectedAnnotation(id),
    getAnnotation: (id, imageId) => {
      const imageAnns = accessors.getAnnotationState().byImage[imageId];
      return imageAnns?.[id];
    },
  };
}

/**
 * Gets the scene point from a Fabric pointer event.
 * Used by both framework implementations for canvas event handling.
 */
export function getScenePointFromEvent(
  screenToImage: (point: Point) => Point,
  opt: {
    readonly e: MouseEvent | PointerEvent | TouchEvent;
    readonly scenePoint?: { readonly x: number; readonly y: number };
    readonly absolutePointer?: { readonly x: number; readonly y: number };
  },
): Point {
  if (opt.scenePoint) {
    return opt.scenePoint;
  }
  if (opt.absolutePointer) {
    return opt.absolutePointer;
  }
  const mouseEvent = opt.e as MouseEvent;
  return screenToImage({ x: mouseEvent.offsetX, y: mouseEvent.offsetY });
}

/**
 * Processes a Fabric object:modified event, returning the updated fields.
 * Returns null if the annotation or geometry cannot be resolved.
 */
export function processObjectModified(
  fabricObject: FabricObject,
  annotationState: AnnotationState<OsdFields>,
  imageId: ImageId,
): {
  readonly id: AnnotationId;
  readonly geometry: ReturnType<typeof getGeometryFromFabricObject>;
  readonly rawAnnotationData: ReturnType<typeof serializeFabricObject>;
} | null {
  if (!fabricObject.id) return null;
  const annotationId = fabricObject.id as AnnotationId;
  const currentAnnotation = annotationState.byImage[imageId]?.[annotationId];
  if (!currentAnnotation) return null;

  const geometry = getGeometryFromFabricObject(fabricObject, currentAnnotation.geometry.type);
  if (!geometry) return null;

  const rawAnnotationData = serializeFabricObject(fabricObject);
  return { id: annotationId, geometry, rawAnnotationData };
}

/**
 * Processes an addAnnotation call from a tool, extracting geometry and serializing.
 * Returns the fields needed to create the annotation, or null on failure.
 */
export function processToolAddAnnotation(params: AddAnnotationParams): {
  readonly id: AnnotationId;
  readonly imageId: ImageId;
  readonly contextId: AnnotationContextId;
  readonly toolType: ToolType;
  readonly geometry: NonNullable<ReturnType<typeof getGeometryFromFabricObject>>;
  readonly rawAnnotationData: ReturnType<typeof serializeFabricObject>;
  readonly label?: string;
} | null {
  const { fabricObject, imageId, contextId, type: annType, label } = params;
  const id = fabricObject.id as AnnotationId;

  const geometry = getGeometryFromFabricObject(fabricObject, toolTypeToGeometryType(annType));
  if (!geometry) {
    console.warn('Could not extract geometry from Fabric object');
    return null;
  }

  const rawAnnotationData = serializeFabricObject(fabricObject);

  return {
    id,
    imageId,
    contextId,
    toolType: annType,
    geometry,
    rawAnnotationData,
    ...(label !== undefined ? { label } : {}),
  };
}

/**
 * Processes an updateAnnotation call from a tool.
 * Returns the patch fields, or null on failure.
 */
export function processToolUpdateAnnotation(
  id: AnnotationId,
  imageId: ImageId,
  fabricObject: FabricObject,
  annotationState: AnnotationState<OsdFields>,
): {
  readonly geometry: NonNullable<ReturnType<typeof getGeometryFromFabricObject>>;
  readonly rawAnnotationData: ReturnType<typeof serializeFabricObject>;
} | null {
  const currentAnnotation = annotationState.byImage[imageId]?.[id];
  if (!currentAnnotation) return null;

  const geometry = getGeometryFromFabricObject(fabricObject, currentAnnotation.geometry.type);
  if (!geometry) return null;

  const rawAnnotationData = serializeFabricObject(fabricObject);
  return { geometry, rawAnnotationData };
}
