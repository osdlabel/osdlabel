// @vitest-environment jsdom
/**
 * Saving what Fabric reports as edited (`enableObjectModifiedCommits`, which
 * both bindings' `useAnnotationTool` run), on a real Fabric canvas driven
 * through pointer events, with a stand-in for the viewer's rebuild from state.
 *
 * A multi-selection is a Fabric `ActiveSelection`. Fabric reports a move,
 * scale or rotation of one with a single `object:modified` whose target is the
 * selection itself, with no annotation id, and with every member still inside
 * it, its left/top/scale/angle relative to the selection. Nothing used to be
 * committed for it. Pinned here:
 *
 * - every member is committed once, in one batch, with the geometry that is
 *   painted, and its saved data paints there again when reloaded;
 * - the same annotations are selected again once the rebuild brings their new
 *   objects;
 * - one gesture is one commit, also when the commit rebuilds synchronously
 *   (Solid's store runs the rebuild inside the commit; it used to remove the
 *   object mid-transform, and Fabric then reported the edit a second time);
 * - a selection dissolved before Fabric reports it (a tool switch mid-drag)
 *   still commits its members;
 * - a point in a scaled (or, by host code, skewed) selection keeps its dot at
 *   its style's radius: dissolving bakes the scale into the dot, and the
 *   commit redraws it at the radius, where it used to save the scale.
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  ActiveSelection,
  Canvas,
  Circle,
  Rect,
  util,
  type FabricObject,
  type TMat2D,
} from 'fabric';
import {
  DEFAULT_ANNOTATION_STYLE,
  type AnnotationId,
  type AnnotationStyle,
  type Geometry,
  type Point,
  type RectangleGeometry,
  type VectorGeometry,
} from '@osdlabel/annotation';
import { createAnnotationContextId } from '@osdlabel/annotation-context';
import { createFabricObjectFromRawData, initFabricModule } from '@osdlabel/fabric-annotations';
import { createImageId, type AnnotationState } from '@osdlabel/viewer-api';
import {
  applyAnnotationAction,
  type AnnotationPatch,
  type AnnotationUpdate,
} from '../../src/actions.js';
import { createAnnotationFromGeometry } from '../../src/create-annotation.js';
import { createInitialAnnotationState } from '../../src/initial-state.js';
import {
  enableObjectModifiedCommits,
  processGroupModified,
  type ObjectModifiedPatch,
  type ObjectModifiedUpdate,
} from '../../src/object-modified.js';
import type { OsdAnnotation, OsdFields } from '../../src/types.js';
import {
  cornerSetDeviation,
  paintedCorners,
  referenceCorners,
  type Corners,
} from './rectangle-reference.js';

initFabricModule();

const imageId = createImageId('img-group');
const contextId = createAnnotationContextId('ctx-group');
const annId = (s: string): AnnotationId => s as AnnotationId;

// ── A canvas, and pointer events as FabricOverlay forwards them ────────────

const canvases: Canvas[] = [];
afterEach(async () => {
  await Promise.all(
    canvases.splice(0).map(async (canvas) => {
      const element = canvas.lowerCanvasEl;
      await canvas.dispose();
      element.remove();
    }),
  );
});

/** As the overlay configures it, with the select tool's drag-box on and an identity view. */
function openCanvas(): Canvas {
  const element = document.createElement('canvas');
  document.body.appendChild(element);
  const canvas = new Canvas(element, {
    width: 800,
    height: 600,
    selection: true,
    renderOnAddRemove: false,
    skipOffscreen: false,
    enablePointerEvents: true,
  });
  canvases.push(canvas);
  return canvas;
}

function forward(canvas: Canvas, type: 'pointerdown' | 'pointermove' | 'pointerup', at: Point) {
  canvas.upperCanvasEl.dispatchEvent(
    new MouseEvent(type, {
      clientX: at.x,
      clientY: at.y,
      bubbles: type !== 'pointerdown',
      cancelable: true,
      button: 0,
    }),
  );
}

