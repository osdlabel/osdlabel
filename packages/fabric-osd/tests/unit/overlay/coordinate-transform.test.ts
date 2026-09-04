import { describe, it, expect, vi } from 'vitest';
import {
  computeViewportTransform,
  imageToScreenFlipAware,
  screenToImageFlipAware,
} from '../../../src/overlay/fabric-overlay.js';
import type OpenSeadragon from 'openseadragon';

/**
 * Create a mock OSD viewer with a configurable viewport transform.
 *
 * Mirrors real OSD behavior:
 * - imageToViewerElementCoordinates handles zoom, pan, rotation — but NOT flip
 * - Flip is a separate flag read by computeViewportTransform and composed into the matrix
 * - containerWidth is used for the flip mirror axis
 */
function createMockViewer(options: {
  scale: number;
  offsetX: number;
  offsetY: number;
  rotationDeg?: number;
  flip?: boolean;
  containerWidth?: number;
}): OpenSeadragon.Viewer {
  const { scale, offsetX, offsetY, rotationDeg = 0, flip = false, containerWidth = 800 } = options;
  const rad = (rotationDeg * Math.PI) / 180;
  const cosR = Math.cos(rad);
  const sinR = Math.sin(rad);

  return {
    viewport: {
      getFlip: () => flip,
      getContainerSize: () => ({ x: containerWidth, y: 600 }),
      imageToViewerElementCoordinates: vi.fn((point: { x: number; y: number }) => {
        // Rotation + scale + translate — NO flip (matches real OSD behavior)
        const sx = cosR * scale * point.x - sinR * scale * point.y + offsetX;
        const sy = sinR * scale * point.x + cosR * scale * point.y + offsetY;
        return { x: sx, y: sy };
      }),
      viewerElementToImageCoordinates: vi.fn((point: { x: number; y: number }) => {
        // Inverse: undo translate, then undo rotation+scale
        const px = point.x - offsetX;
        const py = point.y - offsetY;
        const ix = (cosR * px + sinR * py) / scale;
        const iy = (-sinR * px + cosR * py) / scale;
        return { x: ix, y: iy };
      }),
    },
  } as unknown as OpenSeadragon.Viewer;
}

