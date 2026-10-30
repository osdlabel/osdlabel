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
 *
 * `OsdAnnotationCrossFieldSchema` runs those three checks alone, on an entry as
 * written, for `deserialize` to run before it decodes any mask: every payload
 * that is not Fabric counts as a mask payload there, and a field it cannot
 * read is left to `OsdAnnotationSchema`, but for a mask payload's geometry,
 * which decoding replaces: that must be a mask geometry, or be omitted.
 */
import { describe, expect, it } from 'vitest';
import * as v from 'valibot';
import { Circle, Line, Polygon, Polyline, Rect, type FabricObject } from 'fabric';
import { toolTypeToGeometryType, type ToolType } from '@osdlabel/annotation';
import { OsdAnnotationCrossFieldSchema, OsdAnnotationSchema } from '../../src/index.js';

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
      `Annotation "ann-${g}" has ${g} geometry, but its rawAnnotationData's format is "osdlabel-mask", not "fabric"`,
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

/** The messages of the issues a parse reported, in order; none for a success. */
function messages(result: {
  readonly issues?: readonly { readonly message: string }[] | undefined;
}): string[] {
  return (result.issues ?? []).map((issue) => issue.message);
}

/** A mask payload in a codec's format, as `serialize` writes it with `{ maskCodec }`. */
const COCO_RAW = { format: 'coco-rle', data: { size: [600, 800], counts: 'PQ5' } } as const;

describe('OsdAnnotationCrossFieldSchema: the same checks, on an entry as written', () => {
  // Every well-formed annotation the tests above parse: each pairing of a
  // geometry and a payload, of a tool and a geometry, and the two together.
  const wellFormed: readonly (readonly [string, unknown])[] = [
    ...pairings.map(
      ([g, f]) => [`${g} geometry with a ${f} payload`, annotation(g, PAYLOADS[f])] as const,
    ),
    ...toolPairings.map(([t, g]) => [`toolType ${t} with ${g} geometry`, drawnBy(g, t)] as const),
    ...fabricClasses.map(
      (cls) =>
        [
          `mask geometry with a ${cls} payload`,
          {
            ...maskAnnotation(),
            rawAnnotationData: { format: 'fabric', fabricVersion: '7.4.0', data: PAYLOADS[cls] },
          },
        ] as const,
    ),
    ...geometryNames.map(
      (g) =>
        [
          `${g} geometry with a mask payload`,
          {
            ...(annotation(g, PAYLOADS[PAINTED_BY[g]]) as Record<string, unknown>),
            rawAnnotationData: MASK_RAW,
          },
        ] as const,
    ),
    [
      'a wrong payload and a wrong toolType',
      {
        ...(annotation('rectangle', PAYLOADS.Circle) as Record<string, unknown>),
        toolType: 'point',
      },
    ],
  ];

  it('covers every pairing tried above', () => {
    expect(wellFormed).toHaveLength(30 + 49 + 5 + 6 + 1);
  });

  it.each(wellFormed)('%s: reported as OsdAnnotationSchema reports it', (_name, input) => {
    const full = v.safeParse(OsdAnnotationSchema, input);
    const cross = v.safeParse(OsdAnnotationCrossFieldSchema, input);
    expect(cross.success).toBe(full.success);
    expect(messages(cross)).toEqual(messages(full));
  });

  it('passes its input through unchanged', () => {
    const input = annotation('rectangle', PAYLOADS.Rect);
    expect(v.parse(OsdAnnotationCrossFieldSchema, input)).toBe(input);
  });
});

