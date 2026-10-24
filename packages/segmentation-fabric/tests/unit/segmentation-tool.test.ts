import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Polygon, type Canvas, type FabricObject } from 'fabric';
import type { Point } from '@osdlabel/annotation';
import { createAnnotationContextId } from '@osdlabel/annotation-context';
import type { AddAnnotationParams, ToolCallbacks, ToolOverlay } from '@osdlabel/fabric-annotations';
import { createImageId, type KeyboardShortcutMap } from '@osdlabel/viewer-api';
import type {
  RasterMask,
  SegmentationPrompt,
  SegmentationProvider,
  SegmentationResult,
  SegmentationTarget,
} from '@osdlabel/segmentation';
import {
  SegmentationTool,
  type SegmentationMaskCommit,
  type SegmentationToolConfig,
  type SegmentationToolEvent,
} from '../../src/index.js';

const imageId = createImageId('img');
const contextId = createAnnotationContextId('ctx');
const IMAGE = { width: 400, height: 300 } as const;
const TARGET: SegmentationTarget = {
  imageKey: 'img',
  imageSize: IMAGE,
  viewport: { x: 0, y: 0, width: 400, height: 300 },
  viewportScale: 1,
};

/** A 16x16 logit grid at 4 image px per cell from (100, 50): a disc of radius 5 cells. */
function discRaster(radiusCells = 5): RasterMask {
  const n = 16;
  const data = new Float32Array(n * n);
  for (let v = 0; v < n; v++) {
    for (let u = 0; u < n; u++) {
      data[v * n + u] = Math.hypot(u + 0.5 - 8, v + 0.5 - 8) < radiusCells ? 6 : -6;
    }
  }
  return { frame: { originX: 100, originY: 50, pixelWidth: 4, pixelHeight: 4, width: n, height: n }, data };
}

function resultFor(raster: RasterMask, iou = 0.9): SegmentationResult {
  return {
    candidates: [
      { mask: raster, predictedIou: iou },
      { mask: discRaster(2), predictedIou: iou - 0.3 },
    ],
    view: { imageKey: 'img', imageSize: IMAGE, region: { x: 0, y: 0, width: 400, height: 300 }, scale: 1 },
  };
}

interface Deferred {
  readonly prompt: SegmentationPrompt;
  readonly signal: AbortSignal;
  resolve(r: SegmentationResult): void;
  reject(e: unknown): void;
}

/** A provider whose answers the test releases explicitly, in any order. */
function scriptedProvider(): SegmentationProvider & { readonly calls: Deferred[] } {
  const calls: Deferred[] = [];
  return {
    calls,
    capabilities: { box: true, negativePoints: true, multimask: true, maskInput: true, inputSize: 1024 },
    segment(_target, prompt, signal) {
      return new Promise<SegmentationResult>((resolve, reject) => {
        calls.push({ prompt, signal, resolve, reject });
      });
    },
  };
}

interface FakeCanvas {
  readonly objects: FabricObject[];
  add(...objs: FabricObject[]): number;
  remove(...objs: FabricObject[]): number;
  requestRenderAll(): void;
}

function fakeCanvas(): FakeCanvas {
  const objects: FabricObject[] = [];
  return {
    objects,
    add: (...objs) => objects.push(...objs),
    remove: (...objs) => {
      for (const o of objs) {
        const i = objects.indexOf(o);
        if (i !== -1) objects.splice(i, 1);
      }
      return objects.length;
    },
    requestRenderAll: () => {},
  };
}

function overlayFor(canvas: FakeCanvas): ToolOverlay {
  return {
    // A partial canvas is not a Canvas; this is the one cast, as in fabric-annotations' helpers.
    canvas: canvas as unknown as Canvas,
    imageToScreen: (p: Point) => p,
    pressSeqOf: () => undefined,
  };
}

