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

// A corner drawn with the mouse: image coordinates carry many decimals.
const corner = { x: 132.38578680202863, y: 218.61252115058915 };
const geometry: Geometry = {
  type: 'rectangle',
  origin: corner,
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
    // centre origin, so it was painted centred on that corner, and rounded to
    // 4 decimals by toObject() while the geometry kept every digit.
    const legacy = {
      ...current,
      rawAnnotationData: {
        ...current.rawAnnotationData,
        data: {
          ...current.rawAnnotationData.data,
          left: 132.3858,
          top: 218.6125,
          originX: 'center',
          originY: 'center',
        },
      },
    };

    const { byImage } = deserialize(JSON.parse(JSON.stringify([legacy])));
    const loaded = byImage[imageId]![current.id]!;
    expect(loaded).toBeDefined();
    expect(loaded.geometry.type).toBe('rectangle');
    if (loaded.geometry.type !== 'rectangle') return;
    // Half its size up and to the left of the centre it is painted at.
    expect(loaded.geometry.origin.x).toBeCloseTo(132.3858 - 50, 6);
    expect(loaded.geometry.origin.y).toBeCloseTo(218.6125 - 25, 6);
    expect(loaded.geometry.width).toBe(100);
    expect(loaded.geometry.height).toBe(50);
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
