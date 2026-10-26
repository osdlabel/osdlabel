import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRoot, createComponent } from 'solid-js';
import { createAnnotationContextId } from '@osdlabel/annotation-context';
import { createImageId } from '@osdlabel/viewer-api';
import { createAnnotationId } from '@osdlabel/annotation';
import {
  MaskCanvasTooLargeError,
  createFabricObjectFromRawData,
} from '@osdlabel/fabric-annotations';
import {
  BoundedDenseMaskBuffer,
  MASK_RAW_FORMAT,
  createMaskAnnotation,
  decodeCanonicalRaster,
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

/** When set, masks come from the real renderer, so their placement can be read. */
let realRenderer = false;

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
vi.mock('@osdlabel/fabric-annotations', async () => {
  const actual = await vi.importActual<typeof import('@osdlabel/fabric-annotations')>(
    '@osdlabel/fabric-annotations',
  );
  return {
    ...actual,
    createFabricObjectFromRawData: vi.fn(
      async (
        annotation: Parameters<typeof actual.createFabricObjectFromRawData>[0],
        options?: { maskFill?: string | undefined },
      ) => {
        if (realRenderer && annotation.rawAnnotationData.format === 'osdlabel-mask') {
          return actual.createFabricObjectFromRawData(annotation, options);
        }
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
        return obj as unknown as Awaited<ReturnType<typeof actual.createFabricObjectFromRawData>>;
      },
    ),
  };
});

const imageId = createImageId('img-1');
const contextId = createAnnotationContextId('ctx-1');
const m1 = createAnnotationId('m1');
const m2 = createAnnotationId('m2');
const m3 = createAnnotationId('m3');

/** A 4x mask on a 101-square image, reaching its clipped last cell column and row. */
function coarseMask(id: typeof m1, radius = 12) {
  const buffer = new BoundedDenseMaskBuffer({ imageWidth: 101, imageHeight: 101, downsample: 4 });
  stampCircle(buffer, 92, 92, radius, 1);
  return createMaskAnnotation(buffer.snapshot(), { id, imageId, contextId });
}

/**
 * A 40,000 x 1,600-cell mask: inside the cell cap, too long for any canvas
 * every browser draws.
 */
function tooLongMask(id: typeof m1) {
  // One solid run, LEB128 and base64 by hand: the runs are all there is.
  const cells = 40_000 * 1_600;
  const bytes = [0];
  for (let n = cells; ; n = Math.floor(n / 0x80)) {
    if (n < 0x80) {
      bytes.push(n);
      break;
    }
    bytes.push((n % 0x80) | 0x80);
  }
  const raster = decodeCanonicalRaster({
    x: 0,
    y: 0,
    width: 40_000,
    height: 1_600,
    imageWidth: 100_000,
    imageHeight: 100_000,
    counts: btoa(String.fromCharCode(...bytes)),
  });
  return createMaskAnnotation(raster, { id, imageId, contextId });
}

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
    realRenderer = false;
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

  it('places a downsampled mask by its cells, and reuses it like any other', async () => {
    realRenderer = true;
    setAnnotations('byImage', { [imageId]: { [m1]: coarseMask(m1), [m2]: mask(m2) } });
    await mountWithMasks();
    const placed = byId('m1') as unknown as {
      left: number;
      top: number;
      scaleX: number;
      scaleY: number;
      width: number;
      height: number;
    };
    const geometry = annotationState.byImage[imageId]![m1]!.geometry;
    if (geometry.type !== 'mask') throw new Error('expected a mask');
    expect(geometry.downsample).toBe(4);
    // Image-space placement: the box origin, one canvas pixel per 4x4 cell,
    // the clipped last cell drawn full-size.
    expect(placed.left).toBe(geometry.origin.x);
    expect(placed.top).toBe(geometry.origin.y);
    expect([placed.scaleX, placed.scaleY]).toEqual([4, 4]);
    expect(placed.width).toBe(Math.ceil(geometry.width / 4));
    expect(placed.height).toBe(Math.ceil(geometry.height / 4));
    expect(geometry.origin.x + geometry.width).toBe(101);

    setAnnotations('byImage', imageId, m3, mask(m3));
    await vi.waitFor(() => expect(objects).toHaveLength(3));
    expect(buildsFor('m1')).toBe(1);
    expect(byId('m1')).toBe(placed);
  });

  it('re-decodes a downsampled mask that a stroke refined, at its own downsample', async () => {
    realRenderer = true;
    setAnnotations('byImage', { [imageId]: { [m1]: coarseMask(m1), [m2]: mask(m2) } });
    await mountWithMasks();
    const before = byId('m1');
    const raw = annotationState.byImage[imageId]![m1]!.rawAnnotationData;
    if (raw.format !== MASK_RAW_FORMAT) throw new Error('expected a mask payload');
    // What a refining stroke starts from: the stored mask, at its own grid.
    const refined = BoundedDenseMaskBuffer.fromSnapshot(decodeCanonicalRaster(raw.data));
    stampCircle(refined, 60, 60, 8, 1);
    setAnnotations('byImage', imageId, m1, (prev) => ({
      ...prev!,
      ...maskAnnotationFields(refined.snapshot()),
    }));
    await vi.waitFor(() => expect(buildsFor('m1')).toBe(2));
    // The rebuilt object lands once its build resolves.
    await vi.waitFor(() =>
      expect(objects.find((o) => o.id === 'm1' && o !== before)).toBeDefined(),
    );
    const after = byId('m1') as unknown as { scaleX: number };
    expect(after.scaleX).toBe(4);
    expect(buildsFor('m2')).toBe(1);
  });

  it('reports a mask too long to draw, and still renders the others', async () => {
    realRenderer = true;
    const report = vi.mocked(mockState.reportAnnotationRenderError);
    report.mockClear();
    setAnnotations('byImage', { [imageId]: { [m1]: tooLongMask(m1), [m2]: mask(m2) } });
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

    await vi.waitFor(() => expect(report).toHaveBeenCalled());
    const failure = report.mock.calls[0]![0];
    expect(failure.annotation.id).toBe(m1);
    expect(failure.error).toBeInstanceOf(MaskCanvasTooLargeError);
    expect(objects.map((o) => o.id)).toEqual(['m2']);
  });
});
