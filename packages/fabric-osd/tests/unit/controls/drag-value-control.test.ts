import { describe, it, expect } from 'vitest';
import { createDragValueControl } from '../../../src/controls/drag-value-control.js';
import type { CustomControlEvent } from '../../../src/overlay/fabric-overlay.js';

/**
 * Builds a CustomControlEvent with the given element-relative screen point.
 * The originalEvent / imagePoint are unused by createDragValueControl, so we
 * supply minimal stand-ins.
 */
function evt(x: number, y: number): CustomControlEvent {
  return {
    originalEvent: { clientX: x, clientY: y } as unknown as PointerEvent,
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
