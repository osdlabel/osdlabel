/**
 * Pins that Fabric's controls cannot turn a circle into a shape its geometry
 * cannot describe, on every path that puts one on the canvas, and that lines,
 * polylines and polygons keep Fabric's own controls. Rectangles have the same
 * guarantee pinned in the rectangle suite (`rectangle-fabric.test.ts`).
 *
 * `CircleGeometry` is a centre and a radius. Fabric's default controls let a
 * user stretch a circle into an ellipse (a side handle, or Shift + a corner,
 * Fabric's `uniScaleKey`) or shear it (Shift + a side handle, Fabric's
 * `altActionKey`), and the geometry read back kept a circle of radius
 * `r * max(scaleX, scaleY)` while the canvas painted something else. A circle
 * now has corner handles that always scale it uniformly, a rotation handle, and
 * no side handles.
 *
 * Gestures go through a real Fabric `Canvas` configured as `FabricOverlay`
 * configures its own, with pointer events shaped the way the overlay forwards
 * them. "Painted" is the object's own transform applied to the outline Fabric
 * draws (`paintedCircle`), so a stretched or sheared circle shows up as points
 * at different distances from its centre.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  Canvas,
  Circle,
  Line,
  Polygon,
  Polyline,
  Rect,
  controlsUtils,
  util,
  type FabricObject,
} from 'fabric';
import {
  DEFAULT_ANNOTATION_STYLE,
  createAnnotationId,
  type Annotation,
  type CircleGeometry,
  type Geometry,
  type Point,
  type VectorGeometry,
} from '@osdlabel/annotation';
import { createImageId } from '@osdlabel/viewer-api';
import { createAnnotationContextId } from '@osdlabel/annotation-context';
import { buildFabricObjectFromGeometry } from '../../src/build-fabric-object.js';
import {
  createFabricObjectFromRawData,
  getFabricOptions,
  getGeometryFromFabricObject,
  serializeFabricObject,
} from '../../src/fabric-utils.js';
import { initFabricModule } from '../../src/fabric-module.js';
import { applyShapeControls } from '../../src/shape-controls.js';
import { CircleTool } from '../../src/tools/circle-tool.js';
import type { AddAnnotationParams, ToolCallbacks } from '../../src/tools/base-tool.js';
import type { FabricFields, FabricRawAnnotationData } from '../../src/types.js';
import {
  createMockCanvas,
  createMockToolOverlay,
  createTestKeyboardShortcuts,
  expectFabricInstance,
} from './test-helpers.js';
import {
  expectHostHandles,
  hostControlSet,
  overrideCreateControls,
  snapshotControls,
} from './host-controls.js';

initFabricModule();

const id = createAnnotationId('shape-controls');
/** What a drawn or imported shape gets: stroke 2, uniform. */
const LIBRARY_OPTIONS = getFabricOptions(DEFAULT_ANNOTATION_STYLE, id);
/** Floating-point error only: anything wrong is off by a sizeable fraction of a pixel. */
const TOL = 1e-6;
/** `toObject()` rounds to 4 decimals, scale included: a reloaded circle may differ this much. */
const SAVED_TOL = 1e-2;

const CIRCLE: CircleGeometry = { type: 'circle', center: { x: 300.5, y: 240.25 }, radius: 80 };

function add(a: Point, b: Point, k = 1): Point {
  return { x: a.x + k * b.x, y: a.y + k * b.y };
}

function asCircle(geometry: Geometry | null): CircleGeometry {
  expect(geometry).not.toBeNull();
  if (geometry === null || geometry.type !== 'circle') {
    throw new Error(`expected circle geometry, got ${JSON.stringify(geometry)}`);
  }
  return geometry;
}

/**
 * Where Fabric paints a `Circle`'s outline, excluding the stroke: `_render`
 * draws an arc of `radius` about the object's own origin, and
 * `calcTransformMatrix()` is the transform it renders with (position, angle,
 * scale, flip, skew). `samples` points, evenly spaced around it.
 */
