import { describe, it, expect, vi } from 'vitest';
import { createImageId, MAX_BRUSH_RADIUS, MIN_BRUSH_RADIUS } from '@osdlabel/viewer-api';
import type { AnnotationState } from '@osdlabel/viewer-api';
import { createAnnotationContextId } from '@osdlabel/annotation-context';
import type { AnnotationContextId } from '@osdlabel/annotation-context';
import {
  BoundedDenseMaskBuffer,
  DEFAULT_MAX_MASK_PIXELS,
  MaskCapacityExceededError,
  emptySnapshot,
  stampCircle,
} from '@osdlabel/mask';
import { MASK_RAW_FORMAT, createAnnotationId } from '@osdlabel/annotation';
import { buildSegmentationBrushConfig, nextBrushRadius } from '../../src/brush-config.js';
import { applyUIAction } from '../../src/actions.js';
import { createInitialUIState } from '../../src/initial-state.js';
import { createMaskAnnotation } from '../../src/create-mask-annotation.js';
import { createAnnotationFromGeometry } from '../../src/create-annotation.js';
import type { OsdAnnotation, OsdFields } from '../../src/types.js';

const imageId = createImageId('img-1');
const contextId = createAnnotationContextId('ctx-1');

function snapshot() {
  const buffer = new BoundedDenseMaskBuffer({ imageWidth: 300, imageHeight: 200 });
  stampCircle(buffer, 100.5, 80.5, 6, 1);
  return buffer.snapshot();
}

function stateWith(...annotations: OsdAnnotation[]): AnnotationState<OsdFields> {
  const byImage: AnnotationState<OsdFields>['byImage'] = {};
  for (const a of annotations) byImage[a.imageId] = { ...byImage[a.imageId], [a.id]: a };
  return { byImage, changeCounter: 1 };
}

function harness(options: {
  selectedId?: string | null;
  annotations?: OsdAnnotation[];
  activeContextId?: AnnotationContextId | null;
}) {
  const dispatchers = {
    addAnnotation: vi.fn(),
    updateAnnotation: vi.fn(),
    deleteAnnotation: vi.fn(),
    setSelectedAnnotation: vi.fn(),
    adjustBrushRadius: vi.fn(),
  };
  const config = buildSegmentationBrushConfig(
    {
      getBrushRadius: () => 10,
      isErasing: () => false,
      getImageSize: () => ({ width: 300, height: 200 }),
      getSelectedAnnotationId: () =>
        options.selectedId ? createAnnotationId(options.selectedId) : null,
      getAnnotationState: () => stateWith(...(options.annotations ?? [])),
      getImageId: () => imageId,
      getActiveContextId: () =>
        options.activeContextId === undefined ? contextId : options.activeContextId,
    },
    dispatchers,
  );
  return { config, dispatchers };
}

describe('nextBrushRadius', () => {
  it('steps proportionally so both fine and coarse brushes feel responsive', () => {
    expect(nextBrushRadius(4, 1)).toBe(5); // 25% of 4 rounds to 1
    expect(nextBrushRadius(40, 1)).toBe(50);
    expect(nextBrushRadius(40, -1)).toBe(30);
  });

  it('clamps to the configured bounds', () => {
    expect(nextBrushRadius(MIN_BRUSH_RADIUS, -1)).toBe(MIN_BRUSH_RADIUS);
    expect(nextBrushRadius(MAX_BRUSH_RADIUS, 1)).toBe(MAX_BRUSH_RADIUS);
  });
});

describe('buildSegmentationBrushConfig target resolution', () => {
  it('targets the selected mask so a stroke refines it', () => {
    const mask = createMaskAnnotation(snapshot(), {
      id: createAnnotationId('mask-1'),
      imageId,
      contextId,
    });
    const { config } = harness({ selectedId: 'mask-1', annotations: [mask] });

    const target = config.getTarget();
    expect(target?.annotationId).toBe('mask-1');
    expect(target?.snapshot.width).toBe(snapshot().width);
  });

  it('starts a new mask when nothing is selected', () => {
    expect(harness({ selectedId: null }).config.getTarget()).toBeNull();
  });

  it('starts a new mask when the selection is a vector annotation', () => {
    const rect = createAnnotationFromGeometry(
      { type: 'rectangle', origin: { x: 0, y: 0 }, width: 10, height: 10, rotation: 0 },
      { id: createAnnotationId('rect-1'), imageId, contextId, toolType: 'rectangle' },
    );
    const { config } = harness({ selectedId: 'rect-1', annotations: [rect] });
    expect(config.getTarget()).toBeNull();
  });

  it('ignores a selected mask belonging to another context', () => {
    const mask = createMaskAnnotation(snapshot(), {
      id: createAnnotationId('mask-1'),
      imageId,
      contextId,
    });
    const { config } = harness({
      selectedId: 'mask-1',
      annotations: [mask],
      activeContextId: createAnnotationContextId('ctx-other'),
    });
    expect(config.getTarget()).toBeNull();
  });
});

