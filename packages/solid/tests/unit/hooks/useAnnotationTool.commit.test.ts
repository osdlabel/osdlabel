import { describe, it, expect, vi, afterEach } from 'vitest';
import { createComponent, createEffect, createRoot, on, untrack } from 'solid-js';
import { ActiveSelection, Canvas, type FabricObject } from 'fabric';
import type { FabricOverlay } from '@osdlabel/fabric-osd';
import { createFabricObjectFromRawData, initFabricModule } from '@osdlabel/fabric-annotations';
import {
  createAnnotationId,
  type AnnotationId,
  type Geometry,
  type Point,
} from '@osdlabel/annotation';
import { createImageId } from '@osdlabel/viewer-api';
import { createAnnotationContextId } from '@osdlabel/annotation-context';
import { createAnnotationFromGeometry, type OsdAnnotation } from 'osdlabel';
import { AnnotatorProvider, useAnnotator } from '../../../src/state/annotator-context.js';
import { useAnnotationTool } from '../../../src/hooks/useAnnotationTool.js';

/**
 * What the hook saves when Fabric reports an edit, on a real Fabric canvas
 * driven through pointer events, with the real provider. React covers the
 * same in its `useAnnotationTool.commit.test.tsx`.
 *
 * The canvas is rebuilt from state the way `ViewerCell` rebuilds it, in an
 * effect on the annotation state, which Solid runs synchronously inside the
 * commit: every annotation object is removed there, and new ones are added
 * once built. That removal used to end Fabric's transform while it was still
 * reporting the edit, and Fabric then reported it a second time (a second
 * commit). A multi-selection's edit was not committed at all.
 */

const imageId = createImageId('img-commit');
const contextId = createAnnotationContextId('ctx-commit');

// As FabricOverlay's constructor does, so saved data carries the id.
initFabricModule();

const canvases: Canvas[] = [];
let dispose: (() => void) | undefined;

afterEach(async () => {
  dispose?.();
  dispose = undefined;
  await Promise.all(
    canvases.splice(0).map(async (canvas) => {
      const element = canvas.lowerCanvasEl;
      await canvas.dispose();
      element.remove();
    }),
  );
});

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

/** A pointer event as `FabricOverlay` forwards it (see fabric-annotations' canvas harness). */
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

function gesture(canvas: Canvas, from: Point, to: Point): void {
  forward(canvas, 'pointermove', from);
  forward(canvas, 'pointerdown', from);
  for (let k = 1; k <= 4; k++) {
    forward(canvas, 'pointermove', {
      x: from.x + ((to.x - from.x) * k) / 4,
      y: from.y + ((to.y - from.y) * k) / 4,
    });
  }
  forward(canvas, 'pointerup', to);
}

/** Let queued microtasks and the rebuild's promises run. */
const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

const RECT: Geometry = {
  type: 'rectangle',
  origin: { x: 100, y: 100 },
  width: 120,
  height: 60,
  rotation: 0,
};
const CIRCLE: Geometry = { type: 'circle', center: { x: 380, y: 140 }, radius: 50 };

function annotation(id: string, geometry: Geometry): OsdAnnotation {
  return createAnnotationFromGeometry(geometry, {
    imageId,
    contextId,
    toolType: geometry.type === 'circle' ? 'circle' : 'rectangle',
    id: createAnnotationId(id),
  });
}

