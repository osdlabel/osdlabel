import * as v from 'valibot';
import { MASK_RAW_FORMAT } from '@osdlabel/annotation';
import type { GeometryType, ToolType, VectorGeometry } from '@osdlabel/annotation';
import { GeometrySchema } from './geometry.js';
import { ToolTypeSchema } from './tool.js';
import { FabricRawAnnotationDataSchema } from './fabric-data.js';
import { MaskRawAnnotationDataSchema } from './mask-data.js';

/**
 * Schema for {@link @osdlabel/annotation!BaseAnnotation | BaseAnnotation} — validates core annotation fields.
 * Extension fields (contextId, rawAnnotationData, etc.) are not checked here;
 * they pass through via v.looseObject behavior inherited by intersections.
 */
export const BaseAnnotationSchema = v.object({
  id: v.pipe(v.string(), v.minLength(1)),
  geometry: GeometrySchema,
  toolType: ToolTypeSchema,
  label: v.optional(v.string()),
  metadata: v.optional(v.record(v.string(), v.unknown())),
  createdAt: v.string(),
  updatedAt: v.string(),
});

/** Schema for the fields {@link osdlabel!OsdAnnotation | OsdAnnotation} adds to a base annotation. */
export const OsdFieldsSchema = v.object({
  imageId: v.pipe(v.string(), v.minLength(1)),
  contextId: v.pipe(v.string(), v.minLength(1)),
  // Vector annotations carry a serialized Fabric object; masks carry pixels.
  rawAnnotationData: v.variant('format', [
    FabricRawAnnotationDataSchema,
    MaskRawAnnotationDataSchema,
  ]),
});

/**
 * The Fabric class that paints each geometry type, as a saved payload's `type`
 * names it. A point is painted as a small circle. Every release has saved
 * these spellings (Fabric 7's `toObject()`); Fabric also revives a class by
 * its lowercase name, so the comparison ignores case, as the payload schema's
 * own type check does.
 */
const PAINTED_BY = {
  rectangle: 'Rect',
  circle: 'Circle',
  point: 'Circle',
  line: 'Line',
  polyline: 'Polyline',
  polygon: 'Polygon',
} as const satisfies Record<VectorGeometry['type'], string>;

/**
 * The geometry types each tool commits. Every shape tool commits its own type
 * (`toolTypeToGeometryType`). The polyline and freehand tools commit a closed
 * path as a `Polygon` and an open one as a `Polyline`, read back as polygon
 * and polyline geometry. Converting a circle to a rectangle records the
 * rectangle tool. The segmentation brush is the only tool that paints a mask.
 * Every release since 0.1.0 has saved exactly these pairings, so every
 * document one exported passes.
 */
const DRAWS = {
  rectangle: ['rectangle'],
  circle: ['circle'],
  line: ['line'],
  point: ['point'],
  polyline: ['polyline', 'polygon'],
  freeHandPath: ['polyline', 'polygon'],
  segmentationBrush: ['mask'],
} as const satisfies Record<ToolType, readonly GeometryType[]>;

const TOOL_TYPES = Object.keys(DRAWS) as readonly ToolType[];

const GEOMETRY_TYPES: readonly GeometryType[] = [
  ...(Object.keys(PAINTED_BY) as readonly VectorGeometry['type'][]),
  'mask',
];

/**
 * What the cross-field checks compare, read off one annotation.
 *
 * Read off a structurally valid annotation for `OsdAnnotationSchema`, where
 * every field is present, or off a document entry as declared, before
 * anything has been validated or decoded, for `OsdAnnotationCrossFieldSchema`.
 * There a field that is missing or of the wrong type is `undefined`, and each
 * check that needs it passes: what shape the entry has is the full schema's
 * question, not these checks'. The geometry under a mask payload is the
 * exception (see `declaredCrossFields`).
 */
interface CrossFields {
  /** The annotation as an issue names it: by its `id`, or as having none. */
  readonly subject: string;
  /**
   * The geometry's type. `undefined` only for an entry as written whose
   * payload is a mask's and whose geometry is present but is no geometry,
   * which the pairing check refuses.
   */
  readonly geometryType: GeometryType | undefined;
  /** The geometry as written, for that issue to describe. */
  readonly geometry: unknown;
  readonly toolType: ToolType | undefined;
  /** `rawAnnotationData.format`. Every format but `'fabric'` is a mask payload. */
  readonly format: string | undefined;
  /** `rawAnnotationData.data.type`, the saved Fabric class, for a Fabric payload. */
  readonly fabricClass: string | undefined;
}

