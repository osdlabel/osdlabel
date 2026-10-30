import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Polygon, Polyline } from 'fabric';
import type { FabricObject } from 'fabric';
import { createImageId } from '@osdlabel/viewer-api';
import { createAnnotationContextId } from '@osdlabel/annotation-context';
import type {
  AnnotationTool,
  ToolCallbacks,
  AddAnnotationParams,
} from '../../../src/tools/base-tool.js';
import { RectangleTool } from '../../../src/tools/rectangle-tool.js';
import { CircleTool } from '../../../src/tools/circle-tool.js';
import { LineTool } from '../../../src/tools/line-tool.js';
import { PointTool } from '../../../src/tools/point-tool.js';
import { FreeHandPathTool } from '../../../src/tools/free-hand-path-tool.js';
import { PolylineTool } from '../../../src/tools/polyline-tool.js';
import { SelectTool } from '../../../src/tools/select-tool.js';
import { initFabricModule } from '../../../src/fabric-module.js';
import {
  createTestKeyboardShortcuts,
  createMockCanvas,
  createMockToolOverlay,
  type MockFabricCanvas,
  type MockToolOverlay,
} from '../test-helpers.js';

initFabricModule();

/**
 * `AnnotationTool.onPointerCancel`: the platform cancelled the press in
 * progress (`pointercancel`), and the tool undoes what that press began.
 *
 * `FabricOverlay` reports the cancel, with the press's sequence, *before* it
 * ends Fabric's gesture, and ending it fires Fabric's `mouse:up` — which the
 * framework hooks hand to `onPointerUp`. So each case below follows the cancel
 * with the `onPointerUp` the tool will receive next, and asserts that it
 * commits nothing: a shape tool commits its preview on the release, so a
 * cancel that left the preview in place would turn into exactly the commit
 * it exists to prevent.
 *
 * The overlay's half (putting a transformed object back, ending the gesture)
 * is in `packages/fabric-osd/tests/unit/overlay/pointer-cancel.test.ts`, the
 * gesture end to end in `apps/dev/tests/e2e/touch-cancel.spec.ts`.
 */
