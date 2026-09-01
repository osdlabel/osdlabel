import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The same releases, driven through OpenSeadragon's real `MouseTracker`.
 *
 * `missed-release.test.ts` invokes the overlay's tracker handlers directly
 * and mocks the contact count, which is exactly what let one bug through: a
 * forwarded release that bubbled through the tracker's element re-entered
 * OSD's `updatePointerUp` and removed a contact that was still live, so the
 * second finger that revealed a lost release was reported as a fresh press.
 * Here real DOM events reach the real tracker on the real Fabric container,
 * and the assertions include OSD's own contact counts.
 *
 * OSD decides at module load whether the browser has pointer events and
 * pointer capture, so the polyfills are installed before anything imports it.
 */
vi.hoisted(() => {
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
  (globalThis as unknown as { PointerEvent: unknown }).PointerEvent = PointerEventPolyfill;
  // Browsers retarget a captured pointer's events to the capturing element;
  // the tests dispatch on that element directly, so capture is a no-op here.
  const proto = Element.prototype as unknown as Record<string, unknown>;
  proto['setPointerCapture'] = () => {};
  proto['releasePointerCapture'] = () => {};
});

import { FabricOverlay, type OverlayMode } from '../../../src/overlay/fabric-overlay.js';
import {
  POINTER_CANCEL,
  POINTER_DOWN,
  POINTER_MOVE,
  POINTER_UP,
} from '../../../src/overlay/constants.js';
import { createTestViewer, type TestViewer } from './test-viewer.js';

interface Pointer {
  readonly id: number;
  readonly type: 'touch' | 'pen' | 'mouse';
  readonly primary?: boolean;
}

describe('releases OSD never reports, through the real MouseTracker', () => {
  let tv: TestViewer;
  let overlay: FabricOverlay;
  let container: HTMLElement;
  /** Every synthetic event the overlay dispatched, in order. */
  let forwarded: PointerEvent[];

  function setup(mode: OverlayMode): void {
    tv = createTestViewer();
    overlay = new FabricOverlay(tv.viewer);
    overlay.setMode(mode);
    container = (overlay as unknown as { _fabricContainer: HTMLElement })._fabricContainer;
    forwarded = [];
    // Real events target the Fabric container; everything the overlay
    // dispatches targets the upper canvas or the viewer canvas.
    for (const type of [POINTER_DOWN, POINTER_MOVE, POINTER_UP]) {
      tv.container.addEventListener(
        type,
        (e) => {
          if (e.target !== container) forwarded.push(e as PointerEvent);
        },
        true,
      );
    }
  }

  function fire(type: string, pointer: Pointer, extra: PointerEventInit = {}): void {
    const down = type === POINTER_DOWN || type === POINTER_MOVE;
    container.dispatchEvent(
      new PointerEvent(type, {
        bubbles: true,
        cancelable: true,
        pointerId: pointer.id,
        pointerType: pointer.type,
        isPrimary: pointer.primary ?? true,
        button: 0,
        buttons: down ? 1 : 0,
        clientX: 10,
        clientY: 10,
        ...extra,
      }),
    );
  }

  function contacts(type: string): number {
    return (
      overlay as unknown as {
        _overlayTracker: { getActivePointersListByType(t: string): { contacts: number } };
      }
    )._overlayTracker.getActivePointersListByType(type).contacts;
  }

  const summary = () => forwarded.map((e) => [e.type, e.pointerId, e.isPrimary]);

  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    overlay.destroy();
    tv.cleanup();
    vi.restoreAllMocks();
  });

  it('forwards an ordinary press and release once each', () => {
    setup('paint');
    const finger: Pointer = { id: 1, type: 'touch' };
    fire(POINTER_DOWN, finger);
    expect(contacts('touch')).toBe(1);
    fire(POINTER_UP, finger);
    expect(summary()).toEqual([
      [POINTER_DOWN, 1, true],
      [POINTER_UP, 1, true],
    ]);
    expect(contacts('touch')).toBe(0);
  });

  it('ends the stroke on a second finger without reporting that finger as a press', () => {
    setup('paint');
    const first: Pointer = { id: 1, type: 'touch' };
    const second: Pointer = { id: 2, type: 'touch', primary: false };
    fire(POINTER_DOWN, first);
    fire(POINTER_DOWN, second);
    // The forwarded release did not take a live contact with it.
    expect(contacts('touch')).toBe(2);
    expect(summary()).toEqual([
      [POINTER_DOWN, 1, true],
      [POINTER_UP, 1, true],
    ]);

    fire(POINTER_UP, first);
    expect(contacts('touch')).toBe(1);
    fire(POINTER_UP, second);
    expect(contacts('touch')).toBe(0);
    // No press was ever forwarded for the second finger, so Fabric saw one
    // gesture; its non-primary release is one it ignores.
    expect(summary().filter(([type]) => type === POINTER_DOWN)).toHaveLength(1);
    expect(summary().filter(([type, id]) => type === POINTER_UP && id === 1)).toHaveLength(1);
  });

  it('forwards the lift of the pressing finger while another rests, exactly once', () => {
    setup('annotation');
    const first: Pointer = { id: 1, type: 'touch' };
    const second: Pointer = { id: 2, type: 'touch', primary: false };
    fire(POINTER_DOWN, first);
    fire(POINTER_DOWN, second);
    fire(POINTER_UP, first);
    expect(contacts('touch')).toBe(1);
    expect(summary().filter(([type, id]) => type === POINTER_UP && id === 1)).toHaveLength(1);
    fire(POINTER_UP, second);
    expect(contacts('touch')).toBe(0);
  });

  it('forwards a release for a cancelled pointer and drops its contact', () => {
    setup('paint');
    const finger: Pointer = { id: 1, type: 'touch' };
    fire(POINTER_DOWN, finger);
    fire(POINTER_CANCEL, finger);
    expect(summary()).toEqual([
      [POINTER_DOWN, 1, true],
      [POINTER_UP, 1, true],
    ]);
    expect(contacts('touch')).toBe(0);
  });

  it('lets a palm rest beside a pen without touching the stroke', () => {
    setup('paint');
    const pen: Pointer = { id: 5, type: 'pen' };
    const palm: Pointer = { id: 7, type: 'touch' };
    fire(POINTER_DOWN, pen);
    fire(POINTER_DOWN, palm);
    fire(POINTER_MOVE, pen, { clientX: 20 });
    fire(POINTER_MOVE, palm, { clientX: 30 });
    fire(POINTER_UP, pen);
    fire(POINTER_UP, palm);
    expect(summary()).toEqual([
      [POINTER_DOWN, 5, true],
      [POINTER_MOVE, 5, true],
      [POINTER_UP, 5, true],
    ]);
    expect(contacts('pen')).toBe(0);
    expect(contacts('touch')).toBe(0);
  });
});
