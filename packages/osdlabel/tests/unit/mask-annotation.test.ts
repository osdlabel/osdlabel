import { describe, it, expect } from 'vitest';
import { createImageId, type AnnotationState } from '@osdlabel/viewer-api';
import { createAnnotationContextId } from '@osdlabel/annotation-context';
import {
  BoundedDenseMaskBuffer,
  CocoRunLimitExceededError,
  DEFAULT_MAX_MASK_PIXELS,
  MAX_COCO_RUNS,
  MaskCapacityExceededError,
  cocoRleCodec,
  createMaskCodecRegistry,
  decodeCanonical,
  stampCircle,
  upsampleSnapshot,
  denseRaster,
  runRaster,
  type MaskCodec,
} from '@osdlabel/mask';
import { MASK_RAW_FORMAT, createAnnotationId } from '@osdlabel/annotation';
import { Rect } from 'fabric';
import { createMaskAnnotation, maskAnnotationFields } from '../../src/create-mask-annotation.js';
import { processObjectModified } from '../../src/tool-factory.js';
import { createAnnotationFromGeometry } from '../../src/create-annotation.js';
import { SerializationError, serialize, deserialize } from '../../src/serialization-configured.js';
import type { OsdAnnotation, OsdFields } from '../../src/types.js';

const imageId = createImageId('img-1');
const contextId = createAnnotationContextId('ctx-1');

function paintedSnapshot() {
  const buffer = new BoundedDenseMaskBuffer({ imageWidth: 400, imageHeight: 300 });
  stampCircle(buffer, 120.5, 90.5, 10, 1);
  stampCircle(buffer, 124.5, 92.5, 3, 0); // a hole, so the runs are non-trivial
  return buffer.snapshot();
}

function stateWith(...annotations: OsdAnnotation[]): AnnotationState<OsdFields> {
  const byImage: AnnotationState<OsdFields>['byImage'] = {};
  for (const annotation of annotations) {
    byImage[annotation.imageId] = { ...byImage[annotation.imageId], [annotation.id]: annotation };
  }
  return { byImage, changeCounter: 1 };
}

describe('createMaskAnnotation', () => {
  it('summarises the mask in geometry and carries pixels in the raw envelope', () => {
    const snapshot = paintedSnapshot();
    const annotation = createMaskAnnotation(snapshot, { imageId, contextId });

    expect(annotation.geometry.type).toBe('mask');
    if (annotation.geometry.type !== 'mask') return;
    expect(annotation.geometry.origin).toEqual({ x: snapshot.cells.x, y: snapshot.cells.y });
    expect(annotation.geometry.width).toBe(snapshot.cells.width);
    expect(annotation.geometry.height).toBe(snapshot.cells.height);
    // Exact, not an outline approximation.
    expect(annotation.geometry.pixelCount).toBe(snapshot.data.reduce((a, v) => a + v, 0));

    expect(annotation.toolType).toBe('segmentationBrush');
    expect(annotation.rawAnnotationData.format).toBe(MASK_RAW_FORMAT);
    expect(annotation.imageId).toBe(imageId);
    expect(annotation.contextId).toBe(contextId);
  });

  it('records the pixels losslessly', () => {
    const snapshot = paintedSnapshot();
    const annotation = createMaskAnnotation(snapshot, { imageId, contextId });
    if (annotation.rawAnnotationData.format !== MASK_RAW_FORMAT) throw new Error('expected mask');

    expect(decodeCanonical(annotation.rawAnnotationData.data)).toEqual(snapshot);
  });

  it('records the image dimensions that COCO export needs', () => {
    const annotation = createMaskAnnotation(paintedSnapshot(), { imageId, contextId });
    if (annotation.rawAnnotationData.format !== MASK_RAW_FORMAT) throw new Error('expected mask');
    expect(annotation.rawAnnotationData.data.imageWidth).toBe(400);
    expect(annotation.rawAnnotationData.data.imageHeight).toBe(300);
  });
});

describe('a mask with an empty box', () => {
  it('has empty geometry with no downsample, whatever box it was left with', () => {
    const annotation = createMaskAnnotation(
      {
        cells: { x: 10, y: 3, width: 5, height: 0 },
        data: new Uint8Array(0),
        imageWidth: 100,
        imageHeight: 100,
        downsample: 4,
      },
      { imageId, contextId },
    );
    expect(annotation.geometry).toEqual({
      type: 'mask',
      origin: { x: 0, y: 0 },
      width: 0,
      height: 0,
      pixelCount: 0,
    });
  });
});

