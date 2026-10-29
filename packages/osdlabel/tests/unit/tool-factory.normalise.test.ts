/**
 * Pins `processObjectModified`, the edit commit both bindings run on Fabric's
 * `object:modified`, for shapes other than rectangles (those are pinned in the
 * rectangle suite, `rectangle-annotation.test.ts`):
 *
 * - a circle stretched (`scaleX` ≠ `scaleY`) or sheared (a skew), and a point
 *   sheared, are shapes their geometry cannot describe. The commit stores the
 *   geometry read back, by the rule it always used (a circle's radius is
 *   `radius · max(|scaleX|, |scaleY|)`), and replaces the Fabric data with
 *   data that paints exactly that geometry, in the same style;
 * - an edit that leaves a describable shape is committed as Fabric serialized
 *   it, untouched;
 * - lines, polylines and polygons store points read through the object's
 *   whole transform, a shear included, so their data keeps it.
 *
 * The circle handles can no longer stretch or shear a circle (fabric-annotations'
 * `shape-controls.test.ts`); what reaches this path is data saved by an earlier
 * release, or a host's own Fabric code.
 */
import { describe, expect, it } from 'vitest';
import { Circle, FabricObject, Polygon, util } from 'fabric';
import type {
  AnnotationStyle,
  CircleGeometry,
  Geometry,
  Point,
  PolygonGeometry,
} from '@osdlabel/annotation';
import { createAnnotationContextId } from '@osdlabel/annotation-context';
import {
  createFabricObjectFromRawData,
  initFabricModule,
  serializeFabricObject,
} from '@osdlabel/fabric-annotations';
import { createImageId, type AnnotationState } from '@osdlabel/viewer-api';
import { createAnnotationFromGeometry } from '../../src/create-annotation.js';
import { processObjectModified } from '../../src/tool-factory.js';
import type { OsdAnnotation, OsdFields } from '../../src/types.js';

initFabricModule();

const imageId = createImageId('img-object-modified');
const contextId = createAnnotationContextId('ctx-object-modified');

/** `toObject()` rounds to 4 decimals: a reloaded outline may move this much. */
const SAVED_TOLERANCE = 1e-3;

const STYLE: AnnotationStyle = {
  strokeColor: '#1a2b3c',
  strokeWidth: 3,
  strokeDashArray: [6, 2],
  fillColor: '#00ff88',
  fillOpacity: 0.35,
  opacity: 0.8,
  pointRadius: 7,
};

/** The fields `getFabricOptions` writes: the annotation's style. */
const STYLE_KEYS = ['fill', 'stroke', 'strokeWidth', 'strokeDashArray', 'opacity', 'strokeUniform'];

const CIRCLE: CircleGeometry = { type: 'circle', center: { x: 412.5, y: 233.25 }, radius: 80 };

function create(geometry: Geometry): OsdAnnotation {
  return createAnnotationFromGeometry(geometry, {
    imageId,
    contextId,
    toolType: geometry.type === 'polygon' ? 'polyline' : geometry.type,
    style: STYLE,
  });
}

/** As the viewer loads a stored annotation: from its JSON, through `createFabricObjectFromRawData`. */
async function load(annotation: OsdAnnotation): Promise<FabricObject> {
  const obj = await createFabricObjectFromRawData(
    JSON.parse(JSON.stringify(annotation)) as OsdAnnotation,
  );
  expect(obj).not.toBeNull();
  return obj!;
}

function asCircleObject(obj: FabricObject): Circle {
  expect(obj).toBeInstanceOf(Circle);
  return obj as Circle;
}

function stateOf(annotation: OsdAnnotation): AnnotationState<OsdFields> {
  return { byImage: { [imageId]: { [annotation.id]: annotation } }, changeCounter: 1 };
}

type Committed = NonNullable<ReturnType<typeof processObjectModified>>;

function commit(obj: FabricObject, stored: OsdAnnotation): Committed {
  const committed = processObjectModified(obj, stateOf(stored), imageId);
  expect(committed, 'processObjectModified resolved the edited annotation').not.toBeNull();
  return committed!;
}

/** Reload what a commit stored, as the viewer does after the update. */
function reloadCommitted(committed: Committed, stored: OsdAnnotation): Promise<FabricObject> {
  expect(committed.geometry).not.toBeNull();
  return load({
    ...stored,
    geometry: committed.geometry!,
    rawAnnotationData: committed.rawAnnotationData,
  });
}

/** Where Fabric paints a `Circle`'s outline (no stroke): its `radius` arc through `calcTransformMatrix()`. */
function paintedOutline(circle: Circle, samples = 72): Point[] {
  const matrix = circle.calcTransformMatrix();
  return Array.from({ length: samples }, (_, i) => {
    const t = (2 * Math.PI * i) / samples;
    return util.transformPoint(
      { x: circle.radius * Math.cos(t), y: circle.radius * Math.sin(t) },
      matrix,
    );
  });
}

/** How far the painted outline strays from a circle about `center` of `radius`. */
function deviationFrom(circle: Circle, center: Point, radius: number): number {
  return Math.max(
    ...paintedOutline(circle).map((p) =>
      Math.abs(Math.hypot(p.x - center.x, p.y - center.y) - radius),
    ),
  );
}

function expectStyleKept(committed: Committed, stored: OsdAnnotation): void {
  const data = committed.rawAnnotationData.data;
  const before = stored.rawAnnotationData.data;
  for (const key of STYLE_KEYS) {
    expect(data[key], `style: ${key}`).toStrictEqual(before[key]);
  }
  expect(data['id']).toBe(stored.id);
}

