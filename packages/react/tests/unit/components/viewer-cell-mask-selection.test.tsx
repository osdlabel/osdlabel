import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { createAnnotationContextId } from '@osdlabel/annotation-context';
import { createImageId } from '@osdlabel/viewer-api';
import { createAnnotationId } from '@osdlabel/annotation';
// `@osdlabel/mask` is not a dependency of this package; `osdlabel` re-exports it.
import {
  BoundedDenseMaskBuffer,
  createMaskAnnotation,
  DEFAULT_UNSELECTED_MASK_OPACITY,
  MaskObjectCache,
  stampCircle,
  type MaskStyle,
} from 'osdlabel';
import { renderAnnotator, type AnnotatorHarness, type ProviderProps } from '../render-annotator.js';
import { unmountAll } from '../mount.js';

/**
 * The React counterpart of Solid's `components/viewer-cell-mask-selection.test.ts`,
 * run against the real provider: the selection effect reads masks from the
 * store and the rebuild reads the selection from it, and that wiring is what
 * differs from Solid.
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
  /** The brush hides the committed object for the length of a stroke. */
  visible?: boolean;
  /** The tint `createFabricObjectFromRawData` was asked for, if any. */
  maskFill?: string | undefined;
  set(key: string, value: unknown): void;
}
const objects: FakeObject[] = [];

/** The cell's cache instances, captured as they are first used. */
const caches: MaskObjectCache[] = [];
for (const method of ['retain', 'clear'] as const) {
  const original = MaskObjectCache.prototype[method];
  vi.spyOn(MaskObjectCache.prototype, method).mockImplementation(function (
    this: MaskObjectCache,
    ...args: unknown[]
  ) {
    if (!caches.includes(this)) caches.push(this);
    return (original as (...a: unknown[]) => void).apply(this, args);
  });
}
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

function mask(id: typeof m1, image = imageId, context = contextId) {
  const buffer = new BoundedDenseMaskBuffer({ imageWidth: 100, imageHeight: 100 });
  stampCircle(buffer, 50.5, 50.5, 4, 1);
  return createMaskAnnotation(buffer.snapshot(), { id, imageId: image, contextId: context });
}
const image2 = createImageId('img-2');
const m3 = createAnnotationId('m3');
const contextId2 = createAnnotationContextId('ctx-2');

const byId = (id: string) => objects.find((o) => o.id === id)!;

