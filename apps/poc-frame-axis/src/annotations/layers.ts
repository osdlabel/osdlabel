/**
 * Building per-frame `OsdAnnotation`s with real Fabric payloads, and the four
 * ways the PoC swaps the annotation layer when the frame changes.
 *
 *  `rebuild-async`  today's ViewerCell: clear every annotation object, revive
 *                   each from rawAnnotationData (Fabric enlivenObjects, async)
 *  `rebuild-sync`   clear, rebuild from geometry synchronously
 *  `cache`          per-frame object cache: remove one frame's objects, add the
 *                   next frame's (built once)
 *  `visibility`     every frame's objects on the canvas; toggle `visible`
 */
import type { FabricObject } from 'fabric';
import type { AnnotationId, VectorGeometry } from '@osdlabel/annotation';
import { DEFAULT_ANNOTATION_STYLE } from '@osdlabel/annotation';
import {
  buildFabricObjectFromGeometry,
  createFabricObjectFromRawData,
  getFabricOptions,
  initFabricModule,
  serializeFabricObject,
} from '@osdlabel/fabric-annotations';
import type { FabricOverlay } from '@osdlabel/fabric-osd';
import type { AnnotationContextId } from '@osdlabel/annotation-context';
import type { ImageId } from '@osdlabel/viewer-api';
import type { OsdAnnotation } from 'osdlabel';
import type { FixtureSpec } from './fixtures.js';

export type AnnotationSwapName = 'rebuild-async' | 'rebuild-sync' | 'cache' | 'visibility';

const STYLES = ['#ffcc00', '#00e5ff', '#ff4081', '#76ff03'] as const;

export function buildAnnotation(
  spec: FixtureSpec,
  imageId: ImageId,
  contextId: AnnotationContextId,
  frameKey: string | undefined,
): OsdAnnotation {
  // Fixtures may be serialized before any FabricOverlay exists (the Solid
  // harness builds them before mounting). Without the `id` custom property the
  // payload carries no id, and ViewerCell — which clears annotation objects by
  // `obj.id` — then never removes the revived objects: they pile up on the
  // canvas (found here: 1720 stray objects after three scroll passes).
  initFabricModule();
  const id = `f${spec.frame}-a${spec.ordinal}` as AnnotationId;
  const style = {
    ...DEFAULT_ANNOTATION_STYLE,
    strokeColor: STYLES[spec.ordinal % STYLES.length]!,
    strokeWidth: 2,
    fillOpacity: 0.08,
  };
  const obj = buildFabricObjectFromGeometry(spec.geometry, getFabricOptions(style, id), 3);
  const toolType = spec.geometry.type === 'polygon' ? 'polyline' : spec.geometry.type;
  return {
    id,
    imageId,
    contextId,
    toolType,
    geometry: spec.geometry,
    rawAnnotationData: serializeFabricObject(obj),
    createdAt: '2026-10-23T00:00:00.000Z',
    updatedAt: '2026-10-23T00:00:00.000Z',
    ...(spec.label !== undefined ? { label: spec.label } : {}),
    frame: { index: spec.frame, ...(frameKey !== undefined ? { key: frameKey } : {}) },
  };
}

/** Harness-wide Fabric object caching switch (Fabric's default is on). */
export const fabricTuning = { objectCaching: true };

function syncObject(a: OsdAnnotation): FabricObject {
  const style = {
    ...DEFAULT_ANNOTATION_STYLE,
    strokeColor: String(a.rawAnnotationData.data['stroke'] ?? '#fff'),
    strokeWidth: 2,
    fillOpacity: 0.08,
  };
  const obj = buildFabricObjectFromGeometry(
    a.geometry as VectorGeometry,
    getFabricOptions(style, a.id),
    3,
  );
  obj.objectCaching = fabricTuning.objectCaching;
  return obj;
}

export interface AnnotationLayer {
  readonly name: AnnotationSwapName;
  /** Frame whose objects are on the canvas now (-1 while cleared mid-rebuild). */
  readonly current: number;
  /** One-off setup (e.g. pre-building a cache). Resolves when ready. */
  init(): Promise<void>;
  /** Swap to frame `index`. The synchronous part runs now; async parts finish later. */
  show(index: number): void;
  /** Resolves when the most recent `show` has its objects on the canvas. */
  settled(): Promise<void>;
  dispose(): void;
}

