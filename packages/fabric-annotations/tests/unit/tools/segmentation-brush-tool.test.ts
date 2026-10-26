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
  snapshotCellCount,
  snapshotImageBox,
  snapshotPixelCount,
  stampCircle,
  toDenseSnapshot,
  type MaskRaster,
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
    add: ReturnType<typeof vi.fn>;
    remove: ReturnType<typeof vi.fn>;
    bringObjectToFront: ReturnType<typeof vi.fn>;
  };
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
  } = {},
): Harness {
  const objects: FabricObject[] = [...(options.existingObjects ?? [])];
  const commits: BrushStrokeCommit[] = [];
  const capacityErrors: BrushCapacityError[] = [];
  const radiusAdjustments: (1 | -1)[] = [];

  const canvas = {
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
    getZoom: () => options.viewport?.zoom ?? 1,
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
      const { canvas, fill } = commit.preview!;
      const cells = commit.snapshot.cells;
      expect([canvas.width, canvas.height]).toEqual([cells.width, cells.height]);

      const rendered = buildMaskFabricObject(
        { format: MASK_RAW_FORMAT, data: { ...encodeCanonical(commit.snapshot), fill } },
        { id: 'x' },
      ) as FabricImage;
      const expected = (rendered.getElement() as HTMLCanvasElement)
        .getContext('2d')!
        .getImageData(0, 0, cells.width, cells.height).data;
      const actual = canvas.getContext('2d')!.getImageData(0, 0, cells.width, cells.height).data;
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

  it('is absent when nothing was previewed', () => {
    // No overlay canvas to preview on: the commit still lands, without one.
    const h = harness();
    (h.tool as unknown as { overlay: unknown }).overlay = null;
    down(h.tool, 60, 50);
    up(h.tool, 60, 50);
    expect(h.commits[0]?.preview).toBeUndefined();
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
    // switch the brush off and lose the stroke; the key waits for the release.
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
    const side = 4096;
    const { allocatedPixels } = measureSweep(side);
    expect(allocatedPixels).toBeLessThan(4 * side * side);
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
    const h = harness({ imageSize: BIG, maxPixels: CAP, radius: 30, target });
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

  it('refines an existing mask at its own resolution, whatever the zoom', () => {
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
      viewport: { zoom: 4, width: 800, height: 800 },
    });
    down(h.tool, 5050, 5000);
    up(h.tool, 5050, 5000);
    const committed = h.commits[0]!.snapshot;
    expect(committed.downsample).toBe(4);
    expect(snapshotCellCount(committed)).toBeGreaterThan(snapshotCellCount(target.snapshot));
  });
});
