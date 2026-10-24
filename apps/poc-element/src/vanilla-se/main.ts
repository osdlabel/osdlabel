import { defineWithSolidElement } from '@osdlabel/element/solid-element-variant';
import type { ImageId } from 'osdlabel';
import { CONTEXTS, FIRST_IMAGE_ID, IMAGES } from '../shared/fixtures.js';
import { mark, reportHostEvent, startInteractiveProbe } from '../shared/probe.js';

mark('host-script');
startInteractiveProbe();

/** What component-register puts on the element: one accessor per declared prop. */
interface SolidElementHost extends HTMLElement {
  images: unknown;
  contexts: unknown;
  testMode: boolean;
  assignImageToCell?: (cellIndex: number, imageId: ImageId) => void;
}

defineWithSolidElement('osdlabel-annotator-se');
const el = document.createElement('osdlabel-annotator-se') as SolidElementHost;
// component-register JSON.parses attribute values, and `JSON.parse('')` throws,
// so the bare boolean attribute `test-mode` arrives as the string '' (falsy).
// The property is the only reliable way to set a boolean.
el.testMode = true;
el.style.height = '520px';
el.images = IMAGES;
el.contexts = CONTEXTS;
el.addEventListener('osdlabelready', () => {
  mark('element-ready');
  el.assignImageToCell?.(0, FIRST_IMAGE_ID);
});
el.addEventListener('annotationschange', (e) =>
  reportHostEvent('annotationschange', (e as CustomEvent<unknown>).detail),
);
document.getElementById('app')!.append(el);
