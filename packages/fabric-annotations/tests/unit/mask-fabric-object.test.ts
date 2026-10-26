import { describe, it, expect } from 'vitest';
import { FabricImage, Point, util } from 'fabric';
import { MASK_RAW_FORMAT, type MaskRawAnnotationData } from '@osdlabel/annotation';
import {
  BoundedDenseMaskBuffer,
  decodeCanonicalRaster,
  encodeCanonical,
  stampCircle,
  strokeSegment,
} from '@osdlabel/mask';
import { buildMaskFabricObject } from '../../src/mask-fabric-object.js';
import { initFabricModule } from '../../src/fabric-module.js';

initFabricModule();

function envelope(fill?: string): MaskRawAnnotationData {
  const buffer = new BoundedDenseMaskBuffer({ imageWidth: 400, imageHeight: 300 });
  stampCircle(buffer, 120.5, 90.5, 8, 1);
  const data = encodeCanonical(buffer.snapshot());
  return {
    format: MASK_RAW_FORMAT,
    data: { ...data, ...(fill !== undefined ? { fill } : {}) },
  };
}

describe('buildMaskFabricObject', () => {
  it('renders an image positioned at the mask bounding box in image space', () => {
    const raw = envelope();
    const object = buildMaskFabricObject(raw, { id: 'ann-1' });

    expect(object).toBeInstanceOf(FabricImage);
    expect(object?.left).toBe(raw.data.x);
    expect(object?.top).toBe(raw.data.y);
    expect(object?.width).toBe(raw.data.width);
    expect(object?.height).toBe(raw.data.height);
    // Unscaled, so one mask pixel is one image pixel.
    expect(object?.scaleX).toBe(1);
    expect(object?.scaleY).toBe(1);
  });

  it('carries the annotation id so the overlay treats it as an annotation', () => {
    expect(buildMaskFabricObject(envelope(), { id: 'ann-42' })?.id).toBe('ann-42');
  });

  it('locks transforms, because a mask is edited by painting rather than dragging', () => {
    const object = buildMaskFabricObject(envelope(), { id: 'ann-1' });
    expect(object?.lockMovementX).toBe(true);
    expect(object?.lockMovementY).toBe(true);
    expect(object?.lockScalingX).toBe(true);
    expect(object?.lockScalingY).toBe(true);
    expect(object?.lockRotation).toBe(true);
    expect(object?.hasControls).toBe(false);
    // Selectable in annotation mode, so the select tool can target it; the overlay's `paint` mode makes it inert while the brush is active.
    expect(object?.selectable).toBe(true);
  });

  it('hit-tests its pixels rather than its bounding box', () => {
    // A sparse mask is mostly transparent box; a click through it must reach
    // the shape beneath.
    const object = buildMaskFabricObject(envelope(), { id: 'ann-1' });
    expect(object?.perPixelTargetFind).toBe(true);
  });

  it('keeps mask edges crisp rather than smoothing them', () => {
    const object = buildMaskFabricObject(envelope(), { id: 'ann-1' });
    expect((object as FabricImage).imageSmoothing).toBe(false);
    expect(object?.objectCaching).toBe(false);
  });

  it('returns null for an empty mask', () => {
    const empty = new BoundedDenseMaskBuffer({ imageWidth: 40, imageHeight: 30 }).snapshot();
    const raw: MaskRawAnnotationData = {
      format: MASK_RAW_FORMAT,
      data: { ...encodeCanonical(empty) },
    };
    expect(buildMaskFabricObject(raw, { id: 'ann-1' })).toBeNull();
  });

  it('paints only the set pixels, using the envelope tint', () => {
    const buffer = new BoundedDenseMaskBuffer({ imageWidth: 20, imageHeight: 20 });
    buffer.set(5, 5, 1);
    buffer.set(6, 5, 1);
    const raw: MaskRawAnnotationData = {
      format: MASK_RAW_FORMAT,
      data: { ...encodeCanonical(buffer.snapshot()), fill: 'rgba(255, 0, 0, 1)' },
    };

    const object = buildMaskFabricObject(raw, { id: 'ann-1' }) as FabricImage;
    const source = object.getElement() as HTMLCanvasElement;
    const pixels = source.getContext('2d')!.getImageData(0, 0, source.width, source.height).data;

    // Two painted pixels, both fully opaque red.
    expect([pixels[0], pixels[1], pixels[2], pixels[3]]).toEqual([255, 0, 0, 255]);
    expect([pixels[4], pixels[5], pixels[6], pixels[7]]).toEqual([255, 0, 0, 255]);
  });
});

