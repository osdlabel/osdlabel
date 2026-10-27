import type { MaskCellBox, MaskRaster, MaskSpanVisitor } from '../../src/index.js';

type Box = Pick<MaskRaster, 'cells' | 'imageWidth' | 'imageHeight' | 'downsample'>;

/**
 * A toy sparse tiled store behind {@link MaskRaster}, for tests only: square
 * tiles that are absent (EMPTY), `'full'` (FULL) or a byte per cell (MIXED).
 * Nothing the size of the box is ever allocated. It deliberately emits spans
 * split at tile edges, which the contract allows and consumers must merge.
 */
export class TiledMaskRaster implements MaskRaster {
  readonly cells: MaskCellBox;
  readonly imageWidth: number;
  readonly imageHeight: number;
  readonly downsample: number;
  private readonly tiles = new Map<number, 'full' | Uint8Array>();
  private readonly across: number;

  constructor(
    box: Box,
    readonly tile = 8,
  ) {
    this.cells = { ...box.cells };
    this.imageWidth = box.imageWidth;
    this.imageHeight = box.imageHeight;
    this.downsample = box.downsample;
    this.across = Math.ceil(box.cells.width / tile);
  }

  /** Copies any raster in, span by span. */
  static from(source: MaskRaster, tile = 8): TiledMaskRaster {
    const tiled = new TiledMaskRaster(source, tile);
    source.forEachSpan((cy, x0, x1) => tiled.fillRect(x0, cy, x1 - x0, 1));
    return tiled;
  }

  /** Sets a rectangle of cells (absolute), FULL where it covers a whole tile. */
  fillRect(x: number, y: number, w: number, h: number): void {
    const t = this.tile;
    const [left, top] = [x - this.cells.x, y - this.cells.y];
    for (let ty = Math.floor(top / t); ty * t < top + h; ty++) {
      for (let tx = Math.floor(left / t); tx * t < left + w; tx++) {
        const key = ty * this.across + tx;
        if (this.tiles.get(key) === 'full') continue;
        const [r0, r1] = [Math.max(top, ty * t), Math.min(top + h, (ty + 1) * t)];
        const [c0, c1] = [Math.max(left, tx * t), Math.min(left + w, (tx + 1) * t)];
        if (r1 - r0 === t && c1 - c0 === t) this.tiles.set(key, 'full');
        else {
          let cells = this.tiles.get(key) as Uint8Array | undefined;
          if (!cells) this.tiles.set(key, (cells = new Uint8Array(t * t)));
          for (let r = r0; r < r1; r++)
            cells.fill(1, (r - ty * t) * t + c0 - tx * t, (r - ty * t) * t + c1 - tx * t);
          if (cells.every((v) => v === 1)) this.tiles.set(key, 'full');
        }
      }
    }
  }

  get cellCount(): number {
    let count = 0;
    this.forEachSpan((_cy, x0, x1) => (count += x1 - x0));
    return count;
  }

  get(cx: number, cy: number): 0 | 1 {
    const { x, y, width, height } = this.cells;
    const [col, row] = [cx - x, cy - y];
    if (col < 0 || row < 0 || col >= width || row >= height) return 0;
    const t = this.tile;
    const cells = this.tiles.get(Math.floor(row / t) * this.across + Math.floor(col / t));
    if (cells === undefined || cells === 'full') return cells === 'full' ? 1 : 0;
    return cells[(row % t) * t + (col % t)] === 1 ? 1 : 0;
  }

  forEachSpan(visit: MaskSpanVisitor, within?: MaskCellBox): void {
    const t = this.tile;
    const { x, y, width, height } = this.cells;
    // The window in box-relative cells; the whole box without one.
    const top = within ? Math.max(0, within.y - y) : 0;
    const bottom = within ? Math.min(height, within.y + within.height - y) : height;
    const left = within ? Math.max(0, within.x - x) : 0;
    const right = within ? Math.min(width, within.x + within.width - x) : width;
    if (right <= left || bottom <= top) return;
    // Tile columns present in each band of `t` rows, left to right, limited to
    // the tiles the window touches — the point of honouring it.
    const bands = new Map<number, number[]>();
    for (const key of [...this.tiles.keys()].sort((a, b) => a - b)) {
      const band = Math.floor(key / this.across);
      const tx = key % this.across;
      if ((band + 1) * t <= top || band * t >= bottom) continue;
      if ((tx + 1) * t <= left || tx * t >= right) continue;
      if (!bands.has(band)) bands.set(band, []);
      bands.get(band)!.push(tx);
    }
    const emit = (row: number, c0: number, c1: number): void => {
      const a = Math.max(c0, left);
      const b = Math.min(c1, right);
      if (b > a) visit(y + row, x + a, x + b);
    };
    for (const band of [...bands.keys()].sort((a, b) => a - b)) {
      const first = Math.max(band * t, top);
      const last = Math.min((band + 1) * t, bottom);
      for (let row = first; row < last; row++) {
        for (const tx of bands.get(band)!) {
          const cells = this.tiles.get(band * this.across + tx)!;
          const end = Math.min(t, width - tx * t);
          if (cells === 'full') {
            emit(row, tx * t, tx * t + end);
            continue;
          }
          const on = (c: number): boolean => cells[(row % t) * t + c] === 1;
          for (let c = 0; c < end; c++) {
            if (!on(c)) continue;
            const start = c;
            while (c < end && on(c)) c++;
            emit(row, tx * t + start, tx * t + c);
          }
        }
      }
    }
  }
}
