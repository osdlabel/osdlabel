import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { FabricOverlay } from '../../../src/overlay/fabric-overlay.js';
import { createTestViewer, installPointerEventPolyfill, type TestViewer } from './test-viewer.js';

/**
 * Which synthetic events bubble, and why it matters (issue #175).
 *
 * `_forwardToFabric` dispatches a synthetic `PointerEvent`: the press
 * non-bubbling and the move bubbling, both on Fabric's upper canvas, and the
 * release bubbling from the container's parent so that it never passes
 * through the tracker's element. Getting any of that wrong breaks input in
 * ways that are slow and awkward to see: the whole behaviour lives in
 * `apps/dev/tests/e2e/touch-input.spec.ts`, which needs a browser this
 * package's tests do not have.
 *
 * This pins the one line those E2E tests turn on, in milliseconds, so a change
 * to it fails here first.
 */
interface OverlayInternals {
  // Mirrors the source signature rather than just the types exercised below:
  // `pointercancel` is forwarded by the same method, and a narrower type here
  // would quietly outlive the reason it was narrowed.
  _forwardToFabric(
    type: 'pointerdown' | 'pointermove' | 'pointerup' | 'pointercancel',
    event: PointerEvent,
    pressSeq?: number,
  ): void;
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

describe('synthetic event forwarding', () => {
  let tv: TestViewer;
  let overlay: FabricOverlay;
  let dispatched: PointerEvent[];
  let restorePointerEvent: () => void;

  beforeEach(() => {
    restorePointerEvent = installPointerEventPolyfill();
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
    restorePointerEvent();
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
   * The press sequence is stamped on the event the *tool* sees — the synthetic
   * one — and only for presses (#176). Keying the original event instead would
   * make every `pressSeqOf` lookup return undefined, and stamping moves or
   * releases would hand a tool a number for an event that placed nothing.
   */
  it('stamps the forwarded press, and only the press', () => {
    const originalPress = pointerEvent('pointerdown');
    internals(overlay)._forwardToFabric('pointerdown', originalPress, 42);
    internals(overlay)._forwardToFabric('pointermove', pointerEvent('pointermove'));

    expect(dispatched).toHaveLength(2);
    const [syntheticPress, syntheticMove] = dispatched;
    expect(overlay.pressSeqOf(syntheticPress!)).toBe(42);
    // The move carries no sequence...
    expect(overlay.pressSeqOf(syntheticMove!)).toBeUndefined();
    // ...and neither does the original the overlay received, which is not the
    // object any tool is handed.
    expect(overlay.pressSeqOf(originalPress)).toBeUndefined();
  });

  /**
   * The move must bubble. Fabric relocates `pointermove` to the *document*
   * once a press lands, so a non-bubbling copy reaches it only between
   * presses. A bubbled move re-enters the tracker's element, but only updates
   * a position OSD already has.
   */
  it('dispatches the move bubbling, from the upper canvas', () => {
    internals(overlay)._forwardToFabric('pointermove', pointerEvent('pointermove'));

    expect(dispatched).toHaveLength(1);
    expect(dispatched[0]!.type).toBe('pointermove');
    expect(dispatched[0]!.bubbles).toBe(true);
  });

  /**
   * The release must reach the document, where Fabric binds `pointerup`,
   * without passing through the tracker's element on the way: OSD removes a
   * contact for a bubbled `pointerup` before honouring `stopPropagation`, and
   * `_endPendingPress` forwards one from `preProcessEventHandler`, *before*
   * OSD has processed the real event, so a bubbled copy took a live contact
   * with it and the second finger was then reported as a fresh press. It is
   * dispatched on the container's parent, the viewer canvas, whose own OSD
   * tracker is disabled in every mode that forwards.
   */
  it('dispatches the release above the tracker element, bubbling', () => {
    const fabricContainer = (overlay as unknown as { _fabricContainer: HTMLElement })
      ._fabricContainer;
    const seenByContainer: Event[] = [];
    const seenByParent: Event[] = [];
    fabricContainer.addEventListener('pointerup', (e) => seenByContainer.push(e));
    tv.container.addEventListener('pointerup', (e) => seenByParent.push(e));

    internals(overlay)._forwardToFabric('pointerup', pointerEvent('pointerup'));

    expect(dispatched).toHaveLength(0);
    expect(seenByContainer).toHaveLength(0);
    expect(seenByParent).toHaveLength(1);
    expect(seenByParent[0]!.target).toBe(tv.container);
    expect(seenByParent[0]!.bubbles).toBe(true);
  });

  /**
   * Fabric drops a `pointerup` whose `button` is not the primary one, and the
   * event that reveals a lost release — a cancel, the move that ends a chord —
   * need not carry 0 itself.
   */
  it('reports the primary button on every forwarded release', () => {
    const seen: PointerEvent[] = [];
    tv.container.addEventListener('pointerup', (e) => seen.push(e as PointerEvent));

    internals(overlay)._forwardToFabric('pointerup', { ...pointerEvent('pointerup'), button: 2 });

    expect(seen).toHaveLength(1);
    expect(seen[0]!.button).toBe(0);
    expect(seen[0]!.buttons).toBe(0);
  });
});
