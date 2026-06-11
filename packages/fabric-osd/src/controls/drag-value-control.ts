import type { CustomControlEvent, CustomControlHandler } from '../overlay/fabric-overlay.js';

/** Configuration for {@link createDragValueControl}. */
export interface DragValueControlConfig {
  /** Read the current value when a drag begins. */
  readonly getValue: () => number;
  /** Write the new value on each drag move (continuous). */
  readonly setValue: (value: number) => void;
  /** Drag axis driving the value. Default `'x'`. */
  readonly axis?: 'x' | 'y';
  /**
   * Value-units changed per CSS pixel of drag along {@link axis}. Default `1`.
   * For the y-axis, dragging up (decreasing screen y) increases the value.
   */
  readonly sensitivity?: number;
  /** Lower clamp (inclusive). */
  readonly min?: number;
  /** Upper clamp (inclusive). */
  readonly max?: number;
  /**
   * Quantize the emitted value to multiples of this step (the resolution of
   * change). When omitted the value is continuous. Example: `0.025` snaps a
   * drag to the nearest 0.025.
   */
  readonly step?: number;
}

/**
 * Build a {@link CustomControlHandler} that maps pointer-drag distance onto a
 * numeric value. The handler captures the start value and pointer position on
 * `pointerdown`, then on each `pointermove` sets
 * `startValue + delta(axis) * sensitivity`, optionally quantized to `step`
 * and clamped to `[min, max]`.
 *
 * Framework-agnostic and side-effect-free apart from the supplied
 * `getValue`/`setValue`, so it is reusable for any drag-driven viewer function
 * (exposure being the first) and trivial to unit test.
 */
export function createDragValueControl(config: DragValueControlConfig): CustomControlHandler {
  const axis = config.axis ?? 'x';
  const sensitivity = config.sensitivity ?? 1;
  const min = config.min ?? Number.NEGATIVE_INFINITY;
  const max = config.max ?? Number.POSITIVE_INFINITY;
  const step = config.step;

  let dragging = false;
  let startScreen = 0;
  let startValue = 0;
  let lastValue = 0;

  const coord = (event: CustomControlEvent): number =>
    axis === 'x' ? event.screenPoint.x : event.screenPoint.y;

  return {
    onPointerDown(event: CustomControlEvent): void {
      dragging = true;
      startScreen = coord(event);
      startValue = config.getValue();
      lastValue = startValue;
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
      // For the y-axis, dragging up (smaller screen y) should increase the
      // value, matching the convention that "up" means "more".
      const rawDelta = coord(event) - startScreen;
      const delta = axis === 'y' ? -rawDelta : rawDelta;
      let next = startValue + delta * sensitivity;
      // Quantize to the configured resolution before clamping so the value
      // lands on a clean grid (e.g. multiples of 0.025).
      if (step !== undefined && step > 0) {
        next = Math.round(next / step) * step;
      }
      next = Math.min(Math.max(next, min), max);
      // Skip redundant writes — notably while clamped at min/max or held within
      // the same step during a drag.
      if (next === lastValue) return;
      lastValue = next;
      config.setValue(next);
    },
    onPointerUp(): void {
      dragging = false;
    },
  };
}
