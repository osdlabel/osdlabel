import type { CustomControlEvent, CustomControlHandler } from '../overlay/fabric-overlay.js';
import type { DragAxisBehavior } from './drag-axis.js';
import { createAxisDriver } from './drag-axis.js';

/** Configuration for {@link createDragValueControl}. */
export interface DragValueControlConfig extends DragAxisBehavior {
  /** Drag axis driving the value. Default `'x'`. */
  readonly axis?: 'x' | 'y' | undefined;
}

/**
 * Build a {@link CustomControlHandler} that maps pointer-drag distance along a
 * single axis onto a numeric value. The handler captures the start value and
 * pointer position on `pointerdown`, then on each `pointermove` sets
 * `startValue + delta(axis) * sensitivity`, optionally quantized to `step`
 * and clamped to `[min, max]`.
 *
 * Framework-agnostic and side-effect-free apart from the supplied
 * `getValue`/`setValue`, so it is reusable for any drag-driven viewer function
 * and trivial to unit test. For a gesture that drives two values at once (one
 * per axis), use {@link createDragVectorControl}.
 */
export function createDragValueControl(config: DragValueControlConfig): CustomControlHandler {
  const axis = config.axis ?? 'x';
  const driver = createAxisDriver(axis, config);

  let dragging = false;
  let startScreen = 0;

  const coord = (event: CustomControlEvent): number =>
    axis === 'x' ? event.screenPoint.x : event.screenPoint.y;

  return {
    onPointerDown(event: CustomControlEvent): void {
      dragging = true;
      startScreen = coord(event);
      driver.begin();
    },
    onPointerMove(event: CustomControlEvent): void {
      if (!dragging) return;
      // Defensive: if no button is held the drag is over even though we never
      // saw a pointerup (e.g. a lost pointercancel). Disarm so hovering does
      // not keep mutating the value.
      if (event.originalEvent.buttons === 0) {
        dragging = false;
        return;
      }
      driver.update(coord(event) - startScreen);
    },
    onPointerUp(): void {
      dragging = false;
    },
  };
}
