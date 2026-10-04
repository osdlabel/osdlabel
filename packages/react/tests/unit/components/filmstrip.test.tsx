import { describe, it, expect, vi, afterEach } from 'vitest';
import { act } from 'react';
import { createImageId, type ImageSource, type UIState } from '@osdlabel/viewer-api';
import { createInitialUIState } from 'osdlabel';
import { mount, unmountAll } from '../mount.js';
import { createMockAnnotator, type MockAnnotator } from '../hooks/mock-annotator.js';

/** Reassigned per test; `useAnnotator` returns whatever it holds at render. */
let mockState: MockAnnotator = createMockAnnotator();

vi.mock('../../../src/state/annotator-context.js', () => ({
  useAnnotator: () => mockState,
}));

const { default: Filmstrip } = await import('../../../src/components/Filmstrip.js');

/**
 * The React counterpart of Solid's `components/filmstrip.test.ts`.
 *
 * Solid's test pins that a store-backed label is read reactively rather than
 * once. React re-renders the whole item from props, so the equivalent is a
 * re-render with a new `images` array. The other two tests cover React's own
 * wiring: the click handlers close over `uiState` from the latest render, and
 * the clear button's focus hand-off (#189), which lives in the component.
 */
describe('Filmstrip', () => {
  const img1 = createImageId('img-1');
  const img2 = createImageId('img-2');

  afterEach(() => {
    unmountAll();
    mockState = createMockAnnotator();
  });

  function withUi(patch: Partial<UIState>): void {
    mockState = { ...mockState, uiState: { ...createInitialUIState(), ...patch } };
  }

  const thumb = (root: HTMLElement, id: string) =>
    root.querySelector<HTMLButtonElement>(`[data-testid="filmstrip-thumb-${id}"]`);

  it('follows a change to an image’s label (#205)', () => {
    const before: readonly ImageSource[] = [{ id: img1, tileSource: 'x.png', label: 'Before' }];
    const m = mount(<Filmstrip images={before} position="left" />);

    const button = thumb(m.container, 'img-1');
    expect(button).not.toBeNull();
    expect(button!.getAttribute('aria-label')).toMatch(/^Before,/);
    expect(button!.textContent).toBe('Before');

    m.rerender(
      <Filmstrip images={[{ id: img1, tileSource: 'x.png', label: 'After' }]} position="left" />,
    );

    // The same element, updated in place rather than remounted.
    expect(thumb(m.container, 'img-1')).toBe(button);
    expect(button!.getAttribute('aria-label')).toMatch(/^After,/);
    expect(button!.textContent).toBe('After');
  });

  it('assigns a thumbnail to the active cell of the latest render', () => {
    const images: readonly ImageSource[] = [
      { id: img1, tileSource: 'a.png' },
      { id: img2, tileSource: 'b.png' },
    ];
    withUi({ gridColumns: 2 });
    const m = mount(<Filmstrip images={images} position="bottom" />);

    withUi({ gridColumns: 2, activeCellIndex: 1 });
    m.rerender(<Filmstrip images={images} position="bottom" />);
    act(() => thumb(m.container, 'img-2')!.click());

    expect(mockState.actions.assignImageToCell).toHaveBeenCalledWith(1, img2);
  });

  describe('the clear button', () => {
    const images: readonly ImageSource[] = [{ id: img1, tileSource: 'a.png' }];

    function mountActive() {
      withUi({ gridColumns: 2, activeCellIndex: 1, gridAssignments: { 1: img1 } });
      const m = mount(<Filmstrip images={images} position="left" />);
      const clear = m.container.querySelector<HTMLButtonElement>(
        '[data-testid="filmstrip-clear-img-1"]',
      );
      expect(clear).not.toBeNull();
      return { m, clear: clear! };
    }

    it('clears the active cell', () => {
      const { clear } = mountActive();
      act(() => clear.click());
      expect(mockState.actions.unassignImageFromCell).toHaveBeenCalledWith(1);
    });

    it('hands keyboard focus to its thumbnail before it unmounts (#189)', () => {
      const { m, clear } = mountActive();
      clear.focus();
      expect(document.activeElement).toBe(clear);

      act(() => clear.click());

      expect(document.activeElement).toBe(thumb(m.container, 'img-1'));
    });

    it('leaves focus alone when it did not have it', () => {
      // A mouse press never focuses it (preventButtonFocusSteal), so a click
      // must not pull focus onto the thumbnail from wherever it was.
      const elsewhere = document.createElement('input');
      document.body.append(elsewhere);
      try {
        elsewhere.focus();
        const { clear } = mountActive();

        act(() => clear.click());

        expect(document.activeElement).toBe(elsewhere);
      } finally {
        elsewhere.remove();
      }
    });
  });
});
