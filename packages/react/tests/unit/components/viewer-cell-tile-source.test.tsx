import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createAnnotationContextId } from '@osdlabel/annotation-context';
import { createImageId, type ImageSource } from '@osdlabel/viewer-api';
import { createMockAnnotator } from '../hooks/mock-annotator.js';
import { mount, unmountAll } from '../mount.js';

/**
 * The React counterpart of Solid's `components/viewer-cell-tile-source.test.ts`:
 * a cell reloads its image only when the tile source changes by value (#83).
 * In React this matters on every host render, which re-creates an inline
 * tile-source object.
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

  afterEach(unmountAll);

  function mountCell(initial: ImageSource) {
    const cell = (source: ImageSource) => (
      <ViewerCell imageSource={source} isActive cellIndex={0} onActivate={() => {}} />
    );
    const m = mount(cell(initial));
    // The first open happens on mount, and leaves OSD's writes behind on
    // whatever it was given; count only what follows.
    open.mockClear();
    return { setSource: (source: ImageSource) => m.rerender(cell(source)) };
  }

  it('does not reload when a new ImageSource keeps the same URL', () => {
    const cell = mountCell({ id, tileSource: 'a.dzi' });
    cell.setSource({ id, tileSource: 'a.dzi', label: 'renamed' });
    expect(open).not.toHaveBeenCalled();
  });

  it('does not reload for a re-created tile-source object with the same values', () => {
    const cell = mountCell({ id, tileSource: { type: 'image', url: 'a.png' } });
    cell.setSource({ id, tileSource: { type: 'image', url: 'a.png' } });
    expect(open).not.toHaveBeenCalled();
    expect(fakeViewer.close).not.toHaveBeenCalled();
  });

  it('reloads when a tile-source object changes', () => {
    const cell = mountCell({ id, tileSource: { type: 'image', url: 'a.png' } });
    const next: ImageSource = { id, tileSource: { type: 'image', url: 'b.png' } };
    cell.setSource(next);
    expect(fakeViewer.close).toHaveBeenCalledTimes(1);
    expect(open).toHaveBeenCalledTimes(1);
    expect(open.mock.calls[0]![0]).toMatchObject({ type: 'image', url: 'b.png' });
  });

  it('reloads when a URL changes, and when a URL becomes an object', () => {
    const cell = mountCell({ id, tileSource: 'a.dzi' });
    cell.setSource({ id, tileSource: 'b.dzi' });
    cell.setSource({ id, tileSource: { type: 'image', url: 'b.dzi' } });
    expect(open).toHaveBeenCalledTimes(2);
  });
});
