import { useEffect, useState } from 'react';
import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';
import { AnnotatorProvider, ViewerCell, useAnnotator } from '@osdlabel/react';
import {
  HARNESS_CONTEXTS,
  HARNESS_CONTEXT_ID,
  HARNESS_IMAGE,
  exposeHarness,
  harnessAnnotations,
  reportsRenderErrorsToHarness,
  type ViewerCellHarness,
} from '../../dev/src/viewer-cell-harness.js';

/**
 * The React counterpart of `apps/dev/viewer-cell.html`: a single
 * `<ViewerCell>`, mounted directly, exposing the same `window.__viewerCell`
 * so `apps/dev/tests/e2e/viewer-cell-rebuild.spec.ts` runs against this binding
 * too (#152). The fixtures and the harness API are shared with the Solid page.
 *
 * React batches state updates, so `load` and `unmount` wrap each write in
 * `flushSync`: every call then commits and runs its effects before returning,
 * as a Solid store write does, and two `load` calls in one task really start
 * two overlapping rebuilds.
 */

/** Ids passed to `onAnnotationRenderError`, in order. */
const renderErrors: string[] = [];

/** Writable here, because `Harness` rebinds `load` and `unmount` on each render. */
const harness: { -readonly [K in keyof ViewerCellHarness]: ViewerCellHarness[K] } = {
  framework: 'react',
  load: () => {},
  renderErrors,
  overlay: undefined,
  unmount: () => {},
};
exposeHarness(harness);

function Harness() {
  const { actions } = useAnnotator();
  const [mounted, setMounted] = useState(true);

  useEffect(() => {
    actions.setContexts([...HARNESS_CONTEXTS]);
    actions.setActiveContext(HARNESS_CONTEXT_ID);
    // Mount-only: the harness configures the store once, as the Solid page does.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Rebound on every render, so the harness always calls the current actions.
  harness.load = (count, broken = 0, malformed = 0) =>
    flushSync(() => actions.loadAnnotations(harnessAnnotations(count, broken, malformed)));
  harness.unmount = () => flushSync(() => setMounted(false));

  if (!mounted) return null;
  return (
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
  );
}

const root = document.getElementById('app');
if (root) {
  createRoot(root).render(
    <AnnotatorProvider
      onAnnotationRenderError={
        reportsRenderErrorsToHarness()
          ? (failure) => {
              renderErrors.push(failure.annotation.id);
            }
          : undefined
      }
    >
      <Harness />
    </AnnotatorProvider>,
  );
}
