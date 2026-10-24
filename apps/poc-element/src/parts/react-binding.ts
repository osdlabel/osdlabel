// The React binding's <Annotator> (not the element), written with
// createElement so this app needs no second JSX transform beside Solid's.
import { createElement, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { Annotator, useAnnotator } from '@osdlabel/react';
import { CONTEXTS, FIRST_IMAGE_ID, IMAGES } from '../shared/fixtures.js';
import { mark } from '../shared/probe.js';

function AssignFirstImage() {
  const { actions } = useAnnotator();
  useEffect(() => {
    mark('element-ready');
    actions.assignImageToCell(0, FIRST_IMAGE_ID);
  }, [actions]);
  return null;
}

/** The React binding's <Annotator>, mounted directly in light DOM. */
export function mountReactBinding(container: HTMLElement): HTMLElement {
  createRoot(container).render(
    createElement(Annotator, {
      images: IMAGES,
      contexts: CONTEXTS,
      testMode: true,
      providerChildren: createElement(AssignFirstImage),
    }),
  );
  return container;
}
