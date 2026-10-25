import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRoot, createComponent } from 'solid-js';
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
import { createMockAnnotator } from '../hooks/mock-annotator.js';
import { createAnnotationStore } from '../../../src/state/annotation-store.js';

/**
 * A rebuild re-adds every annotation object on the image. A mask's object is a
 * decode and a full raster, so with many masks one stroke re-rasterized every
 * unchanged one. `MaskObjectCache` reuses the raster while a mask's payload
 * and tint are unchanged. Mirrored for React in
 * `packages/react/tests/unit/components/viewer-cell-mask-cache.test.tsx`.
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

const imageId = createImageId('img-1');
const contextId = createAnnotationContextId('ctx-1');
const m1 = createAnnotationId('m1');
const m2 = createAnnotationId('m2');
const m3 = createAnnotationId('m3');

function mask(id: typeof m1, radius = 4) {
  const buffer = new BoundedDenseMaskBuffer({ imageWidth: 100, imageHeight: 100 });
  stampCircle(buffer, 50.5, 50.5, radius, 1);
  return createMaskAnnotation(buffer.snapshot(), { id, imageId, contextId });
}

const build = vi.mocked(createFabricObjectFromRawData);
const buildsFor = (id: string) => build.mock.calls.filter(([a]) => a.id === id).length;
const byId = (id: string) => objects.find((o) => o.id === id)!;

// A reactive annotation store, so a state write re-runs the rebuild effect as
// it would in the real provider.
const { state: annotationState, setState: setAnnotations } = createAnnotationStore();
const mockState = createMockAnnotator({
  annotationState,
  contextState: { activeContextId: contextId, contexts: [], displayedContextIds: [] },
});

vi.mock('../../../src/state/annotator-context.js', () => ({
  useAnnotator: () => mockState,
}));
vi.mock('../../../src/hooks/useAnnotationTool.js', () => ({
  useAnnotationTool: () => undefined,
}));

const { default: ViewerCell } = await import('../../../src/components/ViewerCell.js');

describe('ViewerCell reuses rasterized masks across rebuilds', () => {
  let dispose: (() => void) | undefined;

  beforeEach(() => {
    objects.length = 0;
    openHandlers.length = 0;
    buildGate = undefined;
    build.mockClear();
    setAnnotations('byImage', { [imageId]: { [m1]: mask(m1), [m2]: mask(m2) } });
  });
  afterEach(() => {
    dispose?.();
    dispose = undefined;
  });

  async function mountWithMasks(): Promise<void> {
    dispose = createRoot((disposeFn) => {
      createComponent(ViewerCell, {
        imageSource: { id: imageId, tileSource: 'x.png' },
        isActive: true,
        cellIndex: 0,
        onActivate: () => {},
      });
      return disposeFn;
    });
    openHandlers[0]!();
    await vi.waitFor(() => expect(objects).toHaveLength(2));
  }

  it('does not re-decode an unchanged mask when another annotation changes', async () => {
    await mountWithMasks();
    const first = { m1: byId('m1'), m2: byId('m2') };
    expect(buildsFor('m1')).toBe(1);

    // A third mask lands — the shape of a brush commit on this image.
    setAnnotations('byImage', imageId, m3, mask(m3));
    await vi.waitFor(() => expect(objects).toHaveLength(3));

    expect(buildsFor('m1')).toBe(1);
    expect(buildsFor('m2')).toBe(1);
    expect(buildsFor('m3')).toBe(1);
    // The very same objects are back on the canvas, not equal copies.
    expect(byId('m1')).toBe(first.m1);
    expect(byId('m2')).toBe(first.m2);
  });

  it('re-decodes only the mask whose pixels changed', async () => {
    await mountWithMasks();
    const buffer = new BoundedDenseMaskBuffer({ imageWidth: 100, imageHeight: 100 });
    stampCircle(buffer, 50.5, 50.5, 9, 1);
    // What a refining stroke writes: a fresh payload object for m1 only.
    setAnnotations('byImage', imageId, m1, (prev) => ({
      ...prev!,
      ...maskAnnotationFields(buffer.snapshot()),
    }));
    await vi.waitFor(() => expect(buildsFor('m1')).toBe(2));
    expect(buildsFor('m2')).toBe(1);
  });
});
