import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Annotation, AnnotationId } from '@osdlabel/annotation';
import type { Decoration, DecorationProvider } from '@osdlabel/decoration';
import type { FabricOverlay } from '@osdlabel/fabric-osd';
import type { PixelSpacing } from '@osdlabel/viewer-api';
import type { FabricObject } from 'fabric';
import { enableLiveDecorationUpdates } from '../../src/live-decoration-updates.js';

// Stub out the Fabric-coupled extractor so tests stay in pure JS land.
// `target.__mockGeometry` is read back as the "live" geometry; `undefined`
// simulates an extraction failure.
vi.mock('@osdlabel/fabric-annotations', () => ({
  getGeometryFromFabricObject: (target: { __mockGeometry?: unknown }) =>
    target.__mockGeometry ?? null,
}));

interface MockCanvas {
  on: ReturnType<typeof vi.fn>;
  off: ReturnType<typeof vi.fn>;
}

interface TestRig {
  overlay: FabricOverlay;
  canvas: MockCanvas;
  handlers: Record<string, Array<(e: { target?: FabricObject }) => void>>;
  fire(event: string, target?: FabricObject): void;
  flushRAF(): void;
}

function createRig(): TestRig {
  const handlers: TestRig['handlers'] = {};
  const canvas: MockCanvas = {
    on: vi.fn((event: string, h: (e: { target?: FabricObject }) => void) => {
      (handlers[event] ??= []).push(h);
    }),
    off: vi.fn((event: string, h: (e: { target?: FabricObject }) => void) => {
      handlers[event] = (handlers[event] ?? []).filter((x) => x !== h);
    }),
  };
  const overlay = { canvas } as unknown as FabricOverlay;
  return {
    overlay,
    canvas,
    handlers,
    fire(event, target) {
      for (const h of handlers[event] ?? []) h({ target });
    },
    flushRAF() {
      const cbs = [...rafQueue];
      rafQueue.length = 0;
      for (const cb of cbs) cb(0);
    },
  };
}

let rafQueue: FrameRequestCallback[] = [];
let cancelAnimationFrameImpl: (id: number) => void = (id) => {
  rafQueue.splice(id - 1, 1);
};

beforeEach(() => {
  rafQueue = [];
  cancelAnimationFrameImpl = (id) => {
    rafQueue.splice(id - 1, 1);
  };
  (
    globalThis as unknown as { requestAnimationFrame: typeof requestAnimationFrame }
  ).requestAnimationFrame = (cb: FrameRequestCallback) => {
    rafQueue.push(cb);
    return rafQueue.length;
  };
  (
    globalThis as unknown as { cancelAnimationFrame: typeof cancelAnimationFrame }
  ).cancelAnimationFrame = (id: number) => cancelAnimationFrameImpl(id);
});

const annId = (s: string): AnnotationId => s as AnnotationId;