function paintedCircle(circle: Circle, samples = 72): Point[] {
  const matrix = circle.calcTransformMatrix();
  return Array.from({ length: samples }, (_, i) => {
    const t = (2 * Math.PI * i) / samples;
    const p = util.transformPoint(
      { x: circle.radius * Math.cos(t), y: circle.radius * Math.sin(t) },
      matrix,
    );
    return { x: p.x, y: p.y };
  });
}

/** How far the painted outline strays from the stored circle: 0 when it is that circle. */
function deviationFrom(circle: Circle, stored: CircleGeometry): number {
  return Math.max(
    ...paintedCircle(circle).map((p) =>
      Math.abs(Math.hypot(p.x - stored.center.x, p.y - stored.center.y) - stored.radius),
    ),
  );
}

function expectPaintedAs(circle: Circle, stored: CircleGeometry, tolerance: number, what: string) {
  expect(
    deviationFrom(circle, stored),
    `${what}: painted with scale ${circle.scaleX}×${circle.scaleY}, skew ${circle.skewX}/${circle.skewY}, stored ${JSON.stringify(stored)}`,
  ).toBeLessThanOrEqual(tolerance);
}

/** A point of the circle's own frame (the unit square about its centre, scaled by its radius), where it is painted. */
function paintedAt(circle: Circle, local: Point): Point {
  const p = util.transformPoint(
    { x: local.x * circle.radius, y: local.y * circle.radius },
    circle.calcTransformMatrix(),
  );
  return { x: p.x, y: p.y };
}

function saved(geometry: CircleGeometry, object: FabricObject): Annotation<FabricFields> {
  return {
    id,
    geometry,
    toolType: 'circle',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    // Through JSON, as a host stores it.
    rawAnnotationData: JSON.parse(
      JSON.stringify(serializeFabricObject(object)),
    ) as FabricRawAnnotationData,
  };
}

// ── The three ways a circle reaches the canvas ───────────────────────────────

const imageId = createImageId('shape-controls-image');
const contextId = createAnnotationContextId('shape-controls-context');

/** Drawn with `CircleTool`: pressed at the centre, released `radius` to its right. */
function drawnCircle(geometry: CircleGeometry): Circle {
  const canvas = createMockCanvas();
  const overlay = createMockToolOverlay(canvas);
  const added: AddAnnotationParams[] = [];
  const callbacks: ToolCallbacks = {
    getActiveContextId: () => contextId,
    getToolConstraint: (type) => ({ type }),
    canAddAnnotation: () => true,
    addAnnotation: (params) => {
      added.push(params);
    },
    updateAnnotation: vi.fn(),
    deleteAnnotation: vi.fn(),
    setSelectedAnnotation: vi.fn(),
    getAnnotation: () => undefined,
  };
  const tool = new CircleTool();
  tool.activate(overlay, imageId, callbacks, createTestKeyboardShortcuts());
  const press = { type: 'pointerdown' } as PointerEvent;
  overlay.stampPress(press);
  const edge = add(geometry.center, { x: geometry.radius, y: 0 });
  tool.onPointerDown(press, geometry.center);
  tool.onPointerMove({ type: 'pointermove' } as PointerEvent, edge);
  tool.onPointerUp({ type: 'pointerup' } as PointerEvent, edge);
  expect(added).toHaveLength(1);
  return expectFabricInstance(added[0]!.fabricObject, Circle);
}

/**
 * Revived from saved data the way the viewer rebuilds every object after a
 * change. The data is written from a plain `Circle`, not one the library
 * built: Fabric does not serialize controls, so whatever the revived object
 * has, `createFabricObjectFromRawData` gave it.
 */
async function revivedCircle(geometry: CircleGeometry): Promise<Circle> {
  const plain = new Circle({
    ...LIBRARY_OPTIONS,
    left: geometry.center.x,
    top: geometry.center.y,
    radius: geometry.radius,
    originX: 'center',
    originY: 'center',
  });
  const revived = await createFabricObjectFromRawData(saved(geometry, plain));
  expect(revived).not.toBeNull();
  return expectFabricInstance(revived!, Circle);
}

const HOW = ['built from geometry', 'revived from saved data', 'drawn with CircleTool'] as const;

