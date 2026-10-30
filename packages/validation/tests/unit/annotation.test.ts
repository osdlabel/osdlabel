/**
 * `OsdAnnotationSchema` checks that an annotation's saved Fabric payload is
 * the kind of object its geometry describes. The payload is what is painted
 * and the geometry is what is measured and exported, so an annotation whose
 * two disagree in kind (rectangle geometry, a Circle painted) would measure a
 * shape nobody sees.
 *
 * A mask is the exception: its payload is pixels (`osdlabel-mask`), not a
 * Fabric object, and a mask geometry with a Fabric payload, or a vector
 * geometry with a mask payload, is refused before the class is compared.
 *
 * It also checks that the annotation's `toolType` names a tool that draws its
 * geometry's type. Constraints count annotations by `toolType`, so a rectangle
 * recorded as drawn by the line tool would use up a line and free a rectangle.
 */
import { describe, expect, it } from 'vitest';
import * as v from 'valibot';
import { Circle, Line, Polygon, Polyline, Rect, type FabricObject } from 'fabric';
import { toolTypeToGeometryType, type ToolType } from '@osdlabel/annotation';
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

/** A mask geometry, and the pixel payload that matches it. */
const MASK_GEOMETRY = {
  type: 'mask',
  origin: { x: 10, y: 20 },
  width: 30,
  height: 40,
  pixelCount: 500,
} as const;
const MASK_RAW = {
  format: 'osdlabel-mask',
  data: {
    x: 10,
    y: 20,
    width: 30,
    height: 40,
    imageWidth: 800,
    imageHeight: 600,
    counts: 'AAEC',
  },
} as const;

/** A mask annotation, as the segmentation brush writes it. */
function maskAnnotation(): Record<string, unknown> {
  return {
    id: 'ann-mask',
    imageId: 'img-1',
    contextId: 'ctx-1',
    geometry: MASK_GEOMETRY,
    toolType: 'segmentationBrush',
    createdAt: '2026-10-01T12:00:00.000Z',
    updatedAt: '2026-10-01T12:00:00.000Z',
    rawAnnotationData: MASK_RAW,
  };
}

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

describe('OsdAnnotationSchema: a mask needs a mask payload, and a vector geometry a Fabric one', () => {
  it('accepts a mask with a mask payload', () => {
    const input = maskAnnotation();
    expect(v.parse(OsdAnnotationSchema, input)).toEqual(input);
  });

  it.each(fabricClasses)('refuses a mask with a %s payload, naming the annotation', (cls) => {
    const result = v.safeParse(OsdAnnotationSchema, {
      ...maskAnnotation(),
      rawAnnotationData: { format: 'fabric', fabricVersion: '7.4.0', data: PAYLOADS[cls] },
    });
    expect(result.success).toBe(false);
    expect(result.issues).toBeDefined();
    // Only the pairing is reported: a mask has no Fabric class to compare.
    expect(result.issues!.map((issue) => issue.message)).toEqual([
      'Annotation "ann-mask" has mask geometry, but its rawAnnotationData is a "fabric" payload, not "osdlabel-mask"',
    ]);
  });

  it.each(geometryNames)('refuses %s geometry with a mask payload, naming the annotation', (g) => {
    const input = {
      ...(annotation(g, PAYLOADS[PAINTED_BY[g]]) as Record<string, unknown>),
      rawAnnotationData: MASK_RAW,
    };
    const result = v.safeParse(OsdAnnotationSchema, input);
    expect(result.success).toBe(false);
    expect(result.issues).toBeDefined();
    expect(result.issues!.map((issue) => issue.message)).toEqual([
      `Annotation "ann-${g}" has ${g} geometry, but its rawAnnotationData is a "osdlabel-mask" payload, not a Fabric object`,
    ]);
  });
});

/** Every tool type, as `ToolTypeSchema` lists them. */
const TOOL_TYPES = [
  'rectangle',
  'circle',
  'line',
  'point',
  'polyline',
  'freeHandPath',
  'segmentationBrush',
] as const satisfies readonly ToolType[];

/** Every geometry type: the vector ones and the mask. */
type AnyGeometryName = GeometryName | 'mask';
const allGeometryNames: readonly AnyGeometryName[] = [...geometryNames, 'mask'];

