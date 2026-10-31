import { describe, it, expect } from 'vitest';
import {
  DEFAULT_ANNOTATION_STYLE,
  DEFAULT_POINT_RADIUS,
  createAnnotationId,
} from '@osdlabel/annotation';
import type { Geometry } from '@osdlabel/annotation';
import { buildFabricObjectFromGeometry } from '../../src/build-fabric-object.js';
import { getFabricOptions, getGeometryFromFabricObject } from '../../src/fabric-utils.js';
import { initFabricModule } from '../../src/fabric-module.js';
import { Rect, type Circle } from 'fabric';

// Register custom Fabric properties so toObject() includes `id`.
initFabricModule();

const id = createAnnotationId('test-1');
const options = getFabricOptions(DEFAULT_ANNOTATION_STYLE, id);

/** Build a Fabric object from geometry and read it straight back. */
function roundTrip(geometry: Geometry): Geometry {
  const obj = buildFabricObjectFromGeometry(geometry, options);
  const back = getGeometryFromFabricObject(obj, geometry.type);
  expect(back).not.toBeNull();
  return back as Geometry;
}

describe('buildFabricObjectFromGeometry', () => {
  it('round-trips rectangle geometry', () => {
    const geometry: Geometry = {
      type: 'rectangle',
      origin: { x: 10, y: 20 },
      width: 100,
      height: 50,
      rotation: 0,
    };
    const back = roundTrip(geometry);
    expect(back.type).toBe('rectangle');
    if (back.type !== 'rectangle') return;
    expect(back.origin.x).toBeCloseTo(10);
    expect(back.origin.y).toBeCloseTo(20);
    expect(back.width).toBeCloseTo(100);
    expect(back.height).toBeCloseTo(50);
    expect(back.rotation).toBeCloseTo(0);
  });

  it('round-trips a rotated rectangle', () => {
    const geometry: Geometry = {
      type: 'rectangle',
      origin: { x: 10, y: 20 },
      width: 100,
      height: 50,
      rotation: 30,
    };
    const back = roundTrip(geometry);
    expect(back.type).toBe('rectangle');
    if (back.type !== 'rectangle') return;
    expect(back.origin.x).toBeCloseTo(10);
    expect(back.origin.y).toBeCloseTo(20);
    expect(back.width).toBeCloseTo(100);
    expect(back.height).toBeCloseTo(50);
    expect(back.rotation).toBeCloseTo(30);
  });

  it('round-trips circle geometry', () => {
    const geometry: Geometry = {
      type: 'circle',
      center: { x: 200, y: 150 },
      radius: 40,
    };
    const back = roundTrip(geometry);
    expect(back.type).toBe('circle');
    if (back.type !== 'circle') return;
    expect(back.center.x).toBeCloseTo(200);
    expect(back.center.y).toBeCloseTo(150);
    expect(back.radius).toBeCloseTo(40);
  });

  it('round-trips line geometry', () => {
    const geometry: Geometry = {
      type: 'line',
      start: { x: 5, y: 5 },
      end: { x: 95, y: 65 },
    };
    const back = roundTrip(geometry);
    expect(back.type).toBe('line');
    if (back.type !== 'line') return;
    expect(back.start.x).toBeCloseTo(5);
    expect(back.start.y).toBeCloseTo(5);
    expect(back.end.x).toBeCloseTo(95);
    expect(back.end.y).toBeCloseTo(65);
  });

  it('renders point geometry at DEFAULT_POINT_RADIUS by default', () => {
    const obj = buildFabricObjectFromGeometry({ type: 'point', position: { x: 1, y: 2 } }, options);
    expect((obj as Circle).radius).toBe(DEFAULT_POINT_RADIUS);
  });

  it('renders point geometry at an explicit radius', () => {
    const obj = buildFabricObjectFromGeometry(
      { type: 'point', position: { x: 1, y: 2 } },
      options,
      12,
    );
    expect((obj as Circle).radius).toBe(12);
  });

  it('round-trips point geometry', () => {
    const geometry: Geometry = { type: 'point', position: { x: 42, y: 84 } };
    const back = roundTrip(geometry);
    expect(back.type).toBe('point');
    if (back.type !== 'point') return;
    expect(back.position.x).toBeCloseTo(42);
    expect(back.position.y).toBeCloseTo(84);
  });

  it('round-trips polyline geometry', () => {
    const points = [
      { x: 0, y: 0 },
      { x: 30, y: 10 },
      { x: 60, y: 0 },
    ];
    const back = roundTrip({ type: 'polyline', points });
    expect(back.type).toBe('polyline');
    if (back.type !== 'polyline') return;
    expect(back.points).toHaveLength(3);
    back.points.forEach((p, i) => {
      expect(p.x).toBeCloseTo(points[i]!.x);
      expect(p.y).toBeCloseTo(points[i]!.y);
    });
  });

  it('round-trips polygon geometry', () => {
    const points = [
      { x: 0, y: 0 },
      { x: 50, y: 0 },
      { x: 25, y: 40 },
    ];
    const back = roundTrip({ type: 'polygon', points });
    expect(back.type).toBe('polygon');
    if (back.type !== 'polygon') return;
    expect(back.points).toHaveLength(3);
    back.points.forEach((p, i) => {
      expect(p.x).toBeCloseTo(points[i]!.x);
      expect(p.y).toBeCloseTo(points[i]!.y);
    });
  });

  it('sets the id on the built object so it serializes', () => {
    const obj = buildFabricObjectFromGeometry({ type: 'point', position: { x: 1, y: 2 } }, options);
    expect((obj.toObject() as { id?: string }).id).toBe(id);
  });
});

