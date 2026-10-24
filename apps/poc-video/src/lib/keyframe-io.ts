/**
 * The two storage formats for tracks the PoC compares.
 *
 * A. Keyframes as ordinary annotations: each keyframe is an `OsdAnnotation`
 *    plus {@link KeyframeFields} (`trackId`, `frame: { index, timeUs }`,
 *    `visibility`), written by osdlabel's own `serialize` and read by its own
 *    `deserialize`. That path strips unknown keys (Valibot `v.object`), so
 *    the keyframe fields are validated and re-attached here in one extra
 *    pass. A productised version would put {@link KeyframeFieldsSchema} in
 *    `@osdlabel/validation` and let `deserialize` take it as an option.
 *
 * B. TrackDocument: tracks as their own entities (the PoC's first format),
 *    here completed with the fields a real document needs (image, context,
 *    label, FrameRef times, mask pixels) and a Valibot schema, which the
 *    first version lacked.
 */
import type { Annotation, AnnotationId, Geometry } from '@osdlabel/annotation';
import type { ImageId } from '@osdlabel/viewer-api';
import { deserialize } from 'osdlabel';
import type { DeserializeResult, OsdAnnotation, OsdFields } from 'osdlabel';
import { GeometrySchema, MaskRawAnnotationDataSchema } from '@osdlabel/validation';
import type { FrameRef, KeyframeFields, Visibility } from '@osdlabel/temporal';
import * as v from 'valibot';

export const FrameRefSchema = v.object({
  index: v.pipe(v.number(), v.integer(), v.minValue(0)),
  timeUs: v.optional(v.pipe(v.number(), v.integer())),
});

const VisibilitySchema = v.picklist(['visible', 'occluded', 'outside']);

export const KeyframeFieldsSchema = v.object({
  trackId: v.pipe(v.string(), v.minLength(1)),
  frame: FrameRefSchema,
  visibility: VisibilitySchema,
});

const KeyframeFieldsWithIdSchema = v.looseObject({
  id: v.pipe(v.string(), v.minLength(1)),
  imageId: v.pipe(v.string(), v.minLength(1)),
  ...KeyframeFieldsSchema.entries,
});

export type KeyframeAnnotation = OsdAnnotation & KeyframeFields;

/**
 * osdlabel's `deserialize` (validation, mask normalisation) plus the keyframe
 * fields, which it drops: validated in a second pass over the raw document
 * and re-attached by (imageId, id).
 */
export function deserializeKeyframeAnnotations(doc: unknown): {
  readonly annotations: KeyframeAnnotation[];
  readonly skipped: DeserializeResult<OsdFields>['skipped'];
  readonly base: DeserializeResult<OsdFields>;
} {
  const base = deserialize(doc);
  const fields = v.parse(v.array(KeyframeFieldsWithIdSchema), doc);
  const byKey = new Map<string, (typeof fields)[number]>();
  for (const f of fields) byKey.set(`${f.imageId}\u0000${f.id}`, f);
  const annotations: KeyframeAnnotation[] = [];
  for (const [imageId, anns] of Object.entries(base.byImage)) {
    for (const a of Object.values(anns) as OsdAnnotation[]) {
      const f = byKey.get(`${imageId}\u0000${a.id}`);
      if (f === undefined) continue;
      const frame: FrameRef =
        f.frame.timeUs === undefined
          ? { index: f.frame.index }
          : { index: f.frame.index, timeUs: f.frame.timeUs };
      annotations.push({
        ...a,
        trackId: f.trackId as KeyframeFields['trackId'],
        frame,
        visibility: f.visibility,
      });
    }
  }
  return { annotations, skipped: base.skipped, base };
}

/** B: a TrackDocument keyframe; `mask` carries the canonical mask envelope. */
export interface StoredKeyframe {
  readonly frame: FrameRef;
  readonly geometry: Geometry;
  readonly visibility: Visibility;
  readonly mask?: v.InferOutput<typeof MaskRawAnnotationDataSchema>;
}

export interface StoredTrack {
  readonly id: string;
  readonly imageId: ImageId;
  readonly contextId: string;
  readonly label?: string;
  readonly geometryType: Geometry['type'];
  readonly keyframes: readonly StoredKeyframe[];
}

export interface TrackDocumentV2 {
  readonly format: 'osdlabel-tracks';
  readonly version: 2;
  readonly tracks: readonly StoredTrack[];
}

export const TrackDocumentSchema = v.object({
  format: v.literal('osdlabel-tracks'),
  version: v.literal(2),
  tracks: v.array(
    v.pipe(
      v.object({
        id: v.pipe(v.string(), v.minLength(1)),
        imageId: v.pipe(v.string(), v.minLength(1)),
        contextId: v.pipe(v.string(), v.minLength(1)),
        label: v.optional(v.string()),
        geometryType: v.picklist([
          'rectangle',
          'circle',
          'line',
          'point',
          'polyline',
          'polygon',
          'mask',
        ]),
        keyframes: v.array(
          v.object({
            frame: FrameRefSchema,
            geometry: GeometrySchema,
            visibility: VisibilitySchema,
            mask: v.optional(MaskRawAnnotationDataSchema),
          }),
        ),
      }),
      v.check(
        (t) => t.keyframes.every((k) => k.geometry.type === t.geometryType),
        'every keyframe geometry must match the track type',
      ),
    ),
  ),
});

export function parseTrackDocument(doc: unknown): TrackDocumentV2 {
  return v.parse(TrackDocumentSchema, doc) as unknown as TrackDocumentV2;
}

/** Ids for keyframe annotations: one per (track, keyframe). */
export const keyframeAnnotationId = (trackId: string, k: number): AnnotationId =>
  `${trackId}~k${k}` as AnnotationId;

export type { Annotation };