function press(canvas: Canvas, from: Point, to: Point): void {
  forward(canvas, 'pointermove', from);
  forward(canvas, 'pointerdown', from);
  for (let k = 1; k <= 4; k++) {
    forward(canvas, 'pointermove', {
      x: from.x + ((to.x - from.x) * k) / 4,
      y: from.y + ((to.y - from.y) * k) / 4,
    });
  }
}

function gesture(canvas: Canvas, from: Point, to: Point): void {
  press(canvas, from, to);
  forward(canvas, 'pointerup', to);
}

/** Let every queued microtask and the rebuild's promises run. */
const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

// ── The annotations, and a stand-in for the viewer ─────────────────────────

/** The point's dot radius, in image px: its style's, not the default. */
const POINT_RADIUS = 7;
const POINT_STYLE: AnnotationStyle = { ...DEFAULT_ANNOTATION_STYLE, pointRadius: POINT_RADIUS };

const SHAPES: Record<
  string,
  {
    readonly toolType: OsdAnnotation['toolType'];
    readonly geometry: VectorGeometry;
    readonly style?: AnnotationStyle;
  }
> = {
  rect: {
    toolType: 'rectangle',
    geometry: {
      type: 'rectangle',
      origin: { x: 100, y: 100 },
      width: 120,
      height: 60,
      rotation: 30,
    },
  },
  circle: {
    toolType: 'circle',
    geometry: { type: 'circle', center: { x: 380, y: 140 }, radius: 50 },
  },
  point: {
    toolType: 'point',
    geometry: { type: 'point', position: { x: 500, y: 140 } },
    style: POINT_STYLE,
  },
  line: {
    toolType: 'line',
    geometry: { type: 'line', start: { x: 100, y: 300 }, end: { x: 260, y: 360 } },
  },
  polygon: {
    toolType: 'polyline',
    geometry: {
      type: 'polygon',
      points: [
        { x: 340, y: 300 },
        { x: 460, y: 300 },
        { x: 450, y: 380 },
        { x: 350, y: 390 },
      ],
    },
  },
};

interface Commit {
  readonly kind: 'one' | 'batch';
  readonly ids: readonly string[];
}

/**
 * The state, a canvas showing it, and the commits made through
 * `enableObjectModifiedCommits`. Each commit applies the real reducer and then
 * rebuilds the canvas from state as ViewerCell does: every annotation object
 * removed at once, new ones built from their saved data and added together
 * once all are ready. `syncRemove` removes them inside the commit, as Solid's
 * synchronously-run effect does; otherwise on the next task, as React's
 * effect runs after the render.
 */
