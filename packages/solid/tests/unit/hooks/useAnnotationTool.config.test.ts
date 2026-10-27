import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  batch,
  createComponent,
  createRenderEffect,
  createRoot,
  createSignal,
  untrack,
  type Setter,
} from 'solid-js';
import { version as FABRIC_VERSION } from 'fabric';
import type { FabricOverlay } from '@osdlabel/fabric-osd';
import {
  PolylineTool,
  type AnnotationTool,
  type ToolCallbacks,
  type VertexMarkerOptions,
} from '@osdlabel/fabric-annotations';
import { createAnnotationId } from '@osdlabel/annotation';
import {
  BoundedDenseMaskBuffer,
  MaskCapacityExceededError,
  createMaskAnnotation,
  majorityCoarsen,
  type BrushCapacityError,
  type BrushOptions,
  type CoarsenStrategy,
} from 'osdlabel';
import type { SegmentationBrushToolConfig } from '@osdlabel/fabric-annotations';
import { createImageId, type KeyboardShortcutMap } from '@osdlabel/viewer-api';
import { createAnnotationContextId } from '@osdlabel/annotation-context';
import { AnnotatorProvider, useAnnotator } from '../../../src/state/annotator-context.js';
import { useAnnotationTool } from '../../../src/hooks/useAnnotationTool.js';

/**
 * The provider config a host can change after mount — `keyboardShortcuts`,
 * `vertexMarkers`, `vertexEditLongPressMs`, `vertexEditMoveTolerancePx` — as the
 * tool sees it (#219). It needs the real provider, whose value-compared memos
 * are what is under test, so it cannot live in `useAnnotationTool.test.ts`,
 * which mocks the provider module. React covers the same behaviour in its
 * `useAnnotationTool.test.tsx` ("is rebuilt when a real input changes").
 */

interface CreatedTool {
  readonly tool: AnnotationTool;
  readonly options: unknown;
}
const createdTools: CreatedTool[] = [];

vi.mock('osdlabel', async () => {
  const actual = (await vi.importActual('osdlabel')) as Record<string, unknown>;
  const realFactory = actual.createAnnotationTool as (
    type: unknown,
    options: unknown,
  ) => AnnotationTool | null;
  return {
    ...actual,
    createAnnotationTool: (type: unknown, options: unknown) => {
      const tool = realFactory(type, options);
      if (tool) createdTools.push({ tool, options });
      return tool;
    },
  };
});

const imageId = createImageId('img-1');
const contextId = createAnnotationContextId('ctx-1');

/** A stand-in overlay: only what the hook and an idle polyline tool touch. */
function makeOverlay(): FabricOverlay {
  const canvas = {
    on: vi.fn(),
    off: vi.fn(),
    requestRenderAll: vi.fn(),
    discardActiveObject: vi.fn(),
    getObjects: vi.fn().mockReturnValue([]),
    remove: vi.fn(),
    add: vi.fn(),
  };
  return {
    canvas,
    setMode: vi.fn(),
    screenToImage: vi.fn(),
    onDoubleClick: vi.fn(() => () => {}),
  } as unknown as FabricOverlay;
}

interface Harness {
  readonly setShortcuts: Setter<Partial<KeyboardShortcutMap> | undefined>;
  readonly setMarkers: Setter<VertexMarkerOptions | undefined>;
  readonly setLongPress: Setter<number | undefined>;
  readonly setTolerance: Setter<number | undefined>;
  readonly annotator: ReturnType<typeof useAnnotator>;
}

let dispose: (() => void) | undefined;

