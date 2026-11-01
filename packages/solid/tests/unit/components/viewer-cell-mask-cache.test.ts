import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRoot, createComponent, createSignal } from 'solid-js';
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
  type BrushOptions,
  type MaskObjectSeed,
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
    onPointerCancel = () => () => {};
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

/**
 * A solid 16 x 16 block at the image's top-left: every halving keeps it, so
 * at the coarsest grid it is one set cell, which fits even a one-pixel budget.
 */
function cornerBlock(id: typeof m1) {
  const buffer = new BoundedDenseMaskBuffer({ imageWidth: 100, imageHeight: 100 });
  for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) buffer.set(x, y, 1);
  return createMaskAnnotation(buffer.snapshot(), { id, imageId, contextId });
}

/**
 * A mask whose box straddles the 2^16 cell boundary in both axes: 2x2 cells
 * even at the coarsest grid, so no mip fits a one-cell display budget.
 */
function straddlingMask(id: typeof m1) {
  const buffer = new BoundedDenseMaskBuffer({ imageWidth: 100_000, imageHeight: 100_000 });
  stampCircle(buffer, 65_536, 65_536, 6, 1);
  return createMaskAnnotation(buffer.snapshot(), { id, imageId, contextId });
}

const build = vi.mocked(createFabricObjectFromRawData);
const buildsFor = (id: string) => build.mock.calls.filter(([a]) => a.id === id).length;
const byId = (id: string) => objects.find((o) => o.id === id)!;

// A reactive annotation store, so a state write re-runs the rebuild effect as
// it would in the real provider.
const { state: annotationState, setState: setAnnotations } = createAnnotationStore();
// Getters over the host's options, as the provider's are: reading one tracks
// the whole host object, so a new object notifies even with every value
// equal. A store write of an equal value would never notify, and a test of
// "no change" would pass for the wrong reason.
const [hostOptions, setHostOptions] = createSignal<BrushOptions>({});
const brushOptions: BrushOptions = {
  get maxCanvasPixels() {
    return hostOptions().maxCanvasPixels;
  },
  get maskStyle() {
    return hostOptions().maskStyle;
  },
  get onCoarsen() {
    return hostOptions().onCoarsen;
  },
};
const setBudget = (maxCanvasPixels: number | undefined) =>
  setHostOptions({ ...hostOptions(), maxCanvasPixels });
const mockState = createMockAnnotator({
  annotationState,
  brushOptions,
  contextState: { activeContextId: contextId, contexts: [], displayedContextIds: [] },
});

vi.mock('../../../src/state/annotator-context.js', () => ({
  useAnnotator: () => mockState,
}));
/** The cell's hooks into a brush commit, as ViewerCell hands them to the tool hook. */
let toolCell: { seedMaskObject?: (seed: MaskObjectSeed) => void } | undefined;
vi.mock('../../../src/hooks/useAnnotationTool.js', () => ({
  useAnnotationTool: (...args: unknown[]) => {
    toolCell = args[3] as typeof toolCell;
  },
}));

const { default: ViewerCell } = await import('../../../src/components/ViewerCell.js');

