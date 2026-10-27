import { describe, it, expect, vi } from 'vitest';
import { FabricImage, FabricObject, Rect } from 'fabric';
import { createImageId } from '@osdlabel/viewer-api';
import { createAnnotationContextId } from '@osdlabel/annotation-context';
import { MASK_RAW_FORMAT, createAnnotationId } from '@osdlabel/annotation';
import {
  BoundedDenseMaskBuffer,
  DEFAULT_MAX_MASK_PIXELS,
  MaskCapacityExceededError,
  emptySnapshot,
  encodeCanonical,
  runRaster,
  snapshotImageBox,
  snapshotPixelCount,
  majorityCoarsen,
  stampCircle,
  toDenseSnapshot,
  type CoarsenStrategy,
  type MaskRaster,
  type MaskRegion,
} from '@osdlabel/mask';
import { SegmentationBrushTool } from '../../../src/tools/segmentation-brush-tool.js';
import { buildMaskFabricObject } from '../../../src/mask-fabric-object.js';
import type {
  BrushStrokeCommit,
  BrushTarget,
  BrushTargetPreview,
  SegmentationBrushToolConfig,
} from '../../../src/tools/segmentation-brush-tool.js';
import type { ToolOverlay } from '../../../src/types.js';
import {
  MAX_MASK_CANVAS_PIXELS,
  MAX_MASK_CANVAS_SIDE,
  MaskCanvasTooLargeError,
  type BrushCapacityError,
} from '../../../src/mask-canvas-limit.js';
import type { ToolCallbacks } from '../../../src/tools/base-tool.js';
import { createTestKeyboardShortcuts } from '../test-helpers.js';

const imageId = createImageId('test-image');
const contextId = createAnnotationContextId('test-context');
const shortcuts = createTestKeyboardShortcuts();
const IMAGE = { width: 400, height: 300 } as const;

/** A painted snapshot to stand in for an existing mask. */
function paintedSnapshot(radius = 6): MaskRaster {
  const buffer = new BoundedDenseMaskBuffer({
    imageWidth: IMAGE.width,
    imageHeight: IMAGE.height,
  });
  stampCircle(buffer, 100.5, 80.5, radius, 1);
  return buffer.raster();
}

interface Harness {
  readonly tool: SegmentationBrushTool;
  readonly callbacks: ToolCallbacks;
  readonly objects: FabricObject[];
  readonly commits: BrushStrokeCommit[];
  readonly capacityErrors: BrushCapacityError[];
  readonly radiusAdjustments: (1 | -1)[];
  /** Releases the stand-in overlay reports as ending a cancelled press. */
  readonly cancelledReleases: WeakSet<PointerEvent>;
  readonly canvas: {
    on: ReturnType<typeof vi.fn>;
    off: ReturnType<typeof vi.fn>;
    add: ReturnType<typeof vi.fn>;
    remove: ReturnType<typeof vi.fn>;
    bringObjectToFront: ReturnType<typeof vi.fn>;
  };
  /** Sets the stand-in canvas's zoom, as a Ctrl/Cmd scroll would, with no pointer move. */
  setZoom(zoom: number): void;
  /** Runs the canvas's `before:render` listeners, as a render would. */
  render(): void;
}

function harness(
  options: {
    readonly target?: BrushTarget | null;
    readonly canAdd?: boolean;
    readonly imageSize?: { width: number; height: number } | null;
    readonly maxPixels?: number;
    readonly erasing?: boolean;
    readonly radius?: number;
    readonly existingObjects?: FabricObject[];
    readonly activeObjects?: FabricObject[];
    /** The host's answer to "refine or create?", for the cursor cue. */
    readonly peekTarget?: () => BrushTargetPreview | null;
    /** Runs on every commit, after it is recorded; stands in for the host's rebuild. */
    readonly onCommit?: (commit: BrushStrokeCommit) => void;
    /**
     * A viewport for the stand-in canvas: a uniform zoom and the canvas size
     * in screen pixels. Without one the canvas reports none, and a new mask
     * starts at downsample 1, as before downsampling existed.
     */
    readonly viewport?: { readonly zoom: number; readonly width: number; readonly height: number };
    /** The context's `maxDownsample`; absent, the tool never coarsens. */
    readonly maxDownsample?: number;
    /** The coarsen strategy; absent, the built-in one. */
    readonly coarsen?: CoarsenStrategy;
  } = {},
): Harness {
  const objects: FabricObject[] = [...(options.existingObjects ?? [])];
  const commits: BrushStrokeCommit[] = [];
  const capacityErrors: BrushCapacityError[] = [];
  const radiusAdjustments: (1 | -1)[] = [];

  let zoom = options.viewport?.zoom ?? 1;
  const beforeRender = new Set<() => void>();
  const canvas = {
    on: vi.fn((event: string, handler: () => void) => {
      if (event === 'before:render') beforeRender.add(handler);
    }),
    off: vi.fn((event: string, handler: () => void) => {
      if (event === 'before:render') beforeRender.delete(handler);
    }),
    add: vi.fn((...added: FabricObject[]) => objects.push(...added)),
    remove: vi.fn((...removed: FabricObject[]) => {
      for (const obj of removed) {
        const at = objects.indexOf(obj);
        if (at >= 0) objects.splice(at, 1);
      }
    }),
    getObjects: () => objects,
    // `paint` mode discards the selection and makes every object inert, so an
    // empty active set is the *normal* state while the brush is in use.
    getActiveObjects: () => [...(options.activeObjects ?? [])],
    discardActiveObject: vi.fn(),
    bringObjectToFront: vi.fn(),
    requestRenderAll: vi.fn(),
    getZoom: () => zoom,
    ...(options.viewport
      ? {
          viewportTransform: [options.viewport.zoom, 0, 0, options.viewport.zoom, 0, 0],
          getWidth: () => options.viewport!.width,
          getHeight: () => options.viewport!.height,
        }
      : {}),
  };

  const config: SegmentationBrushToolConfig = {
    getBrushRadius: () => options.radius ?? 5,
    getImageSize: () => (options.imageSize === undefined ? IMAGE : options.imageSize),
    getTarget: () => options.target ?? null,
    onCommit: (commit) => {
      commits.push(commit);
      options.onCommit?.(commit);
    },
    isErasing: () => options.erasing ?? false,
    onAdjustRadius: (direction) => radiusAdjustments.push(direction),
    onCapacityExceeded: (error) => capacityErrors.push(error),
    ...(options.maxPixels !== undefined ? { maxPixels: options.maxPixels } : {}),
    ...(options.peekTarget !== undefined ? { peekTarget: options.peekTarget } : {}),
    ...(options.maxDownsample !== undefined
      ? { getMaxDownsample: () => options.maxDownsample! }
      : {}),
    ...(options.coarsen !== undefined ? { getCoarsenStrategy: () => options.coarsen! } : {}),
  };

  const callbacks: ToolCallbacks = {
    getActiveContextId: () => contextId,
    getToolConstraint: (type) => ({ type }),
    canAddAnnotation: () => options.canAdd ?? true,
    addAnnotation: vi.fn(),
    updateAnnotation: vi.fn(),
    deleteAnnotation: vi.fn(),
    setSelectedAnnotation: vi.fn(),
    getAnnotation: vi.fn().mockReturnValue(undefined),
  };

  const cancelledReleases = new WeakSet<PointerEvent>();
  const overlay = {
    canvas,
    isCancelledRelease: (event: PointerEvent) => cancelledReleases.has(event),
  };
  const tool = new SegmentationBrushTool(config);
  tool.activate(overlay as unknown as ToolOverlay, imageId, callbacks, shortcuts);

  return {
    tool,
    callbacks,
    objects,
    commits,
    capacityErrors,
    radiusAdjustments,
    cancelledReleases,
    canvas,
    setZoom: (next) => {
      zoom = next;
    },
    render: () => {
      for (const handler of [...beforeRender]) handler();
    },
  };
}

const down = (tool: SegmentationBrushTool, x: number, y: number, alt = false) =>
  tool.onPointerDown({ altKey: alt } as PointerEvent, { x, y });
const move = (tool: SegmentationBrushTool, x: number, y: number) =>
  tool.onPointerMove({} as PointerEvent, { x, y });
const up = (tool: SegmentationBrushTool, x: number, y: number) =>
  tool.onPointerUp({} as PointerEvent, { x, y });

/** A committed annotation object, as `ViewerCell` would have added it. */
function committedObject(id: string): FabricObject {
  const rect = new Rect({ left: 0, top: 0, width: 10, height: 10 });
  rect.id = createAnnotationId(id);
  return rect;
}

/**
 * Reconstructs the preview canvas by replaying `putImageData` into a backing
 * store, so a test can ask what the user would actually see mid-stroke.
 */
function capturePreview() {
  const store = { pixels: new Uint8ClampedArray(0), width: 0, height: 0 };
  const realCreate = document.createElement.bind(document);
  const spy = vi.spyOn(document, 'createElement').mockImplementation(((tag: string) => {
    const el = realCreate(tag) as HTMLCanvasElement;
    if (tag === 'canvas') {
      el.getContext = (() =>
        ({
          createImageData: (w: number, h: number) => ({
            width: w,
            height: h,
            data: new Uint8ClampedArray(w * h * 4),
          }),
          putImageData: (
            img: ImageData,
            _x: number,
            _y: number,
            dx?: number,
            dy?: number,
            dw?: number,
            dh?: number,
          ) => {
            if (store.width !== img.width || store.height !== img.height) {
              store.width = img.width;
              store.height = img.height;
              store.pixels = new Uint8ClampedArray(img.width * img.height * 4);
            }
            if (dx === undefined) {
              store.pixels.set(img.data);
              return;
            }
            for (let row = dy!; row < dy! + dh!; row++) {
              const at = (row * img.width + dx) * 4;
              store.pixels.set(img.data.subarray(at, at + dw! * 4), at);
            }
          },
        }) as unknown as CanvasRenderingContext2D) as unknown as typeof el.getContext;
    }
    return el;
  }) as typeof document.createElement);

  return {
    opaquePixels: () => {
      let n = 0;
      for (let i = 3; i < store.pixels.length; i += 4) if (store.pixels[i]! > 0) n++;
      return n;
    },
    restore: () => spy.mockRestore(),
  };
}