/** Mounts the real provider with a polyline tool active on one cell. */
function setup(): Harness {
  const [shortcuts, setShortcuts] = createSignal<Partial<KeyboardShortcutMap> | undefined>({
    rectangleTool: 'b',
  });
  const [markers, setMarkers] = createSignal<VertexMarkerOptions | undefined>({ radius: 4 });
  const [longPress, setLongPress] = createSignal<number | undefined>(500);
  const [tolerance, setTolerance] = createSignal<number | undefined>(6);
  let annotator: ReturnType<typeof useAnnotator> | undefined;
  const overlay = makeOverlay();

  createRoot((d) => {
    dispose = d;
    createComponent(AnnotatorProvider, {
      get keyboardShortcuts() {
        return shortcuts();
      },
      get vertexMarkers() {
        return markers();
      },
      get vertexEditLongPressMs() {
        return longPress();
      },
      get vertexEditMoveTolerancePx() {
        return tolerance();
      },
      get children() {
        // Untracked, as a component body is: Solid evaluates `children` inside
        // a tracking memo, so without this a setup-time read of the config
        // would re-mount the whole subtree on a change and pass the rebuild
        // tests for the wrong reason. `ViewerCell`, the real call site, runs
        // the hook inside `createComponent`, which untracks.
        untrack(() => {
          annotator = useAnnotator();
          annotator.actions.setContexts([
            {
              id: contextId,
              label: 'Test',
              tools: [{ type: 'polyline' }, { type: 'rectangle' }],
            },
          ]);
          annotator.actions.setActiveContext(contextId);
          annotator.actions.assignImageToCell(0, imageId);
          annotator.actions.setActiveTool('polyline');
          useAnnotationTool(
            () => overlay,
            () => imageId,
            () => true,
          );
        });
        return null;
      },
    });
  });

  expect(annotator).toBeDefined();
  return { setShortcuts, setMarkers, setLongPress, setTolerance, annotator: annotator! };
}

