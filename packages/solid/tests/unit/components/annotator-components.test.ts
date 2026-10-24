import { afterEach, describe, expect, it, vi } from 'vitest';
import { createComponent, untrack, type Component } from 'solid-js';
import { render } from 'solid-js/web';
import { createAnnotationContextId, type AnnotationContext } from '@osdlabel/annotation-context';
import { createImageId, type ImageSource } from '@osdlabel/viewer-api';
import { ANNOTATOR_SLOT_NAMES, OSDLABEL_STOCK_CSS } from 'osdlabel';
import type { AnnotatorSlotName, AnnotatorSlotPropsMap, ToolbarSlotProps } from 'osdlabel';
import {
  ANNOTATOR_SLOT_RENDERERS,
  type AnnotatorSlotRendererTable,
} from '../../../src/components/annotator-slots.js';
import { useAnnotator } from '../../../src/state/annotator-context.js';

// A viewer that never opens: the cell mounts, no overlay is ever built, and
// the tools' constraint status sees an active image.
vi.mock('openseadragon', () => ({
  default: () => ({
    addHandler: vi.fn(),
    removeHandler: vi.fn(),
    open: vi.fn(),
    close: vi.fn(),
    destroy: vi.fn(),
    world: { getItemCount: () => 0, getItemAt: () => undefined },
    viewport: {},
  }),
}));

const { default: Annotator } = await import('../../../src/components/Annotator.js');
type AnnotatorComponents = import('../../../src/components/Annotator.js').AnnotatorComponents;

const IMAGES: ImageSource[] = [{ id: createImageId('img'), tileSource: 'img.png' }];

/** Assigns the image to cell 0 from inside the provider, as a host would. */
const AssignImage: Component = () => {
  const { actions } = useAnnotator();
  untrack(() => actions.assignImageToCell(0, IMAGES[0]!.id));
  return null;
};

/**
 * The override slot and the theme hooks, through the real `<Annotator>` and
 * provider. Mirrors `packages/react/tests/unit/components/annotator-components.test.tsx`.
 */
const CONTEXTS: AnnotationContext[] = [
  {
    id: createAnnotationContextId('general'),
    label: 'General',
    tools: [{ type: 'rectangle' }, { type: 'line', maxCount: 2 }],
  },
];

let dispose: (() => void) | undefined;
afterEach(() => {
  dispose?.();
  dispose = undefined;
  document.body.innerHTML = '';
});

/** Unmounts the current annotator, as the afterEach does. */
function unmountForReinstall(): void {
  dispose?.();
  dispose = undefined;
  document.body.innerHTML = '';
}

function mountAnnotator(components?: AnnotatorComponents): HTMLElement {
  const container = document.createElement('div');
  document.body.append(container);
  dispose = render(
    () =>
      createComponent(Annotator, {
        images: IMAGES,
        contexts: CONTEXTS,
        showFilmstrip: false,
        ...(components ? { components } : {}),
        get providerChildren() {
          return createComponent(AssignImage, {});
        },
      }),
    container,
  );
  return container;
}

/** A host toolbar: one plain button per model button, nothing from the stock UI. */
let received: ToolbarSlotProps | undefined;
const CustomToolbar: Component<ToolbarSlotProps> = (props) => {
  received = props;
  const el = document.createElement('div');
  el.dataset['testid'] = 'custom-toolbar';
  // Imperative on purpose: an override may render however it likes.
  const paint = () => {
    el.replaceChildren(
      ...props.model.buttons.map((b) => {
        const button = document.createElement('button');
        button.dataset['testid'] = `custom-${b.key}`;
        button.dataset['active'] = String(b.active);
        button.textContent = b.countLabel ? `${b.label} (${b.countLabel})` : b.label;
        button.disabled = !b.enabled;
        button.onclick = () => props.onSelectTool(b.tool);
        return button;
      }),
    );
  };
  paint();
  queueMicrotask(paint);
  return el;
};

const q = (root: ParentNode, testId: string) => root.querySelector(`[data-testid="${testId}"]`);

