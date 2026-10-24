/**
 * Light-DOM part styling lab (review finding 2): the stock toolbar of each
 * renderer under a host stylesheet that overrides properties the stock UI
 * sets itself (background, padding, colour).
 *
 *   parts.html?binding=solid|react|element-light|element-shadow&override=1
 *              [&selector=scoped|bare] [&stock=layer|unlayered]
 *
 * - selector=scoped (default): host rules qualified by an ancestor class,
 *   specificity (0,2,0); selector=bare: `[part~="tool-button"]` alone, (0,1,0).
 * - stock=unlayered: also adopts the stock rules without `@layer osdlabel`
 *   into the document (light DOM only), emulating an unlayered class sheet.
 *
 * - solid / react: the framework binding's `<Annotator>`, in light DOM.
 * - element-light: `<osdlabel-annotator-light>` (shadow: 'none').
 * - element-shadow: `<osdlabel-annotator>` (open shadow root), styled through `::part()`.
 *
 * The host rules are unlayered and use only the public hooks: `[part~=…]`
 * attribute selectors and the `osdlabel-*` classes in light DOM, `::part()`
 * from outside a shadow root.
 */
import './page.css';
import { OSDLABEL_STOCK_RULES } from 'osdlabel';
import { mark, startInteractiveProbe } from '../shared/probe.js';

mark('host-script');
startInteractiveProbe();

export type PartsBinding = 'solid' | 'react' | 'element-light' | 'element-shadow';
const BINDINGS: readonly PartsBinding[] = ['solid', 'react', 'element-light', 'element-shadow'];

const params = new URLSearchParams(location.search);
const requested = params.get('binding');
const binding: PartsBinding = BINDINGS.find((b) => b === requested) ?? 'solid';
const override = params.get('override') === '1';
const scope = params.get('selector') === 'bare' ? '' : '.host-override ';

if (params.get('stock') === 'unlayered') {
  const unlayered = new CSSStyleSheet();
  unlayered.replaceSync(OSDLABEL_STOCK_RULES);
  document.adoptedStyleSheets = [...document.adoptedStyleSheets, unlayered];
}

const HOST_OVERRIDE_CSS = `
  /* Light DOM: attribute selectors on the public part names, and a class hook. */
  ${scope}[part~="tool-button"] { background-color: rgb(0, 128, 0); padding: 20px; }
  ${scope}[part~="tool-button-active"] { background-color: rgb(128, 0, 128); }
  ${scope}.osdlabel-tool-button { color: rgb(255, 255, 0); }
  /* Shadow DOM: the same overrides through ::part(). */
  osdlabel-annotator.host-override::part(tool-button) {
    background-color: rgb(0, 128, 0); padding: 20px; color: rgb(255, 255, 0);
  }
  osdlabel-annotator.host-override::part(tool-button-active) { background-color: rgb(128, 0, 128); }
`;

const headStyleNodesBefore = document.head.querySelectorAll('style').length;
if (override) {
  const style = document.createElement('style');
  style.dataset['host'] = 'override';
  style.textContent = HOST_OVERRIDE_CSS;
  document.head.append(style);
}

const app = document.getElementById('app')!;
app.style.height = '520px';
if (override) app.classList.add('host-override');

async function mount(): Promise<HTMLElement> {
  switch (binding) {
    case 'solid':
      return (await import('../solid/parts-solid.js')).mountSolidBinding(app);
    case 'react':
      return (await import('./react-binding.js')).mountReactBinding(app);
    case 'element-light':
    case 'element-shadow':
      return (await import('./element.js')).mountElement(
        app,
        binding === 'element-light' ? 'none' : 'open',
        override,
      );
  }
}

const hostElement = await mount();

interface PartsLab {
  readonly binding: PartsBinding;
  readonly override: boolean;
  readonly host: HTMLElement;
  /** `<style>` nodes in `document.head` that the page did not add itself. */
  readonly addedHeadStyleNodes: () => number;
  readonly documentAdoptedSheets: () => number;
  readonly shadowAdoptedSheets: () => number | null;
  readonly shadowStyleNodes: () => number | null;
}
const lab: PartsLab = {
  binding,
  override,
  host: hostElement,
  addedHeadStyleNodes: () =>
    document.head.querySelectorAll('style').length - headStyleNodesBefore - (override ? 1 : 0),
  documentAdoptedSheets: () => document.adoptedStyleSheets.length,
  shadowAdoptedSheets: () => hostElement.shadowRoot?.adoptedStyleSheets.length ?? null,
  shadowStyleNodes: () => hostElement.shadowRoot?.querySelectorAll('style').length ?? null,
};
(window as unknown as { __parts: PartsLab }).__parts = lab;