describe('SegmentationBrushTool: committing a stroke', () => {
  it('commits the painted pixels on pointer up, and nothing before', () => {
    const h = harness();

    down(h.tool, 50, 50);
    move(h.tool, 60, 50);
    expect(h.commits).toHaveLength(0);

    up(h.tool, 60, 50);
    expect(h.commits).toHaveLength(1);
    const commit = h.commits[0]!;
    expect(commit.annotationId).toBeNull();
    expect(commit.imageId).toBe(imageId);
    expect(commit.contextId).toBe(contextId);
    expect(snapshotPixelCount(commit.snapshot)).toBeGreaterThan(0);
  });

  it('reports the target id when refining, so the host updates in place', () => {
    const snapshot = paintedSnapshot();
    const h = harness({
      target: { annotationId: createAnnotationId('mask-1'), snapshot },
    });

    // Beside the painted disc, so the stroke changes cells.
    down(h.tool, 110, 80);
    up(h.tool, 110, 80);

    expect(h.commits[0]!.annotationId).toBe('mask-1');
    // The stroke adds to what was there rather than replacing it.
    expect(snapshotPixelCount(h.commits[0]!.snapshot)).toBeGreaterThanOrEqual(
      snapshotPixelCount(snapshot),
    );
  });

  it('erases with Alt held, shrinking the mask', () => {
    const snapshot = paintedSnapshot(10);
    const before = snapshotPixelCount(snapshot);
    const h = harness({
      target: { annotationId: createAnnotationId('mask-1'), snapshot },
      radius: 4,
    });

    down(h.tool, 100, 80, true);
    up(h.tool, 100, 80);

    expect(snapshotPixelCount(h.commits[0]!.snapshot)).toBeLessThan(before);
  });

  it('erases with the host toggle, without a modifier', () => {
    const snapshot = paintedSnapshot(10);
    const before = snapshotPixelCount(snapshot);
    const h = harness({
      target: { annotationId: createAnnotationId('mask-1'), snapshot },
      erasing: true,
      radius: 4,
    });

    down(h.tool, 100, 80);
    up(h.tool, 100, 80);

    expect(snapshotPixelCount(h.commits[0]!.snapshot)).toBeLessThan(before);
  });

  it('refuses to start a new mask when the tool is at its limit', () => {
    const h = harness({ canAdd: false });
    down(h.tool, 50, 50);
    up(h.tool, 50, 50);
    expect(h.commits).toHaveLength(0);
  });

  it('still refines an existing mask at the limit, since that adds no annotation', () => {
    const h = harness({
      canAdd: false,
      target: { annotationId: createAnnotationId('mask-1'), snapshot: paintedSnapshot() },
    });
    down(h.tool, 110, 80);
    up(h.tool, 110, 80);
    expect(h.commits).toHaveLength(1);
  });

  it('commits nothing for a stroke that changes no cell', () => {
    // Painting over paint, and erasing where there is none: the mask is
    // unchanged, so there is nothing to re-encode or mark updated.
    const existing = committedObject('mask-1');
    const painted = harness({
      target: { annotationId: createAnnotationId('mask-1'), snapshot: paintedSnapshot() },
      existingObjects: [existing],
    });
    down(painted.tool, 100, 80);
    up(painted.tool, 100, 80);
    expect(painted.commits).toHaveLength(0);
    // The committed mask hidden for the stroke is shown again.
    expect(existing.visible).not.toBe(false);

    const erasing = harness({
      erasing: true,
      target: { annotationId: createAnnotationId('mask-1'), snapshot: paintedSnapshot() },
    });
    down(erasing.tool, 250, 200);
    move(erasing.tool, 280, 200);
    up(erasing.tool, 280, 200);
    expect(erasing.commits).toHaveLength(0);

    // A tap beside the disc adds cells, so it does commit.
    const touched = harness({
      target: { annotationId: createAnnotationId('mask-1'), snapshot: paintedSnapshot() },
    });
    down(touched.tool, 120, 80);
    up(touched.tool, 120, 80);
    expect(touched.commits).toHaveLength(1);
  });

  it('does nothing until the image size is known', () => {
    const h = harness({ imageSize: null });
    down(h.tool, 50, 50);
    up(h.tool, 50, 50);
    expect(h.commits).toHaveLength(0);
  });
});

describe('SegmentationBrushTool: the commit carries its preview', () => {
  it('pixel for pixel what the renderer draws from the committed payload', () => {
    for (const target of [
      null,
      { annotationId: createAnnotationId('m'), snapshot: paintedSnapshot(9) },
    ]) {
      const h = harness({ target, radius: 7 });
      down(h.tool, 60, 50);
      move(h.tool, 140, 90);
      up(h.tool, 140, 90);
      expect(h.commits).toHaveLength(1);
      const commit = h.commits[0]!;
      expect(commit.preview).toBeDefined();
      const { crop, fill } = commit.preview!;
      const canvas = crop();
      expect(canvas).not.toBeNull();
      // Cropped once, then reused.
      expect(crop()).toBe(canvas);
      const cells = commit.snapshot.cells;
      expect([canvas!.width, canvas!.height]).toEqual([cells.width, cells.height]);

      const rendered = buildMaskFabricObject(
        { format: MASK_RAW_FORMAT, data: { ...encodeCanonical(commit.snapshot), fill } },
        { id: 'x' },
      ) as FabricImage;
      const expected = (rendered.getElement() as HTMLCanvasElement)
        .getContext('2d')!
        .getImageData(0, 0, cells.width, cells.height).data;
      const actual = canvas!.getContext('2d')!.getImageData(0, 0, cells.width, cells.height).data;
      // Compared on alpha and on the colour of painted pixels: a clear pixel
      // is transparent in both, whatever colour channels it carries.
      for (let i = 0; i < expected.length; i += 4) {
        expect(actual[i + 3], `alpha at ${i / 4}`).toBe(expected[i + 3]);
        if (expected[i + 3]! > 0) {
          expect([actual[i], actual[i + 1], actual[i + 2]]).toEqual([
            expected[i],
            expected[i + 1],
            expected[i + 2],
          ]);
        }
      }
    }
  });

  /** Refuses a 2D context to every canvas with a side past `side`, as an engine past its limit does. */
  function refuseCanvasesPast(side: number) {
    const realCreate = document.createElement.bind(document);
    return vi.spyOn(document, 'createElement').mockImplementation(((tag: string) => {
      const el = realCreate(tag) as HTMLCanvasElement;
      if (tag === 'canvas') {
        const getContext = el.getContext.bind(el);
        el.getContext = ((kind: string) =>
          el.width > side || el.height > side
            ? null
            : getContext(kind as '2d')) as unknown as typeof el.getContext;
      }
      return el;
    }) as typeof document.createElement);
  }

  it('is absent when the engine refused the preview, rather than a blank crop (#243 P4, minor 16)', () => {
    // The preview canvas past 4,000 px is refused; the small crop would not
    // be. Cropping the refused canvas gave a fully transparent preview, and the
    // cell was seeded with an invisible mask. The commit still lands.
    const spy = refuseCanvasesPast(4_000);
    try {
      const h = harness({ imageSize: { width: 20_000, height: 200 }, radius: 5 });
      down(h.tool, 1_000, 100);
      move(h.tool, 4_500, 100);
      up(h.tool, 4_500, 100);
      expect(h.commits).toHaveLength(1);
      expect(h.commits[0]!.snapshot.cellCount).toBeGreaterThan(0);
      expect(h.commits[0]!.preview).toBeUndefined();
    } finally {
      spy.mockRestore();
    }
  });

  it('names the fill its pixels were drawn in, not the one at the release (#243 minor 11)', () => {
    let fill = 'rgba(255, 0, 0, 0.5)';
    const h = harness({ radius: 5 });
    (h.tool as unknown as { config: { getFill: () => string } }).config.getFill = () => fill;
    down(h.tool, 60, 50);
    fill = 'rgba(0, 0, 255, 0.5)';
    move(h.tool, 90, 50);
    up(h.tool, 90, 50);
    expect(h.commits[0]!.preview!.fill).toBe('rgba(255, 0, 0, 0.5)');
  });
});

describe('SegmentationBrushTool: cancelling', () => {
  it('does not let Delete through while a stroke is open', () => {
    // The host's Delete removes the selected annotation, which is the mask
    // being refined: the release would then have nothing to commit into.
    const h = harness({
      target: { annotationId: createAnnotationId('m1'), snapshot: paintedSnapshot() },
    });
    down(h.tool, 110, 80);
    expect(h.tool.onKeyDown({ key: 'Delete' } as KeyboardEvent)).toBe(true);
    expect(h.tool.onKeyDown({ key: 'Backspace' } as KeyboardEvent)).toBe(true);
    up(h.tool, 110, 80);
    expect(h.commits).toHaveLength(1);
  });

  it('lets Shift with the New mask key through mid-stroke, as another shortcut (#149 minor 9)', () => {
    // Shift+N is toggleNegative in the keyboard map; only a plain N is New mask.
    const h = harness({
      target: { annotationId: createAnnotationId('m1'), snapshot: paintedSnapshot() },
    });
    down(h.tool, 100, 80);
    expect(h.tool.onKeyDown({ key: 'N', shiftKey: true } as KeyboardEvent)).toBe(false);
    expect(h.tool.onKeyDown({ key: 'n', shiftKey: false } as KeyboardEvent)).toBe(true);
    up(h.tool, 100, 80);
  });

  it('discards the stroke on Escape and commits nothing', () => {
    const h = harness();

    down(h.tool, 50, 50);
    move(h.tool, 70, 50);
    const consumed = h.tool.onKeyDown({ key: 'Escape' } as KeyboardEvent);

    expect(consumed).toBe(true);
    expect(h.commits).toHaveLength(0);

    // And the pointer-up that follows the cancel must not commit either.
    up(h.tool, 70, 50);
    expect(h.commits).toHaveLength(0);
  });

  it('leaves Escape to the global handler when not painting', () => {
    const h = harness();
    expect(h.tool.onKeyDown({ key: 'Escape' } as KeyboardEvent)).toBe(false);
  });

  it('removes the live preview when a stroke ends, however it ends', () => {
    const committed = harness();
    down(committed.tool, 50, 50);
    move(committed.tool, 70, 50);
    expect(committed.objects.length).toBeGreaterThan(0);
    up(committed.tool, 70, 50);
    expect(committed.objects.filter((o) => o.type === 'image')).toHaveLength(0);

    const cancelled = harness();
    down(cancelled.tool, 50, 50);
    move(cancelled.tool, 70, 50);
    cancelled.tool.cancel();
    expect(cancelled.objects.filter((o) => o.type === 'image')).toHaveLength(0);
  });
});

describe('SegmentationBrushTool: the committed object it hides while painting', () => {
  it('hides the mask being refined, so the preview is not double-drawn', () => {
    const existing = committedObject('mask-1');
    const h = harness({
      target: { annotationId: createAnnotationId('mask-1'), snapshot: paintedSnapshot() },
      existingObjects: [existing],
    });

    down(h.tool, 100, 80);
    expect(existing.visible).toBe(false);
  });

  it('restores it on commit, on cancel, and on deactivate', () => {
    for (const finish of [
      (h: Harness) => up(h.tool, 100, 80),
      (h: Harness) => h.tool.cancel(),
      (h: Harness) => h.tool.deactivate(),
    ]) {
      const existing = committedObject('mask-1');
      const h = harness({
        target: { annotationId: createAnnotationId('mask-1'), snapshot: paintedSnapshot() },
        existingObjects: [existing],
      });

      down(h.tool, 100, 80);
      expect(existing.visible).toBe(false);
      finish(h);
      // Nothing else ever brings it back, so a stroke that ends any other way
      // would leave the mask invisible until the next state change.
      expect(existing.visible).toBe(true);
    }
  });

  it('leaves other annotations alone', () => {
    const other = committedObject('rect-1');
    const h = harness({
      target: { annotationId: createAnnotationId('mask-1'), snapshot: paintedSnapshot() },
      existingObjects: [other],
    });

    down(h.tool, 100, 80);
    expect(other.visible).not.toBe(false);
  });
});