describe('useAnnotationTool with the provider config (#219)', () => {
  let activate: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    createdTools.length = 0;
    activate = vi.spyOn(PolylineTool.prototype, 'activate');
  });

  afterEach(() => {
    dispose?.();
    dispose = undefined;
    activate.mockRestore();
  });

  it('builds the tool once on mount', () => {
    setup();
    expect(createdTools).toHaveLength(1);
  });

  describe('is not rebuilt for a re-created object with the same values', () => {
    it('keyboardShortcuts', () => {
      const h = setup();
      h.setShortcuts({ rectangleTool: 'b' });
      expect(createdTools).toHaveLength(1);
    });

    it('vertexMarkers', () => {
      const h = setup();
      h.setMarkers({ radius: 4 });
      expect(createdTools).toHaveLength(1);
    });

    it('the brush radius or eraser, while the brush is active', () => {
      // `activate()` reads the radius to size the cursor ring. Without the
      // `untrack` around it that read is a dependency of the tool effect, and
      // every `]` press tore the tool down — discarding a stroke in progress.
      const h = setup();
      // The shared context leaves `b` unbound for the keyboard test below.
      h.annotator.actions.setContexts([
        {
          id: contextId,
          label: 'Test',
          tools: [{ type: 'polyline' }, { type: 'rectangle' }, { type: 'segmentationBrush' }],
        },
      ]);
      h.annotator.actions.setActiveTool('segmentationBrush');
      expect(createdTools).toHaveLength(2);

      h.annotator.actions.setBrushRadius(20);
      h.annotator.actions.adjustBrushRadius(1);
      h.annotator.actions.setBrushErasing(true);
      expect(createdTools).toHaveLength(2);
    });

    it('the vertex-edit tuning, when an explicit value gives way to the equal default', () => {
      // A signal set to the same number never notifies, so the case that
      // reaches the memo's comparison is a new input resolving to the same
      // config: 500 is DEFAULT_VERTEX_EDIT_LONG_PRESS_MS.
      const h = setup();
      h.setLongPress(undefined);
      expect(h.annotator.vertexEditConfig.longPressMs).toBe(500);
      expect(createdTools).toHaveLength(1);
    });
  });

  describe('is rebuilt, with the new value, when it changes', () => {
    it('keyboardShortcuts', () => {
      const h = setup();
      h.setShortcuts({ rectangleTool: 'b', polylineFinish: 'f' });

      expect(createdTools).toHaveLength(2);
      expect(activate).toHaveBeenCalledTimes(2);
      const shortcuts = activate.mock.calls[1]![3] as KeyboardShortcutMap;
      expect(shortcuts.polylineFinish).toBe('f');
    });

    it('vertexMarkers', () => {
      const h = setup();
      h.setMarkers({ radius: 9 });

      expect(createdTools).toHaveLength(2);
      expect(createdTools[1]!.options).toMatchObject({ vertexMarkers: { radius: 9 } });
    });

    it('vertexEditLongPressMs', () => {
      const h = setup();
      h.setLongPress(900);

      expect(createdTools).toHaveLength(2);
      expect(createdTools[1]!.options).toMatchObject({
        vertexEdit: { longPressMs: 900, moveTolerancePx: 6 },
      });
    });

    it('vertexEditMoveTolerancePx', () => {
      const h = setup();
      h.setTolerance(12);

      expect(createdTools).toHaveLength(2);
      expect(createdTools[1]!.options).toMatchObject({
        vertexEdit: { longPressMs: 500, moveTolerancePx: 12 },
      });
    });

    it('deactivates the tool it replaces', () => {
      const h = setup();
      const first = createdTools[0]!.tool;
      const deactivate = vi.spyOn(first, 'deactivate');
      h.setMarkers({ radius: 9 });
      expect(deactivate).toHaveBeenCalledTimes(1);
    });
  });

  it('canAddAnnotation sees an annotation added earlier in the same batch (#217)', () => {
    // The parity case for React's "the tool sees writes made earlier in the
    // same task": a tool adds an annotation and asks whether another is
    // allowed within one pointer event. Solid's memo is read fresh inside a
    // batch; React's callbacks read its store for the same reason.
    const h = setup();
    h.annotator.actions.setContexts([
      {
        id: contextId,
        label: 'Test',
        tools: [{ type: 'polyline' }, { type: 'rectangle', maxCount: 1 }],
      },
    ]);
    expect(activate).toHaveBeenCalled();
    const callbacks = activate.mock.calls.at(-1)![2] as ToolCallbacks;
    expect(callbacks.canAddAnnotation('rectangle')).toBe(true);

    let canAdd: boolean | undefined;
    batch(() => {
      h.annotator.actions.addAnnotation({
        id: createAnnotationId('r1'),
        imageId,
        contextId,
        toolType: 'rectangle',
        geometry: { type: 'rectangle', origin: { x: 0, y: 0 }, width: 10, height: 10, rotation: 0 },
        rawAnnotationData: {
          format: 'fabric',
          fabricVersion: FABRIC_VERSION,
          data: { type: 'Rect', left: 0, top: 0, width: 10, height: 10 },
        },
      });
      canAdd = callbacks.canAddAnnotation('rectangle');
    });

    expect(canAdd).toBe(false);
  });

  it('stays on the brush at its limit while a mask it can refine is selected (#154)', () => {
    // The limit used to switch the brush off and the tool to select the moment
    // the first mask committed, so a context limited to n masks could paint
    // them but never refine them. The brush stays enabled while the selection
    // is a mask it can refine; it may still not start another.
    const h = setup();
    h.annotator.actions.setContexts([
      { id: contextId, label: 'Test', tools: [{ type: 'segmentationBrush', maxCount: 1 }] },
    ]);
    h.annotator.actions.setActiveTool('segmentationBrush');
    expect(activate).toHaveBeenCalled();
    const callbacks = activate.mock.calls.at(-1)![2] as ToolCallbacks;
    expect(callbacks.canAddAnnotation('segmentationBrush')).toBe(true);

    const buffer = new BoundedDenseMaskBuffer({ imageWidth: 100, imageHeight: 100 });
    buffer.set(5, 5, 1);
    const mask = createMaskAnnotation(buffer.snapshot(), {
      id: createAnnotationId('m1'),
      imageId,
      contextId,
    });
    batch(() => {
      h.annotator.actions.addAnnotation(mask);
      h.annotator.actions.setSelectedAnnotation(mask.id);
    });
    expect(h.annotator.uiState.activeTool).toBe('segmentationBrush');
    expect(h.annotator.constraintStatus().segmentationBrush.enabled).toBe(true);
    expect(callbacks.canAddAnnotation('segmentationBrush')).toBe(false);

    // With nothing refinable selected it is a tool at its limit like any other.
    h.annotator.actions.setSelectedAnnotation(null);
    expect(h.annotator.uiState.activeTool).toBe('select');
  });

  it('the keyboard follows a changed binding without remounting', () => {
    const h = setup();
    const press = (key: string) =>
      window.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));

    press('b');
    expect(h.annotator.uiState.activeTool).toBe('rectangle');

    h.annotator.actions.setActiveTool('polyline');
    h.setShortcuts({ rectangleTool: 'j' });

    press('b');
    expect(h.annotator.uiState.activeTool).toBe('polyline');
    press('j');
    expect(h.annotator.uiState.activeTool).toBe('rectangle');
  });
});

