import { createSignal, Show } from 'solid-js';
import { render } from 'solid-js/web';
import { AnnotatorProvider, ViewerCell, useAnnotator } from '@osdlabel/solid';
import {
  HARNESS_CONTEXTS,
  HARNESS_CONTEXT_ID,
  HARNESS_IMAGE,
  exposeHarness,
  harnessAnnotations,
  reportsRenderErrorsToHarness,
  type ViewerCellHarness,
} from './viewer-cell-harness.js';

/**
 * A single `<ViewerCell>`, mounted directly, for specs that drive its
 * annotation rebuild (#160, #190, #209). `apps/dev-react` serves the same page
 * for the React binding (#152); the fixtures and the `window.__viewerCell` API
 * are shared in `viewer-cell-harness.ts`.
 *
 * The cell rebuilds its Fabric objects asynchronously whenever its visible
 * annotations change. A spec can start several rebuilds in one task, or
 * unmount the cell while one is in flight, and then count what reached the
 * canvas. Solid runs the rebuild effect synchronously on each store write, so
 * two `load` calls in one task start two rebuilds. It can also load
 * annotations that cannot be rendered and read what the provider's
 * `onAnnotationRenderError` received.
 */

/** Ids passed to `onAnnotationRenderError`, in order. */
const renderErrors: string[] = [];

function Harness() {
  const { actions } = useAnnotator();
  const [mounted, setMounted] = createSignal(true);

  actions.setContexts([...HARNESS_CONTEXTS]);
  actions.setActiveContext(HARNESS_CONTEXT_ID);

  const harness: ViewerCellHarness = {
    framework: 'solid',
    load: (count, broken = 0, malformed = 0) =>
      actions.loadAnnotations(harnessAnnotations(count, broken, malformed)),
    renderErrors,
    overlay: undefined,
    unmount: () => setMounted(false),
  };
  exposeHarness(harness);

  return (
    <Show when={mounted()}>
      <div data-testid="viewer-cell-host" style={{ width: '640px', height: '480px' }}>
        <ViewerCell
          imageSource={HARNESS_IMAGE}
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
          reportsRenderErrorsToHarness()
            ? (failure) => renderErrors.push(failure.annotation.id)
            : undefined
        }
      >
        <Harness />
      </AnnotatorProvider>
    ),
    root,
  );
}
