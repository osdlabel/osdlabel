/**
 * Part of the rectangle suite (every test file with "rectangle" in its name).
 *
 * Pins, for the Fabric layer: what the library paints for a rectangle is the
 * shape its geometry describes, and the geometry it reads back is what is
 * painted. Until #244 every rectangle was painted centred on the corner its
 * geometry recorded, and no test compared the two. Here they are compared at
 * every step that turns one into the other:
 *
 * - `buildFabricObjectFromGeometry`: painted corners == the geometry's corners;
 * - `getGeometryFromFabricObject`: the exact inverse of the builder, and for a
 *   `Rect` the library did not build (any origin, scale, flip, stroke) a
 *   geometry whose corners are the painted ones;
 * - `serializeFabricObject` → `createFabricObjectFromRawData`: unchanged to
 *   within `toObject()`'s rounding;
 * - edits made through Fabric's own controls (move, rotate, resize, flip): the
 *   stored geometry follows the painted shape, a rotation changes only
 *   `rotation`, a move only `origin`, a resize keeps the opposite side fixed;
 * - Shift, which Fabric's default side handles take as "skew" (a
 *   parallelogram no rectangle geometry describes): a rectangle's side
 *   handles only scale, however it reached the canvas, so Shift + a side
 *   handle does what the handle does without it; data saved skewed still
 *   paints as saved, and reads back as the box about the same centre;
 * - `RectangleTool`: the preview and the committed object cover the dragged box;
 * - data saved by releases up to 0.21.0: `migrateLegacyRectangle` gives a
 *   rotated one the origin it is painted at, with the expected values written
 *   out by hand (`legacy-rectangle.test.ts` covers the rest of the migration).
 *
 * "Painted corners" are the `Rect`'s own transform applied to its
 * `(±width/2, ±height/2)`, excluding the stroke (see `paintedCorners` in
 * `rectangle-reference.ts`); the raster tests check the contract against real
 * rendered pixels as well. The expected corners come from `referenceCorners`,
 * an independent implementation of the contract pinned to the worked example
 * below by hand. The rotations, positions and sizes swept are that module's
 * `ROTATIONS`, `POSITIONS` and `SIZES`.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  Canvas,
  Rect,
  StaticCanvas,
  type FabricObject,
  type TOriginX,
  type TOriginY,
} from 'fabric';
import {
  DEFAULT_ANNOTATION_STYLE,
  createAnnotationId,
  type Annotation,
  type AnnotationStyle,
  type Geometry,
  type Point,
  type RectangleGeometry,
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
import { migrateLegacyRectangle } from '../../src/legacy-rectangle.js';
import { RectangleTool } from '../../src/tools/rectangle-tool.js';
import type { AddAnnotationParams, ToolCallbacks } from '../../src/tools/base-tool.js';
import type { FabricFields, FabricRawAnnotationData } from '../../src/types.js';
import {
  createMockCanvas,
  createMockToolOverlay,
  createTestKeyboardShortcuts,
  expectFabricInstance,
} from './test-helpers.js';
import {
  ROTATIONS,
  cornerDeviation,
  cornerSetDeviation,
  dragBoxCorners,
  formatCorners,
  label,
  matrixAt,
  paintedCorners,
  rectangle,
  referenceCorners,
  rotateAbout,
  seededRandom,
  type Corners,
  type RectangleShape,
} from './rectangle-reference.js';

// Register `id` as a custom property so toObject() saves it, as an overlay would.
initFabricModule();

const id = createAnnotationId('rect-suite');

/** What a drawn or imported rectangle gets: stroke 2, uniform. */
const LIBRARY_OPTIONS = getFabricOptions(DEFAULT_ANNOTATION_STYLE, id);

/** Opaque black, no stroke: what the raster tests render, built the library's own way. */
const RASTER_STYLE: AnnotationStyle = {
  ...DEFAULT_ANNOTATION_STYLE,
  fillColor: '#000000',
  fillOpacity: 1,
  strokeWidth: 0,
  opacity: 1,
};
const RASTER_OPTIONS = getFabricOptions(RASTER_STYLE, id);

/**
 * Coordinates here are at most a few tens of thousands of pixels, where double
 * rounding is around 1e-11; anything that is actually wrong is off by a
 * sizeable fraction of a pixel.
 */
const TOL = 1e-6;

/** `toObject()` rounds to 4 decimals; a saved and reloaded rectangle may move this much. */
const SAVED_TOL = 1e-3;

/** The worked example: centre (250, 125); at 90° it covers x 225–275, y 75–175. */
const WORKED = { origin: { x: 200, y: 100 }, width: 100, height: 50 } as const;
const WORKED_AT_0: Corners = [
  { x: 200, y: 100 },
  { x: 300, y: 100 },
  { x: 300, y: 150 },
  { x: 200, y: 150 },
];
const WORKED_AT_90: Corners = [
  { x: 275, y: 75 },
  { x: 275, y: 175 },
  { x: 225, y: 175 },
  { x: 225, y: 75 },
];

function asRectangle(geometry: Geometry | null): RectangleGeometry {
  expect(geometry).not.toBeNull();
  if (geometry === null || geometry.type !== 'rectangle') {
    throw new Error(`expected rectangle geometry, got ${JSON.stringify(geometry)}`);
  }
  return geometry;
}

function readBack(object: FabricObject): RectangleGeometry {
  return asRectangle(getGeometryFromFabricObject(object, 'rectangle'));
}

function build(geometry: RectangleGeometry, options = LIBRARY_OPTIONS): Rect {
  return expectFabricInstance(buildFabricObjectFromGeometry(geometry, options), Rect);
}

/**
 * `object` saved with `geometry` and revived as the viewer revives every
 * stored annotation, through JSON. Fabric does not serialize controls, so the
 * revived `Rect`'s controls are whatever `createFabricObjectFromRawData` gave it.
 */
async function revive(
  geometry: RectangleGeometry,
  object: FabricObject = build(geometry),
): Promise<Rect> {
  const revived = await createFabricObjectFromRawData({
    id,
    geometry,
    toolType: 'rectangle',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    rawAnnotationData: JSON.parse(
      JSON.stringify(serializeFabricObject(object)),
    ) as FabricRawAnnotationData,
  });
  expect(revived).not.toBeNull();
  return expectFabricInstance(revived!, Rect);
}