describe('the brush config names the bound New mask key (m19)', () => {
  afterEach(() => {
    dispose?.();
    dispose = undefined;
  });

  it("in a capacity failure while refining, from the provider's shortcut map", () => {
    createdTools.length = 0;
    const reported: BrushCapacityError[] = [];
    const overlay = makeOverlay();
    const buffer = new BoundedDenseMaskBuffer({ imageWidth: 100, imageHeight: 100 });
    buffer.set(10, 10, 1);
    const mask = createMaskAnnotation(buffer.raster(), {
      id: createAnnotationId('m1'),
      imageId,
      contextId,
    });
    createRoot((d) => {
      dispose = d;
      createComponent(AnnotatorProvider, {
        keyboardShortcuts: { newMask: 'm' },
        brushOptions: { onCapacityExceeded: (error) => reported.push(error) },
        get children() {
          untrack(() => {
            const annotator = useAnnotator();
            annotator.actions.setContexts([
              { id: contextId, label: 'Test', tools: [{ type: 'segmentationBrush' }] },
            ]);
            annotator.actions.setActiveContext(contextId);
            annotator.actions.assignImageToCell(0, imageId);
            annotator.actions.addAnnotation(mask);
            annotator.actions.setSelectedAnnotation(mask.id);
            annotator.actions.setActiveTool('segmentationBrush');
            useAnnotationTool(
              () => overlay,
              () => imageId,
              () => true,
            );
          });
          return null;
        },
      });
    });

    const built = createdTools.at(-1);
    expect(built).toBeDefined();
    const config = (built!.options as { segmentationBrush: SegmentationBrushToolConfig })
      .segmentationBrush;
    // A refining stroke resolves its target first; then the cap is hit.
    expect(config.getTarget()?.annotationId).toBe(mask.id);
    config.onCapacityExceeded!(new MaskCapacityExceededError(100, 50));
    expect(reported).toHaveLength(1);
    expect(reported[0]!.message).toMatch(/Start a separate mask with New mask \(m\)\.$/);
  });

  it('not when the context is at its limit, where New mask cannot help (#149 minor 10)', () => {
    createdTools.length = 0;
    const reported: BrushCapacityError[] = [];
    const overlay = makeOverlay();
    const buffer = new BoundedDenseMaskBuffer({ imageWidth: 100, imageHeight: 100 });
    buffer.set(10, 10, 1);
    const mask = createMaskAnnotation(buffer.raster(), {
      id: createAnnotationId('m1'),
      imageId,
      contextId,
    });
    createRoot((d) => {
      dispose = d;
      createComponent(AnnotatorProvider, {
        keyboardShortcuts: { newMask: 'm' },
        brushOptions: { onCapacityExceeded: (error) => reported.push(error) },
        get children() {
          untrack(() => {
            const annotator = useAnnotator();
            annotator.actions.setContexts([
              {
                id: contextId,
                label: 'Test',
                tools: [{ type: 'segmentationBrush', maxCount: 1 }],
              },
            ]);
            annotator.actions.setActiveContext(contextId);
            annotator.actions.assignImageToCell(0, imageId);
            annotator.actions.addAnnotation(mask);
            annotator.actions.setSelectedAnnotation(mask.id);
            annotator.actions.setActiveTool('segmentationBrush');
            useAnnotationTool(
              () => overlay,
              () => imageId,
              () => true,
            );
          });
          return null;
        },
      });
    });

    const built = createdTools.at(-1);
    expect(built).toBeDefined();
    const config = (built!.options as { segmentationBrush: SegmentationBrushToolConfig })
      .segmentationBrush;
    // A refining stroke resolves its target first; then the cap is hit.
    expect(config.getTarget()?.annotationId).toBe(mask.id);
    config.onCapacityExceeded!(new MaskCapacityExceededError(100, 50));
    expect(reported).toHaveLength(1);
    // The one allowed mask exists, so New mask is disabled: the default
    // advice stays, without pointing to it.
    expect(reported[0]!.message).not.toMatch(/New mask/);
    expect(reported[0]!.message).toMatch(/Paint a smaller region/);
  });
});

describe("the provider's brush options", () => {
  afterEach(() => {
    dispose?.();
    dispose = undefined;
  });

  it('hand on the display budget, and a change to it is observed', () => {
    const [budget, setBudget] = createSignal<number | undefined>(1_000);
    const seen: (number | undefined)[] = [];
    createRoot((d) => {
      dispose = d;
      createComponent(AnnotatorProvider, {
        get brushOptions() {
          return { maxCanvasPixels: budget() };
        },
        get children() {
          untrack(() => {
            const { brushOptions } = useAnnotator();
            // How `ViewerCell`'s rebuild reads it: tracked, inside an effect.
            createRenderEffect(() => seen.push(brushOptions.maxCanvasPixels));
          });
          return null;
        },
      });
    });
    expect(seen).toEqual([1_000]);
    setBudget(2_000);
    expect(seen).toEqual([1_000, 2_000]);
  });
});

