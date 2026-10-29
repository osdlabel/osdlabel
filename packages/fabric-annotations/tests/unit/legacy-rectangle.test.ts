import { describe, it, expect } from 'vitest';
import { Rect } from 'fabric';
import {
  DEFAULT_ANNOTATION_STYLE,
  createAnnotationId,
  type Annotation,
  type Geometry,
} from '@osdlabel/annotation';
import { buildFabricObjectFromGeometry } from '../../src/build-fabric-object.js';
import {
  createFabricObjectFromRawData,
  getFabricOptions,
  getGeometryFromFabricObject,
  serializeFabricObject,
} from '../../src/fabric-utils.js';
import { initFabricModule } from '../../src/fabric-module.js';
import { migrateLegacyRectangle } from '../../src/legacy-rectangle.js';
import type { FabricFields } from '../../src/types.js';

initFabricModule();

const id = createAnnotationId('rect-1');
const options = getFabricOptions(DEFAULT_ANNOTATION_STYLE, id);

function annotation(geometry: Geometry, object: Rect): Annotation<FabricFields> {
  return {
    id,
    geometry,
    toolType: geometry.type === 'rectangle' ? 'rectangle' : 'point',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    rawAnnotationData: serializeFabricObject(object),
  };
}

/**
 * A rectangle as earlier releases saved it, built the way they built it: a
 * `Rect` with the corner as `left`/`top` and no origin (so Fabric 7 centres it
 * there), the geometry read back as 0.21.0's `getGeometryFromFabricObject`
 * read it (`left`/`top` unrounded, as the corner), and the Fabric data from
 * `serializeFabricObject`, whose `toObject()` rounds `left`/`top` to 4 decimals.
 */
function legacyRect(
  corner: { x: number; y: number },
  rotation: number,
  scale: { x: number; y: number } = { x: 1, y: 1 },
): Annotation<FabricFields> {
  const object = new Rect({
    ...options,
    left: corner.x,
    top: corner.y,
    width: 100,
    height: 50,
    angle: rotation,
    scaleX: scale.x,
    scaleY: scale.y,
  });
  const geometry: Geometry = {
    type: 'rectangle',
    origin: { x: object.left, y: object.top },
    width: object.width * object.scaleX,
    height: object.height * object.scaleY,
    rotation: object.angle,
  };
  return annotation(geometry, object);
}

/** Drawn with the mouse: image coordinates carry many decimals. */
const DRAWN = { x: 132.38578680202863, y: 218.61252115058915 };

function legacy(rotation: number): Annotation<FabricFields> {
  return legacyRect(DRAWN, rotation);
}

/** The geometry the saved Fabric data paints, read as current code reads it. */
async function paintedGeometry(ann: Annotation<FabricFields>): Promise<Geometry | null> {
  const object = await createFabricObjectFromRawData(ann);
  expect(object).not.toBeNull();
  return getGeometryFromFabricObject(object!, 'rectangle');
}

