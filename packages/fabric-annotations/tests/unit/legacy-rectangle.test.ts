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
 * A rectangle as earlier releases saved it: the dragged corner as both the
 * geometry's origin and the Fabric object's left/top, under Fabric 7's
 * default centre origin, so it was painted centred on that corner.
 */
function legacy(rotation: number): Annotation<FabricFields> {
  const geometry: Geometry = {
    type: 'rectangle',
    origin: { x: 10, y: 20 },
    width: 100,
    height: 50,
    rotation,
  };
  const object = new Rect({
    ...options,
    left: 10,
    top: 20,
    width: 100,
    height: 50,
    angle: rotation,
  });
  return annotation(geometry, object);
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
      expect(after.geometry.origin.x).toBeCloseTo(painted.origin.x);
      expect(after.geometry.origin.y).toBeCloseTo(painted.origin.y);
      expect(after.geometry.width).toBe(100);
      expect(after.geometry.height).toBe(50);
      expect(after.geometry.rotation).toBe(rotation);
    },
  );

  it('places an unrotated one half its size up and to the left', () => {
    const after = migrateLegacyRectangle(legacy(0));
    expect(after.geometry).toEqual({
      type: 'rectangle',
      origin: { x: -40, y: -5 },
      width: 100,
      height: 50,
      rotation: 0,
    });
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
