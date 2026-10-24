import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, useEffect, type ComponentType, type ReactElement } from 'react';
import { createAnnotationContextId, type AnnotationContext } from '@osdlabel/annotation-context';
import { createImageId, type ImageSource } from '@osdlabel/viewer-api';
import { ANNOTATOR_SLOT_NAMES, OSDLABEL_STOCK_CSS } from 'osdlabel';
import type { AnnotatorSlotName, AnnotatorSlotPropsMap, ToolbarSlotProps } from 'osdlabel';
import {
  ANNOTATOR_SLOT_RENDERERS,
  type AnnotatorSlotRendererTable,
} from '../../../src/components/annotator-slots.js';
import { useAnnotator } from '../../../src/state/annotator-context.js';
import { mount, unmountAll } from '../mount.js';

/**
 * The override slot and the theme hooks, through the real `<Annotator>` and
 * provider. Mirrors `packages/solid/tests/unit/components/annotator-components.test.ts`.
 */

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

const CONTEXTS: AnnotationContext[] = [
  {
    id: createAnnotationContextId('general'),
    label: 'General',
    tools: [{ type: 'rectangle' }, { type: 'line', maxCount: 2 }],
  },
];
const IMAGES: ImageSource[] = [{ id: createImageId('img'), tileSource: 'img.png' }];

function AssignImage() {
  const { actions } = useAnnotator();
  useEffect(() => {
    actions.assignImageToCell(0, IMAGES[0]!.id);
  }, [actions]);
  return null;
}

afterEach(unmountAll);

/** Unmounts the current annotator, as the afterEach does. */
const unmountForReinstall = unmountAll;

function mountAnnotator(components?: AnnotatorComponents): HTMLElement {
  return mount(
    <Annotator
      images={IMAGES}
      contexts={CONTEXTS}
      showFilmstrip={false}
      {...(components ? { components } : {})}
      providerChildren={<AssignImage />}
    />,
  ).container;
}

/** A host toolbar: one plain button per model button, nothing from the stock UI. */
let received: ToolbarSlotProps | undefined;
function CustomToolbar(props: ToolbarSlotProps) {
  received = props;
  return (
    <div data-testid="custom-toolbar">
      {props.model.buttons.map((b) => (
        <button
          key={b.key}
          data-testid={`custom-${b.key}`}
          data-active={String(b.active)}
          disabled={!b.enabled}
          onClick={() => props.onSelectTool(b.tool)}
        >
          {b.countLabel ? `${b.label} (${b.countLabel})` : b.label}
        </button>
      ))}
    </div>
  );
}

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
    act(() => {
      received!.onSelectTool('rectangle');
    });
    expect(q(root, 'status-tool')!.textContent).toContain('Rectangle');
    // The override re-rendered with a model that reports rectangle active.
    expect(received!.model.buttons.find((b) => b.key === 'rectangle')!.active).toBe(true);
    expect(q(root, 'custom-rectangle')!.getAttribute('data-active')).toBe('true');
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
  const overrideOnly = (
    name: AnnotatorSlotName,
    marker: () => ReactElement,
  ): AnnotatorComponents => {
    const components: {
      -readonly [K in AnnotatorSlotName]?: ComponentType<AnnotatorSlotPropsMap[K]>;
    } = {};
    components[name] = marker;
    return components;
  };

  // Runtime half of the contract: the layout places every slot, so an
  // override for any shared slot name is rendered.
  for (const name of Object.keys(ANNOTATOR_SLOT_NAMES) as AnnotatorSlotName[]) {
    it(`renders an override for the ${name} slot`, () => {
      const Marker = () => <div data-testid={`slot-marker-${name}`} />;
      const root = mountAnnotator(overrideOnly(name, Marker));
      expect(q(root, `slot-marker-${name}`)).not.toBeNull();
    });
  }
});