describe('SegmentationBrushTool: capacity', () => {
  it('reports a stroke that would exceed the cap, and commits nothing', () => {
    const h = harness({ maxPixels: 64 * 64, radius: 120 });

    down(h.tool, 200, 150);
    up(h.tool, 200, 150);

    expect(h.capacityErrors).toHaveLength(1);
    expect(h.capacityErrors[0]).toBeInstanceOf(MaskCapacityExceededError);
    expect(h.commits).toHaveLength(0);
  });

  it('reports a target that is too large to load, rather than throwing', () => {
    // Loading an existing mask allocates too, and used to escape uncaught into
    // Fabric's event dispatch with the host never told.
    const big = new BoundedDenseMaskBuffer({ imageWidth: 4096, imageHeight: 4096 });
    stampCircle(big, 2048, 2048, 900, 1);
    const h = harness({
      target: { annotationId: createAnnotationId('mask-1'), snapshot: big.raster() },
      maxPixels: 64 * 64,
    });

    expect(() => down(h.tool, 2048, 2048)).not.toThrow();
    expect(h.capacityErrors).toHaveLength(1);
    expect(h.commits).toHaveLength(0);
  });

  it('reports a target that cannot even be resolved, rather than throwing', () => {
    // `getTarget` decodes the mask being refined, so it can hit the cap too.
    // Outside the stroke's error handling it escaped into Fabric's dispatch on
    // every pointer-down over that mask, with the host never told.
    const h = harness({ maxPixels: 64 * 64 });
    const config = (h.tool as unknown as { config: { getTarget: () => unknown } }).config;
    config.getTarget = () => {
      throw new MaskCapacityExceededError(1_000_000, 4096);
    };

    expect(() => down(h.tool, 50, 50)).not.toThrow();
    expect(h.capacityErrors).toHaveLength(1);
    expect(h.commits).toHaveLength(0);
  });

  it('ignores an unusable pixel cap instead of letting the buffer reject it', () => {
    // The buffer raises a plain RangeError for a non-positive or non-finite
    // cap — not the MaskCapacityExceededError a stroke knows how to abandon —
    // so a bad value escaped the same way. Falling back to the default cap is
    // how the tool treats every other unusable input.
    for (const maxPixels of [Number.NaN, -1, 0]) {
      const h = harness({ maxPixels });
      expect(() => down(h.tool, 50, 50)).not.toThrow();
      up(h.tool, 50, 50);
      expect(h.commits).toHaveLength(1);
    }
  });

  it('clamps a cap above the format cap to the format cap', () => {
    // A 9,020-square stroke box is 81 M cells: inside a host's 100 M, past the
    // format's 64 Mi. Painting it would leave a mask no encoder writes.
    const h = harness({
      imageSize: { width: 10_000, height: 10_000 },
      maxPixels: 100_000_000,
      radius: 10,
    });
    down(h.tool, 500, 500);
    move(h.tool, 9500, 9500);
    up(h.tool, 9500, 9500);

    expect(h.capacityErrors).toHaveLength(1);
    const error = h.capacityErrors[0];
    expect(error).toBeInstanceOf(MaskCapacityExceededError);
    expect((error as MaskCapacityExceededError).maxCells).toBe(DEFAULT_MAX_MASK_PIXELS);
    expect(h.commits).toHaveLength(0);
  });

  it('refuses a stroke too wide for any canvas to draw, through onCapacityExceeded', () => {
    // 40,000 x 11 cells is far inside the cell cap, but no browser draws a
    // canvas that wide: the stroke would paint nothing visible.
    const h = harness({ imageSize: { width: 50_000, height: 200 }, radius: 5 });
    down(h.tool, 100, 100);
    move(h.tool, 40_000, 100);
    up(h.tool, 40_000, 100);

    expect(h.capacityErrors).toHaveLength(1);
    const error = h.capacityErrors[0];
    expect(error).toBeInstanceOf(MaskCanvasTooLargeError);
    expect((error as MaskCanvasTooLargeError).width).toBeGreaterThan(MAX_MASK_CANVAS_SIDE);
    expect(h.commits).toHaveLength(0);
  });

  it('refines a mask just under the canvas limit, though its allocation is past it', () => {
    // 32,700 cells wide at x = 63: the buffer rounds its allocation out to its
    // growth chunks, to 0..32768, one past the limit. The preview is sized from
    // what can be painted instead, so the stroke is not refused for rounding.
    const target = runRaster(
      {
        cells: { x: 63, y: 10, width: 32_700, height: 1 },
        imageWidth: 40_000,
        imageHeight: 100,
        downsample: 1,
      },
      [0, 32_700],
    );
    const h = harness({
      imageSize: { width: 40_000, height: 100 },
      radius: 3,
      target: { annotationId: createAnnotationId('long'), snapshot: target },
    });
    down(h.tool, 100, 10);
    move(h.tool, 104, 10);
    up(h.tool, 104, 10);

    expect(h.capacityErrors).toEqual([]);
    expect(h.commits).toHaveLength(1);
    expect(h.commits[0]!.snapshot.cells.width).toBe(32_700);
  });

  /** The 32,700-cell strip at `x`, for the near-limit cases below. */
  function strip(x: number) {
    return runRaster(
      {
        cells: { x, y: 10, width: 32_700, height: 1 },
        imageWidth: 40_000,
        imageHeight: 100,
        downsample: 1,
      },
      [0, 32_700],
    );
  }

  it('lets an eraser overhang the far end of a near-limit mask (#149 minor 8)', () => {
    // Erasing sets no cell, so it must not grow the box that sizes the
    // preview: an r=80 eraser at x=32,750 was reported as 32,769 wide and
    // refused, losing the erasing done earlier in the stroke. At 32,780 even
    // the eraser's exact footprint passes the limit, so only not growing
    // the box at all lets it through.
    const h = harness({
      imageSize: { width: 40_000, height: 100 },
      radius: 80,
      target: { annotationId: createAnnotationId('long'), snapshot: strip(63) },
    });
    down(h.tool, 30_000, 10, true);
    move(h.tool, 32_780, 10);
    up(h.tool, 32_780, 10);
    expect(h.capacityErrors).toEqual([]);
    expect(h.commits).toHaveLength(1);
    expect(h.commits[0]!.snapshot.cells.width).toBeLessThan(32_700);
  });

  it('draws a dab whose result is just inside the limit (#149 minor 8)', () => {
    // An r=3 dab at x=32,763 on the strip at 0 sets cells up to 32,765, so the
    // mask is 32,766 wide. The swept slack box called it 32,768 and refused it.
    const h = harness({
      imageSize: { width: 40_000, height: 100 },
      radius: 3,
      target: { annotationId: createAnnotationId('long'), snapshot: strip(0) },
    });
    down(h.tool, 32_763, 10);
    up(h.tool, 32_763, 10);
    expect(h.capacityErrors).toEqual([]);
    expect(h.commits[0]!.snapshot.cells.width).toBe(32_766);
  });

  it('refuses a dab whose result is just past the limit (#149 final 11)', () => {
    // The other side of the footprint bound: an r=3 dab at x=32,766 on the
    // strip at 0 sets cells up to 32,768, so the mask would be 32,769 wide.
    // A footprint that undercounted would let it through, and commit a mask
    // no canvas draws.
    const h = harness({
      imageSize: { width: 40_000, height: 100 },
      radius: 3,
      target: { annotationId: createAnnotationId('long'), snapshot: strip(0) },
    });
    down(h.tool, 32_766, 10);
    up(h.tool, 32_766, 10);
    expect(h.commits).toHaveLength(0);
    expect(h.capacityErrors).toHaveLength(1);
    expect(h.capacityErrors[0]).toBeInstanceOf(MaskCanvasTooLargeError);
  });

  it('does not refuse a stroke for the room its preview leaves to grow', () => {
    // 20,000 cells wide fits; the preview's usual margin, half the box on
    // each side, would take it to 40,000, so the margin is what gives way.
    // In the middle of the image, so its edges do not clip the margin first.
    const h = harness({ imageSize: { width: 100_000, height: 200 }, radius: 5 });
    down(h.tool, 40_000, 100);
    move(h.tool, 60_000, 100);
    up(h.tool, 60_000, 100);

    expect(h.capacityErrors).toEqual([]);
    expect(h.commits).toHaveLength(1);
    expect(h.commits[0]!.snapshot.cells.width).toBeLessThanOrEqual(MAX_MASK_CANVAS_SIDE);
  });

  it('restores the hidden target when a capacity failure aborts the stroke', () => {
    const existing = committedObject('mask-1');
    const big = new BoundedDenseMaskBuffer({ imageWidth: 4096, imageHeight: 4096 });
    stampCircle(big, 2048, 2048, 900, 1);
    const h = harness({
      target: { annotationId: createAnnotationId('mask-1'), snapshot: big.raster() },
      maxPixels: 64 * 64,
      existingObjects: [existing],
    });

    down(h.tool, 2048, 2048);
    expect(existing.visible).not.toBe(false);
  });
});

describe('SegmentationBrushTool: New mask mid-stroke', () => {
  it('is swallowed while a stroke is open, so the stroke is not torn down', () => {
    const h = harness();
    down(h.tool, 50, 50);
    // Deselecting the mask being refined mid-stroke would, at the limit,
    // switch the brush off and lose the stroke; the key is ignored until the
    // release, and must be pressed again after it.
    expect(h.tool.onKeyDown({ key: shortcuts.newMask } as KeyboardEvent)).toBe(true);
    move(h.tool, 80, 50);
    up(h.tool, 80, 50);
    expect(h.commits).toHaveLength(1);
    // Between strokes it goes through to the host.
    expect(h.tool.onKeyDown({ key: shortcuts.newMask } as KeyboardEvent)).toBe(false);
  });
});

describe('SegmentationBrushTool: keyboard', () => {
  it('claims the resize keys while it is the active tool', () => {
    const h = harness();
    expect(h.tool.onKeyDown({ key: ']' } as KeyboardEvent)).toBe(true);
    expect(h.tool.onKeyDown({ key: '[' } as KeyboardEvent)).toBe(true);
    expect(h.radiusAdjustments).toEqual([1, -1]);
  });

  it('claims them between strokes, not only during one', () => {
    // Resizing between strokes is the common case; a `painting` guard here made
    // the keys work only while the pointer was down.
    const h = harness();
    down(h.tool, 50, 50);
    up(h.tool, 50, 50);
    expect(h.tool.onKeyDown({ key: ']' } as KeyboardEvent)).toBe(true);
    expect(h.radiusAdjustments).toEqual([1]);
  });

  it('leaves unrelated keys to the global map', () => {
    const h = harness();
    expect(h.tool.onKeyDown({ key: 'r' } as KeyboardEvent)).toBe(false);
    expect(h.radiusAdjustments).toEqual([]);
  });
});

