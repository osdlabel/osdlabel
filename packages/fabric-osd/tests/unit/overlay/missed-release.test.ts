import { describe, it, expect, vi, beforeEach } from 'vitest';
import { FabricOverlay, type OverlayMode } from '../../../src/overlay/fabric-overlay.js';
import {
  POINTER_CANCEL,
  POINTER_DOWN,
  POINTER_MOVE,
  POINTER_UP,
} from '../../../src/overlay/constants.js';

/**
 * OSD's `releaseHandler` fires only when its contact count returns to zero,
 * and never for a `pointercancel`, so a lift while a second finger rests, a
 * second finger landing mid-stroke, and a cancel all left a Fabric gesture —
 * and a brush stroke — open with no release. `preProcessEventHandler` now
 * forwards the release itself in those cases.
 *
 * Exercises the real `_createMouseTracker` handlers: the overlay is built
 * from its prototype with only the fields those handlers read, and
 * OpenSeadragon's `MouseTracker` is mocked to hand back the options object so
 * the handlers can be invoked directly. This is the test the mock-only
 * `input-routing` suite is not.
 */

// jsdom has MouseEvent but no PointerEvent; `_forwardToFabric` constructs one.
class FakePointerEvent extends MouseEvent {
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
vi.stubGlobal('PointerEvent', FakePointerEvent);

interface ProcessInfo {
  eventType: string;
  originalEvent: PointerEvent;
  stopPropagation: boolean;
  preventDefault: boolean;
  preventGesture: boolean;
}
interface CapturedTracker {
  preProcessEventHandler: (info: ProcessInfo) => void;
  pressHandler: (event: { originalEvent: PointerEvent }) => void;
  moveHandler: (event: { originalEvent: PointerEvent }) => void;
  releaseHandler: (event: { originalEvent: PointerEvent }) => void;
}
/** What OSD hands `preProcessEventHandler`, with its defaults. */
function info(eventType: string, originalEvent: PointerEvent): ProcessInfo {
  return {
    eventType,
    originalEvent,
    stopPropagation: false,
    preventDefault: false,
    preventGesture: false,
  };
}
let captured: CapturedTracker | undefined;
/** Contacts OSD still counts for the pointer type at pre-process time. */
let contacts = 1;

vi.mock('openseadragon', () => ({
  default: {
    MouseTracker: class {
      clickTimeThreshold = 300;
      clickDistThreshold = 20;
      constructor(options: CapturedTracker) {
        captured = options;
      }
      setTracking = vi.fn();
      destroy = vi.fn();
      getActivePointersListByType = () => ({ contacts });
    },
  },
}));

function event(type: string, pointerId: number, extra: Partial<PointerEvent> = {}): PointerEvent {
  return {
    type,
    pointerId,
    pointerType: 'touch',
    isPrimary: pointerId === 1,
    clientX: 10,
    clientY: 10,
    screenX: 10,
    screenY: 10,
    button: 0,
    buttons: type === POINTER_UP || type === POINTER_CANCEL ? 0 : 1,
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    shiftKey: false,
    timeStamp: 1000,
    ...extra,
  } as PointerEvent;
}

function overlayInMode(mode: OverlayMode) {
  // The DOM as the overlay builds it: Fabric's upper canvas inside Fabric's
  // container (the tracker's element) inside the viewer canvas. Everything
  // the overlay dispatches is recorded from the parent in the capture phase,
  // which sees a non-bubbling press too; `target` says where each landed.
  const parent = Object.assign(document.createElement('div'), { focus: vi.fn() });
  const container = document.createElement('div');
  const upperCanvas = document.createElement('div');
  parent.appendChild(container);
  container.appendChild(upperCanvas);
  const dispatched: PointerEvent[] = [];
  for (const type of [POINTER_DOWN, POINTER_MOVE, POINTER_UP]) {
    parent.addEventListener(type, (e) => dispatched.push(e as PointerEvent), true);
  }
  const o = Object.create(FabricOverlay.prototype) as FabricOverlay;
  const fields = o as unknown as Record<string, unknown>;
  fields['_mode'] = mode;
  fields['_forwarding'] = false;
  fields['_pendingPress'] = null;
  fields['_palmPointers'] = new Set();
  fields['_lastClick'] = null;
  fields['_panGestureActive'] = false;
  fields['_pressSeq'] = 0;
  fields['_pressSeqByEvent'] = new Map();
  fields['_doubleClickSubscribers'] = new Set();
  fields['_fabricContainer'] = container;
  fields['_fabricCanvas'] = { upperCanvasEl: upperCanvas };
  fields['_viewer'] = { setMouseNavEnabled: vi.fn(), canvas: parent };
  const tracker = (o as unknown as { _createMouseTracker(): unknown })._createMouseTracker();
  fields['_overlayTracker'] = tracker;
  const pending = () => fields['_pendingPress'] as { pointerId: number } | null;
  return { o, dispatched, tracker: captured!, parent, container, upperCanvas, pending };
}

/** A forwarded press, as OSD delivers it: pre-process, then pressHandler. */
function press(t: CapturedTracker, e: PointerEvent): void {
  t.preProcessEventHandler(info(POINTER_DOWN, e));
  t.pressHandler({ originalEvent: e });
}

describe('releases OSD never reports', () => {
  beforeEach(() => {
    captured = undefined;
    contacts = 1;
  });

  it('forwards a release when the pressing finger lifts while another rests', () => {
    const { dispatched, tracker } = overlayInMode('paint');
    press(tracker, event(POINTER_DOWN, 1));
    expect(dispatched.map((e) => e.type)).toEqual([POINTER_DOWN]);

    // Finger 2 is down too; OSD's count stays at one after finger 1 lifts, so
    // its releaseHandler never fires for this lift.
    contacts = 2;
    tracker.preProcessEventHandler(info(POINTER_UP, event(POINTER_UP, 1)));

    expect(dispatched.map((e) => e.type)).toEqual([POINTER_DOWN, POINTER_UP]);
    expect(dispatched[1]!.pointerId).toBe(1);
    expect(dispatched[1]!.isPrimary).toBe(true);
    expect(dispatched[1]!.buttons).toBe(0);
  });

  it('forwards a release for a cancelled pointer, which OSD drops silently', () => {
    const { dispatched, tracker } = overlayInMode('annotation');
    press(tracker, event(POINTER_DOWN, 1));
    tracker.preProcessEventHandler(info(POINTER_CANCEL, event(POINTER_CANCEL, 1)));
    expect(dispatched.map((e) => e.type)).toEqual([POINTER_DOWN, POINTER_UP]);
    expect(dispatched[1]!.pointerId).toBe(1);
  });

  it('does not double the ordinary last-contact release', () => {
    const { dispatched, tracker } = overlayInMode('paint');
    press(tracker, event(POINTER_DOWN, 1));
    // The only contact lifts: OSD's releaseHandler will fire, so pre-process
    // must leave it alone.
    const up = event(POINTER_UP, 1);
    tracker.preProcessEventHandler(info(POINTER_UP, up));
    expect(dispatched.map((e) => e.type)).toEqual([POINTER_DOWN]);
    tracker.releaseHandler({ originalEvent: up });
    expect(dispatched.map((e) => e.type)).toEqual([POINTER_DOWN, POINTER_UP]);
  });

  it('ends the stroke when a second finger lands in paint mode, with the first pointer’s id', () => {
    const { dispatched, tracker } = overlayInMode('paint');
    press(tracker, event(POINTER_DOWN, 1));
    // OSD will not report this press (two contacts) nor finger 1's release
    // while finger 2 rests; the stroke would paint on along the pinch.
    tracker.preProcessEventHandler(
      info(POINTER_DOWN, event(POINTER_DOWN, 2, { isPrimary: false })),
    );
    expect(dispatched.map((e) => e.type)).toEqual([POINTER_DOWN, POINTER_UP]);
    // Carrying finger 1's identity: Fabric acts only on the primary pointer.
    expect(dispatched[1]!.pointerId).toBe(1);
    expect(dispatched[1]!.isPrimary).toBe(true);
  });

  it('leaves a second contact alone for vector tools, whose behaviour predates this', () => {
    const { dispatched, tracker } = overlayInMode('annotation');
    press(tracker, event(POINTER_DOWN, 1));
    tracker.preProcessEventHandler(
      info(POINTER_DOWN, event(POINTER_DOWN, 2, { isPrimary: false })),
    );
    expect(dispatched.map((e) => e.type)).toEqual([POINTER_DOWN]);
  });

  it('never pairs a forwarded release into a double click', () => {
    const { o, dispatched, tracker } = overlayInMode('paint');
    const onDouble = vi.fn();
    o.onDoubleClick(onDouble);
    press(tracker, event(POINTER_DOWN, 1));
    tracker.preProcessEventHandler(info(POINTER_CANCEL, event(POINTER_CANCEL, 1)));
    // A quick, clean tap right after must not read as the second half.
    const down2 = event(POINTER_DOWN, 1, { timeStamp: 1100 });
    const up2 = event(POINTER_UP, 1, { timeStamp: 1150 });
    press(tracker, down2);
    tracker.preProcessEventHandler(info(POINTER_UP, up2));
    tracker.releaseHandler({ originalEvent: up2 });
    expect(onDouble).not.toHaveBeenCalled();
    expect(dispatched.map((e) => e.type)).toEqual([
      POINTER_DOWN,
      POINTER_UP,
      POINTER_DOWN,
      POINTER_UP,
    ]);
  });

  it('dispatches a forwarded release above the tracker element', () => {
    // From `preProcessEventHandler` the real event has not yet reached OSD's
    // bookkeeping, so a copy that bubbled through the tracker's element would
    // remove a live contact; the second finger was then a fresh press.
    const { dispatched, tracker, parent, container } = overlayInMode('paint');
    const throughContainer: Event[] = [];
    container.addEventListener(POINTER_UP, (e) => throughContainer.push(e));
    press(tracker, event(POINTER_DOWN, 1));
    tracker.preProcessEventHandler(
      info(POINTER_DOWN, event(POINTER_DOWN, 2, { isPrimary: false })),
    );

    expect(dispatched.map((e) => e.type)).toEqual([POINTER_DOWN, POINTER_UP]);
    expect(dispatched[1]!.target).toBe(parent);
    expect(throughContainer).toHaveLength(0);
  });

  it('reports the primary button on a release revealed by another event', () => {
    // Fabric drops a `pointerup` with any other `button`; a cancel need not
    // carry 0, and the move that ends a chord carries the button still held.
    const { dispatched, tracker } = overlayInMode('paint');
    press(tracker, event(POINTER_DOWN, 1));
    tracker.preProcessEventHandler(info(POINTER_CANCEL, event(POINTER_CANCEL, 1, { button: 2 })));
    expect(dispatched[1]!.type).toBe(POINTER_UP);
    expect(dispatched[1]!.button).toBe(0);
  });

  it('swallows a contact of another pointer type while a press is held', () => {
    // OSD keeps one contact list per type, so a palm resting beside a pen is
    // a fresh first press to it: it would forward a primary `pointerdown`
    // that Fabric acts on, and then the palm's release. Neither may reach
    // Fabric, and the pen's own release must still arrive as usual.
    const { dispatched, tracker, pending } = overlayInMode('paint');
    const pen = (type: string, extra: Partial<PointerEvent> = {}) =>
      event(type, 5, { pointerType: 'pen', isPrimary: true, ...extra });
    const palm = (type: string) =>
      event(type, 7, {
        pointerType: 'touch',
        isPrimary: true,
        buttons: type === POINTER_UP ? 0 : 1,
      });
    press(tracker, pen(POINTER_DOWN));

    const palmDown = info(POINTER_DOWN, palm(POINTER_DOWN));
    tracker.preProcessEventHandler(palmDown);
    expect(palmDown.preventGesture).toBe(true);
    expect(palmDown.stopPropagation).toBe(true);
    tracker.pressHandler({ originalEvent: palm(POINTER_DOWN) });

    const palmMove = info(POINTER_MOVE, palm(POINTER_MOVE));
    tracker.preProcessEventHandler(palmMove);
    expect(palmMove.preventGesture).toBe(true);
    // OSD's move handler is not silenced by `preventGesture`.
    tracker.moveHandler({ originalEvent: palm(POINTER_MOVE) });

    const palmUp = info(POINTER_UP, palm(POINTER_UP));
    tracker.preProcessEventHandler(palmUp);
    expect(palmUp.preventGesture).toBe(true);
    expect(pending()?.pointerId).toBe(5);

    const penUp = pen(POINTER_UP, { buttons: 0 });
    tracker.preProcessEventHandler(info(POINTER_UP, penUp));
    tracker.releaseHandler({ originalEvent: penUp });

    expect(dispatched.map((e) => [e.type, e.pointerId])).toEqual([
      [POINTER_DOWN, 5],
      [POINTER_UP, 5],
    ]);
    expect(pending()).toBeNull();
  });

  it('ends a press whose primary button released inside a chord', () => {
    // Left down, right down, left up, right up: the left release is a move
    // with the primary bit clear, and the final `pointerup` names the right
    // button, which OSD ignores, so no release would ever be reported.
    const { dispatched, tracker, pending } = overlayInMode('paint');
    const mouse = (type: string, buttons: number, button = 0) =>
      event(type, 1, { pointerType: 'mouse', buttons, button });
    press(tracker, mouse(POINTER_DOWN, 1));
    tracker.preProcessEventHandler(info(POINTER_MOVE, mouse(POINTER_MOVE, 3)));
    expect(dispatched.map((e) => e.type)).toEqual([POINTER_DOWN]);

    tracker.preProcessEventHandler(info(POINTER_MOVE, mouse(POINTER_MOVE, 2)));
    expect(dispatched.map((e) => e.type)).toEqual([POINTER_DOWN, POINTER_UP]);
    expect(dispatched[1]!.button).toBe(0);
    expect(pending()).toBeNull();

    tracker.preProcessEventHandler(info(POINTER_UP, mouse(POINTER_UP, 0, 2)));
    expect(dispatched.map((e) => e.type)).toEqual([POINTER_DOWN, POINTER_UP]);
  });

  it('leaves a touch move with the primary bit clear alone', () => {
    // A touch contact reports `buttons: 1` for its whole life in every
    // current engine; the chord rule is for devices that have buttons.
    const { dispatched, tracker } = overlayInMode('paint');
    press(tracker, event(POINTER_DOWN, 1));
    tracker.preProcessEventHandler(info(POINTER_MOVE, event(POINTER_MOVE, 1, { buttons: 0 })));
    expect(dispatched.map((e) => e.type)).toEqual([POINTER_DOWN]);
  });

  it("does not consume the pending press on another pointer's release", () => {
    const { tracker, pending } = overlayInMode('annotation');
    press(tracker, event(POINTER_DOWN, 1));
    tracker.releaseHandler({ originalEvent: event(POINTER_UP, 2, { isPrimary: false }) });
    expect(pending()?.pointerId).toBe(1);
    tracker.releaseHandler({ originalEvent: event(POINTER_UP, 1) });
    expect(pending()).toBeNull();
  });
});