abstract class BaseLayer implements AnnotationLayer {
  abstract readonly name: AnnotationSwapName;
  current = -1;
  protected pending: Promise<void> = Promise.resolve();
  constructor(
    protected readonly overlay: FabricOverlay,
    protected readonly byFrame: readonly (readonly OsdAnnotation[])[],
  ) {}
  async init(): Promise<void> {}
  abstract show(index: number): void;
  settled(): Promise<void> {
    return this.pending;
  }
  protected clearAnnotations(): void {
    const canvas = this.overlay.canvas;
    const toRemove = canvas.getObjects().filter((o) => o.id);
    // In chunks, like VisibilityLayer.init: 60 000 arguments overflow the stack.
    for (let i = 0; i < toRemove.length; i += 1000) canvas.remove(...toRemove.slice(i, i + 1000));
  }
  protected prepare(objs: FabricObject[]): void {
    for (const o of objs) {
      this.overlay.applyModeToObject(o, false);
      o.objectCaching = fabricTuning.objectCaching;
    }
  }
  dispose(): void {
    this.clearAnnotations();
  }
}

/** Mirrors ViewerCell's rebuild effect: clear, then revive asynchronously. */
export class RebuildAsyncLayer extends BaseLayer {
  readonly name = 'rebuild-async' as const;
  private generation = 0;
  show(index: number): void {
    const gen = ++this.generation;
    this.clearAnnotations();
    this.current = -1;
    const anns = this.byFrame[index] ?? [];
    this.pending = (async () => {
      const objs = await Promise.all(anns.map((a) => createFabricObjectFromRawData(a)));
      if (gen !== this.generation) return;
      const ok = objs.filter((o): o is FabricObject => o !== null);
      this.prepare(ok);
      if (ok.length > 0) this.overlay.canvas.add(...ok);
      this.current = index;
      this.overlay.canvas.requestRenderAll();
    })();
    this.overlay.canvas.requestRenderAll();
  }
}

export class RebuildSyncLayer extends BaseLayer {
  readonly name = 'rebuild-sync' as const;
  show(index: number): void {
    this.clearAnnotations();
    const objs = (this.byFrame[index] ?? []).map(syncObject);
    this.prepare(objs);
    if (objs.length > 0) this.overlay.canvas.add(...objs);
    this.current = index;
    this.overlay.canvas.requestRenderAll();
  }
}

export class CacheLayer extends BaseLayer {
  readonly name = 'cache' as const;
  private readonly cache = new Map<number, FabricObject[]>();
  buildMs = 0;
  async init(): Promise<void> {
    const t0 = performance.now();
    for (let f = 0; f < this.byFrame.length; f++) {
      const objs = (this.byFrame[f] ?? []).map(syncObject);
      this.prepare(objs);
      this.cache.set(f, objs);
    }
    this.buildMs = performance.now() - t0;
  }
  show(index: number): void {
    const canvas = this.overlay.canvas;
    const prev = this.cache.get(this.current);
    if (prev && prev.length > 0) canvas.remove(...prev);
    const next = this.cache.get(index) ?? [];
    if (next.length > 0) canvas.add(...next);
    this.current = index;
    canvas.requestRenderAll();
  }
}

export class VisibilityLayer extends BaseLayer {
  readonly name = 'visibility' as const;
  private readonly byIndex = new Map<number, FabricObject[]>();
  async init(): Promise<void> {
    const all: FabricObject[] = [];
    for (let f = 0; f < this.byFrame.length; f++) {
      const objs = (this.byFrame[f] ?? []).map(syncObject);
      for (const o of objs) o.visible = false;
      this.prepare(objs);
      this.byIndex.set(f, objs);
      all.push(...objs);
    }
    // In chunks: one spread of 60 000 objects (300 frames x 200) overflows the
    // call stack ("Maximum call stack size exceeded").
    for (let i = 0; i < all.length; i += 1000) this.overlay.canvas.add(...all.slice(i, i + 1000));
  }
  show(index: number): void {
    for (const o of this.byIndex.get(this.current) ?? []) o.visible = false;
    for (const o of this.byIndex.get(index) ?? []) o.visible = true;
    this.current = index;
    this.overlay.canvas.requestRenderAll();
  }
}

export function createAnnotationLayer(
  name: AnnotationSwapName,
  overlay: FabricOverlay,
  byFrame: readonly (readonly OsdAnnotation[])[],
): AnnotationLayer {
  switch (name) {
    case 'rebuild-async':
      return new RebuildAsyncLayer(overlay, byFrame);
    case 'rebuild-sync':
      return new RebuildSyncLayer(overlay, byFrame);
    case 'cache':
      return new CacheLayer(overlay, byFrame);
    case 'visibility':
      return new VisibilityLayer(overlay, byFrame);
  }
}
