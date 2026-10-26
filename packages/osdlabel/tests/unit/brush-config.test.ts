import { describe, it, expect, vi } from 'vitest';
import { createImageId, MAX_BRUSH_RADIUS, MIN_BRUSH_RADIUS } from '@osdlabel/viewer-api';
import type { AnnotationState } from '@osdlabel/viewer-api';
import { createAnnotationContextId } from '@osdlabel/annotation-context';
import type { AnnotationContextId } from '@osdlabel/annotation-context';
import {
  BoundedDenseMaskBuffer,
  DEFAULT_MAX_MASK_PIXELS,
  MaskCapacityExceededError,
  denseRaster,
  emptySnapshot,
  majorityCoarsen,
  stampCircle,
  snapshotImageBox,
  type CoarsenStrategy,
} from '@osdlabel/mask';
import { MASK_RAW_FORMAT, createAnnotationId, type AnnotationId } from '@osdlabel/annotation';
import { MaskCanvasTooLargeError, type BrushCapacityError } from '@osdlabel/fabric-annotations';
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
  return buffer.raster();
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
  selectedFill?: string | undefined;
  maxDownsample?: number | undefined;
  coarsen?: CoarsenStrategy | undefined;
}) {
  const dispatchers = {
    addAnnotation: vi.fn(),
    updateAnnotation: vi.fn(),
    deleteAnnotation: vi.fn(),
    setSelectedAnnotation: vi.fn(),
    adjustBrushRadius: vi.fn(),
    onCoarsen: vi.fn(),
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
      ...(options.selectedFill !== undefined
        ? { getSelectedFill: () => options.selectedFill }
        : {}),
      getMaxDownsample: () => options.maxDownsample,
      getCoarsenStrategy: () => options.coarsen,
    },
    dispatchers,
  );
  return { config, dispatchers };
}

