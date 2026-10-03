import { createSignal, Show } from 'solid-js';
import { render } from 'solid-js/web';
import {
  AnnotatorProvider,
  ViewerCell,
  createAnnotationContextId,
  createAnnotationFromGeometry,
  createAnnotationId,
  createImageId,
  useAnnotator,
  type AnnotationId,
  type FabricOverlay,
  type ImageId,
  type ImageSource,
  type OsdAnnotation,
} from '@osdlabel/solid';

/**
 * A single `<ViewerCell>`, mounted directly, for specs that drive its
 * annotation rebuild (#160, #190, #209).
 *
 * The cell rebuilds its Fabric objects asynchronously whenever its visible
 * annotations change. A spec can start several rebuilds in one task, or
 * unmount the cell while one is in flight, and then count what reached the
 * canvas. It can also load annotations that cannot be rendered and read what
 * the provider's `onAnnotationRenderError` received. `window.__viewerCell`
 * exposes a loader, the cell's overlay, the reported ids and an `unmount()`.
 *
 * `?errors=default` mounts the provider without `onAnnotationRenderError`, so
 * a spec can check the default `console.warn` instead.
 */

const IMAGE_ID = createImageId('landscape');
const CONTEXT_ID = createAnnotationContextId('rebuild-context');
const IMAGE: ImageSource = {
  id: IMAGE_ID,
  tileSource: './sample-data/landscape.png',
  label: 'Landscape',
};

const rectangle = (id: AnnotationId, i: number): OsdAnnotation =>
  createAnnotationFromGeometry(
    { type: 'rectangle', origin: { x: 40 + i * 60, y: 40 }, width: 40, height: 40, rotation: 0 },
    { id, imageId: IMAGE_ID, contextId: CONTEXT_ID, toolType: 'rectangle' },
  );

/**
 * `count` rectangles on the image, then two kinds of annotation that cannot
 * be rendered: `broken` ones whose stored Fabric data names a class Fabric
 * does not have, and `malformed` polygons whose `points` are missing, which
 * Fabric's own loader drops silently unless told otherwise. Ids are stable
 * (`rect-<i>`, `broken-<i>`, `malformed-<i>`), so a reload replaces them.
 */
function annotations(
  count: number,
  broken: number,
  malformed: number,
): Record<ImageId, Record<AnnotationId, OsdAnnotation>> {
  const forImage: Record<AnnotationId, OsdAnnotation> = {};
  for (let i = 0; i < count; i++) {
    const id = createAnnotationId(`rect-${i}`);
    forImage[id] = rectangle(id, i);
  }
  for (let i = 0; i < broken; i++) {
    const id = createAnnotationId(`broken-${i}`);
    const valid = rectangle(id, count + i);
    forImage[id] = {
      ...valid,
      rawAnnotationData: {
        ...valid.rawAnnotationData,
        data: { ...valid.rawAnnotationData.data, type: 'NotAFabricClass' },
      },
    };
  }
  for (let i = 0; i < malformed; i++) {
    const id = createAnnotationId(`malformed-${i}`);
    const valid = createAnnotationFromGeometry(
      {
        type: 'polygon',
        points: [
          { x: 300, y: 300 + i * 60 },
          { x: 340, y: 300 + i * 60 },
          { x: 320, y: 340 + i * 60 },
        ],
      },
      { id, imageId: IMAGE_ID, contextId: CONTEXT_ID, toolType: 'polyline' },
    );
    forImage[id] = {
      ...valid,
      rawAnnotationData: {
        ...valid.rawAnnotationData,
        data: { ...valid.rawAnnotationData.data, points: null },
      },
    };
  }
  return { [IMAGE_ID]: forImage };
}

const reportToHarness = new URLSearchParams(window.location.search).get('errors') !== 'default';
/** Ids passed to `onAnnotationRenderError`, in order. */
const renderErrors: string[] = [];

export interface ViewerCellHarness {
  /**
   * Replaces the image's annotations with `count` rectangles, plus `broken`
   * and `malformed` annotations that cannot be rendered.
   */
  readonly load: (count: number, broken?: number, malformed?: number) => void;
  /** Ids `onAnnotationRenderError` has received (empty with `?errors=default`). */
  readonly renderErrors: readonly string[];
  /** The mounted cell's overlay, once OSD has opened the image. */
  overlay: FabricOverlay | undefined;
  /** Unmounts the cell, which destroys its viewer and overlay. */
  readonly unmount: () => void;
}

function Harness() {
  const { actions } = useAnnotator();
  const [mounted, setMounted] = createSignal(true);

  actions.setContexts([{ id: CONTEXT_ID, label: 'Rebuild', tools: [{ type: 'rectangle' }] }]);
  actions.setActiveContext(CONTEXT_ID);

  const harness: ViewerCellHarness = {
    load: (count, broken = 0, malformed = 0) =>
      actions.loadAnnotations(annotations(count, broken, malformed)),
    renderErrors,
    overlay: undefined,
    unmount: () => setMounted(false),
  };
  (window as unknown as { __viewerCell: ViewerCellHarness }).__viewerCell = harness;

  return (
    <Show when={mounted()}>
      <div data-testid="viewer-cell-host" style={{ width: '640px', height: '480px' }}>
        <ViewerCell
          imageSource={IMAGE}
          isActive={true}
          cellIndex={0}
          onActivate={() => {}}
          onOverlayReady={(ov) => {
            harness.overlay = ov;
          }}
        />
      </div>
    </Show>
  );
}

const root = document.getElementById('app');
if (root) {
  render(
    () => (
      <AnnotatorProvider
        onAnnotationRenderError={
          reportToHarness ? (error) => renderErrors.push(error.annotation.id) : undefined
        }
      >
        <Harness />
      </AnnotatorProvider>
    ),
    root,
  );
}
