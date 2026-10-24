import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type OpenSeadragon from 'openseadragon';
import { createCanvasTileSource } from '../../src/canvas-tile-source.js';
import { FramePresenter } from '../../src/frame-presenter.js';
import { isFramedImageSource } from '../../src/framed-image-source.js';
import type { FrameSource } from '../../src/frame-source.js';

// jsdom has no canvas backend: hand out a fake 2D context bound to its canvas.
beforeEach(() => {
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(function (
    this: HTMLCanvasElement,
  ) {
    return { canvas: this } as unknown as CanvasRenderingContext2D;
  } as never);
});
afterEach(() => vi.restoreAllMocks());

function source(count: number, resident: (i: number) => boolean = () => true) {
  const painted: number[] = [];
  const s: FrameSource = {
    width: 512,
    height: 256,
    count,
    paint: (i) => {
      if (!resident(i)) return false;
      painted.push(i);
      return true;
    },
  };
  return { s, painted };
}

function viewer(drawerType: 'webgl' | 'canvas') {
  const raised: { name: string; args: object }[] = [];
  const items: { source: unknown; redraw: () => void }[] = [];
  const v = {
    drawer: { getType: () => drawerType },
    forceRedraw: vi.fn(),
    // The world holds what was opened, as OSD's does after `open`.
    open: vi.fn((tileSource: unknown) => {
      items.push({ source: tileSource, redraw: vi.fn() });
    }),
    world: {
      getItemCount: () => items.length,
      getItemAt: (i: number) => items[i],
    },
    raiseEvent: (name: string, args: object) => raised.push({ name, args }),
  };
  return { v: v as unknown as OpenSeadragon.Viewer, raised, forceRedraw: v.forceRedraw, items };
}

describe('createCanvasTileSource', () => {
  it('serves one top-level tile synchronously from the provided context', () => {
    const ctx = { canvas: document.createElement('canvas') } as unknown as CanvasRenderingContext2D;
    const ts = createCanvasTileSource({
      width: 512,
      height: 256,
      cacheKey: 'k',
      provide: () => ctx,
    });
    const hooks = ts as unknown as {
      minLevel: number;
      maxLevel: number;
      getTileUrl(l: number, x: number, y: number): string;
      downloadTileStart(job: { finish: (d: unknown, r: unknown) => void }): void;
      createTileCache(c: object, d: unknown): void;
      getTileCacheDataAsContext2D(c: object): unknown;
      hasTransparency(): boolean;
    };
    expect(hooks.minLevel).toBe(9);
    expect(hooks.maxLevel).toBe(9);
    expect(hooks.getTileUrl(9, 0, 0)).toBe('osdlabel-frame://k/9/0_0');
    let finished: unknown;
    hooks.downloadTileStart({ finish: (d) => (finished = d) });
    expect(finished).toBe(ctx);
    const cache = {};
    hooks.createTileCache(cache, ctx);
    expect(hooks.getTileCacheDataAsContext2D(cache)).toBe(ctx);
    expect(hooks.hasTransparency()).toBe(false);
  });
});

describe('FramePresenter', () => {
  it('paints the initial frame and repaints in place on show', () => {
    const { s, painted } = source(300);
    const { v, forceRedraw } = viewer('canvas');
    const p = new FramePresenter(v, s, { initialFrame: 10 });
    expect(painted).toEqual([10]);
    expect(p.show(11)).toBe(true);
    expect(p.frame).toBe(11);
    expect(painted).toEqual([10, 11]);
    expect(forceRedraw).toHaveBeenCalledTimes(1);
  });

  it("marks its own TiledImage for redraw, which OSD's forceRedraw reset cannot undo", () => {
    const { s } = source(5);
    const { v, items } = viewer('canvas');
    v.open(
      createCanvasTileSource({
        width: 1,
        height: 1,
        cacheKey: 'other',
        provide: () => ({}) as CanvasRenderingContext2D,
      }),
    );
    const p = new FramePresenter(v, s);
    p.open();
    expect(items).toHaveLength(2);
    p.show(1);
    expect(items[0]!.redraw).not.toHaveBeenCalled();
    expect(items[1]!.redraw).toHaveBeenCalledTimes(1);
  });

  it('clamps and skips a no-op show', () => {
    const { s, painted } = source(5);
    const { v } = viewer('canvas');
    const p = new FramePresenter(v, s);
    p.show(99);
    expect(p.frame).toBe(4);
    p.show(4);
    expect(painted).toEqual([0, 4]);
  });

  it('keeps the current frame when the source does not have the next one yet', () => {
    const { s } = source(5, (i) => i !== 3);
    const { v, forceRedraw } = viewer('canvas');
    const p = new FramePresenter(v, s);
    expect(p.show(3)).toBe(false);
    expect(p.frame).toBe(0);
    expect(forceRedraw).not.toHaveBeenCalled();
  });

  it("drops the WebGL drawer's cached texture through its image-unloaded event", () => {
    const { s } = source(5);
    const webgl = viewer('webgl');
    new FramePresenter(webgl.v, s).show(1);
    expect(webgl.raised.map((e) => e.name)).toEqual(['image-unloaded']);
    const canvas = viewer('canvas');
    new FramePresenter(canvas.v, s).show(1);
    expect(canvas.raised).toEqual([]);
  });
});

describe('isFramedImageSource', () => {
  it('recognises a source with an axis and a pixel provider', () => {
    const base = { id: 'a' as never, tileSource: 'x.png' };
    expect(isFramedImageSource(base)).toBe(false);
    expect(isFramedImageSource(undefined)).toBe(false);
    expect(
      isFramedImageSource({
        ...base,
        frameAxis: { kind: 'spatial', count: 2 },
        frameSource: source(2).s,
      } as never),
    ).toBe(true);
  });
});