async function circleThatWas(how: (typeof HOW)[number], geometry = CIRCLE): Promise<Circle> {
  switch (how) {
    case 'built from geometry':
      return expectFabricInstance(buildFabricObjectFromGeometry(geometry, LIBRARY_OPTIONS), Circle);
    case 'revived from saved data':
      return revivedCircle(geometry);
    case 'drawn with CircleTool':
      return drawnCircle(geometry);
  }
}

// ── A canvas configured as FabricOverlay configures its own ──────────────────

const editorCanvases: Canvas[] = [];

afterEach(async () => {
  await Promise.all(
    editorCanvases.splice(0).map(async (canvas) => {
      const element = canvas.lowerCanvasEl;
      await canvas.dispose();
      element.remove();
    }),
  );
});

/** `object` on a canvas set up as the overlay sets up its own, selected; every `object:modified` target is recorded. */
function openInEditor(object: FabricObject) {
  const element = document.createElement('canvas');
  document.body.appendChild(element);
  const canvas = new Canvas(element, {
    width: 800,
    height: 600,
    selection: false,
    renderOnAddRemove: false,
    skipOffscreen: false,
    enablePointerEvents: true,
  });
  editorCanvases.push(canvas);
  canvas.add(object);
  canvas.setActiveObject(object);
  object.setCoords();
  const modified: FabricObject[] = [];
  canvas.on('object:modified', ({ target }) => {
    modified.push(target);
  });
  return { canvas, modified };
}

/**
 * One forwarded pointer event, as `FabricOverlay._forwardToFabric` sends it:
 * the press on the upper canvas without bubbling, the move and release
 * bubbling. jsdom has no `PointerEvent`; Fabric reads only clientX/clientY,
 * button and the modifier keys, so a `MouseEvent` of the pointer event's type
 * stands in for it. The canvas sits at (0, 0) with an identity viewport, so
 * client coordinates are image coordinates.
 */
function forward(
  canvas: Canvas,
  type: 'pointerdown' | 'pointermove' | 'pointerup',
  at: Point,
  shiftKey: boolean,
): void {
  canvas.upperCanvasEl.dispatchEvent(
    new MouseEvent(type, {
      clientX: at.x,
      clientY: at.y,
      bubbles: type !== 'pointerdown',
      cancelable: true,
      button: 0,
      shiftKey,
    }),
  );
}

function gesture(canvas: Canvas, from: Point, to: Point, shiftKey = false): void {
  forward(canvas, 'pointerdown', from, shiftKey);
  forward(canvas, 'pointermove', { x: (from.x + to.x) / 2, y: (from.y + to.y) / 2 }, shiftKey);
  forward(canvas, 'pointermove', to, shiftKey);
  forward(canvas, 'pointerup', to, shiftKey);
}

/** A press on control `key`, a fraction of a pixel off its centre, as a user's would be. */
function pressOn(object: FabricObject, key: string): Point {
  const coord = object.oCoords[key];
  expect(coord, `control ${key}`).toBeDefined();
  return { x: coord!.x + 0.31, y: coord!.y + 0.17 };
}

/** The `action` of every `object:modified`, which hosts and Fabric's own centring read. */
function reportedActions(canvas: Canvas): (string | undefined)[] {
  const actions: (string | undefined)[] = [];
  canvas.on('object:modified', ({ action }) => {
    actions.push(action);
  });
  return actions;
}

function onlyModified(modified: readonly FabricObject[]): FabricObject {
  expect(modified, 'one object:modified').toHaveLength(1);
  return modified[0]!;
}

// ── Circles ──────────────────────────────────────────────────────────────────

