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

/** The part of a structurally valid annotation the cross-field checks read. */
interface PaintedAnnotation {
  readonly id: string;
  readonly toolType: ToolType;
  readonly geometry: { readonly type: GeometryType };
  readonly rawAnnotationData:
    | { readonly format: 'fabric'; readonly data: { readonly type: string } }
    | { readonly format: typeof MASK_RAW_FORMAT };
}

/** Whether the payload is the kind its geometry needs: pixels for a mask, Fabric otherwise. */
function pairsItsPayload(annotation: PaintedAnnotation): boolean {
  return (
    (annotation.geometry.type === 'mask') ===
    (annotation.rawAnnotationData.format === MASK_RAW_FORMAT)
  );
}

function pairMismatchMessage(annotation: PaintedAnnotation): string {
  const { id, geometry, rawAnnotationData } = annotation;
  return geometry.type === 'mask'
    ? `Annotation "${id}" has mask geometry, but its rawAnnotationData is a ` +
        `"${rawAnnotationData.format}" payload, not "${MASK_RAW_FORMAT}"`
    : `Annotation "${id}" has ${geometry.type} geometry, but its rawAnnotationData is a ` +
        `"${MASK_RAW_FORMAT}" payload, not a Fabric object`;
}

/**
 * Whether a Fabric payload is the class that paints its vector geometry. A
 * mask, or a payload of the wrong kind, passes here: `pairsItsPayload` owns
 * that case, and a mask payload has no class to compare.
 */
function paintsItsGeometry(annotation: PaintedAnnotation): boolean {
  const { geometry, rawAnnotationData: raw } = annotation;
  if (geometry.type === 'mask' || raw.format !== 'fabric') return true;
  return raw.data.type.toLowerCase() === PAINTED_BY[geometry.type].toLowerCase();
}

function paintMismatchMessage(annotation: PaintedAnnotation): string {
  const { id, geometry, rawAnnotationData: raw } = annotation;
  // Unreachable: `paintsItsGeometry` passes every such annotation.
  if (geometry.type === 'mask' || raw.format !== 'fabric') return '';
  return (
    `Annotation "${id}" has ${geometry.type} geometry, but its rawAnnotationData ` +
    `is a Fabric ${raw.data.type}, not a ${PAINTED_BY[geometry.type]}`
  );
}

function draws(toolType: ToolType, geometryType: GeometryType): boolean {
  const drawn: readonly GeometryType[] = DRAWS[toolType];
  return drawn.includes(geometryType);
}

function drawsItsGeometry(annotation: PaintedAnnotation): boolean {
  return draws(annotation.toolType, annotation.geometry.type);
}

function toolMismatchMessage(annotation: PaintedAnnotation): string {
  const { id, geometry, toolType } = annotation;
  const tools = TOOL_TYPES.filter((t) => draws(t, geometry.type));
  return (
    `Annotation "${id}" has ${geometry.type} geometry, but its toolType is "${toolType}", ` +
    `not ${tools.map((t) => `"${t}"`).join(' or ')}`
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
 */
export const OsdAnnotationSchema = v.pipe(
  v.intersect([BaseAnnotationSchema, OsdFieldsSchema]),
  v.check(
    (annotation) => pairsItsPayload(annotation),
    (issue) => pairMismatchMessage(issue.input),
  ),
  v.check(
    (annotation) => paintsItsGeometry(annotation),
    (issue) => paintMismatchMessage(issue.input),
  ),
  v.check(
    (annotation) => drawsItsGeometry(annotation),
    (issue) => toolMismatchMessage(issue.input),
  ),
);