describe('the live preview tint while refining', () => {
  const red = createMaskAnnotation(snapshot(), {
    id: createAnnotationId('red'),
    imageId,
    contextId,
    fill: 'rgba(255, 0, 0, 0.5)',
  });

  it("paints in the mask's own tint by default", () => {
    const { config } = harness({ selectedId: 'red', annotations: [red] });
    expect(config.getTarget()?.fill).toBe('rgba(255, 0, 0, 0.5)');
  });

  it('paints in the selected tint when the host displays one, without recording it', () => {
    // The selected mask is *shown* in `selectedFill`; a preview in its own
    // tint would flash a different colour for the length of the stroke. The
    // commit still records the mask's own fill: the override is display only.
    const { config, dispatchers } = harness({
      selectedId: 'red',
      annotations: [red],
      selectedFill: '#00ff00',
    });
    const target = config.getTarget();
    expect(target?.fill).toBe('#00ff00');

    config.onCommit({
      startDownsample: 1,
      annotationId: target!.annotationId,
      imageId,
      contextId,
      snapshot: snapshot(),
    });
    const patch = dispatchers.updateAnnotation.mock.calls[0]![2] as {
      rawAnnotationData: { data: { fill?: string } };
    };
    expect(patch.rawAnnotationData.data.fill).toBe('rgba(255, 0, 0, 0.5)');
  });
});

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
    expect(target?.snapshot.cells.width).toBe(snapshot().cells.width);
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

    config.onCommit({
      startDownsample: 1,
      annotationId: null,
      imageId,
      contextId,
      snapshot: snapshot(),
    });

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

    config.onCommit({
      startDownsample: 1,
      annotationId: id,
      imageId,
      contextId,
      snapshot: snapshot(),
    });

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
      startDownsample: 1,
      annotationId: null,
      imageId,
      contextId,
      snapshot: denseRaster(emptySnapshot(300, 200)),
    });

    expect(dispatchers.addAnnotation).not.toHaveBeenCalled();
    expect(dispatchers.setSelectedAnnotation).not.toHaveBeenCalled();
  });

  it('deletes a mask that a stroke erased entirely, rather than leaving a zombie', () => {
    const { config, dispatchers } = harness({ selectedId: 'mask-1' });
    const id = createAnnotationId('mask-1');

    config.onCommit({
      startDownsample: 1,
      annotationId: id,
      imageId,
      contextId,
      snapshot: denseRaster(emptySnapshot(300, 200)),
    });

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
      startDownsample: 1,
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

describe('New mask', () => {
  /** A config over live state, the way a binding wires it. */
  function live(newMaskKey?: string) {
    let selected: AnnotationId | null = null;
    let annotations: OsdAnnotation[] = [];
    const reported: BrushCapacityError[] = [];
    const config = buildSegmentationBrushConfig(
      {
        getBrushRadius: () => 10,
        isErasing: () => false,
        getImageSize: () => ({ width: 300, height: 200 }),
        getSelectedAnnotationId: () => selected,
        getAnnotationState: () => stateWith(...annotations),
        getImageId: () => imageId,
        getActiveContextId: () => contextId,
        ...(newMaskKey !== undefined ? { getNewMaskShortcut: () => newMaskKey } : {}),
      },
      {
        addAnnotation: (annotation) => annotations.push(annotation),
        updateAnnotation: (id, _imageId, patch) => {
          annotations = annotations.map((a) => (a.id === id ? { ...a, ...patch } : a));
        },
        deleteAnnotation: (id) => {
          annotations = annotations.filter((a) => a.id !== id);
        },
        setSelectedAnnotation: (id) => {
          selected = id;
        },
        adjustBrushRadius: vi.fn(),
        onCapacityExceeded: (error) => reported.push(error),
      },
    );
    /** One stroke, the way the tool commits it: into whatever `getTarget` resolves. */
    const stroke = (x: number) => {
      const buffer = new BoundedDenseMaskBuffer({ imageWidth: 300, imageHeight: 200 });
      stampCircle(buffer, x, 80, 6, 1);
      config.onCommit({
        startDownsample: 1,
        annotationId: config.getTarget()?.annotationId ?? null,
        imageId,
        contextId,
        snapshot: buffer.raster(),
      });
    };
    return {
      config,
      stroke,
      reported,
      get selected() {
        return selected;
      },
      get annotations() {
        return annotations;
      },
      /** What the New mask button and shortcut dispatch. */
      newMask: () => {
        selected = null;
      },
    };
  }

  it('selects a new mask before adding it, so the brush is never at its limit with nothing selected', () => {
    const { config, dispatchers } = harness({ selectedId: null });
    config.onCommit({
      startDownsample: 1,
      annotationId: null,
      imageId,
      contextId,
      snapshot: snapshot(),
    });
    expect(dispatchers.setSelectedAnnotation).toHaveBeenCalledTimes(1);
    expect(dispatchers.addAnnotation).toHaveBeenCalledTimes(1);
    const selectedAt = dispatchers.setSelectedAnnotation.mock.invocationCallOrder[0]!;
    const addedAt = dispatchers.addAnnotation.mock.invocationCallOrder[0]!;
    expect(selectedAt).toBeLessThan(addedAt);
    expect(dispatchers.setSelectedAnnotation.mock.calls[0]![0]).toBe(
      (dispatchers.addAnnotation.mock.calls[0]![0] as OsdAnnotation).id,
    );
  });

  it('makes the next stroke create a second mask, and select it', () => {
    const h = live();
    h.stroke(60);
    expect(h.annotations).toHaveLength(1);
    const first = h.annotations[0]!.id;
    expect(h.selected).toBe(first);

    // The default, as before: the next stroke refines the selected mask.
    expect(h.config.peekTarget!()).toMatchObject({ downsample: 1 });
    h.stroke(70);
    expect(h.annotations).toHaveLength(1);

    h.newMask();
    expect(h.config.peekTarget!()).toBeNull();
    h.stroke(200);
    expect(h.annotations).toHaveLength(2);
    const second = h.annotations[1]!.id;
    expect(second).not.toBe(first);
    expect(h.selected).toBe(second);
    // And the first mask is untouched by it.
    expect(h.annotations[0]!.id).toBe(first);
  });

  it('peeks the same answer getTarget resolves, without decoding', () => {
    const coarse = new BoundedDenseMaskBuffer({ imageWidth: 300, imageHeight: 200, downsample: 4 });
    stampCircle(coarse, 150, 100, 12, 1);
    const mask4 = createMaskAnnotation(coarse.raster(), {
      id: createAnnotationId('m4'),
      imageId,
      contextId,
    });
    const other = createMaskAnnotation(snapshot(), {
      id: createAnnotationId('other'),
      imageId,
      contextId: createAnnotationContextId('elsewhere'),
    });
    const rect = createAnnotationFromGeometry(
      { type: 'rectangle', origin: { x: 1, y: 1 }, width: 5, height: 5, rotation: 0 },
      { id: createAnnotationId('rect'), imageId, contextId, toolType: 'rectangle' },
    );
    for (const [selectedId, expected] of [
      [null, null],
      ['m4', { downsample: 4, box: snapshotImageBox(coarse.raster()) }],
      ['other', null],
      ['rect', null],
      ['gone', null],
    ] as const) {
      const { config } = harness({ selectedId, annotations: [mask4, other, rect] });
      expect(config.peekTarget!(), String(selectedId)).toEqual(expected);
      const target = config.getTarget();
      expect(target === null, String(selectedId)).toBe(expected === null);
      // The box is the decoded mask's, in image pixels: the cue re-grids from it.
      if (target) expect(snapshotImageBox(target.snapshot)).toEqual(expected!.box);
    }
  });

  it('advises New mask only where it helps', () => {
    // A stroke creating a mask: New mask does nothing with nothing selected,
    // so only the default advice (a smaller region) can help.
    const creating = live('n');
    creating.config.getTarget();
    creating.config.onCapacityExceeded!(new MaskCapacityExceededError(100, 50));
    expect(creating.reported[0]!.message).toMatch(/Paint a smaller region/);
    expect(creating.reported[0]!.message).not.toMatch(/New mask/);

    // Refining at the context's limit, where New mask is disabled.
    let canStart = false;
    const reported: BrushCapacityError[] = [];
    const atLimit = buildSegmentationBrushConfig(
      {
        getBrushRadius: () => 10,
        isErasing: () => false,
        getImageSize: () => ({ width: 300, height: 200 }),
        getSelectedAnnotationId: () => createAnnotationId('m'),
        getAnnotationState: () =>
          stateWith(
            createMaskAnnotation(snapshot(), { id: createAnnotationId('m'), imageId, contextId }),
          ),
        getImageId: () => imageId,
        getActiveContextId: () => contextId,
        getNewMaskShortcut: () => 'n',
        canStartNewMask: () => canStart,
      },
      {
        addAnnotation: vi.fn(),
        updateAnnotation: vi.fn(),
        deleteAnnotation: vi.fn(),
        setSelectedAnnotation: vi.fn(),
        adjustBrushRadius: vi.fn(),
        onCapacityExceeded: (error) => reported.push(error),
      },
    );
    expect(atLimit.getTarget()).not.toBeNull();
    atLimit.onCapacityExceeded!(new MaskCapacityExceededError(100, 50));
    expect(reported[0]!.message).not.toMatch(/New mask/);
    // Below it, the same refining stroke is pointed at New mask.
    canStart = true;
    atLimit.onCapacityExceeded!(new MaskCapacityExceededError(100, 50));
    expect(reported[1]!.message).toMatch(/Start a separate mask with New mask \(n\)\.$/);
  });

  it('points a capacity failure at New mask, by its bound key', () => {
    const h = live('m');
    // A refining stroke: a mask exists and is selected, and its target resolved.
    h.stroke(60);
    expect(h.config.getTarget()).not.toBeNull();
    h.config.onCapacityExceeded!(new MaskCapacityExceededError(100, 50, 2));
    const error = h.reported[0] as MaskCapacityExceededError;
    expect(error).toBeInstanceOf(MaskCapacityExceededError);
    expect([error.requestedCells, error.maxCells, error.downsample]).toEqual([100, 50, 2]);
    expect(error.message).toMatch(/Start a separate mask with New mask \(m\)\.$/);

    // A canvas too long to draw is not a matter of starting another mask.
    const tooLong = new MaskCanvasTooLargeError(40_000, 10);
    h.config.onCapacityExceeded!(tooLong);
    expect(h.reported[1]).toBe(tooLong);

    // Without a key to name, the error goes through as it was.
    const plain = live();
    const original = new MaskCapacityExceededError(100, 50);
    plain.config.onCapacityExceeded!(original);
    expect(plain.reported[0]).toBe(original);
  });
});

describe('coarsening, through the brush config', () => {
  /** A mask at `downsample`, for a commit's snapshot. */
  const at = (downsample: number) => {
    const buffer = new BoundedDenseMaskBuffer({ imageWidth: 300, imageHeight: 200, downsample });
    stampCircle(buffer, 100.5, 80.5, 12, 1);
    return buffer.raster();
  };
  const mask = createMaskAnnotation(snapshot(), {
    id: createAnnotationId('m'),
    imageId,
    contextId,
  });

  it("hands the tool the context's maxDownsample and the host's strategy, defaulting both", () => {
    const strategy: CoarsenStrategy = (source) => majorityCoarsen(source);
    const set = harness({ maxDownsample: 8, coarsen: strategy });
    expect(set.config.getMaxDownsample!()).toBe(8);
    expect(set.config.getCoarsenStrategy!()).toBe(strategy);
    const unset = harness({});
    expect(unset.config.getMaxDownsample!()).toBe(1);
    expect(unset.config.getCoarsenStrategy!()).toBe(majorityCoarsen);
  });

  it('reports a refining stroke that coarsened its mask, after writing it', () => {
    const { config, dispatchers } = harness({ selectedId: 'm', annotations: [mask] });
    config.onCommit({
      annotationId: mask.id,
      imageId,
      contextId,
      snapshot: at(4),
      startDownsample: 1,
    });
    expect(dispatchers.updateAnnotation).toHaveBeenCalledOnce();
    expect(dispatchers.onCoarsen).toHaveBeenCalledWith({
      annotationId: mask.id,
      imageId,
      contextId,
      from: 1,
      to: 4,
    });
    expect(dispatchers.onCoarsen.mock.invocationCallOrder[0]!).toBeGreaterThan(
      dispatchers.updateAnnotation.mock.invocationCallOrder[0]!,
    );
  });

  it('reports a new mask that coarsened, under its new id', () => {
    const { config, dispatchers } = harness({});
    config.onCommit({
      annotationId: null,
      imageId,
      contextId,
      snapshot: at(2),
      startDownsample: 1,
    });
    expect(dispatchers.addAnnotation).toHaveBeenCalledOnce();
    const created = dispatchers.addAnnotation.mock.calls[0]![0] as OsdAnnotation;
    expect(dispatchers.onCoarsen).toHaveBeenCalledWith(
      expect.objectContaining({ annotationId: created.id, from: 1, to: 2 }),
    );
  });

  it('stays quiet for a stroke at the same grid, or one that re-gridded finer', () => {
    const { config, dispatchers } = harness({ selectedId: 'm', annotations: [mask] });
    for (const [snapshotD, startDownsample] of [
      [1, 1],
      [2, 2],
      [1, 4],
    ] as const) {
      config.onCommit({
        annotationId: mask.id,
        imageId,
        contextId,
        snapshot: at(snapshotD),
        startDownsample,
      });
    }
    expect(dispatchers.updateAnnotation).toHaveBeenCalledTimes(3);
    expect(dispatchers.onCoarsen).not.toHaveBeenCalled();
  });
});