describe('a mask past the format cap', () => {
  // 13,000 square with one painted cell: built from runs, never allocated.
  const SIDE = 13_000;
  const over = runRaster(
    {
      cells: { x: 0, y: 0, width: SIDE, height: SIDE },
      imageWidth: 20_000,
      imageHeight: 20_000,
      downsample: 1,
    },
    [0, 1, SIDE * SIDE - 1],
  );

  it('is refused on write, so the annotator never holds a mask a reader refuses', () => {
    expect(SIDE * SIDE).toBeGreaterThan(DEFAULT_MAX_MASK_PIXELS);
    expect(() => createMaskAnnotation(over, { imageId, contextId })).toThrow(
      MaskCapacityExceededError,
    );
    expect(() => maskAnnotationFields(over)).toThrow(MaskCapacityExceededError);
  });
});

describe('createAnnotationFromGeometry', () => {
  it('does not accept mask geometry', () => {
    // Masks are excluded by the parameter type (`VectorGeometry`), so a
    // TypeScript caller gets a compile error naming `createMaskAnnotation`.
    //
    // The `@ts-expect-error` below is a real assertion: this file is
    // type-checked under `tsconfig.tests.json`, so widening the parameter back
    // to `Geometry` leaves the directive unused and fails `pnpm typecheck`.
    //
    // What the runtime assertion adds is the JavaScript caller's experience,
    // which has no compile error at all: a named `TypeError` pointing at the
    // mask helpers, rather than `Cannot read properties of undefined (reading
    // 'toObject')` several frames downstream.
    const callWithMask = (): OsdAnnotation =>
      createAnnotationFromGeometry(
        // @ts-expect-error mask geometry carries no pixels; use createMaskAnnotation
        { type: 'mask', origin: { x: 0, y: 0 }, width: 4, height: 4, pixelCount: 2 },
        { imageId, contextId, toolType: 'segmentationBrush' },
      );
    expect(callWithMask).toThrow(TypeError);
    expect(callWithMask).toThrow(/createMaskAnnotation/);
  });

  it('still accepts vector geometry', () => {
    const annotation = createAnnotationFromGeometry(
      { type: 'rectangle', origin: { x: 1, y: 2 }, width: 10, height: 20, rotation: 0 },
      { imageId, contextId, toolType: 'rectangle' },
    );
    expect(annotation.geometry.type).toBe('rectangle');
  });
});

describe('mask serialization', () => {
  it('round-trips through serialize/deserialize in the canonical encoding', () => {
    const snapshot = paintedSnapshot();
    const annotation = createMaskAnnotation(snapshot, { imageId, contextId });

    const doc = serialize(stateWith(annotation));
    const restored = deserialize(JSON.parse(JSON.stringify(doc)));
    const back = restored.byImage[imageId]?.[annotation.id];

    expect(back).toBeDefined();
    expect(back?.geometry).toEqual(annotation.geometry);
    if (back?.rawAnnotationData.format !== MASK_RAW_FORMAT) throw new Error('expected mask');
    expect(decodeCanonical(back.rawAnnotationData.data)).toEqual(snapshot);
  });

  it('exports mask pixels through a codec without touching vector annotations', () => {
    const snapshot = paintedSnapshot();
    const mask = createMaskAnnotation(snapshot, { imageId, contextId });
    const rect = createAnnotationFromGeometry(
      { type: 'rectangle', origin: { x: 5, y: 5 }, width: 20, height: 10, rotation: 0 },
      { imageId, contextId, toolType: 'rectangle' },
    );

    const doc = serialize(stateWith(mask, rect), { maskCodec: cocoRleCodec });

    const exportedMask = doc.find((a) => a.id === mask.id);
    expect(exportedMask?.rawAnnotationData.format).toBe('coco-rle');
    // COCO reports [height, width] of the full image.
    expect(exportedMask?.rawAnnotationData.data.size).toEqual([300, 400]);
    expect(typeof exportedMask?.rawAnnotationData.data.counts).toBe('string');

    // The vector annotation is passed through untouched.
    expect(doc.find((a) => a.id === rect.id)?.rawAnnotationData.format).toBe('fabric');
  });

  it('re-imports a COCO-encoded document back to canonical pixels', () => {
    const snapshot = paintedSnapshot();
    const mask = createMaskAnnotation(snapshot, { imageId, contextId });

    const exported = JSON.parse(
      JSON.stringify(serialize(stateWith(mask), { maskCodec: cocoRleCodec })),
    );
    const restored = deserialize(exported, {
      maskCodecs: createMaskCodecRegistry(cocoRleCodec),
    });

    const back = restored.byImage[imageId]?.[mask.id];
    expect(back).toBeDefined();
    if (back?.rawAnnotationData.format !== MASK_RAW_FORMAT) throw new Error('expected mask');
    expect(decodeCanonical(back.rawAnnotationData.data)).toEqual(snapshot);
  });

  it('rejects an exported document when no codec is supplied to decode it', () => {
    const mask = createMaskAnnotation(paintedSnapshot(), { imageId, contextId });
    const exported = JSON.parse(
      JSON.stringify(serialize(stateWith(mask), { maskCodec: cocoRleCodec })),
    );
    // Validation only accepts envelopes the annotator itself reads.
    expect(() => deserialize(exported)).toThrow(/Validation failed/);
  });
});

