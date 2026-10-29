/**
 * Part of the rectangle suite (every test file with "rectangle" in its name).
 *
 * Pins, for osdlabel's annotation creation, serialization and edit commit,
 * the suite's invariant: what a rectangle annotation's Fabric data paints is
 * exactly the shape its geometry describes, and its geometry is what the user
 * did. Until #244 every rectangle was painted centred on the corner its
 * geometry recorded, half its size away from where its labels, measurements
 * and exports put it, and no test compared the two. Here they are compared at
 * every step osdlabel owns:
 *
 * - `createAnnotationFromGeometry`, `processConvertCircleToRectangle` and the
 *   drawing commit `processToolAddAnnotation`: the stored geometry is the one
 *   asked for (or the box dragged), and the stored `rawAnnotationData`, rebuilt
 *   the way the viewer rebuilds it, paints exactly there;
 * - `serialize` → JSON → `deserialize`: the geometry comes back unchanged and
 *   its data still paints there;
 * - the edit commit `processObjectModified`, once the loaded `Rect` is left
 *   the way Fabric's controls leave it after a rotation, a move or a resize:
 *   a rotation changes only `rotation`, a move only `origin` (by the move), a
 *   resize keeps the side opposite the handle where it was, and the stored
 *   corners are the painted ones, also once the committed data is reloaded;
 *   and once it is skewed, which no rectangle geometry describes, the commit
 *   stores the box about the same centre and data that paints exactly it;
 * - `enableLiveDecorationUpdates`: at each step of such an edit, the geometry
 *   handed to the decoration providers has the painted corners, its centroid
 *   (where labels and measurements are anchored) is the painted centre, and
 *   its area and perimeter are the painted shape's.
 *
 * The edits change the `Rect` through Fabric's public API only (`set`,
 * `rotate`, `setCoords`), and the tests fire the drag events themselves.
 * Fabric's own controls are driven through a real Fabric `Canvas` in
 * fabric-annotations' `rectangle-fabric.test.ts`.
 *
 * "Painted corners" are the `Rect`'s own transform applied to its
 * `(±width/2, ±height/2)`, excluding the stroke; the expected corners come
 * from `referenceCorners`, an independent implementation of the contract,
 * pinned to the worked example by hand below. Data saved by releases up to
 * 0.21.0 is covered by `legacy-rectangle.test.ts`.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { Rect, type FabricObject } from 'fabric';
import type { AnnotationStyle, Geometry, Point, RectangleGeometry } from '@osdlabel/annotation';
import { createAnnotationContextId } from '@osdlabel/annotation-context';
import {
  createLabelProvider,
  type Decoration,
  type DecorationContext,
  type DecorationProvider,
} from '@osdlabel/decoration';
import {
  RectangleTool,
  createFabricObjectFromRawData,
  initFabricModule,
  serializeFabricObject,
  type AddAnnotationParams,
  type ToolCallbacks,
  type ToolOverlay,
} from '@osdlabel/fabric-annotations';
import type { FabricOverlay } from '@osdlabel/fabric-osd';
import { area, centroid, perimeter } from '@osdlabel/geometry';
import { createImageId, type AnnotationState } from '@osdlabel/viewer-api';
import { createAnnotationFromGeometry } from '../../src/create-annotation.js';
import { DEFAULT_KEYBOARD_SHORTCUTS } from '../../src/keyboard.js';
import { enableLiveDecorationUpdates } from '../../src/live-decoration-updates.js';
import { deserialize, serialize } from '../../src/serialization-configured.js';
import {
  processConvertCircleToRectangle,
  processObjectModified,
  processToolAddAnnotation,
} from '../../src/tool-factory.js';
import type { OsdAnnotation, OsdFields } from '../../src/types.js';
import {
  RECTANGLE_ROTATIONS,
  cornerDeviation,
  cornerSetDeviation,
  cornersAreaAndPerimeter,
  cornersCentre,
  describeRectangle,
  formatCorners,
  paintedCorners,
  rectangle,
  rectangleMatrix,
  referenceCorners,
  workedExample,
  type Corners,
} from './rectangle-reference.js';

initFabricModule();

const imageId = createImageId('img-rectangle-suite');
const contextId = createAnnotationContextId('ctx-rectangle-suite');

/** Between two live Fabric objects or computations: floating-point error only. */
const LIVE_TOLERANCE = 1e-6;

/**
 * After `serializeFabricObject`: `toObject()` rounds every number to four
 * decimals (`config.NUM_FRACTION_DIGITS`), so `left`/`top`/`width`/`height`
 * may each be 5e-5 off, which moves a corner by at most about 1.1e-4.
 */
const SAVED_TOLERANCE = 2e-4;

/**
 * Reloading the data an edit committed: `scaleX`/`scaleY` and `angle` are
 * rounded to four decimals as well, which moves a corner by up to 2.5e-5 per
 * unscaled pixel of width and height, plus 5e-5 degrees over the
 * half-diagonal. Sub-pixel, but proportional to the size.
 */
function reloadTolerance(rect: Rect): number {
  const halfDiagonal = Math.hypot(rect.width * rect.scaleX, rect.height * rect.scaleY) / 2;
  return (
    SAVED_TOLERANCE + 2.5e-5 * (rect.width + rect.height) + ((5e-5 * Math.PI) / 180) * halfDiagonal
  );
}

// ── Helpers ────────────────────────────────────────────────────────────────

function createRectangle(
  geometry: Geometry,
  options: { readonly style?: AnnotationStyle; readonly label?: string } = {},
): OsdAnnotation {
  return createAnnotationFromGeometry(geometry, {
    imageId,
    contextId,
    toolType: 'rectangle',
    ...options,
  });
}