describe('a circle can only be scaled uniformly', () => {
  it.each(HOW)(
    'a circle %s has four corner handles and a rotation handle, no side handles',
    async (how) => {
      const circle = await circleThatWas(how);
      expect(Object.keys(circle.controls).sort()).toEqual(['bl', 'br', 'mtr', 'tl', 'tr']);
    },
  );

  it.each(HOW)(
    'Shift + a corner handle scales a circle %s uniformly, about the opposite corner',
    async (how) => {
      const circle = await circleThatWas(how);
      const { canvas, modified } = openInEditor(circle);
      const anchor = paintedAt(circle, { x: -1, y: -1 });
      const press = pressOn(circle, 'br');
      // Further right than down: a free scale would stretch it into an ellipse.
      gesture(canvas, press, add(press, { x: 40, y: -15 }), true);

      expect(onlyModified(modified)).toBe(circle);
      expect(circle.skewX).toBe(0);
      expect(circle.skewY).toBe(0);
      expect(circle.scaleX, 'scaled uniformly').toBe(circle.scaleY);
      expect(circle.scaleX, 'the drag grew it').toBeGreaterThan(1.05);
      const stored = asCircle(getGeometryFromFabricObject(circle, 'circle'));
      expectPaintedAs(circle, stored, TOL, `${how}, after Shift + br`);
      const moved = paintedAt(circle, { x: -1, y: -1 });
      expect(
        Math.hypot(moved.x - anchor.x, moved.y - anchor.y),
        'the opposite corner stays',
      ).toBeLessThanOrEqual(TOL);

      // What the viewer then rebuilds from the saved data is that circle too.
      const reloaded = await createFabricObjectFromRawData(saved(stored, circle));
      expect(reloaded).not.toBeNull();
      expectPaintedAs(
        expectFabricInstance(reloaded!, Circle),
        stored,
        SAVED_TOL,
        `${how}, reloaded`,
      );
    },
  );

  it('a corner handle without Shift scales a circle uniformly, as Fabric does by default', async () => {
    const circle = await circleThatWas('built from geometry');
    const { canvas, modified } = openInEditor(circle);
    const press = pressOn(circle, 'tl');
    gesture(canvas, press, add(press, { x: -12, y: -30 }));
    onlyModified(modified);
    expect(circle.scaleX).toBe(circle.scaleY);
    expect(circle.scaleX).toBeGreaterThan(1.05);
    expectPaintedAs(
      circle,
      asCircle(getGeometryFromFabricObject(circle, 'circle')),
      TOL,
      'after tl',
    );
  });

  it.each(HOW)(
    'Shift + a press where a side handle used to be moves a circle %s; it stays round',
    async (how) => {
      const circle = await circleThatWas(how);
      const { canvas, modified } = openInEditor(circle);
      // Just inside the right edge, where the mr handle was: with Shift,
      // dragging it down would have sheared the circle (skewY).
      const press = { x: CIRCLE.center.x + CIRCLE.radius - 3.25, y: CIRCLE.center.y + 0.17 };
      gesture(canvas, press, add(press, { x: 0, y: 40 }), true);

      expect(onlyModified(modified)).toBe(circle);
      expect(circle.skewX).toBe(0);
      expect(circle.skewY).toBe(0);
      expect(circle.scaleX).toBe(1);
      expect(circle.scaleY).toBe(1);
      const stored = asCircle(getGeometryFromFabricObject(circle, 'circle'));
      expect(stored.radius).toBe(CIRCLE.radius);
      expect(stored.center.x).toBeCloseTo(CIRCLE.center.x, 9);
      expect(stored.center.y, 'the press took the body and moved it').toBeCloseTo(
        CIRCLE.center.y + 40,
        9,
      );
      expectPaintedAs(circle, stored, TOL, `${how}, after the drag`);
    },
  );

  it('the rotation handle turns a circle; its stored circle does not change', async () => {
    const circle = await circleThatWas('built from geometry');
    const { canvas, modified } = openInEditor(circle);
    const press = pressOn(circle, 'mtr');
    // From above the centre round to its right: a quarter turn.
    gesture(canvas, press, { x: CIRCLE.center.x + 150, y: CIRCLE.center.y });
    onlyModified(modified);
    expect(circle.angle).toBeCloseTo(90, 0);
    const stored = asCircle(getGeometryFromFabricObject(circle, 'circle'));
    expect(stored.radius).toBe(CIRCLE.radius);
    expect(stored.center.x).toBeCloseTo(CIRCLE.center.x, 9);
    expect(stored.center.y).toBeCloseTo(CIRCLE.center.y, 9);
    expectPaintedAs(circle, stored, TOL, 'after a quarter turn');
  });
});