/**
 * The geometry types each tool commits, read off the tools: every shape tool
 * commits its own type, and the polyline and freehand tools commit a
 * `Polygon` when the path is closed and a `Polyline` when it is open, which
 * `getGeometryFromFabricObject` reads as polygon and polyline geometry. The
 * segmentation brush paints masks and nothing else. Every release since 0.1.0
 * has done the same.
 */
const DRAWS: Record<ToolType, readonly AnyGeometryName[]> = {
  rectangle: ['rectangle'],
  circle: ['circle'],
  line: ['line'],
  point: ['point'],
  polyline: ['polyline', 'polygon'],
  freeHandPath: ['polyline', 'polygon'],
  segmentationBrush: ['mask'],
};

/** `geometry` with the payload that paints it, recorded as drawn by `toolType`. */
function drawnBy(geometry: AnyGeometryName, toolType: string): unknown {
  const base =
    geometry === 'mask'
      ? maskAnnotation()
      : (annotation(geometry, PAYLOADS[PAINTED_BY[geometry]]) as Record<string, unknown>);
  return { ...base, toolType };
}

const toolPairings = TOOL_TYPES.flatMap((t) => allGeometryNames.map((g) => [t, g] as const));

describe('OsdAnnotationSchema: the toolType must draw the geometry', () => {
  it("every tool's static geometry type is among those it draws", () => {
    for (const toolType of TOOL_TYPES) {
      expect(DRAWS[toolType]).toContain(toolTypeToGeometryType(toolType));
    }
  });

  it('there are 9 pairings a tool draws and 40 it does not', () => {
    const drawn = toolPairings.filter(([t, g]) => DRAWS[t].includes(g));
    expect(drawn).toHaveLength(9);
    expect(toolPairings).toHaveLength(49);
  });

  it.each(toolPairings)('toolType %s with %s geometry', (toolType, geometry) => {
    const result = v.safeParse(OsdAnnotationSchema, drawnBy(geometry, toolType));
    expect(result.success).toBe(DRAWS[toolType].includes(geometry));
  });

  it('names the annotation, its geometry type, its toolType and the one it needs', () => {
    const result = v.safeParse(OsdAnnotationSchema, drawnBy('rectangle', 'line'));
    expect(result.success).toBe(false);
    expect(result.issues).toBeDefined();
    expect(result.issues!.map((issue) => issue.message)).toEqual([
      'Annotation "ann-rectangle" has rectangle geometry, but its toolType is "line", not "rectangle"',
    ]);
  });

  it('names the brush for a mask recorded under another tool', () => {
    const result = v.safeParse(OsdAnnotationSchema, drawnBy('mask', 'rectangle'));
    expect(result.issues).toBeDefined();
    expect(result.issues!.map((issue) => issue.message)).toEqual([
      'Annotation "ann-mask" has mask geometry, but its toolType is "rectangle", not "segmentationBrush"',
    ]);
  });

  it('names both tools that draw a path', () => {
    const result = v.safeParse(OsdAnnotationSchema, drawnBy('polygon', 'rectangle'));
    expect(result.issues).toBeDefined();
    expect(result.issues!.map((issue) => issue.message)).toEqual([
      'Annotation "ann-polygon" has polygon geometry, but its toolType is "rectangle", not "polyline" or "freeHandPath"',
    ]);
  });

  it('reports a wrong payload and a wrong toolType both, the payload first', () => {
    const input = {
      ...(annotation('rectangle', PAYLOADS.Circle) as Record<string, unknown>),
      toolType: 'point',
    };
    const result = v.safeParse(OsdAnnotationSchema, input);
    expect(result.issues).toBeDefined();
    expect(result.issues!.map((issue) => issue.message)).toEqual([
      'Annotation "ann-rectangle" has rectangle geometry, but its rawAnnotationData is a Fabric Circle, not a Rect',
      'Annotation "ann-rectangle" has rectangle geometry, but its toolType is "point", not "rectangle"',
    ]);
  });

  it('reports a toolType no tool has as malformed, not as a mismatch', () => {
    const result = v.safeParse(OsdAnnotationSchema, drawnBy('polygon', 'polygon'));
    expect(result.success).toBe(false);
    expect(result.issues).toBeDefined();
    expect(result.issues!).toHaveLength(1);
    expect(result.issues![0]!.message).toMatch(
      /^Invalid type: Expected .* but received "polygon"$/,
    );
  });
});
