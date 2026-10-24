import { defineOsdlabelAnnotator, type OsdlabelAnnotatorElement } from '@osdlabel/element';
import { CONTEXTS, FIRST_IMAGE_ID, IMAGES } from '../shared/fixtures.js';
import { mark } from '../shared/probe.js';

/** The element, in shadow (`'open'`) or light (`'none'`) mode, assigned the first image when ready. */
export function mountElement(
  container: HTMLElement,
  shadow: 'open' | 'none',
  override: boolean,
): HTMLElement {
  const tagName = shadow === 'open' ? 'osdlabel-annotator' : 'osdlabel-annotator-light';
  defineOsdlabelAnnotator({ tagName, shadow });
  const el = document.createElement(tagName) as OsdlabelAnnotatorElement;
  if (override) el.classList.add('host-override');
  el.setAttribute('test-mode', '');
  el.style.height = '100%';
  el.images = IMAGES;
  el.contexts = CONTEXTS;
  el.addEventListener('osdlabelready', () => {
    mark('element-ready');
    el.assignImageToCell(0, FIRST_IMAGE_ID);
  });
  container.append(el);
  return el;
}
