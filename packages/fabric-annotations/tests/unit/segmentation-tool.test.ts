import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Polygon, type Canvas, type FabricObject } from 'fabric';
import type { Point } from '@osdlabel/annotation';
import type { ImageId } from '@osdlabel/viewer-api';
import type { AnnotationContextId } from '@osdlabel/annotation-context';
import type {
  SegmentationProvider,
  SegmentationImageRef,
  SegmentationPrompt,
} from '@osdlabel/segmentation';
import { SegmentationTool } from '../../src/tools/segmentation-tool.js';
import type { ToolOverlay } from '../../src/types.js';
import type { ToolCallbacks, AddAnnotationParams } from '../../src/tools/base-tool.js';
import { getGeometryFromFabricObject } from '../../src/fabric-utils.js';
import { initFabricModule } from '../../src/fabric-module.js';
import { createTestKeyboardShortcuts } from './test-helpers.js';

initFabricModule();

const imageId = 'img-1' as ImageId;
const contextId = 'ctx-1' as AnnotationContextId;

/** Minimal fake canvas recording the objects the tool adds/removes. */
class FakeCanvas {
  objects: FabricObject[] = [];
  add(...objs: FabricObject[]): void {
    this.objects.push(...objs);
  }
  remove(...objs: FabricObject[]): void {
    this.objects = this.objects.filter((o) => !objs.includes(o));
  }
  requestRenderAll(): void {}
  getZoom(): number {
    return 1;
  }
  getActiveObjects(): FabricObject[] {
    return [];
  }
}

/** A square contour around the prompt, used as a deterministic mask. */
const SQUARE: readonly Point[] = [
  { x: 20, y: 20 },
  { x: 40, y: 20 },
  { x: 40, y: 40 },
  { x: 20, y: 40 },
];

interface Harness {
  readonly tool: SegmentationTool;
  readonly canvas: FakeCanvas;
  readonly added: AddAnnotationParams[];
  readonly prompts: SegmentationPrompt[];
  readonly prepareCount: () => number;
}

function setup(opts?: { canAdd?: boolean }): Harness {
  const canvas = new FakeCanvas();
  const overlay: ToolOverlay = {
    canvas: canvas as unknown as Canvas,
    imageToScreen: (p: Point) => p, // identity: screen distance == image distance
  };

  const prompts: SegmentationPrompt[] = [];
  let prepareCount = 0;
  const provider: SegmentationProvider = {
    async prepare(_image, _signal) {
      prepareCount += 1;
    },
    async segment(_image, prompt, _signal) {
      prompts.push(prompt);
      return { contours: [SQUARE], score: 0.8 };
    },
  };

  const ref: SegmentationImageRef = {
    imageId,
    tileSource: 'x',
    getViewportCanvas: () => null,
  };

  const added: AddAnnotationParams[] = [];
  const callbacks: ToolCallbacks = {
    getActiveContextId: () => contextId,
    getToolConstraint: () => undefined,
    canAddAnnotation: () => opts?.canAdd ?? true,
    addAnnotation: (params) => added.push(params),
    updateAnnotation: () => {},
    deleteAnnotation: () => {},
    setSelectedAnnotation: () => {},
    getAnnotation: () => undefined,
  };

  const tool = new SegmentationTool({ provider, getImageRef: () => ref });
  tool.activate(overlay, imageId, callbacks, createTestKeyboardShortcuts());

  return { tool, canvas, added, prompts, prepareCount: () => prepareCount };
}

const evt = (altKey = false): PointerEvent => ({ altKey }) as unknown as PointerEvent;
const enter = (): KeyboardEvent => ({ key: 'Enter' }) as unknown as KeyboardEvent;
const escape = (): KeyboardEvent => ({ key: 'Escape' }) as unknown as KeyboardEvent;

const hasPreviewPolygon = (canvas: FakeCanvas): boolean =>
  canvas.objects.some((o) => o instanceof Polygon);