describe('SegmentationBrushTool: an entirely erased stroke', () => {
  it('commits an empty snapshot so the host can delete the annotation', () => {
    const snapshot = paintedSnapshot(4);
    const h = harness({
      target: { annotationId: createAnnotationId('mask-1'), snapshot },
      erasing: true,
      radius: 40,
    });

    down(h.tool, 100, 80);
    up(h.tool, 100, 80);

    expect(h.commits).toHaveLength(1);
    expect(snapshotPixelCount(h.commits[0]!.snapshot)).toBe(0);
    expect(toDenseSnapshot(h.commits[0]!.snapshot)).toEqual(
      emptySnapshot(IMAGE.width, IMAGE.height),
    );
  });
});

describe('SegmentationBrushTool: preview cost', () => {
  /** Counts what the preview allocates while a stroke is driven across an image. */
  function measureSweep(imageSide: number, samples = 50) {
    let canvases = 0;
    let allocatedPixels = 0;
    const realCreate = document.createElement.bind(document);
    const spy = vi.spyOn(document, 'createElement').mockImplementation(((tag: string) => {
      const el = realCreate(tag) as HTMLCanvasElement;
      if (tag === 'canvas') {
        el.getContext = (() =>
          ({
            createImageData: (w: number, h: number) => {
              canvases++;
              allocatedPixels += w * h;
              return { width: w, height: h, data: new Uint8ClampedArray(w * h * 4) };
            },
            putImageData: () => {},
          }) as unknown as CanvasRenderingContext2D) as unknown as typeof el.getContext;
      }
      return el;
    }) as typeof document.createElement);

    try {
      const h = harness({ imageSize: { width: imageSide, height: imageSide }, radius: 20 });
      down(h.tool, 0, 0);
      for (let i = 1; i <= samples; i++) {
        move(h.tool, (imageSide * i) / samples, (imageSide * i) / samples);
      }
      up(h.tool, imageSide, imageSide);
    } finally {
      spy.mockRestore();
    }
    return { canvases, allocatedPixels };
  }

  // Drags a stroke across a large image and counts allocations: a few seconds
  // of real work, which exceeded the default timeout under a parallel run.
  it(
    'grows the preview geometrically, not once per chunk the buffer gains',
    { timeout: 30_000 },
    () => {
      // Sizing the preview exactly to the buffer meant reallocating on every
      // 64px chunk the stroke crossed, each time larger — cost went as roughly
      // the cube of the distance covered, and one corner-to-corner drag on an
      // 8192px image blocked the main thread for 15 seconds.
      const { canvases } = measureSweep(8192);
      expect(canvases).toBeLessThan(15);
    },
  );

  it('allocates a bounded multiple of the region it ends up covering', () => {
    // Geometric growth means the total allocated across a stroke is a small
    // multiple of the final size, rather than the sum of every intermediate.
    // 4096² ends exactly at the 16 Mi display budget, the worst case since
    // the preview stopped crossing it (#243 P5): the last growths each copy
    // up to the budget, so 4.7x here, against 2-3.6x at 2048-8192.
    const side = 4096;
    const { allocatedPixels } = measureSweep(side);
    expect(allocatedPixels).toBeLessThan(5 * side * side);
  });

  it('does not reallocate while a stroke stays inside the preview it already has', () => {
    // A stroke that scribbles in one spot covers no new ground after the first
    // growth, so however many samples it takes, it must stop reallocating.
    let canvases = 0;
    const realCreate = document.createElement.bind(document);
    const spy = vi.spyOn(document, 'createElement').mockImplementation(((tag: string) => {
      const el = realCreate(tag) as HTMLCanvasElement;
      if (tag === 'canvas') {
        el.getContext = (() =>
          ({
            createImageData: (w: number, h: number) => {
              canvases++;
              return { width: w, height: h, data: new Uint8ClampedArray(w * h * 4) };
            },
            putImageData: () => {},
          }) as unknown as CanvasRenderingContext2D) as unknown as typeof el.getContext;
      }
      return el;
    }) as typeof document.createElement);

    try {
      const h = harness({ imageSize: { width: 4096, height: 4096 }, radius: 10 });
      down(h.tool, 2000, 2000);
      for (let i = 0; i < 40; i++) move(h.tool, 2000 + (i % 5), 2000 + ((i * 3) % 5));
      const afterSettling = canvases;
      for (let i = 0; i < 200; i++) move(h.tool, 2000 + (i % 5), 2000 + ((i * 3) % 5));
      up(h.tool, 2000, 2000);
      expect(canvases).toBe(afterSettling);
    } finally {
      spy.mockRestore();
    }
  });
});

describe('SegmentationBrushTool: what the live preview shows', () => {
  it('shows the whole mask it is refining, from the first frame', () => {
    // The committed object is hidden for the length of the stroke, so whatever
    // the preview omits simply is not on screen. Carrying pixels forward from
    // the previous preview covers every rebuild except the first — where there
    // is no previous, and where a refining stroke has an entire mask to draw.
    // Getting this wrong made the mask vanish the instant the pointer went
    // down, and it is the path every stroke after the first one takes.
    const snapshot = paintedSnapshot(20);
    const existing = snapshotPixelCount(snapshot);
    expect(existing).toBeGreaterThan(1000);

    const capture = capturePreview();
    try {
      const h = harness({
        target: { annotationId: createAnnotationId('mask-1'), snapshot },
        radius: 5,
      });
      down(h.tool, 200, 200);
      expect(capture.opaquePixels()).toBeGreaterThanOrEqual(existing);
    } finally {
      capture.restore();
    }
  });

  it('keeps showing it as the stroke grows the preview', () => {
    const snapshot = paintedSnapshot(20);
    const existing = snapshotPixelCount(snapshot);

    const capture = capturePreview();
    try {
      const h = harness({
        target: { annotationId: createAnnotationId('mask-1'), snapshot },
        radius: 5,
      });
      down(h.tool, 100, 80);
      for (let x = 100; x < 380; x += 20) move(h.tool, x, 80);
      // Still at least the mask it started from, plus what the stroke added.
      expect(capture.opaquePixels()).toBeGreaterThan(existing);
    } finally {
      capture.restore();
    }
  });

  it('survives the image changing under a stroke', () => {
    // `getImageSize()` returns null whenever the cell has no image — swapping a
    // cell's image mid-stroke reaches this. The carry assumed the new preview
    // always contains the old one, and threw out of the pointer handler when
    // it did not.
    let size: { width: number; height: number } | null = { width: 1000, height: 800 };
    const h = harness({ imageSize: { width: 1000, height: 800 }, radius: 8 });
    // Re-point the config at a size that changes underneath the stroke.
    const config = (h.tool as unknown as { config: { getImageSize: () => unknown } }).config;
    config.getImageSize = () => size;

    down(h.tool, 500, 400);
    move(h.tool, 700, 600);
    size = null;
    expect(() => move(h.tool, 100, 100)).not.toThrow();
    size = { width: 512, height: 512 };
    expect(() => move(h.tool, 60, 60)).not.toThrow();
  });
});

describe('SegmentationBrushTool: when the image and the mask disagree about size', () => {
  /**
   * The buffer and the preview learned the image's size from different places.
   *
   * A new stroke takes it from `getImageSize()`, but refining takes it from the
   * snapshot's own `imageWidth`/`imageHeight` — so a mask recorded against a
   * different image (an import, a COCO round trip, another pyramid level)
   * disagrees with the viewer straight away, no timing needed. The preview then
   * clamped to the live size while the buffer wrote in the recorded one.
   *
   * Two independent mechanisms fix it — clamping to the buffer's image size,
   * and flooring the region against `bounds` so containment is structural —
   * and these tests pin the pair. Either alone keeps them passing, which is
   * deliberate redundancy rather than weak coverage.
   */
  it('does not build a negative-sized preview for a mask from a larger image', () => {
    // Recorded against 800x800; the viewer reports 200x160.
    const big = new BoundedDenseMaskBuffer({ imageWidth: 800, imageHeight: 800 });
    stampCircle(big, 500, 500, 20, 1);

    const h = harness({
      target: { annotationId: createAnnotationId('mask-1'), snapshot: big.raster() },
      imageSize: { width: 200, height: 160 },
    });

    expect(() => down(h.tool, 500, 500)).not.toThrow();
    const preview = h.objects.find((o) => o.type === 'image');
    expect(preview).toBeDefined();
    expect(preview!.width).toBeGreaterThan(0);
    expect(preview!.height).toBeGreaterThan(0);
  });

  it('keeps the preview covering what the buffer paints when the image shrinks', () => {
    // A valid but too-small preview is the quieter half of the same bug: the
    // pixels are painted and committed, and simply never shown.
    let size = { width: 400, height: 300 };
    const h = harness({ imageSize: size, radius: 6 });
    const config = (h.tool as unknown as { config: { getImageSize: () => unknown } }).config;
    config.getImageSize = () => size;

    down(h.tool, 150, 80);
    size = { width: 200, height: 300 };
    move(h.tool, 250, 80);

    const preview = h.objects.find((o) => o.type === 'image')!;
    // The stroke reached x=250 with radius 6, so the preview must extend past it.
    expect(preview.left! + preview.width!).toBeGreaterThanOrEqual(256);
  });

  it('gives the preview no more margin than the mask, or the display budget (#158)', () => {
    // A mask whose corners are 4,000 x 3,000 apart: half its extent of margin
    // on every side made an 8,000 x 6,000 preview, 48 M cells of RGBA. The
    // buffer allocates 4,096 x 3,072 of it, so the margin may add at most the
    // larger of that and the 16 Mi budget.
    const corners = new BoundedDenseMaskBuffer({ imageWidth: 10_000, imageHeight: 10_000 });
    stampCircle(corners, 3_000, 3_000, 3, 1);
    stampCircle(corners, 6_997, 5_997, 3, 1);
    const h = harness({
      target: { annotationId: createAnnotationId('mask-1'), snapshot: corners.raster() },
      imageSize: { width: 10_000, height: 10_000 },
      radius: 3,
    });

    down(h.tool, 5_000, 4_500);
    const preview = h.objects.find((o) => o.type === 'image')!;
    const allocated = 4_096 * 3_072;
    expect(preview.width! * preview.height!).toBeLessThanOrEqual(
      allocated + Math.max(allocated, MAX_MASK_CANVAS_PIXELS),
    );
    // It still covers the whole mask, with what margin the budget leaves.
    expect(preview.left!).toBeLessThan(2_997);
    expect(preview.top!).toBeLessThan(2_997);
    expect(preview.left! + preview.width!).toBeGreaterThan(7_000);
    expect(preview.top! + preview.height!).toBeGreaterThan(6_000);
  });
});

