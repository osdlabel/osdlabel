import { defineOsdlabelAnnotator, type OsdlabelAnnotatorElement } from '@osdlabel/element';
import { CONTEXTS, IMAGES } from '../shared/fixtures.js';

/** Appends the element; its connectedCallback renders the Solid tree synchronously. */
export function mountElementSync(
  container: HTMLElement,
  shadow: 'open' | 'none',
): OsdlabelAnnotatorElement {
  const tagName = shadow === 'open' ? 'osdlabel-annotator' : 'osdlabel-annotator-light';
  defineOsdlabelAnnotator({ tagName, shadow });
  const el = document.createElement(tagName) as OsdlabelAnnotatorElement;
  el.style.height = '100%';
  el.images = IMAGES;
  el.contexts = CONTEXTS;
  container.append(el);
  return el;
}