describe('SegmentationTool', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('calls prepare once on activation', () => {
    const h = setup();
    expect(h.prepareCount()).toBe(1);
  });

  it('segments from a box drag and commits a polygon annotation on finish', async () => {
    const h = setup();
    h.tool.onPointerDown(evt(), { x: 10, y: 10 });
    h.tool.onPointerMove(evt(), { x: 50, y: 50 });
    h.tool.onPointerUp(evt(), { x: 50, y: 50 });

    await vi.waitFor(() => expect(h.prompts.length).toBe(1));
    expect(h.prompts[0]?.box).toEqual({ x: 10, y: 10, width: 40, height: 40 });
    await vi.waitFor(() => expect(hasPreviewPolygon(h.canvas)).toBe(true));

    const consumed = h.tool.onKeyDown(enter());
    expect(consumed).toBe(true);
    expect(h.added).toHaveLength(1);

    const params = h.added[0]!;
    expect(params.type).toBe('segmentation');
    expect(params.imageId).toBe(imageId);
    expect(params.contextId).toBe(contextId);

    const geometry = getGeometryFromFabricObject(params.fabricObject, 'polygon');
    expect(geometry?.type).toBe('polygon');
    if (geometry?.type !== 'polygon') return;
    expect(geometry.points).toHaveLength(4);
    expect(geometry.points[0]?.x).toBeCloseTo(20);
    expect(geometry.points[2]?.y).toBeCloseTo(40);
  });

  it('accumulates positive and negative point clicks', async () => {
    const h = setup();
    // A click (no drag) adds a positive point.
    h.tool.onPointerDown(evt(), { x: 30, y: 30 });
    h.tool.onPointerUp(evt(), { x: 30, y: 30 });
    await vi.waitFor(() => expect(h.prompts.length).toBe(1));
    expect(h.prompts[0]?.points).toEqual([{ x: 30, y: 30, label: 1 }]);

    // Alt-click adds a background (negative) point; both points are sent.
    h.tool.onPointerDown(evt(true), { x: 35, y: 35 });
    h.tool.onPointerUp(evt(true), { x: 35, y: 35 });
    await vi.waitFor(() => expect(h.prompts.length).toBe(2));
    expect(h.prompts[1]?.points).toEqual([
      { x: 30, y: 30, label: 1 },
      { x: 35, y: 35, label: 0 },
    ]);
  });

  it('does not commit when no prompt has been made', () => {
    const h = setup();
    const consumed = h.tool.onKeyDown(enter());
    expect(consumed).toBe(false);
    expect(h.added).toHaveLength(0);
  });

  it('cancels the in-progress prompt and clears the preview on Escape', async () => {
    const h = setup();
    h.tool.onPointerDown(evt(), { x: 30, y: 30 });
    h.tool.onPointerUp(evt(), { x: 30, y: 30 });
    await vi.waitFor(() => expect(hasPreviewPolygon(h.canvas)).toBe(true));

    const consumed = h.tool.onKeyDown(escape());
    expect(consumed).toBe(true);
    expect(hasPreviewPolygon(h.canvas)).toBe(false);

    // After cancel, finishing does nothing.
    expect(h.tool.onKeyDown(enter())).toBe(false);
    expect(h.added).toHaveLength(0);
  });

  it('drops stale results from superseded prompts', async () => {
    const canvas = new FakeCanvas();
    const overlay: ToolOverlay = {
      canvas: canvas as unknown as Canvas,
      imageToScreen: (p: Point) => p,
    };
    // First segment call hangs until released; second resolves immediately.
    let releaseFirst: (() => void) | null = null;
    let call = 0;
    const provider: SegmentationProvider = {
      async prepare() {},
      async segment(_image, _prompt, _signal) {
        call += 1;
        if (call === 1) {
          await new Promise<void>((resolve) => {
            releaseFirst = resolve;
          });
          return { contours: [SQUARE] };
        }
        return {
          contours: [
            [
              { x: 0, y: 0 },
              { x: 5, y: 0 },
              { x: 5, y: 5 },
            ],
          ],
        };
      },
    };
    const added: AddAnnotationParams[] = [];
    const callbacks: ToolCallbacks = {
      getActiveContextId: () => contextId,
      getToolConstraint: () => undefined,
      canAddAnnotation: () => true,
      addAnnotation: (p) => added.push(p),
      updateAnnotation: () => {},
      deleteAnnotation: () => {},
      setSelectedAnnotation: () => {},
      getAnnotation: () => undefined,
    };
    const tool = new SegmentationTool({
      provider,
      getImageRef: () => ({ imageId, tileSource: 'x', getViewportCanvas: () => null }),
    });
    tool.activate(overlay, imageId, callbacks, createTestKeyboardShortcuts());

    tool.onPointerDown(evt(), { x: 30, y: 30 });
    tool.onPointerUp(evt(), { x: 30, y: 30 }); // first (hanging) prompt
    tool.onPointerDown(evt(), { x: 31, y: 31 });
    tool.onPointerUp(evt(), { x: 31, y: 31 }); // second prompt supersedes

    // Let the second (latest) result render.
    await vi.waitFor(() => expect(hasPreviewPolygon(canvas)).toBe(true));
    // Now release the stale first result — it must be ignored.
    releaseFirst?.();
    await Promise.resolve();
    await Promise.resolve();

    tool.onKeyDown(enter());
    expect(added).toHaveLength(1);
    const geometry = getGeometryFromFabricObject(added[0]!.fabricObject, 'polygon');
    expect(geometry?.type).toBe('polygon');
    if (geometry?.type !== 'polygon') return;
    // The committed mask is the *second* (triangle), not the stale square.
    expect(geometry.points).toHaveLength(3);
  });
});