describe('SegmentationBrushTool: a stroke that never got its pointer-up', () => {
  it("does not leave the abandoned stroke's pixels on screen", () => {
    // Fabric registers pointerdown/up/move but not pointercancel, so a
    // cancelled gesture leaves a stroke open. The next pointer-down then
    // measured its new buffer against the *old* stroke's preview bounds, found
    // it fitted, and left the previous stroke's pixels displayed throughout.
    //
    // The buffer is replaced either way — asserting on it proves nothing. What
    // has to be checked is the preview, which is the only thing on screen while
    // the committed object is hidden.
    const capture = capturePreview();
    try {
      const h = harness({ radius: 6 });

      down(h.tool, 60, 60);
      move(h.tool, 150, 60);
      const abandoned = capture.opaquePixels();
      expect(abandoned).toBeGreaterThan(500);

      // No pointer-up: a new stroke starts on top of the open one.
      down(h.tool, 100, 60);
      const buffer = (h.tool as unknown as { buffer: { cellCount: number } }).buffer;
      expect(capture.opaquePixels()).toBe(buffer.cellCount);
      expect(capture.opaquePixels()).toBeLessThan(abandoned);
    } finally {
      capture.restore();
    }
  });
});

describe('the delete key while the brush is active', () => {
  it('is left for the host to handle when Fabric has nothing selected', () => {
    // `paint` mode discards the Fabric selection and makes every object inert,
    // so `getActiveObjects()` is empty for the entire time the brush is in
    // use. The tool used to claim the key regardless, which made Delete a dead
    // key on the brush's own main path: paint a mask, it becomes the selected
    // annotation, press Delete, nothing happens. Returning `false` lets the
    // host's keyboard map delete `UIState.selectedAnnotationId` instead.
    const h = harness();
    const consumed = h.tool.onKeyDown({ key: 'Delete' } as KeyboardEvent);

    expect(consumed).toBe(false);
    expect(h.callbacks.deleteAnnotation).not.toHaveBeenCalled();
  });

  it('still claims the key when it does delete something', () => {
    const target = committedObject('ann-1');
    const h = harness({ activeObjects: [target] });

    expect(h.tool.onKeyDown({ key: 'Delete' } as KeyboardEvent)).toBe(true);
    expect(h.callbacks.deleteAnnotation).toHaveBeenCalledWith('ann-1', imageId);
  });

  it('does not claim Backspace either when the selection is empty', () => {
    const h = harness();
    expect(h.tool.onKeyDown({ key: 'Backspace' } as KeyboardEvent)).toBe(false);
  });
});

describe('a stroke whose release never arrives', () => {
  const pointer = (id: number, extra: Partial<PointerEvent> = {}) =>
    ({ altKey: false, pointerId: id, buttons: 1, ...extra }) as PointerEvent;

  it('is committed, not discarded, when the next press arrives', () => {
    // A lost release leaves the stroke open. The old behaviour threw its
    // pixels away at the next press; they are finished work.
    const h = harness();
    h.tool.onPointerDown(pointer(1), { x: 100, y: 100 });
    h.tool.onPointerMove(pointer(1), { x: 140, y: 100 });
    expect(h.commits).toHaveLength(0);

    h.tool.onPointerDown(pointer(1), { x: 100, y: 180 });
    expect(h.commits).toHaveLength(1);
    expect(snapshotPixelCount(h.commits[0]!.snapshot)).toBeGreaterThan(0);
  });

  it('ends when a move arrives with the primary button up', () => {
    // After a `pointercancel` nothing forwarded, the next hover moves still
    // reached the tool and it painted with no button held until a click.
    const h = harness();
    h.tool.onPointerDown(pointer(1), { x: 100, y: 100 });
    h.tool.onPointerMove(pointer(1), { x: 140, y: 100 });
    h.tool.onPointerMove(pointer(1, { buttons: 0 }), { x: 200, y: 100 });
    expect(h.commits).toHaveLength(1);

    // And paints no further: the stroke is over.
    const before = h.commits.length;
    h.tool.onPointerMove(pointer(1, { buttons: 0 }), { x: 260, y: 100 });
    h.tool.onPointerUp(pointer(1, { buttons: 0 }), { x: 260, y: 100 });
    expect(h.commits).toHaveLength(before);
  });

  it('ignores moves and releases from a pointer other than the one painting', () => {
    const h = harness();
    h.tool.onPointerDown(pointer(1), { x: 100, y: 100 });
    h.tool.onPointerMove(pointer(1), { x: 120, y: 100 });
    const buffer = (h.tool as unknown as { buffer: { cellCount: number } }).buffer;
    const painted = buffer.cellCount;
    expect(painted).toBeGreaterThan(0);

    // A palm or second finger: neither steers nor ends the stroke.
    h.tool.onPointerMove(pointer(2), { x: 300, y: 250 });
    h.tool.onPointerUp(pointer(2), { x: 300, y: 250 });
    expect(buffer.cellCount).toBe(painted);
    expect(h.commits).toHaveLength(0);

    h.tool.onPointerUp(pointer(1), { x: 120, y: 100 });
    expect(h.commits).toHaveLength(1);
  });

  it('does not treat a hand-built event without `buttons` as a lost release', () => {
    const h = harness();
    down(h.tool, 100, 100);
    move(h.tool, 140, 100);
    expect(h.commits).toHaveLength(0);
    up(h.tool, 140, 100);
    expect(h.commits).toHaveLength(1);
  });
});

describe('the cursor ring', () => {
  const cursorOf = (h: Harness) =>
    h.objects.find((o) => !o.id && o.type === 'circle') as
      | (FabricObject & { visible: boolean; radius: number })
      | undefined;

  it('shows on press, so a tap shows the ring it painted with', () => {
    const h = harness();
    expect(cursorOf(h)?.visible).toBe(false);
    down(h.tool, 100, 100);
    expect(cursorOf(h)?.visible).toBe(true);
    expect(h.canvas.bringObjectToFront).toHaveBeenCalledWith(cursorOf(h));
  });

  it('hides after a touch release, where there is nothing to hover', () => {
    const h = harness();
    down(h.tool, 100, 100);
    h.tool.onPointerUp({ pointerType: 'touch' } as PointerEvent, { x: 100, y: 100 });
    expect(cursorOf(h)?.visible).toBe(false);

    down(h.tool, 100, 100);
    h.tool.onPointerUp({ pointerType: 'mouse' } as PointerEvent, { x: 100, y: 100 });
    expect(cursorOf(h)?.visible).toBe(true);
  });

  it('takes a new radius at once when the resize key is pressed', () => {
    let radius = 10;
    const h = harness({ radius: 10 });
    (h.tool as unknown as { config: { getBrushRadius: () => number } }).config.getBrushRadius =
      () => radius;
    move(h.tool, 100, 100);
    expect(cursorOf(h)?.radius).toBe(10);

    radius = 13;
    h.tool.onKeyDown({ key: shortcuts.increaseBrushRadius } as KeyboardEvent);
    expect(h.radiusAdjustments).toEqual([1]);
    expect(cursorOf(h)?.radius).toBe(13);
  });
});

describe('the cursor cue: refine or create', () => {
  const ringOf = (h: Harness) =>
    h.objects.find((o) => !o.id && o.type === 'circle') as
      | (FabricObject & { visible: boolean; strokeDashArray: number[] | null })
      | undefined;
  const cellsOf = (h: Harness) =>
    h.objects.find((o) => !o.id && o.type === 'path') as
      | (FabricObject & { path: [string, number, number][]; strokeDashArray: number[] | null })
      | undefined;

  it('is solid when the next stroke refines a mask, dashed when it creates one', () => {
    let peek: BrushTargetPreview | null = { downsample: 1 };
    const h = harness({ peekTarget: () => peek });
    move(h.tool, 100, 100);
    expect(ringOf(h)?.visible).toBe(true);
    expect(ringOf(h)?.strokeDashArray).toBeNull();

    peek = null;
    move(h.tool, 101, 100);
    expect(ringOf(h)?.strokeDashArray).not.toBeNull();
    expect(ringOf(h)!.strokeDashArray!.length).toBeGreaterThan(0);
  });

  it('stays solid for a host that does not say', () => {
    const h = harness();
    move(h.tool, 100, 100);
    expect(ringOf(h)?.strokeDashArray).toBeNull();
  });

  it('keeps one screen pixel of line, and a screen-sized dash, at any zoom', () => {
    // The cue lives in image space; at a whole-slide zoom of 0.1 an
    // image-pixel line was a tenth of a screen pixel, and its dashes too.
    let peek: BrushTargetPreview | null = { downsample: 1 };
    const h = harness({
      peekTarget: () => peek,
      viewport: { zoom: 0.1, width: 800, height: 600 },
    });
    move(h.tool, 100, 100);
    const ring = ringOf(h) as unknown as { strokeWidth: number; strokeDashArray: number[] | null };
    expect(ring.strokeWidth).toBeCloseTo(10);
    expect(ring.strokeDashArray).toBeNull();
    peek = null;
    move(h.tool, 101, 100);
    expect(ring.strokeWidth).toBeCloseTo(10);
    expect(ring.strokeDashArray).toEqual([50, 40]);

    // And the cell outline at a downsample.
    peek = { downsample: 4 };
    move(h.tool, 102, 100);
    const cells = cellsOf(h) as unknown as { strokeWidth: number };
    expect(cells.strokeWidth).toBeCloseTo(10);
  });

  it('resizes the cue when the zoom changes with no pointer move (#149 minor 11)', () => {
    // A Ctrl/Cmd scroll or the reset-view key zooms without a move: the next
    // render redraws the cue for the new zoom.
    const peekTarget = vi.fn(() => ({ downsample: 1 }));
    const h = harness({ peekTarget, viewport: { zoom: 1, width: 800, height: 600 } });
    move(h.tool, 100, 100);
    const ring = ringOf(h) as unknown as { strokeWidth: number };
    expect(ring.strokeWidth).toBeCloseTo(1);
    h.setZoom(0.1);
    h.render();
    expect(ring.strokeWidth).toBeCloseTo(10);
    // And a render at an unchanged zoom does nothing: the cue is not even
    // re-asked what the next stroke would do (#149 final 12).
    const asked = peekTarget.mock.calls.length;
    h.render();
    expect(peekTarget.mock.calls.length).toBe(asked);
    // Deactivated, it no longer listens: the very handler it registered is
    // the one it removes.
    const registered = h.canvas.on.mock.calls.filter(([event]) => event === 'before:render');
    expect(registered).toHaveLength(1);
    h.tool.deactivate();
    expect(h.canvas.off).toHaveBeenCalledWith('before:render', registered[0]![1]);
    h.setZoom(1);
    h.render();
    expect(peekTarget.mock.calls.length).toBe(asked);
  });

  it('redraws after New mask or cancel, without waiting for the pointer', async () => {
    let peek: BrushTargetPreview | null = { downsample: 1 };
    const h = harness({ peekTarget: () => peek });
    move(h.tool, 100, 100);
    expect(ringOf(h)?.strokeDashArray).toBeNull();

    // The host deselects after the tool lets the key through.
    expect(h.tool.onKeyDown({ key: shortcuts.newMask } as KeyboardEvent)).toBe(false);
    peek = null;
    await Promise.resolve();
    expect(ringOf(h)?.strokeDashArray).not.toBeNull();
  });

  it('at downsample 4, outlines exactly the cells one dab sets', () => {
    const radius = 9;
    const at = { x: 101.3, y: 57.8 };
    const h = harness({ radius, peekTarget: () => ({ downsample: 4 }) });
    move(h.tool, at.x, at.y);
    expect(ringOf(h)?.visible).toBe(false);
    const outline = cellsOf(h);
    expect(outline).toBeDefined();
    expect(outline!.strokeDashArray).toBeNull();

    // Every edge of the outline, to ray-cast cell centres against: an
    // independent reading of the footprint, not a re-run of the code that drew it.
    const segments: [number, number, number, number][] = [];
    for (let i = 0; i + 1 < outline!.path.length; i += 2) {
      const [, x0, y0] = outline!.path[i]!;
      const [, x1, y1] = outline!.path[i + 1]!;
      segments.push([x0, y0, x1, y1]);
    }
    const inside = (px: number, py: number) => {
      let crossings = 0;
      for (const [x0, y0, x1, y1] of segments) {
        if (x0 !== x1 || x0 <= px) continue;
        if (py >= Math.min(y0, y1) && py < Math.max(y0, y1)) crossings++;
      }
      return crossings % 2 === 1;
    };

    const expected = new BoundedDenseMaskBuffer({
      imageWidth: IMAGE.width,
      imageHeight: IMAGE.height,
      downsample: 4,
    });
    stampCircle(expected, at.x, at.y, radius, 1);
    const raster = expected.raster();
    let set = 0;
    for (let cy = 0; cy < IMAGE.height / 4; cy++) {
      for (let cx = 0; cx < IMAGE.width / 4; cx++) {
        const want = raster.get(cx, cy) === 1;
        expect(inside(cx * 4 + 2, cy * 4 + 2), `cell ${cx},${cy}`).toBe(want);
        if (want) set++;
      }
    }
    expect(set).toBeGreaterThan(10);
  });

  it('shows the dashed ring, not cells, when the stroke would create a mask', () => {
    // A new mask is always full resolution, so creating never draws cells.
    let peek: BrushTargetPreview | null = { downsample: 4 };
    const h = harness({ peekTarget: () => peek });
    move(h.tool, 100, 100);
    expect(cellsOf(h)).toBeDefined();
    peek = null;
    move(h.tool, 100, 100);
    expect(cellsOf(h)).toBeUndefined();
    expect(ringOf(h)?.visible).toBe(true);
    expect(ringOf(h)?.strokeDashArray).not.toBeNull();
  });
});

