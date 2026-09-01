import { describe, it, expect } from 'vitest';
import { FabricImage, Rect, Polygon } from 'fabric';
import {
  DEFAULT_ANNOTATION_STYLE,
  MASK_RAW_FORMAT,
  createAnnotationId,
  type Annotation,
  type Geometry,
} from '@osdlabel/annotation';
import { BoundedDenseMaskBuffer, encodeCanonical, stampCircle } from '@osdlabel/mask';
import { buildFabricObjectFromGeometry } from '../../src/build-fabric-object.js';
import {
  createFabricObjectFromRawData,
  getFabricOptions,
  serializeFabricObject,
} from '../../src/fabric-utils.js';
import { initFabricModule } from '../../src/fabric-module.js';
import type { FabricFields } from '../../src/types.js';

initFabricModule();

const BASE = {
  toolType: 'rectangle',
  createdAt: '2024-01-01T00:00:00.000Z',
  updatedAt: '2024-01-01T00:00:00.000Z',
} as const;

/** A vector annotation, built the way the drawing tools build them. */
function vectorAnnotation(geometry: Geometry): Annotation<FabricFields> {
  const id = createAnnotationId('vec-1');
  const object = buildFabricObjectFromGeometry(
    geometry,
    getFabricOptions(DEFAULT_ANNOTATION_STYLE, id),
  );
  return { ...BASE, id, geometry, rawAnnotationData: serializeFabricObject(object) };
}

/** A mask annotation, whose payload is pixels rather than a Fabric object. */
function maskAnnotation(): Annotation<FabricFields> {
  const buffer = new BoundedDenseMaskBuffer({ imageWidth: 200, imageHeight: 200 });
  stampCircle(buffer, 60.5, 70.5, 6, 1);
  const snapshot = buffer.snapshot();
  return {
    ...BASE,
    id: createAnnotationId('mask-1'),
    toolType: 'segmentationBrush',
    geometry: {
      type: 'mask',
      origin: { x: snapshot.x, y: snapshot.y },
      width: snapshot.width,
      height: snapshot.height,
      pixelCount: snapshot.data.reduce((a, v) => a + v, 0),
    },
    rawAnnotationData: { format: MASK_RAW_FORMAT, data: encodeCanonical(snapshot) },
  };
}

describe('createFabricObjectFromRawData dispatch', () => {
  it('rebuilds a rectangle annotation through Fabric deserialization', async () => {
    const annotation = vectorAnnotation({
      type: 'rectangle',
      origin: { x: 10, y: 20 },
      width: 40,
      height: 30,
      rotation: 0,
    });

    const object = await createFabricObjectFromRawData(annotation);
    expect(object).toBeInstanceOf(Rect);
    expect(object).not.toBeInstanceOf(FabricImage);
    expect(object?.left).toBeCloseTo(10);
    expect(object?.top).toBeCloseTo(20);
    expect(object?.selectable).toBe(true);
  });

  it('rebuilds a polygon annotation through Fabric deserialization', async () => {
    const annotation = vectorAnnotation({
      type: 'polygon',
      points: [
        { x: 0, y: 0 },
        { x: 10, y: 0 },
        { x: 10, y: 10 },
      ],
    });

    const object = await createFabricObjectFromRawData(annotation);
    expect(object).toBeInstanceOf(Polygon);
  });

  it('rebuilds a mask annotation through the raster path', async () => {
    const annotation = maskAnnotation();
    const object = await createFabricObjectFromRawData(annotation);

    expect(object).toBeInstanceOf(FabricImage);
    if (annotation.geometry.type !== 'mask') throw new Error('expected mask geometry');
    expect(object?.left).toBe(annotation.geometry.origin.x);
    expect(object?.top).toBe(annotation.geometry.origin.y);
  });

  it('carries the annotation id on both paths, so the overlay recognises either', async () => {
    const vector = await createFabricObjectFromRawData(
      vectorAnnotation({ type: 'point', position: { x: 5, y: 5 } }),
    );
    const mask = await createFabricObjectFromRawData(maskAnnotation());

    expect(vector?.id).toBe('vec-1');
    expect(mask?.id).toBe('mask-1');
  });
});
