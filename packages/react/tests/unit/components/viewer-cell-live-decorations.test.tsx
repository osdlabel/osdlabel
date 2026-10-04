import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { createAnnotationId, type AnnotationId } from '@osdlabel/annotation';
import type { Decoration, DecorationContext, DecorationProvider } from '@osdlabel/decoration';
import type { ImageSource, PixelSpacing } from '@osdlabel/viewer-api';
import type { OsdFields } from 'osdlabel';
import { renderAnnotator, type AnnotatorHarness } from '../render-annotator.js';
import { unmountAll } from '../mount.js';
import { imageId, rect } from '../fixtures.js';

/**
 * React-only: Solid's `ViewerCell` hands `enableLiveDecorationUpdates`
 * accessors that read the store directly, so it has no equivalent of this.
 *
 * React's subscribes once per overlay (`useEffect([overlay])`) and the
 * long-lived drag handler reads the selection, the providers, the pixel
 * spacing and the visible annotations through refs the component refreshes on
 * every render (CLAUDE.md, "Subscriptions that need fresh state without
 * resubscribing use refs"). A ref that stops being refreshed is invisible to
 * the type checker and to symmetry with Solid: the readout simply goes stale
 * mid-drag (#152). Each test changes one input after subscription, then drives
 * a drag frame and checks the providers saw the new value — and that nothing
 * re-subscribed.
 *
 * Only OSD, the overlay and the layer are mocked; the provider, reducers and
 * `enableLiveDecorationUpdates` itself are real.
 */

type Listener = (payload: { target?: unknown }) => void;
const canvasListeners = new Map<string, Set<Listener>>();
const canvasOn = vi.fn((event: string, cb: Listener) => {
  const set = canvasListeners.get(event) ?? new Set<Listener>();
  set.add(cb);
  canvasListeners.set(event, set);
});
const canvasOff = vi.fn((event: string, cb: Listener) => {
  canvasListeners.get(event)?.delete(cb);
});
const setDecorations = vi.fn<(decorations: readonly Decoration[]) => void>();

const openHandlers: (() => void)[] = [];
const fakeViewer = {
  addHandler: vi.fn((event: string, handler: () => void) => {
    if (event === 'open') openHandlers.push(handler);
  }),
  removeHandler: vi.fn(),
  close: vi.fn(),
  destroy: vi.fn(),
};

vi.mock('openseadragon', () => ({ default: () => fakeViewer }));

vi.mock('@osdlabel/fabric-osd', () => ({
  FabricOverlay: class {
    destroy = vi.fn();
    canvas = {
      getObjects: () => [],
      remove: vi.fn(),
      add: vi.fn(),
      on: canvasOn,
      off: canvasOff,
      requestRenderAll: vi.fn(),
    };
    applyViewTransform = vi.fn();
    applyImageFilters = vi.fn();
  },
  DecorationLayer: class {
    destroy = vi.fn();
    setDecorations = setDecorations;
    onDomDecorations = vi.fn(() => () => {});
  },
}));

vi.mock('@osdlabel/osd-helper', async () => ({
  // The real tile-source comparison: ViewerCell calls it on every source change.
  ...(await vi.importActual<typeof import('@osdlabel/osd-helper')>('@osdlabel/osd-helper')),
  DEFAULT_VIEWER_OPTIONS: {},
  openImage: vi.fn(),
}));

vi.mock('../../../src/hooks/useAnnotationTool.js', () => ({
  useAnnotationTool: () => undefined,
}));

/**
 * Annotations are rebuilt onto the canvas asynchronously; with Fabric's
 * deserializer stubbed out that rebuild adds nothing and finishes at once.
 */
vi.mock('@osdlabel/fabric-annotations', async () => {
  const actual = await vi.importActual<typeof import('@osdlabel/fabric-annotations')>(
    '@osdlabel/fabric-annotations',
  );
  return { ...actual, createFabricObjectFromRawData: vi.fn(async () => null) };
});

const { default: ViewerCell } = await import('../../../src/components/ViewerCell.js');

/** Every context a provider was called with, in order. */
let seen: DecorationContext<OsdFields>[] = [];

/** A provider that records its context and labels the selection. */
function recordingProvider(tag: string): DecorationProvider<OsdFields> {
  return (ctx) => {
    seen.push(ctx);
    return [
      {
        type: 'text',
        id: `${tag}:${ctx.selectedAnnotationId ?? 'none'}`,
        relatedAnnotationIds: [],
        anchor: { x: 0, y: 0 },
        text: tag,
      },
    ];
  };
}

let rafQueue: FrameRequestCallback[] = [];

/** Fires one Fabric drag event and runs the frame it schedules. */
function dragFrame(): void {
  act(() => {
    for (const cb of canvasListeners.get('object:moving') ?? []) cb({ target: undefined });
  });
  const queued = rafQueue;
  rafQueue = [];
  act(() => {
    for (const cb of queued) cb(0);
  });
}

