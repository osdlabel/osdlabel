import { render } from 'solid-js/web';
import { onMount } from 'solid-js';
import { Annotator, useAnnotator } from '@osdlabel/solid';
import { CONTEXTS, FIRST_IMAGE_ID, IMAGES } from '../shared/fixtures.js';
import { mark } from '../shared/probe.js';

function AssignFirstImage() {
  const { actions } = useAnnotator();
  onMount(() => {
    mark('element-ready');
    actions.assignImageToCell(0, FIRST_IMAGE_ID);
  });
  return null;
}

/** The Solid binding's <Annotator>, mounted directly in light DOM. */
export function mountSolidBinding(container: HTMLElement): HTMLElement {
  render(
    () => (
      <Annotator
        images={IMAGES}
        contexts={CONTEXTS}
        testMode
        providerChildren={<AssignFirstImage />}
      />
    ),
    container,
  );
  return container;
}