/** As the viewer loads a stored annotation: from its JSON, through `createFabricObjectFromRawData`. */
async function load(annotation: OsdAnnotation): Promise<Rect> {
  const stored = JSON.parse(JSON.stringify(annotation)) as OsdAnnotation;
  const obj = await createFabricObjectFromRawData(stored);
  expect(obj).toBeInstanceOf(Rect);
  return obj as Rect;
}

function stateOf(...annotations: readonly OsdAnnotation[]): AnnotationState<OsdFields> {
  const byImage: AnnotationState<OsdFields>['byImage'] = { [imageId]: {} };
  for (const a of annotations) byImage[imageId]![a.id] = a;
  return { byImage, changeCounter: 1 };
}

function asRectangle(geometry: Geometry | null | undefined): RectangleGeometry {
  expect(geometry).toBeDefined();
  expect(geometry).not.toBeNull();
  if (geometry!.type !== 'rectangle') {
    throw new Error(`expected a rectangle geometry, got ${geometry!.type}`);
  }
  return geometry!;
}

function expectCorners(actual: Corners, expected: Corners, tolerance: number, what: string): void {
  expect(
    cornerDeviation(actual, expected),
    `${what}\n  actual   ${formatCorners(actual)}\n  expected ${formatCorners(expected)}`,
  ).toBeLessThanOrEqual(tolerance);
}

function expectCornerSet(
  actual: Corners,
  expected: Corners,
  tolerance: number,
  what: string,
): void {
  expect(
    cornerSetDeviation(actual, expected),
    `${what}\n  actual   ${formatCorners(actual)}\n  expected ${formatCorners(expected)}`,
  ).toBeLessThanOrEqual(tolerance);
}

function expectPointNear(actual: Point, expected: Point, tolerance: number, what: string): void {
  expect(
    Math.hypot(actual.x - expected.x, actual.y - expected.y),
    `${what}: (${actual.x}, ${actual.y}) vs (${expected.x}, ${expected.y})`,
  ).toBeLessThanOrEqual(tolerance);
}

/** A rotation in degrees, in [0, 360). */
const normalizeDegrees = (degrees: number): number => ((degrees % 360) + 360) % 360;

/** Smallest difference between two angles in degrees. */
function angleDifference(a: number, b: number): number {
  const d = normalizeDegrees(a - b);
  return Math.min(d, 360 - d);
}

/** Pointer positions from `from` to `to`: a first small move, as a drag starts, then `steps` even ones. */
function linePath(from: Point, to: Point, steps = 6): readonly Point[] {
  const at = (t: number): Point => ({
    x: from.x + (to.x - from.x) * t,
    y: from.y + (to.y - from.y) * t,
  });
  return [from, at(0.01), ...Array.from({ length: steps }, (_, i) => at((i + 1) / steps))];
}

// ── Editing a Rect the way Fabric's controls leave it ──────────────────────

/** A drag of the body: `left`/`top` move by `delta`. */
function moveBy(rect: Rect, delta: Point): void {
  rect.set({ left: rect.left + delta.x, top: rect.top + delta.y });
  rect.setCoords();
}

/** The rotation handle: `rotate()` turns the object about its centre (`centeredRotation`). */
function rotateTo(rect: Rect, angle: number): void {
  rect.rotate(angle);
  rect.setCoords();
}

type ResizeHandle = 'tl' | 'tr' | 'br' | 'bl' | 'ml' | 'mr' | 'mt' | 'mb';

/**
 * Each resize handle's direction in the rectangle's own frame (`+x` along its
 * top edge whatever its rotation), and the corners opposite it (indices into
 * `paintedCorners`), which a resize from it leaves where they are painted.
 */
const HANDLES: Readonly<
  Record<ResizeHandle, { readonly outward: Point; readonly fixed: readonly number[] }>
> = {
  tl: { outward: { x: -1, y: -1 }, fixed: [2] },
  tr: { outward: { x: 1, y: -1 }, fixed: [3] },
  br: { outward: { x: 1, y: 1 }, fixed: [0] },
  bl: { outward: { x: -1, y: 1 }, fixed: [1] },
  mt: { outward: { x: 0, y: -1 }, fixed: [2, 3] },
  mr: { outward: { x: 1, y: 0 }, fixed: [0, 3] },
  mb: { outward: { x: 0, y: 1 }, fixed: [0, 1] },
  ml: { outward: { x: -1, y: 0 }, fixed: [1, 2] },
};

/**
 * A size in the rectangle's own frame. Negative along an axis means the
 * handle was dragged through the far side, which Fabric paints flipped.
 */
interface FrameSize {
  readonly width: number;
  readonly height: number;
}

/**
 * Start a resize from `handle`. The returned function leaves `rect` as
 * Fabric's control leaves it once the box has reached `size`: `scaleX` /
 * `scaleY` set to it, `flipX` / `flipY` toggled along an axis where it is
 * negative, and `left` / `top` translated so the corner opposite the handle
 * is painted where it was when the resize started. Keeping that corner's own
 * point in place is also what mirrors a flipped box about the side that stays.
 */
function startResize(rect: Rect, handle: ResizeHandle): (size: FrameSize) => void {
  const keep = HANDLES[handle].fixed[0]!;
  const anchor = paintedCorners(rect)[keep]!;
  const { flipX, flipY } = rect;
  return ({ width, height }) => {
    rect.set({
      scaleX: Math.abs(width) / rect.width,
      scaleY: Math.abs(height) / rect.height,
      flipX: width < 0 ? !flipX : flipX,
      flipY: height < 0 ? !flipY : flipY,
    });
    const moved = paintedCorners(rect)[keep]!;
    rect.set({ left: rect.left + anchor.x - moved.x, top: rect.top + anchor.y - moved.y });
    rect.setCoords();
  };
}

