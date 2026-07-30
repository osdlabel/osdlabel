import type { CustomControlEvent, CustomControlHandler } from '../overlay/fabric-overlay.js';
import type { DragAxisBehavior } from './drag-axis.js';
import { createAxisDriver } from './drag-axis.js';

/** Configuration for {@link createDragVectorControl}. */
export interface DragVectorControlConfig {
  /** Behavior for horizontal drag. Omit to ignore the x-axis. */
  readonly x?: DragAxisBehavior | undefined;
  /** Behavior for vertical drag. Omit to ignore the y-axis. */
  readonly y?: DragAxisBehavior | undefined;
}

/**
 * Build a {@link CustomControlHandler} that drives **two independent values in
 * one gesture** — one per axis. Each axis has its own sensitivity, step, clamp
 * and direction, and each is written only when its own value actually changes,
 * so a purely horizontal drag never touches the vertical value (and vice
 * versa). That makes a single armed control cover both axes without the user
 * switching modes, while still allowing single-axis adjustment by dragging
 * along one axis.
 *
 * Both axes are measured from the same `pointerdown` origin, so releasing and
 * pressing again re-anchors the gesture.
 */
export function createDragVectorControl(config: DragVectorControlConfig): CustomControlHandler {
  const xDriver = config.x ? createAxisDriver('x', config.x) : null;
  const yDriver = config.y ? createAxisDriver('y', config.y) : null;

  let dragging = false;
  let startX = 0;
  let startY = 0;

  return {
    onPointerDown(event: CustomControlEvent): void {
      dragging = true;
      startX = event.screenPoint.x;
      startY = event.screenPoint.y;
      xDriver?.begin();
      yDriver?.begin();
    },
    onPointerMove(event: CustomControlEvent): void {
      if (!dragging) return;
      // Defensive: if no button is held the drag is over even though we never
      // saw a pointerup (e.g. a lost pointercancel). Disarm so hovering does
      // not keep mutating the values.
      if (event.originalEvent.buttons === 0) {
        dragging = false;
        return;
      }
      xDriver?.update(event.screenPoint.x - startX);
      yDriver?.update(event.screenPoint.y - startY);
    },
    onPointerUp(): void {
      dragging = false;
    },
  };
}