describe('processObjectModified with a mask annotation', () => {
  /**
   * The invariant, not the guard that currently implements it.
   *
   * `object:modified` fires for any Fabric object the user touches, and the
   * handler rewrites the annotation from that object. For a mask that would
   * replace the pixel envelope with a serialized Fabric image — permanent,
   * silent data loss, and the quietest failure in this feature.
   *
   * `getGeometryFromFabricObject` has an explicit `type === 'mask'` guard, but
   * it happens to be unfalsifiable today: no branch below it matches `'mask'`
   * either, so removing it changes nothing. Testing the guard would therefore
   * prove nothing. What is worth pinning is that `processObjectModified`
   * returns nothing for a mask however that comes about — which is what breaks
   * if someone later adds a fall-through branch.
   */
  it('never rewrites a mask from its rendered object', () => {
    const mask = createMaskAnnotation(paintedSnapshot(), { imageId, contextId });
    const state = stateWith(mask);

    // The object a mask actually renders as, carrying its annotation id.
    const rendered = new Rect({ left: 0, top: 0, width: 20, height: 20 });
    rendered.id = mask.id;

    expect(processObjectModified(rendered, state, imageId)).toBeNull();
  });

  it('still rewrites a vector annotation from its object', () => {
    const rect = createAnnotationFromGeometry(
      { type: 'rectangle', origin: { x: 0, y: 0 }, width: 10, height: 10, rotation: 0 },
      { id: createAnnotationId('rect-1'), imageId, contextId, toolType: 'rectangle' },
    );
    // Placed by its top-left corner, unstroked: a rectangle's geometry is read
    // from the centre it is painted at, and Fabric 7's default origin is the
    // centre, while a stroke widens the painted box.
    const moved = new Rect({
      left: 40,
      top: 50,
      width: 10,
      height: 10,
      strokeWidth: 0,
      originX: 'left',
      originY: 'top',
    });
    moved.id = rect.id;

    const result = processObjectModified(moved, stateWith(rect), imageId);
    expect(result?.geometry).toMatchObject({ origin: { x: 40, y: 50 } });
  });
});