/** A whole resize from `handle`, released at `size`. */
function resizeTo(rect: Rect, handle: ResizeHandle, size: FrameSize): void {
  startResize(rect, handle)(size);
}

type Committed = NonNullable<ReturnType<typeof processObjectModified>>;

/** What `useAnnotationTool` does on `object:modified` in both bindings. */
function commit(rect: Rect, stored: OsdAnnotation): Committed {
  const committed = processObjectModified(rect, stateOf(stored), imageId);
  expect(committed, 'processObjectModified resolved the edited annotation').not.toBeNull();
  return committed!;
}

/** Reload what a commit stored, and return where it is painted. */
async function reloadCommitted(committed: Committed, stored: OsdAnnotation): Promise<Rect> {
  return load({
    ...stored,
    geometry: asRectangle(committed.geometry),
    rawAnnotationData: committed.rawAnnotationData,
  });
}

// ── The oracle ─────────────────────────────────────────────────────────────

const WORKED_0: Corners = [
  { x: 200, y: 100 },
  { x: 300, y: 100 },
  { x: 300, y: 150 },
  { x: 200, y: 150 },
];
// Centre (250, 125); +90 takes the top edge onto the right: x 225–275, y 75–175.
const WORKED_90: Corners = [
  { x: 275, y: 75 },
  { x: 275, y: 175 },
  { x: 225, y: 175 },
  { x: 225, y: 75 },
];

describe('oracle self-check (pins the test reference, not the library)', () => {
  it('reproduces the worked example by hand', () => {
    expect(referenceCorners(workedExample(0))).toEqual(WORKED_0);
    expect(referenceCorners(workedExample(90))).toEqual(WORKED_90);
  });
});

// ── Creation ───────────────────────────────────────────────────────────────

describe('createAnnotationFromGeometry', () => {
  // It stores the caller's geometry object, so each test compares the stored
  // geometry with a copy taken before the call, never with the object passed.

  it('paints the worked example where its geometry says, unrotated and at +90', async () => {
    for (const [rotation, expected] of [
      [0, WORKED_0],
      [90, WORKED_90],
    ] as const) {
      const geometry = workedExample(rotation);
      const asked = structuredClone(geometry);
      const annotation = createRectangle(geometry);
      expect(annotation.geometry).toStrictEqual(asked);
      expectCorners(
        paintedCorners(await load(annotation)),
        expected,
        1e-9,
        `worked example at ${rotation}`,
      );
    }
  });

  it('saves the Fabric object by its centre, with a centre origin', () => {
    const { data } = createRectangle(workedExample(90)).rawAnnotationData;
    expect(data).toMatchObject({
      type: 'Rect',
      originX: 'center',
      originY: 'center',
      left: 250,
      top: 125,
      width: 100,
      height: 50,
      angle: 90,
      scaleX: 1,
      scaleY: 1,
      flipX: false,
      flipY: false,
      skewX: 0,
      skewY: 0,
    });
  });

  it('stores the geometry it was given and paints it at the contract corners, for every origin, size and rotation', async () => {
    for (const geometry of rectangleMatrix()) {
      const asked = structuredClone(geometry);
      const annotation = createRectangle(geometry);
      expect(annotation.geometry, describeRectangle(geometry)).toStrictEqual(asked);
      expectCorners(
        paintedCorners(await load(annotation)),
        referenceCorners(geometry),
        SAVED_TOLERANCE,
        describeRectangle(geometry),
      );
    }
  });

  it('paints a rectangle placed with mouse precision where its geometry says', async () => {
    const geometry = rectangle(
      { x: 132.38578680202863, y: 218.61252115058915 },
      87.12345678901,
      43.98765432109,
      33.3333333333,
    );
    const asked = structuredClone(geometry);
    const annotation = createRectangle(geometry);
    expect(annotation.geometry).toStrictEqual(asked);
    expectCorners(
      paintedCorners(await load(annotation)),
      referenceCorners(geometry),
      SAVED_TOLERANCE,
      describeRectangle(geometry),
    );
  });
});

describe('processConvertCircleToRectangle', () => {
  it("stores the circle's bounding box and paints it there", async () => {
    const circle = createAnnotationFromGeometry(
      { type: 'circle', center: { x: 250, y: 125 }, radius: 25 },
      { imageId, contextId, toolType: 'circle' },
    );
    const converted = processConvertCircleToRectangle(circle);
    expect(converted).not.toBeNull();
    expect(converted!.geometry).toStrictEqual(rectangle({ x: 225, y: 100 }, 50, 50, 0));
    const rect = await load({ ...circle, ...converted! });
    expectCorners(
      paintedCorners(rect),
      [
        { x: 225, y: 100 },
        { x: 275, y: 100 },
        { x: 275, y: 150 },
        { x: 225, y: 150 },
      ],
      1e-9,
      'converted circle',
    );
  });
});