describe('processObjectModified', () => {
  describe('a circle stretched or sheared, which no circle geometry describes', () => {
    const CASES = [
      { name: 'stretched along x by a side handle', props: { scaleX: 1.5 } },
      {
        name: 'stretched and squashed by Shift + a corner',
        props: { scaleX: 0.7504, scaleY: 1.4163 },
      },
      { name: 'sheared by Shift + a side handle', props: { skewX: 20 } },
      {
        name: 'sheared, stretched and turned',
        props: { skewY: -12, scaleY: 1.2, angle: 30 },
      },
    ] as const;

    it.each(CASES)(
      '$name: commits the circle it reads as, and data that paints exactly that circle in the same style',
      async ({ props }) => {
        const stored = create(CIRCLE);
        const circle = asCircleObject(await load(stored));
        circle.set(props);
        circle.setCoords();
        const centre = circle.getCenterPoint();
        const radius = CIRCLE.radius * Math.max(circle.scaleX, circle.scaleY);
        // The premise: what is painted is not a circle.
        expect(deviationFrom(circle, centre, radius)).toBeGreaterThan(5);

        const committed = commit(circle, stored);
        // The geometry, by the rule it always had: the centre where it is
        // painted, the radius the larger of the scaled radii.
        expect(committed.geometry).toStrictEqual({
          type: 'circle',
          center: { x: centre.x, y: centre.y },
          radius,
        });
        expect(committed.rawAnnotationData.data).toMatchObject({
          type: 'Circle',
          scaleX: 1,
          scaleY: 1,
          skewX: 0,
          skewY: 0,
        });
        expectStyleKept(committed, stored);
        const reloaded = asCircleObject(await reloadCommitted(committed, stored));
        expect(deviationFrom(reloaded, centre, radius)).toBeLessThanOrEqual(SAVED_TOLERANCE);
      },
    );

    it('a circle scaled uniformly and turned is committed as Fabric serialized it', async () => {
      const stored = create(CIRCLE);
      const circle = asCircleObject(await load(stored));
      circle.set({ scaleX: 1.375, scaleY: 1.375, angle: 48, flipY: true });
      const committed = commit(circle, stored);
      expect(committed.rawAnnotationData).toStrictEqual(serializeFabricObject(circle));
      expect(committed.geometry).toStrictEqual({
        type: 'circle',
        center: { x: circle.getCenterPoint().x, y: circle.getCenterPoint().y },
        radius: 110,
      });
    });

    it("keeps the host's own custom properties when it replaces the data", async () => {
      const registered = FabricObject.customProperties;
      FabricObject.customProperties = [...registered, 'reviewer'];
      try {
        const stored = create(CIRCLE);
        const circle = asCircleObject(await load(stored));
        circle.set({ skewX: 15 });
        (circle as FabricObject & { reviewer?: string }).reviewer = 'dr-who';
        const committed = commit(circle, stored);
        expect(committed.rawAnnotationData.data).toMatchObject({ skewX: 0, reviewer: 'dr-who' });
      } finally {
        FabricObject.customProperties = registered;
      }
    });
  });

  describe('a point', () => {
    it('sheared: commits its position, and data for an unsheared dot of the same size and style', async () => {
      const stored = create({ type: 'point', position: { x: 90.5, y: 61.25 } });
      const dot = asCircleObject(await load(stored));
      dot.set({ skewX: 30, left: dot.left + 4 });
      const committed = commit(dot, stored);
      expect(committed.geometry).toStrictEqual({ type: 'point', position: { x: 94.5, y: 61.25 } });
      expect(committed.rawAnnotationData.data).toMatchObject({
        type: 'Circle',
        radius: 7,
        skewX: 0,
        skewY: 0,
        left: 94.5,
        top: 61.25,
      });
      expectStyleKept(committed, stored);
      const reloaded = asCircleObject(await reloadCommitted(committed, stored));
      expect(reloaded.hasControls).toBe(false);
      expect(deviationFrom(reloaded, { x: 94.5, y: 61.25 }, 7)).toBeLessThanOrEqual(
        SAVED_TOLERANCE,
      );
    });

    it('moved: committed as Fabric serialized it', async () => {
      const stored = create({ type: 'point', position: { x: 90.5, y: 61.25 } });
      const dot = await load(stored);
      dot.set({ left: dot.left - 12, top: dot.top + 3 });
      expect(commit(dot, stored).rawAnnotationData).toStrictEqual(serializeFabricObject(dot));
    });
  });

  describe('a sheared polygon', () => {
    it('keeps its shear: the points stored are the ones painted', async () => {
      const square: PolygonGeometry = {
        type: 'polygon',
        points: [
          { x: 100, y: 100 },
          { x: 200, y: 100 },
          { x: 200, y: 200 },
          { x: 100, y: 200 },
        ],
      };
      const stored = create(square);
      const polygon = await load(stored);
      expect(polygon).toBeInstanceOf(Polygon);
      polygon.set({ skewX: 20 });
      const committed = commit(polygon, stored);
      expect(committed.rawAnnotationData).toStrictEqual(serializeFabricObject(polygon));
      expect(committed.rawAnnotationData.data['skewX']).toBe(20);
      // Sheared about its centre (150, 150): x' = x + tan 20° · (y - 150).
      const t = Math.tan((20 * Math.PI) / 180);
      const geometry = committed.geometry;
      if (geometry === null || geometry.type !== 'polygon') {
        throw new Error(`expected polygon geometry, got ${JSON.stringify(geometry)}`);
      }
      square.points.forEach((p, i) => {
        expect(geometry.points[i]!.x).toBeCloseTo(p.x + t * (p.y - 150), 9);
        expect(geometry.points[i]!.y).toBeCloseTo(p.y, 9);
      });
    });
  });
});