async function openViewer(options: { readonly syncRemove: boolean }) {
  const canvas = openCanvas();
  const state: AnnotationState<OsdFields> = createInitialAnnotationState();
  state.byImage[imageId] = {};
  for (const [id, shape] of Object.entries(SHAPES)) {
    state.byImage[imageId]![annId(id)] = createAnnotationFromGeometry(shape.geometry, {
      imageId,
      contextId,
      toolType: shape.toolType,
      id: annId(id),
      ...(shape.style !== undefined ? { style: shape.style } : {}),
    });
  }

  const commits: Commit[] = [];
  const modified: (string | undefined)[] = [];
  canvas.on('object:modified', ({ target }) => modified.push(target.id));

  let rebuilding: Promise<void> = Promise.resolve();
  const rebuild = (): void => {
    const remove = (): void => {
      const old = canvas.getObjects().filter((o) => o.id);
      if (old.length > 0) canvas.remove(...old);
    };
    const add = async (): Promise<void> => {
      const stored = Object.values(state.byImage[imageId] ?? {}).map(
        (a) => JSON.parse(JSON.stringify(a)) as OsdAnnotation,
      );
      const objects = await Promise.all(stored.map((a) => createFabricObjectFromRawData(a)));
      canvas.add(...objects.filter((o): o is FabricObject => o !== null));
      canvas.requestRenderAll();
    };
    if (options.syncRemove) {
      remove();
      rebuilding = add();
    } else {
      rebuilding = new Promise<void>((resolve) => setTimeout(resolve, 0)).then(() => {
        remove();
        return add();
      });
    }
  };

  const dispose = enableObjectModifiedCommits({
    overlay: { canvas },
    imageId,
    getAnnotationState: () => state,
    updateAnnotation: (id, patch) => {
      commits.push({ kind: 'one', ids: [id] });
      applyAnnotationAction(state, { type: 'UPDATE_ANNOTATION', payload: { id, imageId, patch } });
      rebuild();
    },
    updateAnnotations: (updates) => {
      commits.push({ kind: 'batch', ids: updates.map((u) => u.id) });
      applyAnnotationAction(state, { type: 'UPDATE_ANNOTATIONS', payload: { imageId, updates } });
      rebuild();
    },
  });

  rebuild();
  await rebuilding;

  return {
    canvas,
    state,
    commits,
    modified,
    dispose,
    /** Wait for the last commit's rebuild to finish. */
    rebuilt: async (): Promise<void> => {
      await settle();
      await rebuilding;
    },
    stored: <G extends Geometry>(id: string): G =>
      state.byImage[imageId]![annId(id)]!.geometry as G,
    object: (id: string): FabricObject => {
      const found = canvas.getObjects().find((o) => o.id === id);
      expect(found, `object ${id} is on the canvas`).toBeDefined();
      return found!;
    },
  };
}

type Viewer = Awaited<ReturnType<typeof openViewer>>;

/** Drag-box from empty canvas over all five shapes. */
function selectAll(viewer: Viewer): ActiveSelection {
  gesture(viewer.canvas, { x: 20, y: 20 }, { x: 780, y: 580 });
  const active = viewer.canvas.getActiveObject();
  expect(active).toBeInstanceOf(ActiveSelection);
  const selection = active as ActiveSelection;
  expect(
    selection
      .getObjects()
      .map((o) => o.id)
      .sort(),
  ).toEqual(Object.keys(SHAPES).sort());
  return selection;
}

// ── What the stored geometry must be ───────────────────────────────────────

function apply(m: TMat2D, p: Point): Point {
  const q = util.transformPoint(p, m);
  return { x: q.x, y: q.y };
}

function expectPoint(actual: Point, expected: Point, tol: number, what: string): void {
  expect(
    Math.hypot(actual.x - expected.x, actual.y - expected.y),
    `${what}: (${actual.x}, ${actual.y}), expected (${expected.x}, ${expected.y})`,
  ).toBeLessThanOrEqual(tol);
}

/** Every stored shape is the one before the edit carried through `m`, which scales by `k`. */
function expectCarried(viewer: Viewer, m: TMat2D, k: number, tol: number): void {
  const rect0 = SHAPES['rect']!.geometry as RectangleGeometry;
  const rect1 = viewer.stored<RectangleGeometry>('rect');
  const [a, b, c, d] = referenceCorners(rect0);
  const carried: Corners = [apply(m, a), apply(m, b), apply(m, c), apply(m, d)];
  expect(
    cornerSetDeviation(referenceCorners(rect1), carried),
    `rectangle ${JSON.stringify(rect1)}`,
  ).toBeLessThanOrEqual(tol);
  expect(rect1.width).toBeCloseTo(rect0.width * k, 6);
  expect(rect1.height).toBeCloseTo(rect0.height * k, 6);

  const circle0 = SHAPES['circle']!.geometry as Extract<Geometry, { type: 'circle' }>;
  const circle1 = viewer.stored<Extract<Geometry, { type: 'circle' }>>('circle');
  expectPoint(circle1.center, apply(m, circle0.center), tol, 'circle centre');
  expect(circle1.radius).toBeCloseTo(circle0.radius * k, 6);

  const point0 = SHAPES['point']!.geometry as Extract<Geometry, { type: 'point' }>;
  expectPoint(
    viewer.stored<Extract<Geometry, { type: 'point' }>>('point').position,
    apply(m, point0.position),
    tol,
    'point',
  );

  const line0 = SHAPES['line']!.geometry as Extract<Geometry, { type: 'line' }>;
  const line1 = viewer.stored<Extract<Geometry, { type: 'line' }>>('line');
  expectPoint(line1.start, apply(m, line0.start), tol, 'line start');
  expectPoint(line1.end, apply(m, line0.end), tol, 'line end');

  const polygon0 = SHAPES['polygon']!.geometry as Extract<Geometry, { type: 'polygon' }>;
  const polygon1 = viewer.stored<Extract<Geometry, { type: 'polygon' }>>('polygon');
  expect(polygon1.points).toHaveLength(polygon0.points.length);
  polygon0.points.forEach((p, i) =>
    expectPoint(polygon1.points[i]!, apply(m, p), tol, `vertex ${i}`),
  );
}