describe('buildSegmentationBrushConfig commit', () => {
  it('creates and then selects a new mask, so the next stroke refines it', () => {
    const { config, dispatchers } = harness({ selectedId: null });

    config.onCommit({ annotationId: null, imageId, contextId, snapshot: snapshot() });

    expect(dispatchers.addAnnotation).toHaveBeenCalledOnce();
    const created = dispatchers.addAnnotation.mock.calls[0]![0] as OsdAnnotation;
    expect(created.geometry.type).toBe('mask');
    expect(created.rawAnnotationData.format).toBe(MASK_RAW_FORMAT);
    expect(dispatchers.setSelectedAnnotation).toHaveBeenCalledWith(created.id);
    expect(dispatchers.updateAnnotation).not.toHaveBeenCalled();
  });

  it('updates in place when refining an existing mask', () => {
    const { config, dispatchers } = harness({ selectedId: 'mask-1' });
    const id = createAnnotationId('mask-1');

    config.onCommit({ annotationId: id, imageId, contextId, snapshot: snapshot() });

    expect(dispatchers.addAnnotation).not.toHaveBeenCalled();
    expect(dispatchers.updateAnnotation).toHaveBeenCalledOnce();
    const [passedId, passedImage, patch] = dispatchers.updateAnnotation.mock.calls[0]!;
    expect(passedId).toBe(id);
    expect(passedImage).toBe(imageId);
    expect(patch.geometry.type).toBe('mask');
    expect(patch.rawAnnotationData.format).toBe(MASK_RAW_FORMAT);
  });

  it('does not create an annotation for a stroke that painted nothing', () => {
    const { config, dispatchers } = harness({ selectedId: null });

    config.onCommit({
      annotationId: null,
      imageId,
      contextId,
      snapshot: emptySnapshot(300, 200),
    });

    expect(dispatchers.addAnnotation).not.toHaveBeenCalled();
    expect(dispatchers.setSelectedAnnotation).not.toHaveBeenCalled();
  });

  it('deletes a mask that a stroke erased entirely, rather than leaving a zombie', () => {
    const { config, dispatchers } = harness({ selectedId: 'mask-1' });
    const id = createAnnotationId('mask-1');

    config.onCommit({ annotationId: id, imageId, contextId, snapshot: emptySnapshot(300, 200) });

    expect(dispatchers.deleteAnnotation).toHaveBeenCalledWith(id, imageId);
    expect(dispatchers.setSelectedAnnotation).toHaveBeenCalledWith(null);
    expect(dispatchers.updateAnnotation).not.toHaveBeenCalled();
  });

  it('preserves the target mask own fill when refining it', () => {
    const mask = createMaskAnnotation(snapshot(), {
      id: createAnnotationId('mask-1'),
      imageId,
      contextId,
      fill: 'rgba(255, 0, 0, 0.4)',
    });
    const { config, dispatchers } = harness({ selectedId: 'mask-1', annotations: [mask] });

    // Resolving the target is what records the fill, exactly as a stroke does.
    expect(config.getTarget()).not.toBeNull();
    config.onCommit({
      annotationId: createAnnotationId('mask-1'),
      imageId,
      contextId,
      snapshot: snapshot(),
    });

    const [, , patch] = dispatchers.updateAnnotation.mock.calls[0]!;
    expect(patch.rawAnnotationData.data.fill).toBe('rgba(255, 0, 0, 0.4)');
  });

  it('forwards resize requests to the host', () => {
    const { config, dispatchers } = harness({ selectedId: null });
    config.onAdjustRadius?.(1);
    expect(dispatchers.adjustBrushRadius).toHaveBeenCalledWith(1);
  });
});

