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
 * That check is constructor identity, not `instanceof`, and the difference is
 * load-bearing: **`Polygon extends Polyline`**, so `toBeInstanceOf(Polyline)`
 * accepts a `Polygon` — which is the one substitution these tools can actually
 * make. With `instanceof`, switching a polyline preview to `new Polygon(...)`
 * (visually: the in-progress shape gains a closing edge and a fill) passed all
 * 36 polyline-tool tests.
 *
 * The flip side: this is exact, so do NOT use it where either class is
 * legitimately correct. `getGeometryFromFabricObject` treats them as a family
 * on purpose (`fabric-utils.ts`: "Polygon extends Polyline in Fabric, so
 * instanceof Polyline matches both"), and `PolylineTool.finish()` emits a
 * `Polygon` when the path is closed and a `Polyline` when it is open. A test
 * spanning both branches wants a plain `instanceof` assertion, not this.
 */
export function expectFabricInstance<T extends FabricObject>(
  object: FabricObject,
  ctor: (abstract new (...args: never[]) => T) & { readonly type: string },
): T {
  // Fabric's static `type` first, purely so the failure reads. `Function.name`
  // cannot serve here — the dist build is minified, and `Circle`, `Line`,
  // `Rect` and `Polyline` all report `"e"`, so a name comparison would be
  // vacuous between any of them while reporting `expected 'Ko' to be 'e'`.
  // `type` survives minification: a Polygon where a Polyline was expected
  // reports `expected 'Polygon' to be 'Polyline'`.
  //
  // Read off `object.constructor`, NOT `object` — the instance getter returns
  // the lowercase `'polyline'`, which would never match the static.
  //
  // This one is not authoritative on its own: a subclass that declares no
  // `static type` of its own inherits the parent's, so the two could agree for
  // different classes. Constructor identity below is what actually decides, and
  // it subsumes `instanceof`, which is why there is no `toBeInstanceOf` here.
  expect((object.constructor as { readonly type?: string }).type).toBe(ctor.type);
  expect(object.constructor).toBe(ctor);
  return object as T;
}
