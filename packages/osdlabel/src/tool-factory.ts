import type {
  AnnotationId,
  Point,
  RectangleGeometry,
  ToolType,
  VectorGeometry,
} from '@osdlabel/annotation';
import { DEFAULT_POINT_RADIUS, toolTypeToGeometryType } from '@osdlabel/annotation';
import { circleToBoundingRectangle } from '@osdlabel/geometry';
import type { ImageId, AnnotationState } from '@osdlabel/viewer-api';
import type { AnnotationContextId } from '@osdlabel/annotation-context';
import type {
  AnnotationTool,
  AddAnnotationParams,
  FabricShapeOptions,
  FabricRawAnnotationData,
  AnnotationRawData,
  SegmentationBrushToolConfig,
} from '@osdlabel/fabric-annotations';
import {
  RectangleTool,
  CircleTool,
  LineTool,
  PointTool,
  PolylineTool,
  FreeHandPathTool,
  SelectTool,
  SegmentationBrushTool,
  buildFabricObjectFromGeometry,
  getGeometryFromFabricObject,
  serializeFabricObject,
  DEFAULT_VERTEX_EDIT_LONG_PRESS_MS,
  DEFAULT_VERTEX_EDIT_MOVE_TOLERANCE_PX,
  type VertexEditConfig,
  type VertexMarkerOptions,
} from '@osdlabel/fabric-annotations';
import type { FabricObject } from 'fabric';
import type { OsdAnnotation, OsdFields } from './types.js';

/** Options for {@link createAnnotationTool}. */
export interface CreateAnnotationToolOptions {
  /**
   * Long-press tuning for the polygon/polyline vertex editor that the select,
   * polyline, and free-draw tools expose. Defaults are applied when omitted.
   */
  readonly vertexEdit?: VertexEditConfig | undefined;
  /**
   * Appearance of the vertex markers drawn while a polyline is in progress.
   * Radii/colours default to values derived from the tool's resolved style;
   * pass `{ enabled: false }` to draw no markers.
   */
  readonly vertexMarkers?: VertexMarkerOptions | undefined;
  /**
   * Configuration for the raster brush. Required for `'segmentationBrush'` to
   * be available; without it `createAnnotationTool('segmentationBrush')`
   * returns null so the tool degrades gracefully.
   */
  readonly segmentationBrush?: SegmentationBrushToolConfig | undefined;
}

/**
 * Creates an annotation tool instance for the given tool type.
 * Returns null for unrecognized types.
 */
export function createAnnotationTool(
  type: ToolType | 'select',
  options?: CreateAnnotationToolOptions,
): AnnotationTool | null {
  const vertexEdit: VertexEditConfig = options?.vertexEdit ?? {
    longPressMs: DEFAULT_VERTEX_EDIT_LONG_PRESS_MS,
    moveTolerancePx: DEFAULT_VERTEX_EDIT_MOVE_TOLERANCE_PX,
  };
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
      return new PolylineTool(vertexEdit, options?.vertexMarkers);
    case 'freeHandPath':
      return new FreeHandPathTool(undefined, vertexEdit);
    case 'segmentationBrush':
      return options?.segmentationBrush
        ? new SegmentationBrushTool(options.segmentationBrush)
        : null;
    case 'select':
      return new SelectTool(vertexEdit);
    default:
      return null;
  }
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
 *
 * The geometry is read back from the object with
 * {@link getGeometryFromFabricObject}. When the object paints a shape that
 * geometry cannot describe (a skewed rectangle or circle, or a circle scaled
 * differently along its two axes, as data saved before their handles were
 * constrained can be), or a point's dot at any size but its style's radius
 * (any scale other than 1, which a scaled multi-selection bakes into it, or
 * any skew), the returned `rawAnnotationData` is not the object's own: it is
 * rebuilt from that geometry in the object's style, so it paints exactly what
 * is stored, and the viewer, which rebuilds the canvas from it, shows the
 * shape snap to it. Any other edit is serialized as is.
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

  const serialized = serializeFabricObject(fabricObject);
  const rawAnnotationData = paintsBeyondGeometry(fabricObject, geometry)
    ? rawDataPaintingGeometry(geometry, serialized, annotationId)
    : serialized;
  return { id: annotationId, geometry, rawAnnotationData };
}