describe('rectangle placement', () => {
  const rectangle = (rotation: number): Geometry => ({
    type: 'rectangle',
    origin: { x: 10, y: 20 },
    width: 100,
    height: 50,
    rotation,
  });

  it('paints a rectangle centred on its geometry, not on its origin corner', () => {
    const obj = buildFabricObjectFromGeometry(rectangle(0), options);
    const center = obj.getCenterPoint();
    expect(center.x).toBeCloseTo(60);
    expect(center.y).toBeCloseTo(45);
  });

  it('rotates a rectangle about its centre, as centroid() assumes', () => {
    const obj = buildFabricObjectFromGeometry(rectangle(30), options);
    const center = obj.getCenterPoint();
    expect(center.x).toBeCloseTo(60);
    expect(center.y).toBeCloseTo(45);
    expect(obj.angle).toBe(30);
  });

  it('reads the true corner of a rectangle saved with Fabric 7’s default centre origin', () => {
    // What earlier releases saved for a drag from (10, 20): left/top at the
    // drag start, under Fabric's default centre origin.
    const saved = new Rect({ ...options, left: 10, top: 20, width: 100, height: 50 });
    expect(getGeometryFromFabricObject(saved, 'rectangle')).toMatchObject({
      origin: { x: -40, y: -5 },
      width: 100,
      height: 50,
    });
  });

  it('reads the corner the same way whatever the object’s origin', () => {
    const topLeft = new Rect({
      left: 10,
      top: 20,
      width: 100,
      height: 50,
      angle: 30,
      strokeWidth: 0,
      originX: 'left',
      originY: 'top',
    });
    // left/top place the rotated top-left corner; the centre is half the
    // size from it along the rotated edges, and origin half the size from
    // the centre along the image axes.
    const theta = (30 * Math.PI) / 180;
    const centre = {
      x: 10 + 50 * Math.cos(theta) - 25 * Math.sin(theta),
      y: 20 + 50 * Math.sin(theta) + 25 * Math.cos(theta),
    };
    const back = getGeometryFromFabricObject(topLeft, 'rectangle');
    expect(back?.type).toBe('rectangle');
    if (back?.type !== 'rectangle') return;
    expect(back.origin.x).toBeCloseTo(centre.x - 50);
    expect(back.origin.y).toBeCloseTo(centre.y - 25);
    expect(back.rotation).toBe(30);
  });
});