describe('the committed object of a stroke that begins with a commit', () => {
  it('is hidden once the rebuild re-adds it', () => {
    // A press that arrives while a stroke is still open commits it, and the
    // host's rebuild clears the canvas at once and re-adds asynchronously. The
    // hide at press time then found nothing, and the rebuilt object rendered
    // under the new stroke's preview: double alpha, and erased pixels still
    // drawn.
    const m1 = createAnnotationId('m1');
    let target: BrushTarget | null = null;
    const h = harness({
      get target() {
        return target;
      },
      onCommit: () => {
        // What `ViewerCell` does on a commit: clear now, re-add later.
        const rebuilt = committedObject('m1');
        for (const committed of h.objects.filter((o) => o.id)) {
          h.objects.splice(h.objects.indexOf(committed), 1);
        }
        queueMicrotask(() => h.objects.push(rebuilt));
        target = { annotationId: m1, snapshot: paintedSnapshot() };
      },
    });
    down(h.tool, 100, 80);
    move(h.tool, 120, 80);
    // The release never arrived; the next press commits and starts refining.
    down(h.tool, 130, 80);
    expect(h.commits).toHaveLength(1);
    expect(h.objects.find((o) => o.id === m1)).toBeUndefined();

    return new Promise<void>((resolve) => {
      queueMicrotask(() => {
        const rebuilt = h.objects.find((o) => o.id === m1)!;
        expect(rebuilt.visible).toBe(true);
        move(h.tool, 140, 80);
        expect(rebuilt.visible).toBe(false);
        up(h.tool, 140, 80);
        expect(rebuilt.visible).toBe(true);
        resolve();
      });
    });
  });
});

describe('a preview the engine refuses to allocate', () => {
  it('is reported as a capacity failure and abandons the stroke', () => {
    // The cap bounds the one-byte buffer; the RGBA preview is four bytes a
    // pixel over a larger box, and an engine past its canvas limit throws a
    // plain RangeError from `createImageData`, which escaped into Fabric's
    // dispatch.
    const original = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = (() => ({
      createImageData: () => {
        throw new RangeError('Failed to allocate ImageData');
      },
      putImageData: () => {},
    })) as unknown as typeof original;
    try {
      const h = harness({
        target: { annotationId: createAnnotationId('m1'), snapshot: paintedSnapshot() },
        existingObjects: [committedObject('m1')],
      });
      expect(() => down(h.tool, 100, 80)).not.toThrow();
      expect(h.capacityErrors).toHaveLength(1);
      expect(h.capacityErrors[0]).toBeInstanceOf(MaskCapacityExceededError);
      expect(h.commits).toHaveLength(0);
      // The hidden target is back, and the stroke is over: its release commits nothing.
      expect(h.objects.find((o) => o.id === 'm1')?.visible).toBe(true);
      up(h.tool, 100, 80);
      expect(h.commits).toHaveLength(0);
    } finally {
      HTMLCanvasElement.prototype.getContext = original;
    }
  });
});

describe('a stroke whose press the platform cancelled', () => {
  it('is discarded, not committed, and the mask it was refining comes back', () => {
    // Palm rejection on an iPad cancels the palm a moment after it lands, and
    // the overlay forwards the cancel as a release. Committing it left a dot
    // in the mask.
    const committed = committedObject('m1');
    const h = harness({
      target: { annotationId: createAnnotationId('m1'), snapshot: paintedSnapshot() },
      existingObjects: [committed],
    });
    down(h.tool, 100, 80);
    move(h.tool, 120, 80);
    expect(committed.visible).toBe(false);

    const release = { pointerType: 'touch' } as PointerEvent;
    h.cancelledReleases.add(release);
    h.tool.onPointerUp(release, { x: 120, y: 80 });

    expect(h.commits).toHaveLength(0);
    expect(committed.visible).toBe(true);
    // The preview is gone, as for any other ending.
    expect(h.objects.filter((o) => o.type === 'image')).toHaveLength(0);
  });

  it('still commits an ordinary release', () => {
    const h = harness();
    down(h.tool, 100, 80);
    move(h.tool, 120, 80);
    up(h.tool, 120, 80);
    expect(h.commits).toHaveLength(1);
  });
});

describe('SegmentationBrushTool: resolution of a new mask', () => {
  // A 20000 px square image under a 64 Ki-cell cap: 6100x the cap at level 0.
  const BIG = { width: 20_000, height: 20_000 } as const;
  const CAP = 64 * 1024;

  it('starts a new mask at full resolution, at any zoom', () => {
    // Zoomed in (200 image px on screen) and zoomed out over the whole
    // image: a new mask is d=1 either way. Choosing from the view coarsened
    // small strokes and depended on the monitor's size.
    for (const zoom of [4, 0.04]) {
      const h = harness({
        imageSize: BIG,
        maxPixels: CAP,
        viewport: { zoom, width: 800, height: 800 },
      });
      down(h.tool, 5000, 5000);
      up(h.tool, 5000, 5000);
      expect(h.commits[0]!.snapshot.downsample, `zoom ${zoom}`).toBe(1);
    }
  });

  it('commits a whole-slide stroke at full resolution, as #149 did', () => {
    // A reviewer's probe: on a 100,000 x 80,000 image at a whole-slide view,
    // an r=12 stroke from (5000,5000) to (5300,5300).
    const h = harness({
      imageSize: { width: 100_000, height: 80_000 },
      radius: 12,
      viewport: { zoom: 0.008, width: 800, height: 640 },
    });
    down(h.tool, 5000, 5000);
    move(h.tool, 5300, 5300);
    up(h.tool, 5300, 5300);
    expect(h.capacityErrors).toHaveLength(0);
    const snapshot = h.commits[0]!.snapshot;
    expect(snapshot.downsample).toBe(1);
    expect(snapshotImageBox(snapshot)).toEqual({ x: 4988, y: 4988, width: 324, height: 324 });
    expect(snapshotPixelCount(snapshot)).toBe(10_348);
  });

  it('places the live preview where the committed mask will render', () => {
    // Refining a d=4 mask: one preview pixel per cell, scaled to the image
    // pixels it covers, on the cell grid.
    const buffer = new BoundedDenseMaskBuffer({
      imageWidth: BIG.width,
      imageHeight: BIG.height,
      downsample: 4,
    });
    stampCircle(buffer, 6000, 4000, 40, 1);
    const target = { annotationId: createAnnotationId('mask-4x'), snapshot: buffer.raster() };
    // Zoomed out to four image pixels a screen pixel, where it stays at d=4.
    const h = harness({
      imageSize: BIG,
      maxPixels: CAP,
      radius: 30,
      target,
      viewport: { zoom: 0.25, width: 800, height: 800 },
    });
    down(h.tool, 6050, 4000);
    const preview = h.objects.find((obj) => obj instanceof FabricImage) as FabricImage;
    expect(preview).toBeDefined();
    expect(preview.scaleX).toBe(4);
    expect(preview.scaleY).toBe(4);
    expect(preview.left % 4).toBe(0);
    expect(preview.top % 4).toBe(0);
    expect(preview.left).toBeLessThanOrEqual(6000 - 40);
    expect(preview.left + preview.width * 4).toBeGreaterThanOrEqual(6050 + 30);
    up(h.tool, 6050, 4000);
    expect(h.commits[0]!.snapshot.downsample).toBe(4);
  });

  it('refines a coarse mask at its own resolution when zoomed out, and finer closer in', () => {
    // At four image pixels a screen pixel the view shows nothing finer than
    // the mask's d=4. Closer in the stroke re-grids it: replicated cells, so
    // nothing is lost, then painted at the finer grid.
    for (const [zoom, expected] of [
      [0.25, 4],
      [0.1, 4],
      [0.5, 2],
      [1, 1],
      [4, 1],
    ] as const) {
      const buffer = new BoundedDenseMaskBuffer({
        imageWidth: BIG.width,
        imageHeight: BIG.height,
        downsample: 4,
      });
      stampCircle(buffer, 5000, 5000, 40, 1);
      const target = { annotationId: createAnnotationId('mask-4x'), snapshot: buffer.raster() };
      const h = harness({
        imageSize: BIG,
        maxPixels: CAP,
        target,
        viewport: { zoom, width: 800, height: 800 },
      });
      down(h.tool, 5050, 5000);
      up(h.tool, 5050, 5000);
      const committed = h.commits[0]!;
      expect(committed.snapshot.downsample, `zoom ${zoom}`).toBe(expected);
      expect(committed.startDownsample).toBe(4);
      expect(snapshotPixelCount(committed.snapshot)).toBeGreaterThan(
        snapshotPixelCount(target.snapshot),
      );
    }
  });

  it('picks the same grid on either side of a rounding at an exact power of two', () => {
    // Four image pixels a screen pixel, as the viewer reports it at two sizes.
    for (const zoom of [0.24999999999994316, 0.2500000000001]) {
      const buffer = new BoundedDenseMaskBuffer({
        imageWidth: BIG.width,
        imageHeight: BIG.height,
        downsample: 4,
      });
      stampCircle(buffer, 5000, 5000, 40, 1);
      const target = { annotationId: createAnnotationId('mask-4x'), snapshot: buffer.raster() };
      const h = harness({
        imageSize: BIG,
        maxPixels: CAP,
        target,
        viewport: { zoom, width: 800, height: 800 },
      });
      down(h.tool, 5050, 5000);
      up(h.tool, 5050, 5000);
      expect(h.commits[0]!.snapshot.downsample, `zoom ${zoom}`).toBe(4);
    }
  });

  it('keeps a coarse mask at its own resolution when the finer box lacks headroom', () => {
    // A context that does not coarsen re-grids only into a quarter of the
    // cap: past that, the next stroke could overflow where at d=4 it fitted.
    // 200 x 200 image pixels is 40,000 cells at d=1, more than 64 Ki / 4.
    const buffer = new BoundedDenseMaskBuffer({
      imageWidth: BIG.width,
      imageHeight: BIG.height,
      downsample: 4,
    });
    stampCircle(buffer, 5000, 5000, 100, 1);
    const target = { annotationId: createAnnotationId('mask-4x'), snapshot: buffer.raster() };
    const h = harness({
      imageSize: BIG,
      maxPixels: CAP,
      target,
      viewport: { zoom: 2, width: 800, height: 800 },
    });
    // At the disc's edge, so the stroke adds cells: one that adds none is
    // a no-op, re-gridded or not, and commits nothing.
    down(h.tool, 5100, 5000);
    up(h.tool, 5100, 5000);
    // 2 is the finest with headroom: about 106 x 100 cells.
    expect(h.commits[0]!.snapshot.downsample).toBe(2);

    // A context that coarsens may fill the cap: 40,000 cells fit 64 Ki.
    const coarsening = harness({
      imageSize: BIG,
      maxPixels: CAP,
      target,
      maxDownsample: 8,
      viewport: { zoom: 2, width: 800, height: 800 },
    });
    down(coarsening.tool, 5100, 5000);
    up(coarsening.tool, 5100, 5000);
    expect(coarsening.commits[0]!.snapshot.downsample).toBe(1);
  });

  it('shows the cue on the grid the press would paint on', () => {
    const box = { x: 4960, y: 4960, width: 80, height: 80 };
    const cue = (zoom: number) => {
      const h = harness({
        imageSize: BIG,
        maxPixels: CAP,
        radius: 12,
        peekTarget: () => ({ downsample: 4, box }),
        viewport: { zoom, width: 800, height: 800 },
      });
      move(h.tool, 5000, 5000);
      return h.objects.some((o) => o.type === 'path');
    };
    // Zoomed out: the mask's own d=4 cells. Closer in, d=1: the ring.
    expect(cue(0.25)).toBe(true);
    expect(cue(1)).toBe(false);
  });
});

