import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Rect } from 'fabric';
import type { FabricObject, TPointerEventInfo } from 'fabric';
import { FabricOverlay } from '../../../src/overlay/fabric-overlay.js';
import type { DoubleClickCallback } from '../../../src/overlay/fabric-overlay.js';
import { createTestViewer, installPointerEventPolyfill, type TestViewer } from './test-viewer.js';

/**
 * A second pointer on the overlay while a press is in progress: a second
 * finger, or a mouse or pen next to a finger.
 *
 * OSD's MouseTracker counts contacts per pointer type and calls
 * `releaseHandler` only when the last contact of a type lifts. So when the
 * finger that pressed lifts while another stays down, OSD runs
 * `preProcessEventHandler` for that `pointerup` and nothing else, and the
 * overlay used to forward no release: Fabric's transform stayed open, the
 * canvas showed the edit while the host's state kept the old shape, and the
 * next movement of any pointer carried the shape on. The other finger's own
 * release, which OSD does report, reached Fabric as a non-primary event,
 * which Fabric ignores.
 *
 * The lift of the pointer that pressed is a release: the gesture ends there
 * and commits as a mouse release would. Every other pointer that goes down
 * meanwhile is held: nothing it does reaches Fabric until it lifts. The
 * gesture end to end, through real two-finger touch input, is in
 * `apps/dev/tests/e2e/touch-second-finger.spec.ts`; this pins the overlay's
 * half against a real Fabric canvas.
 *
 * The tracker's handlers are driven directly, as `pointer-cancel.test.ts`
 * does (under jsdom OSD binds mouse events, not pointer events). Each step
 * makes exactly the calls OSD makes for that DOM event: `preProcessEventHandler`
 * always, then `pressHandler` / `releaseHandler` only for the first contact
 * of its type to go down / the last to lift, and `moveHandler` for every move.
 */
interface TrackerEvent {
  readonly originalEvent: PointerEvent;
}
interface EventProcessInfo {
  readonly eventType: string;
  readonly originalEvent: PointerEvent;
  stopPropagation?: boolean;
  preventDefault?: boolean;
}
interface OverlayInternals {
  _overlayTracker: {
    pressHandler(event: TrackerEvent): void;
    moveHandler(event: TrackerEvent): void;
    releaseHandler(event: TrackerEvent): void;
    preProcessEventHandler(event: EventProcessInfo): void;
  };
}

const tracker = (overlay: FabricOverlay): OverlayInternals['_overlayTracker'] =>
  (overlay as unknown as OverlayInternals)._overlayTracker;

type At = { readonly x: number; readonly y: number };

interface PointerSpec {
  readonly pointerId: number;
  readonly pointerType: 'touch' | 'mouse' | 'pen';
  readonly isPrimary: boolean;
}

/** The finger that presses first: Chrome makes it the primary touch. */
const FINGER_A: PointerSpec = { pointerId: 7, pointerType: 'touch', isPrimary: true };
/** A finger put down while A is down: never primary, even after A lifts. */
const FINGER_B: PointerSpec = { pointerId: 8, pointerType: 'touch', isPrimary: false };
/** A third finger, put down while B is still down. */
const FINGER_C: PointerSpec = { pointerId: 9, pointerType: 'touch', isPrimary: false };
/** A mouse: OSD counts its contacts apart from touch, and it is always primary. */
const MOUSE: PointerSpec = { pointerId: 1, pointerType: 'mouse', isPrimary: true };

/** A pointer event of `pointer`, as the browser delivers it. */
function event(type: string, pointer: PointerSpec, at: At, timeStamp = 0): PointerEvent {
  const e = new PointerEvent(type, {
    clientX: at.x,
    clientY: at.y,
    button: 0,
    buttons: type === 'pointerup' ? 0 : 1,
    bubbles: true,
    cancelable: true,
    ...pointer,
  });
  // The polyfill's timeStamp is the creation time; the click qualifier reads it.
  Object.defineProperty(e, 'timeStamp', { value: timeStamp });
  return e;
}