describe('a circle saved stretched or sheared, before circles were kept round', () => {
  /** As the select tool's handles could leave a circle until they were constrained. */
  const SAVED = [
    { name: 'stretched by a side handle', props: { scaleX: 1.5, scaleY: 1 } },
    { name: 'stretched by Shift + a corner', props: { scaleX: 1.4163, scaleY: 0.7504 } },
    { name: 'sheared by Shift + a side handle', props: { skewX: 20 } },
  ] as const;

  it.each(SAVED)(
    'a circle $name is revived as saved, read back by the documented rule, and gets the circle handles',
    async ({ props }) => {
      const object = new Circle({
        ...LIBRARY_OPTIONS,
        left: CIRCLE.center.x,
        top: CIRCLE.center.y,
        radius: CIRCLE.radius,
        originX: 'center',
        originY: 'center',
        ...props,
      });
      // Its saved geometry is what the release that saved it read back.
      const geometry = asCircle(getGeometryFromFabricObject(object, 'circle'));
      const revived = expectFabricInstance(
        (await createFabricObjectFromRawData(saved(geometry, object)))!,
        Circle,
      );

      // Painted as saved: nothing is corrected on load.
      expect(revived.scaleX).toBe(object.scaleX);
      expect(revived.scaleY).toBe(object.scaleY);
      expect(revived.skewX).toBe(object.skewX);
      expect(revived.skewY).toBe(object.skewY);
      const painted = paintedCircle(revived);
      paintedCircle(object).forEach((p, i) => {
        expect(Math.hypot(p.x - painted[i]!.x, p.y - painted[i]!.y)).toBeLessThanOrEqual(TOL);
      });
      // Read back as a circle of radius `radius * max(|scaleX|, |scaleY|)`
      // about its centre: not the shape painted, which no circle describes.
      const back = asCircle(getGeometryFromFabricObject(revived, 'circle'));
      expect(back.radius).toBe(CIRCLE.radius * Math.max(object.scaleX, object.scaleY));
      expect(back.center.x).toBeCloseTo(CIRCLE.center.x, 9);
      expect(back.center.y).toBeCloseTo(CIRCLE.center.y, 9);
      expect(deviationFrom(revived, back)).toBeGreaterThan(1);
      // Its handles cannot stretch or shear it further.
      expect(Object.keys(revived.controls).sort()).toEqual(['bl', 'br', 'mtr', 'tl', 'tr']);
    },
  );
});

// ── Lines, polylines and polygons ────────────────────────────────────────────