describe('computeViewportTransform', () => {
  it('returns identity-like matrix at 1:1 zoom with no pan', () => {
    const viewer = createMockViewer({ scale: 1, offsetX: 0, offsetY: 0 });
    const vpt = computeViewportTransform(viewer);

    // [scaleX, skewY, skewX, scaleY, tx, ty]
    expect(vpt[0]).toBeCloseTo(1); // scaleX
    expect(vpt[1]).toBeCloseTo(0); // skewY (no rotation)
    expect(vpt[2]).toBeCloseTo(0); // skewX (no rotation)
    expect(vpt[3]).toBeCloseTo(1); // scaleY
    expect(vpt[4]).toBeCloseTo(0); // tx
    expect(vpt[5]).toBeCloseTo(0); // ty
  });

  it('returns correct matrix at 2x zoom with no pan', () => {
    const viewer = createMockViewer({ scale: 2, offsetX: 0, offsetY: 0 });
    const vpt = computeViewportTransform(viewer);

    expect(vpt[0]).toBeCloseTo(2);
    expect(vpt[1]).toBeCloseTo(0);
    expect(vpt[2]).toBeCloseTo(0);
    expect(vpt[3]).toBeCloseTo(2);
    expect(vpt[4]).toBeCloseTo(0);
    expect(vpt[5]).toBeCloseTo(0);
  });

  it('returns correct matrix with zoom and pan offset', () => {
    const viewer = createMockViewer({ scale: 3, offsetX: 100, offsetY: -50 });
    const vpt = computeViewportTransform(viewer);

    expect(vpt[0]).toBeCloseTo(3); // scaleX
    expect(vpt[1]).toBeCloseTo(0);
    expect(vpt[2]).toBeCloseTo(0);
    expect(vpt[3]).toBeCloseTo(3); // scaleY
    expect(vpt[4]).toBeCloseTo(100); // tx
    expect(vpt[5]).toBeCloseTo(-50); // ty
  });

  it('returns correct matrix with 90-degree rotation', () => {
    const viewer = createMockViewer({ scale: 1, offsetX: 0, offsetY: 0, rotationDeg: 90 });
    const vpt = computeViewportTransform(viewer);

    // cos(90°) ≈ 0, sin(90°) = 1
    expect(vpt[0]).toBeCloseTo(0); // cos * scale
    expect(vpt[1]).toBeCloseTo(1); // sin * scale
    expect(vpt[2]).toBeCloseTo(-1); // -sin * scale
    expect(vpt[3]).toBeCloseTo(0); // cos * scale
    expect(vpt[4]).toBeCloseTo(0);
    expect(vpt[5]).toBeCloseTo(0);
  });

  it('returns correct matrix with 45-degree rotation and 2x zoom', () => {
    const viewer = createMockViewer({ scale: 2, offsetX: 50, offsetY: 50, rotationDeg: 45 });
    const vpt = computeViewportTransform(viewer);

    const cos45 = Math.cos(Math.PI / 4);
    const sin45 = Math.sin(Math.PI / 4);

    expect(vpt[0]).toBeCloseTo(cos45 * 2); // a = cos * scale
    expect(vpt[1]).toBeCloseTo(sin45 * 2); // b = sin * scale
    expect(vpt[2]).toBeCloseTo(-sin45 * 2); // c = -sin * scale
    expect(vpt[3]).toBeCloseTo(cos45 * 2); // d = cos * scale
    expect(vpt[4]).toBeCloseTo(50);
    expect(vpt[5]).toBeCloseTo(50);
  });

  it('returns correct matrix with horizontal flip', () => {
    // OSD imageToViewerElementCoordinates does NOT include flip.
    // computeViewportTransform reads viewport.getFlip() and mirrors the matrix.
    // For flip with scale=1, offset=0, containerWidth=800:
    //   unflipped: [1, 0, 0, 1, 0, 0]
    //   flipped: [-1, 0, 0, 1, 800, 0]
    const viewer = createMockViewer({
      scale: 1,
      offsetX: 0,
      offsetY: 0,
      flip: true,
      containerWidth: 800,
    });
    const vpt = computeViewportTransform(viewer);

    expect(vpt[0]).toBeCloseTo(-1); // -a
    expect(vpt[1]).toBeCloseTo(0);
    expect(vpt[2]).toBeCloseTo(0); // -c (c was 0)
    expect(vpt[3]).toBeCloseTo(1); // d unchanged
    expect(vpt[4]).toBeCloseTo(800); // containerWidth - tx
    expect(vpt[5]).toBeCloseTo(0);
  });

  it('returns correct matrix with combined 90° rotation and horizontal flip', () => {
    // Unflipped 90°: [0, 1, -1, 0, 0, 0]
    // Flipped: [-0, 1, 1, 0, 800, 0] = [0, 1, 1, 0, 800, 0]
    const viewer = createMockViewer({
      scale: 1,
      offsetX: 0,
      offsetY: 0,
      rotationDeg: 90,
      flip: true,
      containerWidth: 800,
    });
    const vpt = computeViewportTransform(viewer);

    expect(vpt[0]).toBeCloseTo(0); // -a (a≈0)
    expect(vpt[1]).toBeCloseTo(1); // b (sin(90)*scale)
    expect(vpt[2]).toBeCloseTo(1); // -c (c was -1)
    expect(vpt[3]).toBeCloseTo(0); // d (cos(90)*scale ≈ 0)
    expect(vpt[4]).toBeCloseTo(800); // containerWidth - 0
    expect(vpt[5]).toBeCloseTo(0);
  });

  it('returns correct matrix with 180° rotation and horizontal flip (simulates vertical flip)', () => {
    // Unflipped 180°: [-1, 0, 0, -1, 0, 0]
    // Flipped: [1, 0, 0, -1, 800, 0]
    const viewer = createMockViewer({
      scale: 1,
      offsetX: 0,
      offsetY: 0,
      rotationDeg: 180,
      flip: true,
      containerWidth: 800,
    });
    const vpt = computeViewportTransform(viewer);

    expect(vpt[0]).toBeCloseTo(1); // -(-1) = 1
    expect(vpt[1]).toBeCloseTo(0);
    expect(vpt[2]).toBeCloseTo(0); // -(0) = 0
    expect(vpt[3]).toBeCloseTo(-1); // d unchanged
    expect(vpt[4]).toBeCloseTo(800); // containerWidth - 0
    expect(vpt[5]).toBeCloseTo(0);
  });

  it('produces a matrix that correctly transforms image-space points to screen (no flip)', () => {
    const viewer = createMockViewer({ scale: 2.5, offsetX: 30, offsetY: 20 });
    const vpt = computeViewportTransform(viewer);

    // Manually apply the matrix to an image-space point
    const imgX = 40;
    const imgY = 60;
    const screenX = vpt[0] * imgX + vpt[2] * imgY + vpt[4];
    const screenY = vpt[1] * imgX + vpt[3] * imgY + vpt[5];

    // Without flip, the matrix matches imageToViewerElementCoordinates exactly
    const expected = viewer.viewport.imageToViewerElementCoordinates({
      x: imgX,
      y: imgY,
    } as OpenSeadragon.Point);
    expect(screenX).toBeCloseTo(expected.x);
    expect(screenY).toBeCloseTo(expected.y);
  });

  it('produces a flipped matrix that mirrors screen X around container center', () => {
    const containerWidth = 800;
    const viewer = createMockViewer({
      scale: 2,
      offsetX: 50,
      offsetY: 30,
      flip: true,
      containerWidth,
    });
    const vpt = computeViewportTransform(viewer);

    const imgX = 40;
    const imgY = 60;

    // The unflipped screen position
    const unflipped = viewer.viewport.imageToViewerElementCoordinates({
      x: imgX,
      y: imgY,
    } as OpenSeadragon.Point);

    // The flipped matrix should mirror X: flippedX = containerWidth - unflippedX
    const screenX = vpt[0] * imgX + vpt[2] * imgY + vpt[4];
    const screenY = vpt[1] * imgX + vpt[3] * imgY + vpt[5];

    expect(screenX).toBeCloseTo(containerWidth - unflipped.x);
    expect(screenY).toBeCloseTo(unflipped.y);
  });
});