describe('ViewerCell reuses rasterized masks across rebuilds', () => {
  let dispose: (() => void) | undefined;

  beforeEach(() => {
    objects.length = 0;
    openHandlers.length = 0;
    buildGate = undefined;
    realRenderer = false;
    setHostOptions({});
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

  /** Mounts the cell over the store's annotations; the caller sets them first. */
  function mountCell(): void {
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
  }

  it('draws a mask too long for one canvas from a display mip', async () => {
    realRenderer = true;
    const report = vi.mocked(mockState.reportAnnotationRenderError);
    report.mockClear();
    setAnnotations('byImage', { [imageId]: { [m1]: tooLongMask(m1), [m2]: mask(m2) } });
    mountCell();

    await vi.waitFor(() => expect(objects).toHaveLength(2));
    const drawn = byId('m1') as unknown as { width: number; height: number; scaleX: number };
    expect([drawn.width, drawn.height, drawn.scaleX]).toEqual([20_000, 800, 2]);
    expect(report).not.toHaveBeenCalled();
  });

  it('reports a mask no display mip fits, and still renders the others', async () => {
    realRenderer = true;
    setBudget(1);
    const report = vi.mocked(mockState.reportAnnotationRenderError);
    report.mockClear();
    // m2 is one set cell at its coarsest grid, so it fits even this budget.
    setAnnotations('byImage', { [imageId]: { [m1]: straddlingMask(m1), [m2]: cornerBlock(m2) } });
    mountCell();

    await vi.waitFor(() => expect(report).toHaveBeenCalled());
    const failure = report.mock.calls[0]![0];
    expect(failure.annotation.id).toBe(m1);
    expect(failure.error).toBeInstanceOf(MaskCanvasTooLargeError);
    await vi.waitFor(() => expect(objects.map((o) => o.id)).toEqual(['m2']));
  });

  it('redraws every mask when the display budget changes, and only then', async () => {
    realRenderer = true;
    setAnnotations('byImage', { [imageId]: { [m1]: mask(m1, 40), [m2]: mask(m2) } });
    mountCell();
    await vi.waitFor(() => expect(objects).toHaveLength(2));
    expect((byId('m1') as unknown as { scaleX: number }).scaleX).toBe(1);

    // 81x81 cells: a 1,000-cell budget takes it to 21x21 at 4x.
    setBudget(1_000);
    await vi.waitFor(() => expect(buildsFor('m1')).toBe(2));
    expect(buildsFor('m2')).toBe(2);
    await vi.waitFor(() => expect((byId('m1') as unknown as { scaleX: number }).scaleX).toBe(4));

    // The same value again is no change.
    setBudget(1_000);
    setAnnotations('byImage', imageId, m2, mask(m2, 3));
    await vi.waitFor(() => expect(buildsFor('m2')).toBe(3));
    expect(buildsFor('m1')).toBe(2);
  });

  it('rebuilds nothing for a new options object with an equal budget (#243 P6)', async () => {
    realRenderer = true;
    setAnnotations('byImage', { [imageId]: { [m1]: mask(m1, 40), [m2]: mask(m2) } });
    mountCell();
    await vi.waitFor(() => expect(objects).toHaveLength(2));
    setBudget(1_000);
    await vi.waitFor(() => expect(buildsFor('m1')).toBe(2));
    await vi.waitFor(() => expect(objects).toHaveLength(2));
    const removes = fakeCanvas.remove.mock.calls.length;
    // A new object: the same budget, a new callback and an equal style.
    setHostOptions({ maxCanvasPixels: 1_000, onCoarsen: () => {}, maskStyle: {} });
    setHostOptions({ maxCanvasPixels: 1_000, onCoarsen: () => {}, maskStyle: {} });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(buildsFor('m1')).toBe(2);
    expect(buildsFor('m2')).toBe(2);
    expect(fakeCanvas.remove.mock.calls.length).toBe(removes);
  });

  it('keeps the cache under a NaN budget, which never equals itself (#243 minor 12)', async () => {
    setBudget(Number.NaN);
    await mountWithMasks();
    expect(buildsFor('m1')).toBe(1);
    setAnnotations('byImage', imageId, m2, mask(m2, 3));
    await vi.waitFor(() => expect(buildsFor('m2')).toBe(2));
    expect(buildsFor('m1')).toBe(1);
  });

  /** A refining stroke's commit: the new payload, and the object its preview made. */
  function brushCommit(fill: string | undefined) {
    const buffer = new BoundedDenseMaskBuffer({ imageWidth: 100, imageHeight: 100 });
    stampCircle(buffer, 50.5, 50.5, 9, 1);
    const fields = maskAnnotationFields(buffer.snapshot());
    if (fields.rawAnnotationData.format !== MASK_RAW_FORMAT) throw new Error('expected a mask');
    const object: FakeObject = {
      id: m1,
      opacity: 1,
      set(key, value) {
        (object as unknown as Record<string, unknown>)[key] = value;
      },
    };
    return { fields, object, rawAnnotationData: fields.rawAnnotationData, fill };
  }

  it("shows a brush commit's seeded object without rebuilding it (#238)", async () => {
    await mountWithMasks();
    expect(toolCell?.seedMaskObject).toBeDefined();
    const commit = brushCommit(undefined);
    // What the brush does: seed, then write. The store hands the payload back
    // as a proxy, so the cache matches it by content.
    toolCell!.seedMaskObject!({
      annotationId: m1,
      rawAnnotationData: commit.rawAnnotationData,
      fill: undefined,
      // The 19 x 19 cells of the r=9 disc, and the object its preview builds.
      width: 19,
      height: 19,
      object: (() => commit.object) as unknown as MaskObjectSeed['object'],
    });
    setAnnotations('byImage', imageId, m1, (prev) => ({ ...prev!, ...commit.fields }));
    await vi.waitFor(() => expect(byId('m1')).toBe(commit.object));
    expect(buildsFor('m1')).toBe(1);
  });

  it("rebuilds instead when the seed is past the host's display budget (#243 minor 14)", async () => {
    await mountWithMasks();
    setBudget(100);
    await vi.waitFor(() => expect(buildsFor('m1')).toBe(2));
    const commit = brushCommit(undefined);
    let built = 0;
    toolCell!.seedMaskObject!({
      annotationId: m1,
      rawAnnotationData: commit.rawAnnotationData,
      fill: undefined,
      // 361 cells: past a 100-pixel budget, which a mip would have to draw.
      width: 19,
      height: 19,
      object: (() => {
        built++;
        return commit.object;
      }) as unknown as MaskObjectSeed['object'],
    });
    setAnnotations('byImage', imageId, m1, (prev) => ({ ...prev!, ...commit.fields }));
    await vi.waitFor(() => expect(buildsFor('m1')).toBe(3));
    await vi.waitFor(() => expect(objects.find((o) => o.id === 'm1')).toBeDefined());
    expect(byId('m1')).not.toBe(commit.object);
    expect(built).toBe(0);
  });

  it('rebuilds instead when the seed was drawn in another tint', async () => {
    await mountWithMasks();
    const commit = brushCommit('rgba(255, 0, 0, 1)');
    toolCell!.seedMaskObject!({
      annotationId: m1,
      rawAnnotationData: commit.rawAnnotationData,
      fill: 'rgba(255, 0, 0, 1)',
      // The 19 x 19 cells of the r=9 disc, and the object its preview builds.
      width: 19,
      height: 19,
      object: (() => commit.object) as unknown as MaskObjectSeed['object'],
    });
    setAnnotations('byImage', imageId, m1, (prev) => ({ ...prev!, ...commit.fields }));
    await vi.waitFor(() => expect(buildsFor('m1')).toBe(2));
    await vi.waitFor(() => expect(objects.find((o) => o.id === 'm1')).toBeDefined());
    expect(byId('m1')).not.toBe(commit.object);
  });
});
