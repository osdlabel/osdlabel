import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Control, Point, Polygon, Rect, controlsUtils, util } from 'fabric';
import type { FabricObject, TPointerEvent, Transform } from 'fabric';
import { FabricOverlay } from '../../../src/overlay/fabric-overlay.js';
import type {
  DoubleClickCallback,
  PointerCancelCallback,
} from '../../../src/overlay/fabric-overlay.js';
import { createTestViewer, installPointerEventPolyfill, type TestViewer } from './test-viewer.js';

/**
 * A press the platform cancels (`pointercancel`) is undone (the audit's sweep
 * finding 1).
 *
 * OSD's MouseTracker answers `pointercancel` with `stopTrackingPointer` and
 * never calls `releaseHandler`, so the overlay used to forward nothing: Fabric
 * kept its transform open, the object stayed where the finger left it while
 * the host's state kept it where it was, and the next movement of any pointer
 * carried it on. The gesture end to end, through a real `pointercancel`, is in
 * `apps/dev/tests/e2e/touch-cancel.spec.ts`; this pins the overlay's half in
 * isolation, against a real Fabric canvas.
 *
 * The tracker's handlers are driven directly, as `double-click.test.ts` does:
 * OSD binds mouse events rather than pointer events under jsdom (there is no
 * `PointerEvent` when it loads), so a dispatched `pointercancel` would never
 * reach it. `preProcessEventHandler` is where OSD hands the overlay a cancel.
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

const PRESSING = 7;

/** A touch pointer event at `at`, as the browser delivers it. */
function touchEvent(
  type: string,
  at: { x: number; y: number },
  extra: Partial<PointerEventInit> = {},
): PointerEvent {
  return new PointerEvent(type, {
    clientX: at.x,
    clientY: at.y,
    pointerId: PRESSING,
    pointerType: 'touch',
    isPrimary: true,
    button: 0,
    buttons: type === 'pointerup' ? 0 : 1,
    bubbles: true,
    cancelable: true,
    ...extra,
  });
}

/**
 * Chrome's `pointercancel`: `button` -1, `buttons` 0, at the last position the
 * pointer reached. `button` -1 is truthy, which is what makes Fabric's
 * `__onMouseUp` return early, so a release copied from this event would not
 * end Fabric's gesture.
 */
function cancelEvent(at: { x: number; y: number }, pointerId = PRESSING): PointerEvent {
  return touchEvent('pointercancel', at, { button: -1, buttons: 0, pointerId });
}

