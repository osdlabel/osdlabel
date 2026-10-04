import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createComponent, createRoot, createSignal } from 'solid-js';
import { createAnnotationContextId } from '@osdlabel/annotation-context';
import { createImageId, type ImageSource } from '@osdlabel/viewer-api';
import { createMockAnnotator } from '../hooks/mock-annotator.js';

/**
 * A cell reloads its image only when the tile source changes by value (#83).
 * A tile source can be an object since #83, and a host that re-creates an equal
 * one must not make the viewer close and reopen the image. React covers the
 * same in `components/viewer-cell-tile-source.test.tsx`.
 */

/**
 * Mutates a plain object it is asked to open, as OpenSeadragon 5 does, so the
 * tests cover the whole chain: the real `openImage` must keep that mutation
 * out of the host's object, or the next equal object compares unequal.
 */
const open = vi.fn((tileSource: unknown) => {
  if (typeof tileSource === 'object' && tileSource !== null && !Array.isArray(tileSource)) {
    Object.assign(tileSource, { crossOriginPolicy: false, ajaxWithCredentials: false });
  }
});

const fakeViewer = {
  open,
  addHandler: vi.fn(),
  removeHandler: vi.fn(),
  close: vi.fn(),
  destroy: vi.fn(),
  world: { getItemCount: () => 0, getItemAt: () => undefined },
  viewport: {},
};

vi.mock('openseadragon', () => ({ default: () => fakeViewer }));

vi.mock('@osdlabel/fabric-osd', () => ({
  FabricOverlay: class {},
  DecorationLayer: class {},
}));

vi.mock('@osdlabel/osd-helper', async () => ({
  // The real openImage and isSameTileSource; only the viewer options are stubbed.
  ...(await vi.importActual<typeof import('@osdlabel/osd-helper')>('@osdlabel/osd-helper')),
  DEFAULT_VIEWER_OPTIONS: {},
}));

const mockState = createMockAnnotator({
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

const id = createImageId('img-1');

describe('ViewerCell tile-source changes (#83)', () => {
  beforeEach(() => {
    open.mockClear();
    fakeViewer.close.mockClear();
  });

  function mountCell(initial: ImageSource) {
    const [source, setSource] = createSignal(initial);
    const dispose = createRoot((d) => {
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
    // The first open happens on mount, and leaves OSD's writes behind on
    // whatever it was given; count only what follows.
    open.mockClear();
    return { setSource, dispose };
  }

  it('does not reload when a new ImageSource keeps the same URL', () => {
    // Before #83 the first such change reloaded in Solid: a deferred `on`
    // records no previous input on its skipped first run.
    const cell = mountCell({ id, tileSource: 'a.dzi' });
    cell.setSource({ id, tileSource: 'a.dzi', label: 'renamed' });
    expect(open).not.toHaveBeenCalled();
    cell.dispose();
  });

  it('does not reload for a re-created tile-source object with the same values', () => {
    const cell = mountCell({ id, tileSource: { type: 'image', url: 'a.png' } });
    cell.setSource({ id, tileSource: { type: 'image', url: 'a.png' } });
    expect(open).not.toHaveBeenCalled();
    expect(fakeViewer.close).not.toHaveBeenCalled();
    cell.dispose();
  });

  it('reloads when a tile-source object changes', () => {
    const cell = mountCell({ id, tileSource: { type: 'image', url: 'a.png' } });
    const next: ImageSource = { id, tileSource: { type: 'image', url: 'b.png' } };
    cell.setSource(next);
    expect(fakeViewer.close).toHaveBeenCalledTimes(1);
    expect(open).toHaveBeenCalledTimes(1);
    expect(open.mock.calls[0]![0]).toMatchObject({ type: 'image', url: 'b.png' });
    cell.dispose();
  });

  it('reloads when a URL changes, and when a URL becomes an object', () => {
    const cell = mountCell({ id, tileSource: 'a.dzi' });
    cell.setSource({ id, tileSource: 'b.dzi' });
    cell.setSource({ id, tileSource: { type: 'image', url: 'b.dzi' } });
    expect(open).toHaveBeenCalledTimes(2);
    cell.dispose();
  });
});
