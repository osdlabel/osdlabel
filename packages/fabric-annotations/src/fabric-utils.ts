import {
  Rect,
  Circle,
  Line,
  Polyline,
  Polygon,
  util,
  FabricObject,
  Color,
  version as FABRIC_VERSION,
} from 'fabric';
import type { Annotation, AnnotationStyle, Geometry, GeometryType } from '@osdlabel/annotation';
import type { FabricFields, FabricRawAnnotationData } from './types.js';

export function getFabricOptions(style: AnnotationStyle, id: string) {
  const fill = new Color(style.fillColor);
  if (style.fillOpacity !== undefined) {
    fill.setAlpha(style.fillOpacity);
  }

  return {
    fill: fill.toRgba(),
    stroke: style.strokeColor,
    strokeWidth: style.strokeWidth,
    strokeDashArray: style.strokeDashArray ? [...style.strokeDashArray] : null,
    opacity: style.opacity,
    id,
    strokeUniform: true,
  };
}

/**
 * Serialize a Fabric object into a FabricRawAnnotationData envelope.
 * The `id` property is included automatically via FabricObject.customProperties.
 */
export function serializeFabricObject(obj: FabricObject): FabricRawAnnotationData {
  return {
    format: 'fabric',
    fabricVersion: FABRIC_VERSION,
    data: obj.toObject() as Record<string, unknown>,
  };
}

/**
 * Deserialize a RawAnnotationData envelope back into a Fabric object.
 */
export async function deserializeFabricObject(
  raw: FabricRawAnnotationData,
): Promise<FabricObject | null> {
  if (raw.format !== 'fabric') return null;

  const objects = await util.enlivenObjects([raw.data]);
  if (objects.length === 0) return null;

  return objects[0] as FabricObject;
}

/**
 * Create a Fabric object from an Annotation's rawAnnotationData.
 * Sets selectable/evented to true for committed annotations.
 */
export async function createFabricObjectFromRawData(
  annotation: Annotation<FabricFields>,
): Promise<FabricObject | null> {
  const obj = await deserializeFabricObject(annotation.rawAnnotationData);
  if (!obj) return null;

  obj.set({
    selectable: true,
    evented: true,
  });

  return obj;
}

export function getGeometryFromFabricObject(
  obj: FabricObject,
  type: GeometryType,
): Geometry | null {
  if (type === 'rectangle' && obj instanceof Rect) {
    const width = obj.width * obj.scaleX;
    const height = obj.height * obj.scaleY;
    const left = obj.left;
    const top = obj.top;

    return {
      type: 'rectangle',
      origin: { x: left, y: top },
      width: width,
      height: height,
      rotation: obj.angle,
    };
  }

  if (type === 'circle' && obj instanceof Circle) {
    const radius = obj.radius * Math.max(Math.abs(obj.scaleX), Math.abs(obj.scaleY));
    const center = obj.getCenterPoint();
    return {
      type: 'circle',
      center: { x: center.x, y: center.y },
      radius: radius,
    };
  }

  if (type === 'line' && obj instanceof Line) {
    const matrix = obj.calcTransformMatrix();
    const cx = (obj.x1 + obj.x2) / 2;
    const cy = (obj.y1 + obj.y2) / 2;
    const p1 = util.transformPoint({ x: obj.x1 - cx, y: obj.y1 - cy }, matrix);
    const p2 = util.transformPoint({ x: obj.x2 - cx, y: obj.y2 - cy }, matrix);
    return {
      type: 'line',
      start: { x: p1.x, y: p1.y },
      end: { x: p2.x, y: p2.y },
    };
  }

  if (type === 'point' && obj instanceof Circle) {
    const center = obj.getCenterPoint();
    return {
      type: 'point',
      position: { x: center.x, y: center.y },
    };
  }

  if (type === 'polyline' || type === 'polygon') {
    // Polygon extends Polyline in Fabric, so instanceof Polyline matches both
    if (obj instanceof Polyline) {
      const matrix = obj.calcTransformMatrix();
      const pathOffset = obj.pathOffset || { x: 0, y: 0 };
      const points = (obj.points || []).map((p) => {
        const centeredP = { x: p.x - pathOffset.x, y: p.y - pathOffset.y };
        const tp = util.transformPoint(centeredP, matrix);
        return { x: tp.x, y: tp.y };
      });
      // Determine actual geometry type from the Fabric object class
      const geometryType = obj instanceof Polygon ? 'polygon' : 'polyline';
      return {
        type: geometryType,
        points: points,
      };
    }
  }

  return null;
}

/** The options object produced by getFabricOptions. */
export type FabricShapeOptions = ReturnType<typeof getFabricOptions>;
