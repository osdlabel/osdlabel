import { describe, expect, it, vi, beforeEach } from 'vitest';
import { DecorationLayer } from '../../../src/decoration/decoration-layer.js';
import type { FabricOverlay } from '../../../src/overlay/fabric-overlay.js';
import type { AnnotationId } from '@osdlabel/annotation';
import type {
  Decoration,
  DomDecoration,
  TextDecoration,
  TextPlacement,
} from '@osdlabel/decoration';
import type { DomDecorationEntry } from '../../../src/decoration/decoration-layer.js';

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

const domDeco = (id: string, overrides: Partial<DomDecoration> = {}): DomDecoration => ({
  type: 'dom',
  id,
  relatedAnnotationIds: [annId(id)],
  anchor: { x: 10, y: 20 },
  content: { id },
  ...overrides,
});

/**
 * jsdom reports 0 for `clientWidth`/`clientHeight` on every element, so the
 * cell-space anchor math (`anchor.x * hostEl.clientWidth`) needs the host's box
 * stubbed. The host is the div the layer appends on construction.
 */
function hostElementOf(hostParent: HTMLElement): HTMLElement {
  const el = hostParent.querySelector('[data-osdlabel="decoration-layer"]');
  expect(el).not.toBeNull();
  return el as HTMLElement;
}

function setHostSize(hostParent: HTMLElement, width: number, height: number): void {
  const host = hostElementOf(hostParent);
  Object.defineProperty(host, 'clientWidth', { value: width, configurable: true });
  Object.defineProperty(host, 'clientHeight', { value: height, configurable: true });
}

