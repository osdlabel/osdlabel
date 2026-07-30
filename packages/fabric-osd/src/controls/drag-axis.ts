/**
 * How one drag axis maps pointer distance onto a numeric value. Shared by the
 * single-axis {@link createDragValueControl} and the two-axis
 * {@link createDragVectorControl} so quantization, clamping, direction and
 * redundant-write suppression are defined exactly once.
 */
export interface DragAxisBehavior {
  /** Read the current value when a drag begins. */
  readonly getValue: () => number;
  /** Write the new value on each drag move (continuous). */
  readonly setValue: (value: number) => void;
  /**
   * Value-units changed per CSS pixel of drag along the axis. Default `1`.
   * Always positive — use {@link invert} to reverse the direction rather than a
   * negative sensitivity, so the magnitude and the direction stay separable.
   */
  readonly sensitivity?: number | undefined;
  /**
   * Reverse which way along the axis counts as "more". By default the x-axis
   * increases rightward and the y-axis increases upward (the convention that
   * "up" means "more"); set this to flip that. Default `false`.
   */
  readonly invert?: boolean | undefined;
  /** Lower clamp (inclusive). */
  readonly min?: number | undefined;
  /** Upper clamp (inclusive). */
  readonly max?: number | undefined;
  /**
   * Quantize the emitted value to multiples of this step (the resolution of
   * change). When omitted the value is continuous. Example: `0.025` snaps a
   * drag to the nearest 0.025.
   */
  readonly step?: number | undefined;
}

/** Stateful driver for a single axis of an in-progress drag. */
export interface AxisDriver {
  /** Capture the starting value; call on `pointerdown`. */
  begin(): void;
  /** Apply a raw screen-space delta (current minus start) along this axis. */
  update(rawDelta: number): void;
}

/**
 * Build a driver for one axis. `axis` only selects the default direction:
 * screen y grows downward, so a y-axis driver negates the raw delta to make
 * dragging up mean "more". `invert` flips whichever default applies.
 */
export function createAxisDriver(axis: 'x' | 'y', config: DragAxisBehavior): AxisDriver {
  const sensitivity = config.sensitivity ?? 1;
  const directionSign = (axis === 'y' ? -1 : 1) * (config.invert ? -1 : 1);
  const min = config.min ?? Number.NEGATIVE_INFINITY;
  const max = config.max ?? Number.POSITIVE_INFINITY;
  const step = config.step;

  let startValue = 0;
  let lastValue = 0;

  return {
    begin(): void {
      startValue = config.getValue();
      lastValue = startValue;
    },
    update(rawDelta: number): void {
      let next = startValue + rawDelta * directionSign * sensitivity;
      // Quantize to the configured resolution before clamping so the value
      // lands on a clean grid (e.g. multiples of 0.025).
      if (step !== undefined && step > 0) {
        next = Math.round(next / step) * step;
      }
      next = Math.min(Math.max(next, min), max);
      // Skip redundant writes — notably while clamped at min/max or held within
      // the same step during a drag. Tracked per axis, so a gesture that only
      // moves horizontally never writes the vertical axis.
      if (next === lastValue) return;
      lastValue = next;
      config.setValue(next);
    },
  };
}
