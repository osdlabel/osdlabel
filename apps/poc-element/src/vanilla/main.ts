import { defineOsdlabelAnnotator, type OsdlabelAnnotatorElement } from '@osdlabel/element';
import {
  CONTEXTS,
  DECORATION_PROVIDERS,
  FIRST_IMAGE_ID,
  IMAGES,
  sampleAnnotations,
} from '../shared/fixtures.js';
import { HOST_EVENT_NAMES, mark, reportHostEvent, startInteractiveProbe } from '../shared/probe.js';

mark('host-script');
startInteractiveProbe();

// Plain DOM: define, create, set properties, listen.
defineOsdlabelAnnotator();
const el = document.createElement('osdlabel-annotator') as OsdlabelAnnotatorElement;
el.setAttribute('test-mode', '');
el.style.height = '520px';
el.images = IMAGES;
el.contexts = CONTEXTS;
el.addEventListener('osdlabelready', () => {
  mark('element-ready');
  el.assignImageToCell(0, FIRST_IMAGE_ID);
});
for (const name of HOST_EVENT_NAMES) {
  el.addEventListener(name, (e) => reportHostEvent(name, (e as CustomEvent<unknown>).detail));
}
const load = document.createElement('button');
load.dataset['testid'] = 'host-load-sample';
load.textContent = 'load sample';
load.onclick = () => {
  el.annotations = sampleAnnotations();
};
document.getElementById('app')!.append(load, el);
// After connect on purpose: a write to a mounted element must take effect.
el.decorationProviders = DECORATION_PROVIDERS;