describe("OsdAnnotationCrossFieldSchema: every payload but Fabric is a mask's", () => {
  it('accepts a mask exported through a codec, which OsdAnnotationSchema cannot read', () => {
    const input = { ...maskAnnotation(), rawAnnotationData: COCO_RAW };
    expect(v.safeParse(OsdAnnotationCrossFieldSchema, input).success).toBe(true);
    expect(v.safeParse(OsdAnnotationSchema, input).success).toBe(false);
  });

  it.each(geometryNames)('refuses %s geometry over it, quoting its format', (g) => {
    const input = {
      ...(annotation(g, PAYLOADS[PAINTED_BY[g]]) as Record<string, unknown>),
      rawAnnotationData: COCO_RAW,
    };
    expect(messages(v.safeParse(OsdAnnotationCrossFieldSchema, input))).toEqual([
      `Annotation "ann-${g}" has ${g} geometry, but its rawAnnotationData's format is "coco-rle", not "fabric"`,
    ]);
  });

  it('reports the brush drawing that geometry as well, after the payload', () => {
    const input = {
      ...(annotation('rectangle', PAYLOADS.Rect) as Record<string, unknown>),
      toolType: 'segmentationBrush',
      rawAnnotationData: COCO_RAW,
    };
    expect(messages(v.safeParse(OsdAnnotationCrossFieldSchema, input))).toEqual([
      'Annotation "ann-rectangle" has rectangle geometry, but its rawAnnotationData\'s format is "coco-rle", not "fabric"',
      'Annotation "ann-rectangle" has rectangle geometry, but its toolType is "segmentationBrush", not "rectangle"',
    ]);
  });

  /**
   * Before decoding, a format that is not `'fabric'` may as well be a
   * misspelling of it as a mask's, so the issue names the format and the one
   * the geometry needs, rather than calling the payload a mask.
   */
  it.each(['Fabric', 'fabric ', 'fabricjs'])(
    'names a misspelled Fabric format, %j, against the one it needs',
    (format) => {
      const input = {
        ...(annotation('rectangle', PAYLOADS.Rect) as Record<string, unknown>),
        rawAnnotationData: { format, fabricVersion: '7.4.0', data: PAYLOADS.Rect },
      };
      expect(messages(v.safeParse(OsdAnnotationCrossFieldSchema, input))).toEqual([
        `Annotation "ann-rectangle" has rectangle geometry, but its rawAnnotationData's format is "${format}", not "fabric"`,
      ]);
    },
  );

  it('refuses a mask recorded under another tool, whatever its format', () => {
    const input = { ...maskAnnotation(), toolType: 'polyline', rawAnnotationData: COCO_RAW };
    expect(messages(v.safeParse(OsdAnnotationCrossFieldSchema, input))).toEqual([
      'Annotation "ann-mask" has mask geometry, but its toolType is "polyline", not "segmentationBrush"',
    ]);
  });
});

/** The tool types that do not draw a mask, read off `DRAWS`. */
const NON_MASK_TOOLS = TOOL_TYPES.filter((t) => !DRAWS[t].includes('mask'));

/** `maskAnnotation()` with its geometry omitted: the key is not there at all. */
function withoutGeometry(changes: Record<string, unknown>): Record<string, unknown> {
  const input: Record<string, unknown> = { ...maskAnnotation(), ...changes };
  delete input['geometry'];
  return input;
}