describe('FabricOverlay: a second pointer while a press is in progress', () => {
  let tv: TestViewer;
  let overlay: FabricOverlay;
  let rect: Rect;
  let restorePointerEvent: () => void;
  let modified: ReturnType<typeof vi.fn<(e: { target: FabricObject }) => void>>;
  /** Every event Fabric fired, by name, with the pointer it came from. */
  let fired: { name: string; pointerId: number }[];

  beforeEach(() => {
    restorePointerEvent = installPointerEventPolyfill();
    tv = createTestViewer();
    overlay = new FabricOverlay(tv.viewer);
    rect = new Rect({
      left: 100,
      top: 100,
      width: 40,
      height: 30,
      originX: 'center',
      originY: 'center',
    });
    rect.id = 'ann-1';
    overlay.canvas.add(rect);
    overlay.setMode('annotation');
    modified = vi.fn<(e: { target: FabricObject }) => void>();
    overlay.canvas.on('object:modified', modified);
    // Each canvas writes to its own array: Fabric's `dispose()` can defer
    // removing a canvas's document listeners to its next frame, so an earlier
    // test's canvas may still hear this test's events.
    const log: { name: string; pointerId: number }[] = [];
    fired = log;
    for (const name of [
      'mouse:down:before',
      'mouse:down',
      'mouse:move:before',
      'mouse:up:before',
      'mouse:up',
    ] as const) {
      overlay.canvas.on(name, (opt: TPointerEventInfo) => {
        log.push({ name, pointerId: (opt.e as PointerEvent).pointerId });
      });
    }
  });

  afterEach(() => {
    overlay.destroy();
    tv.cleanup();
    restorePointerEvent();
  });

  // ── What OSD calls, per DOM event ──────────────────────────────────────

  const pre = (eventType: string, originalEvent: PointerEvent): EventProcessInfo => {
    const info: EventProcessInfo = { eventType, originalEvent };
    tracker(overlay).preProcessEventHandler(info);
    return info;
  };
  /** A `pointerdown` OSD reports as a press: the first contact of its type. */
  const press = (pointer: PointerSpec, at: At, time = 0): void => {
    const e = event('pointerdown', pointer, at, time);
    pre('pointerdown', e);
    tracker(overlay).pressHandler({ originalEvent: e });
  };
  /** A `pointerdown` OSD does not report: another contact of its type is down. */
  const downUnreported = (pointer: PointerSpec, at: At): EventProcessInfo =>
    pre('pointerdown', event('pointerdown', pointer, at));
  /** A `pointermove`: OSD reports every one. */
  const move = (pointer: PointerSpec, at: At, buttons = 1): void => {
    const e = event('pointermove', pointer, at);
    Object.defineProperty(e, 'buttons', { value: buttons });
    pre('pointermove', e);
    tracker(overlay).moveHandler({ originalEvent: e });
  };
  /** A `pointerup` OSD reports as a release: the last contact of its type. */
  const release = (pointer: PointerSpec, at: At, time = 0): void => {
    const e = event('pointerup', pointer, at, time);
    pre('pointerup', e);
    tracker(overlay).releaseHandler({ originalEvent: e });
  };
  /** A `pointerup` OSD does not report: another contact of its type is still down. */
  const upUnreported = (pointer: PointerSpec, at: At, time = 0): EventProcessInfo =>
    pre('pointerup', event('pointerup', pointer, at, time));

  const transformOpen = (): boolean => overlay.canvas._currentTransform !== null;
  const firedBy = (name: string, pointer: PointerSpec): number =>
    fired.filter((f) => f.name === name && f.pointerId === pointer.pointerId).length;
  const firedAny = (name: string): number => fired.filter((f) => f.name === name).length;

  it("ends a drag at the pressing finger's lift, though another finger stays down", () => {
    press(FINGER_A, { x: 100, y: 100 });
    move(FINGER_A, { x: 130, y: 120 });
    move(FINGER_A, { x: 160, y: 140 });
    downUnreported(FINGER_B, { x: 400, y: 300 });
    move(FINGER_A, { x: 170, y: 150 });
    expect(rect.left).toBe(170);

    // OSD reports no release here: B is still down.
    upUnreported(FINGER_A, { x: 170, y: 150 });

    expect(transformOpen(), "Fabric's transform is still open").toBe(false);
    expect(modified).toHaveBeenCalledTimes(1);
    expect(modified.mock.calls[0]![0].target).toBe(rect);
    expect(firedBy('mouse:up', FINGER_A)).toBe(1);
    expect({ left: rect.left, top: rect.top }).toEqual({ left: 170, top: 150 });
  });

  it('lets the finger left down move and lift without touching the shape', () => {
    press(FINGER_A, { x: 100, y: 100 });
    move(FINGER_A, { x: 140, y: 130 });
    downUnreported(FINGER_B, { x: 400, y: 300 });
    move(FINGER_B, { x: 420, y: 310 });
    upUnreported(FINGER_A, { x: 140, y: 130 });
    const afterLift = fired.length;

    // B on its own: OSD reports its moves, and its lift as the release, since
    // it is the last contact.
    move(FINGER_B, { x: 450, y: 330 });
    move(FINGER_B, { x: 480, y: 350 });
    release(FINGER_B, { x: 480, y: 350 });

    // None of it reached Fabric.
    expect(fired.slice(afterLift)).toEqual([]);
    expect({ left: rect.left, top: rect.top }).toEqual({ left: 140, top: 130 });
    expect(modified).toHaveBeenCalledTimes(1);

    // And the next press, of any finger, is a gesture of its own.
    press(FINGER_A, { x: 300, y: 300 });
    move(FINGER_A, { x: 340, y: 320 });
    release(FINGER_A, { x: 340, y: 320 });
    expect({ left: rect.left, top: rect.top }).toEqual({ left: 140, top: 130 });
    expect(modified).toHaveBeenCalledTimes(1);
  });

  it("forwards nothing of the second finger's while the first is down", () => {
    press(FINGER_A, { x: 100, y: 100 });
    move(FINGER_A, { x: 120, y: 110 });
    const beforeB = fired.length;

    const down = downUnreported(FINGER_B, { x: 400, y: 300 });
    move(FINGER_B, { x: 420, y: 310 });
    move(FINGER_B, { x: 440, y: 320 });

    expect(fired.slice(beforeB)).toEqual([]);
    // OSD and the page must not see it either: OSD would treat it as the
    // start of a pinch or a pan.
    expect(down.stopPropagation).toBe(true);
    expect(down.preventDefault).toBe(true);
    expect(rect.left).toBe(120);
  });

  /**
   * A mouse next to a finger. OSD counts mouse and touch contacts apart, so it
   * reports the mouse's press while the finger is down, and Chrome marks both
   * primary, so Fabric does not tell them apart: a mouse press started a
   * second gesture on top of the first, and a mouse hover carried the shape
   * the finger was dragging.
   */
  it('holds a pointer of another type that goes down mid-press, and its hover', () => {
    press(FINGER_A, { x: 100, y: 100 });
    move(FINGER_A, { x: 120, y: 110 });
    const beforeMouse = fired.length;

    move(MOUSE, { x: 500, y: 400 }, 0);
    press(MOUSE, { x: 500, y: 400 });
    move(MOUSE, { x: 520, y: 420 });
    release(MOUSE, { x: 520, y: 420 });

    expect(fired.slice(beforeMouse)).toEqual([]);
    expect(rect.left).toBe(120);
    expect(transformOpen()).toBe(true);

    // The finger's gesture is still the one in progress, and its lift ends it.
    move(FINGER_A, { x: 150, y: 130 });
    release(FINGER_A, { x: 150, y: 130 });
    expect(modified).toHaveBeenCalledTimes(1);
    expect({ left: rect.left, top: rect.top }).toEqual({ left: 150, top: 130 });
  });

  /**
   * A mouse pressed outside the viewer and released over it: OSD reports the
   * release ("pressed in another element") though the overlay never saw the
   * press, so the pointer was never held. It ended the finger's gesture with
   * the mouse's position.
   */
  it('does not let a release it never saw press end the press in progress', () => {
    press(FINGER_A, { x: 100, y: 100 });
    move(FINGER_A, { x: 120, y: 110 });
    const beforeMouse = fired.length;

    release(MOUSE, { x: 500, y: 400 });

    expect(fired.slice(beforeMouse)).toEqual([]);
    expect(transformOpen()).toBe(true);
    move(FINGER_A, { x: 150, y: 130 });
    release(FINGER_A, { x: 150, y: 130 });
    expect(modified).toHaveBeenCalledTimes(1);
    expect({ left: rect.left, top: rect.top }).toEqual({ left: 150, top: 130 });
  });

  it('starts nothing for a finger that joins one left down after the press ended', () => {
    press(FINGER_A, { x: 100, y: 100 });
    downUnreported(FINGER_B, { x: 400, y: 300 });
    upUnreported(FINGER_A, { x: 100, y: 100 });
    const beforeC = fired.length;

    // OSD may report C's press (its count of B's contact can be off by the
    // release the overlay forwarded for A); C is not primary either way.
    press(FINGER_C, { x: 300, y: 300 });
    move(FINGER_C, { x: 330, y: 320 });
    upUnreported(FINGER_C, { x: 330, y: 320 });
    release(FINGER_B, { x: 400, y: 300 });

    expect(fired.slice(beforeC)).toEqual([]);
  });

  /**
   * The usual case: A is the last contact, so OSD reports the release too,
   * after `preProcessEventHandler` has ended the gesture. A second forward
   * would be lost on Fabric, which unbinds its release listener after the
   * first, but qualifying the release twice is not: the second finds no press
   * and clears the click the first recorded, so no two taps would pair.
   */
  it('handles the lift of a lone finger once, as before', () => {
    const forwardedReleases: Event[] = [];
    // Where every forwarded release is dispatched: the viewer canvas, above
    // the tracker's element, so OSD's contact count never sees it.
    overlay.overlayElement.addEventListener('pointerup', (e) => forwardedReleases.push(e));
    const onDoubleClick = vi.fn<DoubleClickCallback>();
    overlay.onDoubleClick(onDoubleClick);

    press(FINGER_A, { x: 100, y: 100 }, 0);
    move(FINGER_A, { x: 130, y: 120 });
    release(FINGER_A, { x: 130, y: 120 }, 40);

    expect(forwardedReleases).toHaveLength(1);
    expect(firedAny('mouse:up')).toBe(1);
    expect(modified).toHaveBeenCalledTimes(1);
    expect(transformOpen()).toBe(false);

    // Two taps, each reported by OSD as well, pair.
    const tap = (pointerId: number, time: number): void => {
      press({ ...FINGER_A, pointerId }, { x: 300, y: 300 }, time);
      release({ ...FINGER_A, pointerId }, { x: 300, y: 300 }, time + 30);
    };
    tap(11, 1000);
    tap(12, 1100);
    expect(onDoubleClick).toHaveBeenCalledTimes(1);
  });

  /**
   * The lift is a release in every respect, so it also qualifies as a click.
   * And the held finger's own lift is nothing at all: it must not break the
   * pairing (it used to clear it, as a release with no matching press).
   */
  it("pairs the pressing finger's taps into a double tap around a held finger", () => {
    const onDoubleClick = vi.fn<DoubleClickCallback>();
    overlay.onDoubleClick(onDoubleClick);
    const at = { x: 300, y: 300 };

    press(FINGER_A, at, 0);
    downUnreported(FINGER_B, { x: 500, y: 400 });
    upUnreported(FINGER_A, at, 40);
    release(FINGER_B, { x: 500, y: 400 }, 60);
    const second: PointerSpec = { ...FINGER_A, pointerId: 10 };
    press(second, at, 120);
    release(second, at, 160);

    expect(onDoubleClick).toHaveBeenCalledTimes(1);
    const [, , pressSeqs] = onDoubleClick.mock.calls[0]!;
    expect(pressSeqs).toBeDefined();
    expect(pressSeqs![1]).toBe(pressSeqs![0] + 1);
  });

  it('lets a held pointer go when it presses again, should its lift have gone unseen', () => {
    press(FINGER_A, { x: 100, y: 100 });
    press(MOUSE, { x: 500, y: 400 });
    release(FINGER_A, { x: 100, y: 100 });
    // The mouse's release never reached the overlay. Its next press is a
    // gesture: a pointer cannot press without having lifted.
    press(MOUSE, { x: 100, y: 100 });
    move(MOUSE, { x: 160, y: 130 });
    release(MOUSE, { x: 160, y: 130 });

    expect(firedBy('mouse:down', MOUSE)).toBe(1);
    expect({ left: rect.left, top: rect.top }).toEqual({ left: 160, top: 130 });
  });

  it('lets a held mouse go when it hovers, should its lift have gone unseen', () => {
    press(FINGER_A, { x: 100, y: 100 });
    press(MOUSE, { x: 500, y: 400 });
    release(FINGER_A, { x: 100, y: 100 });
    const beforeHover = fired.length;

    // No button down: the mouse has lifted, whatever the overlay saw.
    move(MOUSE, { x: 300, y: 300 }, 0);

    expect(fired.slice(beforeHover).map((f) => f.name)).toEqual(['mouse:move:before']);
  });

  it('forgets held pointers when the mode changes', () => {
    press(FINGER_A, { x: 100, y: 100 });
    press(MOUSE, { x: 500, y: 400 });
    overlay.setMode('navigation');
    overlay.setMode('annotation');
    const before = fired.length;

    move(MOUSE, { x: 300, y: 300 });

    expect(fired.slice(before).map((f) => f.name)).toEqual(['mouse:move:before']);
  });
});