describe('a downsampled mask', () => {
  /** A 4x mask on a 401x301 image, reaching its clipped last column and row. */
  function downsampledSnapshot() {
    const buffer = new BoundedDenseMaskBuffer({ imageWidth: 401, imageHeight: 301, downsample: 4 });
    stampCircle(buffer, 380, 280, 30, 1);
    stampCircle(buffer, 384, 284, 6, 0);
    return buffer.snapshot();
  }

  it('keeps its geometry in image pixels, with the downsample alongside', () => {
    const snapshot = downsampledSnapshot();
    const annotation = createMaskAnnotation(snapshot, { imageId, contextId });
    if (annotation.geometry.type !== 'mask') throw new Error('expected mask');
    const expanded = upsampleSnapshot(snapshot, Infinity);
    expect(annotation.geometry).toEqual({
      type: 'mask',
      origin: { x: expanded.cells.x, y: expanded.cells.y },
      width: expanded.cells.width,
      height: expanded.cells.height,
      // Exact image pixels, clipped cells included: what `area()` reports.
      pixelCount: expanded.data.reduce((sum, v) => sum + v, 0),
      downsample: 4,
    });
    expect(expanded.cells.x + expanded.cells.width).toBe(401);
    expect(expanded.cells.y + expanded.cells.height).toBe(301);
  });

  it('round-trips through serialize/deserialize at its own resolution', () => {
    const snapshot = downsampledSnapshot();
    const annotation = createMaskAnnotation(snapshot, { imageId, contextId });
    const restored = deserialize(JSON.parse(JSON.stringify(serialize(stateWith(annotation)))));
    expect(restored.skipped).toEqual([]);
    const back = restored.byImage[imageId]?.[annotation.id];
    expect(back).toBeDefined();
    expect(back!.geometry).toEqual(annotation.geometry);
    if (back!.rawAnnotationData.format !== MASK_RAW_FORMAT) throw new Error('expected mask');
    expect(back!.rawAnnotationData.data.downsample).toBe(4);
    expect(decodeCanonical(back!.rawAnnotationData.data)).toEqual(snapshot);
  });

  it('exports to COCO as the level-0 mask it stands for', () => {
    const snapshot = downsampledSnapshot();
    const mask = createMaskAnnotation(snapshot, { imageId, contextId });
    const doc = serialize(stateWith(mask), { maskCodec: cocoRleCodec });
    const exported = doc.find((a) => a.id === mask.id)!;
    expect(exported.rawAnnotationData.data).toEqual(
      cocoRleCodec.encode(denseRaster(upsampleSnapshot(snapshot, Infinity))),
    );
  });

  it('refuses a codec that has not opted in, rather than mis-placing the mask', () => {
    const mask = createMaskAnnotation(downsampledSnapshot(), { imageId, contextId });
    const legacy: MaskCodec = { format: 'legacy', encode: (s) => ({ x: s.cells.x, y: s.cells.y }) };
    expect(() => serialize(stateWith(mask), { maskCodec: legacy })).toThrow(
      /does not declare encodesDownsampled/,
    );
    // A full-resolution mask still goes through it, as before.
    const fine = createMaskAnnotation(paintedSnapshot(), { imageId, contextId });
    expect(() => serialize(stateWith(fine), { maskCodec: legacy })).not.toThrow();
  });

  describe('through COCO, which has no downsample of its own', () => {
    const registry = createMaskCodecRegistry(cocoRleCodec);
    const throughCoco = (...annotations: OsdAnnotation[]) =>
      deserialize(
        JSON.parse(
          JSON.stringify(serialize(stateWith(...annotations), { maskCodec: cocoRleCodec })),
        ),
        { maskCodecs: registry },
      );

    it('comes back at its own downsample, carried by its geometry', () => {
      const snapshot = downsampledSnapshot();
      const mask = createMaskAnnotation(snapshot, { imageId, contextId });
      const restored = throughCoco(mask);
      expect(restored.skipped).toEqual([]);
      const back = restored.byImage[imageId]?.[mask.id];
      expect(back).toBeDefined();
      expect(back!.geometry).toEqual(mask.geometry);
      if (back!.rawAnnotationData.format !== MASK_RAW_FORMAT) throw new Error('expected mask');
      expect(back!.rawAnnotationData.data).toEqual(mask.rawAnnotationData.data);
    });

    it('keeps a coarse disc coarse, payload and all', () => {
      // r = 1500 at downsample 16 on a 100k x 80k slide. Decoded at full
      // resolution it would come back as a 3000-pixel disc at downsample 1,
      // with twenty times the payload.
      const buffer = new BoundedDenseMaskBuffer({
        imageWidth: 100_000,
        imageHeight: 80_000,
        downsample: 16,
      });
      stampCircle(buffer, 40_000, 30_000, 1500, 1);
      const mask = createMaskAnnotation(buffer.snapshot(), { imageId, contextId });
      if (mask.rawAnnotationData.format !== MASK_RAW_FORMAT) throw new Error('expected mask');
      const restored = throughCoco(mask);
      expect(restored.skipped).toEqual([]);
      const back = restored.byImage[imageId]![mask.id]!;
      if (back.rawAnnotationData.format !== MASK_RAW_FORMAT) throw new Error('expected mask');
      expect(back.rawAnnotationData.data.downsample).toBe(16);
      expect(mask.rawAnnotationData.data.counts).toHaveLength(648);
      expect(back.rawAnnotationData.data.counts).toBe(mask.rawAnnotationData.data.counts);
      expect(back.geometry).toEqual(mask.geometry);
    });

    it('re-imports a region whose image pixels are past the cap, as cells', () => {
      // 21,024 x 17,024 image pixels at downsample 16: 1,314 x 1,064 cells.
      const raster = runRaster(
        {
          cells: { x: 1000, y: 1000, width: 1314, height: 1064 },
          imageWidth: 100_000,
          imageHeight: 80_000,
          downsample: 16,
        },
        [0, 1314 * 1064],
      );
      const mask = createMaskAnnotation(raster, { imageId, contextId });
      expect(21_024 * 17_024).toBeGreaterThan(DEFAULT_MAX_MASK_PIXELS);
      const restored = throughCoco(mask);
      expect(restored.skipped).toEqual([]);
      const back = restored.byImage[imageId]![mask.id]!;
      expect(back.geometry).toEqual({
        type: 'mask',
        origin: { x: 16_000, y: 16_000 },
        width: 21_024,
        height: 17_024,
        pixelCount: 21_024 * 17_024,
        downsample: 16,
      });
    });

    it('skips a mask its geometry declares coarser than its pixels are, naming why', () => {
      const good = createMaskAnnotation(paintedSnapshot(), { imageId, contextId });
      const fine = createMaskAnnotation(paintedSnapshot(), {
        id: createAnnotationId('fine'),
        imageId,
        contextId,
      });
      const doc = JSON.parse(
        JSON.stringify(serialize(stateWith(good, fine), { maskCodec: cocoRleCodec })),
      );
      doc.find((a: { id: string }) => a.id === fine.id).geometry.downsample = 4;
      const restored = deserialize(doc, { maskCodecs: registry });
      expect(restored.byImage[imageId]?.[good.id]).toBeDefined();
      expect(restored.skipped.map((s) => s.id)).toEqual([fine.id]);
      expect(restored.skipped[0]!.reason).toMatch(
        /Codec "coco-rle".*not constant within each 4x4 block/,
      );
    });

    it('decodes at full resolution when the declared downsample is unusable', () => {
      const mask = createMaskAnnotation(paintedSnapshot(), { imageId, contextId });
      const doc = JSON.parse(
        JSON.stringify(serialize(stateWith(mask), { maskCodec: cocoRleCodec })),
      );
      doc[0].geometry.downsample = 3;
      const restored = deserialize(doc, { maskCodecs: registry });
      expect(restored.skipped).toEqual([]);
      expect(restored.byImage[imageId]![mask.id]!.geometry).toEqual(mask.geometry);
    });

    it('refuses to export a coarse mask past the COCO bound, with the codec error as cause', () => {
      // 3,200 x 2,700 alternating cell rows at downsample 16: sixteen runs per
      // cell row, about 138 M in all, past MAX_COCO_RUNS.
      const raster = runRaster(
        {
          cells: { x: 0, y: 0, width: 3200, height: 2700 },
          imageWidth: 100_000,
          imageHeight: 80_000,
          downsample: 16,
        },
        [0, ...Array.from({ length: 2700 }, () => 3200)],
      );
      const mask = createMaskAnnotation(raster, { imageId, contextId });
      expect(() => serialize(stateWith(mask))).not.toThrow();
      let caught: unknown;
      try {
        serialize(stateWith(mask), { maskCodec: cocoRleCodec });
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(SerializationError);
      const cause = (caught as SerializationError).cause;
      expect(cause).toBeInstanceOf(CocoRunLimitExceededError);
      expect((cause as CocoRunLimitExceededError).maxRuns).toBe(MAX_COCO_RUNS);
      expect((cause as CocoRunLimitExceededError).downsample).toBe(16);
    });
  });

  it('skips a payload whose downsample is unusable, without losing the document', () => {
    const good = createMaskAnnotation(paintedSnapshot(), { imageId, contextId });
    const bad = createMaskAnnotation(downsampledSnapshot(), { imageId, contextId });
    const doc = JSON.parse(JSON.stringify(serialize(stateWith(good, bad))));
    const badEntry = doc.find((a: { id: string }) => a.id === bad.id);
    badEntry.rawAnnotationData.data.downsample = 3;
    const restored = deserialize(doc);
    expect(restored.byImage[imageId]?.[good.id]).toBeDefined();
    expect(restored.skipped.map((s) => s.id)).toEqual([bad.id]);
    expect(restored.skipped[0]!.reason).toMatch(/power of two/);
  });
});