describe('buildSegmentationBrushConfig host settings', () => {
  it('passes maxPixels and onCapacityExceeded through to the tool config', () => {
    const onCapacityExceeded = vi.fn();
    const config = buildSegmentationBrushConfig(
      {
        getBrushRadius: () => 10,
        isErasing: () => false,
        getImageSize: () => ({ width: 300, height: 200 }),
        getSelectedAnnotationId: () => null,
        getAnnotationState: () => stateWith(),
        getImageId: () => imageId,
        getActiveContextId: () => contextId,
        maxPixels: 1024,
      },
      {
        addAnnotation: vi.fn(),
        updateAnnotation: vi.fn(),
        deleteAnnotation: vi.fn(),
        setSelectedAnnotation: vi.fn(),
        adjustBrushRadius: vi.fn(),
        onCapacityExceeded,
      },
    );

    expect(config.maxPixels).toBe(1024);
    config.onCapacityExceeded?.(new MaskCapacityExceededError(2048, 1024));
    expect(onCapacityExceeded).toHaveBeenCalledOnce();
  });

  it('omits both when the host does not configure them', () => {
    const { config } = harness({ selectedId: null });
    expect('maxPixels' in config).toBe(false);
    expect('onCapacityExceeded' in config).toBe(false);
  });
});

describe('applyUIAction brush radius', () => {
  it('ignores a non-finite radius instead of latching it into state', () => {
    const state = createInitialUIState();
    const withNaN = { ...state };
    applyUIAction(withNaN, { type: 'SET_BRUSH_RADIUS', payload: Number.NaN });
    expect(withNaN.brushRadius).toBe(state.brushRadius);

    applyUIAction(withNaN, { type: 'SET_BRUSH_RADIUS', payload: Number.POSITIVE_INFINITY });
    expect(withNaN.brushRadius).toBe(state.brushRadius);
  });

  it('still clamps ordinary out-of-range values', () => {
    const state = createInitialUIState();
    applyUIAction(state, { type: 'SET_BRUSH_RADIUS', payload: -5 });
    expect(state.brushRadius).toBe(MIN_BRUSH_RADIUS);
    applyUIAction(state, { type: 'SET_BRUSH_RADIUS', payload: 99999 });
    expect(state.brushRadius).toBe(MAX_BRUSH_RADIUS);
  });
});

describe('buildSegmentationBrushConfig target fill', () => {
  it("hands the target's own tint to the tool so the preview does not recolour it", () => {
    const mask = createMaskAnnotation(snapshot(), {
      id: createAnnotationId('mask-1'),
      imageId,
      contextId,
      fill: 'rgba(255, 0, 0, 0.4)',
    });
    const { config } = harness({ selectedId: 'mask-1', annotations: [mask] });
    expect(config.getTarget()?.fill).toBe('rgba(255, 0, 0, 0.4)');
  });

  it('leaves fill unset for a mask that never recorded one', () => {
    const mask = createMaskAnnotation(snapshot(), {
      id: createAnnotationId('mask-1'),
      imageId,
      contextId,
    });
    const { config } = harness({ selectedId: 'mask-1', annotations: [mask] });
    expect(config.getTarget()?.fill).toBeUndefined();
  });
});

describe('buildSegmentationBrushConfig pixel cap handling', () => {
  function configWith(maxPixels: number | undefined) {
    return buildSegmentationBrushConfig(
      {
        getBrushRadius: () => 10,
        isErasing: () => false,
        getImageSize: () => ({ width: 300, height: 200 }),
        getSelectedAnnotationId: () => null,
        getAnnotationState: () => stateWith(),
        getImageId: () => imageId,
        getActiveContextId: () => contextId,
        ...(maxPixels !== undefined ? { maxPixels } : {}),
      },
      {
        addAnnotation: vi.fn(),
        updateAnnotation: vi.fn(),
        deleteAnnotation: vi.fn(),
        setSelectedAnnotation: vi.fn(),
        adjustBrushRadius: vi.fn(),
      },
    );
  }

  it('drops a cap the buffer would reject outright', () => {
    // The buffer raises a plain RangeError for a non-positive or non-finite
    // cap — not the MaskCapacityExceededError the tool knows how to abandon a
    // stroke on — so an unusable value escaped into Fabric's event dispatch on
    // every pointer-down. Falling back to the default is the same treatment the
    // brush radius gets a few lines away.
    for (const bad of [Number.NaN, 0, -1, Number.NEGATIVE_INFINITY]) {
      expect(configWith(bad).maxPixels).toBeUndefined();
    }
  });

  it('clamps a cap above the shared ceiling instead of honouring it', () => {
    // Painting above the ceiling produces a mask that cannot be rendered,
    // exported, or re-imported: rendering and the validation schema both
    // enforce it, and the schema's copy is a module constant.
    expect(configWith(4 * DEFAULT_MAX_MASK_PIXELS).maxPixels).toBe(DEFAULT_MAX_MASK_PIXELS);
  });

  it('passes a usable cap through unchanged', () => {
    expect(configWith(5000).maxPixels).toBe(5000);
    expect(configWith(undefined).maxPixels).toBeUndefined();
  });
});