describe('ViewerCell selected-mask styling', () => {
  beforeEach(() => {
    objects.length = 0;
    openHandlers.length = 0;
    buildGate = undefined;
    applyModeToObject.mockClear();
    caches.length = 0;
  });
  afterEach(unmountAll);

  const r1 = createAnnotationId('r1');
  /** A vector annotation on the same image: selecting it must not dim the masks. */
  const rectAnnotation = {
    id: r1,
    imageId,
    contextId,
    toolType: 'rectangle' as const,
    geometry: {
      type: 'rectangle' as const,
      origin: { x: 0, y: 0 },
      width: 5,
      height: 5,
      rotation: 0,
    },
    rawAnnotationData: { format: 'fabric' as const, fabricVersion: 'test', data: { type: 'Rect' } },
    createdAt: 'now',
    updatedAt: 'now',
  };
  const cell = (
    <ViewerCell
      imageSource={{ id: imageId, tileSource: 'x.png' }}
      isActive
      cellIndex={0}
      onActivate={() => {}}
    />
  );
  const providerProps = (maskStyle?: MaskStyle, maxPixels?: number): ProviderProps => ({
    initialAnnotations: { [imageId]: { [m1]: mask(m1), [m2]: mask(m2), [r1]: rectAnnotation } },
    ...(maskStyle || maxPixels !== undefined
      ? {
          brushOptions: {
            ...(maskStyle ? { maskStyle } : {}),
            ...(maxPixels !== undefined ? { maxPixels } : {}),
          },
        }
      : {}),
  });

  async function mountWithMasks(
    maskStyle?: MaskStyle,
    selected: typeof m1 | null = null,
  ): Promise<AnnotatorHarness> {
    const h = renderAnnotator(providerProps(maskStyle), cell);
    h.run((a) => {
      a.setContexts([{ id: contextId, label: 'All', tools: [{ type: 'segmentationBrush' }] }]);
      a.setActiveContext(contextId);
      if (selected) a.setSelectedAnnotation(selected);
    });
    act(() => openHandlers[0]!());
    await vi.waitFor(() => expect(objects).toHaveLength(3));
    return h;
  }

  it('renders every mask at full opacity while nothing is selected', async () => {
    await mountWithMasks();
    expect(byId('m1').opacity).toBe(1);
    expect(byId('m2').opacity).toBe(1);
    expect(byId('m1').maskFill).toBeUndefined();
    // Interactivity is the overlay's call: each rebuilt object goes through it.
    expect(applyModeToObject).toHaveBeenCalledWith(byId('m1'), false);
    expect(applyModeToObject).toHaveBeenCalledWith(byId('m2'), false);
  });

  it('dims the other masks when one is selected, without rebuilding, and restores them', async () => {
    const h = await mountWithMasks();
    const before = [...objects];

    h.run((a) => a.setSelectedAnnotation(m1));
    expect(byId('m1').opacity).toBe(1);
    expect(byId('m2').opacity).toBe(DEFAULT_UNSELECTED_MASK_OPACITY);
    // The same objects: a selection change must not re-decode every mask.
    expect(objects).toEqual(before);

    h.run((a) => a.setSelectedAnnotation(null));
    expect(byId('m2').opacity).toBe(1);
  });

  it('honours a configured dimming level', async () => {
    const h = await mountWithMasks({ unselectedOpacity: 0.1 });
    h.run((a) => a.setSelectedAnnotation(m2));
    expect(byId('m1').opacity).toBe(0.1);
  });

  it('recolours only the selected mask when selectedFill is set, swapping it in place', async () => {
    const h = await mountWithMasks({ selectedFill: '#ff0000' });
    const index = objects.indexOf(byId('m1'));

    h.run((a) => a.setSelectedAnnotation(m1));
    await vi.waitFor(() => expect(byId('m1').maskFill).toBe('#ff0000'));
    expect(objects.indexOf(byId('m1'))).toBe(index);
    // The replacement is a new object; it too must get the overlay's mode.
    expect(applyModeToObject).toHaveBeenCalledWith(byId('m1'), false);
    expect(byId('m2').maskFill).toBeUndefined();
    expect(byId('m2').opacity).toBe(DEFAULT_UNSELECTED_MASK_OPACITY);

    // Moving the selection recolours the one that lost it back, and the new one.
    h.run((a) => a.setSelectedAnnotation(m2));
    await vi.waitFor(() => expect(byId('m2').maskFill).toBe('#ff0000'));
    await vi.waitFor(() => expect(byId('m1').maskFill).toBeUndefined());
    expect(byId('m1').opacity).toBe(DEFAULT_UNSELECTED_MASK_OPACITY);
    expect(byId('m2').opacity).toBe(1);
  });

  it('builds the selected mask in the selected tint on a rebuild', async () => {
    await mountWithMasks({ selectedFill: '#ff0000' }, m2);
    expect(byId('m2').maskFill).toBe('#ff0000');
    expect(byId('m1').maskFill).toBeUndefined();
    expect(byId('m1').opacity).toBe(DEFAULT_UNSELECTED_MASK_OPACITY);
  });
  it('applies a selection made while the rebuild was still in flight', async () => {
    // A click can land while the objects are still being built: the selection
    // effect then finds a canvas the rebuild has just cleared, so the rebuild
    // has to re-apply the selection when its objects land. (Solid hits this on
    // every brush commit, whose two writes straddle its rebuild.)
    let release!: () => void;
    buildGate = new Promise<void>((resolve) => {
      release = resolve;
    });
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
    expect(objects).toHaveLength(0);

    h.run((a) => a.setSelectedAnnotation(m2));
    release();
    await vi.waitFor(() => expect(objects).toHaveLength(2));

    expect(byId('m2').opacity).toBe(1);
    expect(byId('m1').opacity).toBe(DEFAULT_UNSELECTED_MASK_OPACITY);
  });

  it('does not dim masks for a selected vector annotation or a selection on another image', async () => {
    const h = await mountWithMasks();
    h.run((a) => a.setSelectedAnnotation(r1));
    expect(byId('m1').opacity).toBe(1);
    expect(byId('m2').opacity).toBe(1);

    // Selection is global: a mask selected in another grid cell is not one of
    // this cell's masks.
    h.run((a) => a.setSelectedAnnotation(createAnnotationId('mask-on-another-image')));
    expect(byId('m1').opacity).toBe(1);
    expect(byId('m2').opacity).toBe(1);
  });

  it('restores the others when the selected mask is deleted without clearing selection', async () => {
    const h = await mountWithMasks();
    h.run((a) => a.setSelectedAnnotation(m1));
    expect(byId('m2').opacity).toBe(DEFAULT_UNSELECTED_MASK_OPACITY);

    // `deleteAnnotation` leaves `selectedAnnotationId` pointing at a mask that
    // no longer exists; the rebuild must treat that as "no mask selected".
    h.run((a) => a.deleteAnnotation(m1, imageId));
    // The rebuild clears the canvas first, so wait for it to land: m2 and the
    // rectangle come back, m1 does not.
    await vi.waitFor(() => expect(objects).toHaveLength(2));
    expect(objects.find((o) => o.id === 'm1')).toBeUndefined();
    expect(byId('m2').opacity).toBe(1);
  });

  it('reverts the selected tint when selectedFill is turned off at runtime', async () => {
    const h = await mountWithMasks({ selectedFill: '#ff0000' });
    h.run((a) => a.setSelectedAnnotation(m1));
    await vi.waitFor(() => expect(byId('m1').maskFill).toBe('#ff0000'));

    h.rerender(providerProps({}), cell);
    await vi.waitFor(() => expect(byId('m1').maskFill).toBeUndefined());
    // Dimming is unaffected: m1 is still the selected mask.
    expect(byId('m2').opacity).toBe(DEFAULT_UNSELECTED_MASK_OPACITY);
  });

  it('does not re-decode the selected mask when only maxPixels changes', async () => {
    // `maskStyle` has its own memo in the provider, so a `maxPixels` change
    // must not hand the selection effect a new object and cost a decode.
    const h = await mountWithMasks({ selectedFill: '#ff0000' });
    h.run((a) => a.setSelectedAnnotation(m1));
    await vi.waitFor(() => expect(byId('m1').maskFill).toBe('#ff0000'));
    const swaps = fakeCanvas.insertAt.mock.calls.length;

    h.rerender(providerProps({ selectedFill: '#ff0000' }, 4096), cell);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(fakeCanvas.insertAt.mock.calls.length).toBe(swaps);
  });

  const cellFor = (imageSource: { id: typeof imageId; tileSource: string } | undefined) => (
    <ViewerCell imageSource={imageSource} isActive cellIndex={0} onActivate={() => {}} />
  );
  const cache = () => caches[0]!;
  const twoImages: ProviderProps = {
    initialAnnotations: {
      [imageId]: { [m1]: mask(m1), [m2]: mask(m2), [r1]: rectAnnotation },
      [image2]: { [m3]: mask(m3, image2) },
    },
  };

  it('drops a pending tint swap when selectedFill is turned off, whichever effect issued it', async () => {
    // The rebuild re-applies the selection when its objects land, and when a
    // mask was selected meanwhile under a `selectedFill` it issues the tint
    // swap itself. That swap used to be cancelled only by a selection change,
    // so the style going off while it decoded let it land — and nothing then
    // reverted it, the record saying no tint was applied.
    let release!: () => void;
    buildGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const h = renderAnnotator(providerProps({ selectedFill: '#ff0000' }), cell);
    h.run((a) => {
      a.setContexts([{ id: contextId, label: 'All', tools: [{ type: 'segmentationBrush' }] }]);
      a.setActiveContext(contextId);
    });
    act(() => openHandlers[0]!());
    h.run((a) => a.setSelectedAnnotation(m1));
    // The rebuild's own swap decodes behind a second gate.
    let releaseSwap!: () => void;
    release();
    buildGate = new Promise<void>((resolve) => {
      releaseSwap = resolve;
    });
    await vi.waitFor(() => expect(objects).toHaveLength(3));
    expect(byId('m1').maskFill).toBeUndefined();

    h.rerender(providerProps({}), cell);
    releaseSwap();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(byId('m1').maskFill).toBeUndefined();
    expect(byId('m2').opacity).toBe(DEFAULT_UNSELECTED_MASK_OPACITY);
  });

  it('keeps its record honest when a swap skips the mask a stroke has hidden', async () => {
    const h = await mountWithMasks({ selectedFill: '#ff0000' });
    h.run((a) => a.setSelectedAnnotation(m1));
    await vi.waitFor(() => expect(byId('m1').maskFill).toBe('#ff0000'));

    // Mid-stroke on m1, the host turns the tint off: the swap must leave the
    // hidden object alone, and must not claim the revert happened.
    byId('m1').visible = false;
    h.rerender(providerProps({}), cell);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(byId('m1').maskFill).toBe('#ff0000');

    // The stroke is cancelled, so the object comes back and no rebuild
    // follows; the next selection change has to revert it.
    byId('m1').visible = true;
    h.run((a) => a.setSelectedAnnotation(m2));
    await vi.waitFor(() => expect(byId('m1').maskFill).toBeUndefined());
  });

  it('does not cache rasters a superseded rebuild decoded for another image', async () => {
    let releaseFirst!: () => void;
    buildGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const h = renderAnnotator(twoImages, cellFor({ id: imageId, tileSource: 'x.png' }));
    h.run((a) => {
      a.setContexts([{ id: contextId, label: 'All', tools: [{ type: 'segmentationBrush' }] }]);
      a.setActiveContext(contextId);
    });
    act(() => openHandlers[0]!());
    // The cell moves to another image before the first one's masks decode,
    // and the new image lands first.
    let releaseSecond!: () => void;
    buildGate = new Promise<void>((resolve) => {
      releaseSecond = resolve;
    });
    h.rerender(twoImages, cellFor({ id: image2, tileSource: 'y.png' }));
    releaseSecond();
    await vi.waitFor(() => expect(objects.map((o) => o.id)).toEqual(['m3']));
    expect(cache().size).toBe(1);

    releaseFirst();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(objects.map((o) => o.id)).toEqual(['m3']);
    // A cell showing a static image never rebuilds, so a late write would
    // have kept the first image's rasters for good.
    expect(cache().size).toBe(1);
  });

  it('releases its rasters when the image is unassigned', async () => {
    const h = renderAnnotator(twoImages, cellFor({ id: imageId, tileSource: 'x.png' }));
    h.run((a) => {
      a.setContexts([{ id: contextId, label: 'All', tools: [{ type: 'segmentationBrush' }] }]);
      a.setActiveContext(contextId);
    });
    act(() => openHandlers[0]!());
    await vi.waitFor(() => expect(objects).toHaveLength(3));
    expect(cache().size).toBe(2);
    h.rerender(twoImages, cellFor(undefined));
    expect(cache().size).toBe(0);
  });

  it('does not dim for a selected mask in a context that is not displayed', async () => {
    // Selection survives a context switch, so a mask of a context that is
    // neither active nor displayed can be the selection while not being on
    // the canvas; nothing visible is selected, so nothing is dimmed. Solid
    // reads the visible set; this effect reads the store, and must agree.
    const h = renderAnnotator(
      {
        initialAnnotations: {
          [imageId]: {
            [m1]: mask(m1),
            [m2]: mask(m2),
            [r1]: rectAnnotation,
            [m3]: mask(m3, imageId, contextId2),
          },
        },
      },
      cell,
    );
    h.run((a) => {
      a.setContexts([
        { id: contextId, label: 'All', tools: [{ type: 'segmentationBrush' }] },
        { id: contextId2, label: 'Other', tools: [{ type: 'segmentationBrush' }] },
      ]);
      a.setActiveContext(contextId);
    });
    act(() => openHandlers[0]!());
    await vi.waitFor(() => expect(objects).toHaveLength(3));
    expect(objects.find((o) => o.id === 'm3')).toBeUndefined();

    h.run((a) => a.setSelectedAnnotation(m3));
    expect(byId('m1').opacity).toBe(1);
    expect(byId('m2').opacity).toBe(1);
  });
});
