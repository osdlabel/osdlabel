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

import {
  FabricOverlay,
  type OverlayMode,
  type PointerCancelCallback,
} from '../../../src/overlay/fabric-overlay.js';
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

  /**
   * Every cancel reported to subscribers: the press it took away, the pointer
   * type of the event that revealed it, and how many events the overlay had
   * forwarded by then (a cancel must come before the release that ends it).
   */
  function listenForCancels(): { pressSeq: number; by: string; afterForwarded: number }[] {
    const cancels: { pressSeq: number; by: string; afterForwarded: number }[] = [];
    overlay.onPointerCancel(((event, pressSeq) => {
      cancels.push({ pressSeq, by: event.pointerType, afterForwarded: forwarded.length });
    }) satisfies PointerCancelCallback);
    return cancels;
  }

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

  it.each(['pen', 'mouse'] as const)(
    'lets a touch rest beside a %s press without touching the stroke',
    (type) => {
      setup('paint');
      const stroking: Pointer = { id: 5, type };
      const resting: Pointer = { id: 7, type: 'touch' };
      fire(POINTER_DOWN, stroking);
      fire(POINTER_DOWN, resting);
      fire(POINTER_MOVE, stroking, { clientX: 20 });
      fire(POINTER_MOVE, resting, { clientX: 30 });
      fire(POINTER_UP, stroking);
      fire(POINTER_UP, resting);
      expect(summary()).toEqual([
        [POINTER_DOWN, 5, true],
        [POINTER_MOVE, 5, true],
        [POINTER_UP, 5, true],
      ]);
      expect(contacts(type)).toBe(0);
      expect(contacts('touch')).toBe(0);
    },
  );

  it.each(['touch', 'pen'] as const)(
    "holds a %s that lands while the mouse pans, and ends the pan at the mouse's lift",
    (type) => {
      // A Ctrl/Cmd pan is the mouse's press. The newcomer used to take
      // Fabric's gesture over, which stopped the pan and left OSD's
      // navigation on in annotation mode.
      setup('paint');
      const mouse: Pointer = { id: 1, type: 'mouse' };
      const other: Pointer = { id: 7, type };
      fire(POINTER_DOWN, mouse, { ctrlKey: true });
      expect(tv.setMouseNavEnabled).toHaveBeenLastCalledWith(true);
      fire(POINTER_DOWN, other, { clientX: 40 });
      fire(POINTER_MOVE, other, { clientX: 60 });
      fire(POINTER_MOVE, mouse, { clientX: 20 });
      expect(tv.setMouseNavEnabled).toHaveBeenLastCalledWith(true);
      fire(POINTER_UP, mouse, { clientX: 20 });
      expect(tv.setMouseNavEnabled).toHaveBeenLastCalledWith(false);
      fire(POINTER_UP, other, { clientX: 60 });

      // Nothing of the newcomer's reached Fabric, and no press at all did.
      expect(summary().filter(([, id]) => id === other.id)).toEqual([]);
      expect(summary().filter(([t]) => t === POINTER_DOWN)).toEqual([]);
      expect(contacts('mouse')).toBe(0);
      expect(contacts(type)).toBe(0);
    },
  );

  it('tells subscribers of a cancelled press, before its release, so a tool can discard it', () => {
    setup('paint');
    const cancels = listenForCancels();
    const finger: Pointer = { id: 1, type: 'touch' };
    fire(POINTER_DOWN, finger);
    fire(POINTER_CANCEL, finger);
    expect(summary()).toEqual([
      [POINTER_DOWN, 1, true],
      [POINTER_UP, 1, true],
    ]);
    expect(cancels).toEqual([
      { pressSeq: overlay.pressSeqOf(forwarded[0]!), by: 'touch', afterForwarded: 1 },
    ]);
  });

  // The lift of the pressing finger is ended, and qualified as a click, by
  // the overlay itself, whatever OSD counts. A path that waited for OSD's
  // count to drop missed the click whenever another finger was down, so a
  // double tap whose first tap overlapped a brief second touch never paired:
  // tests that drive the tracker's handlers directly keep the count at zero
  // and cannot see that.
  it('pairs a double tap whose first tap overlapped a brief second touch', () => {
    setup('annotation');
    const onDouble = vi.fn();
    overlay.onDoubleClick(onDouble);
    const a: Pointer = { id: 1, type: 'touch' };
    const b: Pointer = { id: 2, type: 'touch', primary: false };
    const a2: Pointer = { id: 3, type: 'touch' };
    fire(POINTER_DOWN, a, { clientX: 300, clientY: 300 });
    fire(POINTER_DOWN, b, { clientX: 500, clientY: 400 });
    fire(POINTER_UP, a, { clientX: 300, clientY: 300 });
    fire(POINTER_UP, b, { clientX: 500, clientY: 400 });
    expect(contacts('touch')).toBe(0);
    fire(POINTER_DOWN, a2, { clientX: 300, clientY: 300 });
    fire(POINTER_UP, a2, { clientX: 300, clientY: 300 });
    expect(onDouble).toHaveBeenCalledTimes(1);
    expect(contacts('touch')).toBe(0);
  });

  it('lets the pencil through when the palm landed first and is cancelled after', () => {
    // The iPad order: the hand rests, the pencil lands, then the platform
    // cancels the palm.
    setup('paint');
    const cancels = listenForCancels();
    const palm: Pointer = { id: 7, type: 'touch' };
    const pen: Pointer = { id: 5, type: 'pen' };
    fire(POINTER_DOWN, palm);
    fire(POINTER_DOWN, pen);
    fire(POINTER_MOVE, pen, { clientX: 20 });
    fire(POINTER_MOVE, palm, { clientX: 30 });
    fire(POINTER_CANCEL, palm);
    fire(POINTER_UP, pen);
    expect(summary()).toEqual([
      [POINTER_DOWN, 7, true],
      [POINTER_UP, 7, true],
      [POINTER_DOWN, 5, true],
      [POINTER_MOVE, 5, true],
      [POINTER_UP, 5, true],
    ]);
    // The palm's press is cancelled once, by the pencil's, before the release
    // that ends it; the platform's later cancel of the palm, and the pencil's
    // lift, are no others.
    expect(cancels).toEqual([
      { pressSeq: overlay.pressSeqOf(forwarded[0]!), by: 'pen', afterForwarded: 1 },
    ]);
    expect(contacts('pen')).toBe(0);
    expect(contacts('touch')).toBe(0);
  });

  it('lets the mouse through while a finger rests, and holds the finger to its lift', () => {
    // A touch never wins over a mouse either: a finger left on a touchscreen
    // while the other hand takes the mouse. Nothing cancels that finger, so
    // it lifts after the mouse's stroke, and its lift must end nothing.
    setup('paint');
    const cancels = listenForCancels();
    const finger: Pointer = { id: 7, type: 'touch' };
    const mouse: Pointer = { id: 1, type: 'mouse' };
    fire(POINTER_DOWN, finger);
    fire(POINTER_DOWN, mouse);
    fire(POINTER_MOVE, mouse, { clientX: 20 });
    fire(POINTER_MOVE, finger, { clientX: 30 });
    fire(POINTER_UP, mouse);
    fire(POINTER_UP, finger);
    expect(summary()).toEqual([
      [POINTER_DOWN, 7, true],
      [POINTER_UP, 7, true],
      [POINTER_DOWN, 1, true],
      [POINTER_MOVE, 1, true],
      [POINTER_UP, 1, true],
    ]);
    // The finger's press is cancelled once, by the mouse's, before the
    // release that ends it; the finger's lift and the mouse's are no others.
    expect(cancels).toEqual([
      { pressSeq: overlay.pressSeqOf(forwarded[0]!), by: 'mouse', afterForwarded: 1 },
    ]);
    expect(contacts('mouse')).toBe(0);
    expect(contacts('touch')).toBe(0);
  });
});
