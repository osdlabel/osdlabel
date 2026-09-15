import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createRoot, createComponent } from 'solid-js';
import { createAnnotationContextId } from '@osdlabel/annotation-context';
import { createImageId } from '@osdlabel/viewer-api';
import { createMockAnnotator } from '../hooks/mock-annotator.js';

/**
 * Teardown became load-bearing with the cell-clearing gesture: unmounting a
 * live viewer went from a page-unload event to something a user does
 * repeatedly. Emptying `ViewerCell`'s cleanup body passed every unit and E2E
 * test before this — E2E cannot see it, because the
 * `imageSource ? <ViewerCell/> : placeholder` ternary removes the DOM subtree
 * whether or not OpenSeadragon was destroyed.
 */

const viewerDestroy = vi.fn();
const overlayDestroy = vi.fn();
const layerDestroy = vi.fn();

const fakeViewer = {
  addHandler: vi.fn(),
  removeHandler: vi.fn(),
  destroy: viewerDestroy,
  world: { getItemCount: () => 0, getItemAt: () => undefined },
  viewport: {},
};

vi.mock('openseadragon', () => ({ default: () => fakeViewer }));

vi.mock('@osdlabel/fabric-osd', () => ({
  FabricOverlay: class {
    destroy = overlayDestroy;
    canvas = { getObjects: () => [], remove: vi.fn(), add: vi.fn() };
    onSync = () => () => {};
    setMode = vi.fn();
    overlayElement = null;
  },
  DecorationLayer: class {
    destroy = layerDestroy;
    setDecorations = vi.fn();
    setDomDecorationRenderer = vi.fn();
  },
}));

vi.mock('@osdlabel/osd-helper', () => ({
  DEFAULT_VIEWER_OPTIONS: {},
  openImage: vi.fn(),
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

describe('ViewerCell teardown', () => {
  beforeEach(() => {
    viewerDestroy.mockClear();
    overlayDestroy.mockClear();
    layerDestroy.mockClear();
  });

  it('destroys the OSD viewer when the cell unmounts', () => {
    const dispose = createRoot((disposeFn) => {
      createComponent(ViewerCell, {
        imageSource: { id: createImageId('img-1'), tileSource: 'x.png' },
        isActive: true,
        cellIndex: 0,
        onActivate: () => {},
      });
      return disposeFn;
    });

    expect(viewerDestroy).not.toHaveBeenCalled();

    dispose();

    // Without this the viewer's rAF update loop, MouseTracker handlers and
    // tile requests outlive every cleared cell.
    expect(viewerDestroy).toHaveBeenCalledTimes(1);
  });
});
