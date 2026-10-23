/**
 * The four ways the PoC presents frame i of a stack in one OSD viewer.
 *
 *  (a)  `open`         viewer.open() a fresh single-tile source per frame
 *  (a') `open-png`     viewer.open({type:'image'}) a PNG blob URL per frame —
 *                      what "one ImageId per slice" does with today's openImage
 *  (b)  `reset`        one TiledImage; its source serves the *current* frame;
 *                      tiledImage.reset() + forceRedraw re-fetches the tile
 *  (c)  `opacity`      one preloaded TiledImage per frame, toggled by opacity
 *  (d)  `mutable`      one TiledImage, one tile canvas repainted in place
 *                      (FramePresenter from @osdlabel/frame-osd)
 */
import OpenSeadragon from 'openseadragon';
import type { FrameSource } from '@osdlabel/frame-osd';
import { createCanvasTileSource, createFrameCanvas, FramePresenter } from '@osdlabel/frame-osd';

export type StrategyName =
  | 'open'
  | 'open-png'
  | 'reset'
  | 'opacity'
  | 'mutable'
  /** Negative control: mutable tile WITHOUT the WebGL texture invalidation. */
  | 'mutable-noinval';

export interface DisplayStrategy {
  readonly name: StrategyName;
  /** Open the initial frame; resolves on OSD 'open' (the overlay can attach then). */
  open(): Promise<void>;
  /** Present frame `index`. Synchronous request; OSD draws at its next frame. */
  show(index: number): void;
  dispose(): void;
}

function onceOpen(viewer: OpenSeadragon.Viewer): Promise<void> {
  return new Promise((resolve, reject) => {
    viewer.addOnceHandler('open', () => resolve());
    viewer.addOnceHandler('open-failed', (e) => reject(new Error(String(e.message))));
  });
}

/** A fresh canvas painted with frame `index`. */
function paintedCanvas(source: FrameSource, index: number): CanvasRenderingContext2D {
  const ctx = createFrameCanvas(source.width, source.height);
  source.paint(index, ctx);
  return ctx;
}

export class OpenPerFrame implements DisplayStrategy {
  readonly name = 'open' as const;
  constructor(
    private readonly viewer: OpenSeadragon.Viewer,
    private readonly source: FrameSource,
  ) {}

  private tileSourceFor(index: number): OpenSeadragon.TileSource {
    return createCanvasTileSource({
      width: this.source.width,
      height: this.source.height,
      cacheKey: `open-${index}`,
      provide: () => paintedCanvas(this.source, index),
    });
  }

  open(): Promise<void> {
    const p = onceOpen(this.viewer);
    this.viewer.open(this.tileSourceFor(0));
    return p;
  }

  show(index: number): void {
    this.viewer.open(this.tileSourceFor(index));
  }

  dispose(): void {}
}

export class OpenPngPerFrame implements DisplayStrategy {
  readonly name = 'open-png' as const;
  constructor(
    private readonly viewer: OpenSeadragon.Viewer,
    private readonly urls: readonly string[],
  ) {}

  open(): Promise<void> {
    const p = onceOpen(this.viewer);
    this.viewer.open({ type: 'image', url: this.urls[0]!, buildPyramid: false } as never);
    return p;
  }

  show(index: number): void {
    this.viewer.open({ type: 'image', url: this.urls[index]!, buildPyramid: false } as never);
  }

  dispose(): void {
    for (const u of this.urls) URL.revokeObjectURL(u);
  }
}

export class ResetInPlace implements DisplayStrategy {
  readonly name = 'reset' as const;
  private target = 0;
  constructor(
    private readonly viewer: OpenSeadragon.Viewer,
    private readonly source: FrameSource,
  ) {}

  open(): Promise<void> {
    const p = onceOpen(this.viewer);
    this.viewer.open(
      createCanvasTileSource({
        width: this.source.width,
        height: this.source.height,
        cacheKey: 'reset',
        // Read at load time: whatever frame is current when OSD re-fetches.
        provide: () => paintedCanvas(this.source, this.target),
      }),
    );
    return p;
  }

