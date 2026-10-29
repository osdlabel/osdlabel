/**
 * Rectangles saved by releases up to 0.21.0, loaded through osdlabel:
 * `deserialize` leaves their geometry as saved, and `migrateLegacyRectangle`,
 * which a host opts into, moves it to where the saved Fabric data paints them.
 * The migration itself is pinned in fabric-annotations' tests.
 */
import { describe, expect, it } from 'vitest';
import { Rect } from 'fabric';
import { createImageId } from '@osdlabel/viewer-api';
import { createAnnotationContextId } from '@osdlabel/annotation-context';
import {
  createFabricObjectFromRawData,
  initFabricModule,
  migrateLegacyRectangle,
} from '@osdlabel/fabric-annotations';
import type { Geometry } from '@osdlabel/annotation';
import { createAnnotationFromGeometry } from '../../src/create-annotation.js';
import { deserialize } from '../../src/serialization-configured.js';
import {
  cornerDeviation,
  formatCorners,
  paintedCorners,
  rectangle,
  referenceCorners,
  type Corners,
} from './rectangle-reference.js';

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

describe('a rectangle saved by an earlier release', () => {
  it('loads as saved, and migrateLegacyRectangle corrects it when the host opts in', () => {
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
    // deserialize changes nothing: correcting it is the host's choice.
    expect(loaded.geometry).toEqual(geometry);

    const migrated = migrateLegacyRectangle(loaded);
    expect(migrated.geometry.type).toBe('rectangle');
    if (migrated.geometry.type !== 'rectangle') return;
    // Half its size up and to the left of the centre it is painted at.
    expect(migrated.geometry.origin.x).toBeCloseTo(132.3858 - 50, 6);
    expect(migrated.geometry.origin.y).toBeCloseTo(218.6125 - 25, 6);
    expect(migrated.geometry.width).toBe(100);
    expect(migrated.geometry.height).toBe(50);
    // The saved Fabric data, which paints it where the user saw it, is kept.
    expect(migrated.rawAnnotationData).toBe(loaded.rawAnnotationData);
  });

  it('a rectangle saved at 90° centred on (250, 125) loads as saved, and migrates to origin (200, 100)', async () => {
    // As releases up to 0.21.0 saved it: centred on (250, 125), its
    // geometry's origin read back from that same left/top.
    const saved = rectangle({ x: 250, y: 125 }, 100, 50, 90);
    const current = createAnnotationFromGeometry(saved, {
      imageId,
      contextId,
      toolType: 'rectangle',
    });
    const legacy = {
      ...current,
      rawAnnotationData: {
        ...current.rawAnnotationData,
        data: {
          ...current.rawAnnotationData.data,
          left: 250,
          top: 125,
          originX: 'center',
          originY: 'center',
        },
      },
    };
    const doc: unknown = JSON.parse(JSON.stringify([legacy]));

    const { byImage } = deserialize(doc);
    const loaded = byImage[imageId]![current.id]!;
    expect(loaded).toBeDefined();
    // deserialize changes nothing: correcting it is the host's choice.
    expect(loaded.geometry).toEqual(rectangle({ x: 250, y: 125 }, 100, 50, 90));

    const migrated = migrateLegacyRectangle(loaded);
    expect(migrated.geometry).toEqual(rectangle({ x: 200, y: 100 }, 100, 50, 90));
    expect(migrated.rawAnnotationData).toBe(loaded.rawAnnotationData);

    // Centre (250, 125) at 90°: x 225–275, y 75–175, where the saved data paints it.
    const corners: Corners = [
      { x: 275, y: 75 },
      { x: 275, y: 175 },
      { x: 225, y: 175 },
      { x: 225, y: 75 },
    ];
    if (migrated.geometry.type !== 'rectangle') throw new Error('expected a rectangle');
    expect(referenceCorners(migrated.geometry)).toEqual(corners);
    const object = await createFabricObjectFromRawData(migrated);
    expect(object).toBeInstanceOf(Rect);
    const painted = paintedCorners(object as Rect);
    expect(
      cornerDeviation(painted, corners),
      `painted ${formatCorners(painted)}`,
    ).toBeLessThanOrEqual(1e-9);
  });

  it('is told apart from a rectangle saved by the current release, which is left alone', () => {
    const current = createAnnotationFromGeometry(geometry, {
      imageId,
      contextId,
      toolType: 'rectangle',
    });
    const { byImage } = deserialize(JSON.parse(JSON.stringify([current])));
    const loaded = byImage[imageId]![current.id]!;
    expect(loaded.geometry).toEqual(geometry);
    expect(migrateLegacyRectangle(loaded)).toBe(loaded);
  });
});
