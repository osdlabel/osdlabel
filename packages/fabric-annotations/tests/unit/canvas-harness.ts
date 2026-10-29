import { Canvas, type FabricObject } from 'fabric';
import type { Point } from '@osdlabel/annotation';

/**
 * A real Fabric `Canvas` in jsdom, configured as `FabricOverlay` configures
 * its own (drag-box selection off, as annotation mode leaves it), with an
 * identity viewport so client, canvas and scene coordinates coincide.
 *
 * Call `disposeCanvases` in `afterEach`.
 */
const open: Canvas[] = [];

export function openCanvas(): Canvas {
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
  open.push(canvas);
  return canvas;
}

export async function disposeCanvases(): Promise<void> {
  await Promise.all(
    open.splice(0).map(async (canvas) => {
      const element = canvas.lowerCanvasEl;
      await canvas.dispose();
      element.remove();
    }),
  );
}

export interface PointerOptions {
  readonly shiftKey?: boolean;
}

/**
 * One forwarded pointer event, the way `FabricOverlay._forwardToFabric` sends
 * it: the press on the upper canvas without bubbling, the move and release
 * bubbling (Fabric listens for those on the document). jsdom has no
 * PointerEvent; Fabric reads only clientX/clientY, button and the modifier
 * keys, so a MouseEvent carrying the pointer event's type stands in for it.
 */
export function forward(
  canvas: Canvas,
  type: 'pointerdown' | 'pointermove' | 'pointerup',
  at: Point,
  options: PointerOptions = {},
): void {
  canvas.upperCanvasEl.dispatchEvent(
    new MouseEvent(type, {
      clientX: at.x,
      clientY: at.y,
      bubbles: type !== 'pointerdown',
      cancelable: true,
      button: 0,
      shiftKey: options.shiftKey ?? false,
    }),
  );
}

/** Hover `from`, press, move to `to` in four steps, release. */
export function gesture(
  canvas: Canvas,
  from: Point,
  to: Point,
  options: PointerOptions = {},
): void {
  forward(canvas, 'pointermove', from, options);
  forward(canvas, 'pointerdown', from, options);
  for (let k = 1; k <= 4; k++) {
    forward(
      canvas,
      'pointermove',
      { x: from.x + ((to.x - from.x) * k) / 4, y: from.y + ((to.y - from.y) * k) / 4 },
      options,
    );
  }
  forward(canvas, 'pointerup', to, options);
}

/** Hover, press and release at `at`. */
export function click(canvas: Canvas, at: Point, options: PointerOptions = {}): void {
  forward(canvas, 'pointermove', at, options);
  forward(canvas, 'pointerdown', at, options);
  forward(canvas, 'pointerup', at, options);
}

/** Where control `key` of `object` is drawn, nudged off its exact centre (see `rectangle-fabric.test.ts`). */
export function controlPoint(object: FabricObject, key: string): Point {
  object.setCoords();
  const coord = object.oCoords[key];
  if (!coord) throw new Error(`no ${key} control`);
  return { x: coord.x + 0.31, y: coord.y + 0.17 };
}

/** The names of `object`'s controls, sorted. */
export function controlNames(object: FabricObject): string[] {
  return Object.keys(object.controls).sort();
}