function rectAnnotation(id: string, x: number, y: number): Annotation {
  return {
    id: annId(id),
    geometry: { type: 'rectangle', origin: { x, y }, width: 10, height: 10, rotation: 0 },
    toolType: 'rectangle',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

function fakeFabricTarget(id: string, geometry: Annotation['geometry']): FabricObject {
  return { id, __mockGeometry: geometry } as unknown as FabricObject;
}

/** Mock ActiveSelection wrapping the given child targets. No `id` (groups carry none). */
function fakeActiveSelection(children: readonly FabricObject[]): FabricObject {
  return {
    type: 'activeselection',
    getObjects: () => [...children],
  } as unknown as FabricObject;
}

describe('enableLiveDecorationUpdates', () => {
  it('subscribes to object:moving, object:scaling, and object:rotating', () => {
    const rig = createRig();
    const dispose = enableLiveDecorationUpdates({
      overlay: rig.overlay,
      getVisibleAnnotations: () => [],
      getPixelSpacing: () => undefined,
      getProviders: () => [],
      onDecorations: vi.fn(),
    });
    expect(rig.canvas.on).toHaveBeenCalledTimes(3);
    const events = rig.canvas.on.mock.calls.map((c) => c[0]);
    expect(events).toEqual(['object:moving', 'object:scaling', 'object:rotating']);
    dispose();
  });

  it('throttles multiple events within a frame to one onDecorations call', () => {
    const rig = createRig();
    const onDecorations = vi.fn();
    const provider: DecorationProvider = () => [];
    enableLiveDecorationUpdates({
      overlay: rig.overlay,
      getVisibleAnnotations: () => [],
      getPixelSpacing: () => undefined,
      getProviders: () => [provider],
      onDecorations,
    });

    const t = fakeFabricTarget('a', {
      type: 'rectangle',
      origin: { x: 0, y: 0 },
      width: 1,
      height: 1,
      rotation: 0,
    });
    rig.fire('object:moving', t);
    rig.fire('object:scaling', t);
    rig.fire('object:rotating', t);
    expect(onDecorations).not.toHaveBeenCalled();
    rig.flushRAF();
    expect(onDecorations).toHaveBeenCalledTimes(1);
  });

  it('overrides the moving annotation geometry with the live Fabric geometry', () => {
    const rig = createRig();
    const onDecorations = vi.fn();
    const a = rectAnnotation('a', 0, 0);
    const b = rectAnnotation('b', 100, 100);

    // Provider that snapshots the geometry it received for each annotation.
    const seenGeoms: Record<string, Annotation['geometry']> = {};
    const provider: DecorationProvider = ({ annotations }) => {
      for (const ann of annotations) seenGeoms[ann.id] = ann.geometry;
      return [];
    };
    enableLiveDecorationUpdates({
      overlay: rig.overlay,
      getVisibleAnnotations: () => [a, b],
      getPixelSpacing: () => undefined,
      getProviders: () => [provider],
      onDecorations,
    });

    const liveGeometry: Annotation['geometry'] = {
      type: 'rectangle',
      origin: { x: 50, y: 60 },
      width: 70,
      height: 80,
      rotation: 0,
    };
    rig.fire('object:moving', fakeFabricTarget('a', liveGeometry));
    rig.flushRAF();

    expect(seenGeoms['a']).toEqual(liveGeometry);
    // Other annotation untouched
    expect(seenGeoms['b']).toEqual(b.geometry);
  });

  it('passes pixel spacing through to providers', () => {
    const rig = createRig();
    const spacing: PixelSpacing = { x: 0.5, y: 0.5, unit: 'mm' };
    const provider: DecorationProvider = ({ pixelSpacing }) => {
      providerSpacing = pixelSpacing;
      return [];
    };
    let providerSpacing: PixelSpacing | undefined;
    enableLiveDecorationUpdates({
      overlay: rig.overlay,
      getVisibleAnnotations: () => [],
      getPixelSpacing: () => spacing,
      getProviders: () => [provider],
      onDecorations: vi.fn(),
    });
    rig.fire('object:moving', fakeFabricTarget('x', null as unknown as Annotation['geometry']));
    rig.flushRAF();
    expect(providerSpacing).toEqual(spacing);
  });

  it('skips providers and onDecorations entirely when none are registered', () => {
    // No-providers case is fast-exited at the event handler; the rAF queue
    // stays empty and onDecorations is never invoked. Host frameworks call
    // setDecorations([]) themselves when providers go empty, so cleanup is
    // not this helper's responsibility.
    const rig = createRig();
    const onDecorations = vi.fn();
    enableLiveDecorationUpdates({
      overlay: rig.overlay,
      getVisibleAnnotations: () => [],
      getPixelSpacing: () => undefined,
      getProviders: () => [],
      onDecorations,
    });
    rig.fire('object:moving', fakeFabricTarget('x', null as unknown as Annotation['geometry']));
    rig.flushRAF();
    expect(onDecorations).not.toHaveBeenCalled();
  });

  it('falls back to the state-derived geometry when the target carries no id', () => {
    const rig = createRig();
    const a = rectAnnotation('a', 1, 2);
    const seen: Annotation['geometry'][] = [];
    const provider: DecorationProvider = ({ annotations }) => {
      for (const ann of annotations) seen.push(ann.geometry);
      return [];
    };
    enableLiveDecorationUpdates({
      overlay: rig.overlay,
      getVisibleAnnotations: () => [a],
      getPixelSpacing: () => undefined,
      getProviders: () => [provider],
      onDecorations: vi.fn(),
    });
    // Target has no .id — override should be skipped
    rig.fire('object:moving', { __mockGeometry: { type: 'rectangle' } } as unknown as FabricObject);
    rig.flushRAF();
    expect(seen).toEqual([a.geometry]);
  });

  it('calls providers with the original list when geometry extraction fails', () => {
    const rig = createRig();
    const a = rectAnnotation('a', 1, 2);
    const seen: Annotation['geometry'][] = [];
    const provider: DecorationProvider = ({ annotations }) => {
      for (const ann of annotations) seen.push(ann.geometry);
      return [];
    };
    enableLiveDecorationUpdates({
      overlay: rig.overlay,
      getVisibleAnnotations: () => [a],
      getPixelSpacing: () => undefined,
      getProviders: () => [provider],
      onDecorations: vi.fn(),
    });
    // Target has id but __mockGeometry is undefined → extractor returns null
    rig.fire('object:moving', { id: 'a' } as unknown as FabricObject);
    rig.flushRAF();
    expect(seen).toEqual([a.geometry]);
  });

  it('preserves identity of non-target items (no per-item realloc)', () => {
    const rig = createRig();
    const a = rectAnnotation('a', 0, 0);
    const b = rectAnnotation('b', 5, 5);
    const c = rectAnnotation('c', 10, 10);
    let seen: readonly Annotation[] | undefined;
    const provider: DecorationProvider = ({ annotations }) => {
      seen = annotations;
      return [];
    };
    enableLiveDecorationUpdates({
      overlay: rig.overlay,
      getVisibleAnnotations: () => [a, b, c],
      getPixelSpacing: () => undefined,
      getProviders: () => [provider],
      onDecorations: vi.fn(),
    });
    rig.fire(
      'object:moving',
      fakeFabricTarget('b', {
        type: 'rectangle',
        origin: { x: 99, y: 99 },
        width: 1,
        height: 1,
        rotation: 0,
      }),
    );
    rig.flushRAF();
    // Target item is replaced; siblings keep their identity for memo stability.
    expect(seen![0]).toBe(a);
    expect(seen![2]).toBe(c);
    expect(seen![1]).not.toBe(b);
    expect(seen![1]!.id).toBe('b');
  });

  it('overrides geometry for every id-bearing child of an ActiveSelection drag', () => {
    const rig = createRig();
    const a = rectAnnotation('a', 0, 0);
    const b = rectAnnotation('b', 10, 10);
    const c = rectAnnotation('c', 20, 20);
    const seenGeoms: Record<string, Annotation['geometry']> = {};
    const provider: DecorationProvider = ({ annotations }) => {
      for (const ann of annotations) seenGeoms[ann.id] = ann.geometry;
      return [];
    };
    enableLiveDecorationUpdates({
      overlay: rig.overlay,
      getVisibleAnnotations: () => [a, b, c],
      getPixelSpacing: () => undefined,
      getProviders: () => [provider],
      onDecorations: vi.fn(),
    });
    const liveA: Annotation['geometry'] = {
      type: 'rectangle',
      origin: { x: 50, y: 50 },
      width: 1,
      height: 1,
      rotation: 0,
    };
    const liveB: Annotation['geometry'] = {
      type: 'rectangle',
      origin: { x: 60, y: 60 },
      width: 1,
      height: 1,
      rotation: 0,
    };
    const selection = fakeActiveSelection([
      fakeFabricTarget('a', liveA),
      fakeFabricTarget('b', liveB),
    ]);
    rig.fire('object:moving', selection);
    rig.flushRAF();
    expect(seenGeoms['a']).toEqual(liveA);
    expect(seenGeoms['b']).toEqual(liveB);
    // Unselected annotation untouched.
    expect(seenGeoms['c']).toEqual(c.geometry);
  });

  it('does not schedule a rAF when providers are empty (fast-exit)', () => {
    const rig = createRig();
    enableLiveDecorationUpdates({
      overlay: rig.overlay,
      getVisibleAnnotations: () => [],
      getPixelSpacing: () => undefined,
      getProviders: () => [],
      onDecorations: vi.fn(),
    });
    rig.fire('object:moving', fakeFabricTarget('x', null as unknown as Annotation['geometry']));
    rig.fire('object:scaling', fakeFabricTarget('x', null as unknown as Annotation['geometry']));
    rig.fire('object:rotating', fakeFabricTarget('x', null as unknown as Annotation['geometry']));
    expect(rafQueue).toHaveLength(0);
  });

  it('teardown unsubscribes from all events and cancels a pending rAF', () => {
    const rig = createRig();
    const onDecorations = vi.fn();
    const dispose = enableLiveDecorationUpdates({
      overlay: rig.overlay,
      getVisibleAnnotations: () => [],
      getPixelSpacing: () => undefined,
      getProviders: () => [() => []],
      onDecorations,
    });
    rig.fire('object:moving', fakeFabricTarget('x', null as unknown as Annotation['geometry']));
    // rAF scheduled but not yet flushed
    dispose();
    expect(rig.canvas.off).toHaveBeenCalledTimes(3);
    rig.flushRAF();
    // Even if the cancelAnimationFrame mock didn't fully clear, the disposed
    // flag guards onDecorations from firing post-teardown.
    expect(onDecorations).not.toHaveBeenCalled();
  });

  it('does not return decorations from disposed instance even if rAF still fires', () => {
    // Belt-and-suspenders: simulate a buggy host where cancelAnimationFrame
    // is a no-op. The disposed guard inside flush() must still suppress calls.
    const rig = createRig();
    cancelAnimationFrameImpl = () => {};
    const onDecorations = vi.fn();
    const dispose = enableLiveDecorationUpdates({
      overlay: rig.overlay,
      getVisibleAnnotations: () => [],
      getPixelSpacing: () => undefined,
      getProviders: () => [() => []],
      onDecorations,
    });
    rig.fire('object:moving', fakeFabricTarget('x', null as unknown as Annotation['geometry']));
    dispose();
    rig.flushRAF();
    expect(onDecorations).not.toHaveBeenCalled();
  });
});