/** The `Rect` RectangleTool commits for a drag from `a` to `b`. */
function drawnWithTool(a: Point, b: Point): Rect {
  const overlay = createMockToolOverlay(createMockCanvas());
  const added: AddAnnotationParams[] = [];
  const callbacks: ToolCallbacks = {
    getActiveContextId: () => createAnnotationContextId('rect-suite-context'),
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
  const tool = new RectangleTool();
  tool.activate(
    overlay,
    createImageId('rect-suite-image'),
    callbacks,
    createTestKeyboardShortcuts(),
  );
  const press = { type: 'pointerdown' } as PointerEvent;
  overlay.stampPress(press);
  tool.onPointerDown(press, a);
  tool.onPointerMove({ type: 'pointermove' } as PointerEvent, b);
  tool.onPointerUp({ type: 'pointerup' } as PointerEvent, b);
  expect(added).toHaveLength(1);
  return expectFabricInstance(added[0]!.fabricObject, Rect);
}

/** tan 20°: the skew a Shift + side-handle drag left on the worked example in the audit. */
const TAN_20 = Math.tan((20 * Math.PI) / 180);

/**
 * The worked example with `skewX: 20`: Fabric shears the box about its centre
 * (250, 125), x' = x + tan 20° · y in the box's own frame, so the top edge
 * moves left by 25 · tan 20° and the bottom edge right by as much.
 */
const WORKED_SKEWED_X20: Corners = [
  { x: 200 - 25 * TAN_20, y: 100 },
  { x: 300 - 25 * TAN_20, y: 100 },
  { x: 300 + 25 * TAN_20, y: 150 },
  { x: 200 + 25 * TAN_20, y: 150 },
];

/** The worked example saved with `skewX: 20`, as releases before side handles were constrained could leave it. */
function workedSkewedX20(): Rect {
  return new Rect({
    ...LIBRARY_OPTIONS,
    left: 250,
    top: 125,
    width: 100,
    height: 50,
    originX: 'center',
    originY: 'center',
    skewX: 20,
  });
}

/** Each field of `actual` within `tolerance` of `expected`. */
function expectShapeClose(
  actual: RectangleShape,
  expected: RectangleShape,
  tolerance: number,
  what = label(expected),
): void {
  const deviations = {
    'origin.x': actual.origin.x - expected.origin.x,
    'origin.y': actual.origin.y - expected.origin.y,
    width: actual.width - expected.width,
    height: actual.height - expected.height,
    rotation: actual.rotation - expected.rotation,
  };
  for (const [field, deviation] of Object.entries(deviations)) {
    expect(
      Math.abs(deviation),
      `${what}: ${field} read back as ${label(actual)}`,
    ).toBeLessThanOrEqual(tolerance);
  }
}

function expectCorners(actual: Corners, expected: Corners, tolerance: number, what: string): void {
  expect(
    cornerDeviation(actual, expected),
    `${what}\n  painted  ${formatCorners(actual)}\n  expected ${formatCorners(expected)}`,
  ).toBeLessThanOrEqual(tolerance);
}

function expectSameCornerSet(
  actual: Corners,
  expected: Corners,
  tolerance: number,
  what: string,
): void {
  expect(
    cornerSetDeviation(actual, expected),
    `${what}\n  painted  ${formatCorners(actual)}\n  expected ${formatCorners(expected)}`,
  ).toBeLessThanOrEqual(tolerance);
}

// ── Raster: what Fabric really draws ─────────────────────────────────────────

const RASTER_WIDTH = 400;
const RASTER_HEIGHT = 300;
/** Far enough from an edge that the whole pixel holding the probe is on one side of it. */
const PROBE_INSET = 2.5;

function add(a: Point, b: Point, k = 1): Point {
  return { x: a.x + k * b.x, y: a.y + k * b.y };
}

function unit(from: Point, to: Point): Point {
  const length = Math.hypot(to.x - from.x, to.y - from.y);
  return { x: (to.x - from.x) / length, y: (to.y - from.y) / length };
}

interface Probe {
  readonly at: Point;
  readonly filled: boolean;
  readonly what: string;
}

/** Points just inside and just outside every corner and edge of `corners`, plus the centre. */
function probesFor(corners: Corners): Probe[] {
  const centre = {
    x: (corners[0].x + corners[1].x + corners[2].x + corners[3].x) / 4,
    y: (corners[0].y + corners[1].y + corners[2].y + corners[3].y) / 4,
  };
  const probes: Probe[] = [{ at: centre, filled: true, what: 'centre' }];
  corners.forEach((corner, i) => {
    const next = corners[(i + 1) % 4]!;
    const previous = corners[(i + 3) % 4]!;
    const inward = add(unit(corner, next), unit(corner, previous));
    probes.push({ at: add(corner, inward, PROBE_INSET), filled: true, what: `inside corner ${i}` });
    probes.push({
      at: add(corner, inward, -PROBE_INSET),
      filled: false,
      what: `outside corner ${i}`,
    });
    const middle = { x: (corner.x + next.x) / 2, y: (corner.y + next.y) / 2 };
    const outward = unit(centre, middle);
    probes.push({ at: add(middle, outward, -PROBE_INSET), filled: true, what: `inside edge ${i}` });
    probes.push({
      at: add(middle, outward, PROBE_INSET),
      filled: false,
      what: `outside edge ${i}`,
    });
  });
  return probes;
}

/**
 * Render `object` alone on white, one canvas pixel per image pixel, and list
 * every probe of `expected` whose pixel disagrees. The object must be opaque
 * black with no stroke ({@link RASTER_OPTIONS}).
 */
function rasterMismatches(object: FabricObject, expected: Corners): string[] {
  const canvas = new StaticCanvas(document.createElement('canvas'), {
    width: RASTER_WIDTH,
    height: RASTER_HEIGHT,
    backgroundColor: '#ffffff',
    enableRetinaScaling: false,
    renderOnAddRemove: false,
  });
  canvas.add(object);
  canvas.renderAll();
  const context = canvas.getContext();
  const mismatches: string[] = [];
  for (const probe of probesFor(expected)) {
    const x = Math.floor(probe.at.x);
    const y = Math.floor(probe.at.y);
    expect(x >= 0 && y >= 0 && x < RASTER_WIDTH && y < RASTER_HEIGHT, probe.what).toBe(true);
    const red = context.getImageData(x, y, 1, 1).data[0]!;
    const filled = red < 64;
    const empty = red > 191;
    if (probe.filled ? !filled : !empty) {
      mismatches.push(
        `${probe.what} at (${probe.at.x.toFixed(2)}, ${probe.at.y.toFixed(2)}): expected ${
          probe.filled ? 'filled' : 'empty'
        }, red channel ${red}`,
      );
    }
  }
  canvas.remove(object);
  return mismatches;
}

// ── The oracle ───────────────────────────────────────────────────────────────

describe('oracle self-check (pins the test reference, not the library)', () => {
  it('pins the worked example at rotation 0: x 200–300, y 100–150', () => {
    expect(referenceCorners({ ...WORKED, rotation: 0 })).toEqual(WORKED_AT_0);
  });

  it('pins the worked example at rotation 90: centre (250, 125), x 225–275, y 75–175', () => {
    // +90 takes the box's +x edge (top-left → top-right) onto image +y.
    expect(referenceCorners({ ...WORKED, rotation: 90 })).toEqual(WORKED_AT_90);
  });

  it('pins rotations 180, 270 and -90 by hand', () => {
    expect(referenceCorners({ ...WORKED, rotation: 180 })).toEqual([
      { x: 300, y: 150 },
      { x: 200, y: 150 },
      { x: 200, y: 100 },
      { x: 300, y: 100 },
    ]);
    const at270: Corners = [
      { x: 225, y: 175 },
      { x: 225, y: 75 },
      { x: 275, y: 75 },
      { x: 275, y: 175 },
    ];
    expect(referenceCorners({ ...WORKED, rotation: 270 })).toEqual(at270);
    expect(referenceCorners({ ...WORKED, rotation: -90 })).toEqual(at270);
  });

  it('pins a 45° square by hand', () => {
    const r2 = Math.SQRT2;
    expectCorners(
      referenceCorners({ origin: { x: 0, y: 0 }, width: 2, height: 2, rotation: 45 }),
      [
        { x: 1, y: 1 - r2 },
        { x: 1 + r2, y: 1 },
        { x: 1, y: 1 + r2 },
        { x: 1 - r2, y: 1 },
      ],
      1e-12,
      '45° square',
    );
  });
});

// ── Geometry → Fabric ────────────────────────────────────────────────────────

describe('buildFabricObjectFromGeometry paints the geometry', () => {
  it('paints the worked example where its geometry says, at rotation 0 and 90', () => {
    expectCorners(
      paintedCorners(build(rectangle(WORKED.origin, 100, 50, 0))),
      WORKED_AT_0,
      1e-9,
      'worked example at 0°',
    );
    expectCorners(
      paintedCorners(build(rectangle(WORKED.origin, 100, 50, 90))),
      WORKED_AT_90,
      1e-9,
      'worked example at 90°',
    );
  });

  it.each([0, 30, 90, 135, 359.5])(
    'renders pixels exactly over the geometry at %s°',
    (rotation) => {
      // At 0° the probe just outside the top-left corner lies inside the box
      // 0.21.0 painted for this geometry, which was centred on the origin.
      const geometry = rectangle({ x: 200.25, y: 100.75 }, 100, 50, rotation);
      expect(rasterMismatches(build(geometry, RASTER_OPTIONS), referenceCorners(geometry))).toEqual(
        [],
      );
    },
  );

  it.each(ROTATIONS)(
    'paints the reference corners at %s° across positions and sizes',
    (rotation) => {
      for (const geometry of matrixAt(rotation)) {
        expectCorners(
          paintedCorners(build(geometry)),
          referenceCorners(geometry),
          TOL,
          label(geometry),
        );
      }
    },
  );

  it('does not move the painted outline with the stroke width', () => {
    const geometry = rectangle({ x: 12.5, y: 40.25 }, 80, 30, 30);
    const expected = referenceCorners(geometry);
    for (const strokeWidth of [0, 2, 7.5]) {
      for (const strokeUniform of [true, false]) {
        const rect = build(geometry, { ...LIBRARY_OPTIONS, strokeWidth, strokeUniform });
        expectCorners(
          paintedCorners(rect),
          expected,
          TOL,
          `stroke ${strokeWidth} uniform ${strokeUniform}`,
        );
      }
    }
  });

  it('measures the outline, not the stroke: getCoords() is the outline grown by half the stroke', () => {
    // Documents why paintedCorners reads the transform matrix.
    const rect = build(rectangle(WORKED.origin, 100, 50, 0), {
      ...LIBRARY_OPTIONS,
      strokeWidth: 8,
    });
    rect.setCoords();
    const [tl, , br] = rect.getCoords();
    expect({ x: tl!.x, y: tl!.y }).toEqual({ x: 196, y: 96 });
    expect({ x: br!.x, y: br!.y }).toEqual({ x: 304, y: 154 });
    expect(paintedCorners(rect)).toEqual(WORKED_AT_0);
  });
});

// ── Fabric → geometry ────────────────────────────────────────────────────────

describe('getGeometryFromFabricObject reads back what is painted', () => {
  it.each(ROTATIONS)('inverts buildFabricObjectFromGeometry exactly at %s°', (rotation) => {
    for (const geometry of matrixAt(rotation)) {
      const back = readBack(build(geometry));
      expectShapeClose(back, geometry, TOL);
      expect(back.rotation, label(geometry)).toBe(geometry.rotation);
    }
  });

  it('reads a Rect positioned by its top-left corner (stroke 0)', () => {
    const rect = new Rect({
      left: 200,
      top: 100,
      width: 100,
      height: 50,
      originX: 'left',
      originY: 'top',
      strokeWidth: 0,
    });
    expect(readBack(rect)).toEqual(rectangle({ x: 200, y: 100 }, 100, 50, 0));
  });

  it('reads a Rect rotated 90° about its top-left corner', () => {
    // Fabric keeps left/top (the top-left corner) at (200, 100) and turns the
    // box about it, so the painted box is x 150–200, y 100–200, centre
    // (175, 150): the box before rotation is (125, 125) to (225, 175).
    const rect = new Rect({
      left: 200,
      top: 100,
      width: 100,
      height: 50,
      originX: 'left',
      originY: 'top',
      strokeWidth: 0,
      angle: 90,
    });
    const back = readBack(rect);
    expectShapeClose(back, rectangle({ x: 125, y: 125 }, 100, 50, 90), 1e-9);
    expectCorners(
      referenceCorners(back),
      [
        { x: 200, y: 100 },
        { x: 200, y: 200 },
        { x: 150, y: 200 },
        { x: 150, y: 100 },
      ],
      1e-9,
      'rotated about its corner',
    );
  });

  it('reads a stroked Rect whose left/top name the outer edge of its stroke', () => {
    // A 10px stroke reaches 5px outside the outline, so the outline starts at (5, 5).
    const rect = new Rect({
      left: 0,
      top: 0,
      width: 100,
      height: 50,
      originX: 'left',
      originY: 'top',
      strokeWidth: 10,
      strokeUniform: false,
    });
    expect(readBack(rect)).toEqual(rectangle({ x: 5, y: 5 }, 100, 50, 0));
  });

  it('reads a Rect with numeric origins (0.25, 0.8)', () => {
    const rect = new Rect({
      left: 100,
      top: 100,
      width: 80,
      height: 40,
      originX: 0.25,
      originY: 0.8,
      strokeWidth: 0,
    });
    expect(readBack(rect)).toEqual(rectangle({ x: 80, y: 68 }, 80, 40, 0));
  });

  it('reads a scaled Rect at its scaled size', () => {
    const rect = new Rect({
      left: 100,
      top: 100,
      width: 10,
      height: 20,
      scaleX: 3,
      scaleY: 0.5,
      originX: 'center',
      originY: 'center',
      strokeWidth: 0,
    });
    expect(readBack(rect)).toEqual(rectangle({ x: 85, y: 95 }, 30, 10, 0));
  });

  it('reads a Rect flipped on both axes as the same box (a rectangle is symmetric about its centre)', () => {
    const rect = new Rect({
      left: 250,
      top: 125,
      width: 100,
      height: 50,
      originX: 'center',
      originY: 'center',
      strokeWidth: 0,
      angle: 90,
      flipX: true,
      flipY: true,
    });
    const back = readBack(rect);
    expectShapeClose(back, rectangle(WORKED.origin, 100, 50, 90), 1e-9);
    expectSameCornerSet(paintedCorners(rect), WORKED_AT_90, 1e-9, 'flipped worked example');
  });

  const ORIGINS_X: readonly TOriginX[] = ['left', 'center', 'right', 0.25, 0.8];
  const ORIGINS_Y: readonly TOriginY[] = ['top', 'center', 'bottom', 0.25, 0.8];
  const ORIGIN_PAIRS = ORIGINS_X.flatMap((originX) =>
    ORIGINS_Y.map((originY) => ({ originX, originY })),
  );
  const VARIANTS = [
    { scaleX: 1, scaleY: 1, flipX: false, flipY: false, strokeWidth: 0, strokeUniform: false },
    { scaleX: 2.5, scaleY: 0.4, flipX: false, flipY: false, strokeWidth: 3, strokeUniform: false },
    { scaleX: 0.75, scaleY: 1.5, flipX: true, flipY: false, strokeWidth: 2, strokeUniform: true },
    { scaleX: 1.25, scaleY: 3, flipX: false, flipY: true, strokeWidth: 0, strokeUniform: true },
    { scaleX: 3, scaleY: 0.5, flipX: true, flipY: true, strokeWidth: 5, strokeUniform: false },
  ] as const;

  it.each(ORIGIN_PAIRS)(
    'reads a Rect with originX $originX / originY $originY as the shape it paints',
    ({ originX, originY }) => {
      for (const angle of ROTATIONS) {
        for (const variant of VARIANTS) {
          const rect = new Rect({
            left: 321.123,
            top: -45.678,
            width: 87.5,
            height: 33.25,
            originX,
            originY,
            angle,
            ...variant,
          });
          const back = readBack(rect);
          const what = `angle ${angle} ${JSON.stringify(variant)} → ${label(back)}`;
          expect(back.width, what).toBeCloseTo(87.5 * variant.scaleX, 9);
          expect(back.height, what).toBeCloseTo(33.25 * variant.scaleY, 9);
          expectSameCornerSet(referenceCorners(back), paintedCorners(rect), TOL, what);
        }
      }
    },
  );

  it('reads 400 seeded arbitrary Rect states as the shapes they paint', () => {
    const random = seededRandom(0x5eed_0244);
    const between = (lo: number, hi: number): number => lo + random() * (hi - lo);
    const NAMED_X = ['left', 'center', 'right'] as const;
    const NAMED_Y = ['top', 'center', 'bottom'] as const;
    for (let i = 0; i < 400; i++) {
      // Half named, half numeric (Fabric reads a number as a fraction of the size).
      const originX: TOriginX =
        random() < 0.5 ? NAMED_X[Math.floor(random() * 3)]! : between(-0.25, 1.25);
      const originY: TOriginY =
        random() < 0.5 ? NAMED_Y[Math.floor(random() * 3)]! : between(-0.25, 1.25);
      const props = {
        left: between(-1000, 6000),
        top: between(-1000, 6000),
        width: between(0.5, 5000),
        height: between(0.5, 5000),
        originX,
        originY,
        angle: between(-720, 720),
        // A negative scale is how Fabric flips while scaling; set() turns it into flipX/flipY.
        scaleX: (random() < 0.2 ? -1 : 1) * between(0.05, 5),
        scaleY: (random() < 0.2 ? -1 : 1) * between(0.05, 5),
        flipX: random() < 0.5,
        flipY: random() < 0.5,
        strokeWidth: random() < 0.3 ? 0 : between(0, 12),
        strokeUniform: random() < 0.5,
      };
      const rect = new Rect(props);
      const back = readBack(rect);
      const what = `state ${i}: ${JSON.stringify(props)} → ${label(back)}`;
      expect(back.width, what).toBeGreaterThan(0);
      expect(back.height, what).toBeGreaterThan(0);
      expectSameCornerSet(referenceCorners(back), paintedCorners(rect), TOL, what);
    }
  });

  it('reads a skewed Rect, which paints a parallelogram no rectangle describes, as the unskewed box about the same centre', () => {
    // Nothing the library builds can be skewed any more (see "Shift + a side
    // handle" below), and osdlabel's edit commit replaces a skewed object's
    // data with the box read back here; data saved skewed is the case left.
    const rect = workedSkewedX20();
    expectCorners(paintedCorners(rect), WORKED_SKEWED_X20, 1e-9, 'skewX 20');
    expect(readBack(rect)).toEqual(rectangle(WORKED.origin, 100, 50, 0));
    // The box read back is not what is painted: its corners are 25 · tan 20° off.
    expect(cornerDeviation(paintedCorners(rect), WORKED_AT_0)).toBeCloseTo(25 * TAN_20, 9);
  });

  it('a Rect rebuilt from what a skewed one reads back as paints that box, unskewed', () => {
    // How osdlabel's edit commit normalises a skewed rectangle.
    const rebuilt = build(readBack(workedSkewedX20()));
    expect(rebuilt.skewX).toBe(0);
    expect(rebuilt.skewY).toBe(0);
    expectCorners(paintedCorners(rebuilt), WORKED_AT_0, 1e-9, 'rebuilt');
  });
});

// ── Save and reload ──────────────────────────────────────────────────────────

describe('serializeFabricObject → createFabricObjectFromRawData', () => {
  function saved(geometry: RectangleGeometry, object: FabricObject): Annotation<FabricFields> {
    // Through JSON, as a host stores it.
    const rawAnnotationData = JSON.parse(
      JSON.stringify(serializeFabricObject(object)),
    ) as FabricRawAnnotationData;
    return {
      id,
      geometry,
      toolType: 'rectangle',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      rawAnnotationData,
    };
  }

  async function reload(annotation: Annotation<FabricFields>): Promise<Rect> {
    const object = await createFabricObjectFromRawData(annotation);
    expect(object).not.toBeNull();
    return expectFabricInstance(object!, Rect);
  }

  it('saves a centre-origin Rect at the centre, rounded by toObject()', () => {
    // Many decimals, so the 4-decimal rounding actually happens.
    const geometry = rectangle(
      { x: 132.38578680202863, y: 218.61252115058915 },
      87.123456789,
      41.987654321,
      33.3333333333,
    );
    const { data } = saved(geometry, build(geometry)).rawAnnotationData;
    const centre = {
      x: 132.38578680202863 + 87.123456789 / 2,
      y: 218.61252115058915 + 41.987654321 / 2,
    };
    expect(data['originX']).toBe('center');
    expect(data['originY']).toBe('center');
    expect(typeof data['left']).toBe('number');
    expect(typeof data['top']).toBe('number');
    const left = data['left'] as number;
    const top = data['top'] as number;
    expect(left).not.toBe(centre.x);
    expect(Math.abs(left - centre.x)).toBeLessThanOrEqual(5e-5);
    expect(Math.abs(top - centre.y)).toBeLessThanOrEqual(5e-5);
  });

  it.each(ROTATIONS)(
    'reloads a rectangle saved at %s° painted where it was, within 1e-3 px',
    async (rotation) => {
      const geometries = [
        ...matrixAt(rotation),
        rectangle(
          { x: 132.38578680202863, y: 218.61252115058915 },
          87.123456789,
          41.987654321,
          rotation + 0.123456789,
        ),
      ];
      for (const geometry of geometries) {
        const original = build(geometry);
        const reloaded = await reload(saved(geometry, original));
        expect(reloaded.selectable).toBe(true);
        expect(reloaded.evented).toBe(true);
        expectCorners(
          paintedCorners(reloaded),
          referenceCorners(geometry),
          SAVED_TOL,
          `reloaded ${label(geometry)}`,
        );
        expectCorners(
          paintedCorners(reloaded),
          paintedCorners(original),
          SAVED_TOL,
          `reloaded vs original ${label(geometry)}`,
        );
        expectShapeClose(readBack(reloaded), geometry, SAVED_TOL);
      }
    },
  );

  it('reloaded pixels cover the saved geometry', async () => {
    const geometry = rectangle({ x: 200.123456789, y: 100.987654321 }, 100.5, 50.25, 30.25);
    const reloaded = await reload(saved(geometry, build(geometry, RASTER_OPTIONS)));
    expect(rasterMismatches(reloaded, referenceCorners(geometry))).toEqual([]);
  });
});

// ── Data saved by releases up to 0.21.0 ──────────────────────────────────────

describe('legacy data', () => {
  /**
   * A rectangle centred on (250, 125), 100×50, as releases up to 0.21.0 saved
   * it: a `Rect` built with no origin, which Fabric 7 centres on its
   * `left`/`top`, and a geometry whose `origin` was read back from that same
   * `left`/`top`. Through JSON, as a host stores it.
   */
  function savedByLegacyRelease(angle: number): Annotation<FabricFields> {
    const object = new Rect({
      ...LIBRARY_OPTIONS,
      left: 250,
      top: 125,
      width: 100,
      height: 50,
      angle,
    });
    return {
      id,
      geometry: rectangle({ x: 250, y: 125 }, 100, 50, angle),
      toolType: 'rectangle',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      rawAnnotationData: JSON.parse(
        JSON.stringify(serializeFabricObject(object)),
      ) as FabricRawAnnotationData,
    };
  }

  // √3/2 = cos 30°: the 30° corners are (250, 125) + (±50, ±25) turned by 30°.
  const R3 = Math.sqrt(3);
  const LEGACY_CASES: readonly { readonly angle: number; readonly corners: Corners }[] = [
    {
      angle: 90,
      corners: [
        { x: 275, y: 75 },
        { x: 275, y: 175 },
        { x: 225, y: 175 },
        { x: 225, y: 75 },
      ],
    },
    {
      angle: 30,
      corners: [
        { x: 262.5 - 25 * R3, y: 100 - 12.5 * R3 },
        { x: 262.5 + 25 * R3, y: 150 - 12.5 * R3 },
        { x: 237.5 + 25 * R3, y: 150 + 12.5 * R3 },
        { x: 237.5 - 25 * R3, y: 100 + 12.5 * R3 },
      ],
    },
  ];

  it.each(LEGACY_CASES)(
    'a rectangle saved at $angle° centred on (250, 125) migrates to origin (200, 100), still painted where it was saved',
    async ({ angle, corners }) => {
      const legacy = savedByLegacyRelease(angle);
      // How it was saved: a centre origin at the geometry's origin.
      expect(legacy.rawAnnotationData.data).toMatchObject({
        type: 'Rect',
        originX: 'center',
        originY: 'center',
        left: 250,
        top: 125,
        width: 100,
        height: 50,
        angle,
        scaleX: 1,
        scaleY: 1,
      });

      const migrated = migrateLegacyRectangle(legacy);
      expect(migrated.geometry).toEqual(rectangle({ x: 200, y: 100 }, 100, 50, angle));
      expect(migrated.rawAnnotationData).toBe(legacy.rawAnnotationData);
      expectCorners(
        referenceCorners(asRectangle(migrated.geometry)),
        corners,
        1e-9,
        `migrated geometry at ${angle}°`,
      );

      // The saved data, which the migration keeps, still paints there.
      const painted = await createFabricObjectFromRawData(legacy);
      expect(painted).not.toBeNull();
      expectCorners(
        paintedCorners(expectFabricInstance(painted!, Rect)),
        corners,
        1e-9,
        `saved data at ${angle}°`,
      );
      // And a Rect rebuilt from the migrated geometry is painted there too.
      expectCorners(
        paintedCorners(build(asRectangle(migrated.geometry))),
        corners,
        1e-9,
        `rebuilt from the migrated geometry at ${angle}°`,
      );
    },
  );
});

// ── Editing through Fabric's own controls ────────────────────────────────────

describe('editing a rectangle through Fabric', () => {
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

  /**
   * A canvas configured as FabricOverlay configures its own, with `geometry`
   * built on it and selected. `zoom` and `pan` set a scale + translate viewport
   * transform, as the overlay does for an OSD view: control positions
   * (`oCoords`) and pointer events are then in screen pixels, geometry and
   * `paintedCorners` stay in image pixels.
   */
  function openInEditor(
    geometry: RectangleGeometry,
    options = LIBRARY_OPTIONS,
    zoom = 1,
    pan: Point = { x: 0, y: 0 },
  ) {
    return mountInEditor(build(geometry, options), zoom, pan);
  }

  /** {@link openInEditor} for a `Rect` made some other way (revived, drawn). */
  function mountInEditor(rect: Rect, zoom = 1, pan: Point = { x: 0, y: 0 }) {
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
    canvas.setViewportTransform([zoom, 0, 0, zoom, pan.x, pan.y]);
    canvas.add(rect);
    canvas.setActiveObject(rect);
    rect.setCoords();
    // What ViewerCell stores when Fabric reports an edit.
    const commits: RectangleGeometry[] = [];
    canvas.on('object:modified', ({ target }) => {
      commits.push(readBack(target));
    });
    return { canvas, rect, commits };
  }

  /**
   * One forwarded pointer event, the way FabricOverlay._forwardToFabric sends
   * it: the press on the upper canvas without bubbling, the move and release
   * bubbling (Fabric listens for those on the document). jsdom has no
   * PointerEvent; Fabric reads only clientX/clientY, button and the modifier
   * keys (and treats an event without isPrimary as the main pointer), so a
   * MouseEvent carrying the pointer event's type stands in for it. The canvas
   * sits at (0, 0) with an identity viewport, so client = image coordinates.
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

  function onlyCommit(commits: readonly RectangleGeometry[]): RectangleGeometry {
    expect(commits).toHaveLength(1);
    return commits[0]!;
  }

  function control(rect: Rect, key: string): Point {
    const coord = rect.oCoords[key];
    expect(coord, `control ${key}`).toBeDefined();
    return { x: coord!.x, y: coord!.y };
  }

  /**
   * A press on control `key`, a fraction of a pixel off its exact centre.
   * Fabric hit-tests a control by casting a ray left from the pointer across
   * the control's square; at odd multiples of 45° a corner of that square lies
   * on the ray through its centre and the press misses (it becomes a move). A user
   * never lands on the centre to the last bit, so step off it along `towards`.
   */
  function pressOn(rect: Rect, key: string, towards: Point = { x: 0.31, y: 0.17 }): Point {
    return add(control(rect, key), towards);
  }

  const EDIT_ROTATIONS = [0, 30, 135, 270, 359.5, -30] as const;

  describe('move', () => {
    it('drags the worked example by (13, -7): only the origin moves, by exactly that', () => {
      const { canvas, commits } = openInEditor(rectangle(WORKED.origin, 100, 50, 90));
      gesture(canvas, { x: 250, y: 125 }, { x: 263, y: 118 });
      expectShapeClose(onlyCommit(commits), rectangle({ x: 213, y: 93 }, 100, 50, 90), 1e-9);
    });

    it.each(EDIT_ROTATIONS)('dragging at %s° moves the origin by the drag', (rotation) => {
      const geometry = rectangle({ x: 101.375, y: 202.625 }, 120.5, 60.25, rotation);
      const { canvas, rect, commits } = openInEditor(geometry);
      const centre = { x: 101.375 + 60.25, y: 202.625 + 30.125 };
      const delta = { x: 13.5, y: -7.25 };
      gesture(canvas, centre, add(centre, delta));
      const stored = onlyCommit(commits);
      expectShapeClose(stored, rectangle(add(geometry.origin, delta), 120.5, 60.25, rotation), TOL);
      expectCorners(paintedCorners(rect), referenceCorners(stored), TOL, label(stored));
    });

    it.each(ROTATIONS)('setting left/top += delta at %s° moves the origin by delta', (rotation) => {
      for (const geometry of matrixAt(rotation)) {
        const rect = build(geometry);
        rect.set({ left: rect.left + 3.25, top: rect.top - 1.5 });
        expectShapeClose(
          readBack(rect),
          { ...geometry, origin: add(geometry.origin, { x: 3.25, y: -1.5 }) },
          TOL,
        );
      }
    });
  });

  describe('rotate', () => {
    it('turns the worked example to 90° with the rotation handle: only rotation changes', () => {
      const { canvas, rect, commits } = openInEditor(rectangle(WORKED.origin, 100, 50, 0), {
        ...LIBRARY_OPTIONS,
        strokeWidth: 0,
      });
      // The handle sits above the top edge; drag it round to the right of the centre.
      gesture(canvas, control(rect, 'mtr'), { x: 370, y: 125 });
      const stored = onlyCommit(commits);
      expectShapeClose(stored, rectangle(WORKED.origin, 100, 50, 90), 1e-9);
      expectCorners(paintedCorners(rect), WORKED_AT_90, 1e-9, 'rotated worked example');
    });

    it.each(EDIT_ROTATIONS)('turning a rectangle at %s° by 40° with the handle', (rotation) => {
      const geometry = rectangle({ x: 300.125, y: 200.875 }, 110.5, 70.25, rotation);
      const { canvas, rect, commits } = openInEditor(geometry);
      const centre = { x: 300.125 + 55.25, y: 200.875 + 35.125 };
      const target = rotation + 40;
      // The handle points along the box's -y axis, so to end at `target` the
      // pointer goes to bearing target - 90 from the centre.
      const radians = (target * Math.PI) / 180;
      // Step off the handle's centre along its own bearing from the centre,
      // which leaves the angle it starts from unchanged.
      const handle = control(rect, 'mtr');
      const press = add(handle, unit(centre, handle), 0.4);
      gesture(
        canvas,
        press,
        add(centre, { x: 150 * Math.sin(radians), y: -150 * Math.cos(radians) }),
      );
      const stored = onlyCommit(commits);
      // Fabric's handle normalises the angle into [0, 360).
      const normalised = ((target % 360) + 360) % 360;
      expectShapeClose(stored, { ...geometry, rotation: normalised }, 1e-9);
      expectCorners(paintedCorners(rect), referenceCorners(stored), TOL, label(stored));
    });

    it.each(ROTATIONS)('rect.rotate(%s) changes only rotation', (rotation) => {
      for (const geometry of matrixAt(30)) {
        const rect = build(geometry);
        rect.rotate(rotation);
        const stored = readBack(rect);
        expectShapeClose(stored, { ...geometry, rotation }, TOL);
        expectCorners(paintedCorners(rect), referenceCorners(stored), TOL, label(stored));
      }
    });
  });

  describe('resize', () => {
    it('drags the bottom-right corner of the worked example from (300, 150) to (320, 180)', () => {
      const { canvas, rect, commits } = openInEditor(rectangle(WORKED.origin, 100, 50, 0), {
        ...LIBRARY_OPTIONS,
        strokeWidth: 0,
      });
      // Shift scales freely; without it Fabric keeps the aspect ratio.
      gesture(canvas, control(rect, 'br'), { x: 320, y: 180 }, true);
      expectShapeClose(onlyCommit(commits), rectangle(WORKED.origin, 120, 80, 0), 1e-9);
    });

    it('drags the bottom-right corner of the worked example at 90° from (225, 175) to (195, 195)', () => {
      // The box's +x is image +y and its +y is image -x, so this grows it by
      // (20, 30) in its own frame to 120×80. The top-left corner (275, 75)
      // stays; the centre moves to (235, 135), so the origin is (175, 95).
      const { canvas, rect, commits } = openInEditor(rectangle(WORKED.origin, 100, 50, 90), {
        ...LIBRARY_OPTIONS,
        strokeWidth: 0,
      });
      expect(control(rect, 'br')).toEqual({ x: 225, y: 175 });
      gesture(canvas, { x: 225, y: 175 }, { x: 195, y: 195 }, true);
      expectShapeClose(onlyCommit(commits), rectangle({ x: 175, y: 95 }, 120, 80, 90), 1e-9);
      expectCorners(
        paintedCorners(rect),
        [
          { x: 275, y: 75 },
          { x: 275, y: 195 },
          { x: 195, y: 195 },
          { x: 195, y: 75 },
        ],
        1e-9,
        'resized at 90°',
      );
    });

    it('drags the right edge of the worked example at 90° 30px along its width', () => {
      // The right edge's handle is at (250, 175); the left edge (275, 75)–(225, 75) stays.
      const { canvas, rect, commits } = openInEditor(rectangle(WORKED.origin, 100, 50, 90), {
        ...LIBRARY_OPTIONS,
        strokeWidth: 0,
      });
      expect(control(rect, 'mr')).toEqual({ x: 250, y: 175 });
      gesture(canvas, { x: 250, y: 175 }, { x: 250, y: 205 });
      expectShapeClose(onlyCommit(commits), rectangle({ x: 185, y: 115 }, 130, 50, 90), 1e-9);
    });

    it('drags the bottom-right corner past the top-left: the flipped box is stored as painted', () => {
      const { canvas, rect, commits } = openInEditor(rectangle(WORKED.origin, 100, 50, 0), {
        ...LIBRARY_OPTIONS,
        strokeWidth: 0,
      });
      gesture(canvas, { x: 300, y: 150 }, { x: 150, y: 80 }, true);
      expect(rect.flipX).toBe(true);
      expect(rect.flipY).toBe(true);
      const stored = onlyCommit(commits);
      expectShapeClose(stored, rectangle({ x: 150, y: 80 }, 50, 20, 0), 1e-9);
      expectSameCornerSet(
        paintedCorners(rect),
        [
          { x: 150, y: 80 },
          { x: 200, y: 80 },
          { x: 200, y: 100 },
          { x: 150, y: 100 },
        ],
        1e-9,
        'flipped by dragging past the anchor',
      );
    });

    /** Each control's position in the box's own frame: -1, 0 or 1 of a half-size on each axis. */
    const CONTROLS = {
      tl: [-1, -1],
      tr: [1, -1],
      br: [1, 1],
      bl: [-1, 1],
      ml: [-1, 0],
      mr: [1, 0],
      mt: [0, -1],
      mb: [0, 1],
    } as const;
    /** paintedCorners order. */
    const CORNER_SIGNS = [
      [-1, -1],
      [1, -1],
      [1, 1],
      [-1, 1],
    ] as const;

    const RESIZES = EDIT_ROTATIONS.flatMap((rotation) =>
      (Object.keys(CONTROLS) as (keyof typeof CONTROLS)[]).map((key) => ({ rotation, key })),
    );

    it.each(RESIZES)(
      'dragging $key outward at $rotation° keeps the opposite side and stores the painted box',
      ({ rotation, key }) => {
        const geometry = rectangle({ x: 300.375, y: 220.625 }, 110.5, 70.25, rotation);
        const { canvas, rect, commits } = openInEditor(geometry);
        const [sx, sy] = CONTROLS[key];
        const isCorner = sx !== 0 && sy !== 0;
        const anchored = CORNER_SIGNS.flatMap(([cx, cy], index) =>
          (sx === 0 || cx === -sx) && (sy === 0 || cy === -sy) ? [index] : [],
        );
        expect(anchored).toHaveLength(isCorner ? 1 : 2);
        const before = paintedCorners(rect);

        // Outward in the box's own frame, turned into image space.
        const local = isCorner ? { x: sx * 17.5, y: sy * 11.25 } : { x: sx * 23.5, y: sy * 23.5 };
        const delta = rotateAbout(local, { x: 0, y: 0 }, rotation);
        // Shift on a corner scales freely; a side handle does the same with or
        // without it (see "Shift + a side handle" below), so edges go without.
        const press = pressOn(rect, key);
        gesture(canvas, press, add(press, delta), isCorner);

        const stored = onlyCommit(commits);
        const after = paintedCorners(rect);
        for (const index of anchored) {
          expect(
            Math.hypot(after[index]!.x - before[index]!.x, after[index]!.y - before[index]!.y),
            `corner ${index} should stay put`,
          ).toBeLessThanOrEqual(TOL);
        }
        expectCorners(after, referenceCorners(stored), TOL, `stored after ${key}`);
        expect(stored.rotation).toBe(rotation);
        if (sx !== 0) expect(stored.width).toBeGreaterThan(geometry.width);
        else expect(stored.width).toBe(geometry.width);
        if (sy !== 0) expect(stored.height).toBeGreaterThan(geometry.height);
        else expect(stored.height).toBe(geometry.height);
      },
    );

    it.each(EDIT_ROTATIONS)(
      'proportional corner scaling at %s° keeps the aspect ratio and the opposite corner',
      (rotation) => {
        const geometry = rectangle({ x: 300.375, y: 220.625 }, 110.5, 70.25, rotation);
        const { canvas, rect, commits } = openInEditor(geometry);
        const before = paintedCorners(rect);
        const delta = rotateAbout({ x: 30, y: 12 }, { x: 0, y: 0 }, rotation);
        const press = pressOn(rect, 'br');
        gesture(canvas, press, add(press, delta));
        const stored = onlyCommit(commits);
        const after = paintedCorners(rect);
        expect(
          Math.hypot(after[0].x - before[0].x, after[0].y - before[0].y),
          'the top-left corner should stay put',
        ).toBeLessThanOrEqual(TOL);
        expect(stored.width).toBeGreaterThan(geometry.width);
        expect(stored.width / stored.height).toBeCloseTo(geometry.width / geometry.height, 9);
        expectCorners(after, referenceCorners(stored), TOL, label(stored));
      },
    );

    it.each(RESIZES)(
      'dragging $key through the far side at $rotation° flips the box, keeps the far side and stores the painted box',
      ({ rotation, key }) => {
        const geometry = rectangle({ x: 300.375, y: 220.625 }, 110.5, 70.25, rotation);
        // Unstroked, so the far side Fabric anchors on is the outline itself.
        const { canvas, rect, commits } = openInEditor(geometry, {
          ...LIBRARY_OPTIONS,
          strokeWidth: 0,
        });
        const [sx, sy] = CONTROLS[key];
        const isCorner = sx !== 0 && sy !== 0;
        const before = paintedCorners(rect);
        const farSide = CORNER_SIGNS.flatMap(([cx, cy], index) =>
          (sx === 0 || cx === -sx) && (sy === 0 || cy === -sy) ? [before[index]!] : [],
        );
        // In the box's own frame: through the opposite side and 30 (x) or 20 (y) beyond it.
        const local = {
          x: sx === 0 ? 0 : -sx * (geometry.width + 30),
          y: sy === 0 ? 0 : -sy * (geometry.height + 20),
        };
        const press = pressOn(rect, key);
        // Shift on a corner scales freely; a side handle does the same with or
        // without it (see "Shift + a side handle" below), so edges go without.
        gesture(canvas, press, add(press, rotateAbout(local, { x: 0, y: 0 }, rotation)), isCorner);

        // The premise: Fabric flipped the box rather than ignoring the drag.
        if (sx !== 0) expect(rect.flipX, `${key}: flipped across its width`).toBe(true);
        if (sy !== 0) expect(rect.flipY, `${key}: flipped across its height`).toBe(true);
        const stored = onlyCommit(commits);
        const after = paintedCorners(rect);
        for (const corner of farSide) {
          const nearest = Math.min(...after.map((p) => Math.hypot(p.x - corner.x, p.y - corner.y)));
          expect(nearest, `${key}: the far side stays put`).toBeLessThanOrEqual(TOL);
        }
        expectSameCornerSet(after, referenceCorners(stored), TOL, `stored after ${key} flip`);
        expect(stored.rotation).toBe(rotation);
        // The pointer is pressed a fraction of a pixel off the handle, which
        // Fabric carries into the new size.
        expect(Math.abs(stored.width - (sx === 0 ? geometry.width : 30))).toBeLessThanOrEqual(1);
        expect(Math.abs(stored.height - (sy === 0 ? geometry.height : 20))).toBeLessThanOrEqual(1);
      },
    );
  });

  /**
   * Shift is Fabric's `altActionKey`: on its default side handles it turns the
   * scale into a skew, a parallelogram that no rectangle geometry describes
   * and that the stored geometry silently dropped. A rectangle's side handles
   * only scale, so Shift + a side handle does exactly what the handle does
   * without it. (On a corner, Shift still scales freely: see above.)
   */
  describe('Shift + a side handle', () => {
    const SIDES = ['ml', 'mr', 'mt', 'mb'] as const;
    type Side = (typeof SIDES)[number];
    /** Each side handle's outward direction in the box's own frame. */
    const OUTWARD: Readonly<Record<Side, Point>> = {
      ml: { x: -1, y: 0 },
      mr: { x: 1, y: 0 },
      mt: { x: 0, y: -1 },
      mb: { x: 0, y: 1 },
    };

    /**
     * Out by 23.5 and along the side by 17.25, in the box's own frame: the
     * part along the side is what Fabric's default would skew by.
     */
    function sideDrag(key: Side, rotation: number): Point {
      const out = OUTWARD[key];
      const local = {
        x: out.x * 23.5 + (out.x === 0 ? 17.25 : 0),
        y: out.y * 23.5 + (out.y === 0 ? 17.25 : 0),
      };
      return rotateAbout(local, { x: 0, y: 0 }, rotation);
    }

    const CASES = EDIT_ROTATIONS.flatMap((rotation) => SIDES.map((key) => ({ rotation, key })));

    it.each(CASES)(
      '$key at $rotation°, dragged out and along its side: stored as without Shift, nothing skewed',
      ({ rotation, key }) => {
        const geometry = rectangle({ x: 300.375, y: 220.625 }, 110.5, 70.25, rotation);
        const delta = sideDrag(key, rotation);
        const plain = openInEditor(geometry);
        const plainPress = pressOn(plain.rect, key);
        gesture(plain.canvas, plainPress, add(plainPress, delta));
        const shifted = openInEditor(geometry);
        const press = pressOn(shifted.rect, key);
        gesture(shifted.canvas, press, add(press, delta), true);

        expect(shifted.rect.skewX, 'skewX').toBe(0);
        expect(shifted.rect.skewY, 'skewY').toBe(0);
        const stored = onlyCommit(shifted.commits);
        expectShapeClose(stored, onlyCommit(plain.commits), 1e-9, `${key} with Shift`);
        expectCorners(paintedCorners(shifted.rect), referenceCorners(stored), TOL, label(stored));
        // It scaled that axis by the outward part of the drag. The press is a
        // fraction of a pixel off the handle, which Fabric carries into the size.
        if (OUTWARD[key].x !== 0) {
          expect(Math.abs(stored.width - (geometry.width + 23.5))).toBeLessThanOrEqual(1);
          expect(stored.height).toBe(geometry.height);
        } else {
          expect(Math.abs(stored.height - (geometry.height + 23.5))).toBeLessThanOrEqual(1);
          expect(stored.width).toBe(geometry.width);
        }
      },
    );

    it('renders, after Shift + mr dragged along its side at 30°, exactly the stored box', () => {
      const geometry = rectangle({ x: 120.5, y: 90.25 }, 140, 80, 30);
      const { canvas, rect, commits } = openInEditor(geometry, RASTER_OPTIONS);
      const press = pressOn(rect, 'mr');
      gesture(canvas, press, add(press, sideDrag('mr', 30)), true);
      const stored = onlyCommit(commits);
      canvas.remove(rect);
      expect(rasterMismatches(rect, referenceCorners(stored))).toEqual([]);
    });

    const MADE = ['revived from saved data', 'drawn with RectangleTool'] as const;

    it.each(MADE)('a rectangle %s: Shift + mb dragged along its side scales it', async (how) => {
      const geometry = rectangle({ x: 300.375, y: 220.625 }, 110.5, 70.25, 0);
      const rect =
        how === 'revived from saved data'
          ? await revive(geometry)
          : drawnWithTool(geometry.origin, add(geometry.origin, { x: 110.5, y: 70.25 }));
      const { canvas, commits } = mountInEditor(rect);
      const press = pressOn(rect, 'mb');
      gesture(canvas, press, add(press, sideDrag('mb', 0)), true);

      expect(rect.skewX, 'skewX').toBe(0);
      expect(rect.skewY, 'skewY').toBe(0);
      const stored = onlyCommit(commits);
      expect(stored.width).toBeCloseTo(geometry.width, 9);
      expect(Math.abs(stored.height - (geometry.height + 23.5))).toBeLessThanOrEqual(1);
      expectCorners(
        paintedCorners(rect),
        referenceCorners(stored),
        TOL,
        `${how}: ${label(stored)}`,
      );
    });

    it('a rectangle saved skewed is revived as saved; Shift + a side handle skews it no further', async () => {
      const saved = workedSkewedX20();
      const geometry = readBack(saved);
      const rect = await revive(geometry, saved);
      // Painted as saved: nothing is corrected on load.
      expect(rect.skewX).toBe(20);
      expectCorners(paintedCorners(rect), WORKED_SKEWED_X20, 1e-9, 'revived skewed');
      expect(readBack(rect)).toEqual(geometry);

      const { canvas, commits } = mountInEditor(rect);
      const press = pressOn(rect, 'mr');
      gesture(canvas, press, add(press, { x: 20, y: 30 }), true);
      onlyCommit(commits);
      expect(rect.skewX, 'the saved skew, which the edit commit removes').toBe(20);
      expect(rect.skewY, 'no new skew').toBe(0);
      expect(rect.scaleX, 'mr scaled its width').toBeGreaterThan(1.1);
    });
  });

  /**
   * The editor at the extremes of the matrix: a very large rectangle far from
   * the image origin seen zoomed out, and a sub-pixel one seen zoomed in, as an
   * OSD view shows them. Pointer deltas are in screen pixels, so an image-space
   * delta is scaled by the zoom.
   */
  describe('at extreme sizes and zooms', () => {
    const EXTREMES = EDIT_ROTATIONS.flatMap((rotation) => [
      {
        name: '5000×3000 far from the origin, zoom 0.1',
        rotation,
        geometry: rectangle({ x: -37.5, y: 4096.25 }, 5000, 3000, rotation),
        zoom: 0.1,
        pan: { x: 300, y: -200 },
      },
      {
        name: '0.5×0.25 at a fractional origin, zoom 400',
        rotation,
        geometry: rectangle({ x: 12.125, y: 7.0625 }, 0.5, 0.25, rotation),
        zoom: 400,
        pan: { x: -4600, y: -2700 },
      },
    ]);

    function open(c: (typeof EXTREMES)[number]) {
      return openInEditor(c.geometry, { ...LIBRARY_OPTIONS, strokeWidth: 0 }, c.zoom, c.pan);
    }

    function toScreen(c: (typeof EXTREMES)[number], p: Point): Point {
      return { x: p.x * c.zoom + c.pan.x, y: p.y * c.zoom + c.pan.y };
    }

    it.each(EXTREMES)('$name at $rotation°: dragging the body moves only the origin', (c) => {
      const { canvas, rect, commits } = open(c);
      const centre = {
        x: c.geometry.origin.x + c.geometry.width / 2,
        y: c.geometry.origin.y + c.geometry.height / 2,
      };
      // 40 × -24 screen pixels, whatever the zoom.
      const delta = { x: 40 / c.zoom, y: -24 / c.zoom };
      gesture(canvas, toScreen(c, centre), toScreen(c, add(centre, delta)));
      const stored = onlyCommit(commits);
      const tolerance = 1e-9 * Math.max(1, c.geometry.width, Math.abs(c.geometry.origin.y));
      expectShapeClose(stored, { ...c.geometry, origin: add(c.geometry.origin, delta) }, tolerance);
      expectCorners(paintedCorners(rect), referenceCorners(stored), tolerance, label(stored));
    });

    it.each(EXTREMES)(
      '$name at $rotation°: a free corner resize keeps the opposite corner',
      (c) => {
        const { canvas, rect, commits } = open(c);
        const before = paintedCorners(rect);
        // 30 × 18 screen pixels outward along the box's own axes.
        const press = pressOn(rect, 'br');
        gesture(
          canvas,
          press,
          add(press, rotateAbout({ x: 30, y: 18 }, { x: 0, y: 0 }, c.rotation)),
          true,
        );
        const stored = onlyCommit(commits);
        const after = paintedCorners(rect);
        const tolerance = 1e-9 * Math.max(1, c.geometry.width, Math.abs(c.geometry.origin.y));
        expect(
          Math.hypot(after[0].x - before[0].x, after[0].y - before[0].y),
          'the top-left corner should stay put',
        ).toBeLessThanOrEqual(tolerance);
        expect(stored.width).toBeGreaterThan(c.geometry.width);
        expect(stored.height).toBeGreaterThan(c.geometry.height);
        expect(stored.rotation).toBe(c.rotation);
        expectCorners(after, referenceCorners(stored), tolerance, label(stored));
      },
    );

    it.each(EXTREMES)(
      '$name at $rotation°: turning it with the handle changes only rotation',
      (c) => {
        const { canvas, rect, commits } = open(c);
        const centre = toScreen(c, {
          x: c.geometry.origin.x + c.geometry.width / 2,
          y: c.geometry.origin.y + c.geometry.height / 2,
        });
        const target = c.rotation + 40;
        const radians = (target * Math.PI) / 180;
        const handle = control(rect, 'mtr');
        const press = add(handle, unit(centre, handle), 0.4);
        gesture(
          canvas,
          press,
          add(centre, { x: 150 * Math.sin(radians), y: -150 * Math.cos(radians) }),
        );
        const stored = onlyCommit(commits);
        const normalised = ((target % 360) + 360) % 360;
        const tolerance = 1e-9 * Math.max(1, c.geometry.width, Math.abs(c.geometry.origin.y));
        expectShapeClose(stored, { ...c.geometry, rotation: normalised }, tolerance);
        expectCorners(paintedCorners(rect), referenceCorners(stored), tolerance, label(stored));
      },
    );
  });
});

// ── Drawing with RectangleTool ───────────────────────────────────────────────

describe('RectangleTool draws the dragged box', () => {
  const imageId = createImageId('rect-suite-image');
  const contextId = createAnnotationContextId('rect-suite-context');

  /** `zoom` is the view's screen px per image px. */
  function setUpTool(defaultStyle?: Partial<AnnotationStyle>, zoom = 1) {
    const canvas = createMockCanvas();
    canvas.getZoom.mockReturnValue(zoom);
    const overlay = createMockToolOverlay(canvas, (p) => ({ x: p.x * zoom, y: p.y * zoom }));
    const added: AddAnnotationParams[] = [];
    const callbacks: ToolCallbacks = {
      getActiveContextId: () => contextId,
      getToolConstraint: (type) => ({ type, defaultStyle }),
      canAddAnnotation: () => true,
      addAnnotation: (params) => {
        added.push(params);
      },
      updateAnnotation: vi.fn(),
      deleteAnnotation: vi.fn(),
      setSelectedAnnotation: vi.fn(),
      getAnnotation: () => undefined,
    };
    const tool = new RectangleTool();
    tool.activate(overlay, imageId, callbacks, createTestKeyboardShortcuts());
    return { tool, canvas, overlay, added };
  }

  interface Drag {
    readonly name: string;
    readonly start: Point;
    readonly end: Point;
    /** Screen px per image px the drag is made at; 1 if absent. */
    readonly zoom?: number;
  }

  const DRAGS: readonly Drag[] = [
    { name: 'down-right', start: { x: 10.25, y: 20.75 }, end: { x: 130.75, y: 95.875 } },
    { name: 'up-left', start: { x: 130.75, y: 95.875 }, end: { x: 10.25, y: 20.75 } },
    { name: 'up-right', start: { x: 10.25, y: 95.875 }, end: { x: 130.75, y: 20.75 } },
    { name: 'down-left', start: { x: 130.75, y: 20.75 }, end: { x: 10.25, y: 95.875 } },
    // Seen zoomed in, as a box this small must be to be drawn at all: at zoom
    // 1 it is under MIN_SHAPE_SCREEN_PX and the tool discards it. At 16 it is
    // 8 x 12 screen px.
    {
      name: 'sub-pixel up-right',
      start: { x: 3.1, y: 8.05 },
      end: { x: 3.6, y: 7.3 },
      zoom: 16,
    },
    { name: 'large down-left', start: { x: 4097.3, y: 12.5 }, end: { x: -902.2, y: 3013 } },
  ];

  /** Press, wander to the other side of the start, move to the end, release there. */
  function drawDrag(h: ReturnType<typeof setUpTool>, drag: Drag): Rect {
    const press = { type: 'pointerdown' } as PointerEvent;
    h.overlay.stampPress(press);
    h.tool.onPointerDown(press, drag.start);
    expect(h.canvas.add).toHaveBeenCalledTimes(1);
    const preview = expectFabricInstance(h.canvas.add.mock.calls[0]![0], Rect);

    const wander = {
      x: drag.start.x - (drag.end.x - drag.start.x) / 2,
      y: drag.start.y - (drag.end.y - drag.start.y) / 2,
    };
    h.tool.onPointerMove({ type: 'pointermove' } as PointerEvent, wander);
    expectCorners(
      paintedCorners(preview),
      dragBoxCorners(drag.start, wander),
      TOL,
      `${drag.name}: preview while wandering`,
    );

    h.tool.onPointerMove({ type: 'pointermove' } as PointerEvent, drag.end);
    expectCorners(
      paintedCorners(preview),
      dragBoxCorners(drag.start, drag.end),
      TOL,
      `${drag.name}: preview at the end of the drag`,
    );

    h.tool.onPointerUp({ type: 'pointerup' } as PointerEvent, drag.end);
    expect(h.added, `${drag.name}: committed once`).toHaveLength(1);
    return preview;
  }

  it.each(DRAGS)(
    '$name: preview and committed object cover the box, geometry is its min corner and size',
    (drag) => {
      const h = setUpTool(undefined, drag.zoom);
      const preview = drawDrag(h, drag);

      const params = h.added[0]!;
      expect(params.type).toBe('rectangle');
      expect(params.fabricObject).toBe(preview);
      const committed = expectFabricInstance(params.fabricObject, Rect);
      expectCorners(
        paintedCorners(committed),
        dragBoxCorners(drag.start, drag.end),
        TOL,
        `${drag.name}: committed`,
      );

      const stored = readBack(committed);
      expectShapeClose(
        stored,
        rectangle(
          { x: Math.min(drag.start.x, drag.end.x), y: Math.min(drag.start.y, drag.end.y) },
          Math.abs(drag.end.x - drag.start.x),
          Math.abs(drag.end.y - drag.start.y),
          0,
        ),
        TOL,
        drag.name,
      );
      expect(stored.rotation).toBe(0);
    },
  );

  it('pins one drag by hand: (60.5, 40.25) up-left to (20.25, 10.75) stores origin (20.25, 10.75), 40.25×29.5', () => {
    const h = setUpTool();
    drawDrag(h, { name: 'hand', start: { x: 60.5, y: 40.25 }, end: { x: 20.25, y: 10.75 } });
    const stored = readBack(h.added[0]!.fabricObject);
    expect(stored).toEqual(rectangle({ x: 20.25, y: 10.75 }, 40.25, 29.5, 0));
  });

  it('renders the committed rectangle exactly over the dragged box', () => {
    const h = setUpTool({ fillColor: '#000000', fillOpacity: 1, strokeWidth: 0, opacity: 1 });
    const drag = { name: 'raster', start: { x: 310.75, y: 220.25 }, end: { x: 120.5, y: 60.125 } };
    drawDrag(h, drag);
    expect(
      rasterMismatches(h.added[0]!.fabricObject, dragBoxCorners(drag.start, drag.end)),
    ).toEqual([]);
  });

  it('a drawn rectangle reloads painted over the box it was drawn on', async () => {
    const h = setUpTool();
    const drag = DRAGS[1]!;
    drawDrag(h, drag);
    const committed = h.added[0]!.fabricObject;
    const geometry = readBack(committed);
    const reloaded = await createFabricObjectFromRawData({
      id,
      geometry,
      toolType: 'rectangle',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      rawAnnotationData: JSON.parse(
        JSON.stringify(serializeFabricObject(committed)),
      ) as FabricRawAnnotationData,
    });
    expect(reloaded).not.toBeNull();
    expectCorners(
      paintedCorners(expectFabricInstance(reloaded!, Rect)),
      dragBoxCorners(drag.start, drag.end),
      SAVED_TOL,
      'reloaded drawn rectangle',
    );
  });

  it('rotating a drawn rectangle about its centre keeps its stored box', () => {
    const h = setUpTool();
    const drag = DRAGS[0]!;
    drawDrag(h, drag);
    const committed = expectFabricInstance(h.added[0]!.fabricObject, Rect);
    const drawn = readBack(committed);
    committed.rotate(90);
    expectShapeClose(readBack(committed), { ...drawn, rotation: 90 }, TOL);
  });
});