/** How far the outline Fabric paints for `dot` (its `radius` arc through its whole transform) strays from a circle of `radius` about `centre`. */
function dotDeviation(dot: Circle, centre: Point, radius: number): number {
  const matrix = dot.calcTransformMatrix();
  let worst = 0;
  for (let i = 0; i < 72; i++) {
    const t = (2 * Math.PI * i) / 72;
    const p = util.transformPoint(
      { x: dot.radius * Math.cos(t), y: dot.radius * Math.sin(t) },
      matrix,
    );
    worst = Math.max(worst, Math.abs(Math.hypot(p.x - centre.x, p.y - centre.y) - radius));
  }
  return worst;
}

// ── Specs ──────────────────────────────────────────────────────────────────

describe.each([
  { binding: 'removed inside the commit (Solid)', syncRemove: true },
  { binding: 'removed after the commit (React)', syncRemove: false },
])('enableObjectModifiedCommits, objects $binding', ({ syncRemove }) => {
  it('commits every member of a moved selection once, in one batch, where it is painted', async () => {
    const viewer = await openViewer({ syncRemove });
    selectAll(viewer);

    // Press on the rectangle's centre, which lies inside it at any rotation.
    gesture(viewer.canvas, { x: 160, y: 130 }, { x: 197, y: 109 });
    await viewer.rebuilt();

    expect(viewer.modified).toEqual([undefined]);
    expect(viewer.commits).toHaveLength(1);
    expect(viewer.commits[0]!.kind).toBe('batch');
    expect([...viewer.commits[0]!.ids].sort()).toEqual(Object.keys(SHAPES).sort());
    expectCarried(viewer, [1, 0, 0, 1, 37, -21], 1, 1e-6);
  });

  it('commits a scaled and rotated selection as the shapes it paints', async () => {
    const viewer = await openViewer({ syncRemove });
    const selection = selectAll(viewer);
    const before = selection.calcTransformMatrix();
    selection.set({ scaleX: 1.4, scaleY: 1.4, angle: 25 });
    selection.setCoords();
    // Where the edited selection paints each member, as a map of the scene.
    const m = util.multiplyTransformMatrices(
      selection.calcTransformMatrix(),
      util.invertTransform(before),
    );
    viewer.canvas.fire('object:modified', { target: selection });
    await viewer.rebuilt();

    expect(viewer.commits.map((c) => c.kind)).toEqual(['batch']);
    expectCarried(viewer, m, 1.4, 1e-6);

    // The rebuilt rectangle, from its saved data, paints the stored corners.
    const rect = viewer.object('rect');
    expect(rect).toBeInstanceOf(Rect);
    expect(
      cornerSetDeviation(paintedCorners(rect as Rect), referenceCorners(viewer.stored('rect'))),
    ).toBeLessThanOrEqual(1e-3);
  });

  it.each([
    { name: 'scaled 1.7', props: { scaleX: 1.7, scaleY: 1.7 } },
    { name: 'shrunk to 0.6 and turned', props: { scaleX: 0.6, scaleY: 0.6, angle: 35 } },
    {
      name: 'scaled 1.7 and, by host code, skewed',
      props: { scaleX: 1.7, scaleY: 1.7, skewX: 20 },
    },
  ])(
    'commits the point of a selection $name as a dot of its style radius, where it is painted',
    async ({ props }) => {
      const viewer = await openViewer({ syncRemove });
      const selection = selectAll(viewer);
      const before = selection.calcTransformMatrix();
      selection.set(props);
      selection.setCoords();
      const m = util.multiplyTransformMatrices(
        selection.calcTransformMatrix(),
        util.invertTransform(before),
      );
      const point0 = SHAPES['point']!.geometry as Extract<Geometry, { type: 'point' }>;
      const centre = apply(m, point0.position);
      // The premise: the selection paints the dot at another size, or sheared.
      const member = selection.getObjects().find((o) => o.id === 'point');
      expect(member).toBeInstanceOf(Circle);
      expect(dotDeviation(member as Circle, centre, POINT_RADIUS)).toBeGreaterThan(1);

      viewer.canvas.fire('object:modified', { target: selection });
      await viewer.rebuilt();

      expect(viewer.commits.map((c) => c.kind)).toEqual(['batch']);
      const stored = viewer.stored<Extract<Geometry, { type: 'point' }>>('point');
      expectPoint(stored.position, centre, 1e-6, 'point');
      const data = viewer.state.byImage[imageId]![annId('point')]!.rawAnnotationData.data;
      expect(data).toMatchObject({
        type: 'Circle',
        radius: POINT_RADIUS,
        scaleX: 1,
        scaleY: 1,
        skewX: 0,
        skewY: 0,
      });
      // The rebuilt dot, from its saved data, is the style's dot at the stored position.
      const dot = viewer.object('point');
      expect(dot).toBeInstanceOf(Circle);
      expect(dotDeviation(dot as Circle, stored.position, POINT_RADIUS)).toBeLessThanOrEqual(1e-3);
    },
  );

  it('selects the same annotations again once their rebuilt objects are back', async () => {
    const viewer = await openViewer({ syncRemove });
    const selection = selectAll(viewer);
    const oldMembers = selection.getObjects();

    gesture(viewer.canvas, { x: 160, y: 130 }, { x: 197, y: 109 });
    await viewer.rebuilt();

    const active = viewer.canvas.getActiveObject();
    expect(active).toBeInstanceOf(ActiveSelection);
    const members = (active as ActiveSelection).getObjects();
    expect(members.map((o) => o.id).sort()).toEqual(Object.keys(SHAPES).sort());
    for (const member of members) {
      expect(viewer.canvas.getObjects()).toContain(member);
      expect(oldMembers).not.toContain(member);
    }
    // And it is the uniform-only selection the select tool makes.
    expect(Object.keys(active!.controls).sort()).toEqual(['bl', 'br', 'mtr', 'tl', 'tr']);
  });

  it('commits a one-object drag once', async () => {
    const viewer = await openViewer({ syncRemove });
    const centre = { x: 160, y: 130 };
    forward(viewer.canvas, 'pointermove', centre);
    forward(viewer.canvas, 'pointerdown', centre);
    forward(viewer.canvas, 'pointerup', centre);
    expect(viewer.canvas.getActiveObject()?.id).toBe('rect');

    gesture(viewer.canvas, centre, { x: 183, y: 141 });
    await viewer.rebuilt();

    expect(viewer.modified).toEqual(['rect']);
    expect(viewer.commits).toEqual([{ kind: 'one', ids: ['rect'] }]);
    expectPoint(
      viewer.stored<RectangleGeometry>('rect').origin,
      { x: 123, y: 111 },
      1e-6,
      'rectangle origin',
    );
  });

  it('commits the members of a selection dissolved before Fabric reports the edit', async () => {
    const viewer = await openViewer({ syncRemove });
    selectAll(viewer);

    // Mid-drag, the select tool is switched away: it discards the selection,
    // which bakes the drag so far into each member and empties the selection
    // before Fabric ends the transform and reports it.
    press(viewer.canvas, { x: 160, y: 130 }, { x: 197, y: 109 });
    viewer.canvas.discardActiveObject();
    forward(viewer.canvas, 'pointerup', { x: 197, y: 109 });
    await viewer.rebuilt();

    expect(viewer.commits).toHaveLength(1);
    expect([...viewer.commits[0]!.ids].sort()).toEqual(Object.keys(SHAPES).sort());
    expectCarried(viewer, [1, 0, 0, 1, 37, -21], 1, 1e-6);
  });
});

