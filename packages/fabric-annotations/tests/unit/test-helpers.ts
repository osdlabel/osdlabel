import { expect, vi, type Mock } from 'vitest';
import type { FabricObject } from 'fabric';
import type { KeyboardShortcutMap } from '@osdlabel/viewer-api';

/** Creates a KeyboardShortcutMap with default values for use in tests. */
export function createTestKeyboardShortcuts(): KeyboardShortcutMap {
  return {
    selectTool: 'v',
    rectangleTool: 'r',
    circleTool: 'c',
    lineTool: 'l',
    pointTool: 'p',
    polylineTool: 'd',
    freeHandPathTool: 'f',
    cancel: 'Escape',
    delete: 'Delete',
    deleteAlt: 'Backspace',
    gridCell1: '1',
    gridCell2: '2',
    gridCell3: '3',
    gridCell4: '4',
    gridCell5: '5',
    gridCell6: '6',
    gridCell7: '7',
    gridCell8: '8',
    gridCell9: '9',
    increaseGridColumns: '=',
    decreaseGridColumns: '-',
    increaseGridRows: ']',
    decreaseGridRows: '[',
    polylineFinish: 'Enter',
    polylineClose: 'c',
    polylineCancel: 'Escape',
    rotateCW: 'R',
    rotateCCW: 'L',
    flipHorizontal: 'H',
    flipVertical: 'V',
    resetView: ')',
    toggleNegative: 'N',
    increaseExposure: 'E',
    decreaseExposure: 'D',
    increaseContrast: 'C',
    decreaseContrast: 'X',
    nextContext: '.',
    previousContext: ',',
  };
}

/**
 * A mock Fabric canvas whose recorded calls are actually type-checked.
 *
 * `add: ReturnType<typeof vi.fn>` — the previous shape — makes `.mock.calls`
 * `any[][]`, so every assertion reading off it compiles no matter what it
 * claims. `mockCanvas.add.mock.calls[0]![0].thisFieldDoesNotExist` assigned to
 * a `string` type-checked cleanly before this existed (#162). Declaring the
 * parameter type makes each recorded argument a `FabricObject`, so a typo or a
 * property that belongs to a different shape is a compile error.
 *
 * Subclass-only fields (`Polyline.points`, `Line.x1`) are deliberately still
 * errors here: assert `toBeInstanceOf` first and narrow, which also checks the
 * tool built the Fabric class it was supposed to.
 */
export interface MockFabricCanvas {
  // A required first parameter, not a bare rest: `calls[0]![0]` is then a
  // `FabricObject` rather than `FabricObject | undefined`, which matches how
  // the tools call it and keeps the assertions free of noise.
  add: Mock<(object: FabricObject, ...rest: FabricObject[]) => number>;
  remove: Mock<(object: FabricObject, ...rest: FabricObject[]) => number>;
  requestRenderAll: Mock<() => void>;
  getZoom: Mock<() => number>;
  on: Mock<(eventName: string, handler: (...args: never[]) => void) => void>;
  off: Mock<(eventName: string, handler?: (...args: never[]) => void) => void>;
}

export function createMockCanvas(): MockFabricCanvas {
  return {
    add: vi.fn(),
    remove: vi.fn(),
    requestRenderAll: vi.fn(),
    getZoom: vi.fn(() => 1),
    on: vi.fn(),
    off: vi.fn(),
  };
}

/**
 * Assert a recorded Fabric object is *exactly* the expected class, and narrow
 * to it.
 *
 * The tool tests read subclass-only fields (`Circle.radius`, `Line.x1`,
 * `Polyline.points`). With the canvas mock typed those reads no longer compile
 * against the base `FabricObject`, so they need narrowing — and since which
 * Fabric class each tool constructs was itself unasserted, the narrowing is
 * routed through an assertion rather than a bare cast. The cast below is still
 * a cast; what makes it sound is the check in front of it.
 *
 * That check is `constructor === ctor`, not `instanceof`, and the difference
 * is load-bearing: **`Polygon extends Polyline`**, so `toBeInstanceOf(Polyline)`
 * accepts a `Polygon` — which is the one substitution these tools can actually
 * make. With `instanceof`, switching a polyline preview to `new Polygon(...)`
 * (visually: the in-progress shape gains a closing edge and a fill) passed all
 * 36 polyline-tool tests.
 */
export function expectFabricInstance<T extends FabricObject>(
  object: FabricObject,
  ctor: abstract new (...args: never[]) => T,
): T {
  expect(object).toBeInstanceOf(ctor);
  // `instanceof` is satisfied by any subclass; this pins the exact class.
  expect(object.constructor).toBe(ctor);
  return object as T;
}
