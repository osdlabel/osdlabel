import { Rect, Circle, Line, Polyline, Polygon, type FabricObject } from 'fabric';
import { DEFAULT_POINT_RADIUS, type Geometry } from '@osdlabel/annotation';
import type { FabricShapeOptions } from './fabric-utils.js';

/**
 * Construct a Fabric object from image-space {@link Geometry}. This is the
 * inverse of {@link getGeometryFromFabricObject}: feeding the result back
 * through that function reproduces the input geometry.
 *
 * Construction mirrors the per-shape tools (`RectangleTool`, `CircleTool`,
 * `LineTool`, `PointTool`, `PolylineTool`, `FreeHandPathTool`) so imported
 * geometry behaves identically to user-drawn geometry. The object is created
 * committed (`selectable`/`evented` true) — callers that need a preview object
 * should adjust those flags afterwards.
 *
 * @param pointRadius Radius (image pixels) for `point` geometry, mirroring
 *   `AnnotationStyle.pointRadius`. Defaults to {@link DEFAULT_POINT_RADIUS}.
 */
export function buildFabricObjectFromGeometry(
  geometry: Geometry,
  options: FabricShapeOptions,
  pointRadius: number = DEFAULT_POINT_RADIUS,
): FabricObject {
  switch (geometry.type) {
    case 'rectangle':
      return new Rect({
        ...options,
        left: geometry.origin.x,
        top: geometry.origin.y,
        width: geometry.width,
        height: geometry.height,
        angle: geometry.rotation,
        selectable: true,
        evented: true,
      });
    case 'circle':
      return new Circle({
        ...options,
        left: geometry.center.x,
        top: geometry.center.y,
        radius: geometry.radius,
        originX: 'center',
        originY: 'center',
        selectable: true,
        evented: true,
      });
    case 'line':
      return new Line([geometry.start.x, geometry.start.y, geometry.end.x, geometry.end.y], {
        ...options,
        originX: 'left',
        originY: 'top',
        selectable: true,
        evented: true,
      });
    case 'point':
      return new Circle({
        ...options,
        left: geometry.position.x,
        top: geometry.position.y,
        radius: pointRadius,
        originX: 'center',
        originY: 'center',
        hasControls: false,
        selectable: true,
        evented: true,
      });
    case 'polyline':
      return new Polyline(
        geometry.points.map((p) => ({ x: p.x, y: p.y })),
        { ...options, fill: 'transparent', selectable: true, evented: true },
      );
    case 'polygon':
      return new Polygon(
        geometry.points.map((p) => ({ x: p.x, y: p.y })),
        { ...options, selectable: true, evented: true },
      );
  }
}
