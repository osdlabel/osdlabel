import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, useEffect } from 'react';
import { createAnnotationContextId, type AnnotationContext } from '@osdlabel/annotation-context';
import { createImageId, type ImageSource } from '@osdlabel/viewer-api';
import type { ToolbarSlotProps } from 'osdlabel';
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
  it('reads colours through --osdlabel-* tokens with the old values as fallbacks', () => {
    const root = mountAnnotator();
    const navigate = q(root, 'tool-navigate') as HTMLButtonElement;
    expect(navigate.style.background).toContain('var(--osdlabel-accent, #2196F3)');
    const rect = q(root, 'tool-rectangle') as HTMLButtonElement;
    expect(rect.style.background).toContain('var(--osdlabel-control, #333)');
  });

  it('exposes part names, with a state part on the active button', () => {
    const root = mountAnnotator();
    expect(q(root, 'annotator-root')!.getAttribute('part')).toBe('root');
    expect(q(root, 'tool-navigate')!.getAttribute('part')).toBe('tool-button tool-button-active');
    expect(q(root, 'tool-rectangle')!.getAttribute('part')).toBe('tool-button');
    expect(root.querySelector('[part="status-bar"]')).not.toBeNull();
  });
});
