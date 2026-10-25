import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRoot, createComponent, createSignal } from 'solid-js';
import { createAnnotationContextId } from '@osdlabel/annotation-context';
import { createImageId, type ImageSource } from '@osdlabel/viewer-api';
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
import { createMockAnnotator } from '../hooks/mock-annotator.js';
import { createUIStore } from '../../../src/state/ui-store.js';

/**
 * The selected mask is told apart from the others by dimming them and, if the
 * host asks, recolouring it. Both happen in `ViewerCell`: on every rebuild and,
 * without a rebuild, on every selection change. Mirrored for React in
 * `packages/react/tests/unit/components/viewer-cell-mask-selection.test.tsx`.
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

// A reactive UI store, so a selection change re-runs the cell's effects as it
// would in the real provider.
const { state: uiState, setState: setUi } = createUIStore();
// A signal behind the getter, as the real provider's props are reactive, so a
// style change after mount re-runs the cell's selection effect.
const [maskStyleSignal, setMaskStyle] = createSignal<MaskStyle | undefined>(undefined);
const brushOptions = {
  get maskStyle() {
    return maskStyleSignal();
  },
};
const mockState = createMockAnnotator({
  uiState,
  brushOptions,
  contextState: { activeContextId: contextId, contexts: [], displayedContextIds: [] },
});
const r1 = createAnnotationId('r1');
/** The image's annotations, re-seeded before each test since a test may delete one. */
function seedAnnotations(): void {
  mockState.annotationState.byImage[imageId] = {
    [m1]: mask(m1),
    [m2]: mask(m2),
    // A vector annotation on the same image: selecting it must not dim the masks.
    [r1]: {
      id: r1,
      imageId,
      contextId,
      toolType: 'rectangle',
      geometry: { type: 'rectangle', origin: { x: 0, y: 0 }, width: 5, height: 5, rotation: 0 },
      rawAnnotationData: { format: 'fabric', fabricVersion: 'test', data: { type: 'Rect' } },
      createdAt: 'now',
      updatedAt: 'now',
    },
  };
}
seedAnnotations();

vi.mock('../../../src/state/annotator-context.js', () => ({
  useAnnotator: () => mockState,
}));
vi.mock('../../../src/hooks/useAnnotationTool.js', () => ({
  useAnnotationTool: () => undefined,
}));

const { default: ViewerCell } = await import('../../../src/components/ViewerCell.js');

const byId = (id: string) => objects.find((o) => o.id === id)!;

