import { describe, expect, it } from 'vitest';
import { createImageId } from '@osdlabel/viewer-api';
import { createAnnotationContextId } from '@osdlabel/annotation-context';
import { initFabricModule } from '@osdlabel/fabric-annotations';
import { createAnnotationFromGeometry } from '../../src/create-annotation.js';
import { processConvertCircleToRectangle } from '../../src/tool-factory.js';

initFabricModule();

const imageId = createImageId('img-1');
const contextId = createAnnotationContextId('ctx-1');

describe('processConvertCircleToRectangle', () => {
  it('converts a circle to its axis-aligned bounding-box rectangle', () => {
    const circle = createAnnotationFromGeometry(
      { type: 'circle', center: { x: 10, y: 20 }, radius: 5 },
      { imageId, contextId, toolType: 'circle' },
    );

    const result = processConvertCircleToRectangle(circle);
    expect(result).not.toBeNull();
    expect(result!.toolType).toBe('rectangle');
    expect(result!.geometry).toEqual({
      type: 'rectangle',
      origin: { x: 5, y: 15 },
      width: 10,
      height: 10,
      rotation: 0,
    });
    expect(result!.rawAnnotationData.format).toBe('fabric');
    // The id round-trips into the new serialized envelope.
    expect((result!.rawAnnotationData.data as { id?: string }).id).toBe(circle.id);
  });

  it('returns null for a non-circle annotation', () => {
    const rect = createAnnotationFromGeometry(
      { type: 'rectangle', origin: { x: 0, y: 0 }, width: 4, height: 4, rotation: 0 },
      { imageId, contextId, toolType: 'rectangle' },
    );
    expect(processConvertCircleToRectangle(rect)).toBeNull();
  });

  it('preserves the original visual style', () => {
    const circle = createAnnotationFromGeometry(
      { type: 'circle', center: { x: 0, y: 0 }, radius: 3 },
      { imageId, contextId, toolType: 'circle' },
    );
    const origData = circle.rawAnnotationData.data as { stroke?: unknown; fill?: unknown };
    const result = processConvertCircleToRectangle(circle)!;
    const newData = result.rawAnnotationData.data as { stroke?: unknown; fill?: unknown };

    expect(newData.stroke).toEqual(origData.stroke);
    expect(newData.fill).toEqual(origData.fill);
  });
});