describe('coarsening through the provider (step 6)', () => {
  afterEach(() => {
    dispose?.();
    dispose = undefined;
  });

  /** A brush on one cell, its options and the active context's tools from signals. */
  function mountBrush(initial: {
    readonly options: BrushOptions;
    readonly maxDownsample?: number;
  }) {
    createdTools.length = 0;
    const [options, setOptions] = createSignal<BrushOptions>(initial.options);
    let annotator: ReturnType<typeof useAnnotator> | undefined;
    const overlay = makeOverlay();
    const contextsWith = (maxDownsample: number | undefined) => [
      {
        id: contextId,
        label: 'Test',
        tools: [
          {
            type: 'segmentationBrush' as const,
            ...(maxDownsample !== undefined ? { brush: { maxDownsample } } : {}),
          },
        ],
      },
    ];
    createRoot((d) => {
      dispose = d;
      createComponent(AnnotatorProvider, {
        get brushOptions() {
          return options();
        },
        get children() {
          untrack(() => {
            annotator = useAnnotator();
            annotator.actions.setContexts(contextsWith(initial.maxDownsample));
            annotator.actions.setActiveContext(contextId);
            annotator.actions.assignImageToCell(0, imageId);
            annotator.actions.setActiveTool('segmentationBrush');
            useAnnotationTool(
              () => overlay,
              () => imageId,
              () => true,
            );
          });
          return null;
        },
      });
    });
    const built = createdTools.at(-1);
    expect(built).toBeDefined();
    const config = (built!.options as { segmentationBrush: SegmentationBrushToolConfig })
      .segmentationBrush;
    return {
      config,
      setOptions,
      setMaxDownsample: (value: number | undefined) =>
        annotator!.actions.setContexts(contextsWith(value)),
    };
  }

  /** A coarsened commit for a new mask: d=2, from d=1. */
  const coarsenedCommit = () => {
    const buffer = new BoundedDenseMaskBuffer({ imageWidth: 100, imageHeight: 100, downsample: 2 });
    buffer.set(10, 10, 1);
    return {
      annotationId: null,
      imageId,
      contextId,
      snapshot: buffer.raster(),
      startDownsample: 1,
    };
  };

  it("uses the provider's strategy, and a changed one without rebuilding the tool", () => {
    const first: CoarsenStrategy = (source) => majorityCoarsen(source);
    const second: CoarsenStrategy = (source) => majorityCoarsen(source);
    const h = mountBrush({ options: { coarsen: first } });
    expect(h.config.getCoarsenStrategy!()).toBe(first);
    const builds = createdTools.length;
    h.setOptions({ coarsen: second });
    expect(createdTools.length).toBe(builds);
    expect(h.config.getCoarsenStrategy!()).toBe(second);
    h.setOptions({});
    expect(h.config.getCoarsenStrategy!()).toBe(majorityCoarsen);
    expect(createdTools.length).toBe(builds);
    // The cap is what the tool is built with: changing it does rebuild.
    h.setOptions({ maxPixels: 500 });
    expect(createdTools.length).toBe(builds + 1);
  });

  it('calls onCoarsen through, and a changed one without rebuilding the tool', () => {
    const first = vi.fn();
    const second = vi.fn();
    const h = mountBrush({ options: { onCoarsen: first } });
    h.config.onCommit(coarsenedCommit());
    expect(first).toHaveBeenCalledWith(expect.objectContaining({ from: 1, to: 2, imageId }));
    const builds = createdTools.length;
    h.setOptions({ onCoarsen: second });
    expect(createdTools.length).toBe(builds);
    h.config.onCommit(coarsenedCommit());
    expect(second).toHaveBeenCalledOnce();
    expect(first).toHaveBeenCalledOnce();
  });

  it("reads maxDownsample from the active context's brush constraint at each press", () => {
    const h = mountBrush({ options: {}, maxDownsample: 8 });
    expect(h.config.getMaxDownsample!()).toBe(8);
    h.setMaxDownsample(4);
    expect(h.config.getMaxDownsample!()).toBe(4);
    h.setMaxDownsample(undefined);
    expect(h.config.getMaxDownsample!()).toBe(1);
  });
});