describe('processToolAddAnnotation (the drawing commit)', () => {
  function draw(from: Point, to: Point): AddAnnotationParams {
    const added: AddAnnotationParams[] = [];
    const overlay = {
      canvas: { add: () => {}, remove: () => {}, requestRenderAll: () => {} },
      imageToScreen: (p: Point) => p,
      pressSeqOf: () => undefined,
    } as unknown as ToolOverlay;
    const callbacks: ToolCallbacks = {
      getActiveContextId: () => contextId,
      getToolConstraint: () => undefined,
      canAddAnnotation: () => true,
      addAnnotation: (params) => added.push(params),
      updateAnnotation: () => {},
      deleteAnnotation: () => {},
      setSelectedAnnotation: () => {},
      getAnnotation: () => undefined,
    };
    const tool = new RectangleTool();
    tool.activate(overlay, imageId, callbacks, DEFAULT_KEYBOARD_SHORTCUTS);
    const e = {} as PointerEvent;
    tool.onPointerDown(e, from);
    for (const p of linePath(from, to).slice(1)) tool.onPointerMove(e, p);
    tool.onPointerUp(e, to);
    expect(added).toHaveLength(1);
    return added[0]!;
  }

  it.each([
    ['top-left to bottom-right', { x: 200, y: 100 }, { x: 300, y: 150 }],
    ['bottom-right to top-left', { x: 300, y: 150 }, { x: 200, y: 100 }],
    ['top-right to bottom-left', { x: 300, y: 100 }, { x: 200, y: 150 }],
    ['bottom-left to top-right', { x: 200, y: 150 }, { x: 300, y: 100 }],
  ])('stores the box dragged %s and paints it there', async (_name, from, to) => {
    const committed = processToolAddAnnotation(draw(from, to));
    expect(committed).not.toBeNull();
    const geometry = asRectangle(committed!.geometry);
    expect(geometry.origin.x).toBeCloseTo(200, 9);
    expect(geometry.origin.y).toBeCloseTo(100, 9);
    expect(geometry.width).toBeCloseTo(100, 9);
    expect(geometry.height).toBeCloseTo(50, 9);
    expect(geometry.rotation).toBe(0);
    const rect = await load({
      ...createRectangle(geometry),
      rawAnnotationData: committed!.rawAnnotationData,
    });
    expectCorners(paintedCorners(rect), WORKED_0, SAVED_TOLERANCE, 'reloaded drawing');
  });

  it('stores a box dragged with mouse precision', async () => {
    const from = { x: 432.38578680202863, y: 218.61252115058915 };
    const to = { x: 132.1234567890123, y: 318.9876543210988 };
    const committed = processToolAddAnnotation(draw(from, to));
    expect(committed).not.toBeNull();
    const geometry = asRectangle(committed!.geometry);
    const dragged: Corners = [
      { x: to.x, y: from.y },
      { x: from.x, y: from.y },
      { x: from.x, y: to.y },
      { x: to.x, y: to.y },
    ];
    expectCorners(referenceCorners(geometry), dragged, LIVE_TOLERANCE, 'stored geometry');
    const rect = await load({
      ...createRectangle(geometry),
      rawAnnotationData: committed!.rawAnnotationData,
    });
    expectCorners(paintedCorners(rect), dragged, SAVED_TOLERANCE, 'reloaded drawing');
  });
});

// ── Serialization ──────────────────────────────────────────────────────────

describe('serialize → JSON → deserialize', () => {
  it('returns every rectangle unchanged, still painted at its geometry', async () => {
    const annotations = rectangleMatrix().map((geometry) => createRectangle(geometry));
    const json = JSON.stringify(serialize(stateOf(...annotations)));
    const { byImage } = deserialize(JSON.parse(json));
    const restored = byImage[imageId];
    expect(restored).toBeDefined();
    expect(Object.keys(restored!)).toHaveLength(annotations.length);

    for (const original of annotations) {
      const back = restored![original.id];
      expect(back, describeRectangle(asRectangle(original.geometry))).toBeDefined();
      expect(back!.geometry).toStrictEqual(original.geometry);
      expect(back!.rawAnnotationData).toStrictEqual(original.rawAnnotationData);
      expectCorners(
        paintedCorners(await load(back!)),
        referenceCorners(asRectangle(original.geometry)),
        SAVED_TOLERANCE,
        describeRectangle(asRectangle(original.geometry)),
      );
    }

    // Loading changes nothing: saving what was loaded writes the same document.
    const state = { byImage, changeCounter: 2 };
    expect(JSON.parse(JSON.stringify(serialize(state)))).toStrictEqual(JSON.parse(json));
  });
});

// ── The edit commit ────────────────────────────────────────────────────────

