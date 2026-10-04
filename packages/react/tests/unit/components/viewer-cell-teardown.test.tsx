import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { createAnnotationContextId } from '@osdlabel/annotation-context';
import { createImageId } from '@osdlabel/viewer-api';
import { createMockAnnotator } from '../hooks/mock-annotator.js';
import { mount, unmountAll } from '../mount.js';

/**
 * The React counterpart of Solid's `components/viewer-cell-teardown.test.ts`.
 *
 * Unmounting a live viewer is something a user does repeatedly (clearing a
 * cell), and E2E cannot see a leak: the `imageSource ? <ViewerCell/> :
 * placeholder` ternary removes the DOM subtree whether or not OpenSeadragon
 * was destroyed. In React the teardown is the mount-only effect's cleanup, and
 * the overlay/layer are only reachable through refs set in the OSD `'open'`
 * handler — so this also pins the `overlayRef` guard CLAUDE.md describes
 * against building a second overlay on a later `'open'`.
 */

const viewerDestroy = vi.fn();
const overlayDestroy = vi.fn();
const layerDestroy = vi.fn();
const overlayConstructed = vi.fn();

/** Captures the OSD `'open'` handler so the test can fire it. */
const openHandlers: (() => void)[] = [];

const fakeViewer = {
  addHandler: vi.fn((event: string, handler: () => void) => {
    if (event === 'open') openHandlers.push(handler);
  }),
  removeHandler: vi.fn(),
  close: vi.fn(),
  destroy: viewerDestroy,
  world: { getItemCount: () => 0, getItemAt: () => undefined },
  viewport: {},
};

vi.mock('openseadragon', () => ({ default: () => fakeViewer }));

vi.mock('@osdlabel/fabric-osd', () => ({
  FabricOverlay: class {
    constructor() {
      overlayConstructed();
    }
    destroy = overlayDestroy;
    canvas = {
      getObjects: () => [],
      remove: vi.fn(),
      add: vi.fn(),
      on: vi.fn(),
      off: vi.fn(),
      requestRenderAll: vi.fn(),
      discardActiveObject: vi.fn(),
      setActiveObject: vi.fn(),
    };
    applyViewTransform = vi.fn();
    applyImageFilters = vi.fn();
    onSync = () => () => {};
    setMode = vi.fn();
    overlayElement = null;
  },
  DecorationLayer: class {
    destroy = layerDestroy;
    setDecorations = vi.fn();
    onDomDecorations = vi.fn(() => () => {});
  },
}));

vi.mock('@osdlabel/osd-helper', async () => ({
  // The real tile-source comparison: ViewerCell calls it on every source change.
  ...(await vi.importActual<typeof import('@osdlabel/osd-helper')>('@osdlabel/osd-helper')),
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
    overlayConstructed.mockClear();
    openHandlers.length = 0;
  });

  afterEach(unmountAll);

  const mountCell = () =>
    mount(
      <ViewerCell
        imageSource={{ id: createImageId('img-1'), tileSource: 'x.png' }}
        isActive
        cellIndex={0}
        onActivate={() => {}}
      />,
    );

  it('destroys the OSD viewer when the cell unmounts', () => {
    const m = mountCell();
    expect(viewerDestroy).not.toHaveBeenCalled();

    m.unmount();

    expect(viewerDestroy).toHaveBeenCalledTimes(1);
  });

  it('destroys the Fabric overlay and decoration layer too', () => {
    const m = mountCell();

    // The overlay and layer only exist once OSD reports the image open.
    expect(openHandlers).toHaveLength(1);
    act(() => openHandlers[0]!());

    m.unmount();

    expect(overlayDestroy).toHaveBeenCalledTimes(1);
    expect(layerDestroy).toHaveBeenCalledTimes(1);
    expect(viewerDestroy).toHaveBeenCalledTimes(1);
  });

  it('builds one overlay however often OSD reports an open', () => {
    // OSD fires 'open' again for every image the viewer opens later. The
    // handler is a mount-only closure, so only `overlayRef` stops it from
    // stacking a second canvas on the first — and leaking the first, since
    // teardown only reaches the one in the ref.
    const m = mountCell();
    act(() => openHandlers[0]!());
    act(() => openHandlers[0]!());

    expect(overlayConstructed).toHaveBeenCalledTimes(1);

    m.unmount();
    expect(overlayDestroy).toHaveBeenCalledTimes(1);
  });
});