  show(index: number): void {
    this.target = index;
    const item = this.viewer.world.getItemAt(0);
    if (!item) return;
    item.reset();
    // OSD 5.0.1: reset() alone does not re-fetch. update() only re-plans tiles
    // when a spring moved, the viewport changed, the item is not fully loaded
    // or `_needsUpdate` is set — and reset() sets none of them, so the item
    // stays blank until the user pans. setClip(getClip()) is the cheapest
    // public call that sets `_needsUpdate` without changing anything.
    item.setClip(item.getClip());
    this.viewer.forceRedraw();
  }

  dispose(): void {}
}

export class OpacityPreload implements DisplayStrategy {
  readonly name = 'opacity' as const;
  private items: OpenSeadragon.TiledImage[] = [];
  private current = 0;
  constructor(
    private readonly viewer: OpenSeadragon.Viewer,
    private readonly source: FrameSource,
  ) {}

  async open(): Promise<void> {
    const p = onceOpen(this.viewer);
    this.viewer.open(this.tileSourceFor(0));
    await p;
    this.items = [this.viewer.world.getItemAt(0)];
    for (let i = 1; i < this.source.count; i++) {
      this.items.push(
        await new Promise<OpenSeadragon.TiledImage>((resolve, reject) => {
          this.viewer.addTiledImage({
            tileSource: this.tileSourceFor(i),
            opacity: 0,
            preload: true,
            success: (e: { item: OpenSeadragon.TiledImage }) => resolve(e.item),
            error: () => reject(new Error(`addTiledImage ${i} failed`)),
          } as never);
        }),
      );
    }
  }

  private tileSourceFor(index: number): OpenSeadragon.TileSource {
    return createCanvasTileSource({
      width: this.source.width,
      height: this.source.height,
      cacheKey: `pre-${index}`,
      provide: () => paintedCanvas(this.source, index),
    });
  }

  show(index: number): void {
    if (index === this.current) return;
    this.items[this.current]?.setOpacity(0);
    this.items[index]?.setOpacity(1);
    this.current = index;
  }

  dispose(): void {}
}

export class MutableTile implements DisplayStrategy {
  readonly name = 'mutable' as const;
  readonly presenter: FramePresenter;
  constructor(
    private readonly viewer: OpenSeadragon.Viewer,
    source: FrameSource,
  ) {
    this.presenter = new FramePresenter(viewer, source);
  }

  open(): Promise<void> {
    const p = onceOpen(this.viewer);
    this.presenter.open();
    return p;
  }

  show(index: number): void {
    this.presenter.show(index);
  }

  dispose(): void {}
}

/**
 * Negative control for the pixel verifier: paints the presenter's tile canvas
 * but skips the WebGL texture invalidation, so with the WebGL drawer the
 * screen keeps showing the first uploaded frame while the tag says otherwise.
 */
export class MutableTileNoInvalidate implements DisplayStrategy {
  readonly name = 'mutable-noinval' as const;
  private readonly presenter: FramePresenter;
  constructor(
    private readonly viewer: OpenSeadragon.Viewer,
    private readonly source: FrameSource,
  ) {
    this.presenter = new FramePresenter(viewer, source);
  }

  open(): Promise<void> {
    const p = onceOpen(this.viewer);
    this.presenter.open();
    return p;
  }

  show(index: number): void {
    const ctx = this.presenter.canvas.getContext('2d');
    if (ctx) this.source.paint(index, ctx);
    this.viewer.forceRedraw();
  }

  dispose(): void {}
}

/** PNG blob URLs for a stack (for `open-png`); cost reported as setup. */
export async function encodePngUrls(source: FrameSource): Promise<string[]> {
  const canvas = new OffscreenCanvas(source.width, source.height);
  const off = canvas.getContext('2d');
  const scratch = createFrameCanvas(source.width, source.height);
  if (!off) throw new Error('OffscreenCanvas 2D unavailable');
  const urls: string[] = [];
  for (let i = 0; i < source.count; i++) {
    source.paint(i, scratch);
    off.drawImage(scratch.canvas, 0, 0);
    const blob = await canvas.convertToBlob({ type: 'image/png' });
    urls.push(URL.createObjectURL(blob));
  }
  return urls;
}