describe('raw data that is not a mask', () => {
  it('throws rather than returning null', () => {
    // `null` already means "empty mask, nothing to draw". Returning it here
    // too would render a Fabric envelope as silence instead of naming the
    // mistake — and the caller has no way to tell the two apart.
    expect(() =>
      buildMaskFabricObject({ format: 'fabric', data: {} } as never, { id: 'ann-1' as never }),
    ).toThrow(TypeError);
  });
});

describe('a downsampled mask', () => {
  /** An 8x mask on a 1001x601 image whose last cell column / row are clipped. */
  function downsampledEnvelope(): MaskRawAnnotationData {
    const buffer = new BoundedDenseMaskBuffer({
      imageWidth: 1001,
      imageHeight: 601,
      downsample: 8,
    });
    strokeSegment(buffer, 300, 200, 998, 598, 60, 1);
    return { format: MASK_RAW_FORMAT, data: { ...encodeCanonical(buffer.snapshot()) } };
  }

  it('renders one canvas pixel per cell, scaled to the image pixels it covers', () => {
    const raw = downsampledEnvelope();
    expect(raw.data.downsample).toBe(8);
    const object = buildMaskFabricObject(raw, { id: 'ann-1' }) as FabricImage;
    expect(object.left).toBe(raw.data.x);
    expect(object.top).toBe(raw.data.y);
    expect(object.scaleX).toBe(8);
    expect(object.scaleY).toBe(8);
    expect(object.width).toBe(Math.ceil(raw.data.width / 8));
    expect(object.height).toBe(Math.ceil(raw.data.height / 8));
    // Still crisp: a cell is a block, not a blur.
    expect(object.imageSmoothing).toBe(false);
  });

  it('puts every cell centre exactly where the payload says it is', () => {
    const raw = downsampledEnvelope();
    const object = buildMaskFabricObject(raw, { id: 'ann-1' }) as FabricImage;
    const matrix = object.calcTransformMatrix();
    const cellsWide = object.width;
    const cellsHigh = object.height;
    let worst = 0;
    for (let row = 0; row < cellsHigh; row++) {
      for (let col = 0; col < cellsWide; col++) {
        // Fabric's object space is centred on the object.
        const local = new Point(col + 0.5 - cellsWide / 2, row + 0.5 - cellsHigh / 2);
        const placed = util.transformPoint(local, matrix);
        const expectedX = raw.data.x + (col + 0.5) * 8;
        const expectedY = raw.data.y + (row + 0.5) * 8;
        worst = Math.max(worst, Math.abs(placed.x - expectedX), Math.abs(placed.y - expectedY));
      }
    }
    expect(worst).toBeLessThan(1e-9);
  });

  it('draws each cell where it lies, the clipped last column and row included', () => {
    const raw = downsampledEnvelope();
    const raster = decodeCanonicalRaster(raw.data);
    const object = buildMaskFabricObject(raw, { id: 'ann-1' }) as FabricImage;
    const source = object.getElement() as HTMLCanvasElement;
    const pixels = source.getContext('2d')!.getImageData(0, 0, source.width, source.height).data;
    const { cells } = raster;

    // The stroke reaches the image's last cell column (1000..1000) and row
    // (600..600), each clipped to one image pixel by the 1001x601 image.
    expect(cells.x + cells.width).toBe(Math.ceil(1001 / 8));
    expect(cells.y + cells.height).toBe(Math.ceil(601 / 8));
    const lastColumn = cells.x + cells.width - 1;
    const lastRow = cells.y + cells.height - 1;
    expect(raster.get(lastColumn, lastRow)).toBe(1);

    // Every cell: painted on the canvas exactly when the raster has it.
    let painted = 0;
    for (let cy = cells.y; cy < cells.y + cells.height; cy++) {
      for (let cx = cells.x; cx < cells.x + cells.width; cx++) {
        const alpha = pixels[((cy - cells.y) * cells.width + (cx - cells.x)) * 4 + 3]!;
        expect(alpha > 0).toBe(raster.get(cx, cy) === 1);
        if (alpha > 0) painted++;
      }
    }
    expect(painted).toBe(raster.cellCount);

    // Cells are drawn full-size, so the clipped edge overhangs the image by
    // under one cell, never more.
    const right = object.left + object.width * object.scaleX;
    const bottom = object.top + object.height * object.scaleY;
    expect(right).toBeGreaterThanOrEqual(1001);
    expect(right - 1001).toBeLessThan(8);
    expect(bottom).toBeGreaterThanOrEqual(601);
    expect(bottom - 601).toBeLessThan(8);
  });
});
