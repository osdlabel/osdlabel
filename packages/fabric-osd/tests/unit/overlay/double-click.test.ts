import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FabricOverlay } from '../../../src/overlay/fabric-overlay.js';
import type { DoubleClickCallback } from '../../../src/overlay/fabric-overlay.js';
import { createTestViewer, type TestViewer } from './test-viewer.js';

/**
 * Double-click detection (issue #168).
 *
 * The gesture itself is driven end to end in `apps/dev/tests/e2e/` — that is
 * the only honest test of the wiring. Covered here is the pairing logic, which
 * needs timings and modifier combinations impractical to stage in a browser.
 *
 * `_recordPress` / `_detectDoubleClick` are reached into deliberately: driving
 * them through the real MouseTracker would mean reimplementing OSD's gesture
 * bookkeeping in the test, which is what made the old `input-routing.test.ts`
 * worthless (#162).
 */
interface OverlayInternals {
  _recordPress(event: PointerEvent): void;
  _detectDoubleClick(event: PointerEvent): void;
}

const internals = (overlay: FabricOverlay): OverlayInternals =>
  overlay as unknown as OverlayInternals;

/** Positions go through this so `{ x, y }` cannot be spread into an event that
 *  reads `clientX` / `clientY` and silently land at the origin. */
const at = (p: { x: number; y: number }) => ({ clientX: p.x, clientY: p.y });

/** The only fields the detector reads. Named so `click`'s `extra` can be typed
 *  too — a bare `{}` there would silently accept a mistyped `pointerid`. */
type PointerEventOverrides = Partial<{
  timeStamp: number;
  clientX: number;
  clientY: number;
  pointerId: number;
  pointerType: string;
  ctrlKey: boolean;
  metaKey: boolean;
}>;

/** A pointer event carrying only what the detector reads. */
function pointerEvent(overrides: PointerEventOverrides = {}): PointerEvent {
  return {
    timeStamp: 0,
    clientX: 0,
    clientY: 0,
    pointerId: 1,
    pointerType: 'mouse',
    ctrlKey: false,
    metaKey: false,
    ...overrides,
  } as PointerEvent;
}

