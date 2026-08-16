import { describe, it, expect } from 'vitest';
import { computeScrollZoom, SCROLL_ZOOM_PER_NOTCH } from '../../../src/overlay/scroll-zoom.js';
import { mirrorScreenX } from '../../../src/overlay/mirror-screen-x.js';

const CONTAINER_WIDTH = 800;

function input(overrides: {
  deltaY: number;
  x?: number;
  y?: number;
  flipped?: boolean;
  containerWidth?: number;
}) {
  return {
    deltaY: overrides.deltaY,
    position: { x: overrides.x ?? 100, y: overrides.y ?? 50 },
    containerWidth: overrides.containerWidth ?? CONTAINER_WIDTH,
    flipped: overrides.flipped ?? false,
  };
}

describe('computeScrollZoom', () => {
  it('zooms in when the wheel is pushed away from the user', () => {
    // deltaY is negative for wheel-up in every deltaMode.
    expect(computeScrollZoom(input({ deltaY: -120 }))?.factor).toBeCloseTo(SCROLL_ZOOM_PER_NOTCH);
  });

  it('zooms out when the wheel is pulled toward the user', () => {
    expect(computeScrollZoom(input({ deltaY: 120 }))?.factor).toBeCloseTo(
      1 / SCROLL_ZOOM_PER_NOTCH,
    );
  });

  it('uses only the sign of deltaY, so deltaMode does not matter', () => {
    const pixels = computeScrollZoom(input({ deltaY: -120 }));
    const lines = computeScrollZoom(input({ deltaY: -3 }));
    expect(pixels?.factor).toBe(lines?.factor);
  });

  it('returns null for a purely horizontal wheel', () => {
    // Regression: `-0 > 0` is false, so a naive sign test treated a horizontal
    // trackpad shear or tilt wheel as "scroll down" and zoomed out.
    expect(computeScrollZoom(input({ deltaY: 0 }))).toBeNull();
    expect(computeScrollZoom(input({ deltaY: -0 }))).toBeNull();
  });

  it('anchors at the pointer position when not flipped', () => {
    const command = computeScrollZoom(input({ deltaY: -120, x: 100, y: 50 }));
    expect(command?.anchorPixel).toEqual({ x: 100, y: 50 });
  });

  it('mirrors the anchor x around the container width when flipped', () => {
    const command = computeScrollZoom(input({ deltaY: -120, x: 100, y: 50, flipped: true }));
    // OSD's own onCanvasScroll applies exactly this mirror before
    // pointFromPixel; without it the view zooms toward the mirror image.
    expect(command?.anchorPixel).toEqual({ x: CONTAINER_WIDTH - 100, y: 50 });
  });

  it('leaves the anchor y untouched under flip', () => {
    const command = computeScrollZoom(input({ deltaY: 120, y: 321, flipped: true }));
    expect(command?.anchorPixel.y).toBe(321);
  });

  it('ignores the container width entirely when not flipped', () => {
    // containerWidth may only enter the result through the flip mirror. This
    // pins the contract that the anchor is the element-relative pointer
    // position and nothing else — the old handler passed clientX/clientY, so
    // the anchor drifted by wherever the viewer sat in the window, an offset
    // that changes on a fullscreen transition.
    const narrow = computeScrollZoom(input({ deltaY: -120, x: 100, containerWidth: 400 }));
    const wide = computeScrollZoom(input({ deltaY: -120, x: 100, containerWidth: 4000 }));
    expect(narrow).toEqual(wide);
  });
});

describe('mirrorScreenX', () => {
  it('is the identity when not flipped', () => {
    expect(mirrorScreenX(100, CONTAINER_WIDTH, false)).toBe(100);
  });

  it('mirrors around the container width when flipped', () => {
    expect(mirrorScreenX(100, CONTAINER_WIDTH, true)).toBe(700);
  });

  it('is its own inverse', () => {
    const once = mirrorScreenX(137, CONTAINER_WIDTH, true);
    expect(mirrorScreenX(once, CONTAINER_WIDTH, true)).toBe(137);
  });

  it('maps the container midpoint to itself', () => {
    expect(mirrorScreenX(CONTAINER_WIDTH / 2, CONTAINER_WIDTH, true)).toBe(CONTAINER_WIDTH / 2);
  });
});
