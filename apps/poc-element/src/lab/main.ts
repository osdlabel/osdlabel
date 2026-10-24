/**
 * H2 lab: the same element in shadow-DOM and light-DOM mode, optionally under
 * a real-world global stylesheet, with a decoration provider so decoration
 * positioning can be compared.
 *
 *   lab.html?mode=shadow|light&css=none|bootstrap|tailwind|tailwind-layered&stock=layer|unlayered
 *
 * `stock=unlayered` (light DOM only) emulates an unlayered class-selector
 * stock sheet: it adopts the same rules without `@layer osdlabel` into the
 * document, where they outrank the layered copy the toolbar installs.
 */
import bootstrapCss from 'bootstrap/dist/css/bootstrap.css?inline';
import tailwindPreflight from 'tailwindcss/preflight.css?inline';
import { OSDLABEL_STOCK_RULES, createMeasurementProvider } from 'osdlabel';
import type { OsdFields } from 'osdlabel';
import { defineOsdlabelAnnotator, type OsdlabelAnnotatorElement } from '@osdlabel/element';
import { CONTEXTS, FIRST_IMAGE_ID, IMAGES } from '../shared/fixtures.js';
import { HOST_EVENT_NAMES, mark, reportHostEvent, startInteractiveProbe } from '../shared/probe.js';

mark('host-script');
startInteractiveProbe();

const params = new URLSearchParams(location.search);
const mode = params.get('mode') === 'light' ? 'light' : 'shadow';
const css = params.get('css') ?? 'none';

const SHEETS: Record<string, string> = {
  bootstrap: bootstrapCss,
  // The preflight file on its own, unlayered: harsher than a real Tailwind 4
  // app, which imports it into `@layer base`.
  tailwind: tailwindPreflight,
  // What `@import "tailwindcss"` produces: the layer order statement first,
  // then the preflight inside `@layer base`.
  'tailwind-layered': `@layer theme, base, components, utilities;\n@layer base {\n${tailwindPreflight}\n}`,
};
const sheet = SHEETS[css];
if (sheet) {
  const style = document.createElement('style');
  style.dataset['hostile'] = css;
  style.textContent = sheet;
  document.head.append(style);
}

if (params.get('stock') === 'unlayered') {
  const unlayered = new CSSStyleSheet();
  unlayered.replaceSync(OSDLABEL_STOCK_RULES);
  document.adoptedStyleSheets = [...document.adoptedStyleSheets, unlayered];
}

const headNodesBefore = document.head.querySelectorAll('style, link[rel="stylesheet"]').length;

defineOsdlabelAnnotator();
defineOsdlabelAnnotator({ tagName: 'osdlabel-annotator-light', shadow: 'none' });

const tag = mode === 'light' ? 'osdlabel-annotator-light' : 'osdlabel-annotator';
const el = document.createElement(tag) as OsdlabelAnnotatorElement;
el.setAttribute('test-mode', '');
el.setAttribute('show-grid-controls', '');
el.style.height = '560px';
el.style.width = '900px';
el.images = IMAGES;
el.contexts = CONTEXTS;
el.decorationProviders = [createMeasurementProvider<OsdFields>({ area: true })];
el.addEventListener('osdlabelready', () => {
  mark('element-ready');
  el.assignImageToCell(0, FIRST_IMAGE_ID);
});
for (const name of HOST_EVENT_NAMES) {
  el.addEventListener(name, (e) => reportHostEvent(name, (e as CustomEvent<unknown>).detail));
}
document.getElementById('app')!.append(el);

(window as unknown as { __lab: unknown }).__lab = {
  el,
  mode,
  css,
  headNodesBefore,
  headNodesAfter: () => document.head.querySelectorAll('style, link[rel="stylesheet"]').length,
};
