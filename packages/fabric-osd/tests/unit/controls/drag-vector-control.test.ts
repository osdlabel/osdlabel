import { describe, it, expect } from 'vitest';
import { createDragVectorControl } from '../../../src/controls/drag-vector-control.js';
import type { CustomControlEvent } from '../../../src/overlay/fabric-overlay.js';

function evt(x: number, y: number, buttons = 1): CustomControlEvent {
  return {
    originalEvent: { clientX: x, clientY: y, buttons } as unknown as PointerEvent,
    screenPoint: { x, y },
    imagePoint: { x, y },
  };
}

/** Mirrors how the bundled `tone` control is configured. */
function toneControl() {
  const values = { exposure: 0, contrast: 0 };
  const writes = { exposure: 0, contrast: 0 };
  const control = createDragVectorControl({
    x: {
      getValue: () => values.exposure,
      setValue: (v) => {
        values.exposure = v;
        writes.exposure += 1;
      },
      invert: true, // left = brighter
      sensitivity: 0.01,
      step: 0.025,
      min: -1,
      max: 1,
    },
    y: {
      getValue: () => values.contrast,
      setValue: (v) => {
        values.contrast = v;
        writes.contrast += 1;
      },
      sensitivity: 0.01,
      step: 0.025,
      min: -1,
      max: 1,
    },
  });
  return { control, values, writes };
}

describe('createDragVectorControl', () => {
  it('drives both axes in a single diagonal gesture', () => {
    const { control, values } = toneControl();

    control.onPointerDown?.(evt(100, 100));
    control.onPointerMove?.(evt(60, 70)); // 40px left → +0.4 exposure; 30px up → +0.3 contrast
    expect(values.exposure).toBeCloseTo(0.4);
    expect(values.contrast).toBeCloseTo(0.3);
  });

  it('leaves the other axis untouched during a single-axis drag', () => {
    const { control, values, writes } = toneControl();

    control.onPointerDown?.(evt(100, 100));
    control.onPointerMove?.(evt(60, 100)); // purely horizontal
    expect(values.exposure).toBeCloseTo(0.4);
    expect(values.contrast).toBe(0);
    // No redundant write on the axis that did not move.
    expect(writes.contrast).toBe(0);

    control.onPointerUp?.(evt(60, 100));

    control.onPointerDown?.(evt(60, 100));
    control.onPointerMove?.(evt(60, 60)); // purely vertical
    expect(values.contrast).toBeCloseTo(0.4);
    expect(values.exposure).toBeCloseTo(0.4); // preserved from the first gesture
    expect(writes.exposure).toBe(1);
  });

  it('applies each axis direction independently', () => {
    const { control, values } = toneControl();

    control.onPointerDown?.(evt(100, 100));
    control.onPointerMove?.(evt(140, 140)); // right → darker; down → less contrast
    expect(values.exposure).toBeCloseTo(-0.4);
    expect(values.contrast).toBeCloseTo(-0.4);
  });

  it('clamps and quantizes per axis', () => {
    const { control, values } = toneControl();

    control.onPointerDown?.(evt(0, 0));
    control.onPointerMove?.(evt(-7, -7)); // raw 0.07 on both → nearest 0.025 = 0.075
    expect(values.exposure).toBeCloseTo(0.075);
    expect(values.contrast).toBeCloseTo(0.075);

    control.onPointerMove?.(evt(-10000, -10000));
    expect(values.exposure).toBe(1);
    expect(values.contrast).toBe(1);
  });

  it('re-anchors both axes on a new pointer-down', () => {
    const { control, values } = toneControl();

    control.onPointerDown?.(evt(100, 100));
    control.onPointerMove?.(evt(80, 80)); // +0.2 / +0.2
    control.onPointerUp?.(evt(80, 80));

    control.onPointerDown?.(evt(0, 0)); // new origin, values captured fresh
    control.onPointerMove?.(evt(-10, -10)); // +0.1 on top of 0.2
    expect(values.exposure).toBeCloseTo(0.3);
    expect(values.contrast).toBeCloseTo(0.3);
  });

  it('ignores moves before pointer-down and after pointer-up', () => {
    const { control, values } = toneControl();

    control.onPointerMove?.(evt(-50, -50));
    expect(values.exposure).toBe(0);
    expect(values.contrast).toBe(0);

    control.onPointerDown?.(evt(0, 0));
    control.onPointerMove?.(evt(-10, -10));
    control.onPointerUp?.(evt(-10, -10));
    control.onPointerMove?.(evt(-1000, -1000));
    expect(values.exposure).toBeCloseTo(0.1);
    expect(values.contrast).toBeCloseTo(0.1);
  });

  it('disarms both axes when a move arrives with no button held', () => {
    const { control, values } = toneControl();

    control.onPointerDown?.(evt(0, 0));
    control.onPointerMove?.(evt(-10, -10));
    expect(values.exposure).toBeCloseTo(0.1);

    control.onPointerMove?.(evt(-500, -500, 0)); // lost pointerup
    expect(values.exposure).toBeCloseTo(0.1);
    expect(values.contrast).toBeCloseTo(0.1);

    control.onPointerMove?.(evt(-800, -800, 1)); // hover after the drag ended
    expect(values.exposure).toBeCloseTo(0.1);
    expect(values.contrast).toBeCloseTo(0.1);
  });

  it('ignores an axis that has no configured behavior', () => {
    let contrast = 0;
    const control = createDragVectorControl({
      y: {
        getValue: () => contrast,
        setValue: (v) => {
          contrast = v;
        },
        sensitivity: 0.01,
      },
    });

    control.onPointerDown?.(evt(0, 0));
    control.onPointerMove?.(evt(500, -20)); // large horizontal move is a no-op
    expect(contrast).toBeCloseTo(0.2);
  });
});
