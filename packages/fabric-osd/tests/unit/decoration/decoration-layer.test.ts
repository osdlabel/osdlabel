import { describe, expect, it, vi, beforeEach } from 'vitest';
import { DecorationLayer } from '../../../src/decoration/decoration-layer.js';
import type { FabricOverlay } from '../../../src/overlay/fabric-overlay.js';
import type { AnnotationId } from '@osdlabel/annotation';
import type { Decoration } from '@osdlabel/decoration';

/**
 * A mock FabricOverlay sufficient for unit-testing the DecorationLayer's
 * DOM and Fabric-canvas interactions. Tests the diff/lifecycle logic
 * without spinning up a real OSD viewer.
 */
function createMockOverlay(): {
  overlay: FabricOverlay;
  canvas: {
    add: ReturnType<typeof vi.fn>;
    remove: ReturnType<typeof vi.fn>;
    requestRenderAll: ReturnType<typeof vi.fn>;
  };
  hostParent: HTMLElement;
  syncSubscribers: Set<() => void>;
} {
  const hostParent = document.createElement('div');
  document.body.appendChild(hostParent);
  const syncSubscribers = new Set<() => void>();
  const canvas = {
    add: vi.fn(),
    remove: vi.fn(),
    requestRenderAll: vi.fn(),
  };
  const overlay = {
    canvas,
    overlayElement: hostParent,
    imageToScreen: vi.fn((p: { x: number; y: number }) => ({ x: p.x * 2, y: p.y * 2 })),
    onSync: vi.fn((cb: () => void) => {
      syncSubscribers.add(cb);
      return () => {
        syncSubscribers.delete(cb);
      };
    }),
  } as unknown as FabricOverlay;
  return { overlay, canvas, hostParent, syncSubscribers };
}

const annId = (s: string): AnnotationId => s as AnnotationId;

const textDeco = (id: string, text = id): Decoration => ({
  type: 'text',
  id,
  relatedAnnotationIds: [annId(id)],
  text,
  anchor: { x: 10, y: 20 },
});

describe('DecorationLayer', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('mounts a host element on construction and subscribes to onSync', () => {
    const { overlay, hostParent, syncSubscribers } = createMockOverlay();
    const layer = new DecorationLayer(overlay);
    expect(hostParent.querySelector('[data-osdlabel="decoration-layer"]')).not.toBeNull();
    expect(syncSubscribers.size).toBe(1);
    layer.destroy();
  });

  it('setDecorations adds DOM elements for text decorations', () => {
    const { overlay, hostParent } = createMockOverlay();
    const layer = new DecorationLayer(overlay);
    layer.setDecorations([textDeco('a', 'Hello'), textDeco('b', 'World')]);
    const els = hostParent.querySelectorAll('[data-osdlabel="decoration-text"]');
    expect(els).toHaveLength(2);
    const texts = Array.from(els).map((el) => el.textContent);
    expect(texts).toContain('Hello');
    expect(texts).toContain('World');
    layer.destroy();
  });

  it('setDecorations re-running diffs by id (adds new, removes gone, keeps shared)', () => {
    const { overlay, hostParent } = createMockOverlay();
    const layer = new DecorationLayer(overlay);
    layer.setDecorations([textDeco('a'), textDeco('b')]);
    const elA1 = hostParent.querySelector('[data-decoration-id="a"]');
    expect(elA1).not.toBeNull();

    // Replace: remove b, add c, keep a (same id => element instance is reused)
    layer.setDecorations([textDeco('a', 'A2'), textDeco('c')]);
    const elA2 = hostParent.querySelector('[data-decoration-id="a"]');
    expect(elA2).toBe(elA1); // element instance reused
    expect(elA2!.textContent).toBe('A2');
    expect(hostParent.querySelector('[data-decoration-id="b"]')).toBeNull();
    expect(hostParent.querySelector('[data-decoration-id="c"]')).not.toBeNull();
    layer.destroy();
  });

  it('positions text via overlay.imageToScreen + screen-px offset', () => {
    const { overlay, hostParent } = createMockOverlay();
    const layer = new DecorationLayer(overlay);
    layer.setDecorations([
      {
        type: 'text',
        id: 'x',
        relatedAnnotationIds: [annId('x')],
        text: 't',
        anchor: { x: 5, y: 7 },
        offset: { x: 3, y: -1 },
      },
    ]);
    const el = hostParent.querySelector('[data-decoration-id="x"]') as HTMLElement;
    // imageToScreen doubles the coords (mock) → (10, 14). Plus offset → (13, 13).
    expect(el.style.transform).toContain('translate3d(13px, 13px, 0)');
    layer.destroy();
  });

  it('repositions text on overlay.onSync callback', () => {
    const { overlay, hostParent, syncSubscribers } = createMockOverlay();
    const layer = new DecorationLayer(overlay);
    layer.setDecorations([
      {
        type: 'text',
        id: 'x',
        relatedAnnotationIds: [annId('x')],
        text: 't',
        anchor: { x: 1, y: 1 },
      },
    ]);
    const el = hostParent.querySelector('[data-decoration-id="x"]') as HTMLElement;
    // Initial position: imageToScreen mock doubles → (2,2)
    expect(el.style.transform).toContain('translate3d(2px, 2px, 0)');
    // Change the mock to triple, then fire sync
    (overlay.imageToScreen as ReturnType<typeof vi.fn>).mockImplementation(
      (p: { x: number; y: number }) => ({ x: p.x * 3, y: p.y * 3 }),
    );
    for (const cb of syncSubscribers) cb();
    expect(el.style.transform).toContain('translate3d(3px, 3px, 0)');
    layer.destroy();
  });

  it('applies placement via CSS transform suffix', () => {
    const { overlay, hostParent } = createMockOverlay();
    const layer = new DecorationLayer(overlay);
    layer.setDecorations([
      {
        type: 'text',
        id: 'centered',
        relatedAnnotationIds: [annId('centered')],
        text: 't',
        anchor: { x: 0, y: 0 },
        placement: 'center',
      },
    ]);
    const el = hostParent.querySelector('[data-decoration-id="centered"]') as HTMLElement;
    expect(el.style.transform).toContain('translate3d(-50%, -50%, 0)');
    layer.destroy();
  });

  it('destroy removes the host element and unsubscribes', () => {
    const { overlay, hostParent, syncSubscribers } = createMockOverlay();
    const layer = new DecorationLayer(overlay);
    expect(syncSubscribers.size).toBe(1);
    layer.destroy();
    expect(hostParent.querySelector('[data-osdlabel="decoration-layer"]')).toBeNull();
    expect(syncSubscribers.size).toBe(0);
  });
});