describe('enableObjectModifiedCommits teardown', () => {
  it('commits nothing reported after it is disposed', async () => {
    const viewer = await openViewer({ syncRemove: true });
    viewer.dispose();
    selectAll(viewer);
    gesture(viewer.canvas, { x: 160, y: 130 }, { x: 197, y: 109 });
    await viewer.rebuilt();
    expect(viewer.commits).toEqual([]);
  });

  it('still saves an edit reported just before it, but reselects nothing', async () => {
    const viewer = await openViewer({ syncRemove: false });
    selectAll(viewer);
    gesture(viewer.canvas, { x: 160, y: 130 }, { x: 197, y: 109 });
    // The cell re-subscribes in the same task (say, a new image id).
    viewer.dispose();
    await viewer.rebuilt();
    expect(viewer.commits).toHaveLength(1);
    expect(viewer.canvas.getActiveObject()).toBeUndefined();
  });
});

describe('processGroupModified', () => {
  it('reads every member it can resolve, and skips the rest', async () => {
    const viewer = await openViewer({ syncRemove: true });
    const stray = new Rect({ left: 10, top: 10, width: 5, height: 5 });
    const unknown = new Rect({ left: 10, top: 10, width: 5, height: 5 });
    unknown.id = 'not-stored';
    const members = [viewer.object('circle'), stray, unknown, viewer.object('point')];

    const updates = processGroupModified(members, viewer.state, imageId);

    expect(updates.map((u) => u.id)).toEqual(['circle', 'point']);
    expect(updates[0]!.patch.geometry).toEqual(viewer.stored('circle'));
    expect(updates[0]!.patch.rawAnnotationData.format).toBe('fabric');
  });
});