describe('processObjectModified after an edit', () => {
  describe('worked by hand', () => {
    it('a quarter turn of the worked example about its centre changes only rotation', async () => {
      const stored = createRectangle(workedExample(0));
      const obj = await load(stored);
      rotateTo(obj, 90);
      const geometry = asRectangle(commit(obj, stored).geometry);
      expectPointNear(geometry.origin, { x: 200, y: 100 }, 1e-9, 'origin after the turn');
      expect(geometry.width).toBe(100);
      expect(geometry.height).toBe(50);
      expect(geometry.rotation).toBe(90);
      expectCorners(paintedCorners(obj), WORKED_90, 1e-9, 'painted after the turn');
      expectCorners(referenceCorners(geometry), WORKED_90, 1e-9, 'stored after the turn');
    });

    it('a move of the rotated worked example by (12.5, -31.75) shifts its origin by the move', async () => {
      const stored = createRectangle(workedExample(90));
      const obj = await load(stored);
      moveBy(obj, { x: 12.5, y: -31.75 });
      const geometry = asRectangle(commit(obj, stored).geometry);
      expect(geometry).toStrictEqual(rectangle({ x: 212.5, y: 68.25 }, 100, 50, 90));
      // x 237.5–287.5, y 43.25–143.25.
      const moved: Corners = [
        { x: 287.5, y: 43.25 },
        { x: 287.5, y: 143.25 },
        { x: 237.5, y: 143.25 },
        { x: 237.5, y: 43.25 },
      ];
      expectCorners(paintedCorners(obj), moved, 1e-9, 'painted after the move');
      expectCorners(referenceCorners(geometry), moved, 1e-9, 'stored after the move');
    });

    it.each([
      // The dragged corner lands on (360, 160); the top-left stays at (200, 100).
      ['br, free', 'br', { width: 160, height: 60 }, rectangle({ x: 200, y: 100 }, 160, 60, 0)],
      // The dragged corner lands on (180, 90); the bottom-right stays at (300, 150).
      ['tl, free', 'tl', { width: 120, height: 60 }, rectangle({ x: 180, y: 90 }, 120, 60, 0)],
      // Proportional, as a corner scales without Shift: both sides by 22/15.
      [
        'br, proportional',
        'br',
        { width: (100 * 22) / 15, height: (50 * 22) / 15 },
        rectangle({ x: 200, y: 100 }, (100 * 22) / 15, (50 * 22) / 15, 0),
      ],
      // Dragged to x = 150, past the left edge: the left edge stays, the box flips onto x 150–200.
      [
        'mr, through the far side',
        'mr',
        { width: -50, height: 50 },
        rectangle({ x: 150, y: 100 }, 50, 50, 0),
      ],
    ] as const)(
      'resizing the worked example from %s keeps the opposite side fixed',
      async (_name, handle, size, expected) => {
        const stored = createRectangle(workedExample(0));
        const obj = await load(stored);
        resizeTo(obj, handle, size);
        const geometry = asRectangle(commit(obj, stored).geometry);
        expect(geometry.origin.x).toBeCloseTo(expected.origin.x, 9);
        expect(geometry.origin.y).toBeCloseTo(expected.origin.y, 9);
        expect(geometry.width).toBeCloseTo(expected.width, 9);
        expect(geometry.height).toBeCloseTo(expected.height, 9);
        expect(geometry.rotation).toBe(0);
        expectCornerSet(
          paintedCorners(obj),
          referenceCorners(expected),
          1e-9,
          'painted after the resize',
        );
      },
    );

    it('resizing the rotated worked example along its own x stretches it down the image', async () => {
      // At +90 the unrotated right edge is painted along y = 175; widening the
      // box to 130 keeps its left edge at y = 75 and covers x 225–275, y 75–205.
      const stored = createRectangle(workedExample(90));
      const obj = await load(stored);
      resizeTo(obj, 'mr', { width: 130, height: 50 });
      const geometry = asRectangle(commit(obj, stored).geometry);
      expect(geometry.origin.x).toBeCloseTo(185, 9);
      expect(geometry.origin.y).toBeCloseTo(115, 9);
      expect(geometry.width).toBeCloseTo(130, 9);
      expect(geometry.height).toBe(50);
      expect(geometry.rotation).toBe(90);
      const stretched: Corners = [
        { x: 275, y: 75 },
        { x: 275, y: 205 },
        { x: 225, y: 205 },
        { x: 225, y: 75 },
      ];
      expectCorners(paintedCorners(obj), stretched, 1e-9, 'painted after the resize');
      expectCorners(referenceCorners(geometry), stretched, 1e-9, 'stored after the resize');
    });
  });

  it('commits the stored geometry when nothing changed it', async () => {
    for (const geometry of rectangleMatrix()) {
      const stored = createRectangle(geometry);
      const obj = await load(stored);
      const committed = processObjectModified(obj, stateOf(stored), imageId);
      expect(committed, describeRectangle(geometry)).not.toBeNull();
      expectCorners(
        referenceCorners(asRectangle(committed!.geometry)),
        referenceCorners(geometry),
        SAVED_TOLERANCE,
        describeRectangle(geometry),
      );
    }
  });

  it.each([37.5, -120])(
    'a rotation by %s° about the centre changes only rotation, for every origin, size and rotation',
    async (delta) => {
      for (const geometry of rectangleMatrix()) {
        const what = `${describeRectangle(geometry)}, turned by ${delta}`;
        const stored = createRectangle(geometry);
        const obj = await load(stored);
        rotateTo(obj, obj.angle + delta);
        const committed = commit(obj, stored);
        const after = asRectangle(committed.geometry);
        expectPointNear(after.origin, geometry.origin, LIVE_TOLERANCE, `${what}: origin`);
        expect(after.width, what).toBe(geometry.width);
        expect(after.height, what).toBe(geometry.height);
        expect(angleDifference(after.rotation, geometry.rotation + delta), what).toBeLessThan(1e-9);
        expectCorners(referenceCorners(after), paintedCorners(obj), LIVE_TOLERANCE, what);
        expectCorners(
          paintedCorners(await reloadCommitted(committed, stored)),
          referenceCorners(after),
          reloadTolerance(obj),
          `${what}, reloaded`,
        );
      }
    },
  );

  it('a move changes only origin, by the move, for every origin, size and rotation', async () => {
    const delta = { x: 37.5, y: -12.25 };
    for (const geometry of rectangleMatrix()) {
      const what = describeRectangle(geometry);
      const stored = createRectangle(geometry);
      const obj = await load(stored);
      moveBy(obj, delta);
      const committed = commit(obj, stored);
      const after = asRectangle(committed.geometry);
      expectPointNear(
        after.origin,
        { x: geometry.origin.x + delta.x, y: geometry.origin.y + delta.y },
        LIVE_TOLERANCE,
        `${what}: origin`,
      );
      expect(after.width, what).toBe(geometry.width);
      expect(after.height, what).toBe(geometry.height);
      expect(after.rotation, what).toBe(geometry.rotation);
      expectCorners(referenceCorners(after), paintedCorners(obj), LIVE_TOLERANCE, what);
      expectCorners(
        paintedCorners(await reloadCommitted(committed, stored)),
        referenceCorners(after),
        reloadTolerance(obj),
        `${what}, reloaded`,
      );
    }
  });

  const RESIZES: readonly (readonly [ResizeHandle, 'proportional' | 'free'])[] = [
    ['tl', 'proportional'],
    ['tr', 'proportional'],
    ['br', 'proportional'],
    ['bl', 'proportional'],
    ['tl', 'free'],
    ['tr', 'free'],
    ['br', 'free'],
    ['bl', 'free'],
    ['ml', 'free'],
    ['mr', 'free'],
    ['mt', 'free'],
    ['mb', 'free'],
  ];

  it.each(RESIZES)(
    'a resize from %s (%s) keeps the opposite side fixed and stores the painted corners',
    async (handle, mode) => {
      for (const geometry of rectangleMatrix()) {
        const what = `${describeRectangle(geometry)}, ${handle} ${mode}`;
        const stored = createRectangle(geometry);
        const obj = await load(stored);
        const before = paintedCorners(obj);
        const { outward, fixed } = HANDLES[handle];
        // Dragged outward, by a quarter of the width and a fifth of the height
        // and a few pixels; a side handle leaves the other axis alone.
        const width = outward.x === 0 ? geometry.width : 1.25 * geometry.width + 3;
        const height = outward.y === 0 ? geometry.height : 1.2 * geometry.height + 2;
        const factor = width / geometry.width;
        resizeTo(
          obj,
          handle,
          mode === 'proportional' ? { width, height: geometry.height * factor } : { width, height },
        );
        const committed = commit(obj, stored);
        const after = asRectangle(committed.geometry);
        const storedCorners = referenceCorners(after);
        for (const i of fixed) {
          expectPointNear(
            storedCorners[i]!,
            before[i]!,
            LIVE_TOLERANCE,
            `${what}: stored corner ${i}, opposite the handle, stays put`,
          );
        }
        expect(after.rotation, what).toBe(geometry.rotation);
        if (outward.x === 0) expect(after.width, what).toBe(geometry.width);
        else expect(after.width, what).toBeGreaterThan(geometry.width);
        if (outward.y === 0) expect(after.height, what).toBe(geometry.height);
        else expect(after.height, what).toBeGreaterThan(geometry.height);
        if (mode === 'proportional') {
          expect(after.width / after.height, `${what}: aspect ratio`).toBeCloseTo(
            geometry.width / geometry.height,
            9,
          );
        }
        expectCorners(storedCorners, paintedCorners(obj), LIVE_TOLERANCE, what);
        expectCorners(
          paintedCorners(await reloadCommitted(committed, stored)),
          storedCorners,
          reloadTolerance(obj),
          `${what}, reloaded`,
        );
      }
    },
  );

  it.each(['ml', 'mr', 'mt', 'mb', 'tl', 'br'] as const)(
    'a resize from %s through the far side flips the painted shape, and the stored corners follow it',
    async (handle) => {
      for (const geometry of rectangleMatrix()) {
        const what = `${describeRectangle(geometry)}, ${handle} through the far side`;
        const stored = createRectangle(geometry);
        const obj = await load(stored);
        const before = paintedCorners(obj);
        const { outward, fixed } = HANDLES[handle];
        // Across the whole box and half as far again beyond it.
        const width = outward.x === 0 ? geometry.width : 0.5 * geometry.width + 6;
        const height = outward.y === 0 ? geometry.height : 0.5 * geometry.height + 6;
        resizeTo(obj, handle, {
          width: outward.x === 0 ? width : -width,
          height: outward.y === 0 ? height : -height,
        });
        const committed = commit(obj, stored);
        const after = asRectangle(committed.geometry);
        const storedCorners = referenceCorners(after);
        // Flipped, the stored corners are the painted ones in another order.
        for (const i of fixed) {
          const kept = Math.min(
            ...storedCorners.map((p) => Math.hypot(p.x - before[i]!.x, p.y - before[i]!.y)),
          );
          expect(
            kept,
            `${what}: corner ${i}, opposite the handle, is still a stored corner`,
          ).toBeLessThanOrEqual(LIVE_TOLERANCE);
        }
        expect(after.rotation, what).toBe(geometry.rotation);
        expect(after.width, `${what}: width`).toBeCloseTo(width, 6);
        expect(after.height, `${what}: height`).toBeCloseTo(height, 6);
        expectCornerSet(storedCorners, paintedCorners(obj), LIVE_TOLERANCE, what);
        expectCornerSet(
          paintedCorners(await reloadCommitted(committed, stored)),
          storedCorners,
          reloadTolerance(obj),
          `${what}, reloaded`,
        );
      }
    },
  );

  /**
   * A skew makes a parallelogram, which no `RectangleGeometry` describes. A
   * rectangle's handles can no longer skew it (fabric-annotations'
   * `rectangle-fabric.test.ts`), but data saved skewed by an earlier release
   * loads as saved, and a host's own Fabric code can skew one. The geometry
   * read back is the box about the same centre (its corners are not the
   * painted ones), so the commit writes data that paints exactly that box:
   * the canvas, rebuilt from it, snaps to what is stored.
   */
  describe('of a skewed rectangle', () => {
    const STYLE: AnnotationStyle = {
      strokeColor: '#1a2b3c',
      strokeWidth: 3,
      strokeDashArray: [6, 2],
      fillColor: '#00ff88',
      fillOpacity: 0.35,
      opacity: 0.8,
    };

    it('the worked example with skewX 20 is committed as the worked example, unskewed', async () => {
      const stored = createRectangle(workedExample(0), { style: STYLE });
      const obj = await load(stored);
      obj.set({ skewX: 20 });
      obj.setCoords();
      // Painted: the top edge 25 · tan 20° to the left, the bottom edge as far right.
      const shift = 25 * Math.tan((20 * Math.PI) / 180);
      expectCorners(
        paintedCorners(obj),
        [
          { x: 200 - shift, y: 100 },
          { x: 300 - shift, y: 100 },
          { x: 300 + shift, y: 150 },
          { x: 200 + shift, y: 150 },
        ],
        1e-9,
        'skewed before the commit',
      );

      const committed = commit(obj, stored);
      expect(asRectangle(committed.geometry)).toStrictEqual(workedExample(0));
      expect(committed.rawAnnotationData.data).toMatchObject({ type: 'Rect', skewX: 0, skewY: 0 });
      expectCorners(
        paintedCorners(await reloadCommitted(committed, stored)),
        WORKED_0,
        SAVED_TOLERANCE,
        'reloaded after the commit',
      );
    });

    const CASES = [
      { name: 'skewX 20', props: { skewX: 20 }, rotation: 0 },
      { name: 'skewY -15, turned 30°', props: { skewY: -15 }, rotation: 30 },
      {
        name: 'skewX 12 and skewY 7, scaled, turned 135°',
        props: { skewX: 12, skewY: 7, scaleX: 1.25, scaleY: 0.8 },
        rotation: 135,
      },
      {
        name: 'skewX -25, positioned by its top-left corner',
        props: { skewX: -25, originX: 'left', originY: 'top' },
        rotation: -40,
      },
    ] as const;

    it.each(CASES)(
      '$name: commits the box about the painted centre, and data that paints exactly that box in the same style',
      async ({ props, rotation }) => {
        const geometry = rectangle({ x: 311.25, y: 187.5 }, 140.5, 60.25, rotation);
        const stored = createRectangle(geometry, { style: STYLE });
        const obj = await load(stored);
        obj.set(props);
        obj.setCoords();
        const centre = obj.getCenterPoint();

        const committed = commit(obj, stored);
        const after = asRectangle(committed.geometry);
        expect(after.width).toBeCloseTo(geometry.width * obj.scaleX, 9);
        expect(after.height).toBeCloseTo(geometry.height * obj.scaleY, 9);
        expect(after.rotation).toBe(rotation);
        expectPointNear(
          { x: after.origin.x + after.width / 2, y: after.origin.y + after.height / 2 },
          centre,
          LIVE_TOLERANCE,
          'the stored centre is the painted one',
        );

        const data = committed.rawAnnotationData.data;
        expect(data).toMatchObject({ type: 'Rect', skewX: 0, skewY: 0, id: stored.id });
        const before = stored.rawAnnotationData.data;
        for (const key of [
          'fill',
          'stroke',
          'strokeWidth',
          'strokeDashArray',
          'opacity',
          'strokeUniform',
        ]) {
          expect(data[key], `style: ${key}`).toStrictEqual(before[key]);
        }
        const reloaded = await reloadCommitted(committed, stored);
        expectCorners(
          paintedCorners(reloaded),
          referenceCorners(after),
          reloadTolerance(reloaded),
          'reloaded after the commit',
        );
      },
    );

    it('an edit that leaves no skew is committed as Fabric serialized it', async () => {
      const stored = createRectangle(rectangle({ x: 311.25, y: 187.5 }, 140.5, 60.25, 30));
      const obj = await load(stored);
      obj.set({ scaleX: 1.5, scaleY: 0.5, flipX: true });
      rotateTo(obj, 75);
      expect(commit(obj, stored).rawAnnotationData).toStrictEqual(serializeFabricObject(obj));
    });
  });
});

