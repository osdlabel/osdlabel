// H3 theming lab; filled in with the token / ::part / slot prototype.
import { defineOsdlabelAnnotator, type OsdlabelAnnotatorElement } from '@osdlabel/element';
import { CONTEXTS, FIRST_IMAGE_ID, IMAGES } from '../shared/fixtures.js';

defineOsdlabelAnnotator();
const el = document.createElement('osdlabel-annotator') as OsdlabelAnnotatorElement;
el.setAttribute('test-mode', '');
el.style.height = '520px';
el.images = IMAGES;
el.contexts = CONTEXTS;
el.addEventListener('osdlabelready', () => el.assignImageToCell(0, FIRST_IMAGE_ID));
document.getElementById('app')!.append(el);