/**
 * The patch types an edit is committed with are the action types, narrowed:
 * an `ObjectModifiedPatch` is an `AnnotationPatch` with both its geometry and
 * its Fabric data required, and an `ObjectModifiedUpdate` an
 * `AnnotationUpdate` carrying one. Checked by `tsc` (the package's
 * `typecheck`), which compiles the test tree: each constant below is typed
 * `true` only when the relation it names holds.
 */
describe('ObjectModifiedPatch and ObjectModifiedUpdate', () => {
  /** `true` when `A` is assignable to `B`, else `false`. */
  type Extends<A, B> = [A] extends [B] ? true : false;

  it('narrow AnnotationPatch and AnnotationUpdate', () => {
    const patchIsAnnotationPatch: Extends<ObjectModifiedPatch, AnnotationPatch> = true;
    const patchNamesEveryField: Extends<keyof AnnotationPatch, keyof ObjectModifiedPatch> = true;
    const bothFieldsRequired: Extends<
      Pick<AnnotationPatch, 'geometry' | 'rawAnnotationData'>,
      Pick<ObjectModifiedPatch, 'geometry' | 'rawAnnotationData'>
    > = false;
    const updateIsAnnotationUpdate: Extends<ObjectModifiedUpdate, AnnotationUpdate> = true;
    const updateCarriesNarrowPatch: Extends<ObjectModifiedUpdate['patch'], ObjectModifiedPatch> =
      true;
    expect([
      patchIsAnnotationPatch,
      patchNamesEveryField,
      bothFieldsRequired,
      updateIsAnnotationUpdate,
      updateCarriesNarrowPatch,
    ]).toEqual([true, true, false, true, true]);
  });
});