/** The part of a structurally valid annotation the cross-field checks read. */
interface PaintedAnnotation {
  readonly id: string;
  readonly toolType: ToolType;
  readonly geometry: { readonly type: GeometryType };
  readonly rawAnnotationData:
    | { readonly format: 'fabric'; readonly data: { readonly type: string } }
    | { readonly format: typeof MASK_RAW_FORMAT };
}

/**
 * How an issue names an annotation. Only the message reads the `id`, so an
 * entry without a string one is still checked, and named as such.
 */
function subjectOf(id: unknown): string {
  return typeof id === 'string' ? `Annotation "${id}"` : 'An annotation with no string id';
}

function crossFieldsOf(annotation: PaintedAnnotation): CrossFields {
  const raw = annotation.rawAnnotationData;
  return {
    subject: subjectOf(annotation.id),
    geometryType: annotation.geometry.type,
    geometry: annotation.geometry,
    toolType: annotation.toolType,
    format: raw.format,
    fabricClass: raw.format === 'fabric' ? raw.data.type : undefined,
  };
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null;
}

function isGeometryType(value: unknown): value is GeometryType {
  return typeof value === 'string' && (GEOMETRY_TYPES as readonly string[]).includes(value);
}

function isToolType(value: unknown): value is ToolType {
  return typeof value === 'string' && (TOOL_TYPES as readonly string[]).includes(value);
}

/** The most of a declared `type` an issue quotes. */
const QUOTED_TYPE_LENGTH = 32;

/** A value's kind, as an issue names it: `null`, `an array`, `a string`, `an object`. */
function kindOf(value: unknown): string {
  if (value === null || value === undefined) return String(value);
  if (Array.isArray(value)) return 'an array';
  const kind = typeof value;
  return kind === 'object' ? 'an object' : `a ${kind}`;
}

/**
 * A geometry that is no geometry, as an issue describes it. It is untrusted,
 * so nothing of it is quoted but a `type` that is a string, and that cut
 * short; anything else is named by its kind.
 */
function describeGeometry(geometry: unknown): string {
  if (!isRecord(geometry) || Array.isArray(geometry)) return kindOf(geometry);
  const type = geometry['type'];
  if (type === undefined) return 'an object with no type';
  if (typeof type !== 'string') return `an object whose type is ${kindOf(type)}`;
  const quoted =
    type.length > QUOTED_TYPE_LENGTH
      ? `${JSON.stringify(type.slice(0, QUOTED_TYPE_LENGTH))}…`
      : JSON.stringify(type);
  return `an object whose type is ${quoted}`;
}

/**
 * The cross fields an entry declares, or `undefined` when there is no
 * geometry type to compare, which every check needs.
 *
 * A mask payload is the exception, since decoding replaces the entry's
 * geometry with the one its pixels give: whatever the entry declared is gone
 * by the time the full schema runs, so it is read here or never. Its geometry
 * may be omitted, since decoding supplies one, and then counts as the mask
 * geometry decoding will give it. Present, it must be a geometry, and the
 * pairing check refuses any but a mask's: one that is not (`null`,
 * `{ type: 'Rectangle' }`) leaves `geometryType` `undefined` for it to
 * refuse, rather than passing for the full schema to judge the replacement.
 */
function declaredCrossFields(entry: unknown): CrossFields | undefined {
  if (!isRecord(entry)) return undefined;
  const { id, geometry, toolType, rawAnnotationData: raw } = entry;
  const format = isRecord(raw) && typeof raw['format'] === 'string' ? raw['format'] : undefined;
  const declared = isRecord(geometry) ? geometry['type'] : undefined;
  let geometryType: GeometryType | undefined;
  if (isGeometryType(declared)) geometryType = declared;
  else if (format !== undefined && format !== 'fabric') {
    geometryType = geometry === undefined ? 'mask' : undefined;
  } else return undefined;
  const data = format === 'fabric' && isRecord(raw) ? raw['data'] : undefined;
  return {
    subject: subjectOf(id),
    geometryType,
    geometry,
    toolType: isToolType(toolType) ? toolType : undefined,
    format,
    fabricClass: isRecord(data) && typeof data['type'] === 'string' ? data['type'] : undefined,
  };
}

/**
 * Whether the payload is the kind its geometry needs: pixels for a mask,
 * Fabric otherwise. Every payload that is not Fabric counts as pixels, so a
 * mask payload in a format a codec converts is held to the same rule as a
 * canonical one. A geometry under a mask payload that is no geometry at all
 * fails here too: it is not a mask's.
 */
function pairsItsPayload(fields: CrossFields): boolean {
  if (fields.format === undefined) return true;
  return (fields.geometryType === 'mask') === (fields.format !== 'fabric');
}

/**
 * A vector geometry's issue names the payload's `format` against `'fabric'`,
 * the one it needs, rather than calling the payload a mask: before decoding,
 * a format that is not `'fabric'` may be a mask's or a misspelling
 * (`'Fabric'`), and only the format is certain.
 */
