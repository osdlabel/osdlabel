import { Rect, Circle, Line, Polyline, Polygon, type FabricObject } from 'fabric';
import type { VectorGeometry } from '@osdlabel/annotation';
import type { FabricShapeOptions } from './fabric-utils.js';

/** Screen-pixel radius used to render `point` geometry (mirrors PointTool). */
const POINT_RADIUS = 5;

/**
 * Construct a Fabric object from image-space {@link VectorGeometry}. This is the
 * inverse of {@link getGeometryFromFabricObject}: feeding the result back
 * through that function reproduces the input geometry.
 *
 * Mask geometry is deliberately outside the parameter type. A mask's pixels
 * live in the annotation's `rawAnnotationData`, so there is nothing to build
 * from its geometry — use `buildMaskFabricObject` or
 * `createFabricObjectFromRawData` instead. Narrowing here means a caller
 * holding a general `Geometry` has to decide which branch it is in, at compile
 * time, rather than discovering it as a throw at runtime.
 *
 * Construction mirrors the per-shape tools (`RectangleTool`, `CircleTool`,
 * `LineTool`, `PointTool`, `PolylineTool`, `FreeHandPathTool`) so imported
 * geometry behaves identically to user-drawn geometry. The object is created
 * committed (`selectable`/`evented` true) — callers that need a preview object
 * should adjust those flags afterwards.
 */
export function buildFabricObjectFromGeometry(
  geometry: VectorGeometry,
  options: FabricShapeOptions,
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
        radius: POINT_RADIUS,
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
    default: {
      // Unreachable for a `VectorGeometry`, which is the point: the parameter
      // type already excludes masks, so a TypeScript caller gets a compile
      // error naming `createMaskAnnotation`. A JavaScript one gets nothing,
      // and used to fall out of this switch with `undefined` and fail several
      // frames later on `undefined.toObject()`. Naming the cause here costs a
      // branch that types prove is dead.
      const unsupported: never = geometry;
      throw new TypeError(
        `Cannot build a Fabric object from ${String((unsupported as { type?: unknown }).type)} ` +
          `geometry — a mask's pixels are not in its geometry. Use createMaskAnnotation / ` +
          `buildMaskFabricObject instead.`,
      );
    }
  }
}
