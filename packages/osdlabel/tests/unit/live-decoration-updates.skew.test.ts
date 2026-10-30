// @vitest-environment jsdom
/**
 * Pins `enableLiveDecorationUpdates` against a real Fabric canvas for the one
 * edit the mocked suite (`live-decoration-updates.test.ts`) cannot show Fabric
 * making: a shear. Shift + a side handle (Fabric's `altActionKey`) shears a
 * line, polyline or polygon, whose stored points follow the shear exactly, and
 * Fabric reports each step of it with `object:skewing`, not `object:scaling`.
 * The helper used to listen for moving, scaling and rotating only, so a
 * shape's label stayed where it was for the whole drag and jumped on release.
 *
 * Pinned here, for a polygon and a line built as the viewer builds them: every
 * frame of the drag gives the providers the shape Fabric paints at that moment,
 * and the built-in measurement label is anchored on it.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Canvas, Line, Polyline, util, type FabricObject } from 'fabric';
import type { Geometry, Point } from '@osdlabel/annotation';
import { createAnnotationContextId } from '@osdlabel/annotation-context';
import {
  createMeasurementProvider,
  type Decoration,
  type DecorationContext,
  type DecorationProvider,
} from '@osdlabel/decoration';
import { createFabricObjectFromRawData, initFabricModule } from '@osdlabel/fabric-annotations';
import type { FabricOverlay } from '@osdlabel/fabric-osd';
import { createImageId } from '@osdlabel/viewer-api';
import { createAnnotationFromGeometry } from '../../src/create-annotation.js';
import { enableLiveDecorationUpdates } from '../../src/live-decoration-updates.js';
import type { OsdAnnotation, OsdFields } from '../../src/types.js';

initFabricModule();

const imageId = createImageId('img-live-skew');
const contextId = createAnnotationContextId('ctx-live-skew');

// ── requestAnimationFrame, flushed by hand ─────────────────────────────────

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

// ── A canvas, and pointer events as FabricOverlay forwards them ────────────

const canvases: Canvas[] = [];
afterEach(async () => {
  await Promise.all(
    canvases.splice(0).map(async (canvas) => {
      const element = canvas.lowerCanvasEl;
      // `dispose` waits for a requested render, whose frame is in the hand-flushed queue.
      canvas.cancelRequestedRender();
      await canvas.dispose();
      element.remove();
    }),
  );
});

/** As the overlay configures it, with an identity view: client, canvas and scene coordinates coincide. */
function openCanvas(): Canvas {
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
  canvases.push(canvas);
  return canvas;
}

/** jsdom has no PointerEvent; Fabric reads clientX/clientY, button and the modifiers. */
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

// ── What Fabric paints ─────────────────────────────────────────────────────

/** The scene points Fabric paints for a polygon's vertices or a line's ends, through its whole transform. */
function paintedPoints(obj: FabricObject): Point[] {
  const matrix = obj.calcTransformMatrix();
  const local: Point[] =
    obj instanceof Line
      ? [
          { x: (obj.x1 - obj.x2) / 2, y: (obj.y1 - obj.y2) / 2 },
          { x: (obj.x2 - obj.x1) / 2, y: (obj.y2 - obj.y1) / 2 },
        ]
      : obj instanceof Polyline
        ? obj.points.map((p) => ({ x: p.x - obj.pathOffset.x, y: p.y - obj.pathOffset.y }))
        : [];
  expect(local.length, 'a line or a polygon').toBeGreaterThan(0);
  return local.map((p) => {
    const q = util.transformPoint(p, matrix);
    return { x: q.x, y: q.y };
  });
}

function pointsOf(geometry: Geometry): readonly Point[] {
  if (geometry.type === 'line') return [geometry.start, geometry.end];
  if (geometry.type === 'polygon' || geometry.type === 'polyline') return geometry.points;
  throw new Error(`no points in a ${geometry.type}`);
}

function mean(points: readonly Point[]): Point {
  return {
    x: points.reduce((sum, p) => sum + p.x, 0) / points.length,
    y: points.reduce((sum, p) => sum + p.y, 0) / points.length,
  };
}

function expectPointsNear(
  actual: readonly Point[],
  expected: readonly Point[],
  what: string,
): void {
  expect(actual).toHaveLength(expected.length);
  expected.forEach((e, i) => {
    const a = actual[i]!;
    expect(
      Math.hypot(a.x - e.x, a.y - e.y),
      `${what}, point ${i}: (${a.x}, ${a.y}), painted at (${e.x}, ${e.y})`,
    ).toBeLessThanOrEqual(1e-6);
  });
}

