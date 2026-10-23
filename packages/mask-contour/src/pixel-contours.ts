import { signedArea, type Contour, type Vec2 } from './ring.js';

/** A row-major binary grid; any non-zero value is foreground. */
export interface BinaryGrid {
  readonly width: number;
  readonly height: number;
  readonly data: Uint8Array;
}

// Directions in y-down coordinates, ordered so that d + 1 is a right turn.
const DX: readonly number[] = [1, 0, -1, 0]; // E, S, W, N
const DY: readonly number[] = [0, 1, 0, -1];

/**
 * Traces the exact pixel-edge boundaries of a binary grid.
 *
 * Vertices sit on pixel corners, so rasterising the result at pixel centres
 * reproduces the grid exactly: this is the lossless direction for turning a
 * painted mask (e.g. a brush stroke) into polygons. Straight runs are
 * collapsed to their end points.
 *
 * Every boundary edge is walked with foreground on its right, so outer rings
 * have positive signed area and holes negative. Foreground is 4-connected:
 * two pixels touching only at a corner become two rings, so no ring touches
 * itself. Coordinates are grid pixels; callers map them to image space.
 */
export function tracePixelContours(grid: BinaryGrid): Contour[] {
  const { width: W, height: H, data } = grid;
  const CW = W + 1;
  // Unused outgoing edge directions per corner, as a 4-bit mask.
  const out = new Uint8Array(CW * (H + 1));
  const fg = (x: number, y: number): boolean =>
    x >= 0 && y >= 0 && x < W && y < H && data[y * W + x] !== 0;

  for (let y = 0; y <= H; y++) {
    for (let x = 0; x < W; x++) {
      const above = fg(x, y - 1);
      const below = fg(x, y);
      if (above === below) continue;
      // Foreground on the right: below -> east from (x,y); above -> west from (x+1,y).
      if (below) out[y * CW + x]! |= 1;
      else out[y * CW + x + 1]! |= 4;
    }
  }
  for (let y = 0; y < H; y++) {
    for (let x = 0; x <= W; x++) {
      const left = fg(x - 1, y);
      const right = fg(x, y);
      if (left === right) continue;
      // left fg -> south from (x,y); right fg -> north from (x,y+1).
      if (left) out[y * CW + x]! |= 2;
      else out[(y + 1) * CW + x]! |= 8;
    }
  }

  const contours: Contour[] = [];
  for (let start = 0; start < out.length; start++) {
    while (out[start] !== 0) {
      const sx = start % CW;
      const sy = (start - sx) / CW;
      let d0 = 0;
      while (!(out[start]! & (1 << d0))) d0++;
      out[start]! &= ~(1 << d0);
      const ring: Vec2[] = [{ x: sx, y: sy }];
      let dir = d0;
      let x = sx + DX[dir]!;
      let y = sy + DY[dir]!;
      for (;;) {
        const c = y * CW + x;
        const atStart = x === sx && y === sy;
        let next = -1;
        for (const cand of [(dir + 1) % 4, dir, (dir + 3) % 4]) {
          if (atStart && cand === d0) {
            next = d0;
            break;
          }
          if (out[c]! & (1 << cand)) {
            next = cand;
            break;
          }
        }
        if (next === -1) throw new Error('tracePixelContours: open boundary (internal error)');
        if (atStart && next === d0) {
          if (dir === d0) ring.shift(); // the start corner was mid-edge
          break;
        }
        if (next !== dir) ring.push({ x, y });
        out[c]! &= ~(1 << next);
        dir = next;
        x += DX[dir]!;
        y += DY[dir]!;
      }
      contours.push({ ring, hole: signedArea(ring) < 0 });
    }
  }
  return contours;
}