describe('onPointerCancel', () => {
  let overlay: MockToolOverlay;
  let canvas: MockFabricCanvas;
  let callbacks: ToolCallbacks;
  let added: AddAnnotationParams[];
  const imageId = createImageId('test-image');
  const contextId = createAnnotationContextId('test-context');
  const shortcuts = createTestKeyboardShortcuts();

  beforeEach(() => {
    added = [];
    canvas = createMockCanvas();
    overlay = createMockToolOverlay(canvas);
    callbacks = {
      getActiveContextId: () => contextId,
      getToolConstraint: (type) => ({ type }),
      canAddAnnotation: () => true,
      addAnnotation: (params) => {
        added.push(params);
      },
      updateAnnotation: vi.fn(),
      deleteAnnotation: vi.fn(),
      setSelectedAnnotation: vi.fn(),
      getAnnotation: vi.fn().mockReturnValue(undefined),
    };
  });

  const activate = <T extends AnnotationTool>(tool: T): T => {
    tool.activate(overlay, imageId, callbacks, shortcuts);
    return tool;
  };

  /** A press as the overlay forwards it: stamped with its sequence. */
  const press = (): PointerEvent => {
    const event = { type: 'pointerdown' } as PointerEvent;
    overlay.stampPress(event);
    return event;
  };
  const cancelEvent = { type: 'pointercancel' } as PointerEvent;
  const release = { type: 'pointerup' } as PointerEvent;

  /** Every object the tool added to the canvas and has not removed again. */
  const onCanvas = (): FabricObject[] => {
    const live = canvas.add.mock.calls.flat();
    const removed = new Set(canvas.remove.mock.calls.flat());
    return live.filter((o) => !removed.has(o));
  };

  describe.each([
    ['rectangle', () => new RectangleTool()],
    ['circle', () => new CircleTool()],
    ['line', () => new LineTool()],
    ['point', () => new PointTool()],
  ] as const)('the %s tool', (_name, make) => {
    it('removes its preview, and the release that follows commits nothing', () => {
      const tool = activate(make());
      const down = press();
      tool.onPointerDown(down, { x: 10, y: 10 });
      tool.onPointerMove({ type: 'pointermove' } as PointerEvent, { x: 60, y: 40 });
      expect(onCanvas()).toHaveLength(1);

      tool.onPointerCancel!(cancelEvent, overlay.seqOf(down)!);
      tool.onPointerUp(release, { x: 60, y: 40 });

      expect(onCanvas()).toHaveLength(0);
      expect(added).toHaveLength(0);
    });

    it('draws normally on the next press', () => {
      const tool = activate(make());
      const first = press();
      tool.onPointerDown(first, { x: 10, y: 10 });
      tool.onPointerCancel!(cancelEvent, overlay.seqOf(first)!);

      tool.onPointerDown(press(), { x: 100, y: 100 });
      tool.onPointerMove({ type: 'pointermove' } as PointerEvent, { x: 140, y: 130 });
      tool.onPointerUp(release, { x: 140, y: 130 });

      expect(added).toHaveLength(1);
    });
  });

  describe('the free-hand tool', () => {
    it('drops the stroke, and the release that follows commits nothing', () => {
      const tool = activate(new FreeHandPathTool());
      const down = press();
      tool.onPointerDown(down, { x: 0, y: 0 });
      for (let i = 1; i <= 5; i++) {
        tool.onPointerMove({ type: 'pointermove' } as PointerEvent, { x: i * 10, y: i * 7 });
      }
      expect(onCanvas()).toHaveLength(1);

      tool.onPointerCancel!(cancelEvent, overlay.seqOf(down)!);
      tool.onPointerUp(release, { x: 50, y: 35 });

      expect(onCanvas()).toHaveLength(0);
      expect(added).toHaveLength(0);
    });
  });

  /**
   * A polyline places its vertex on the press, so the press a cancel takes
   * away had placed one. Undoing that press removes that vertex and no other:
   * the earlier vertices were placed by presses that completed.
   */
  describe('the polyline tool', () => {
    const vertex = (tool: PolylineTool, at: { x: number; y: number }): PointerEvent => {
      const down = press();
      tool.onPointerDown(down, at);
      tool.onPointerUp(release, at);
      return down;
    };

    const finish = (tool: PolylineTool): void => {
      expect(tool.onKeyDown({ key: 'Enter' } as KeyboardEvent)).toBe(true);
    };

    const committedPoints = (): { x: number; y: number }[] => {
      expect(added).toHaveLength(1);
      const object = added[0]!.fabricObject;
      expect(object).toBeInstanceOf(Polyline);
      return (object as Polyline).points.map(({ x, y }) => ({ x, y }));
    };

    it('takes back the vertex the cancelled press placed, and only that one', () => {
      const tool = activate(new PolylineTool());
      vertex(tool, { x: 10, y: 10 });
      vertex(tool, { x: 50, y: 10 });
      const down = press();
      tool.onPointerDown(down, { x: 90, y: 60 });

      tool.onPointerCancel!(cancelEvent, overlay.seqOf(down)!);
      tool.onPointerUp(release, { x: 90, y: 60 });
      vertex(tool, { x: 50, y: 80 });
      finish(tool);

      expect(committedPoints()).toEqual([
        { x: 10, y: 10 },
        { x: 50, y: 10 },
        { x: 50, y: 80 },
      ]);
    });

    it('redraws the preview without the vertex it took back', () => {
      const tool = activate(new PolylineTool());
      vertex(tool, { x: 10, y: 10 });
      vertex(tool, { x: 50, y: 10 });
      const down = press();
      tool.onPointerDown(down, { x: 90, y: 60 });

      tool.onPointerCancel!(cancelEvent, overlay.seqOf(down)!);

      // The preview is the one polyline it added; the markers are circles.
      const previews = canvas.add.mock.calls
        .flat()
        .filter((o): o is Polyline => o instanceof Polyline);
      expect(previews).toHaveLength(1);
      const xs = previews[0]!.points.map((p) => p.x);
      expect(xs).not.toContain(90);
    });

    it('drops the whole path when the cancelled press was its first', () => {
      const tool = activate(new PolylineTool());
      const down = press();
      tool.onPointerDown(down, { x: 10, y: 10 });

      tool.onPointerCancel!(cancelEvent, overlay.seqOf(down)!);

      // Every preview object and marker it added is gone again...
      expect(onCanvas()).toHaveLength(0);
      // ...and nothing is being drawn: Enter is not the tool's to consume.
      expect(tool.onKeyDown({ key: 'Enter' } as KeyboardEvent)).toBe(false);
      expect(added).toHaveLength(0);
    });

    /**
     * A press landing on an existing annotation is suppressed by the framework
     * hooks and never reaches the tool, so no vertex carries its sequence;
     * the cancel still arrives, and must leave the path alone.
     */
    it('keeps every vertex when the cancelled press placed none', () => {
      const tool = activate(new PolylineTool());
      vertex(tool, { x: 10, y: 10 });
      vertex(tool, { x: 50, y: 10 });
      const suppressed = press();

      tool.onPointerCancel!(cancelEvent, overlay.seqOf(suppressed)!);
      finish(tool);

      expect(committedPoints()).toEqual([
        { x: 10, y: 10 },
        { x: 50, y: 10 },
      ]);
    });

    it('leaves a path the cancelled press had already closed', () => {
      const tool = activate(new PolylineTool());
      vertex(tool, { x: 100, y: 100 });
      vertex(tool, { x: 200, y: 100 });
      vertex(tool, { x: 200, y: 200 });
      // Pressing next to the first vertex closes the path on the press.
      const down = press();
      tool.onPointerDown(down, { x: 102, y: 102 });
      expect(added).toHaveLength(1);

      tool.onPointerCancel!(cancelEvent, overlay.seqOf(down)!);

      expect(added).toHaveLength(1);
      expect(added[0]!.fabricObject).toBeInstanceOf(Polygon);
    });
  });

  describe('the select tool', () => {
    let selectCanvas: MockFabricCanvas & {
      discardActiveObject: ReturnType<typeof vi.fn>;
      setActiveObject: ReturnType<typeof vi.fn>;
    };
    let handlers: Record<string, Array<(arg: unknown) => void>>;

    beforeEach(() => {
      handlers = {};
      selectCanvas = {
        ...createMockCanvas(),
        on: vi.fn((name: string, handler: (...args: never[]) => void) => {
          (handlers[name] ??= []).push(handler as (arg: unknown) => void);
        }),
        discardActiveObject: vi.fn(),
        setActiveObject: vi.fn(),
      };
      overlay = createMockToolOverlay(selectCanvas);
    });

    /**
     * The overlay has already put the object back where the press found it;
     * the press's other effect, selecting what it landed on, stands, as focus
     * does after a cancelled press. `cancel()` is the tool's deactivation path
     * and discards the selection, so it is not what a cancel may call.
     */
    it('keeps the selection', () => {
      const tool = activate(new SelectTool());
      const down = press();

      tool.onPointerCancel!(cancelEvent, overlay.seqOf(down)!);

      expect(selectCanvas.discardActiveObject).not.toHaveBeenCalled();
    });

    it('does not enter vertex-edit mode from a long press the cancel interrupted', () => {
      vi.useFakeTimers();
      try {
        const tool = activate(new SelectTool());
        const poly = new Polygon(
          [
            { x: 0, y: 0 },
            { x: 10, y: 0 },
            { x: 10, y: 10 },
          ],
          { id: 'poly-1' },
        );
        const down = press();
        for (const handler of handlers['mouse:down'] ?? []) {
          handler({ target: poly, viewportPoint: { x: 5, y: 5 }, e: down });
        }

        tool.onPointerCancel!(cancelEvent, overlay.seqOf(down)!);
        vi.advanceTimersByTime(2000);

        expect(selectCanvas.setActiveObject).not.toHaveBeenCalled();
        expect(Object.keys(poly.controls)).not.toContain('p0');
      } finally {
        vi.useRealTimers();
      }
    });
  });
});