describe("OsdAnnotationCrossFieldSchema: a mask payload's geometry is a mask's, or none", () => {
  // Decoding replaces a mask entry's geometry with the one its pixels give,
  // so what the entry declared is read here or never. Each of these loaded as
  // a mask when recorded under the brush; under another tool each was refused
  // only once its pixels had been decoded, and skipped if they could not be.
  const malformed: readonly (readonly [string, unknown, string])[] = [
    ['null', null, 'null'],
    ['an array', [MASK_GEOMETRY], 'an array'],
    ['a string', 'rectangle', 'a string'],
    ['a number', 42, 'a number'],
    ['a boolean', true, 'a boolean'],
    ['an empty object', {}, 'an object with no type'],
    ['an object with no prototype', Object.create(null), 'an object with no type'],
    [
      'a mask geometry with no type',
      { ...MASK_GEOMETRY, type: undefined },
      'an object with no type',
    ],
    [
      'a miscased rectangle type',
      { type: 'Rectangle', origin: { x: 10, y: 20 }, width: 30, height: 40, rotation: 0 },
      'an object whose type is "Rectangle"',
    ],
    ['a miscased mask type', { ...MASK_GEOMETRY, type: 'Mask' }, 'an object whose type is "Mask"'],
    ['a type no geometry has', { type: 'blob' }, 'an object whose type is "blob"'],
    ['a numeric type', { ...MASK_GEOMETRY, type: 7 }, 'an object whose type is a number'],
    ['a null type', { ...MASK_GEOMETRY, type: null }, 'an object whose type is null'],
    ['a type that is an array', { type: ['mask'] }, 'an object whose type is an array'],
    ['a type that is an object', { type: { type: 'mask' } }, 'an object whose type is an object'],
  ];
  const cases = [MASK_RAW, COCO_RAW].flatMap((raw) =>
    malformed.map(([name, geometry, found]) => [raw.format, name, raw, geometry, found] as const),
  );

  it.each(cases)(
    'with format %s, a geometry that is %s is refused, saying what it is',
    (format, _name, raw, geometry, found) => {
      const input = { ...maskAnnotation(), geometry, rawAnnotationData: raw };
      expect(messages(v.safeParse(OsdAnnotationCrossFieldSchema, input))).toEqual([
        `Annotation "ann-mask" has a mask payload (format "${format}"), but its geometry is ${found}, not a mask geometry`,
      ]);
      // As written, the full schema refuses it too: this refuses nothing it accepts.
      expect(v.safeParse(OsdAnnotationSchema, input).success).toBe(false);
    },
  );

  it.each([...TOOL_TYPES, 'brush', undefined])(
    'reports that alone under toolType %s: there is no geometry for a tool to draw',
    (toolType) => {
      const input = {
        ...maskAnnotation(),
        toolType,
        geometry: { ...MASK_GEOMETRY, type: 'Rectangle' },
        rawAnnotationData: COCO_RAW,
      };
      expect(messages(v.safeParse(OsdAnnotationCrossFieldSchema, input))).toEqual([
        'Annotation "ann-mask" has a mask payload (format "coco-rle"), but its geometry is an object whose type is "Rectangle", not a mask geometry',
      ]);
    },
  );

  it('quotes a type as JSON, and no more than 32 characters of it', () => {
    const long = {
      ...maskAnnotation(),
      geometry: { type: `${'x'.repeat(40)}${'y'.repeat(4000)}` },
    };
    expect(messages(v.safeParse(OsdAnnotationCrossFieldSchema, long))).toEqual([
      `Annotation "ann-mask" has a mask payload (format "osdlabel-mask"), but its geometry is an object whose type is "${'x'.repeat(32)}"…, not a mask geometry`,
    ]);
    const quoted = { ...maskAnnotation(), geometry: { type: 'Rect"\nangle' } };
    expect(messages(v.safeParse(OsdAnnotationCrossFieldSchema, quoted))).toEqual([
      'Annotation "ann-mask" has a mask payload (format "osdlabel-mask"), but its geometry is an object whose type is "Rect\\"\\nangle", not a mask geometry',
    ]);
  });

  it('names an entry with no string id as such', () => {
    const input = { ...maskAnnotation(), id: 7, geometry: null };
    expect(messages(v.safeParse(OsdAnnotationCrossFieldSchema, input))).toEqual([
      'An annotation with no string id has a mask payload (format "osdlabel-mask"), but its geometry is null, not a mask geometry',
    ]);
  });

  it.each(geometryNames)(
    'still names a %s geometry by its type, however malformed the rest of it',
    (g) => {
      const input = { ...maskAnnotation(), geometry: { type: g }, rawAnnotationData: COCO_RAW };
      const tools = TOOL_TYPES.filter((t) => DRAWS[t].includes(g)).map((t) => `"${t}"`);
      expect(messages(v.safeParse(OsdAnnotationCrossFieldSchema, input))).toEqual([
        `Annotation "ann-mask" has ${g} geometry, but its rawAnnotationData's format is "coco-rle", not "fabric"`,
        `Annotation "ann-mask" has ${g} geometry, but its toolType is "segmentationBrush", not ${tools.join(' or ')}`,
      ]);
    },
  );

  describe('a mask payload may omit its geometry, which decoding supplies', () => {
    it.each([MASK_RAW, COCO_RAW])(
      'accepts format $format with no geometry, under the brush',
      (raw) => {
        for (const input of [
          withoutGeometry({ rawAnnotationData: raw }),
          { ...maskAnnotation(), geometry: undefined, rawAnnotationData: raw },
        ]) {
          expect(messages(v.safeParse(OsdAnnotationCrossFieldSchema, input))).toEqual([]);
          // The one geometry it accepts that the full schema, as written, does not.
          expect(v.safeParse(OsdAnnotationSchema, input).success).toBe(false);
        }
      },
    );

    const refused = [MASK_RAW, COCO_RAW].flatMap((raw) =>
      NON_MASK_TOOLS.map((toolType) => [raw.format, toolType, raw] as const),
    );

    it.each(refused)(
      'refuses format %s with no geometry under the %s tool, as it would a mask geometry',
      (_format, toolType, raw) => {
        const expected = [
          `Annotation "ann-mask" has mask geometry, but its toolType is "${toolType}", not "segmentationBrush"`,
        ];
        const omitted = withoutGeometry({ toolType, rawAnnotationData: raw });
        expect(messages(v.safeParse(OsdAnnotationCrossFieldSchema, omitted))).toEqual(expected);
        expect(v.safeParse(OsdAnnotationSchema, omitted).success).toBe(false);
        const declared = { ...maskAnnotation(), toolType, rawAnnotationData: raw };
        expect(messages(v.safeParse(OsdAnnotationCrossFieldSchema, declared))).toEqual(expected);
      },
    );

    it.each(['brush', 7, undefined])(
      'passes one with none under toolType %s, for OsdAnnotationSchema to refuse',
      (toolType) => {
        const input = withoutGeometry({ toolType });
        expect(messages(v.safeParse(OsdAnnotationCrossFieldSchema, input))).toEqual([]);
        expect(v.safeParse(OsdAnnotationSchema, input).success).toBe(false);
      },
    );
  });

  describe('only a mask payload: the rule reads no other geometry', () => {
    const rect = annotation('rectangle', PAYLOADS.Rect) as Record<string, unknown>;
    const noFormat = { data: MASK_RAW.data };

    it.each(malformed)(
      'passes %s under a Fabric payload, or one with no format, for OsdAnnotationSchema to refuse',
      (_name, geometry) => {
        for (const input of [
          { ...rect, geometry },
          { ...maskAnnotation(), geometry, rawAnnotationData: noFormat },
        ]) {
          expect(messages(v.safeParse(OsdAnnotationCrossFieldSchema, input))).toEqual([]);
          expect(v.safeParse(OsdAnnotationSchema, input).success).toBe(false);
        }
      },
    );

    it('passes a Fabric payload with no geometry, for OsdAnnotationSchema to refuse', () => {
      const input: Record<string, unknown> = { ...rect };
      delete input['geometry'];
      expect(messages(v.safeParse(OsdAnnotationCrossFieldSchema, input))).toEqual([]);
      expect(v.safeParse(OsdAnnotationSchema, input).success).toBe(false);
    });
  });
});

