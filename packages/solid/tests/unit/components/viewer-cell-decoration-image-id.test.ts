import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createComponent, createRoot, createSignal } from 'solid-js';
import { createAnnotationContextId } from '@osdlabel/annotation-context';
import type { Decoration, DecorationContext, DecorationProvider } from '@osdlabel/decoration';
import { createImageId, type ImageId, type ImageSource } from '@osdlabel/viewer-api';
import type { OsdFields } from 'osdlabel';
import { createMockAnnotator } from '../hooks/mock-annotator.js';

/**
 * Decoration providers are shared by every cell, so `DecorationContext.imageId`
 * is how one tells cells apart (a volume host maps it to the plane the cell
 * shows). The cell passes its `imageSource.id`, and a new id with the same
 * tile source re-runs the providers with it. Mirrored for React in
 * `packages/react/tests/unit/components/viewer-cell-decoration-image-id.test.tsx`.
 */

const setDecorations = vi.fn<(decorations: readonly Decoration[]) => void>();
const openHandlers: (() => void)[] = [];
const fakeViewer = {
  addHandler: vi.fn((event: string, handler: () => void) => {
    if (event === 'open') openHandlers.push(handler);
  }),
  removeHandler: vi.fn(),
  close: vi.fn(),
  destroy: vi.fn(),
  world: { getItemCount: () => 0, getItemAt: () => undefined },
  viewport: {},
};

vi.mock('openseadragon', () => ({ default: () => fakeViewer }));

vi.mock('@osdlabel/fabric-osd', () => ({
  FabricOverlay: class {
    destroy = vi.fn();
    canvas = {
      getObjects: () => [],
      add: vi.fn(),
      remove: vi.fn(),
      on: vi.fn(),
      off: vi.fn(),
      requestRenderAll: vi.fn(),
      discardActiveObject: vi.fn(),
    };
    applyViewTransform = vi.fn();
    applyImageFilters = vi.fn();
    applyModeToObject = vi.fn();
    onSync = () => () => {};
    setMode = vi.fn();
    overlayElement = null;
  },
  DecorationLayer: class {
    destroy = vi.fn();
    setDecorations = setDecorations;
    onDomDecorations = vi.fn(() => () => {});
  },
}));

vi.mock('@osdlabel/osd-helper', async () => ({
  ...(await vi.importActual<typeof import('@osdlabel/osd-helper')>('@osdlabel/osd-helper')),
  DEFAULT_VIEWER_OPTIONS: {},
  openImage: vi.fn(),
}));

/** Every context the provider was called with, in order. */
let seen: DecorationContext<OsdFields>[] = [];
const provider: DecorationProvider<OsdFields> = (ctx) => {
  seen.push(ctx);
  return [
    {
      type: 'text',
      id: `for:${ctx.imageId ?? 'none'}`,
      relatedAnnotationIds: [],
      anchor: { x: 0, y: 0 },
      text: 'x',
    },
  ];
};

const mockState = createMockAnnotator({
  decorationProviders: [provider],
  contextState: {
    activeContextId: createAnnotationContextId('ctx-1'),
    contexts: [],
    displayedContextIds: [],
  },
});

vi.mock('../../../src/state/annotator-context.js', () => ({
  useAnnotator: () => mockState,
}));
vi.mock('../../../src/hooks/useAnnotationTool.js', () => ({
  useAnnotationTool: () => undefined,
}));

const { default: ViewerCell } = await import('../../../src/components/ViewerCell.js');

const planeA: ImageId = createImageId('vol:ct:axial:10');
const planeB: ImageId = createImageId('vol:ct:axial:11');
/** One tile-source instance for every plane, as a reslicing host keeps it. */
const tileSource = { type: 'image', url: 'plane.png' };

describe('ViewerCell DecorationContext.imageId', () => {
  let dispose: (() => void) | undefined;

  beforeEach(() => {
    seen = [];
    setDecorations.mockClear();
    openHandlers.length = 0;
  });
  afterEach(() => {
    dispose?.();
    dispose = undefined;
  });

  function mount(initial: ImageSource) {
    const [source, setSource] = createSignal(initial);
    dispose = createRoot((d) => {
      createComponent(ViewerCell, {
        get imageSource() {
          return source();
        },
        isActive: true,
        cellIndex: 0,
        onActivate: () => {},
      });
      return d;
    });
    expect(openHandlers).toHaveLength(1);
    openHandlers[0]!();
    return setSource;
  }

  it("passes the cell's imageSource.id to every provider call", () => {
    mount({ id: planeA, tileSource });
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((c) => c.imageId === planeA)).toBe(true);
    expect(setDecorations).toHaveBeenLastCalledWith([
      expect.objectContaining({ id: `for:${planeA}` }),
    ]);
  });

  it('re-runs the providers with the new id when only the id changes', () => {
    const setSource = mount({ id: planeA, tileSource });
    seen = [];
    setSource({ id: planeB, tileSource });
    expect(seen.length).toBeGreaterThan(0);
    expect(seen[seen.length - 1]!.imageId).toBe(planeB);
    expect(setDecorations).toHaveBeenLastCalledWith([
      expect.objectContaining({ id: `for:${planeB}` }),
    ]);
    // Same tile source by value: the image is not reopened.
    expect(openHandlers).toHaveLength(1);
  });
});
