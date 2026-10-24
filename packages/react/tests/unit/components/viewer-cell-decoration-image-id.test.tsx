import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import type { Decoration, DecorationContext, DecorationProvider } from '@osdlabel/decoration';
import { createImageId, type ImageId, type ImageSource } from '@osdlabel/viewer-api';
import type { OsdFields } from 'osdlabel';
import { renderAnnotator, type AnnotatorHarness } from '../render-annotator.js';
import { unmountAll } from '../mount.js';

/**
 * Decoration providers are shared by every cell, so `DecorationContext.imageId`
 * is how one tells cells apart (a volume host maps it to the plane the cell
 * shows). The cell passes its `imageSource.id`, and a new id with the same
 * tile source re-runs the providers with it: in React that takes
 * `imageSource?.id` in the decoration effect's dependency list. Mirrors
 * `packages/solid/tests/unit/components/viewer-cell-decoration-image-id.test.ts`;
 * the live-drag path is covered in `viewer-cell-live-decorations.test.tsx`.
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
};

vi.mock('openseadragon', () => ({ default: () => fakeViewer }));

vi.mock('@osdlabel/fabric-osd', () => ({
  FabricOverlay: class {
    destroy = vi.fn();
    canvas = {
      getObjects: () => [],
      remove: vi.fn(),
      add: vi.fn(),
      on: vi.fn(),
      off: vi.fn(),
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
  ...(await vi.importActual<typeof import('@osdlabel/osd-helper')>('@osdlabel/osd-helper')),
  DEFAULT_VIEWER_OPTIONS: {},
  openImage: vi.fn(),
}));

vi.mock('../../../src/hooks/useAnnotationTool.js', () => ({
  useAnnotationTool: () => undefined,
}));

vi.mock('@osdlabel/fabric-annotations', async () => {
  const actual = await vi.importActual<typeof import('@osdlabel/fabric-annotations')>(
    '@osdlabel/fabric-annotations',
  );
  return { ...actual, createFabricObjectFromRawData: vi.fn(async () => null) };
});

const { default: ViewerCell } = await import('../../../src/components/ViewerCell.js');

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

const planeA: ImageId = createImageId('vol:ct:axial:10');
const planeB: ImageId = createImageId('vol:ct:axial:11');
/** One tile-source instance for every plane, as a reslicing host keeps it. */
const tileSource = { type: 'image', url: 'plane.png' };

const cell = (imageSource: ImageSource) => (
  <ViewerCell imageSource={imageSource} isActive cellIndex={0} onActivate={() => {}} />
);

describe('ViewerCell DecorationContext.imageId', () => {
  beforeEach(() => {
    seen = [];
    setDecorations.mockClear();
    openHandlers.length = 0;
  });
  afterEach(() => {
    unmountAll();
  });

  function mount(): AnnotatorHarness {
    const h = renderAnnotator(
      { decorationProviders: [provider] },
      cell({ id: planeA, tileSource }),
    );
    expect(openHandlers).toHaveLength(1);
    act(() => openHandlers[0]!());
    return h;
  }

  it("passes the cell's imageSource.id to every provider call", () => {
    mount();
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((c) => c.imageId === planeA)).toBe(true);
    expect(setDecorations).toHaveBeenLastCalledWith([
      expect.objectContaining({ id: `for:${planeA}` }),
    ]);
  });

  it('re-runs the providers with the new id when only the id changes', () => {
    const h = mount();
    seen = [];
    h.rerender({}, cell({ id: planeB, tileSource }));
    expect(seen.length).toBeGreaterThan(0);
    expect(seen[seen.length - 1]!.imageId).toBe(planeB);
    expect(setDecorations).toHaveBeenLastCalledWith([
      expect.objectContaining({ id: `for:${planeB}` }),
    ]);
    expect(openHandlers).toHaveLength(1);
  });

  it('does not re-run the providers for an equal re-render', () => {
    const h = mount();
    seen = [];
    h.rerender({}, cell({ id: planeA, tileSource }));
    expect(seen).toHaveLength(0);
  });
});
