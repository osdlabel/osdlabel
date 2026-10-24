import { signedArea, type Contour, type Vec2 } from './ring.js';

/** A row-major scalar field sampled at pixel centres (e.g. mask logits). */
export interface ScalarGrid {
  readonly width: number;
  readonly height: number;
  readonly data: Float32Array | Uint8Array;
}

/**
 * Iso-contours of a scalar field at `level` (marching squares with linear
 * interpolation along cell edges).
 *
 * This is how a low-resolution logit map — SAM's 256x256 output — becomes a
 * smooth, sub-pixel outline without first upsampling it to image resolution:
 * the cost is proportional to the logit grid, not to the image area the mask
 * covers. Samples sit at pixel centres, so vertex (u, v) is in grid pixel
 * units with (0.5, 0.5) at the centre of the first sample. The field is
 * treated as below `level` outside the grid, so every contour closes.
 *
 * Orientation matches {@link tracePixelContours}: the inside (values above
 * `level`) is on the right of travel, so outer rings have positive signed area
 * and holes negative. Saddles are resolved by the cell-centre average.
 */
export function traceIsoContours(grid: ScalarGrid, level = 0): Contour[] {
  const W = grid.width + 2; // padded sample grid
  const H = grid.height + 2;
  const src = grid.data;
  const below = level - 1;
  const v = (i: number, j: number): number => {
    const x = i - 1;
    const y = j - 1;
    if (x < 0 || y < 0 || x >= grid.width || y >= grid.height) return below;
    return src[y * grid.width + x]!;
  };

  // Crossing ids: horizontal edges (i,j)-(i+1,j) are j*W+i; vertical edges
  // (i,j)-(i,j+1) are W*H + j*W + i.
  const HOFF = 0;
  const VOFF = W * H;
  const next = new Int32Array(2 * W * H).fill(-1);
  const px = new Float32Array(2 * W * H);
  const py = new Float32Array(2 * W * H);
  const crossing = (
    id: number,
    ax: number,
    ay: number,
    bx: number,
    by: number,
    fa: number,
    fb: number,
  ): number => {
    const t = (level - fa) / (fb - fa);
    px[id] = ax + (bx - ax) * t - 0.5;
    py[id] = ay + (by - ay) * t - 0.5;
    return id;
  };

  for (let j = 0; j < H - 1; j++) {
    for (let i = 0; i < W - 1; i++) {
      const a = v(i, j);
      const b = v(i + 1, j);
      const c = v(i + 1, j + 1);
      const d = v(i, j + 1);
      const ia = a > level ? 1 : 0;
      const ib = b > level ? 1 : 0;
      const ic = c > level ? 1 : 0;
      const id = d > level ? 1 : 0;
      const code = (ia << 3) | (ib << 2) | (ic << 1) | id;
      if (code === 0 || code === 15) continue;
      // Edge crossing ids (grid sample coordinates; -0.5 maps to pixel centres).
      const top = () => crossing(HOFF + j * W + i, i, j, i + 1, j, a, b);
      const bottom = () => crossing(HOFF + (j + 1) * W + i, i, j + 1, i + 1, j + 1, d, c);
      const left = () => crossing(VOFF + j * W + i, i, j, i, j + 1, a, d);
      const right = () => crossing(VOFF + j * W + i + 1, i + 1, j, i + 1, j + 1, b, c);
      // Link from -> to with the inside on the right of travel. Each case is
      // listed by which corners are inside (a=TL, b=TR, c=BR, d=BL).
      const link = (from: number, to: number): void => {
        next[from] = to;
      };
      switch (code) {
        case 0b1000:
          link(top(), left());
          break; // a
        case 0b0100:
          link(right(), top());
          break; // b
        case 0b0010:
          link(bottom(), right());
          break; // c
        case 0b0001:
          link(left(), bottom());
          break; // d
        case 0b1100:
          link(right(), left());
          break; // a b
        case 0b0110:
          link(bottom(), top());
          break; // b c
        case 0b0011:
          link(left(), right());
          break; // c d
        case 0b1001:
          link(top(), bottom());
          break; // a d
        case 0b1110:
          link(bottom(), left());
          break; // not d
        case 0b1101:
          link(right(), bottom());
          break; // not c
        case 0b1011:
          link(top(), right());
          break; // not b
        case 0b0111:
          link(left(), top());
          break; // not a
        case 0b1010: {
          // a, c inside (saddle)
          if ((a + b + c + d) / 4 > level) {
            link(top(), right()); // centre inside: cut off b (outside), as "not b"
            link(bottom(), left()); // and d, as "not d"
          } else {
            link(top(), left()); // centre outside: a alone
            link(bottom(), right()); // and c alone
          }
          break;
        }
        case 0b0101: {
          // b, d inside (saddle)
          if ((a + b + c + d) / 4 > level) {
            link(left(), top()); // centre inside: cut off a, as "not a"
            link(right(), bottom()); // and c, as "not c"
          } else {
            link(right(), top());
            link(left(), bottom());
          }
          break;
        }
      }
    }
  }

  const contours: Contour[] = [];
  for (let s = 0; s < next.length; s++) {
    if (next[s] === -1) continue;
    const ring: Vec2[] = [];
    let cur = s;
    while (next[cur] !== -1) {
      ring.push({ x: px[cur]!, y: py[cur]! });
      const n = next[cur]!;
      next[cur] = -1;
      cur = n;
    }
    if (ring.length >= 3) contours.push({ ring, hole: signedArea(ring) < 0 });
  }
  return contours;
}
