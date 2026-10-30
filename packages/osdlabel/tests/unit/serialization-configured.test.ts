/**
 * `deserialize` rejects an annotation whose saved Fabric payload is not the
 * kind of object its geometry describes: the payload is what is painted, the
 * geometry what is measured and exported, so accepting one would measure a
 * shape nobody sees. Every document a release has written still loads.
 */
import { describe, expect, it } from 'vitest';
import { Polygon, Polyline } from 'fabric';
import { createImageId, type AnnotationState, type ImageId } from '@osdlabel/viewer-api';
import { createAnnotationContextId } from '@osdlabel/annotation-context';
import { getFabricOptions, initFabricModule } from '@osdlabel/fabric-annotations';
import {
  DEFAULT_ANNOTATION_STYLE,
  createAnnotationId,
  type AnnotationId,
  type ToolType,
  type VectorGeometry,
} from '@osdlabel/annotation';
import { createAnnotationFromGeometry } from '../../src/create-annotation.js';
import { deserialize, serialize, SerializationError } from '../../src/serialization-configured.js';
import {
  processConvertCircleToRectangle,
  processToolAddAnnotation,
} from '../../src/tool-factory.js';
import type { OsdAnnotation, OsdFields } from '../../src/types.js';
import { DOCUMENT_0_21_0_JSON } from './document-0.21.0.js';

initFabricModule();

const imageId = createImageId('img-1');
const contextId = createAnnotationContextId('ctx-1');

const triangle = [
  { x: 10, y: 20 },
  { x: 110, y: 70 },
  { x: 60, y: 90 },
];

/** One annotation of each geometry type, as this release builds them. */
function annotationsOfEveryType(): OsdAnnotation[] {
  const make = (name: string, geometry: VectorGeometry, toolType: ToolType): OsdAnnotation =>
    createAnnotationFromGeometry(geometry, {
      imageId,
      contextId,
      toolType,
      id: createAnnotationId(name),
    });
  return [
    make(
      'rectangle',
      { type: 'rectangle', origin: { x: 10, y: 20 }, width: 100, height: 50, rotation: 30 },
      'rectangle',
    ),
    make('circle', { type: 'circle', center: { x: 60, y: 45 }, radius: 25 }, 'circle'),
    make('point', { type: 'point', position: { x: 60, y: 45 } }, 'point'),
    make('line', { type: 'line', start: { x: 10, y: 20 }, end: { x: 110, y: 70 } }, 'line'),
    make('polyline', { type: 'polyline', points: triangle }, 'polyline'),
    make('polygon', { type: 'polygon', points: triangle }, 'freeHandPath'),
  ];
}

/** What the drawing tools commit where the tool and geometry types differ. */
function annotationsFromTools(): OsdAnnotation[] {
  const commit = (obj: Polyline, type: ToolType): OsdAnnotation => {
    const fields = processToolAddAnnotation({ fabricObject: obj, imageId, contextId, type });
    expect(fields).not.toBeNull();
    const now = new Date().toISOString();
    return { ...fields!, createdAt: now, updatedAt: now };
  };
  const options = (id: string) => getFabricOptions(DEFAULT_ANNOTATION_STYLE, id);
  // The polyline tool, path closed on its first vertex: a Polygon.
  const closed = commit(new Polygon(triangle, options('closed-polyline')), 'polyline');
  // The freehand tool with Shift held: an open Polyline.
  const open = commit(
    new Polyline(triangle, { ...options('open-freehand'), fill: 'transparent' }),
    'freeHandPath',
  );
  return [closed, open];
}

/** A circle converted to its bounding rectangle, as the toolbar's Convert does. */
function convertedCircle(): OsdAnnotation {
  const circle = createAnnotationFromGeometry(
    { type: 'circle', center: { x: 60, y: 45 }, radius: 25 },
    { imageId, contextId, toolType: 'circle', id: createAnnotationId('converted') },
  );
  const patch = processConvertCircleToRectangle(circle);
  expect(patch).not.toBeNull();
  return { ...circle, ...patch! };
}

/** `annotations` exported and read back, as a host saves and loads them. */
function roundTrip(annotations: readonly OsdAnnotation[]): OsdAnnotation[] {
  const stored: Record<ImageId, Record<AnnotationId, OsdAnnotation>> = {};
  for (const a of annotations) stored[a.imageId] = { ...stored[a.imageId], [a.id]: a };
  const state: AnnotationState<OsdFields> = { byImage: stored, changeCounter: 0 };
  const { byImage } = deserialize(JSON.parse(JSON.stringify(serialize(state))));
  return Object.values(byImage).flatMap((forImage) => Object.values(forImage));
}