describe('Coordinate conversion round-trip (OSD coordinate API, no flip)', () => {
  const configs = [
    { scale: 1, offsetX: 0, offsetY: 0, rotationDeg: 0 },
    { scale: 2, offsetX: 100, offsetY: -50, rotationDeg: 0 },
    { scale: 0.5, offsetX: 300, offsetY: 200, rotationDeg: 0 },
    { scale: 3, offsetX: 0, offsetY: 0, rotationDeg: 45 },
    { scale: 1.5, offsetX: -100, offsetY: 50, rotationDeg: 90 },
  ];

  for (const config of configs) {
    it(`round-trips correctly for scale=${config.scale}, offset=(${config.offsetX},${config.offsetY}), rotation=${config.rotationDeg}°`, () => {
      const viewer = createMockViewer({ ...config, flip: false });

      const originalImagePoint = { x: 150, y: 250 };

      // image → screen via OSD
      const screenPoint = viewer.viewport.imageToViewerElementCoordinates(
        originalImagePoint as OpenSeadragon.Point,
      );

      // screen → image via OSD
      const roundTripped = viewer.viewport.viewerElementToImageCoordinates(
        screenPoint as OpenSeadragon.Point,
      );

      expect(roundTripped.x).toBeCloseTo(originalImagePoint.x, 6);
      expect(roundTripped.y).toBeCloseTo(originalImagePoint.y, 6);
    });
  }
});

