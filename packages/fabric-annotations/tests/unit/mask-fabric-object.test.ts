import { describe, it, expect } from 'vitest';
import { FabricImage, Point, util } from 'fabric';
import { MASK_RAW_FORMAT, type MaskRawAnnotationData } from '@osdlabel/annotation';
import {
  BoundedDenseMaskBuffer,
  decodeCanonicalRaster,
  encodeCanonical,
  runRaster,
  stampCircle,
  strokeSegment,
} from '@osdlabel/mask';
import { buildMaskFabricObject } from '../../src/mask-fabric-object.js';
import {
  MAX_MASK_CANVAS_PIXELS,
  MAX_MASK_CANVAS_SIDE,
  MaskCanvasTooLargeError,
} from '../../src/mask-canvas-limit.js';
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

describe('a mask too long for a canvas', () => {
  /** A solid mask of `width` x `height` cells, built from runs. */
  const solid = (width: number, height: number): MaskRawAnnotationData => ({
    format: MASK_RAW_FORMAT,
    data: {
      ...encodeCanonical(
        runRaster(
          {
            cells: { x: 0, y: 0, width, height },
            imageWidth: 100_000,
            imageHeight: 100_000,
            downsample: 1,
          },
          [0, width * height],
        ),
      ),
    },
  });

  // Halves three masks of 63-64 M cells, twice for two of them: a few seconds
  // of real work, past the default timeout under a parallel run.
  it(
    'draws from a display mip rather than refusing, inside the cell cap',
    { timeout: 30_000 },
    () => {
      // 63 M and 64 M cells: both under the 64 Mi cap, both past Firefox's
      // 32,767-pixel canvas side and the 16 Mi display budget.
      for (const [width, height, scale] of [
        [70_000, 900, 4],
        [40_000, 1_600, 2],
        [900, 70_000, 4],
      ] as const) {
        const object = buildMaskFabricObject(solid(width, height), { id: 'ann-1' }) as FabricImage;
        expect(object.scaleX, `${width}x${height}`).toBe(scale);
        expect(object.scaleY).toBe(scale);
        // The mip covers the same image region: the box is cell-aligned at 0.
        expect(object.width).toBe(Math.ceil(width / scale));
        expect(object.height).toBe(Math.ceil(height / scale));
        expect(object.width).toBeLessThanOrEqual(MAX_MASK_CANVAS_SIDE);
        expect(object.width * object.height).toBeLessThanOrEqual(MAX_MASK_CANVAS_PIXELS);
      }
    },
  );

  it('refuses by name only when no mip up to the largest downsample fits', () => {
    // A box straddling the 2^16 cell boundary in both axes is 2x2 cells even at
    // the coarsest grid, so a one-cell budget is out of reach.
    const straddling: MaskRawAnnotationData = {
      format: MASK_RAW_FORMAT,
      data: {
        ...encodeCanonical(
          runRaster(
            {
              cells: { x: 65_530, y: 65_530, width: 12, height: 12 },
              imageWidth: 100_000,
              imageHeight: 100_000,
              downsample: 1,
            },
            [0, 144],
          ),
        ),
      },
    };
    let caught: unknown;
    try {
      buildMaskFabricObject(straddling, { id: 'ann-1', maxCanvasPixels: 1 });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(MaskCanvasTooLargeError);
    expect(caught).toMatchObject({ width: 2, height: 2, maxPixels: 1 });
    expect((caught as Error).message).toMatch(/display budget of 1 canvas pixels/);
  });

  it('still draws a mask exactly as long as the limit', () => {
    const object = buildMaskFabricObject(solid(MAX_MASK_CANVAS_SIDE, 1), { id: 'ann-1' });
    expect((object as FabricImage).width).toBe(MAX_MASK_CANVAS_SIDE);
    expect((object as FabricImage).scaleX).toBe(1);
  });
});

describe('the display budget', () => {
  /** A solid 6,000 x 5,000 mask: 30 M cells, under the cap and every side limit. */
  const large = (): MaskRawAnnotationData => ({
    format: MASK_RAW_FORMAT,
    data: {
      ...encodeCanonical(
        runRaster(
          {
            cells: { x: 0, y: 0, width: 6_000, height: 5_000 },
            imageWidth: 8_000,
            imageHeight: 8_000,
            downsample: 1,
          },
          [0, 30_000_000],
        ),
      ),
    },
  });

  // 30 M cells per mask, as for the strips above.
  it('draws a mask past 16 Mi cells from a 2x mip', { timeout: 30_000 }, () => {
    const object = buildMaskFabricObject(large(), { id: 'ann-1' }) as FabricImage;
    expect([object.width, object.height, object.scaleX, object.scaleY]).toEqual([
      3_000, 2_500, 2, 2,
    ]);
    expect([object.left, object.top]).toEqual([0, 0]);
  });

  it('takes a host budget in place of the default', { timeout: 30_000 }, () => {
    const full = buildMaskFabricObject(large(), {
      id: 'ann-1',
      maxCanvasPixels: Infinity,
    }) as FabricImage;
    expect([full.width, full.scaleX]).toEqual([6_000, 1]);
    // 30 M / 4^2 is under 2 M, 30 M / 4 is not: two halvings.
    const small = buildMaskFabricObject(large(), {
      id: 'ann-1',
      maxCanvasPixels: 2 * 1024 * 1024,
    }) as FabricImage;
    expect([small.width, small.height, small.scaleX]).toEqual([1_500, 1_250, 4]);
  });
});