describe('migrateLegacyRectangle', () => {
  it.each([0, 30, 90, -45])(
    'moves the geometry of a rectangle saved at %d° to where it is painted',
    async (rotation) => {
      const before = legacy(rotation);
      const after = migrateLegacyRectangle(before);
      const painted = await paintedGeometry(before);

      expect(after).not.toBe(before);
      expect(after.rawAnnotationData).toBe(before.rawAnnotationData);
      expect(after.geometry.type).toBe('rectangle');
      expect(painted?.type).toBe('rectangle');
      if (after.geometry.type !== 'rectangle' || painted?.type !== 'rectangle') return;
      expect(after.geometry.origin.x).toBeCloseTo(painted.origin.x, 3);
      expect(after.geometry.origin.y).toBeCloseTo(painted.origin.y, 3);
      expect(after.geometry.width).toBe(100);
      expect(after.geometry.height).toBe(50);
      expect(after.geometry.rotation).toBe(rotation);
    },
  );

  it('places an unrotated one half its size up and to the left of its saved centre', () => {
    const before = legacyRect({ x: 10, y: 20 }, 0);
    expect(migrateLegacyRectangle(before).geometry).toEqual({
      type: 'rectangle',
      origin: { x: -40, y: -5 },
      width: 100,
      height: 50,
      rotation: 0,
    });
  });

  it('matches the saved left/top to the geometry despite toObject() rounding it', () => {
    const before = legacy(0);
    expect(before.rawAnnotationData.data.left).toBe(132.3858);
    expect(before.geometry.type === 'rectangle' && before.geometry.origin.x).toBe(DRAWN.x);
    const after = migrateLegacyRectangle(before);
    expect(after).not.toBe(before);
    if (after.geometry.type !== 'rectangle') return;
    expect(after.geometry.origin.x).toBeCloseTo(DRAWN.x - 50, 3);
    expect(after.geometry.origin.y).toBeCloseTo(DRAWN.y - 25, 3);
  });

  it('migrates a rectangle that was resized before it was saved', async () => {
    const before = legacyRect({ x: 512.123456789, y: 77.987654321 }, 15, { x: 1.37, y: 0.61 });
    const after = migrateLegacyRectangle(before);
    const painted = await paintedGeometry(before);
    expect(after).not.toBe(before);
    if (after.geometry.type !== 'rectangle' || painted?.type !== 'rectangle') return;
    expect(after.geometry.origin.x).toBeCloseTo(painted.origin.x, 3);
    expect(after.geometry.origin.y).toBeCloseTo(painted.origin.y, 3);
    expect(after.geometry.width).toBeCloseTo(137);
    expect(after.geometry.height).toBeCloseTo(30.5);
  });

  it('migrates a rectangle converted from a circle by an earlier release', async () => {
    // 0.21.0 converted a circle to its bounding box and built it as above:
    // the corner, centre minus radius, as left/top with no origin.
    const center = { x: 300.333333333, y: 140.666666667 };
    const radius = 25.123456789;
    const object = new Rect({
      ...options,
      left: center.x - radius,
      top: center.y - radius,
      width: 2 * radius,
      height: 2 * radius,
    });
    const before = annotation(
      {
        type: 'rectangle',
        origin: { x: center.x - radius, y: center.y - radius },
        width: 2 * radius,
        height: 2 * radius,
        rotation: 0,
      },
      object,
    );
    const after = migrateLegacyRectangle(before);
    const painted = await paintedGeometry(before);
    expect(after).not.toBe(before);
    if (after.geometry.type !== 'rectangle' || painted?.type !== 'rectangle') return;
    expect(after.geometry.origin.x).toBeCloseTo(painted.origin.x, 3);
    expect(after.geometry.origin.y).toBeCloseTo(painted.origin.y, 3);
  });

  it('runs once: a migrated rectangle is left alone', () => {
    const once = migrateLegacyRectangle(legacy(30));
    expect(migrateLegacyRectangle(once)).toBe(once);
  });

  it('leaves a rectangle saved by the current release alone', () => {
    const geometry: Geometry = {
      type: 'rectangle',
      origin: { x: 10, y: 20 },
      width: 100,
      height: 50,
      rotation: 30,
    };
    const current = annotation(geometry, buildFabricObjectFromGeometry(geometry, options) as Rect);
    expect(migrateLegacyRectangle(current)).toBe(current);
  });

  it('leaves current rectangles alone at any size, rotation and position', () => {
    for (const size of [0.1, 1, 37.5, 1000]) {
      for (const rotation of [0, 15, 90, 180, -135]) {
        const geometry: Geometry = {
          type: 'rectangle',
          origin: { x: 1234.56789123, y: 98.7654321 },
          width: size,
          height: size / 3,
          rotation,
        };
        const current = annotation(
          geometry,
          buildFabricObjectFromGeometry(geometry, options) as Rect,
        );
        expect(migrateLegacyRectangle(current)).toBe(current);
      }
    }
  });

  it('leaves a rectangle whose Fabric data has a top-left origin alone: it was painted at its geometry', () => {
    const geometry: Geometry = {
      type: 'rectangle',
      origin: { x: 10, y: 20 },
      width: 100,
      height: 50,
      rotation: 0,
    };
    const topLeft = new Rect({
      ...options,
      left: 10,
      top: 20,
      width: 100,
      height: 50,
      originX: 'left',
      originY: 'top',
    });
    const ann = annotation(geometry, topLeft);
    expect(migrateLegacyRectangle(ann)).toBe(ann);
  });

  it('leaves a rectangle with no size alone: both readings agree', () => {
    const geometry: Geometry = {
      type: 'rectangle',
      origin: { x: 10, y: 20 },
      width: 0,
      height: 0,
      rotation: 0,
    };
    const ann = annotation(
      geometry,
      new Rect({ ...options, left: 10, top: 20, width: 0, height: 0 }),
    );
    expect(migrateLegacyRectangle(ann)).toBe(ann);
  });

  it('leaves other shapes alone', () => {
    const geometry: Geometry = { type: 'point', position: { x: 10, y: 20 } };
    const ann = annotation(geometry, new Rect({ ...options, left: 10, top: 20 }));
    expect(migrateLegacyRectangle(ann)).toBe(ann);
  });
});
