/**
 * `OsdAnnotationSchema` checks that an annotation's saved Fabric payload is
 * the kind of object its geometry describes. The payload is what is painted
 * and the geometry is what is measured and exported, so an annotation whose
 * two disagree in kind (rectangle geometry, a Circle painted) would measure a
 * shape nobody sees.
 */
import { describe, expect, it } from 'vitest';
import * as v from 'valibot';
import { Circle, Line, Polygon, Polyline, Rect, type FabricObject } from 'fabric';
import { OsdAnnotationSchema } from '../../src/index.js';

/** One geometry of each type. */
const GEOMETRIES = {
  rectangle: { type: 'rectangle', origin: { x: 10, y: 20 }, width: 100, height: 50, rotation: 0 },
  circle: { type: 'circle', center: { x: 60, y: 45 }, radius: 25 },
  point: { type: 'point', position: { x: 60, y: 45 } },
  line: { type: 'line', start: { x: 10, y: 20 }, end: { x: 110, y: 70 } },
  polyline: {
    type: 'polyline',
    points: [
      { x: 10, y: 20 },
      { x: 110, y: 70 },
      { x: 60, y: 90 },
    ],
  },
  polygon: {
    type: 'polygon',
    points: [
      { x: 10, y: 20 },
      { x: 110, y: 70 },
      { x: 60, y: 90 },
    ],
  },
} as const;

type GeometryName = keyof typeof GEOMETRIES;

type Payload = { readonly type: string } & Readonly<Record<string, unknown>>;

/** What Fabric saves for `obj`: `toObject()`, as `serializeFabricObject` stores it. */
function saved(obj: FabricObject): Payload {
  const data: Record<string, unknown> = { ...obj.toObject() };
  const type = data['type'];
  if (typeof type !== 'string') throw new Error(`toObject() wrote type ${String(type)}`);
  return { ...data, type };
}

/**
 * One payload of each Fabric class, as Fabric itself writes it, so the `type`
 * strings here are the ones real documents carry.
 */
const PAYLOADS = {
  Rect: saved(new Rect({ left: 60, top: 45, width: 100, height: 50 })),
  Circle: saved(new Circle({ left: 60, top: 45, radius: 25 })),
  Line: saved(new Line([10, 20, 110, 70])),
  Polyline: saved(
    new Polyline([
      { x: 10, y: 20 },
      { x: 110, y: 70 },
      { x: 60, y: 90 },
    ]),
  ),
  Polygon: saved(
    new Polygon([
      { x: 10, y: 20 },
      { x: 110, y: 70 },
      { x: 60, y: 90 },
    ]),
  ),
} as const;

type FabricClass = keyof typeof PAYLOADS;

/** The Fabric class that paints each geometry type. */
const PAINTED_BY: Record<GeometryName, FabricClass> = {
  rectangle: 'Rect',
  circle: 'Circle',
  point: 'Circle',
  line: 'Line',
  polyline: 'Polyline',
  polygon: 'Polygon',
};

function annotation(geometry: GeometryName, payload: Payload): unknown {
  return {
    id: `ann-${geometry}`,
    imageId: 'img-1',
    contextId: 'ctx-1',
    geometry: GEOMETRIES[geometry],
    toolType: geometry === 'polygon' ? 'freeHandPath' : geometry,
    createdAt: '2026-10-01T12:00:00.000Z',
    updatedAt: '2026-10-01T12:00:00.000Z',
    rawAnnotationData: { format: 'fabric', fabricVersion: '7.4.0', data: payload },
  };
}

const geometryNames = Object.keys(GEOMETRIES) as GeometryName[];
const fabricClasses = Object.keys(PAYLOADS) as FabricClass[];
const pairings = geometryNames.flatMap((g) => fabricClasses.map((f) => [g, f] as const));

describe('OsdAnnotationSchema: the Fabric payload must paint the geometry', () => {
  it('the payloads carry the type strings Fabric writes', () => {
    expect(fabricClasses.map((f) => PAYLOADS[f].type)).toEqual(fabricClasses);
  });

  it.each(pairings)('%s geometry with a %s payload', (geometry, fabricClass) => {
    const result = v.safeParse(OsdAnnotationSchema, annotation(geometry, PAYLOADS[fabricClass]));
    expect(result.success).toBe(PAINTED_BY[geometry] === fabricClass);
  });

  // Fabric's class registry revives a class under its lowercase name too, and
  // the payload schema has always accepted either spelling.
  it.each(geometryNames)('%s geometry with its payload type in lowercase', (geometry) => {
    const payload = PAYLOADS[PAINTED_BY[geometry]];
    const result = v.safeParse(
      OsdAnnotationSchema,
      annotation(geometry, { ...payload, type: payload.type.toLowerCase() }),
    );
    expect(result.success).toBe(true);
  });

  it('a lowercase payload of the wrong kind is still rejected', () => {
    const result = v.safeParse(
      OsdAnnotationSchema,
      annotation('rectangle', { ...PAYLOADS.Circle, type: 'circle' }),
    );
    expect(result.success).toBe(false);
  });

  it('names the annotation, its geometry type and both Fabric types', () => {
    const result = v.safeParse(OsdAnnotationSchema, annotation('rectangle', PAYLOADS.Circle));
    expect(result.success).toBe(false);
    expect(result.issues).toBeDefined();
    expect(result.issues!.map((issue) => issue.message)).toEqual([
      'Annotation "ann-rectangle" has rectangle geometry, but its rawAnnotationData is a Fabric Circle, not a Rect',
    ]);
  });

  it('quotes the payload type as saved', () => {
    const result = v.safeParse(
      OsdAnnotationSchema,
      annotation('point', { ...PAYLOADS.Line, type: 'line' }),
    );
    expect(result.issues).toBeDefined();
    expect(result.issues![0]!.message).toBe(
      'Annotation "ann-point" has point geometry, but its rawAnnotationData is a Fabric line, not a Circle',
    );
  });

  it('passes an accepted annotation through whole', () => {
    const input = annotation('rectangle', PAYLOADS.Rect);
    const parsed = v.parse(OsdAnnotationSchema, input);
    expect(parsed).toEqual(input);
    // Typed as the whole annotation, not just the fields the check reads.
    const fields: readonly string[] = [parsed.contextId, parsed.imageId, parsed.createdAt];
    expect(fields).toEqual(['ctx-1', 'img-1', '2026-10-01T12:00:00.000Z']);
  });

  it('reports a malformed annotation as malformed, not as a mismatch', () => {
    const malformed = annotation('rectangle', PAYLOADS.Rect) as Record<string, unknown>;
    delete malformed['rawAnnotationData'];
    const result = v.safeParse(OsdAnnotationSchema, malformed);
    expect(result.success).toBe(false);
    expect(result.issues).toBeDefined();
    expect(result.issues!.map((issue) => issue.message)).toEqual([
      'Invalid key: Expected "rawAnnotationData" but received undefined',
    ]);
  });
});