// ── Specs ──────────────────────────────────────────────────────────────────

const SHAPES: readonly {
  readonly name: string;
  readonly toolType: OsdAnnotation['toolType'];
  readonly geometry: Geometry;
}[] = [
  {
    name: 'a polygon',
    toolType: 'polyline',
    geometry: {
      type: 'polygon',
      points: [
        { x: 300, y: 200 },
        { x: 460, y: 200 },
        { x: 460, y: 320 },
        { x: 300, y: 320 },
      ],
    },
  },
  {
    name: 'a line',
    toolType: 'line',
    geometry: { type: 'line', start: { x: 300, y: 210 }, end: { x: 460, y: 330 } },
  },
];

describe('enableLiveDecorationUpdates during a Shift + side-handle shear', () => {
  it.each(SHAPES)(
    'of $name: every frame of the drag gives the providers the painted shape, and its label follows it',
    async ({ toolType, geometry }) => {
      const canvas = openCanvas();
      const stored = createAnnotationFromGeometry(geometry, { imageId, contextId, toolType });
      const obj = await createFabricObjectFromRawData(
        JSON.parse(JSON.stringify(stored)) as OsdAnnotation,
      );
      expect(obj).not.toBeNull();
      canvas.add(obj!);
      canvas.setActiveObject(obj!);

      const fired: string[] = [];
      for (const name of ['object:moving', 'object:scaling', 'object:skewing'] as const) {
        canvas.on(name, () => fired.push(name));
      }

      let latest: DecorationContext<OsdFields> | undefined;
      const recorder: DecorationProvider<OsdFields> = (ctx) => {
        latest = ctx;
        return [];
      };
      let frames = 0;
      let decorations: readonly Decoration[] = [];
      enableLiveDecorationUpdates<OsdFields>({
        overlay: { canvas, onPointerCancel: () => () => {} } as unknown as FabricOverlay,
        getVisibleAnnotations: () => [stored],
        getPixelSpacing: () => undefined,
        getProviders: () => [
          recorder,
          createMeasurementProvider<OsdFields>({ perimeter: true, length: true }),
        ],
        onDecorations: (next) => {
          frames++;
          decorations = next;
        },
      });

      // Shift + the bottom handle, carried sideways: a shear about the top edge.
      obj!.setCoords();
      const handle = obj!.oCoords['mb'];
      expect(handle, 'the bottom handle').toBeDefined();
      const from = { x: handle!.x + 0.31, y: handle!.y + 0.17 };
      forward(canvas, 'pointermove', from, true);
      forward(canvas, 'pointerdown', from, true);
      flushFrame();
      const before = paintedPoints(obj!);

      for (let k = 1; k <= 4; k++) {
        forward(canvas, 'pointermove', { x: from.x + 15 * k, y: from.y }, true);
        const framesBefore = frames;
        flushFrame();
        expect(frames, `a frame was emitted for step ${k} of the drag`).toBe(framesBefore + 1);

        const painted = paintedPoints(obj!);
        expect(latest).toBeDefined();
        const live = latest!.annotations.find((a) => a.id === stored.id);
        expect(live, 'the sheared annotation in the providers’ context').toBeDefined();
        expectPointsNear(pointsOf(live!.geometry), painted, `step ${k}`);

        const label = decorations.find((d) => d.id === `measurement:${stored.id}`);
        expect(label, 'the measurement label').toBeDefined();
        if (label!.type !== 'text') throw new Error('the measurement label is a text decoration');
        const centre = mean(painted);
        expect(
          Math.hypot(label!.anchor.x - centre.x, label!.anchor.y - centre.y),
          `step ${k}: label anchor (${label!.anchor.x}, ${label!.anchor.y}), painted centre (${centre.x}, ${centre.y})`,
        ).toBeLessThanOrEqual(1e-6);
      }
      forward(canvas, 'pointerup', { x: from.x + 60, y: from.y }, true);

      // The premise: Fabric sheared the shape, and reported it as skewing alone.
      expect(obj!.skewX, 'Fabric sheared it').not.toBe(0);
      const after = paintedPoints(obj!);
      expect(Math.max(...after.map((p, i) => Math.abs(p.x - before[i]!.x)))).toBeGreaterThan(20);
      expect(fired).toContain('object:skewing');
      expect(fired).not.toContain('object:scaling');
      expect(fired).not.toContain('object:moving');
    },
  );
});
