// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { createImageId, type AnnotationState } from '@osdlabel/viewer-api';
import { createAnnotationContextId } from '@osdlabel/annotation-context';
import type { AnnotationId } from '@osdlabel/annotation';
import { BoundedDenseMaskBuffer, stampCircle } from '@osdlabel/mask';
import { DEFAULT_MASK_FILL } from '@osdlabel/fabric-annotations';
import { buildSegmentationBrushConfig, type MaskObjectSeed } from '../../src/brush-config.js';
import type { OsdAnnotation, OsdFields } from '../../src/types.js';

/**
 * A brush commit hands the cell the committed mask's object, built from the
 * stroke's preview, so the rebuild that follows reuses it (#238). In its own
 * file for the DOM: the object is backed by a canvas.
 */
const imageId = createImageId('img-1');
const contextId = createAnnotationContextId('ctx-1');

function stateWith(...annotations: OsdAnnotation[]): AnnotationState<OsdFields> {
  const byImage: AnnotationState<OsdFields>['byImage'] = {};
  for (const a of annotations) byImage[a.imageId] = { ...byImage[a.imageId], [a.id]: a };
  return { byImage, changeCounter: 1 };
}

function harness(options: { selectedFill?: string; fill?: string } = {}) {
  let selected: AnnotationId | null = null;
  let annotations: OsdAnnotation[] = [];
  const order: string[] = [];
  const seeds: MaskObjectSeed[] = [];
  const config = buildSegmentationBrushConfig(
    {
      getBrushRadius: () => 6,
      isErasing: () => false,
      getImageSize: () => ({ width: 200, height: 150 }),
      getSelectedAnnotationId: () => selected,
      getAnnotationState: () => stateWith(...annotations),
      getImageId: () => imageId,
      getActiveContextId: () => contextId,
      ...(options.selectedFill !== undefined
        ? { getSelectedFill: () => options.selectedFill }
        : {}),
      ...(options.fill !== undefined ? { getFill: () => options.fill! } : {}),
    },
    {
      addAnnotation: (annotation) => {
        order.push('add');
        annotations.push(annotation);
      },
      updateAnnotation: (id, _image, patch) => {
        order.push('update');
        annotations = annotations.map((a) => (a.id === id ? { ...a, ...patch } : a));
      },
      deleteAnnotation: vi.fn(),
      setSelectedAnnotation: (id) => {
        selected = id;
      },
      adjustBrushRadius: vi.fn(),
      seedMaskObject: (seed) => {
        order.push('seed');
        seeds.push(seed);
      },
    },
  );
  const crops: ReturnType<typeof vi.fn>[] = [];
  /** A stroke, committed with a preview painted in `previewFill`. */
  const stroke = (x: number, previewFill: string) => {
    const buffer = new BoundedDenseMaskBuffer({ imageWidth: 200, imageHeight: 150 });
    const target = config.getTarget();
    if (target)
      target.snapshot.forEachSpan((cy, x0, x1) => {
        for (let cx = x0; cx < x1; cx++) buffer.set(cx, cy, 1);
      });
    stampCircle(buffer, x, 60, 6, 1);
    const snapshot = buffer.raster();
    const canvas = document.createElement('canvas');
    canvas.width = snapshot.cells.width;
    canvas.height = snapshot.cells.height;
    const crop = vi.fn(() => canvas);
    crops.push(crop);
    config.onCommit({
      startDownsample: 1,
      annotationId: target?.annotationId ?? null,
      imageId,
      contextId,
      snapshot,
      preview: { crop, fill: previewFill },
    });
    return { snapshot, canvas, crop };
  };
  return {
    config,
    stroke,
    seeds,
    crops,
    order,
    get annotations() {
      return annotations;
    },
  };
}

describe('the brush seeds the cell with its preview', () => {
  it('before the write, for a new mask and for a refining stroke', () => {
    const h = harness();
    const first = h.stroke(50, DEFAULT_MASK_FILL);
    expect(h.order).toEqual(['seed', 'add']);
    const seed = h.seeds[0]!;
    const created = h.annotations[0]!;
    expect(seed.annotationId).toBe(created.id);
    expect(seed.rawAnnotationData).toBe(created.rawAnnotationData);
    // Its own tint, no override.
    expect(seed.fill).toBeUndefined();
    // Sized as its box, and cropped only when built.
    expect([seed.width, seed.height]).toEqual([
      first.snapshot.cells.width,
      first.snapshot.cells.height,
    ]);
    expect(first.crop).not.toHaveBeenCalled();
    // Placed where the payload says, from the preview's canvas.
    expect(seed.object()).toMatchObject({
      left: first.snapshot.cells.x,
      top: first.snapshot.cells.y,
      id: created.id,
    });

    h.stroke(70, DEFAULT_MASK_FILL);
    expect(h.order).toEqual(['seed', 'add', 'seed', 'update']);
    expect(h.seeds[1]!.rawAnnotationData).toBe(h.annotations[0]!.rawAnnotationData);
  });

  it('with the tint override the preview was drawn in', () => {
    const h = harness({ selectedFill: 'rgba(255, 0, 0, 0.5)' });
    h.stroke(50, 'rgba(255, 0, 0, 0.5)');
    expect(h.seeds[0]!.fill).toBe('rgba(255, 0, 0, 0.5)');
  });

  it('not at all when the preview is in a tint the cell will not draw', () => {
    // The host overrides the selected tint, but the preview painted the mask's
    // own: the cell will draw it in the override, so the seed would not match.
    const overridden = harness({ selectedFill: 'rgba(255, 0, 0, 0.5)' });
    overridden.stroke(50, DEFAULT_MASK_FILL);
    expect(overridden.seeds).toEqual([]);
    expect(overridden.order).toEqual(['add']);
    // And the preview it could not use was never cropped (#243 minor 10).
    expect(overridden.crops[0]).not.toHaveBeenCalled();

    // No override, and a preview in neither the mask's own tint nor the default.
    const odd = harness({ fill: 'rgba(0, 0, 255, 0.5)' });
    odd.stroke(50, 'rgba(0, 255, 0, 0.5)');
    expect(odd.seeds).toEqual([]);
    // In the mask's own recorded tint, it seeds.
    odd.stroke(90, 'rgba(0, 0, 255, 0.5)');
    expect(odd.seeds).toHaveLength(1);
    expect(odd.seeds[0]!.fill).toBeUndefined();
  });

  it('not at all without a preview', () => {
    const h = harness();
    h.config.onCommit({
      startDownsample: 1,
      annotationId: null,
      imageId,
      contextId,
      snapshot: (() => {
        const b = new BoundedDenseMaskBuffer({ imageWidth: 200, imageHeight: 150 });
        stampCircle(b, 50, 60, 6, 1);
        return b.raster();
      })(),
    });
    expect(h.seeds).toEqual([]);
    expect(h.annotations).toHaveLength(1);
  });
});