function pairMismatchMessage(fields: CrossFields): string {
  const { subject, geometryType, format } = fields;
  if (geometryType === undefined) {
    return (
      `${subject} has a mask payload (format "${String(format)}"), but its geometry is ` +
      `${describeGeometry(fields.geometry)}, not a mask geometry`
    );
  }
  return geometryType === 'mask'
    ? `${subject} has mask geometry, but its rawAnnotationData is a ` +
        `"${String(format)}" payload, not "${MASK_RAW_FORMAT}"`
    : `${subject} has ${geometryType} geometry, but its rawAnnotationData's format is ` +
        `"${String(format)}", not "fabric"`;
}

/**
 * Whether a Fabric payload is the class that paints its vector geometry. A
 * mask, or a payload of the wrong kind, passes here: `pairsItsPayload` owns
 * that case, and a mask payload has no class to compare.
 */
function paintsItsGeometry(fields: CrossFields): boolean {
  const { geometryType, format, fabricClass } = fields;
  if (geometryType === undefined || geometryType === 'mask') return true;
  if (format !== 'fabric' || fabricClass === undefined) return true;
  return fabricClass.toLowerCase() === PAINTED_BY[geometryType].toLowerCase();
}

function paintMismatchMessage(fields: CrossFields): string {
  const { subject, geometryType, fabricClass } = fields;
  // Unreachable: `paintsItsGeometry` passes every such annotation.
  if (geometryType === undefined || geometryType === 'mask') return '';
  return (
    `${subject} has ${geometryType} geometry, but its rawAnnotationData ` +
    `is a Fabric ${String(fabricClass)}, not a ${PAINTED_BY[geometryType]}`
  );
}

function draws(toolType: ToolType, geometryType: GeometryType): boolean {
  const drawn: readonly GeometryType[] = DRAWS[toolType];
  return drawn.includes(geometryType);
}

/**
 * Whether the `toolType` draws the geometry. A geometry that is no geometry
 * passes: the pairing check has refused it, and no tool draws it to compare.
 */
function drawsItsGeometry(fields: CrossFields): boolean {
  const { toolType, geometryType } = fields;
  return toolType === undefined || geometryType === undefined || draws(toolType, geometryType);
}

function toolMismatchMessage(fields: CrossFields): string {
  const { subject, geometryType, toolType } = fields;
  // Unreachable: `drawsItsGeometry` passes every such annotation.
  if (geometryType === undefined) return '';
  const tools = TOOL_TYPES.filter((t) => draws(t, geometryType));
  return (
    `${subject} has ${geometryType} geometry, but its toolType is "${String(toolType)}", ` +
    `not ${tools.map((t) => `"${t}"`).join(' or ')}`
  );
}

/** One cross-field check over a document entry's declared fields. */
function declaredCheck(
  passes: (fields: CrossFields) => boolean,
  message: (fields: CrossFields) => string,
) {
  return v.check(
    (entry: unknown) => {
      const fields = declaredCrossFields(entry);
      return fields === undefined || passes(fields);
    },
    (issue) => {
      const fields = declaredCrossFields(issue.input);
      return fields === undefined ? '' : message(fields);
    },
  );
}

/**
 * Schema for a whole {@link osdlabel!OsdAnnotation | OsdAnnotation}, as
 * `deserialize` validates each entry of a document: the base fields, the OSD
 * fields, that the two halves describe the same kind of shape, and that the
 * `toolType` is a tool that draws it.
 *
 * A mask geometry needs a mask payload (`osdlabel-mask`), and a vector
 * geometry a Fabric one. Either half passes on its own when they are mixed,
 * and the annotation would then fail only when rendered, one at a time; it is
 * a malformed document, and is refused here with an issue naming the
 * annotation, ahead of the checks below.
 *
 * A vector annotation stores its shape twice. `rawAnnotationData` is the saved
 * Fabric object, and it is what is painted. `geometry` is what is measured,
 * labelled and exported. Editing the shape on the canvas recomputes the
 * geometry from the Fabric object. So the payload must be the Fabric class
 * that paints the geometry's type: `Rect` for a rectangle, `Circle` for a
 * circle or a point, `Line`, `Polyline` and `Polygon` for the others. An
 * annotation whose payload is another class (rectangle geometry with a
 * `Circle` payload, say) is rejected with an issue naming the annotation and
 * both types. Accepted, it would measure a shape nobody sees, and an edit to
 * the shape that is seen would be dropped, or would change the geometry's
 * type.
 *
 * Only the kind is compared. Whether the payload sits where the geometry says
 * cannot be checked without Fabric, so it is not.
 *
 * The `toolType` must name a tool that draws the geometry's type: the tool of
 * the same name for a rectangle, circle, line or point, and `polyline` or
 * `freeHandPath` for a polyline or a polygon (either tool closes a path into
 * a polygon). Constraints count annotations by `toolType`, so a rectangle
 * recorded as drawn by the line tool would use up one of the context's lines
 * and free one of its rectangles. It is rejected with an issue naming the
 * annotation, its geometry type, its `toolType` and the tool types that draw
 * it; for a mask that is `segmentationBrush`. When both checks fail, the
 * payload's issue comes first.
 *
 * {@link OsdAnnotationCrossFieldSchema} runs these three checks on an entry as
 * written, before its shape is validated or its mask decoded.
 */