describe("lines, polylines and polygons keep Fabric's own controls", () => {
  /**
   * Their stored points are read through the object's whole transform
   * (`calcTransformMatrix`), so a shear is part of what is stored: Shift + a
   * side handle still shears them, and the stored points follow.
   */
  const SHAPES: readonly { readonly name: string; readonly geometry: VectorGeometry }[] = [
    {
      name: 'line',
      geometry: { type: 'line', start: { x: 200, y: 150 }, end: { x: 400, y: 250 } },
    },
    {
      name: 'polyline',
      geometry: {
        type: 'polyline',
        points: [
          { x: 200, y: 150 },
          { x: 300, y: 250 },
          { x: 400, y: 150 },
        ],
      },
    },
    {
      name: 'polygon',
      geometry: {
        type: 'polygon',
        points: [
          { x: 200, y: 150 },
          { x: 400, y: 150 },
          { x: 400, y: 250 },
          { x: 200, y: 250 },
        ],
      },
    },
  ];

  function pointsOf(geometry: Geometry | null): readonly Point[] {
    expect(geometry).not.toBeNull();
    switch (geometry!.type) {
      case 'line':
        return [geometry!.start, geometry!.end];
      case 'polyline':
      case 'polygon':
        return geometry!.points;
      default:
        throw new Error(`unexpected ${geometry!.type}`);
    }
  }

  it.each(SHAPES)(
    'Shift + the bottom handle shears a $name about its top edge, and its stored points follow',
    async ({ geometry }) => {
      const object = buildFabricObjectFromGeometry(geometry, {
        ...LIBRARY_OPTIONS,
        strokeWidth: 0,
      });
      expect(
        object instanceof Line || object instanceof Polyline || object instanceof Polygon,
      ).toBe(true);
      expect(Object.keys(object.controls).sort()).toEqual([
        'bl',
        'br',
        'mb',
        'ml',
        'mr',
        'mt',
        'mtr',
        'tl',
        'tr',
      ]);
      const { canvas, modified } = openInEditor(object);
      const press = pressOn(object, 'mb');
      gesture(canvas, press, add(press, { x: 30, y: 0 }), true);
      onlyModified(modified);
      expect(object.skewX, 'Fabric sheared it').not.toBe(0);

      const before = pointsOf(geometry);
      const after = pointsOf(getGeometryFromFabricObject(object, geometry.type));
      expect(after).toHaveLength(before.length);
      // A shear about the top edge (y = 150): every point moves right in
      // proportion to how far below that edge it is, and not at all vertically.
      const bottom = before.findIndex((p) => p.y === 250);
      const shear = (after[bottom]!.x - before[bottom]!.x) / 100;
      expect(shear).toBeGreaterThan(0.2);
      before.forEach((p, i) => {
        expect(after[i]!.y, `point ${i}: y`).toBeCloseTo(p.y, 6);
        expect(after[i]!.x, `point ${i}: x`).toBeCloseTo(p.x + shear * (p.y - 150), 6);
      });
    },
  );
});

// ── applyShapeControls itself ────────────────────────────────────────────────

describe('applyShapeControls', () => {
  it("gives a rectangle Fabric's handles, with side handles that only scale", () => {
    const rect = new Rect({ width: 10, height: 10 });
    const defaults = controlsUtils.createObjectDefaultControls();
    applyShapeControls(rect, 'rectangle');
    expect(Object.keys(rect.controls).sort()).toEqual(Object.keys(defaults).sort());
    for (const key of ['ml', 'mr'] as const) {
      expect(rect.controls[key]!.actionHandler, key).toBe(controlsUtils.scalingX);
      expect(rect.controls[key]!.actionName, key).toBe('scaleX');
    }
    for (const key of ['mt', 'mb'] as const) {
      expect(rect.controls[key]!.actionHandler, key).toBe(controlsUtils.scalingY);
      expect(rect.controls[key]!.actionName, key).toBe('scaleY');
    }
    for (const key of ['tl', 'tr', 'bl', 'br', 'mtr'] as const) {
      expect(rect.controls[key]!.actionHandler, key).toBe(defaults[key]!.actionHandler);
      expect(rect.controls[key]!.x, key).toBe(defaults[key]!.x);
      expect(rect.controls[key]!.y, key).toBe(defaults[key]!.y);
    }
  });

  it('gives every object its own set of controls', () => {
    const a = new Circle({ radius: 5 });
    const b = new Circle({ radius: 5 });
    applyShapeControls(a, 'circle');
    applyShapeControls(b, 'circle');
    expect(a.controls).not.toBe(b.controls);
    expect(a.controls['br']).not.toBe(b.controls['br']);
  });

  it.each(['line', 'polyline', 'polygon', 'point'] as const)('leaves a %s as it was', (type) => {
    const object = new Polyline([
      { x: 0, y: 0 },
      { x: 10, y: 10 },
    ]);
    const before = object.controls;
    applyShapeControls(object, type);
    expect(object.controls).toBe(before);
  });

  it.each([
    ['mr', 'scaleX'],
    ['mb', 'scaleY'],
  ] as const)("reports Shift + a rectangle's %s handle as %s, not a skew", (key, expected) => {
    const rect = expectFabricInstance(
      buildFabricObjectFromGeometry(
        { type: 'rectangle', origin: { x: 200, y: 100 }, width: 100, height: 50, rotation: 0 },
        LIBRARY_OPTIONS,
      ),
      Rect,
    );
    const { canvas, modified } = openInEditor(rect);
    const actions = reportedActions(canvas);
    const press = pressOn(rect, key);
    gesture(canvas, press, add(press, { x: 30, y: 30 }), true);
    expect(onlyModified(modified)).toBe(rect);
    expect(actions).toEqual([expected]);
    expect(rect.skewX).toBe(0);
    expect(rect.skewY).toBe(0);
  });

  it("leaves the canvas's Shift settings as they were: a rectangle's corner still scales freely with Shift after a circle's", async () => {
    const circle = await circleThatWas('built from geometry');
    const { canvas } = openInEditor(circle);
    const circlePress = pressOn(circle, 'br');
    gesture(canvas, circlePress, add(circlePress, { x: 40, y: -15 }), true);
    expect(circle.scaleX).toBe(circle.scaleY);
    expect(canvas.uniScaleKey).toBe('shiftKey');
    expect(canvas.uniformScaling).toBe(true);

    const rect = buildFabricObjectFromGeometry(
      { type: 'rectangle', origin: { x: 500, y: 100 }, width: 100, height: 50, rotation: 0 },
      LIBRARY_OPTIONS,
    );
    canvas.add(rect);
    canvas.setActiveObject(rect);
    rect.setCoords();
    const rectPress = pressOn(rect, 'br');
    gesture(canvas, rectPress, add(rectPress, { x: 40, y: -15 }), true);
    expect(rect.scaleX).toBeGreaterThan(1.3);
    expect(rect.scaleY).toBeLessThan(0.8);
  });
});