describe('FabricOverlay double-click detection', () => {
  let tv: TestViewer;
  let overlay: FabricOverlay;
  let onDoubleClick: ReturnType<typeof vi.fn<DoubleClickCallback>>;

  beforeEach(() => {
    tv = createTestViewer();
    overlay = new FabricOverlay(tv.viewer);
    overlay.setMode('annotation');
    onDoubleClick = vi.fn<DoubleClickCallback>();
    overlay.onDoubleClick(onDoubleClick);
  });

  afterEach(() => {
    overlay.destroy();
    tv.cleanup();
  });

  /** One press-and-release at a position and time, as the handlers deliver it. */
  function click(
    position: { x: number; y: number },
    time: number,
    extra: PointerEventOverrides = {},
  ): void {
    const common = { ...at(position), ...extra };
    internals(overlay)._recordPress(pointerEvent({ ...common, timeStamp: time }));
    internals(overlay)._detectDoubleClick(pointerEvent({ ...common, timeStamp: time + 10 }));
  }

  const ORIGIN = { x: 100, y: 100 };

  it('fires on two quick clicks in the same place', () => {
    click(ORIGIN, 0);
    expect(onDoubleClick).not.toHaveBeenCalled();
    click(ORIGIN, 100);
    expect(onDoubleClick).toHaveBeenCalledTimes(1);
  });

  it('reports the image point the second click landed on', () => {
    // Offset inside the 20px pair threshold, so the two positions differ and
    // reporting the *first* click's would fail. Identical positions would let
    // a stale-point regression pass.
    const second = { x: ORIGIN.x + 15, y: ORIGIN.y + 8 };
    click(ORIGIN, 0);
    click(second, 100);

    expect(onDoubleClick).toHaveBeenCalledTimes(1);
    const [, imagePoint] = onDoubleClick.mock.calls[0]!;
    // The stub viewer maps element coordinates through unchanged.
    expect(imagePoint).toEqual({ x: second.x, y: second.y });
  });

  it('does not fire when the clicks are too far apart in time', () => {
    click(ORIGIN, 0);
    // dblClickTimeThreshold is 300ms.
    click(ORIGIN, 400);
    expect(onDoubleClick).not.toHaveBeenCalled();
  });

  it('does not fire when the clicks are too far apart in space', () => {
    click(ORIGIN, 0);
    // dblClickDistThreshold is 20px.
    click({ x: ORIGIN.x + 50, y: ORIGIN.y }, 100);
    expect(onDoubleClick).not.toHaveBeenCalled();
  });

  it('does not treat a press-drag-release as a click', () => {
    // Released well beyond clickDistThreshold (5px) of its own press: a drag,
    // not a click, so it can neither pair nor be paired with.
    const releasedAt = { x: ORIGIN.x + 60, y: ORIGIN.y };
    internals(overlay)._recordPress(pointerEvent({ ...at(ORIGIN), timeStamp: 0 }));
    internals(overlay)._detectDoubleClick(pointerEvent({ ...at(releasedAt), timeStamp: 50 }));

    // The follow-up must land where the drag *released*, not where it began:
    // if the release had been counted as a click, this would pair with it.
    click(releasedAt, 100);
    expect(onDoubleClick).not.toHaveBeenCalled();
  });

  it('ignores a release that had no press of its own', () => {
    // Pressed over another element and released over us: OSD still reports the
    // release, but it is not a click here. The follow-up click is in the same
    // place, so the only thing stopping a pair is the missing press.
    internals(overlay)._detectDoubleClick(pointerEvent({ ...at(ORIGIN), timeStamp: 0 }));
    click(ORIGIN, 100);
    expect(onDoubleClick).not.toHaveBeenCalled();
  });

  it('does not treat a slow press-and-hold as a click', () => {
    // Released in place, but well beyond clickTimeThreshold (300ms) of its own
    // press. Separate from the drag case above: that one moves, this one waits.
    internals(overlay)._recordPress(pointerEvent({ ...at(ORIGIN), timeStamp: 0 }));
    internals(overlay)._detectDoubleClick(pointerEvent({ ...at(ORIGIN), timeStamp: 500 }));

    click(ORIGIN, 600);
    expect(onDoubleClick).not.toHaveBeenCalled();
  });

  it("does not pair a release with another pointer's press", () => {
    // Same pointerType, so this isolates the pointerId match. Defensive rather
    // than routine — a mouse keeps one id, and multi-touch cannot reach here
    // (see the pointer-type test) — but it is what stops a release consuming a
    // press that was not its own.
    internals(overlay)._recordPress(pointerEvent({ ...at(ORIGIN), timeStamp: 0, pointerId: 1 }));
    internals(overlay)._detectDoubleClick(
      pointerEvent({ ...at(ORIGIN), timeStamp: 10, pointerId: 2 }),
    );

    click(ORIGIN, 100, { pointerId: 1 });
    expect(onDoubleClick).not.toHaveBeenCalled();
  });

  it('does not pair clicks from different pointer types', () => {
    // Mouse and pen, not touch: touch cannot reach this layer at all (#175),
    // so pairing with it would assert an impossible sequence.
    click(ORIGIN, 0, { pointerId: 1, pointerType: 'mouse' });
    click(ORIGIN, 100, { pointerId: 2, pointerType: 'pen' });
    expect(onDoubleClick).not.toHaveBeenCalled();
  });

  it('ignores Ctrl/Cmd clicks, which are the pan pass-through trigger', () => {
    click(ORIGIN, 0, { ctrlKey: true });
    click(ORIGIN, 100, { ctrlKey: true });
    expect(onDoubleClick).not.toHaveBeenCalled();

    click(ORIGIN, 200, { metaKey: true });
    click(ORIGIN, 300, { metaKey: true });
    expect(onDoubleClick).not.toHaveBeenCalled();
  });

  it('consumes the pair, so a triple click fires once', () => {
    click(ORIGIN, 0);
    click(ORIGIN, 100);
    click(ORIGIN, 200);
    expect(onDoubleClick).toHaveBeenCalledTimes(1);
  });

  it('does not pair across a mode change', () => {
    click(ORIGIN, 0);
    // Round-tripping through navigation discards the first click, so the user
    // does not resume into a half-finished gesture.
    overlay.setMode('navigation');
    overlay.setMode('annotation');
    click(ORIGIN, 100);
    expect(onDoubleClick).not.toHaveBeenCalled();
  });

  it('does not pair across a resubscribe, which is how a tool switch reaches us', () => {
    // The framework hooks tear down and resubscribe on every tool change, and
    // that stays inside annotation mode — so `setMode`'s reset never runs.
    click(ORIGIN, 0);
    overlay.onDoubleClick(vi.fn<DoubleClickCallback>());
    click(ORIGIN, 100);
    expect(onDoubleClick).not.toHaveBeenCalled();
  });

  it('pairs normally for a subscriber added after earlier clicks', () => {
    const bareViewer = createTestViewer();
    const bare = new FabricOverlay(bareViewer.viewer);
    bare.setMode('annotation');
    const late = vi.fn<DoubleClickCallback>();

    // The earlier click must not carry over (the resubscribe reset above), but
    // the empty-subscriber early return must not leave detection wedged either.
    internals(bare)._recordPress(pointerEvent({ ...at(ORIGIN), timeStamp: 0 }));
    internals(bare)._detectDoubleClick(pointerEvent({ ...at(ORIGIN), timeStamp: 10 }));
    bare.onDoubleClick(late);

    internals(bare)._recordPress(pointerEvent({ ...at(ORIGIN), timeStamp: 100 }));
    internals(bare)._detectDoubleClick(pointerEvent({ ...at(ORIGIN), timeStamp: 110 }));
    expect(late).not.toHaveBeenCalled();

    internals(bare)._recordPress(pointerEvent({ ...at(ORIGIN), timeStamp: 200 }));
    internals(bare)._detectDoubleClick(pointerEvent({ ...at(ORIGIN), timeStamp: 210 }));
    expect(late).toHaveBeenCalledTimes(1);

    bare.destroy();
    bareViewer.cleanup();
  });

  it('does not deliver to a subscriber registered during the same dispatch', () => {
    // Finishing a shape can hit a context limit and switch tool synchronously,
    // tearing the subscription down and back up inside the callback.
    const late = vi.fn<DoubleClickCallback>();
    overlay.onDoubleClick(() => {
      overlay.onDoubleClick(late);
    });

    click(ORIGIN, 0);
    click(ORIGIN, 100);

    expect(onDoubleClick).toHaveBeenCalledTimes(1);
    // The gesture belongs to the tool that was active when it happened.
    expect(late).not.toHaveBeenCalled();

    // …but the new subscriber is registered, and gets the next one.
    click(ORIGIN, 1000);
    click(ORIGIN, 1100);
    expect(late).toHaveBeenCalledTimes(1);
  });

  it('does not deliver to a subscriber removed during the same dispatch', () => {
    // The remover must be registered BEFORE its target, so the target is in the
    // snapshot when it is unsubscribed but is reached afterwards. `destroy()`
    // clears the whole set the same way.
    const second = vi.fn<DoubleClickCallback>();
    let unsubscribeSecond = (): void => {};
    overlay.onDoubleClick(() => {
      unsubscribeSecond();
    });
    unsubscribeSecond = overlay.onDoubleClick(second);

    click(ORIGIN, 0);
    click(ORIGIN, 100);

    // Snapshotting the set to survive additions must not resurrect removals.
    expect(second).not.toHaveBeenCalled();
    // Positive control: the gesture really was dispatched.
    expect(onDoubleClick).toHaveBeenCalledTimes(1);
  });

  it('stops delivering after unsubscribe, leaving other subscribers intact', () => {
    const second = vi.fn<DoubleClickCallback>();
    const unsubscribe = overlay.onDoubleClick(second);
    unsubscribe();

    click(ORIGIN, 0);
    click(ORIGIN, 100);

    expect(second).not.toHaveBeenCalled();
    // The subscriber registered in beforeEach is untouched, so the assertion
    // above is about the unsubscribe and not about detection having stopped.
    expect(onDoubleClick).toHaveBeenCalledTimes(1);
  });
});