/**
 * Whether `object` paints a shape its `geometry` cannot describe. A rectangle
 * or circle is placed by its centre, size and (a rectangle) rotation, which a
 * skew bends into a parallelogram or a sheared ellipse, and a circle has one
 * radius, which a scale that differs between the axes stretches into an
 * ellipse. A point has no size at all: its dot is always drawn at its style's
 * radius, so any scale other than 1, or any skew, paints a dot its geometry
 * does not describe. Lines, polylines and polygons are read through the
 * object's whole transform, so their stored points are exact whatever it is.
 */
function paintsBeyondGeometry(object: FabricObject, geometry: VectorGeometry): boolean {
  if (geometry.type !== 'rectangle' && geometry.type !== 'circle' && geometry.type !== 'point') {
    return false;
  }
  // Truthy, not `!== 0`: Fabric defaults both to 0, and an object that lacks them is unskewed.
  if (object.skewX || object.skewY) return true;
  if (geometry.type === 'point') return object.scaleX !== 1 || object.scaleY !== 1;
  return geometry.type === 'circle' && Math.abs(object.scaleX) !== Math.abs(object.scaleY);
}

/**
 * Fabric data that paints exactly `geometry`, in the style `serialized` was
 * painted with: the object {@link buildFabricObjectFromGeometry} builds for it,
 * as {@link processConvertCircleToRectangle} does. Fields the rebuilt object
 * does not write, such as a host's own `FabricObject.customProperties`, are
 * kept from `serialized`.
 *
 * A point's dot is rebuilt at its style's radius: the `radius` its `Circle`
 * was saved with, which is where `AnnotationStyle.pointRadius` lives once the
 * point is drawn ({@link DEFAULT_POINT_RADIUS} if the data has none). The
 * object's scale and skew are dropped, not folded into it.
 */
function rawDataPaintingGeometry(
  geometry: VectorGeometry,
  serialized: FabricRawAnnotationData,
  id: AnnotationId,
): FabricRawAnnotationData {
  const savedRadius = serialized.data['radius'];
  const pointRadius =
    geometry.type === 'point' && typeof savedRadius === 'number'
      ? savedRadius
      : DEFAULT_POINT_RADIUS;
  const rebuilt = serializeFabricObject(
    buildFabricObjectFromGeometry(geometry, styleOptionsFromRawData(serialized, id), pointRadius),
  );
  return { ...rebuilt, data: { ...serialized.data, ...rebuilt.data } };
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

/**
 * Extracts the visual style fields from an existing annotation's serialized
 * Fabric data so a converted shape keeps the original styling. Annotation
 * style is not stored separately — it lives in the serialized Fabric object.
 */
function styleOptionsFromRawData(raw: AnnotationRawData, id: string): FabricShapeOptions {
  const d = raw.data;
  const asString = (value: unknown, fallback: string): string =>
    typeof value === 'string' ? value : fallback;
  const asNumber = (value: unknown, fallback: number): number =>
    typeof value === 'number' ? value : fallback;
  return {
    fill: asString(d.fill, 'transparent'),
    stroke: asString(d.stroke, '#000000'),
    strokeWidth: asNumber(d.strokeWidth, 1),
    strokeDashArray: Array.isArray(d.strokeDashArray)
      ? d.strokeDashArray.filter((n: unknown): n is number => typeof n === 'number')
      : null,
    opacity: asNumber(d.opacity, 1),
    id,
    strokeUniform: typeof d.strokeUniform === 'boolean' ? d.strokeUniform : true,
  };
}

/**
 * Converts a circle annotation into its axis-aligned bounding-box rectangle.
 * Returns the UPDATE_ANNOTATION patch fields (geometry, toolType, rawAnnotationData),
 * preserving the original visual style. Returns null if the annotation is not a circle.
 *
 * Callers should enforce constraints (e.g. the active context's rectangle limit)
 * before applying the returned patch.
 */
export function processConvertCircleToRectangle(annotation: OsdAnnotation): {
  readonly geometry: RectangleGeometry;
  readonly toolType: 'rectangle';
  readonly rawAnnotationData: FabricRawAnnotationData;
} | null {
  if (annotation.geometry.type !== 'circle') return null;

  const geometry = circleToBoundingRectangle(annotation.geometry);
  const options = styleOptionsFromRawData(annotation.rawAnnotationData, annotation.id);
  const rect = buildFabricObjectFromGeometry(geometry, options);
  const rawAnnotationData = serializeFabricObject(rect);

  return { geometry, toolType: 'rectangle', rawAnnotationData };
}
