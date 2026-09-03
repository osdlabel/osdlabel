import { describe, it, expect } from 'vitest';
import { FabricImage } from 'fabric';
import { MASK_RAW_FORMAT, type MaskRawAnnotationData } from '@osdlabel/annotation';
import { BoundedDenseMaskBuffer, encodeCanonical, stampCircle } from '@osdlabel/mask';
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

  it('keeps mask edges crisp rather than smoothing them', () => {
    const object = buildMaskFabricObject(envelope(), { id: 'ann-1' });
    expect((object as FabricImage).imageSmoothing).toBe(false);
    expect(object?.objectCaching).toBe(false);
  });

  it('returns null for an empty mask', () => {
    const empty = new BoundedDenseMaskBuffer({ imageWidth: 40, imageHeight: 30 }).snapshot();
    const raw: MaskRawAnnotationData = { format: MASK_RAW_FORMAT, data: encodeCanonical(empty) };
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