describe('FabricOverlay: a cancelled press is undone', () => {
  let tv: TestViewer;
  let overlay: FabricOverlay;
  let rect: Rect;
  let restorePointerEvent: () => void;
  let modified: ReturnType<typeof vi.fn<(e: { target: FabricObject }) => void>>;

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
  });

  afterEach(() => {
    overlay.destroy();
    tv.cleanup();
    restorePointerEvent();
  });

  const press = (at: { x: number; y: number }, pointerId = PRESSING): void =>
    tracker(overlay).pressHandler({ originalEvent: touchEvent('pointerdown', at, { pointerId }) });
  const move = (at: { x: number; y: number }): void =>
    tracker(overlay).moveHandler({ originalEvent: touchEvent('pointermove', at) });
  const release = (at: { x: number; y: number }): void =>
    tracker(overlay).releaseHandler({ originalEvent: touchEvent('pointerup', at) });
  const cancel = (at: { x: number; y: number }, pointerId = PRESSING): EventProcessInfo => {
    const info: EventProcessInfo = {
      eventType: 'pointercancel',
      originalEvent: cancelEvent(at, pointerId),
    };
    tracker(overlay).preProcessEventHandler(info);
    return info;
  };

  /** Where the selected object's control `key` is, in canvas px. */
  const controlAt = (object: FabricObject, key: string): { x: number; y: number } => {
    overlay.canvas.setActiveObject(object);
    object.setCoords();
    const at = object.oCoords[key];
    expect(at, `no ${key} control`).toBeDefined();
    return { x: at!.x, y: at!.y };
  };

  const placement = (object: FabricObject) => ({
    left: object.left,
    top: object.top,
    scaleX: object.scaleX,
    scaleY: object.scaleY,
    skewX: object.skewX,
    skewY: object.skewY,
    angle: object.angle,
    flipX: object.flipX,
    flipY: object.flipY,
  });

  const transformOpen = (): boolean => overlay.canvas._currentTransform !== null;

  it('puts a dragged object back where it was at the press, and commits nothing', () => {
    const atPress = placement(rect);
    press({ x: 100, y: 100 });
    move({ x: 130, y: 120 });
    move({ x: 160, y: 140 });
    // The drag reached Fabric, so there is something to undo.
    expect(rect.left).toBe(160);

    cancel({ x: 160, y: 140 });

    expect(placement(rect)).toEqual(atPress);
    expect(transformOpen(), 'the transform is still open').toBe(false);
    expect(modified).not.toHaveBeenCalled();
    // The object's own origin is untouched: Fabric's `original` records the
    // transform's anchor under `originX` / `originY`, not the object's.
    expect(rect.originX).toBe('center');
    expect(rect.originY).toBe('center');
  });

  it.each([
    ['resize', 'br', { x: 40, y: 30 }],
    ['rotation', 'mtr', { x: 60, y: 10 }],
  ] as const)('puts a cancelled %s back', (_name, control, by) => {
    const from = controlAt(rect, control);
    const atPress = placement(rect);
    press(from);
    move({ x: from.x + by.x / 2, y: from.y + by.y / 2 });
    move({ x: from.x + by.x, y: from.y + by.y });
    expect(placement(rect)).not.toEqual(atPress);

    cancel({ x: from.x + by.x, y: from.y + by.y });

    expect(placement(rect)).toEqual(atPress);
    expect(transformOpen()).toBe(false);
    expect(modified).not.toHaveBeenCalled();
  });

  describe('a polygon whose points the gesture changed', () => {
    const square = [
      { x: 200, y: 200 },
      { x: 260, y: 200 },
      { x: 260, y: 260 },
      { x: 200, y: 260 },
    ];
    let poly: Polygon;

    beforeEach(() => {
      poly = new Polygon(
        square.map((p) => new Point(p.x, p.y)),
        { id: 'ann-2' },
      );
      poly.controls = controlsUtils.createPolyControls(poly);
      overlay.canvas.add(poly);
    });

    const shape = (p: Polygon) => ({
      points: p.points.map(({ x, y }) => ({ x, y })),
      width: p.width,
      height: p.height,
      pathOffset: { x: p.pathOffset.x, y: p.pathOffset.y },
      ...placement(p),
    });

    it('restores the points a vertex drag moved', () => {
      const from = controlAt(poly, 'p1');
      const atPress = shape(poly);
      press(from);
      move({ x: from.x + 20, y: from.y - 15 });
      move({ x: from.x + 40, y: from.y - 30 });
      expect(shape(poly).points).not.toEqual(atPress.points);

      cancel({ x: from.x + 40, y: from.y - 30 });

      expect(shape(poly)).toEqual(atPress);
      expect(transformOpen()).toBe(false);
      expect(modified).not.toHaveBeenCalled();
    });

    /**
     * The vertex editor's insert handle splices its vertex in the control's
     * `mouseDownHandler`, which runs after Fabric sets the transform up but
     * before any move, and rebuilds its handles for the new vertex. Two
     * things follow, and these controls copy the editor's mechanics to pin
     * both: the points must be recorded before the handler runs, or the
     * revert keeps the inserted vertex; and nothing may place the handles
     * between the points going back and the subscribers rebuilding them,
     * since each reads `points` directly and the last would read past the end.
     */
    it('restores points the press itself added, before the handles are rebuilt', () => {
      const edgeHandles = (p: Polygon): Record<string, Control> => {
        const handles: Record<string, Control> = {};
        p.points.forEach((_, i) => {
          const ends = (q: Polygon) => [q.points[i]!, q.points[(i + 1) % q.points.length]!];
          handles[`ins${i}`] = new Control({
            actionName: 'insertPoint',
            positionHandler: (_dim, _matrix, object) => {
              const q = object as Polygon;
              const [a, b] = ends(q);
              return new Point((a!.x + b!.x) / 2, (a!.y + b!.y) / 2)
                .subtract(q.pathOffset)
                .transform(
                  util.multiplyTransformMatrices(q.getViewportTransform(), q.calcTransformMatrix()),
                );
            },
            mouseDownHandler: (_e: TPointerEvent, transform: Transform) => {
              const q = transform.target as Polygon;
              const [a, b] = ends(q);
              q.points.splice(i + 1, 0, new Point((a!.x + b!.x) / 2, (a!.y + b!.y) / 2));
              q.setDimensions();
              q.controls = edgeHandles(q);
              q.setCoords();
              return true;
            },
            actionHandler: () => false,
          });
        });
        return handles;
      };
      poly.controls = edgeHandles(poly);
      // What the editor does when its tool hears of the cancel.
      overlay.onPointerCancel(() => {
        poly.controls = edgeHandles(poly);
      });
      const from = controlAt(poly, 'ins0');
      const atPress = shape(poly);
      press(from);
      expect(poly.points).toHaveLength(5);

      cancel(from);

      expect(shape(poly)).toEqual(atPress);
      expect(Object.keys(poly.controls)).toHaveLength(4);
      expect(transformOpen()).toBe(false);
    });
  });

  it('ends the gesture: a later press elsewhere does not carry the object off', () => {
    const atPress = placement(rect);
    press({ x: 100, y: 100 });
    move({ x: 140, y: 130 });
    cancel({ x: 140, y: 130 });

    // A hover, then a drag on empty canvas, released normally. While the
    // transform was left open, the first move dragged the object after it and
    // the release committed it there.
    move({ x: 300, y: 300 });
    press({ x: 300, y: 300 });
    move({ x: 340, y: 320 });
    release({ x: 340, y: 320 });

    expect(placement(rect)).toEqual(atPress);
    expect(modified).not.toHaveBeenCalled();
  });

  it('drops a rubber-band selection the cancel interrupted, then and later', () => {
    // Annotation mode alone leaves drag-box selection off; SelectTool turns it
    // on while it is the active tool.
    overlay.canvas.selection = true;
    press({ x: 20, y: 20 });
    move({ x: 120, y: 120 });
    move({ x: 200, y: 200 });

    cancel({ x: 200, y: 200 });
    // Fabric applies a rubber band on release; a later one must not either.
    release({ x: 200, y: 200 });

    expect(overlay.canvas.getActiveObject()).toBeUndefined();
    // The overlay suppresses the band by lowering `selection` for the release
    // it forwards; the select tool's value must be back afterwards.
    expect(overlay.canvas.selection).toBe(true);
  });

  it('tells subscribers, with the press sequence, before Fabric sees the release', () => {
    const order: string[] = [];
    const onCancel = vi.fn<PointerCancelCallback>(() => {
      order.push('cancel');
    });
    overlay.onPointerCancel(onCancel);
    let syntheticPress: PointerEvent | undefined;
    overlay.canvas.on('mouse:down', (opt) => {
      syntheticPress = opt.e as PointerEvent;
    });
    overlay.canvas.on('mouse:up', () => {
      order.push('mouse:up');
    });

    press({ x: 100, y: 100 });
    move({ x: 120, y: 110 });
    const info = cancel({ x: 120, y: 110 });

    expect(onCancel).toHaveBeenCalledTimes(1);
    const [event, pressSeq] = onCancel.mock.calls[0]!;
    expect(event).toBe(info.originalEvent);
    expect(syntheticPress).toBeDefined();
    expect(pressSeq).toBe(overlay.pressSeqOf(syntheticPress!));
    // A drawing tool commits its preview on `mouse:up`, so it must have
    // cancelled before Fabric's own end of the gesture reaches it.
    expect(order).toEqual(['cancel', 'mouse:up']);
    // OSD and the page must not see the cancel either, as for any other
    // event the overlay owns.
    expect(info.stopPropagation).toBe(true);
  });

  it('in paint mode too: subscribers first, then a release marked cancelled that commits nothing', () => {
    // The brush paints in paint mode, where every object is inert: there is
    // no transform to revert, but the tool must hear of the cancel before the
    // release, which it would otherwise commit, and the release is marked.
    overlay.setMode('paint');
    const order: string[] = [];
    overlay.onPointerCancel(() => {
      order.push('cancel');
    });
    const releases: PointerEvent[] = [];
    overlay.canvas.on('mouse:up', (opt) => {
      order.push('mouse:up');
      releases.push(opt.e as PointerEvent);
    });

    press({ x: 100, y: 100 });
    move({ x: 120, y: 110 });
    cancel({ x: 120, y: 110 });

    expect(order).toEqual(['cancel', 'mouse:up']);
    expect(releases).toHaveLength(1);
    expect(overlay.isCancelledRelease(releases[0]!)).toBe(true);
    expect(modified).not.toHaveBeenCalled();
  });

  /**
   * On an iPad the hand often rests before the pencil lands, and the platform
   * has not always cancelled it by then. A pen pressing while a touch press is
   * held reveals the touch as the palm: its press is undone as a cancel would
   * undo it, and the pen's press goes through. A mouse beside a touch has no
   * such claim, and is held like any other second pointer.
   */
  describe('another pointer type pressing while a touch press is held', () => {
    interface ProcessInfo extends EventProcessInfo {
      preventGesture?: boolean;
    }
    const otherPress = (pointerType: 'pen' | 'mouse', at: { x: number; y: number }) => {
      const e = touchEvent('pointerdown', at, { pointerId: 3, pointerType });
      const info: ProcessInfo = { eventType: 'pointerdown', originalEvent: e };
      tracker(overlay).preProcessEventHandler(info);
      // OSD calls pressHandler for it either way: it is the first of its type.
      // With `preventGesture` set it would not; the overlay's belt holds too.
      if (info.preventGesture !== true) tracker(overlay).pressHandler({ originalEvent: e });
      return { e, info };
    };
    const palmMove = (at: { x: number; y: number }): void => {
      const e = touchEvent('pointermove', at);
      tracker(overlay).preProcessEventHandler({ eventType: 'pointermove', originalEvent: e });
      tracker(overlay).moveHandler({ originalEvent: e });
    };

    it("a pen undoes the touch's press as a palm, tells subscribers with its own press, and goes through", () => {
      const atPress = placement(rect);
      const onCancel = vi.fn<PointerCancelCallback>();
      overlay.onPointerCancel(onCancel);
      const downs: PointerEvent[] = [];
      const ups: PointerEvent[] = [];
      overlay.canvas.on('mouse:down', (opt) => {
        downs.push(opt.e as PointerEvent);
      });
      overlay.canvas.on('mouse:up', (opt) => {
        ups.push(opt.e as PointerEvent);
      });

      press({ x: 100, y: 100 });
      move({ x: 130, y: 120 });
      expect(rect.left).toBe(130);

      const { e, info } = otherPress('pen', { x: 300, y: 300 });

      expect(placement(rect)).toEqual(atPress);
      expect(modified).not.toHaveBeenCalled();
      expect(onCancel).toHaveBeenCalledTimes(1);
      const [event, pressSeq] = onCancel.mock.calls[0]!;
      expect(event).toBe(e);
      expect(pressSeq).toBe(overlay.pressSeqOf(downs[0]!));
      expect(ups).toHaveLength(1);
      expect(overlay.isCancelledRelease(ups[0]!)).toBe(true);
      expect(info.preventGesture).not.toBe(true);
      expect(downs.map((d) => d.pointerType)).toEqual(['touch', 'pen']);

      // The rest of the palm is held: its moves carry nothing.
      palmMove({ x: 160, y: 140 });
      expect(placement(rect)).toEqual(atPress);
    });

    it('a mouse is held, and the touch keeps its gesture to its own lift', () => {
      const onCancel = vi.fn<PointerCancelCallback>();
      overlay.onPointerCancel(onCancel);

      press({ x: 100, y: 100 });
      move({ x: 130, y: 120 });
      const { info } = otherPress('mouse', { x: 300, y: 300 });

      expect(info.preventGesture).toBe(true);
      expect(info.stopPropagation).toBe(true);
      expect(onCancel).not.toHaveBeenCalled();
      expect(transformOpen()).toBe(true);

      move({ x: 160, y: 140 });
      release({ x: 160, y: 140 });
      expect(rect.left).toBe(160);
      expect(modified).toHaveBeenCalledTimes(1);
    });
  });

  it("ignores another pointer's cancel", () => {
    const onCancel = vi.fn<PointerCancelCallback>();
    overlay.onPointerCancel(onCancel);
    press({ x: 100, y: 100 });
    move({ x: 140, y: 130 });

    cancel({ x: 140, y: 130 }, PRESSING + 2);

    expect(onCancel).not.toHaveBeenCalled();
    expect(transformOpen()).toBe(true);
    expect(rect.left).toBe(140);
  });

  it('does nothing when no press is in progress', () => {
    const onCancel = vi.fn<PointerCancelCallback>();
    overlay.onPointerCancel(onCancel);
    press({ x: 100, y: 100 });
    release({ x: 100, y: 100 });

    cancel({ x: 100, y: 100 });

    expect(onCancel).not.toHaveBeenCalled();
  });

  /**
   * A cancelled press is still a press: the clicks either side of it were not
   * consecutive, so they must not pair into a double click.
   */
  it('does not let the clicks either side of a cancelled press pair', () => {
    const onDoubleClick = vi.fn<DoubleClickCallback>();
    overlay.onDoubleClick(onDoubleClick);
    const at = { x: 300, y: 300 };

    press(at);
    release(at);
    press(at);
    cancel(at);
    press(at);
    release(at);

    expect(onDoubleClick).not.toHaveBeenCalled();
  });

  it('unsubscribes', () => {
    const kept = vi.fn<PointerCancelCallback>();
    const dropped = vi.fn<PointerCancelCallback>();
    overlay.onPointerCancel(kept);
    const unsubscribe = overlay.onPointerCancel(dropped);
    unsubscribe();

    press({ x: 100, y: 100 });
    cancel({ x: 100, y: 100 });

    expect(kept).toHaveBeenCalledTimes(1);
    expect(dropped).not.toHaveBeenCalled();
  });

  it('drops every subscriber on destroy()', () => {
    const other = createTestViewer();
    const doomed = new FabricOverlay(other.viewer);
    doomed.onPointerCancel(vi.fn<PointerCancelCallback>());

    doomed.destroy();
    other.cleanup();

    const subscribers = (doomed as unknown as { _pointerCancelSubscribers: Set<unknown> })
      ._pointerCancelSubscribers;
    expect(subscribers.size).toBe(0);
  });
});
