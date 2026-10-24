import { render } from 'solid-js/web';
import { onMount } from 'solid-js';
import { Annotator, useAnnotator } from '@osdlabel/solid';
import { CONTEXTS, FIRST_IMAGE_ID, IMAGES } from '../shared/fixtures.js';
import { mark, reportHostEvent, startInteractiveProbe } from '../shared/probe.js';

// Baseline: the Solid binding mounted directly, no custom element, same
// fixtures and the same "assign the first image on startup" step.
mark('host-script');
startInteractiveProbe();

function AssignFirstImage() {
  const { actions } = useAnnotator();
  onMount(() => {
    mark('element-ready');
    actions.assignImageToCell(0, FIRST_IMAGE_ID);
  });
  return null;
}

render(
  () => (
    <div style={{ height: '520px' }}>
      <Annotator
        images={IMAGES}
        contexts={CONTEXTS}
        testMode
        onAnnotationsChange={(annotations) => reportHostEvent('annotationschange', { annotations })}
        providerChildren={<AssignFirstImage />}
      />
    </div>
  ),
  document.getElementById('app')!,
);
