import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
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
  type OsdAnnotation,
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

vi.mock('../../../src/hooks/useAnnotationTool.js', () => ({
  useAnnotationTool: () => undefined,
}));

const { default: ViewerCell } = await import('../../../src/components/ViewerCell.js');

const imageId = createImageId('img-1');
const contextId = createAnnotationContextId('ctx-1');
const m1 = createAnnotationId('m1');
const m2 = createAnnotationId('m2');

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

/** A 4x mask on a 101-square image, reaching its clipped last cell column and row. */
function coarseMask(id: typeof m1, radius = 12) {
  const buffer = new BoundedDenseMaskBuffer({ imageWidth: 101, imageHeight: 101, downsample: 4 });
  stampCircle(buffer, 92, 92, radius, 1);
  return createMaskAnnotation(buffer.snapshot(), { id, imageId, contextId });
}

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
    realRenderer = false;
    build.mockClear();
  });
  afterEach(unmountAll);

  async function mountWithMasks(first: OsdAnnotation = mask(m1)): Promise<AnnotatorHarness> {
    const h = renderAnnotator(
      { initialAnnotations: { [imageId]: { [m1]: first, [m2]: mask(m2) } } },
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

  it('places a downsampled mask by its cells, and reuses it like any other', async () => {
    realRenderer = true;
    const coarse = coarseMask(m1);
    const h = await mountWithMasks(coarse);
    const placed = byId('m1') as unknown as {
      left: number;
      top: number;
      scaleX: number;
      scaleY: number;
      width: number;
      height: number;
    };
    const geometry = coarse.geometry;
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

    h.run((a) => a.addAnnotation(rect('r1', { imageId, contextId })));
    await vi.waitFor(() => expect(objects).toHaveLength(3));
    expect(buildsFor('m1')).toBe(1);
    expect(byId('m1')).toBe(placed);
  });

  it('re-decodes a downsampled mask that a stroke refined, at its own downsample', async () => {
    realRenderer = true;
    const coarse = coarseMask(m1);
    const h = await mountWithMasks(coarse);
    const before = byId('m1');
    const raw = coarse.rawAnnotationData;
    if (raw.format !== MASK_RAW_FORMAT) throw new Error('expected a mask payload');
    // What a refining stroke starts from: the stored mask, at its own grid.
    const refined = BoundedDenseMaskBuffer.fromSnapshot(decodeCanonicalRaster(raw.data));
    stampCircle(refined, 60, 60, 8, 1);
    h.run((a) => a.updateAnnotation(m1, imageId, maskAnnotationFields(refined.snapshot())));
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
    const report = vi.fn();
    const h = renderAnnotator(
      {
        initialAnnotations: { [imageId]: { [m1]: tooLongMask(m1), [m2]: mask(m2) } },
        onAnnotationRenderError: report,
      },
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

    await vi.waitFor(() => expect(report).toHaveBeenCalled());
    const failure = report.mock.calls[0]![0] as { annotation: { id: string }; error: unknown };
    expect(failure.annotation.id).toBe(m1);
    expect(failure.error).toBeInstanceOf(MaskCanvasTooLargeError);
    expect(objects.map((o) => o.id)).toEqual(['m2']);
  });
});