const cellText = (id: string, overrides: Partial<TextDecoration> = {}): TextDecoration => ({
  type: 'text',
  id,
  relatedAnnotationIds: [annId(id)],
  text: id,
  anchor: { x: 1, y: 0 },
  anchorSpace: 'cell',
  ...overrides,
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

  it('applies zIndex from text style to el.style.zIndex', () => {
    const { overlay, hostParent } = createMockOverlay();
    const layer = new DecorationLayer(overlay);
    layer.setDecorations([
      {
        type: 'text',
        id: 'z-index-test',
        relatedAnnotationIds: [annId('z-index-test')],
        text: 'Z',
        anchor: { x: 0, y: 0 },
        style: { zIndex: 42 },
      },
    ]);
    const el = hostParent.querySelector('[data-decoration-id="z-index-test"]') as HTMLElement;
    expect(el.style.zIndex).toBe('42');

    // Update to remove zIndex
    layer.setDecorations([
      {
        type: 'text',
        id: 'z-index-test',
        relatedAnnotationIds: [annId('z-index-test')],
        text: 'Z',
        anchor: { x: 0, y: 0 },
      },
    ]);
    expect(el.style.zIndex).toBe('');

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

  describe('DOM decorations', () => {
    it('creates a positioned root div per dom decoration (no text content)', () => {
      const { overlay, hostParent } = createMockOverlay();
      const layer = new DecorationLayer(overlay);
      layer.setDecorations([domDeco('a'), domDeco('b')]);
      const els = hostParent.querySelectorAll('[data-osdlabel="decoration-dom"]');
      expect(els).toHaveLength(2);
      // The layer must never write content into the root — the framework owns it.
      expect(Array.from(els).every((el) => el.textContent === '')).toBe(true);
      layer.destroy();
    });

    it('defaults pointer-events to auto and honors an explicit none', () => {
      const { overlay, hostParent } = createMockOverlay();
      const layer = new DecorationLayer(overlay);
      layer.setDecorations([
        domDeco('interactive'),
        domDeco('visual', { style: { pointerEvents: 'none' } }),
      ]);
      const interactive = hostParent.querySelector(
        '[data-decoration-id="interactive"]',
      ) as HTMLElement;
      const visual = hostParent.querySelector('[data-decoration-id="visual"]') as HTMLElement;
      expect(interactive.style.pointerEvents).toBe('auto');
      expect(visual.style.pointerEvents).toBe('none');
      layer.destroy();
    });

    it('reuses the root div by id across re-runs (stable for portals/focus)', () => {
      const { overlay, hostParent } = createMockOverlay();
      const layer = new DecorationLayer(overlay);
      layer.setDecorations([domDeco('a'), domDeco('b')]);
      const elA1 = hostParent.querySelector('[data-decoration-id="a"]');
      layer.setDecorations([domDeco('a'), domDeco('c')]);
      const elA2 = hostParent.querySelector('[data-decoration-id="a"]');
      expect(elA2).toBe(elA1);
      expect(hostParent.querySelector('[data-decoration-id="b"]')).toBeNull();
      expect(hostParent.querySelector('[data-decoration-id="c"]')).not.toBeNull();
      layer.destroy();
    });

    it('positions and repositions dom roots like text (imageToScreen + offset + onSync)', () => {
      const { overlay, hostParent, syncSubscribers } = createMockOverlay();
      const layer = new DecorationLayer(overlay);
      layer.setDecorations([domDeco('x', { anchor: { x: 5, y: 7 }, offset: { x: 3, y: -1 } })]);
      const el = hostParent.querySelector('[data-decoration-id="x"]') as HTMLElement;
      // imageToScreen mock doubles → (10,14); plus offset → (13,13).
      expect(el.style.transform).toContain('translate3d(13px, 13px, 0)');
      (overlay.imageToScreen as ReturnType<typeof vi.fn>).mockImplementation(
        (p: { x: number; y: number }) => ({ x: p.x * 3, y: p.y * 3 }),
      );
      for (const cb of syncSubscribers) cb();
      // Now triples → (15,21); plus offset → (18,20).
      expect(el.style.transform).toContain('translate3d(18px, 20px, 0)');
      layer.destroy();
    });

    it('notifies subscribers on membership change only — immediately, on add/remove, not on re-emit', () => {
      const { overlay } = createMockOverlay();
      const layer = new DecorationLayer(overlay);
      const calls: number[] = [];
      const unsubscribe = layer.onDomDecorations((entries: readonly DomDecorationEntry[]) => {
        calls.push(entries.length);
      });
      // Immediate callback with current (empty) state.
      expect(calls).toEqual([0]);

      // Add two → one membership change.
      layer.setDecorations([domDeco('a'), domDeco('b')]);
      expect(calls).toEqual([0, 2]);

      // Re-emit the same id set with new objects → NO notification.
      layer.setDecorations([domDeco('a'), domDeco('b')]);
      expect(calls).toEqual([0, 2]);

      // Remove one → membership change.
      layer.setDecorations([domDeco('a')]);
      expect(calls).toEqual([0, 2, 1]);

      unsubscribe();
      layer.setDecorations([domDeco('a'), domDeco('b')]);
      expect(calls).toEqual([0, 2, 1]); // unsubscribed: no further calls
      layer.destroy();
    });

    it('subscription entries expose the live element and decoration', () => {
      const { overlay, hostParent } = createMockOverlay();
      const layer = new DecorationLayer(overlay);
      let latest: readonly DomDecorationEntry[] = [];
      layer.onDomDecorations((entries) => {
        latest = entries;
      });
      layer.setDecorations([domDeco('a', { content: { kind: 'badge' } })]);
      expect(latest).toHaveLength(1);
      expect(latest[0]!.id).toBe('a');
      expect(latest[0]!.element).toBe(hostParent.querySelector('[data-decoration-id="a"]'));
      expect(latest[0]!.decoration.content).toEqual({ kind: 'badge' });
      layer.destroy();
    });

    it('keeps entry object identity stable across membership changes (SolidJS <For>)', () => {
      const { overlay } = createMockOverlay();
      const layer = new DecorationLayer(overlay);
      const notifications: (readonly DomDecorationEntry[])[] = [];
      layer.onDomDecorations((entries) => notifications.push(entries));

      layer.setDecorations([domDeco('a'), domDeco('b')]);
      const firstA = notifications.at(-1)!.find((e) => e.id === 'a')!;
      const firstB = notifications.at(-1)!.find((e) => e.id === 'b')!;

      // Add 'c' (membership change) with brand-new decoration objects for a/b.
      layer.setDecorations([domDeco('a'), domDeco('b'), domDeco('c')]);
      const latest = notifications.at(-1)!;
      // Surviving entries must be the SAME object references, so <For> reuses
      // their rows instead of remounting every portal.
      expect(latest.find((e) => e.id === 'a')).toBe(firstA);
      expect(latest.find((e) => e.id === 'b')).toBe(firstB);
      expect(latest.find((e) => e.id === 'c')).toBeDefined();
      layer.destroy();
    });

    it('updates an entry decoration in place without changing its identity', () => {
      const { overlay } = createMockOverlay();
      const layer = new DecorationLayer(overlay);
      let latest: readonly DomDecorationEntry[] = [];
      layer.onDomDecorations((entries) => {
        latest = entries;
      });
      layer.setDecorations([domDeco('a', { content: { v: 1 } }), domDeco('b')]);
      const entryA = latest.find((e) => e.id === 'a')!;

      // Re-emit with same id set but new content for 'a' → no notification, but
      // the stable entry's decoration is updated in place.
      layer.setDecorations([domDeco('a', { content: { v: 2 } }), domDeco('b')]);
      expect(entryA.decoration.content).toEqual({ v: 2 });
      layer.destroy();
    });

    it('destroy removes dom roots and notifies subscribers with an empty set', () => {
      const { overlay, hostParent } = createMockOverlay();
      const layer = new DecorationLayer(overlay);
      const calls: number[] = [];
      layer.onDomDecorations((entries) => calls.push(entries.length));
      layer.setDecorations([domDeco('a')]);
      expect(calls).toEqual([0, 1]);
      layer.destroy();
      expect(hostParent.querySelector('[data-osdlabel="decoration-dom"]')).toBeNull();
      expect(calls).toEqual([0, 1, 0]);
    });
  });
});

/** Expected `placementTranslate` suffix per placement, for all nine values. */
const PLACEMENT_SUFFIX: Readonly<Record<TextPlacement, string>> = {
  'top-left': 'translate3d(0, 0, 0)',
  'top-right': 'translate3d(-100%, 0, 0)',
  'bottom-left': 'translate3d(0, -100%, 0)',
  'bottom-right': 'translate3d(-100%, -100%, 0)',
  center: 'translate3d(-50%, -50%, 0)',
  top: 'translate3d(-50%, 0, 0)',
  bottom: 'translate3d(-50%, -100%, 0)',
  left: 'translate3d(0, -50%, 0)',
  right: 'translate3d(-100%, -50%, 0)',
};

const ALL_PLACEMENTS = Object.keys(PLACEMENT_SUFFIX) as readonly TextPlacement[];

describe('DecorationLayer — cell-anchored decorations', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('L1: positions a cell-space text decoration from the host box, without imageToScreen', () => {
    const { overlay, hostParent } = createMockOverlay();
    const layer = new DecorationLayer(overlay);
    setHostSize(hostParent, 400, 300);

    layer.setDecorations([cellText('hud', { anchor: { x: 1, y: 0 } })]);

    const el = hostParent.querySelector('[data-decoration-id="hud"]') as HTMLElement;
    expect(el).not.toBeNull();
    expect(el.style.transform).toContain('translate3d(400px, 0px, 0)');
    expect(overlay.imageToScreen).not.toHaveBeenCalled();
    layer.destroy();
  });

  it('L2: positions a cell-space dom decoration the same way', () => {
    const { overlay, hostParent } = createMockOverlay();
    const layer = new DecorationLayer(overlay);
    setHostSize(hostParent, 400, 300);

    layer.setDecorations([domDeco('hud-dom', { anchor: { x: 1, y: 0 }, anchorSpace: 'cell' })]);

    const el = hostParent.querySelector('[data-decoration-id="hud-dom"]') as HTMLElement;
    expect(el).not.toBeNull();
    expect(el.style.transform).toContain('translate3d(400px, 0px, 0)');
    expect(overlay.imageToScreen).not.toHaveBeenCalled();
    layer.destroy();
  });

  it('L3: mixed list — image-space goes through imageToScreen, cell-space does not', () => {
    const { overlay, hostParent } = createMockOverlay();
    const layer = new DecorationLayer(overlay);
    setHostSize(hostParent, 400, 300);

    layer.setDecorations([
      {
        type: 'text',
        id: 'img',
        relatedAnnotationIds: [annId('img')],
        text: 'image-space',
        anchor: { x: 5, y: 7 },
      },
      cellText('cell', { anchor: { x: 0.5, y: 1 } }),
    ]);

    const imgEl = hostParent.querySelector('[data-decoration-id="img"]') as HTMLElement;
    const cellEl = hostParent.querySelector('[data-decoration-id="cell"]') as HTMLElement;
    expect(imgEl.style.transform).toContain('translate3d(10px, 14px, 0)');
    expect(cellEl.style.transform).toContain('translate3d(200px, 300px, 0)');

    const calls = (overlay.imageToScreen as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls).toHaveLength(1);
    expect(calls[0]![0]).toEqual({ x: 5, y: 7 });
    layer.destroy();
  });

  it('L4: applies the screen-px offset in cell space', () => {
    const { overlay, hostParent } = createMockOverlay();
    const layer = new DecorationLayer(overlay);
    setHostSize(hostParent, 400, 300);

    layer.setDecorations([cellText('hud', { anchor: { x: 1, y: 1 }, offset: { x: -8, y: -8 } })]);

    const el = hostParent.querySelector('[data-decoration-id="hud"]') as HTMLElement;
    expect(el.style.transform).toContain('translate3d(392px, 292px, 0)');
    layer.destroy();
  });

  // L5 + L6: all nine placements (the three new corners plus the six existing
  // ones) produce the right alignment suffix, in both anchor spaces.
  it.each(ALL_PLACEMENTS)('L5/L6: placement %s in image space', (placement) => {
    const { overlay, hostParent } = createMockOverlay();
    const layer = new DecorationLayer(overlay);
    layer.setDecorations([
      {
        type: 'text',
        id: 'p',
        relatedAnnotationIds: [annId('p')],
        text: 'p',
        anchor: { x: 5, y: 7 },
        placement,
      },
    ]);
    const el = hostParent.querySelector('[data-decoration-id="p"]') as HTMLElement;
    expect(el.style.transform).toBe(`translate3d(10px, 14px, 0) ${PLACEMENT_SUFFIX[placement]}`);
    layer.destroy();
  });

  it.each(ALL_PLACEMENTS)('L5/L6: placement %s in cell space', (placement) => {
    const { overlay, hostParent } = createMockOverlay();
    const layer = new DecorationLayer(overlay);
    setHostSize(hostParent, 400, 300);
    layer.setDecorations([cellText('p', { anchor: { x: 1, y: 0 }, placement })]);
    const el = hostParent.querySelector('[data-decoration-id="p"]') as HTMLElement;
    expect(el.style.transform).toBe(`translate3d(400px, 0px, 0) ${PLACEMENT_SUFFIX[placement]}`);
    expect(overlay.imageToScreen).not.toHaveBeenCalled();
    layer.destroy();
  });

  it('L7: onSync after a host resize repositions cell-space and re-queries image-space', () => {
    const { overlay, hostParent, syncSubscribers } = createMockOverlay();
    const layer = new DecorationLayer(overlay);
    setHostSize(hostParent, 400, 300);

    layer.setDecorations([
      {
        type: 'text',
        id: 'img',
        relatedAnnotationIds: [annId('img')],
        text: 'image-space',
        anchor: { x: 1, y: 1 },
      },
      cellText('cell', { anchor: { x: 1, y: 1 } }),
    ]);
    const imgEl = hostParent.querySelector('[data-decoration-id="img"]') as HTMLElement;
    const cellEl = hostParent.querySelector('[data-decoration-id="cell"]') as HTMLElement;
    expect(imgEl.style.transform).toContain('translate3d(2px, 2px, 0)');
    expect(cellEl.style.transform).toContain('translate3d(400px, 300px, 0)');

    // The cell grew and the viewport transform changed with it.
    setHostSize(hostParent, 800, 600);
    (overlay.imageToScreen as ReturnType<typeof vi.fn>).mockImplementation(
      (p: { x: number; y: number }) => ({ x: p.x * 3, y: p.y * 3 }),
    );
    (overlay.imageToScreen as ReturnType<typeof vi.fn>).mockClear();
    for (const cb of syncSubscribers) cb();

    expect(cellEl.style.transform).toContain('translate3d(800px, 600px, 0)');
    expect(imgEl.style.transform).toContain('translate3d(3px, 3px, 0)');
    expect(overlay.imageToScreen).toHaveBeenCalledTimes(1);
    layer.destroy();
  });

  it('L8: switching anchorSpace for the same id reuses the element and switches space', () => {
    const { overlay, hostParent } = createMockOverlay();
    const layer = new DecorationLayer(overlay);
    setHostSize(hostParent, 400, 300);

    layer.setDecorations([cellText('switcher', { anchor: { x: 1, y: 0 } })]);
    const first = hostParent.querySelector('[data-decoration-id="switcher"]') as HTMLElement;
    expect(first.style.transform).toContain('translate3d(400px, 0px, 0)');

    layer.setDecorations([
      {
        type: 'text',
        id: 'switcher',
        relatedAnnotationIds: [annId('switcher')],
        text: 'switcher',
        anchor: { x: 5, y: 7 },
        anchorSpace: 'image',
      },
    ]);
    const second = hostParent.querySelector('[data-decoration-id="switcher"]') as HTMLElement;
    expect(second).toBe(first);
    expect(second.style.transform).toContain('translate3d(10px, 14px, 0)');
    layer.destroy();
  });

  it('L8: switching a dom decoration between spaces does not notify subscribers', () => {
    const { overlay, hostParent } = createMockOverlay();
    const layer = new DecorationLayer(overlay);
    setHostSize(hostParent, 400, 300);
    const calls: number[] = [];
    layer.onDomDecorations((entries) => calls.push(entries.length));
    expect(calls).toEqual([0]);

    layer.setDecorations([domDeco('d', { anchor: { x: 1, y: 0 }, anchorSpace: 'cell' })]);
    const el = hostParent.querySelector('[data-decoration-id="d"]') as HTMLElement;
    expect(el.style.transform).toContain('translate3d(400px, 0px, 0)');
    expect(calls).toEqual([0, 1]);

    layer.setDecorations([domDeco('d', { anchor: { x: 5, y: 7 } })]);
    expect(hostParent.querySelector('[data-decoration-id="d"]')).toBe(el);
    expect(el.style.transform).toContain('translate3d(10px, 14px, 0)');
    // Membership did not change, so no notification.
    expect(calls).toEqual([0, 1]);
    layer.destroy();
  });

  it('L9: omitting anchorSpace behaves exactly like an explicit image space', () => {
    const { overlay, hostParent } = createMockOverlay();
    const layer = new DecorationLayer(overlay);
    setHostSize(hostParent, 400, 300);

    layer.setDecorations([
      {
        type: 'text',
        id: 'omitted',
        relatedAnnotationIds: [annId('omitted')],
        text: 'o',
        anchor: { x: 5, y: 7 },
        offset: { x: 3, y: -1 },
        placement: 'center',
      },
      {
        type: 'text',
        id: 'explicit',
        relatedAnnotationIds: [annId('explicit')],
        text: 'e',
        anchor: { x: 5, y: 7 },
        anchorSpace: 'image',
        offset: { x: 3, y: -1 },
        placement: 'center',
      },
    ]);

    const omitted = hostParent.querySelector('[data-decoration-id="omitted"]') as HTMLElement;
    const explicit = hostParent.querySelector('[data-decoration-id="explicit"]') as HTMLElement;
    expect(omitted.style.transform).toBe(explicit.style.transform);
    expect(omitted.style.transform).toBe('translate3d(13px, 13px, 0) translate3d(-50%, -50%, 0)');
    layer.destroy();
  });

  it('L10: destroy removes cell-space text and dom elements', () => {
    const { overlay, hostParent } = createMockOverlay();
    const layer = new DecorationLayer(overlay);
    setHostSize(hostParent, 400, 300);
    layer.setDecorations([
      cellText('hud'),
      domDeco('hud-dom', { anchor: { x: 0, y: 1 }, anchorSpace: 'cell' }),
    ]);
    expect(hostParent.querySelectorAll('[data-osdlabel="decoration-text"]')).toHaveLength(1);
    expect(hostParent.querySelectorAll('[data-osdlabel="decoration-dom"]')).toHaveLength(1);

    layer.destroy();

    expect(hostParent.querySelector('[data-osdlabel="decoration-layer"]')).toBeNull();
    expect(hostParent.querySelector('[data-osdlabel="decoration-text"]')).toBeNull();
    expect(hostParent.querySelector('[data-osdlabel="decoration-dom"]')).toBeNull();
  });
});
