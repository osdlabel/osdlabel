import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { createAnnotationContextId } from '@osdlabel/annotation-context';
import { createImageId } from '@osdlabel/viewer-api';
import { createAnnotationId } from '@osdlabel/annotation';
import { createFabricObjectFromRawData } from '@osdlabel/fabric-annotations';
import {
  BoundedDenseMaskBuffer,
  createMaskAnnotation,
  maskAnnotationFields,
  stampCircle,
} from 'osdlabel';
import { renderAnnotator, type AnnotatorHarness } from '../render-annotator.js';
import { unmountAll } from '../mount.js';
import { rect } from '../fixtures.js';

/**
 * The React counterpart of Solid's `components/viewer-cell-mask-cache.test.ts`,
 * run against the real provider. The rebuild depends on the per-image
 * dictionary Immer replaces on every write to the image, so the cache — not a
 * skipped effect — is what spares the unchanged masks.
 */
/**
 * A Fabric canvas stand-in that actually holds its objects, so the test can
 * see which object is where and at what opacity. Only what `ViewerCell` and
 * the mask-style helpers touch is present.
 */
interface FakeObject {
  id?: string;
  opacity: number;
  _readOnly?: boolean;
  /** The tint `createFabricObjectFromRawData` was asked for, if any. */
  maskFill?: string | undefined;
  set(key: string, value: unknown): void;
}
const objects: FakeObject[] = [];
const fakeCanvas = {
  getObjects: () => objects,
  add: vi.fn((...added: FakeObject[]) => objects.push(...added)),
  insertAt: vi.fn((index: number, ...added: FakeObject[]) => objects.splice(index, 0, ...added)),
  remove: vi.fn((...removed: FakeObject[]) => {
    for (const o of removed) {
      const at = objects.indexOf(o);
      if (at >= 0) objects.splice(at, 1);
    }
  }),
  on: vi.fn(),
  off: vi.fn(),
  requestRenderAll: vi.fn(),
  discardActiveObject: vi.fn(),
  setActiveObject: vi.fn(),
};

/** When set, every object build waits on it before resolving. */
let buildGate: Promise<void> | undefined;

/** The overlay's single authority over interaction flags; every built object must pass through it. */
const applyModeToObject = vi.fn();

/** Captures the OSD `'open'` handler so the test can fire it. */
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
    canvas = fakeCanvas;
    applyViewTransform = vi.fn();
    applyImageFilters = vi.fn();
    applyModeToObject = applyModeToObject;
    onSync = () => () => {};
    setMode = vi.fn();
    overlayElement = null;
  },
  DecorationLayer: class {
    destroy = vi.fn();
    setDecorations = vi.fn();
    onDomDecorations = vi.fn(() => () => {});
  },
}));

vi.mock('@osdlabel/osd-helper', async () => ({
  ...(await vi.importActual<typeof import('@osdlabel/osd-helper')>('@osdlabel/osd-helper')),
  DEFAULT_VIEWER_OPTIONS: {},
  openImage: vi.fn(),
}));

// The renderer is not under test; a fake object that remembers the tint it was
// asked for is enough to see the selected mask recoloured.
vi.mock('@osdlabel/fabric-annotations', async () => ({
  ...(await vi.importActual<typeof import('@osdlabel/fabric-annotations')>(
    '@osdlabel/fabric-annotations',
  )),
  createFabricObjectFromRawData: vi.fn(
    async (annotation: { id: string }, options?: { maskFill?: string | undefined }) => {
      // Lets a test hold every build open, to change the selection mid-rebuild.
      if (buildGate) await buildGate;
      const obj: FakeObject = {
        id: annotation.id,
        opacity: 1,
        maskFill: options?.maskFill,
        set(key, value) {
          (obj as unknown as Record<string, unknown>)[key] = value;
        },
      };
      return obj;
    },
  ),
}));

vi.mock('../../../src/hooks/useAnnotationTool.js', () => ({
  useAnnotationTool: () => undefined,
}));

const { default: ViewerCell } = await import('../../../src/components/ViewerCell.js');

const imageId = createImageId('img-1');
const contextId = createAnnotationContextId('ctx-1');
const m1 = createAnnotationId('m1');
const m2 = createAnnotationId('m2');

function mask(id: typeof m1, radius = 4) {
  const buffer = new BoundedDenseMaskBuffer({ imageWidth: 100, imageHeight: 100 });
  stampCircle(buffer, 50.5, 50.5, radius, 1);
  return createMaskAnnotation(buffer.snapshot(), { id, imageId, contextId });
}

const build = vi.mocked(createFabricObjectFromRawData);
const buildsFor = (id: string) => build.mock.calls.filter(([a]) => a.id === id).length;
const byId = (id: string) => objects.find((o) => o.id === id)!;

describe('ViewerCell reuses rasterized masks across rebuilds', () => {
  beforeEach(() => {
    objects.length = 0;
    openHandlers.length = 0;
    buildGate = undefined;
    build.mockClear();
  });
  afterEach(unmountAll);

  async function mountWithMasks(): Promise<AnnotatorHarness> {
    const h = renderAnnotator(
      { initialAnnotations: { [imageId]: { [m1]: mask(m1), [m2]: mask(m2) } } },
      <ViewerCell
        imageSource={{ id: imageId, tileSource: 'x.png' }}
        isActive
        cellIndex={0}
        onActivate={() => {}}
      />,
    );
    h.run((a) => {
      a.setContexts([{ id: contextId, label: 'All', tools: [{ type: 'segmentationBrush' }] }]);
      a.setActiveContext(contextId);
    });
    act(() => openHandlers[0]!());
    await vi.waitFor(() => expect(objects).toHaveLength(2));
    return h;
  }

  it('does not re-decode an unchanged mask when another annotation changes', async () => {
    const h = await mountWithMasks();
    const first = { m1: byId('m1'), m2: byId('m2') };
    expect(buildsFor('m1')).toBe(1);

    h.run((a) => a.addAnnotation(rect('r1', { imageId, contextId })));
    await vi.waitFor(() => expect(objects).toHaveLength(3));

    expect(buildsFor('m1')).toBe(1);
    expect(buildsFor('m2')).toBe(1);
    // The very same objects are back on the canvas, not equal copies.
    expect(byId('m1')).toBe(first.m1);
    expect(byId('m2')).toBe(first.m2);
  });

  it('re-decodes only the mask whose pixels changed', async () => {
    const h = await mountWithMasks();
    const buffer = new BoundedDenseMaskBuffer({ imageWidth: 100, imageHeight: 100 });
    stampCircle(buffer, 50.5, 50.5, 9, 1);
    // What a refining stroke writes: a fresh payload object for m1 only.
    h.run((a) => a.updateAnnotation(m1, imageId, maskAnnotationFields(buffer.snapshot())));
    await vi.waitFor(() => expect(buildsFor('m1')).toBe(2));
    expect(buildsFor('m2')).toBe(1);
  });
});
