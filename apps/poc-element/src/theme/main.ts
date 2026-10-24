/**
 * H3 theming lab: design tokens (CSS custom properties), ::part() styling and
 * the Toolbar override slot, on the custom element.
 *
 *   theme.html?theme=1     host CSS sets --osdlabel-* tokens and ::part() rules
 *   theme.html?override=1  host renders its own toolbar into slot="toolbar"
 */
import {
  defineOsdlabelAnnotator,
  type OsdlabelAnnotatorElement,
  type ToolbarModelChangeDetail,
} from '@osdlabel/element';
import { ANNOTATOR_SLOT_NAMES } from 'osdlabel';
import type { ToolbarModel } from 'osdlabel';
import { CONTEXTS, FIRST_IMAGE_ID, IMAGES } from '../shared/fixtures.js';
import { HOST_EVENT_NAMES, reportHostEvent, startInteractiveProbe } from '../shared/probe.js';

startInteractiveProbe();
const params = new URLSearchParams(location.search);

const THEME_CSS = `
  osdlabel-annotator.themed {
    --osdlabel-accent: rgb(233, 30, 99);
    --osdlabel-radius: 0px;
    --osdlabel-surface: rgb(245, 245, 245);
    --osdlabel-control: rgb(224, 224, 224);
    --osdlabel-text: rgb(20, 20, 20);
    --osdlabel-font-size-control: 15px;
  }
  osdlabel-annotator.themed::part(tool-button-active) {
    outline: 2px solid rgb(0, 128, 0);
  }
  osdlabel-annotator.themed::part(status-bar) {
    letter-spacing: 1px;
  }
`;
if (params.get('theme') === '1') {
  const style = document.createElement('style');
  style.textContent = THEME_CSS;
  document.head.append(style);
}

defineOsdlabelAnnotator();
const el = document.createElement('osdlabel-annotator') as OsdlabelAnnotatorElement;
if (params.get('theme') === '1') el.classList.add('themed');
el.setAttribute('test-mode', '');
el.style.height = '520px';
el.images = IMAGES;
el.contexts = CONTEXTS;
el.addEventListener('osdlabelready', () => el.assignImageToCell(0, FIRST_IMAGE_ID));
for (const name of HOST_EVENT_NAMES) {
  el.addEventListener(name, (e) => reportHostEvent(name, (e as CustomEvent<unknown>).detail));
}

if (params.get('override') === '1') {
  // A host-owned toolbar in the light DOM: styled by the host's own CSS,
  // rendered from the element's shared toolbar model, driving it by command.
  const toolbar = document.createElement('div');
  toolbar.slot = 'toolbar';
  toolbar.dataset['testid'] = 'host-toolbar';
  toolbar.style.cssText = 'display:flex;gap:6px;padding:2px;font:14px serif;color:#fff';
  const paint = (model: ToolbarModel): void => {
    toolbar.replaceChildren(
      ...model.buttons.map((b) => {
        const button = document.createElement('button');
        button.dataset['testid'] = `host-tool-${b.key}`;
        button.dataset['active'] = String(b.active);
        button.disabled = !b.enabled;
        const text = b.countLabel === null ? b.label : `${b.label} ${b.countLabel}`;
        button.textContent = b.active ? `[${text}]` : text;
        button.onclick = () => el.selectTool(b.tool);
        return button;
      }),
    );
  };
  el.addEventListener('toolbarmodelchange', (e) =>
    paint((e as CustomEvent<ToolbarModelChangeDetail>).detail.model),
  );
  el.append(toolbar);
}

document.getElementById('app')!.append(el);

// The shared slot names, so the spec can check the element renders a named
// <slot> for every one of them.
(window as unknown as { __slotNames: readonly string[] }).__slotNames =
  Object.values(ANNOTATOR_SLOT_NAMES);
