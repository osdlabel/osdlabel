import { describe, it, expect, vi, afterEach } from 'vitest';
import { act, useEffect } from 'react';
import { ActiveSelection, Canvas, type FabricObject } from 'fabric';
import type { FabricOverlay } from '@osdlabel/fabric-osd';
import { createFabricObjectFromRawData, initFabricModule } from '@osdlabel/fabric-annotations';
import {
  createAnnotationId,
  type AnnotationId,
  type VectorGeometry,
  type Point,
} from '@osdlabel/annotation';
import { createAnnotationFromGeometry, type OsdAnnotation } from 'osdlabel';
import { useAnnotationTool } from '../../../src/hooks/useAnnotationTool.js';
import { useAnnotator } from '../../../src/state/annotator-context.js';
import { renderAnnotator } from '../render-annotator.js';
import { unmountAll } from '../mount.js';
import { contextId, imageId } from '../fixtures.js';

/**
 * The React counterpart of Solid's `hooks/useAnnotationTool.commit.test.ts`:
 * what the hook saves when Fabric reports an edit, on a real Fabric canvas
 * driven through pointer events, with the real provider.
 *
 * The canvas is rebuilt from state the way React's `ViewerCell` rebuilds it,
 * in an effect on this image's annotations, which React runs after the render
 * the commit causes. React already reported and committed a one-object drag
 * once (Solid did not); the test pins that the two agree. A multi-selection's
 * edit was not committed at all.
 */

// As FabricOverlay's constructor does, so saved data carries the id.
initFabricModule();

const canvases: Canvas[] = [];

afterEach(async () => {
  unmountAll();
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

const RECT: VectorGeometry = {
  type: 'rectangle',
  origin: { x: 100, y: 100 },
  width: 120,
  height: 60,
  rotation: 0,
};
const CIRCLE: VectorGeometry = { type: 'circle', center: { x: 380, y: 140 }, radius: 50 };

function annotation(id: string, geometry: VectorGeometry): OsdAnnotation {
  return createAnnotationFromGeometry(geometry, {
    imageId,
    contextId,
    toolType: geometry.type === 'circle' ? 'circle' : 'rectangle',
    id: createAnnotationId(id),
  });
}

/** The hook on `overlay`, and the canvas rebuilt from this image's annotations, as ViewerCell does. */
function Cell(props: {
  readonly overlay: FabricOverlay;
  readonly rebuild: (all: readonly OsdAnnotation[]) => void;
}) {
  useAnnotationTool(props.overlay, imageId, true);
  const { annotationState } = useAnnotator();
  const forImage = annotationState.byImage[imageId];
  const { rebuild } = props;
  useEffect(() => {
    rebuild(Object.values(forImage ?? {}));
  }, [forImage, rebuild]);
  return null;
}

async function setup() {
  const canvas = openCanvas();
  const overlay = {
    canvas,
    setMode: vi.fn(),
    screenToImage: (p: Point) => p,
    imageToScreen: (p: Point) => p,
    pressSeqOf: () => undefined,
    onDoubleClick: () => () => {},
    onPointerCancel: () => () => {},
  } as unknown as FabricOverlay;
  const modified: (string | undefined)[] = [];
  canvas.on('object:modified', ({ target }) => modified.push(target.id));

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

  const h = renderAnnotator(
    {
      initialAnnotations: {
        [imageId]: {
          [createAnnotationId('rect')]: annotation('rect', RECT),
          [createAnnotationId('circle')]: annotation('circle', CIRCLE),
        },
      },
    },
    <Cell overlay={overlay} rebuild={rebuild} />,
  );
  h.run((a) => {
    a.setContexts([
      { id: contextId, label: 'Test', tools: [{ type: 'rectangle' }, { type: 'circle' }] },
    ]);
    a.setActiveContext(contextId);
    a.assignImageToCell(0, imageId);
    a.setActiveTool('select');
  });
  await act(async () => {
    await rebuilding;
  });

  const snapshot = () => h.current.store.getSnapshot().annotationState;
  return {
    canvas,
    modified,
    changes: () => snapshot().changeCounter,
    stored: (id: string) => snapshot().byImage[imageId]![id as AnnotationId]!.geometry,
    /** Run a gesture, then let the commit, React's render and effects, and the rebuild finish. */
    act: async (fn: () => void): Promise<void> => {
      await act(async () => {
        fn();
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
      });
      await act(async () => {
        await rebuilding;
      });
    },
  };
}

describe('useAnnotationTool commits', () => {
  it('a one-object drag is reported once and committed once', async () => {
    const h = await setup();
    await h.act(() => {
      forward(h.canvas, 'pointermove', { x: 160, y: 130 });
      forward(h.canvas, 'pointerdown', { x: 160, y: 130 });
      forward(h.canvas, 'pointerup', { x: 160, y: 130 });
    });
    expect(h.canvas.getActiveObject()?.id).toBe('rect');
    const before = h.changes();

    await h.act(() => gesture(h.canvas, { x: 160, y: 130 }, { x: 183, y: 141 }));

    expect(h.modified).toEqual(['rect']);
    expect(h.changes()).toBe(before + 1);
    expect(h.stored('rect')).toEqual({ ...RECT, origin: { x: 123, y: 111 } });
  });

  it('a moved multi-selection commits every member as one change, and stays selected', async () => {
    const h = await setup();
    // The select tool turns the drag-box on; set here too, so this test is
    // about the commit whichever layer turns it on.
    h.canvas.selection = true;
    await h.act(() => gesture(h.canvas, { x: 20, y: 20 }, { x: 780, y: 580 }));
    expect(h.canvas.getActiveObject()).toBeInstanceOf(ActiveSelection);
    const before = h.changes();

    await h.act(() => gesture(h.canvas, { x: 160, y: 130 }, { x: 197, y: 109 }));

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