/** The Fabric class `annotation`'s saved payload names. */
function payloadType(annotation: OsdAnnotation): string {
  const type = annotation.rawAnnotationData.data['type'];
  if (typeof type !== 'string') throw new Error(`payload type ${String(type)}`);
  return type;
}

/** `target` with `source`'s Fabric payload, its id kept: a hand-edited document. */
function withPayloadOf(target: OsdAnnotation, source: OsdAnnotation): OsdAnnotation {
  const raw = source.rawAnnotationData;
  if (raw.format !== 'fabric') throw new Error(`${source.id} has no Fabric payload`);
  return { ...target, rawAnnotationData: { ...raw, data: { ...raw.data, id: target.id } } };
}

function rejection(doc: unknown): SerializationError {
  try {
    deserialize(doc);
  } catch (err) {
    expect(err).toBeInstanceOf(SerializationError);
    return err as SerializationError;
  }
  throw new Error('deserialize accepted the document');
}

describe('deserialize: payload and geometry must agree in kind', () => {
  it('loads a document exported by 0.21.0, every annotation as saved', () => {
    const saved: unknown = JSON.parse(DOCUMENT_0_21_0_JSON);
    expect(saved).toBeInstanceOf(Array);
    const savedAnnotations = saved as { id: string; imageId: string }[];
    expect(savedAnnotations).toHaveLength(9);

    const { byImage } = deserialize(saved);

    const loaded = Object.values(byImage).flatMap((forImage) => Object.values(forImage));
    expect(loaded).toHaveLength(savedAnnotations.length);
    for (const annotation of savedAnnotations) {
      const forImage = byImage[createImageId(annotation.imageId)];
      expect(forImage, `image ${annotation.imageId}`).toBeDefined();
      expect(forImage![createAnnotationId(annotation.id)]).toEqual(annotation);
    }
  });

  it('loads one annotation of every geometry type this release saves', () => {
    const annotations = annotationsOfEveryType();
    expect(roundTrip(annotations)).toEqual(annotations);
  });

  it('loads what the drawing tools save where tool and geometry types differ', () => {
    const annotations = annotationsFromTools();
    expect(annotations.map((a) => [a.toolType, a.geometry.type])).toEqual([
      ['polyline', 'polygon'],
      ['freeHandPath', 'polyline'],
    ]);
    expect(roundTrip(annotations)).toEqual(annotations);
  });

  it('loads a circle converted to a rectangle', () => {
    const converted = convertedCircle();
    expect(converted.geometry.type).toBe('rectangle');
    expect(roundTrip([converted])).toEqual([converted]);
  });

  // Every annotation given the payload of each other shape whose Fabric class
  // differs: 5 each, but 4 for the circle and the point, which are both
  // painted by a Circle.
  const everyType = annotationsOfEveryType();
  const mismatches = everyType.flatMap((target) =>
    everyType
      .filter((source) => payloadType(source) !== payloadType(target))
      .map((source) => [target.geometry.type, source.geometry.type, target, source] as const),
  );

  it('there is a mismatch to try for every geometry type', () => {
    expect(new Set(mismatches.map(([geometryType]) => geometryType)).size).toBe(6);
    expect(mismatches).toHaveLength(28);
  });

  it.each(mismatches)(
    'rejects %s geometry with the payload of a %s, naming the annotation and both types',
    (geometryType, _sourceType, target, source) => {
      const err = rejection(JSON.parse(JSON.stringify([withPayloadOf(target, source)])));
      expect(err.message).toContain(`Annotation "${target.id}"`);
      expect(err.message).toContain(`has ${geometryType} geometry`);
      expect(err.message).toContain(`is a Fabric ${payloadType(source)},`);
      expect(err.message).toContain(`not a ${payloadType(target)}`);
    },
  );

  it('reports the mismatch through SerializationError', () => {
    const [rectangle, circle] = annotationsOfEveryType();
    const err = rejection(JSON.parse(JSON.stringify([withPayloadOf(rectangle!, circle!)])));
    expect(err.name).toBe('SerializationError');
    expect(err.message).toBe(
      'Validation failed: Annotation "rectangle" has rectangle geometry, but its rawAnnotationData is a Fabric Circle, not a Rect',
    );
  });

  it('rejects the whole document, so none of it is loaded', () => {
    const annotations = annotationsOfEveryType();
    const doc = [...annotations, withPayloadOf(annotations[0]!, annotations[1]!)];
    // The last entry replaces the first's id: on its own the rest would load.
    expect(() => deserialize(JSON.parse(JSON.stringify(doc.slice(0, -1))))).not.toThrow();
    const err = rejection(JSON.parse(JSON.stringify(doc)));
    expect(err.message).toContain('Annotation "rectangle"');
  });
});