describe('Flip matrix correctness', () => {
  const configs = [
    { scale: 1, offsetX: 0, offsetY: 0, rotationDeg: 0, containerWidth: 800 },
    { scale: 2, offsetX: 50, offsetY: 50, rotationDeg: 90, containerWidth: 1024 },
    { scale: 1.5, offsetX: -20, offsetY: 80, rotationDeg: 180, containerWidth: 600 },
  ];

  for (const config of configs) {
    it(`flipped matrix mirrors X correctly for rotation=${config.rotationDeg}°, scale=${config.scale}`, () => {
      const unflippedViewer = createMockViewer({ ...config, flip: false });
      const flippedViewer = createMockViewer({ ...config, flip: true });

      const unflippedVpt = computeViewportTransform(unflippedViewer);
      const flippedVpt = computeViewportTransform(flippedViewer);

      const imgX = 150;
      const imgY = 250;

      // Unflipped screen position
      const ux = unflippedVpt[0] * imgX + unflippedVpt[2] * imgY + unflippedVpt[4];
      const uy = unflippedVpt[1] * imgX + unflippedVpt[3] * imgY + unflippedVpt[5];

      // Flipped screen position
      const fx = flippedVpt[0] * imgX + flippedVpt[2] * imgY + flippedVpt[4];
      const fy = flippedVpt[1] * imgX + flippedVpt[3] * imgY + flippedVpt[5];

      // Flipped X should be mirrored around containerWidth/2
      expect(fx).toBeCloseTo(config.containerWidth - ux);
      expect(fy).toBeCloseTo(uy); // Y unchanged
    });
  }
});

describe('imageToScreenFlipAware / screenToImageFlipAware', () => {
  it('matches OSD without flip', () => {
    const viewer = createMockViewer({ scale: 2, offsetX: 30, offsetY: 20 });
    const result = imageToScreenFlipAware(viewer, { x: 40, y: 60 });
    const expected = viewer.viewport.imageToViewerElementCoordinates({
      x: 40,
      y: 60,
    } as OpenSeadragon.Point);
    expect(result.x).toBeCloseTo(expected.x);
    expect(result.y).toBeCloseTo(expected.y);
  });

  it('agrees with the viewportTransform painted position under flip', () => {
    // Regression: text decorations drifted at 2× pan speed under
    // single-flip mode because imageToScreen returned the un-mirrored
    // coord while Fabric painted at the mirrored coord.
    const containerWidth = 800;
    const viewer = createMockViewer({
      scale: 2,
      offsetX: 50,
      offsetY: 30,
      flip: true,
      containerWidth,
    });
    const vpt = computeViewportTransform(viewer);
    const imgX = 40;
    const imgY = 60;

    // Where Fabric paints the annotation
    const paintedX = vpt[0] * imgX + vpt[2] * imgY + vpt[4];
    const paintedY = vpt[1] * imgX + vpt[3] * imgY + vpt[5];

    const overlayed = imageToScreenFlipAware(viewer, { x: imgX, y: imgY });
    expect(overlayed.x).toBeCloseTo(paintedX);
    expect(overlayed.y).toBeCloseTo(paintedY);
  });

  it('drift on horizontal pan is zero under flip (regression for text-decoration drift)', () => {
    // Two viewers with the same flip + scale but different horizontal pans.
    // The screen position of a fixed image point must change by exactly
    // the negated delta (mirror geometry), and imageToScreenFlipAware
    // must agree with that — pre-fix it shifted by +delta instead.
    const containerWidth = 800;
    const base = { scale: 2, offsetY: 0, flip: true, containerWidth };
    const a = createMockViewer({ ...base, offsetX: 100 });
    const b = createMockViewer({ ...base, offsetX: 160 });

    const p = { x: 40, y: 60 };
    const screenA = imageToScreenFlipAware(a, p);
    const screenB = imageToScreenFlipAware(b, p);
    // Painted position shifts by -(offsetB - offsetA) under flip
    expect(screenB.x - screenA.x).toBeCloseTo(-60);
  });

  it('round-trips image → screen → image under flip', () => {
    const viewer = createMockViewer({
      scale: 1.5,
      offsetX: 25,
      offsetY: -10,
      rotationDeg: 0,
      flip: true,
      containerWidth: 800,
    });
    const original = { x: 123, y: 456 };
    const screen = imageToScreenFlipAware(viewer, original);
    const back = screenToImageFlipAware(viewer, screen);
    expect(back.x).toBeCloseTo(original.x, 6);
    expect(back.y).toBeCloseTo(original.y, 6);
  });
});
