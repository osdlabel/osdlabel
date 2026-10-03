import { describe, it, expect } from 'vitest';
import { Circle, Polygon } from 'fabric';
import { createAnnotationId } from '@osdlabel/annotation';
import {
  createFabricObjectFromRawData,
  deserializeFabricObject,
  serializeFabricObject,
} from '../../src/fabric-utils.js';
import type { FabricFields, FabricRawAnnotationData } from '../../src/types.js';
import type { Annotation } from '@osdlabel/annotation';
import type { ImageIdFields } from '@osdlabel/viewer-api';
import { createImageId } from '@osdlabel/viewer-api';
import { createAnnotationContextId } from '@osdlabel/annotation-context';
import type { ContextFields } from '@osdlabel/annotation-context';
import { initFabricModule } from '../../src/fabric-module.js';

// Register custom Fabric properties so toObject() includes `id`
initFabricModule();

type OsdAnnotation = Annotation<ImageIdFields & ContextFields & FabricFields>;

function makePointAnnotation(): OsdAnnotation {
  const id = createAnnotationId('test-point-1');
  const circle = new Circle({
    left: 100,
    top: 200,
    radius: 5,
    originX: 'center',
    originY: 'center',
  });
  // Attach the id so it round-trips through serialization
  (circle as unknown as { id: string }).id = id;

  return {
    id,
    imageId: createImageId('img-1'),
    contextId: createAnnotationContextId('ctx-1'),
    geometry: { type: 'point', position: { x: 100, y: 200 } },
    rawAnnotationData: serializeFabricObject(circle),
    toolType: 'point',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

function makeCircleAnnotation(): OsdAnnotation {
  const id = createAnnotationId('test-circle-1');
  const circle = new Circle({
    left: 50,
    top: 50,
    radius: 30,
    originX: 'center',
    originY: 'center',
  });
  (circle as unknown as { id: string }).id = id;

  return {
    id,
    imageId: createImageId('img-1'),
    contextId: createAnnotationContextId('ctx-1'),
    geometry: { type: 'circle', center: { x: 50, y: 50 }, radius: 30 },
    rawAnnotationData: serializeFabricObject(circle),
    toolType: 'circle',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

describe('createFabricObjectFromRawData', () => {
  it('should set hasControls to false for point annotations', async () => {
    const annotation = makePointAnnotation();
    const obj = await createFabricObjectFromRawData(annotation);
    expect(obj).not.toBeNull();
    expect(obj!.hasControls).toBe(false);
  });

  it('should keep hasControls true for non-point annotations (e.g. circle)', async () => {
    const annotation = makeCircleAnnotation();
    const obj = await createFabricObjectFromRawData(annotation);
    expect(obj).not.toBeNull();
    // Circle annotations should still have controls (resizable)
    expect(obj!.hasControls).toBe(true);
  });

  it('should make point annotation selectable and evented', async () => {
    const annotation = makePointAnnotation();
    const obj = await createFabricObjectFromRawData(annotation);
    expect(obj!.selectable).toBe(true);
    expect(obj!.evented).toBe(true);
  });
});

describe('deserializeFabricObject', () => {
  const polygonData = (): FabricRawAnnotationData =>
    serializeFabricObject(
      new Polygon([
        { x: 0, y: 0 },
        { x: 10, y: 0 },
        { x: 5, y: 10 },
      ]),
    );

  it('revives a valid payload', async () => {
    const obj = await deserializeFabricObject(polygonData());
    expect(obj).toBeInstanceOf(Polygon);
  });

  it('rejects a payload whose class fails on malformed data (#209)', async () => {
    // Fabric's enlivenObjects swallowed this by default and resolved with no
    // object, so the annotation vanished with nothing reported.
    const valid = polygonData();
    const malformed: FabricRawAnnotationData = {
      ...valid,
      data: { ...valid.data, points: null },
    };
    await expect(deserializeFabricObject(malformed)).rejects.toThrow();
  });

  it('rejects a payload naming a class that is not registered', async () => {
    const valid = polygonData();
    const unknown: FabricRawAnnotationData = {
      ...valid,
      data: { ...valid.data, type: 'NotAFabricClass' },
    };
    await expect(deserializeFabricObject(unknown)).rejects.toThrow(/NotAFabricClass/);
  });

  it('resolves to null for an envelope that is not Fabric’s', async () => {
    const other = {
      format: 'other',
      fabricVersion: '7',
      data: {},
    } as unknown as FabricRawAnnotationData;
    await expect(deserializeFabricObject(other)).resolves.toBeNull();
  });
});
