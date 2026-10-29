import { describe, expect, it } from 'vitest';
import { createImageId } from '@osdlabel/viewer-api';
import { createAnnotationContextId } from '@osdlabel/annotation-context';
import { initFabricModule } from '@osdlabel/fabric-annotations';
import type { Geometry } from '@osdlabel/annotation';
import { createAnnotationFromGeometry } from '../../src/create-annotation.js';
import { deserialize } from '../../src/serialization-configured.js';

initFabricModule();

const imageId = createImageId('img-1');
const contextId = createAnnotationContextId('ctx-1');

const geometry: Geometry = {
  type: 'rectangle',
  origin: { x: 10, y: 20 },
  width: 100,
  height: 50,
  rotation: 0,
};

describe('deserialize', () => {
  it('corrects the geometry of a rectangle saved by an earlier release', () => {
    const current = createAnnotationFromGeometry(geometry, {
      imageId,
      contextId,
      toolType: 'rectangle',
    });
    // As earlier releases saved it: left/top at the geometry's corner under a
    // centre origin, so it was painted centred on that corner.
    const legacy = {
      ...current,
      rawAnnotationData: {
        ...current.rawAnnotationData,
        data: { ...current.rawAnnotationData.data, left: 10, top: 20, originX: 'center' },
      },
    };

    const { byImage } = deserialize(JSON.parse(JSON.stringify([legacy])));
    const loaded = byImage[imageId]![current.id]!;
    expect(loaded).toBeDefined();
    expect(loaded.geometry).toEqual({ ...geometry, origin: { x: -40, y: -5 } });
    // The saved Fabric data, which paints it where the user saw it, is kept.
    expect(loaded.rawAnnotationData).toEqual(legacy.rawAnnotationData);
  });

  it('leaves a rectangle saved by the current release as it was', () => {
    const current = createAnnotationFromGeometry(geometry, {
      imageId,
      contextId,
      toolType: 'rectangle',
    });
    const { byImage } = deserialize(JSON.parse(JSON.stringify([current])));
    expect(byImage[imageId]![current.id]!.geometry).toEqual(geometry);
  });
});