describe('ViewerCell live decoration updates', () => {
  beforeEach(() => {
    canvasListeners.clear();
    canvasOn.mockClear();
    canvasOff.mockClear();
    setDecorations.mockClear();
    openHandlers.length = 0;
    seen = [];
    rafQueue = [];
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      rafQueue.push(cb);
      return rafQueue.length;
    });
    vi.stubGlobal('cancelAnimationFrame', () => {});
  });

  afterEach(() => {
    unmountAll();
    vi.unstubAllGlobals();
  });

  const source = (pixelSpacing?: PixelSpacing): ImageSource => ({
    id: imageId,
    tileSource: 'x.png',
    ...(pixelSpacing ? { pixelSpacing } : {}),
  });

  const cell = (imageSource: ImageSource = source()) => (
    <ViewerCell imageSource={imageSource} isActive cellIndex={0} onActivate={() => {}} />
  );

  /** Mounts a real provider around a cell, and lets OSD report the image open. */
  function setup(providers: readonly DecorationProvider<OsdFields>[]): AnnotatorHarness {
    const h = renderAnnotator({ decorationProviders: providers }, cell());
    expect(openHandlers).toHaveLength(1);
    act(() => openHandlers[0]!());
    // Subscribed once the overlay exists.
    expect(canvasListeners.get('object:moving')?.size).toBe(1);
    return h;
  }

  /** Subscriptions made to the drag event since mount. */
  const movingSubscriptions = () => canvasOn.mock.calls.filter(([e]) => e === 'object:moving');

  it('a provider sees a selection made after subscription', () => {
    const h = setup([recordingProvider('a')]);
    const selected: AnnotationId = createAnnotationId('ann-7');

    h.run((a) => a.setSelectedAnnotation(selected));
    seen = [];
    dragFrame();

    // Exactly the drag frame's call: the state-driven effect ran before
    // `seen` was reset, so what is left came through the live handler.
    expect(seen).toHaveLength(1);
    expect(seen[0]!.selectedAnnotationId).toBe(selected);
    expect(setDecorations).toHaveBeenLastCalledWith([
      expect.objectContaining({ id: `a:${selected}` }),
    ]);
    expect(movingSubscriptions()).toHaveLength(1);
  });

  it('a provider sees the selection cleared again', () => {
    const h = setup([recordingProvider('a')]);
    h.run((a) => a.setSelectedAnnotation(createAnnotationId('ann-7')));
    dragFrame();

    h.run((a) => a.setSelectedAnnotation(null));
    seen = [];
    dragFrame();

    expect(seen).toHaveLength(1);
    expect(seen[0]!.selectedAnnotationId).toBeNull();
  });

  it('a replaced provider list takes over without re-subscribing', () => {
    const h = setup([recordingProvider('a')]);

    h.rerender({ decorationProviders: [recordingProvider('b')] });
    setDecorations.mockClear();
    dragFrame();

    expect(setDecorations).toHaveBeenCalledTimes(1);
    expect(setDecorations).toHaveBeenLastCalledWith([expect.objectContaining({ text: 'b' })]);
    expect(movingSubscriptions()).toHaveLength(1);
  });

  it('removing every provider stops the live recompute', () => {
    const h = setup([recordingProvider('a')]);

    h.rerender({ decorationProviders: [] });
    seen = [];
    setDecorations.mockClear();
    dragFrame();

    // `getProviders()` reads the ref, so the handler's fast exit sees the empty
    // list and schedules nothing.
    expect(seen).toHaveLength(0);
    expect(setDecorations).not.toHaveBeenCalled();
  });

  it('a provider sees a pixel spacing set after subscription', () => {
    const h = setup([recordingProvider('a')]);
    const spacing: PixelSpacing = { x: 0.25, y: 0.5, unit: 'mm' };

    h.rerender({}, cell(source(spacing)));
    seen = [];
    dragFrame();

    expect(seen).toHaveLength(1);
    expect(seen[0]!.pixelSpacing).toEqual(spacing);
    expect(movingSubscriptions()).toHaveLength(1);
  });

  it('a provider sees an annotation added after subscription', () => {
    const h = setup([recordingProvider('a')]);

    h.run((a) => a.addAnnotation(rect('r1')));
    seen = [];
    dragFrame();

    expect(seen).toHaveLength(1);
    expect(seen[0]!.annotations.map((a) => a.id)).toEqual([createAnnotationId('r1')]);
    expect(movingSubscriptions()).toHaveLength(1);
  });

  it('unsubscribes when the cell unmounts', () => {
    const h = setup([recordingProvider('a')]);
    h.unmount();
    expect(canvasListeners.get('object:moving')?.size ?? 0).toBe(0);
  });
});