// ── Controls a host customised ───────────────────────────────────────────────

/**
 * A host customises handles the way Fabric documents, by overriding
 * `createControls`, and the library constrains only the handlers it must.
 * Until the fix it replaced a rectangle's or circle's whole set with Fabric's
 * defaults, on every rebuild: a rotation handle the host had removed came
 * back, and its renderers were lost.
 */
describe('applyShapeControls on controls a host customised', () => {
  let restore: (() => void) | undefined;
  afterEach(() => {
    restore?.();
    restore = undefined;
  });

  const RECTANGLE: VectorGeometry = {
    type: 'rectangle',
    origin: { x: 200, y: 150 },
    width: 160,
    height: 90,
    rotation: 0,
  };

  /** A rectangle as the viewer revives one, from data saved off a plain `Rect`. */
  async function revivedRectangle(): Promise<Rect> {
    if (RECTANGLE.type !== 'rectangle') throw new Error('not a rectangle');
    const plain = new Rect({
      ...LIBRARY_OPTIONS,
      left: RECTANGLE.origin.x + RECTANGLE.width / 2,
      top: RECTANGLE.origin.y + RECTANGLE.height / 2,
      width: RECTANGLE.width,
      height: RECTANGLE.height,
    });
    const revived = await createFabricObjectFromRawData({
      id,
      geometry: RECTANGLE,
      toolType: 'rectangle',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      rawAnnotationData: JSON.parse(
        JSON.stringify(serializeFabricObject(plain)),
      ) as FabricRawAnnotationData,
    });
    expect(revived).not.toBeNull();
    return expectFabricInstance(revived!, Rect);
  }

  const RECTANGLE_WAYS = ['built from geometry', 'revived from saved data'] as const;

  async function rectangleThatWas(how: (typeof RECTANGLE_WAYS)[number]): Promise<Rect> {
    return how === 'built from geometry'
      ? expectFabricInstance(buildFabricObjectFromGeometry(RECTANGLE, LIBRARY_OPTIONS), Rect)
      : revivedRectangle();
  }

  it.each(RECTANGLE_WAYS)(
    "a rectangle %s keeps the host's handles; Shift + a side handle still only scales it",
    async (how) => {
      restore = overrideCreateControls(hostControlSet);
      const rect = await rectangleThatWas(how);

      expect(Object.keys(rect.controls).sort(), 'the removed rotation handle came back').toEqual([
        'bl',
        'br',
        'mb',
        'ml',
        'mr',
        'mt',
        'tl',
        'tr',
      ]);
      expectHostHandles(rect, how);
      for (const key of ['ml', 'mr'] as const) {
        expect(rect.controls[key]!.actionHandler, key).toBe(controlsUtils.scalingX);
      }
      for (const key of ['mt', 'mb'] as const) {
        expect(rect.controls[key]!.actionHandler, key).toBe(controlsUtils.scalingY);
      }

      const { canvas, modified } = openInEditor(rect);
      const actions = reportedActions(canvas);
      const press = pressOn(rect, 'mr');
      gesture(canvas, press, add(press, { x: 40, y: 30 }), true);
      expect(onlyModified(modified)).toBe(rect);
      // A side handle copied from Fabric's defaults keeps its skew-aware
      // getActionName, which would report the scale as a skew with Shift held.
      expect(actions, 'the action Fabric reports').toEqual(['scaleX']);
      expect(rect.skewX).toBe(0);
      expect(rect.skewY).toBe(0);
      expect(rect.scaleX, 'the drag scaled it').toBeGreaterThan(1.2);
      expect(rect.scaleY).toBe(1);
    },
  );

  it.each(HOW)(
    "a circle %s keeps the host's handles; Shift + a corner handle still scales it uniformly",
    async (how) => {
      restore = overrideCreateControls(hostControlSet);
      const circle = await circleThatWas(how);

      expect(Object.keys(circle.controls).sort(), 'the removed rotation handle came back').toEqual([
        'bl',
        'br',
        'tl',
        'tr',
      ]);
      expectHostHandles(circle, how);

      const { canvas, modified } = openInEditor(circle);
      const press = pressOn(circle, 'br');
      gesture(canvas, press, add(press, { x: 40, y: -15 }), true);
      expect(onlyModified(modified)).toBe(circle);
      expect(circle.scaleX, 'scaled uniformly').toBe(circle.scaleY);
      expect(circle.scaleX, 'the drag grew it').toBeGreaterThan(1.05);
      expect(circle.skewX).toBe(0);
      expect(circle.skewY).toBe(0);
    },
  );

  it('leaves a set the host shares among all objects as it was', async () => {
    const shared = hostControlSet();
    const before = snapshotControls(shared);
    restore = overrideCreateControls(() => shared);

    const rect = await rectangleThatWas('revived from saved data');
    const circle = await circleThatWas('revived from saved data');
    const line = buildFabricObjectFromGeometry(
      { type: 'line', start: { x: 10, y: 10 }, end: { x: 90, y: 40 } },
      LIBRARY_OPTIONS,
    );

    expect(snapshotControls(shared), 'a shared control was changed').toEqual(before);
    // The constrained objects have sets of their own; the line, which keeps
    // what Fabric gave it, still has the shared one, skewing side handles and all.
    expect(rect.controls).not.toBe(shared);
    expect(circle.controls).not.toBe(shared);
    expect(line.controls).toBe(shared);
    expect(line.controls['mr']!.actionHandler).toBe(controlsUtils.scalingXOrSkewingY);
    // The controls the shapes did not need to change are still the shared instances.
    expect(rect.controls['tl']).toBe(shared['tl']);
    expect(rect.controls['mr']).not.toBe(shared['mr']);
    expect(circle.controls['br']).not.toBe(shared['br']);
  });

  it.each([
    ["Fabric's own handles", undefined],
    ["the host's handles", hostControlSet],
  ] as const)('applying it again changes nothing, on %s', async (_name, make) => {
    if (make) restore = overrideCreateControls(make);
    const rect = await rectangleThatWas('built from geometry');
    const circle = await circleThatWas('built from geometry');
    for (const [object, type] of [
      [rect, 'rectangle'],
      [circle, 'circle'],
    ] as const) {
      const controls = object.controls;
      const each = { ...controls };
      applyShapeControls(object, type);
      expect(object.controls, type).toBe(controls);
      expect(object.controls, type).toEqual(each);
      for (const key of Object.keys(each)) {
        expect(object.controls[key], `${type}: ${key}`).toBe(each[key]);
      }
    }
  });
});