describe('ViewerCell selected-mask styling', () => {
  let dispose: (() => void) | undefined;

  beforeEach(() => {
    objects.length = 0;
    openHandlers.length = 0;
    buildGate = undefined;
    applyModeToObject.mockClear();
    setUi('selectedAnnotationId', null);
    setMaskStyle(undefined);
    seedAnnotations();
    mockState.annotationState.byImage[image2] = { [m3]: mask(m3, image2) };
    caches.length = 0;
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
    await vi.waitFor(() => expect(objects).toHaveLength(3));
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
    await mountWithMasks();
    const before = [...objects];

    setUi('selectedAnnotationId', m1);
    expect(byId('m1').opacity).toBe(1);
    expect(byId('m2').opacity).toBe(DEFAULT_UNSELECTED_MASK_OPACITY);
    // The same objects: a selection change must not re-decode every mask.
    expect(objects).toEqual(before);

    setUi('selectedAnnotationId', null);
    expect(byId('m2').opacity).toBe(1);
  });

  it('honours a configured dimming level', async () => {
    setMaskStyle({ unselectedOpacity: 0.1 });
    await mountWithMasks();
    setUi('selectedAnnotationId', m2);
    expect(byId('m1').opacity).toBe(0.1);
  });

  it('recolours only the selected mask when selectedFill is set, swapping it in place', async () => {
    setMaskStyle({ selectedFill: '#ff0000' });
    await mountWithMasks();
    const index = objects.indexOf(byId('m1'));

    setUi('selectedAnnotationId', m1);
    await vi.waitFor(() => expect(byId('m1').maskFill).toBe('#ff0000'));
    expect(objects.indexOf(byId('m1'))).toBe(index);
    // The replacement is a new object; it too must get the overlay's mode.
    expect(applyModeToObject).toHaveBeenCalledWith(byId('m1'), false);
    expect(byId('m2').maskFill).toBeUndefined();
    expect(byId('m2').opacity).toBe(DEFAULT_UNSELECTED_MASK_OPACITY);

    // Moving the selection recolours the one that lost it back, and the new one.
    setUi('selectedAnnotationId', m2);
    await vi.waitFor(() => expect(byId('m2').maskFill).toBe('#ff0000'));
    await vi.waitFor(() => expect(byId('m1').maskFill).toBeUndefined());
    expect(byId('m1').opacity).toBe(DEFAULT_UNSELECTED_MASK_OPACITY);
    expect(byId('m2').opacity).toBe(1);
  });

  it('builds the selected mask in the selected tint on a rebuild', async () => {
    setMaskStyle({ selectedFill: '#ff0000' });
    setUi('selectedAnnotationId', m2);
    await mountWithMasks();
    expect(byId('m2').maskFill).toBe('#ff0000');
    expect(byId('m1').maskFill).toBeUndefined();
    expect(byId('m1').opacity).toBe(DEFAULT_UNSELECTED_MASK_OPACITY);
  });
  it('applies a selection made while the rebuild was still in flight', async () => {
    // A brush commit adds its mask and then selects it. The rebuild runs
    // between the two writes and builds against the old selection, while the
    // selection effect finds a canvas the rebuild has just cleared. Neither
    // alone dims anything; the rebuild has to re-apply the selection when its
    // objects land.
    let release!: () => void;
    buildGate = new Promise<void>((resolve) => {
      release = resolve;
    });
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
    expect(objects).toHaveLength(0);

    setUi('selectedAnnotationId', m2);
    release();
    await vi.waitFor(() => expect(objects).toHaveLength(3));

    expect(byId('m2').opacity).toBe(1);
    expect(byId('m1').opacity).toBe(DEFAULT_UNSELECTED_MASK_OPACITY);
  });

  it('does not dim masks for a selected vector annotation or a selection on another image', async () => {
    await mountWithMasks();
    setUi('selectedAnnotationId', r1);
    expect(byId('m1').opacity).toBe(1);
    expect(byId('m2').opacity).toBe(1);

    // Selection is global: a mask selected in another grid cell is not one of
    // this cell's masks.
    setUi('selectedAnnotationId', createAnnotationId('mask-on-another-image'));
    expect(byId('m1').opacity).toBe(1);
    expect(byId('m2').opacity).toBe(1);
  });

  it('restores the others when the selected mask is deleted without clearing selection', async () => {
    await mountWithMasks();
    setUi('selectedAnnotationId', m1);
    expect(byId('m2').opacity).toBe(DEFAULT_UNSELECTED_MASK_OPACITY);

    // `deleteAnnotation` leaves `selectedAnnotationId` pointing at a mask that
    // no longer exists; the rebuild must treat that as "no mask selected".
    const { [m1]: _gone, ...rest } = mockState.annotationState.byImage[imageId]!;
    mockState.annotationState.byImage[imageId] = rest;
    // A plain-object mock does not re-run the rebuild; simulate what the real
    // store would do by firing it through the only reactive input it tracks.
    setUi('selectedAnnotationId', null);
    setUi('selectedAnnotationId', m1);
    expect(byId('m2').opacity).toBe(1);
  });

  it('reverts the selected tint when selectedFill is turned off at runtime', async () => {
    setMaskStyle({ selectedFill: '#ff0000' });
    await mountWithMasks();
    setUi('selectedAnnotationId', m1);
    await vi.waitFor(() => expect(byId('m1').maskFill).toBe('#ff0000'));

    setMaskStyle({});
    await vi.waitFor(() => expect(byId('m1').maskFill).toBeUndefined());
    // Dimming is unaffected: m1 is still the selected mask.
    expect(byId('m2').opacity).toBe(DEFAULT_UNSELECTED_MASK_OPACITY);
  });

  /** Mounts with an image the test can change or unassign. */
  function mountSwitchable(
    initial: ImageSource | undefined = { id: imageId, tileSource: 'x.png' },
  ) {
    const [imageSource, setImage] = createSignal<ImageSource | undefined>(initial);
    dispose = createRoot((disposeFn) => {
      createComponent(ViewerCell, {
        get imageSource() {
          return imageSource();
        },
        isActive: true,
        cellIndex: 0,
        onActivate: () => {},
      });
      return disposeFn;
    });
    openHandlers[0]!();
    return { setImage };
  }
  const cache = () => caches[0]!;

  it('drops a pending tint swap when selectedFill is turned off, whichever effect issued it', async () => {
    // The rebuild re-applies the selection when its objects land, and when a
    // mask was selected meanwhile under a `selectedFill` it issues the tint
    // swap itself. That swap used to be cancelled only by a selection change,
    // so the style going off while it decoded let it land — and nothing then
    // reverted it, the record saying no tint was applied.
    setMaskStyle({ selectedFill: '#ff0000' });
    let release!: () => void;
    buildGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    mountSwitchable();
    setUi('selectedAnnotationId', m1);
    // The rebuild's own swap decodes behind a second gate.
    let releaseSwap!: () => void;
    release();
    buildGate = new Promise<void>((resolve) => {
      releaseSwap = resolve;
    });
    await vi.waitFor(() => expect(objects).toHaveLength(3));
    expect(byId('m1').maskFill).toBeUndefined();

    setMaskStyle({});
    releaseSwap();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(byId('m1').maskFill).toBeUndefined();
    expect(byId('m2').opacity).toBe(DEFAULT_UNSELECTED_MASK_OPACITY);
  });

  it('keeps its record honest when a swap skips the mask a stroke has hidden', async () => {
    setMaskStyle({ selectedFill: '#ff0000' });
    await mountWithMasks();
    setUi('selectedAnnotationId', m1);
    await vi.waitFor(() => expect(byId('m1').maskFill).toBe('#ff0000'));

    // Mid-stroke on m1, the host turns the tint off: the swap must leave the
    // hidden object alone, and must not claim the revert happened.
    byId('m1').visible = false;
    setMaskStyle({});
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(byId('m1').maskFill).toBe('#ff0000');

    // The stroke is cancelled, so the object comes back and no rebuild
    // follows; the next selection change has to revert it.
    byId('m1').visible = true;
    setUi('selectedAnnotationId', m2);
    await vi.waitFor(() => expect(byId('m1').maskFill).toBeUndefined());
  });

  it('does not cache rasters a superseded rebuild decoded for another image', async () => {
    let releaseFirst!: () => void;
    buildGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const { setImage } = mountSwitchable();
    // The cell moves to another image before the first one's masks decode,
    // and the new image lands first.
    let releaseSecond!: () => void;
    buildGate = new Promise<void>((resolve) => {
      releaseSecond = resolve;
    });
    setImage({ id: image2, tileSource: 'y.png' });
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
    const { setImage } = mountSwitchable();
    await vi.waitFor(() => expect(objects).toHaveLength(3));
    expect(cache().size).toBe(2);
    setImage(undefined);
    expect(cache().size).toBe(0);
  });

  it('does not dim for a selected mask in a context that is not displayed', async () => {
    // Selection survives a context switch, so a mask of a context that is
    // neither active nor displayed can be the selection while not being on
    // the canvas; nothing visible is selected, so nothing is dimmed.
    const other = createAnnotationContextId('ctx-2');
    mockState.annotationState.byImage[imageId]![m3] = mask(m3, imageId, other);
    await mountWithMasks();
    expect(objects.find((o) => o.id === 'm3')).toBeUndefined();
    setUi('selectedAnnotationId', m3);
    expect(byId('m1').opacity).toBe(1);
    expect(byId('m2').opacity).toBe(1);
  });
});
