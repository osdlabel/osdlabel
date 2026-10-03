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
 * annotation rebuild (#160, #190).
 *
 * The cell rebuilds its Fabric objects asynchronously whenever its visible
 * annotations change. A spec can start several rebuilds in one task, or
 * unmount the cell while one is in flight, and then count what reached the
 * canvas. `window.__viewerCell` exposes the store's `loadAnnotations`, the
 * cell's overlay, and an `unmount()`.
 */

const IMAGE_ID = createImageId('landscape');
const CONTEXT_ID = createAnnotationContextId('rebuild-context');
const IMAGE: ImageSource = {
  id: IMAGE_ID,
  tileSource: './sample-data/landscape.png',
  label: 'Landscape',
};

/** `count` rectangles on the image, with stable ids so a reload replaces them. */
function rectangles(count: number): Record<ImageId, Record<AnnotationId, OsdAnnotation>> {
  const forImage: Record<AnnotationId, OsdAnnotation> = {};
  for (let i = 0; i < count; i++) {
    const id = createAnnotationId(`rect-${i}`);
    forImage[id] = createAnnotationFromGeometry(
      { type: 'rectangle', origin: { x: 40 + i * 60, y: 40 }, width: 40, height: 40, rotation: 0 },
      { id, imageId: IMAGE_ID, contextId: CONTEXT_ID, toolType: 'rectangle' },
    );
  }
  return { [IMAGE_ID]: forImage };
}

export interface ViewerCellHarness {
  /** Replaces the image's annotations with `count` rectangles. */
  readonly load: (count: number) => void;
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
    load: (count) => actions.loadAnnotations(rectangles(count)),
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
      <AnnotatorProvider>
        <Harness />
      </AnnotatorProvider>
    ),
    root,
  );
}