function setup(config: Partial<SegmentationToolConfig> = {}) {
  const canvas = fakeCanvas();
  const provider = scriptedProvider();
  const events: SegmentationToolEvent[] = [];
  const commits: SegmentationMaskCommit[] = [];
  const added: AddAnnotationParams[] = [];
  const canAdd = vi.fn(() => true);
  const callbacks: ToolCallbacks = {
    getActiveContextId: () => contextId,
    getToolConstraint: () => undefined,
    canAddAnnotation: canAdd,
    addAnnotation: (p) => void added.push(p),
    updateAnnotation: () => {},
    deleteAnnotation: () => {},
    setSelectedAnnotation: () => {},
    getAnnotation: () => undefined,
  };
  const tool = new SegmentationTool({
    provider,
    getTarget: () => TARGET,
    onEvent: (e) => void events.push(e),
    onCommitMask: (c) => void commits.push(c),
    ...config,
  });
  // The tool reads no shortcut beyond BaseTool's delete keys.
  const shortcuts = { delete: 'Delete', deleteAlt: 'Backspace' } as KeyboardShortcutMap;
  tool.activate(overlayFor(canvas), imageId, callbacks, shortcuts);
  return { tool, canvas, provider, events, commits, added, canAdd };
}

const pointer = (init: MouseEventInit = {}): PointerEvent => new MouseEvent('pointerup', init) as PointerEvent;
const flush = () => new Promise<void>((r) => setTimeout(r, 0));

function click(tool: SegmentationTool, p: Point, init: MouseEventInit = {}): void {
  tool.onPointerDown(pointer(init), p);
  tool.onPointerUp(pointer(init), p);
}

beforeEach(() => {
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
    cb(performance.now());
    return 0;
  });
});
afterEach(() => vi.unstubAllGlobals());

describe('SegmentationTool prompts', () => {
  it('is the dedicated segmentation tool type by default', () => {
    expect(setup().tool.type).toBe('segmentation');
  });

  it('sends a click as a positive point and Alt/Shift-click as a negative one, in image space', async () => {
    const { tool, provider } = setup();
    click(tool, { x: 120, y: 80 });
    expect(provider.calls).toHaveLength(1);
    expect(provider.calls[0]!.prompt.points).toEqual([{ x: 120, y: 80, label: 1 }]);
    provider.calls[0]!.resolve(resultFor(discRaster()));
    await flush();
    click(tool, { x: 130, y: 90 }, { altKey: true });
    expect(provider.calls[1]!.prompt.points).toEqual([
      { x: 120, y: 80, label: 1 },
      { x: 130, y: 90, label: 0 },
    ]);
    // More than one point: the previous best logits go back in as mask_input.
    expect(tool.currentCandidate).not.toBeNull();
    expect(provider.calls[1]!.prompt.previous).toBe(tool.currentCandidate!.mask);
  });

  it('turns a drag past the threshold into a box prompt and removes the rubber band', () => {
    const { tool, provider, canvas } = setup();
    tool.onPointerDown(pointer(), { x: 100, y: 50 });
    tool.onPointerMove(pointer(), { x: 160, y: 120 });
    expect(canvas.objects).toHaveLength(1);
    tool.onPointerUp(pointer(), { x: 170, y: 130 });
    expect(canvas.objects).toHaveLength(0);
    expect(provider.calls[0]!.prompt.box).toEqual({ x: 100, y: 50, width: 70, height: 80 });
    expect(provider.calls[0]!.prompt.points).toBeUndefined();
  });

  it('draws the best candidate as read-only, id-less preview polygons', async () => {
    const { tool, provider, canvas, events } = setup();
    click(tool, { x: 132, y: 82 });
    provider.calls[0]!.resolve(resultFor(discRaster(), 0.95));
    await flush();
    expect(tool.currentCandidate?.predictedIou).toBe(0.95);
    expect(canvas.objects.length).toBeGreaterThan(0);
    for (const o of canvas.objects) {
      expect(o).toBeInstanceOf(Polygon);
      expect(o._readOnly).toBe(true);
      expect(o.id).toBeUndefined();
    }
    expect(events.map((e) => e.type)).toEqual(['result', 'painted']);
  });

  it('aborts a superseded prompt and ignores its late answer', async () => {
    const { tool, provider, canvas } = setup();
    click(tool, { x: 120, y: 80 });
    click(tool, { x: 125, y: 85 });
    expect(provider.calls[0]!.signal.aborted).toBe(true);
    provider.calls[1]!.resolve(resultFor(discRaster(3), 0.7));
    await flush();
    const after = canvas.objects.length;
    provider.calls[0]!.resolve(resultFor(discRaster(6), 0.99));
    await flush();
    expect(tool.currentCandidate?.predictedIou).toBe(0.7);
    expect(canvas.objects).toHaveLength(after);
  });

  it('reports provider errors as events, and swallows aborts', async () => {
    const { tool, provider, events } = setup();
    click(tool, { x: 120, y: 80 });
    provider.calls[0]!.reject(new DOMException('Aborted', 'AbortError'));
    await flush();
    expect(events).toHaveLength(0);
    click(tool, { x: 121, y: 80 });
    provider.calls[1]!.reject(new Error('model failed'));
    await flush();
    expect(events.map((e) => e.type)).toEqual(['error']);
  });
});

