import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { FabricOverlay } from '../../../src/overlay/fabric-overlay.js';
import { createTestViewer, type TestViewer } from './test-viewer.js';

/**
 * Which synthetic events bubble, and why it matters (issue #175).
 *
 * `_forwardToFabric` dispatches a synthetic `PointerEvent` on Fabric's upper
 * canvas. The press is deliberately non-bubbling and the move and release are
 * not, and getting that backwards breaks input in ways that are slow and
 * awkward to see: the whole behaviour lives in `apps/dev/tests/e2e/
 * touch-input.spec.ts`, which needs a browser this package's tests do not have.
 *
 * This pins the one line those E2E tests turn on, in milliseconds, so a change
 * to it fails here first.
 */
interface OverlayInternals {
  _forwardToFabric(type: 'pointerdown' | 'pointermove' | 'pointerup', event: PointerEvent): void;
}

const internals = (overlay: FabricOverlay): OverlayInternals =>
  overlay as unknown as OverlayInternals;

/** Only the fields the forwarder copies onto the synthetic event. */
function pointerEvent(type: string): PointerEvent {
  return {
    type,
    clientX: 10,
    clientY: 20,
    screenX: 10,
    screenY: 20,
    button: 0,
    buttons: 1,
    pointerId: 1,
    pointerType: 'touch',
    isPrimary: true,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    metaKey: false,
  } as PointerEvent;
}

/**
 * jsdom has no `PointerEvent`, and the forwarder constructs one. A `MouseEvent`
 * subclass carrying the extra fields is enough: the only property asserted here
 * is `bubbles`, which `MouseEvent` honours from its init dict.
 */
class PointerEventPolyfill extends MouseEvent {
  readonly pointerId: number;
  readonly pointerType: string;
  readonly isPrimary: boolean;
  constructor(type: string, init: PointerEventInit = {}) {
    super(type, init);
    this.pointerId = init.pointerId ?? 0;
    this.pointerType = init.pointerType ?? '';
    this.isPrimary = init.isPrimary ?? false;
  }
}

describe('synthetic event forwarding', () => {
  let tv: TestViewer;
  let overlay: FabricOverlay;
  let dispatched: PointerEvent[];

  beforeEach(() => {
    (globalThis as unknown as { PointerEvent: typeof PointerEventPolyfill }).PointerEvent =
      PointerEventPolyfill;
    tv = createTestViewer();
    overlay = new FabricOverlay(tv.viewer);
    dispatched = [];
    vi.spyOn(
      (overlay as unknown as { _fabricCanvas: { upperCanvasEl: HTMLCanvasElement } })._fabricCanvas
        .upperCanvasEl,
      'dispatchEvent',
    ).mockImplementation((event: Event) => {
      dispatched.push(event as PointerEvent);
      return true;
    });
  });

  afterEach(() => {
    overlay.destroy();
    tv.cleanup();
    vi.restoreAllMocks();
  });

  /**
   * The press must not bubble. It re-enters the OSD MouseTracker's own element
   * otherwise, and `onPointerDown` adds a contact before it honours
   * `stopPropagation` — one real press counted twice. `addContact()` clamps
   * that back for mouse and pen but not for touch, so the touch contact count
   * never returns to zero and the release is never forwarded.
   */
  it('dispatches the press non-bubbling', () => {
    internals(overlay)._forwardToFabric('pointerdown', pointerEvent('pointerdown'));

    expect(dispatched).toHaveLength(1);
    expect(dispatched[0]!.type).toBe('pointerdown');
    expect(dispatched[0]!.bubbles).toBe(false);
  });

  /**
   * The move and release must bubble. Fabric relocates its `pointermove` and
   * `pointerup` listeners to the *document* once a press lands, so a
   * non-bubbling copy reaches Fabric for the press and never for the release.
   * Only `pointerdown` adds a contact, so only the press needs withholding.
   */
  it.each(['pointermove', 'pointerup'] as const)('dispatches the %s bubbling', (type) => {
    internals(overlay)._forwardToFabric(type, pointerEvent(type));

    expect(dispatched).toHaveLength(1);
    expect(dispatched[0]!.type).toBe(type);
    expect(dispatched[0]!.bubbles).toBe(true);
  });
});
