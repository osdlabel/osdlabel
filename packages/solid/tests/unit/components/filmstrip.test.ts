import { describe, it, expect, vi, afterEach } from 'vitest';
import { createComponent } from 'solid-js';
import { createStore } from 'solid-js/store';
import { render } from 'solid-js/web';
import { createImageId, type ImageSource } from '@osdlabel/viewer-api';
import { createMockAnnotator } from '../hooks/mock-annotator.js';

const mockState = createMockAnnotator();

vi.mock('../../../src/state/annotator-context.js', () => ({
  useAnnotator: () => mockState,
}));

const { default: Filmstrip } = await import('../../../src/components/Filmstrip.js');

describe('Filmstrip', () => {
  let dispose: (() => void) | undefined;
  afterEach(() => {
    dispose?.();
    dispose = undefined;
    document.body.innerHTML = '';
  });

  it('follows a change to an image’s label (#205)', () => {
    // The label used to be read once per item, so a host whose images live in
    // a store kept showing, and announcing, the old name.
    // Mutable, so the store can be written; `ImageSource` itself is readonly.
    const [image, setImage] = createStore({
      id: createImageId('img-1'),
      tileSource: 'x.png',
      label: 'Before',
    });
    const images: readonly ImageSource[] = [image];
    const container = document.createElement('div');
    document.body.append(container);
    dispose = render(() => createComponent(Filmstrip, { images, position: 'left' }), container);

    const thumb = container.querySelector('[data-testid="filmstrip-thumb-img-1"]');
    expect(thumb).not.toBeNull();
    expect(thumb!.getAttribute('aria-label')).toMatch(/^Before,/);
    expect(thumb!.textContent).toBe('Before');

    setImage('label', 'After');

    expect(thumb!.getAttribute('aria-label')).toMatch(/^After,/);
    expect(thumb!.textContent).toBe('After');
  });
});