describe('Annotator components.Toolbar override', () => {
  it('replaces the stock toolbar and hands the override the shared model', () => {
    const root = mountAnnotator({ Toolbar: CustomToolbar });
    expect(q(root, 'tool-navigate')).toBeNull();
    expect(q(root, 'custom-toolbar')).not.toBeNull();
    expect(received).toBeDefined();
    expect(received!.model.buttons.map((b) => b.key)).toEqual([
      'navigate',
      'select',
      'rectangle',
      'line',
    ]);
    expect(received!.model.buttons.find((b) => b.key === 'line')!.countLabel).toBe('0/2');
  });

  it('drives annotator state through the override’s commands', () => {
    const root = mountAnnotator({ Toolbar: CustomToolbar });
    expect(q(root, 'status-tool')!.textContent).toContain('Navigate');
    received!.onSelectTool('rectangle');
    expect(q(root, 'status-tool')!.textContent).toContain('Rectangle');
    // The model the override holds is live: it now reports rectangle active.
    expect(received!.model.buttons.find((b) => b.key === 'rectangle')!.active).toBe(true);
  });
});

describe('stock toolbar theming hooks', () => {
  it('styles the toolbar through the layered stock stylesheet, not inline', () => {
    const root = mountAnnotator();
    const navigate = q(root, 'tool-navigate') as HTMLButtonElement;
    expect(navigate.getAttribute('style')).toBeNull();
    expect(navigate.className).toBe('osdlabel-tool-button osdlabel-tool-button-active');
    const rect = q(root, 'tool-rectangle') as HTMLButtonElement;
    expect(rect.getAttribute('style')).toBeNull();
    expect(rect.className).toBe('osdlabel-tool-button');
    expect(root.querySelector('[part="toolbar"]')!.className).toBe('osdlabel-toolbar');
  });

  it('installs the stock stylesheet once per document, with the token fallbacks', () => {
    // jsdom has no constructable stylesheets, so this exercises the <style>
    // fallback; in a browser the same call adopts one CSSStyleSheet instead.
    mountAnnotator();
    unmountForReinstall();
    mountAnnotator();
    const sheets = document.head.querySelectorAll('style[data-osdlabel="stock"]');
    expect(sheets).toHaveLength(1);
    expect(sheets[0]!.textContent).toBe(OSDLABEL_STOCK_CSS);
    expect(sheets[0]!.textContent).toContain('var(--osdlabel-accent, #2196F3)');
  });

  it('exposes part names, with a state part on the active button', () => {
    const root = mountAnnotator();
    expect(q(root, 'annotator-root')!.getAttribute('part')).toBe('root');
    expect(q(root, 'tool-navigate')!.getAttribute('part')).toBe('tool-button tool-button-active');
    expect(q(root, 'tool-rectangle')!.getAttribute('part')).toBe('tool-button');
    expect(root.querySelector('[part="status-bar"]')).not.toBeNull();
  });
});

describe('slot renderer table', () => {
  it('has a renderer for exactly the shared slot names', () => {
    expect(Object.keys(ANNOTATOR_SLOT_RENDERERS).sort()).toEqual(
      Object.keys(ANNOTATOR_SLOT_NAMES).sort(),
    );
  });

  it('does not compile without a renderer for every shared slot', () => {
    const { Toolbar: omitted, ...withoutToolbar } = ANNOTATOR_SLOT_RENDERERS;
    // @ts-expect-error -- a table missing a slot must not type-check; if this
    // directive is reported unused, the table type stopped being exhaustive.
    const incomplete: AnnotatorSlotRendererTable = withoutToolbar;
    expect(Object.keys(incomplete)).not.toContain('Toolbar');
    expect(omitted.Stock).toBe(ANNOTATOR_SLOT_RENDERERS.Toolbar.Stock);
  });

  /** A `components` map overriding only `name`, with a marker component. */
  const overrideOnly = (name: AnnotatorSlotName, marker: Component): AnnotatorComponents => {
    const components: { -readonly [K in AnnotatorSlotName]?: Component<AnnotatorSlotPropsMap[K]> } =
      {};
    components[name] = marker;
    return components;
  };

  // Runtime half of the contract: the layout places every slot, so an
  // override for any shared slot name is rendered.
  for (const name of Object.keys(ANNOTATOR_SLOT_NAMES) as AnnotatorSlotName[]) {
    it(`renders an override for the ${name} slot`, () => {
      const Marker: Component = () => {
        const el = document.createElement('div');
        el.dataset['testid'] = `slot-marker-${name}`;
        return el;
      };
      const root = mountAnnotator(overrideOnly(name, Marker));
      expect(q(root, `slot-marker-${name}`)).not.toBeNull();
    });
  }
});