describe('SegmentationBrushTool: re-gridding never turns a stroke that fits into a refusal (#243)', () => {
  const BIG = { width: 100_000, height: 2_000 } as const;

  /** A d=`d` mask covering `box`, solid, on `size`. */
  function coarseMask(d: number, box: MaskRegion, size: { width: number; height: number }) {
    const buffer = new BoundedDenseMaskBuffer({
      imageWidth: size.width,
      imageHeight: size.height,
      downsample: d,
    });
    for (let y = box.y; y < box.y + box.height; y += d) {
      for (let x = box.x; x < box.x + box.width; x += d) buffer.set(x / d, y / d, 1);
    }
    return { annotationId: createAnnotationId('coarse'), snapshot: buffer.raster() };
  }

  it('coarsens a re-gridded stroke back to the grid it started from (P1)', () => {
    // A d=2 mask about 100 px across and an r=20 drag 400 px long, under a
    // 64 Ki cap: it fits at d=2 (61,100 cells), not at d=1 (70,664). At zoom 1
    // or 4 the press re-grids to d=1, and the stroke was refused there.
    const size = { width: 4_000, height: 4_000 };
    const target = coarseMask(2, { x: 1_000, y: 1_000, width: 100, height: 100 }, size);
    for (const maxDownsample of [undefined, 4]) {
      for (const zoom of [0.5, 1, 4]) {
        const h = harness({
          imageSize: size,
          maxPixels: 64 * 1024,
          radius: 20,
          target,
          viewport: { zoom, width: 800, height: 800 },
          ...(maxDownsample !== undefined ? { maxDownsample } : {}),
        });
        down(h.tool, 1_050, 1_050);
        for (let x = 1_060; x <= 1_450; x += 10) move(h.tool, x, 1_050 + (x - 1_050) / 4);
        up(h.tool, 1_450, 1_150);
        const label = `zoom ${zoom}, maxDownsample ${maxDownsample}`;
        expect(
          h.capacityErrors.map((e) => e.message),
          label,
        ).toEqual([]);
        expect(h.commits, label).toHaveLength(1);
        // Back at its own grid, never coarser than it started.
        expect(h.commits[0]!.snapshot.downsample, label).toBe(2);
        expect(h.commits[0]!.startDownsample).toBe(2);
      }
    }
  });

  it('does not re-grid past the canvas side limit, and coarsens back if it must (P2)', () => {
    // A d=4 mask 40,160 x 160 px: at d=1 or 2 its cells are 40,160 or 20,080
    // wide, past or near the 32,767 a canvas draws. Every close-zoom stroke was
    // refused; it now stays at the grid that draws.
    const target = coarseMask(4, { x: 1_000, y: 500, width: 40_160, height: 160 }, BIG);
    for (const maxDownsample of [undefined, 8]) {
      for (const zoom of [0.25, 0.5, 1, 4]) {
        const h = harness({
          imageSize: BIG,
          radius: 10,
          target,
          viewport: { zoom, width: 800, height: 800 },
          ...(maxDownsample !== undefined ? { maxDownsample } : {}),
        });
        // Across the mask's top edge, so the stroke adds cells and commits.
        down(h.tool, 20_000, 495);
        move(h.tool, 20_040, 495);
        up(h.tool, 20_040, 495);
        const label = `zoom ${zoom}, maxDownsample ${maxDownsample}`;
        expect(
          h.capacityErrors.map((e) => e.message),
          label,
        ).toEqual([]);
        expect(h.commits, label).toHaveLength(1);
        expect(h.commits[0]!.snapshot.cells.width, label).toBeLessThanOrEqual(MAX_MASK_CANVAS_SIDE);
      }
    }
  });
});

describe('SegmentationBrushTool: the canvas side limit, at the press and mid-stroke (#243 P2)', () => {
  const BIG = { width: 100_000, height: 2_000 } as const;

  it('chooses a press grid whose cells a canvas draws, and the cue agrees', () => {
    // 40,160 px wide at d=4: d=1 would be 40,160 cells, past the limit, so at
    // zoom 1 the finest drawable grid is d=2, and the cue shows its cells.
    const box = { x: 1_000, y: 500, width: 40_160, height: 160 };
    const h = harness({
      imageSize: BIG,
      radius: 10,
      peekTarget: () => ({ downsample: 4, box }),
      viewport: { zoom: 1, width: 800, height: 800 },
    });
    move(h.tool, 20_000, 495);
    expect(h.objects.some((o) => o.type === 'path')).toBe(true);
  });

  it('coarsens a re-gridded stroke back when it grows past the limit mid-stroke', () => {
    // 20,000 px wide at d=4 re-grids to d=1 at zoom 1, which fits. Dragged on
    // past the end, it reaches 35,000 cells wide: past what a canvas draws at
    // d=1, so it returns to d=2 instead of being refused.
    const buffer = new BoundedDenseMaskBuffer({
      imageWidth: BIG.width,
      imageHeight: BIG.height,
      downsample: 4,
    });
    for (let x = 250; x < 5_250; x++) buffer.set(x, 125, 1);
    const target = { annotationId: createAnnotationId('long'), snapshot: buffer.raster() };
    const h = harness({
      imageSize: BIG,
      radius: 3,
      target,
      viewport: { zoom: 1, width: 800, height: 800 },
    });
    down(h.tool, 20_990, 502);
    for (let x = 21_000; x <= 36_000; x += 500) move(h.tool, x, 502);
    up(h.tool, 36_000, 502);
    expect(h.capacityErrors.map((e) => e.message)).toEqual([]);
    expect(h.commits).toHaveLength(1);
    expect(h.commits[0]!.snapshot.downsample).toBeGreaterThan(1);
    expect(h.commits[0]!.snapshot.cells.width).toBeLessThanOrEqual(MAX_MASK_CANVAS_SIDE);
  });
});

describe('SegmentationBrushTool: the preview under the display budget (#243 P5)', () => {
  it('stays within the budget for any mask under it', () => {
    // A 3,000-square mask, 9 M cells: the margin rule let its preview reach
    // 9 M + 16 Mi, past the 16 Mi an iPad draws, though a 16 Mi maxPixels
    // would never have coarsened it.
    for (const side of [1_000, 2_048, 3_000, 4_000]) {
      const buffer = new BoundedDenseMaskBuffer({ imageWidth: 10_000, imageHeight: 10_000 });
      stampCircle(buffer, 5_000, 5_000, 2, 1);
      stampCircle(buffer, 5_000 + side - 3, 5_000 + side - 3, 2, 1);
      const h = harness({
        imageSize: { width: 10_000, height: 10_000 },
        radius: 3,
        target: { annotationId: createAnnotationId('m'), snapshot: buffer.raster() },
      });
      down(h.tool, 5_000 + side / 2, 5_000 + side / 2);
      const preview = h.objects.find((o) => o.type === 'image')!;
      expect(preview.width! * preview.height!, `side ${side}`).toBeLessThanOrEqual(
        MAX_MASK_CANVAS_PIXELS,
      );
      up(h.tool, 5_000 + side / 2, 5_000 + side / 2);
    }
  });
});