/** The provider, the hook with the select tool active on `canvas`, and a rebuild like ViewerCell's. */
async function setup() {
  const canvas = openCanvas();
  const overlay = {
    canvas,
    setMode: vi.fn(),
    screenToImage: (p: Point) => p,
    imageToScreen: (p: Point) => p,
    pressSeqOf: () => undefined,
    onDoubleClick: () => () => {},
  } as unknown as FabricOverlay;
  const modified: (string | undefined)[] = [];
  canvas.on('object:modified', ({ target }) => modified.push(target.id));

  let annotator: ReturnType<typeof useAnnotator> | undefined;
  let rebuilding: Promise<void> = Promise.resolve();
  const rebuild = (all: readonly OsdAnnotation[]): void => {
    const old = canvas.getObjects().filter((o) => o.id);
    if (old.length > 0) canvas.remove(...old);
    const stored = all.map((a) => JSON.parse(JSON.stringify(a)) as OsdAnnotation);
    rebuilding = Promise.all(stored.map((a) => createFabricObjectFromRawData(a))).then(
      (objects) => {
        canvas.add(...objects.filter((o): o is FabricObject => o !== null));
      },
    );
  };

  createRoot((d) => {
    dispose = d;
    createComponent(AnnotatorProvider, {
      initialAnnotations: {
        [imageId]: {
          [createAnnotationId('rect')]: annotation('rect', RECT),
          [createAnnotationId('circle')]: annotation('circle', CIRCLE),
        },
      },
      get children() {
        untrack(() => {
          annotator = useAnnotator();
          const a = annotator;
          a.actions.setContexts([
            { id: contextId, label: 'Test', tools: [{ type: 'rectangle' }, { type: 'circle' }] },
          ]);
          a.actions.setActiveContext(contextId);
          a.actions.assignImageToCell(0, imageId);
          a.actions.setActiveTool('select');
          useAnnotationTool(
            () => overlay,
            () => imageId,
            () => true,
          );
          createEffect(
            on(
              () => a.annotationState.changeCounter,
              () => rebuild(Object.values(a.annotationState.byImage[imageId] ?? {})),
            ),
          );
        });
        return null;
      },
    });
  });
  expect(annotator).toBeDefined();
  await rebuilding;
  const a = annotator!;
  return {
    canvas,
    modified,
    changes: () => a.annotationState.changeCounter,
    stored: (id: string) => a.annotationState.byImage[imageId]![id as AnnotationId]!.geometry,
    rebuilt: async () => {
      await settle();
      await rebuilding;
    },
  };
}

describe('useAnnotationTool commits', () => {
  it('a one-object drag is reported once and committed once', async () => {
    const h = await setup();
    forward(h.canvas, 'pointermove', { x: 160, y: 130 });
    forward(h.canvas, 'pointerdown', { x: 160, y: 130 });
    forward(h.canvas, 'pointerup', { x: 160, y: 130 });
    expect(h.canvas.getActiveObject()?.id).toBe('rect');
    const before = h.changes();

    gesture(h.canvas, { x: 160, y: 130 }, { x: 183, y: 141 });
    await h.rebuilt();

    expect(h.modified).toEqual(['rect']);
    expect(h.changes()).toBe(before + 1);
    expect(h.stored('rect')).toEqual({ ...RECT, origin: { x: 123, y: 111 } });
  });

  it('a moved multi-selection commits every member as one change, and stays selected', async () => {
    const h = await setup();
    // The select tool turns the drag-box on; set here too, so this test is
    // about the commit whichever layer turns it on.
    h.canvas.selection = true;
    gesture(h.canvas, { x: 20, y: 20 }, { x: 780, y: 580 });
    expect(h.canvas.getActiveObject()).toBeInstanceOf(ActiveSelection);
    const before = h.changes();

    gesture(h.canvas, { x: 160, y: 130 }, { x: 197, y: 109 });
    await h.rebuilt();

    expect(h.modified).toEqual([undefined]);
    expect(h.changes()).toBe(before + 1);
    const rect = h.stored('rect');
    expect(rect.type).toBe('rectangle');
    if (rect.type !== 'rectangle') return;
    expect(rect.origin.x).toBeCloseTo(137, 9);
    expect(rect.origin.y).toBeCloseTo(79, 9);
    expect(rect.width).toBeCloseTo(120, 9);
    expect(rect.height).toBeCloseTo(60, 9);
    const circle = h.stored('circle');
    expect(circle.type).toBe('circle');
    if (circle.type !== 'circle') return;
    expect(circle.center.x).toBeCloseTo(417, 9);
    expect(circle.center.y).toBeCloseTo(119, 9);
    expect(circle.radius).toBeCloseTo(50, 9);

    const active = h.canvas.getActiveObject();
    expect(active).toBeInstanceOf(ActiveSelection);
    const members = (active as ActiveSelection).getObjects();
    expect(members.map((o) => o.id).sort()).toEqual(['circle', 'rect']);
    for (const member of members) expect(h.canvas.getObjects()).toContain(member);
  });
});