export const OsdAnnotationSchema = v.pipe(
  v.intersect([BaseAnnotationSchema, OsdFieldsSchema]),
  v.check(
    (annotation) => pairsItsPayload(crossFieldsOf(annotation)),
    (issue) => pairMismatchMessage(crossFieldsOf(issue.input)),
  ),
  v.check(
    (annotation) => paintsItsGeometry(crossFieldsOf(annotation)),
    (issue) => paintMismatchMessage(crossFieldsOf(issue.input)),
  ),
  v.check(
    (annotation) => drawsItsGeometry(crossFieldsOf(annotation)),
    (issue) => toolMismatchMessage(crossFieldsOf(issue.input)),
  ),
);

/**
 * The cross-field checks of {@link OsdAnnotationSchema}, run on a document
 * entry as it was written, before anything else about it is validated: that a
 * mask geometry has a mask payload and a vector geometry a Fabric one, that a
 * Fabric payload is the class that paints its geometry, and that the
 * `toolType` is a tool that draws the geometry. Each issue is worded as
 * `OsdAnnotationSchema` words it, but for the one only this schema raises (a
 * mask payload's geometry that is no geometry, below), and its output is its
 * input, unchanged.
 *
 * `deserialize` runs it over a whole document before it decodes any mask, and
 * `OsdAnnotationSchema` once the masks are decoded. Decoding rewrites a mask
 * entry's geometry from its pixels, so without this what the entry declared
 * would never be checked: rectangle geometry over a mask payload would load
 * as a mask, and so would `{ type: 'Rectangle' }` recorded under the brush. It
 * also means a document refused for a `toolType` that does not draw the
 * declared geometry is refused before any of its masks costs a decode.
 *
 * It differs from those checks in these ways:
 *
 * - Every payload whose `format` is not `'fabric'` counts as a mask payload,
 *   since a mask exported through a codec (`'coco-rle'`, say) is converted to
 *   the canonical `osdlabel-mask` only after this runs. Under a vector
 *   geometry the pairing issue quotes the `format` as written against the
 *   `'fabric'` it needs, since it may as well be a misspelling.
 * - Under a mask payload the geometry must be a mask geometry, or be omitted,
 *   since decoding gives the entry one. Omitted, it counts as mask geometry,
 *   so the `toolType` must still be a tool that draws a mask. Present but no
 *   geometry at all (`null`, an array, a string, an object with no `type` or
 *   with one that is no geometry type), it is refused with an issue naming
 *   the payload's `format` as written and what the geometry is, quoting
 *   nothing of it but a string `type`, cut short. Only its `type` is read:
 *   its other fields, which decoding replaces, are not compared.
 * - Otherwise it checks only the fields it can read. An entry whose payload
 *   is not a mask's passes when its `geometry` is missing or its `type` is
 *   no geometry type, and so does each check whose own fields are missing or
 *   of the wrong type: the `toolType` check when the `toolType` is not a tool
 *   type, the pairing and class checks when there is no string `format`, and
 *   the class check when a Fabric payload's `data.type` is not a string.
 *   Those are faults in the entry's shape, which `OsdAnnotationSchema`
 *   reports.
 * - An entry whose `id` is not a string is checked all the same, and its
 *   issue names it as an annotation with no string id.
 *
 * Every entry it refuses, `OsdAnnotationSchema` would refuse as written too,
 * for the same mismatch or for a fault in its shape, so it never refuses an
 * entry `OsdAnnotationSchema` accepts as written. Under a mask payload it
 * refuses every geometry `OsdAnnotationSchema` would refuse as written but
 * one whose `type` is `'mask'`, the rest of which decoding replaces, and it
 * accepts an omitted one, which decoding supplies. It is no substitute for
 * `OsdAnnotationSchema`.
 */
export const OsdAnnotationCrossFieldSchema = v.pipe(
  v.unknown(),
  declaredCheck(pairsItsPayload, pairMismatchMessage),
  declaredCheck(paintsItsGeometry, paintMismatchMessage),
  declaredCheck(drawsItsGeometry, toolMismatchMessage),
);
