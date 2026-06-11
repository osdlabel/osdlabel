import { describe, it, expect } from 'vitest';
import { createDragValueControl } from '../../../src/controls/drag-value-control.js';
import type { CustomControlEvent } from '../../../src/overlay/fabric-overlay.js';

/**
 * Builds a CustomControlEvent with the given element-relative screen point.
 * The originalEvent / imagePoint are unused by createDragValueControl, so we
 * supply minimal stand-ins.
 */
function evt(x: number, y: number, buttons = 1): CustomControlEvent {
  return {
    originalEvent: { clientX: x, clientY: y, buttons } as unknown as PointerEvent,
    screenPoint: { x, y },
    imagePoint: { x, y },
  };
}

describe('createDragValueControl', () => {
  it('maps horizontal drag distance onto the value via sensitivity', () => {
    let value = 0;
    const control = createDragValueControl({
      getValue: () => value,
      setValue: (v) => {
        value = v;
      },
      sensitivity: 0.01,
    });

    control.onPointerDown?.(evt(100, 50));
    control.onPointerMove?.(evt(150, 50)); // +50px * 0.01 = +0.5
    expect(value).toBeCloseTo(0.5);

    control.onPointerMove?.(evt(60, 50)); // -40px from start * 0.01 = -0.4
    expect(value).toBeCloseTo(-0.4);
  });

  it('captures the starting value at pointer-down', () => {
    let value = 0.3;
    const control = createDragValueControl({
      getValue: () => value,
      setValue: (v) => {
        value = v;
      },
      sensitivity: 0.01,
    });

    control.onPointerDown?.(evt(0, 0));
    control.onPointerMove?.(evt(20, 0)); // 0.3 + 20*0.01 = 0.5
    expect(value).toBeCloseTo(0.5);
  });

  it('clamps to [min, max]', () => {
    let value = 0;
    const control = createDragValueControl({
      getValue: () => value,
      setValue: (v) => {
        value = v;
      },
      sensitivity: 0.01,
      min: -1,
      max: 1,
    });

    control.onPointerDown?.(evt(0, 0));
    control.onPointerMove?.(evt(10000, 0));
    expect(value).toBe(1);
    control.onPointerMove?.(evt(-10000, 0));
    expect(value).toBe(-1);
  });

  it('ignores moves before a pointer-down', () => {
    let calls = 0;
    const control = createDragValueControl({
      getValue: () => 0,
      setValue: () => {
        calls += 1;
      },
    });

    control.onPointerMove?.(evt(50, 50));
    expect(calls).toBe(0);
  });

  it('stops responding to moves after pointer-up', () => {
    let value = 0;
    const control = createDragValueControl({
      getValue: () => value,
      setValue: (v) => {
        value = v;
      },
      sensitivity: 0.01,
    });

    control.onPointerDown?.(evt(0, 0));
    control.onPointerMove?.(evt(10, 0));
    expect(value).toBeCloseTo(0.1);
    control.onPointerUp?.(evt(10, 0));

    control.onPointerMove?.(evt(1000, 0));
    expect(value).toBeCloseTo(0.1); // unchanged
  });

  it('disarms when a move arrives with no button held (lost pointerup/cancel)', () => {
    let value = 0;
    const control = createDragValueControl({
      getValue: () => value,
      setValue: (v) => {
        value = v;
      },
      sensitivity: 0.01,
    });

    control.onPointerDown?.(evt(0, 0));
    control.onPointerMove?.(evt(10, 0)); // dragging, button held
    expect(value).toBeCloseTo(0.1);

    // A move with buttons === 0 means the press ended without a pointerup.
    control.onPointerMove?.(evt(500, 0, 0));
    expect(value).toBeCloseTo(0.1); // unchanged — disarmed

    // Subsequent hover moves must not mutate the value either.
    control.onPointerMove?.(evt(1000, 0, 1));
    expect(value).toBeCloseTo(0.1);
  });

  it('skips redundant setValue calls while clamped at a boundary', () => {
    let calls = 0;
    const control = createDragValueControl({
      getValue: () => 0,
      setValue: () => {
        calls += 1;
      },
      sensitivity: 0.01,
      max: 1,
    });

    control.onPointerDown?.(evt(0, 0));
    control.onPointerMove?.(evt(10000, 0)); // clamps to 1 → 1 write
    control.onPointerMove?.(evt(20000, 0)); // still 1 → no write
    control.onPointerMove?.(evt(30000, 0)); // still 1 → no write
    expect(calls).toBe(1);
  });

  it('quantizes the value to the configured step (resolution of change)', () => {
    let value = 0;
    const control = createDragValueControl({
      getValue: () => value,
      setValue: (v) => {
        value = v;
      },
      sensitivity: 0.01,
      step: 0.025,
    });

    control.onPointerDown?.(evt(0, 0));

    control.onPointerMove?.(evt(7, 0)); // raw 0.07 → nearest 0.025 = 0.075
    expect(value).toBeCloseTo(0.075);

    control.onPointerMove?.(evt(1, 0)); // raw 0.01 → nearest 0.025 = 0.0 (snaps back)
    expect(value).toBeCloseTo(0);

    control.onPointerMove?.(evt(4, 0)); // raw 0.04 → nearest 0.025 = 0.05
    expect(value).toBeCloseTo(0.05);
  });

  it('does not emit until the drag crosses a step boundary', () => {
    const writes: number[] = [];
    const control = createDragValueControl({
      getValue: () => 0,
      setValue: (v) => writes.push(v),
      sensitivity: 0.01,
      step: 0.025,
    });

    control.onPointerDown?.(evt(0, 0));
    control.onPointerMove?.(evt(1, 0)); // raw 0.01 → 0 (== start, no write)
    control.onPointerMove?.(evt(2, 0)); // raw 0.02 → 0.025? round(0.8)=1 → 0.025
    expect(writes).toEqual([0.025]);
  });

  it('treats upward drag as increasing on the y-axis', () => {
    let value = 0;
    const control = createDragValueControl({
      getValue: () => value,
      setValue: (v) => {
        value = v;
      },
      axis: 'y',
      sensitivity: 0.01,
    });

    control.onPointerDown?.(evt(0, 100));
    control.onPointerMove?.(evt(0, 60)); // dragged up 40px → +0.4
    expect(value).toBeCloseTo(0.4);
  });
});