describe('SegmentationBrushTool: coarsening on overflow', () => {
  const BIG = { width: 20_000, height: 20_000 } as const;
  // 4,096 cells: a 64 x 64 box at d=1.
  const CAP = 64 * 64;

  /** A horizontal stroke `length` image pixels long at y=1000. */
  const sweep = (h: Harness, length: number) => {
    down(h.tool, 1000, 1000);
    for (let x = 1010; x <= 1000 + length; x += 10) move(h.tool, x, 1000);
    up(h.tool, 1000 + length, 1000);
  };

  it('coarsens a stroke that outgrows the cap, and painting goes on', () => {
    const h = harness({ imageSize: BIG, maxPixels: CAP, radius: 8, maxDownsample: 4 });
    // 200 x 18 px: 3,600 cells at d=1 before the chunk rounding outgrows 4,096.
    sweep(h, 200);
    expect(h.capacityErrors.map((e) => e.message)).toEqual([]);
    const commit = h.commits[0]!;
    expect(commit.startDownsample).toBe(1);
    expect(commit.snapshot.downsample).toBeGreaterThan(1);
    expect(commit.snapshot.downsample).toBeLessThanOrEqual(4);
    // The far end was painted after the coarsening, at the coarse grid.
    const d = commit.snapshot.downsample;
    expect(commit.snapshot.get(Math.floor(1195 / d), Math.floor(1000 / d))).toBe(1);
    expect(commit.snapshot.get(Math.floor(1005 / d), Math.floor(1000 / d))).toBe(1);
  });

  it('refuses the whole stroke at maxDownsample, naming it, with the mask unchanged', () => {
    const target = (() => {
      const buffer = new BoundedDenseMaskBuffer({ imageWidth: BIG.width, imageHeight: BIG.height });
      stampCircle(buffer, 1000, 1000, 10, 1);
      return { annotationId: createAnnotationId('mask-1'), snapshot: buffer.raster() };
    })();
    const existing = committedObject('mask-1');
    const h = harness({
      imageSize: BIG,
      maxPixels: CAP,
      radius: 8,
      maxDownsample: 2,
      target,
      existingObjects: [existing],
    });
    down(h.tool, 1000, 1000);
    expect(existing.visible).toBe(false);
    for (let x = 1010; x <= 3000; x += 10) move(h.tool, x, 1000);
    up(h.tool, 3000, 1000);
    expect(h.commits).toHaveLength(0);
    expect(h.capacityErrors).toHaveLength(1);
    expect(h.capacityErrors[0]).toBeInstanceOf(MaskCapacityExceededError);
    expect(h.capacityErrors[0]!.message).toMatch(/maxDownsample 2/);
    // The committed object, hidden while painting, is back, and the preview gone.
    expect(existing.visible).toBe(true);
    expect(h.objects.filter((o) => o.type === 'image')).toHaveLength(0);
  });

  it('restores the hidden target on a cancel once the stroke has coarsened (#243 minor 18)', () => {
    const buffer = new BoundedDenseMaskBuffer({ imageWidth: BIG.width, imageHeight: BIG.height });
    stampCircle(buffer, 1000, 1000, 10, 1);
    const target = { annotationId: createAnnotationId('mask-1'), snapshot: buffer.raster() };
    const existing = committedObject('mask-1');
    let coarsenings = 0;
    const h = harness({
      imageSize: BIG,
      maxPixels: CAP,
      radius: 8,
      maxDownsample: 4,
      target,
      existingObjects: [existing],
      coarsen: (source) => {
        coarsenings++;
        return majorityCoarsen(source);
      },
    });
    down(h.tool, 1000, 1000);
    for (let x = 1010; x <= 1200; x += 10) move(h.tool, x, 1000);
    expect(coarsenings).toBeGreaterThan(0);
    expect(existing.visible).toBe(false);
    h.tool.cancel();
    expect(existing.visible).toBe(true);
    up(h.tool, 1200, 1000);
    expect(h.commits).toHaveLength(0);
  });

  it('refuses the whole stroke when the strategy fails, carrying the failure (#243 minor 1)', () => {
    const thrown = new Error('host strategy broke');
    const strategies: readonly [string, CoarsenStrategy][] = [
      [
        'throws',
        () => {
          throw thrown;
        },
      ],
      // The wrong downsample: the tool's own RangeError.
      ['unchanged', (source) => source],
    ];
    for (const [name, coarsen] of strategies) {
      const buffer = new BoundedDenseMaskBuffer({ imageWidth: BIG.width, imageHeight: BIG.height });
      stampCircle(buffer, 1000, 1000, 10, 1);
      const target = { annotationId: createAnnotationId('mask-1'), snapshot: buffer.raster() };
      const existing = committedObject('mask-1');
      const h = harness({
        imageSize: BIG,
        maxPixels: CAP,
        radius: 8,
        maxDownsample: 4,
        target,
        existingObjects: [existing],
        coarsen,
      });
      expect(() => sweep(h, 600), name).not.toThrow();
      // Reported once, then the stroke is over: no half-stroke is committed.
      expect(h.capacityErrors, name).toHaveLength(1);
      expect(h.commits, name).toHaveLength(0);
      const error = h.capacityErrors[0] as MaskCapacityExceededError;
      expect(error).toBeInstanceOf(MaskCapacityExceededError);
      expect(error.message, name).toMatch(/Coarsening it failed/);
      if (name === 'throws') expect(error.cause).toBe(thrown);
      else expect(error.cause).toBeInstanceOf(RangeError);
      expect(existing.visible, name).toBe(true);
    }
  });

  it("reads a refined mask's box without copying the mask (#243 minor 9)", () => {
    const buffer = new BoundedDenseMaskBuffer({ imageWidth: BIG.width, imageHeight: BIG.height });
    stampCircle(buffer, 1000, 1000, 20, 1);
    const target = { annotationId: createAnnotationId('mask-1'), snapshot: buffer.raster() };
    const h = harness({ imageSize: BIG, maxPixels: CAP, radius: 4, maxDownsample: 4, target });
    const raster = vi.spyOn(BoundedDenseMaskBuffer.prototype, 'raster');
    try {
      // At the disc's edge, so the tap changes the mask.
      down(h.tool, 1020, 1000);
      expect(raster).not.toHaveBeenCalled();
    } finally {
      raster.mockRestore();
    }
    up(h.tool, 1020, 1000);
    expect(h.capacityErrors).toEqual([]);
    expect(h.commits).toHaveLength(1);
  });

  it('never coarsens without maxDownsample, or with one that is not a power of two', () => {
    for (const maxDownsample of [undefined, 1, 3, Number.NaN, 0]) {
      const h = harness({
        imageSize: BIG,
        maxPixels: CAP,
        radius: 8,
        ...(maxDownsample !== undefined ? { maxDownsample } : {}),
      });
      sweep(h, 2000);
      expect(h.commits, `maxDownsample ${maxDownsample}`).toHaveLength(0);
      expect(h.capacityErrors).toHaveLength(1);
      expect(h.capacityErrors[0]!.message).not.toMatch(/maxDownsample/);
    }
  });

  it('coarsens by the strategy the host supplies', () => {
    const calls: number[] = [];
    const strategy: CoarsenStrategy = (source) => {
      calls.push(source.downsample);
      return majorityCoarsen(source);
    };
    const h = harness({
      imageSize: BIG,
      maxPixels: CAP,
      radius: 8,
      maxDownsample: 16,
      coarsen: strategy,
    });
    sweep(h, 600);
    expect(h.capacityErrors).toHaveLength(0);
    expect(calls.length).toBeGreaterThan(0);
    expect(calls[0]).toBe(1);
    expect(h.commits[0]!.snapshot.downsample).toBe(2 ** calls.length);
  });

  it('coarsens a first dab that alone overflows, twice, before any cell is set', () => {
    // A radius-120 dab is 241 x 241 cells at d=1 and 121 x 121 at d=2, both
    // past a 64 x 64 cap; it fits at d=4. The buffer is empty at the second
    // halving, and an empty buffer must still report its own grid.
    const h = harness({ imageSize: BIG, maxPixels: CAP, radius: 120, maxDownsample: 4 });
    down(h.tool, 2000, 2000);
    up(h.tool, 2000, 2000);
    expect(h.capacityErrors.map((e) => e.message)).toEqual([]);
    expect(h.commits[0]!.snapshot.downsample).toBe(4);
    expect(h.commits[0]!.snapshot.get(500, 500)).toBe(1);
  });

  it('keeps the mask when a coarsening leaves its buffer empty and a far dab follows (#243 P3)', () => {
    // Two isolated pixels: a 2x2 majority clears both but keeps a box covering
    // them. The dab, far to their left, then grew from an allocation with no
    // set cell; the copy wrote past the end, the RangeError escaped the stroke,
    // and the release committed an empty mask, which deletes the annotation.
    const buffer = new BoundedDenseMaskBuffer({ imageWidth: BIG.width, imageHeight: BIG.height });
    // Far enough out that, at d=2 as well, the dab and the cleared box
    // together pass the cap, which is what takes the cut-back path.
    buffer.set(10_000, 10, 1);
    buffer.set(10_060, 10, 1);
    const target = { annotationId: createAnnotationId('sparse'), snapshot: buffer.raster() };
    const h = harness({
      imageSize: BIG,
      maxPixels: CAP,
      radius: 3,
      maxDownsample: 4,
      target,
      viewport: { zoom: 1 / 8, width: 800, height: 800 },
    });
    expect(() => down(h.tool, 20, 10)).not.toThrow();
    up(h.tool, 20, 10);
    expect(h.capacityErrors.map((e) => e.message)).toEqual([]);
    expect(h.commits).toHaveLength(1);
    expect(h.commits[0]!.snapshot.cellCount).toBeGreaterThan(0);
  });

  it('refuses a paint stroke whose coarsening leaves the target empty, rather than deleting it (#243 Q1)', () => {
    // Two isolated pixels: a 2x2 majority clears both. The press is just off
    // the image's left edge, so at d=1 the dab reaches column 0, and its growth
    // passes the cap; at d=2 it covers no cell centre and paints nothing. The
    // result was an empty mask, committed under the target's id, which the
    // host reads as "erased to nothing" and deletes.
    const buffer = new BoundedDenseMaskBuffer({ imageWidth: 100, imageHeight: 100 });
    buffer.set(10, 10, 1);
    buffer.set(60, 60, 1);
    const target = { annotationId: createAnnotationId('sparse'), snapshot: buffer.raster() };
    const existing = committedObject('sparse');
    const h = harness({
      imageSize: { width: 100, height: 100 },
      maxPixels: 2_700,
      radius: 1.5,
      maxDownsample: 4,
      target,
      existingObjects: [existing],
      viewport: { zoom: 1 / 8, width: 800, height: 800 },
    });
    down(h.tool, -1, 50);
    up(h.tool, -1, 50);
    expect(h.commits).toHaveLength(0);
    expect(h.capacityErrors).toHaveLength(1);
    expect(h.capacityErrors[0]).toBeInstanceOf(MaskCapacityExceededError);
    expect(h.capacityErrors[0]!.message).toMatch(/would leave it empty/);
    expect(existing.visible).toBe(true);
  });

  it('commits a coarsened stroke even where it painted nothing new', () => {
    // A block of 100 x 21 cells under a cap of 2,150, and a stroke inside it
    // along its top row: every cell it paints is set already, but the region
    // it reserves reaches a row above the block, which passes the cap. The
    // mask changed grid, so it is a different mask, and is committed.
    const buffer = new BoundedDenseMaskBuffer({ imageWidth: BIG.width, imageHeight: BIG.height });
    for (let y = 990; y <= 1010; y++) for (let x = 1000; x < 1100; x++) buffer.set(x, y, 1);
    const target = { annotationId: createAnnotationId('mask-1'), snapshot: buffer.raster() };
    const h = harness({
      imageSize: BIG,
      maxPixels: 2_150,
      radius: 4,
      maxDownsample: 4,
      target,
      viewport: { zoom: 1, width: 800, height: 800 },
    });
    down(h.tool, 1020, 994);
    move(h.tool, 1080, 994);
    up(h.tool, 1080, 994);
    expect(h.capacityErrors.map((e) => e.message)).toEqual([]);
    expect(h.commits).toHaveLength(1);
    expect(h.commits[0]!.snapshot.downsample).toBe(2);
  });
});