// ── Live decorations during a drag ─────────────────────────────────────────

describe('enableLiveDecorationUpdates during a drag', () => {
  let rafQueue: FrameRequestCallback[] = [];

  beforeEach(() => {
    rafQueue = [];
    (
      globalThis as unknown as { requestAnimationFrame: typeof requestAnimationFrame }
    ).requestAnimationFrame = (cb: FrameRequestCallback) => {
      rafQueue.push(cb);
      return rafQueue.length;
    };
    (
      globalThis as unknown as { cancelAnimationFrame: typeof cancelAnimationFrame }
    ).cancelAnimationFrame = () => {};
  });

  function flushFrame(): void {
    const callbacks = [...rafQueue];
    rafQueue = [];
    for (const cb of callbacks) cb(0);
  }

  type DragEventName = 'object:moving' | 'object:scaling' | 'object:rotating';
  type DragListener = (event: { target?: FabricObject }) => void;

  /**
   * Stands in for the overlay's Fabric canvas, whose drag events
   * `enableLiveDecorationUpdates` subscribes to. Fabric's controls fire them
   * while the user drags; here the test fires them after each step of an edit.
   */
  class DragEvents {
    private readonly listeners = new Map<string, DragListener[]>();

    on(name: string, listener: DragListener): void {
      this.listeners.set(name, [...(this.listeners.get(name) ?? []), listener]);
    }

    off(name: string, listener: DragListener): void {
      this.listeners.set(
        name,
        (this.listeners.get(name) ?? []).filter((l) => l !== listener),
      );
    }

    fire(name: DragEventName, target: FabricObject): void {
      for (const listener of this.listeners.get(name) ?? []) listener({ target });
    }

    asOverlay(): FabricOverlay {
      return { canvas: this } as unknown as FabricOverlay;
    }
  }

  /**
   * Wires `enableLiveDecorationUpdates` to `events` with a recording provider
   * and the built-in label provider, and returns the step to call after each
   * change to `obj`: it fires `event`, runs the frame, and checks that the
   * frame's live geometry is the painted shape and that the label sits at the
   * painted centre.
   */
  function watchLive(
    events: DragEvents,
    stored: OsdAnnotation,
    obj: Rect,
    compare: 'ordered' | 'as a set',
  ): {
    readonly step: (event: DragEventName) => void;
    readonly frames: () => number;
    readonly dispose: () => void;
  } {
    let frames = 0;
    let latest: DecorationContext<OsdFields> | undefined;
    let decorations: readonly Decoration[] = [];
    const recorder: DecorationProvider<OsdFields> = (ctx) => {
      latest = ctx;
      return [];
    };
    const dispose = enableLiveDecorationUpdates<OsdFields>({
      overlay: events.asOverlay(),
      getVisibleAnnotations: () => [stored],
      getPixelSpacing: () => undefined,
      getProviders: () => [recorder, createLabelProvider<OsdFields>()],
      onDecorations: (next) => {
        frames++;
        decorations = next;
      },
    });
    const step = (event: DragEventName): void => {
      events.fire(event, obj);
      const before = frames;
      flushFrame();
      expect(frames, `a frame was emitted for ${event}`).toBe(before + 1);
      expect(latest).toBeDefined();
      const dragged = latest!.annotations.find((a) => a.id === stored.id);
      expect(dragged, 'the dragged annotation in the providers’ context').toBeDefined();
      const live = asRectangle(dragged!.geometry);
      const painted = paintedCorners(obj);
      const what = `live ${describeRectangle(live)}`;
      if (compare === 'ordered') {
        expectCorners(referenceCorners(live), painted, LIVE_TOLERANCE, what);
      } else {
        expectCornerSet(referenceCorners(live), painted, LIVE_TOLERANCE, what);
      }
      const centre = cornersCentre(painted);
      expectPointNear(centroid(live), centre, LIVE_TOLERANCE, `${what}: centroid`);
      const label = decorations.find((d) => d.id === `label:${stored.id}`);
      expect(label, 'the label decoration').toBeDefined();
      if (label!.type !== 'text') throw new Error('the label is a text decoration');
      expectPointNear(label!.anchor, centre, LIVE_TOLERANCE, `${what}: label anchor`);
      const shape = cornersAreaAndPerimeter(painted);
      expect(Math.abs(area(live) - shape.area), `${what}: area`).toBeLessThanOrEqual(
        1e-9 * shape.area + LIVE_TOLERANCE,
      );
      expect(Math.abs(perimeter(live) - shape.perimeter), `${what}: perimeter`).toBeLessThanOrEqual(
        1e-9 * shape.perimeter + LIVE_TOLERANCE,
      );
    };
    return { step, frames: () => frames, dispose };
  }

  const SHAPES = (rotation: number): readonly RectangleGeometry[] => [
    workedExample(rotation),
    rectangle({ x: 0.3, y: -0.7 }, 0.5, 0.5, rotation),
    rectangle({ x: 1234.567, y: 8910.11 }, 5000, 3000, rotation),
    rectangle({ x: -37.25, y: 12.5 }, 33.25, 1200.5, rotation),
  ];

  /** Steps per gesture, each followed by its drag event and a frame. */
  const STEPS = 6;

  type LiveGesture = readonly [
    name: string,
    compare: 'ordered' | 'as a set',
    run: (obj: Rect, geometry: RectangleGeometry, step: (event: DragEventName) => void) => void,
  ];

  const GESTURES: readonly LiveGesture[] = [
    [
      'a rotation',
      'ordered',
      (obj, _g, step) => {
        const start = obj.angle;
        for (let i = 1; i <= STEPS; i++) {
          rotateTo(obj, start + (75 * i) / STEPS);
          step('object:rotating');
        }
      },
    ],
    [
      'a move',
      'ordered',
      (obj, _g, step) => {
        for (let i = 1; i <= STEPS; i++) {
          moveBy(obj, { x: -42.5 / STEPS, y: 17.75 / STEPS });
          step('object:moving');
        }
      },
    ],
    [
      'a proportional corner resize',
      'ordered',
      (obj, g, step) => {
        const resize = startResize(obj, 'br');
        for (let i = 1; i <= STEPS; i++) {
          const factor = 1 + (0.3 * i) / STEPS;
          resize({ width: g.width * factor, height: g.height * factor });
          step('object:scaling');
        }
      },
    ],
    [
      'a free corner resize',
      'ordered',
      (obj, g, step) => {
        const resize = startResize(obj, 'tl');
        for (let i = 1; i <= STEPS; i++) {
          const t = i / STEPS;
          // Wider and shorter: the handle moves out along x and in along y.
          resize({ width: g.width * (1 + 0.2 * t) + t, height: g.height * (1 - 0.25 * t) });
          step('object:scaling');
        }
      },
    ],
    [
      'a side resize through the far side',
      'as a set',
      (obj, g, step) => {
        const resize = startResize(obj, 'mr');
        for (let i = 1; i <= STEPS; i++) {
          // From the full width, through zero (between two steps), to minus
          // half the width and 6 px.
          resize({ width: g.width - (i / STEPS) * (1.5 * g.width + 6), height: g.height });
          step('object:scaling');
        }
      },
    ],
  ];

  it.each(GESTURES)(
    'during %s of a rotated rectangle, providers see the painted shape and the label sits at its centre',
    async (_name, compare, run) => {
      for (const rotation of RECTANGLE_ROTATIONS) {
        for (const geometry of SHAPES(rotation)) {
          // createAnnotationFromGeometry stores the caller's object: compare with a copy.
          const asStored = structuredClone(geometry);
          const stored = createRectangle(geometry, { label: 'lesion' });
          const obj = await load(stored);
          const events = new DragEvents();
          const live = watchLive(events, stored, obj, compare);
          run(obj, geometry, live.step);
          live.dispose();
          expect(live.frames(), describeRectangle(geometry)).toBe(STEPS);
          // The live override never writes back: state keeps the stored geometry.
          expect(stored.geometry).toStrictEqual(asStored);
        }
      }
    },
  );
});