describe('SegmentationTool commit', () => {
  async function withResult(config: Partial<SegmentationToolConfig> = {}) {
    const h = setup(config);
    click(h.tool, { x: 132, y: 82 });
    h.provider.calls[0]!.resolve(resultFor(discRaster()));
    await flush();
    return h;
  }

  it('commits a #149 mask snapshot in image pixels by default and clears the preview', async () => {
    const { tool, commits, canvas } = await withResult();
    expect(tool.commit()).toBe('mask');
    expect(commits).toHaveLength(1);
    const s = commits[0]!.snapshot;
    // Disc of radius 5 cells x 4 px centred on (132, 82): about 40 px across.
    expect(s.imageWidth).toBe(400);
    expect(s.x).toBeGreaterThanOrEqual(110);
    expect(s.x + s.width).toBeLessThanOrEqual(154);
    expect(s.width).toBeGreaterThan(34);
    let set = 0;
    for (const v of s.data) set += v;
    expect(set / (Math.PI * 20 * 20)).toBeGreaterThan(0.85);
    expect(set / (Math.PI * 20 * 20)).toBeLessThan(1.15);
    expect(commits[0]!.contextId).toBe(contextId);
    expect(canvas.objects).toHaveLength(0);
    expect(tool.currentCandidate).toBeNull();
  });

  it('falls back to a polygon when the mask would exceed the cap, and says so', async () => {
    const { tool, commits, added, events } = await withResult({ maxPixels: 100 });
    expect(tool.commit()).toBe('polygon');
    expect(commits).toHaveLength(0);
    expect(events.some((e) => e.type === 'capacity')).toBe(true);
    expect(added).toHaveLength(1);
    expect(added[0]!.type).toBe('polyline');
    expect(added[0]!.fabricObject).toBeInstanceOf(Polygon);
    expect(added[0]!.fabricObject.id).toBeDefined();
  });

  it('refuses rather than falls back when fallbackToPolygon is false', async () => {
    const { tool, commits, added } = await withResult({ maxPixels: 100, fallbackToPolygon: false });
    expect(tool.commit()).toBeNull();
    expect(commits).toHaveLength(0);
    expect(added).toHaveLength(0);
  });

  it('commits a polygon on request under the configured polygon tool type', async () => {
    const { tool, added, canAdd } = await withResult({ polygonToolType: 'polyline' });
    expect(tool.commit('polygon')).toBe('polygon');
    expect(canAdd).toHaveBeenCalledWith('polyline');
    const poly = added[0]!.fabricObject;
    expect(poly).toBeInstanceOf(Polygon);
  });

  it('respects the constraint layer for masks', async () => {
    const { tool, commits, canAdd } = await withResult();
    canAdd.mockReturnValue(false);
    expect(tool.commit('mask')).toBeNull();
    expect(canAdd).toHaveBeenCalledWith('segmentation');
    expect(commits).toHaveLength(0);
  });

  it('Enter commits, Escape discards, deactivate cleans up', async () => {
    const a = await withResult();
    expect(a.tool.onKeyDown(new KeyboardEvent('keydown', { key: 'Enter' }))).toBe(true);
    expect(a.commits).toHaveLength(1);

    const b = await withResult();
    expect(b.tool.onKeyDown(new KeyboardEvent('keydown', { key: 'Escape' }))).toBe(true);
    expect(b.canvas.objects).toHaveLength(0);
    expect(b.tool.commit()).toBeNull();

    const c = await withResult();
    c.tool.deactivate();
    expect(c.canvas.objects).toHaveLength(0);
  });
});