describe('OsdAnnotationCrossFieldSchema: it checks only what it can read', () => {
  const rect = annotation('rectangle', PAYLOADS.Rect) as Record<string, unknown>;
  const fabric = { format: 'fabric', fabricVersion: '7.4.0' };
  // Each of these is malformed, and each would be a mismatch if the field
  // that is missing or of the wrong type were read as anything.
  const unreadable: readonly (readonly [string, unknown])[] = [
    ['null', null],
    ['a number', 42],
    ['an array', [rect]],
    ['an object with no prototype', Object.create(null)],
    // Under a Fabric payload: a mask payload's geometry is read whatever it is.
    ['no geometry', { ...rect, geometry: undefined, toolType: 'line' }],
    ['a null geometry', { ...rect, geometry: null, toolType: 'line' }],
    ['a geometry type no geometry has', { ...rect, geometry: { type: 'blob' }, toolType: 'line' }],
    ['a toolType no tool has', { ...maskAnnotation(), toolType: 'brush' }],
    ['a payload that is a string', { ...maskAnnotation(), rawAnnotationData: 'osdlabel-mask' }],
    ['a payload with no format', { ...rect, rawAnnotationData: { data: MASK_RAW.data } }],
    ['a format that is not a string', { ...rect, rawAnnotationData: { format: 1, data: {} } }],
    [
      'a Fabric payload with no class',
      { ...rect, geometry: GEOMETRIES.circle, toolType: 'circle', rawAnnotationData: fabric },
    ],
    [
      'a Fabric payload whose class is not a string',
      {
        ...rect,
        geometry: GEOMETRIES.circle,
        toolType: 'circle',
        rawAnnotationData: { ...fabric, data: { type: 7 } },
      },
    ],
  ];

  it.each(unreadable)('passes %s, for OsdAnnotationSchema to refuse', (_name, input) => {
    expect(messages(v.safeParse(OsdAnnotationCrossFieldSchema, input))).toEqual([]);
    expect(v.safeParse(OsdAnnotationSchema, input).success).toBe(false);
  });

  /**
   * Only the message reads the `id`. Gating the checks on it let an entry
   * with a mismatch it could read through to decoding, which skipped it when
   * its pixels were corrupt, and the document loaded.
   */
  it.each([
    ['a number', 7],
    ['missing', undefined],
  ])('checks an entry whose id is %s, naming it as having no string id', (_name, id) => {
    const input = { ...rect, id, toolType: 'segmentationBrush', rawAnnotationData: MASK_RAW };
    expect(messages(v.safeParse(OsdAnnotationCrossFieldSchema, input))).toEqual([
      'An annotation with no string id has rectangle geometry, but its rawAnnotationData\'s format is "osdlabel-mask", not "fabric"',
      'An annotation with no string id has rectangle geometry, but its toolType is "segmentationBrush", not "rectangle"',
    ]);
    expect(v.safeParse(OsdAnnotationSchema, input).success).toBe(false);
  });

  it("does not compare a mask geometry's numbers, which decoding replaces", () => {
    const input = { ...maskAnnotation(), geometry: { type: 'mask', width: 'wide' } };
    expect(v.safeParse(OsdAnnotationCrossFieldSchema, input).success).toBe(true);
  });

  it('still reports a mismatch it can read beside a field it cannot', () => {
    expect(
      messages(
        v.safeParse(OsdAnnotationCrossFieldSchema, {
          ...rect,
          toolType: 'brush',
          rawAnnotationData: MASK_RAW,
        }),
      ),
    ).toEqual([
      'Annotation "ann-rectangle" has rectangle geometry, but its rawAnnotationData\'s format is "osdlabel-mask", not "fabric"',
    ]);
    expect(
      messages(
        v.safeParse(OsdAnnotationCrossFieldSchema, {
          ...rect,
          toolType: 'line',
          rawAnnotationData: fabric,
        }),
      ),
    ).toEqual([
      'Annotation "ann-rectangle" has rectangle geometry, but its toolType is "line", not "rectangle"',
    ]);
  });
});
