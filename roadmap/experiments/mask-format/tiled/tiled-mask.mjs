// Minimal sparse tiled level-0 mask (Option C prototype). 64x64 tiles,
// state EMPTY/FULL/MIXED, dense bytes only for MIXED tiles. Exact pixelCount.
export const T = 64;
const EMPTY = 0,
  FULL = 1,
  MIXED = 2;

export class TiledMask {
  constructor(imageWidth, imageHeight) {
    this.W = imageWidth;
    this.H = imageHeight;
    this.tx = Math.ceil(imageWidth / T);
    this.ty = Math.ceil(imageHeight / T);
    this.state = new Uint8Array(this.tx * this.ty); // directory: 1 byte per tile
    this.count = new Uint16Array(this.tx * this.ty); // set pixels per MIXED tile (cap <= 4096)
    this.data = new Map(); // tile index -> Uint8Array(T*T)
    this.pixelCount = 0;
  }
  tw(t) {
    return Math.min(T, this.W - t * T);
  }
  th(t) {
    return Math.min(T, this.H - t * T);
  }
  cap(i) {
    return this.tw(i % this.tx) * this.th(Math.floor(i / this.tx));
  }
  mixedTiles() {
    return this.data.size;
  }
  setTileUniform(i, v) {
    const c = this.cap(i);
    const before = this.state[i] === FULL ? c : this.state[i] === EMPTY ? 0 : this.count[i];
    this.pixelCount += (v ? c : 0) - before;
    this.state[i] = v ? FULL : EMPTY;
    this.count[i] = 0;
    this.data.delete(i);
  }
  materialize(i) {
    if (this.state[i] === MIXED) return this.data.get(i);
    const d = new Uint8Array(T * T);
    if (this.state[i] === FULL) {
      d.fill(1);
      this.count[i] = this.cap(i);
    } else this.count[i] = 0;
    this.state[i] = MIXED;
    this.data.set(i, d);
    return d;
  }
  collapse(i) {
    if (this.state[i] !== MIXED) return;
    const c = this.count[i];
    if (c === 0) {
      this.state[i] = EMPTY;
      this.data.delete(i);
    } else if (c === this.cap(i)) {
      this.state[i] = FULL;
      this.count[i] = 0;
      this.data.delete(i);
    }
  }
  get(x, y) {
    if (x < 0 || y < 0 || x >= this.W || y >= this.H) return 0;
    const i = Math.floor(y / T) * this.tx + Math.floor(x / T);
    const s = this.state[i];
    if (s !== MIXED) return s;
    return this.data.get(i)[(y % T) * T + (x % T)];
  }
  /** Paint/erase the capsule {p : dist(p, segment) <= r}, pixel centres. Tile-classified. */
  fillCapsule(x0, y0, x1, y1, r, v) {
    const minX = Math.max(0, Math.floor(Math.min(x0, x1) - r)),
      maxX = Math.min(this.W - 1, Math.ceil(Math.max(x0, x1) + r));
    const minY = Math.max(0, Math.floor(Math.min(y0, y1) - r)),
      maxY = Math.min(this.H - 1, Math.ceil(Math.max(y0, y1) + r));
    const dx = x1 - x0,
      dy = y1 - y0,
      len2 = dx * dx + dy * dy,
      r2 = r * r;
    const d2 = (px, py) => {
      let t = len2 === 0 ? 0 : ((px - x0) * dx + (py - y0) * dy) / len2;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const ex = px - (x0 + t * dx),
        ey = py - (y0 + t * dy);
      return ex * ex + ey * ey;
    };
    let touchedTiles = 0,
      pixelTests = 0;
    for (let ty = Math.floor(minY / T); ty <= Math.floor(maxY / T); ty++) {
      const th = this.th(ty);
      for (let tx = Math.floor(minX / T); tx <= Math.floor(maxX / T); tx++) {
        const i = ty * this.tx + tx,
          tw = this.tw(tx);
        const s = this.state[i];
        if ((s === FULL && v === 1) || (s === EMPTY && v === 0)) continue;
        const ax = tx * T + 0.5,
          ay = ty * T + 0.5,
          bx = tx * T + tw - 0.5,
          by = ty * T + th - 0.5;
        // distance-to-segment is convex: its max over the tile is at a corner
        if (Math.max(d2(ax, ay), d2(bx, ay), d2(ax, by), d2(bx, by)) <= r2) {
          this.setTileUniform(i, v);
          touchedTiles++;
          continue;
        }
        // conservative outside test via the tile's circumscribed circle
        const cxm = (ax + bx) / 2,
          cym = (ay + by) / 2,
          half = Math.hypot(bx - ax, by - ay) / 2;
        const dc = Math.sqrt(d2(cxm, cym));
        if (dc - half > r) continue;
        touchedTiles++;
        const d = this.materialize(i);
        let c = this.count[i];
        for (let yy = 0; yy < th; yy++) {
          const py = ty * T + yy + 0.5;
          for (let xx = 0; xx < tw; xx++) {
            pixelTests++;
            if (d2(tx * T + xx + 0.5, py) <= r2) {
              const k = yy * T + xx;
              if (d[k] !== v) {
                d[k] = v;
                c += v ? 1 : -1;
                this.pixelCount += v ? 1 : -1;
              }
            }
          }
        }
        this.count[i] = c;
        this.collapse(i);
      }
    }
    return { touchedTiles, pixelTests };
  }
  /** Tight bbox of set pixels. */
  bbox() {
    let t0x = Infinity,
      t0y = Infinity,
      t1x = -1,
      t1y = -1;
    for (let ty = 0; ty < this.ty; ty++)
      for (let tx = 0; tx < this.tx; tx++) {
        if (this.state[ty * this.tx + tx] !== EMPTY) {
          if (tx < t0x) t0x = tx;
          if (tx > t1x) t1x = tx;
          if (ty < t0y) t0y = ty;
          if (ty > t1y) t1y = ty;
        }
      }
    if (t1x < 0) return null;
    // refine inside edge tiles
    let x0 = Infinity,
      y0 = Infinity,
      x1 = -1,
      y1 = -1;
    const scan = (tx, ty) => {
      const i = ty * this.tx + tx,
        s = this.state[i],
        tw = this.tw(tx),
        th = this.th(ty);
      if (s === EMPTY) return;
      if (s === FULL) {
        x0 = Math.min(x0, tx * T);
        y0 = Math.min(y0, ty * T);
        x1 = Math.max(x1, tx * T + tw - 1);
        y1 = Math.max(y1, ty * T + th - 1);
        return;
      }
      const d = this.data.get(i);
      for (let yy = 0; yy < th; yy++)
        for (let xx = 0; xx < tw; xx++)
          if (d[yy * T + xx]) {
            const X = tx * T + xx,
              Y = ty * T + yy;
            if (X < x0) x0 = X;
            if (X > x1) x1 = X;
            if (Y < y0) y0 = Y;
            if (Y > y1) y1 = Y;
          }
    };
    for (let ty = t0y; ty <= t1y; ty++) {
      scan(t0x, ty);
      if (t1x !== t0x) scan(t1x, ty);
    }
    for (let tx = t0x; tx <= t1x; tx++) {
      scan(tx, t0y);
      if (t1y !== t0y) scan(tx, t1y);
    }
    return { x: x0, y: y0, width: x1 - x0 + 1, height: y1 - y0 + 1 };
  }
  /** Row-major runs over the tight bbox, starting with background (osdlabel-mask semantics). */
  rowMajorRuns() {
    const b = this.bbox();
    if (!b) return { box: null, runs: [] };
    const runs = [];
    let cur = 0,
      len = 0;
    const app = (val, n) => {
      if (n <= 0) return;
      if (val === cur) {
        len += n;
        return;
      }
      runs.push(len);
      cur = val;
      len = n;
    };
    const tx0 = Math.floor(b.x / T),
      tx1 = Math.floor((b.x + b.width - 1) / T);
    for (let y = b.y; y < b.y + b.height; y++) {
      const ty = Math.floor(y / T),
        yy = y % T;
      for (let tx = tx0; tx <= tx1; tx++) {
        const i = ty * this.tx + tx;
        const xa = Math.max(b.x, tx * T),
          xb = Math.min(b.x + b.width, tx * T + this.tw(tx));
        const s = this.state[i];
        if (s !== MIXED) {
          app(s, xb - xa);
          continue;
        }
        const d = this.data.get(i),
          base = yy * T - tx * T;
        for (let X = xa; X < xb; X++) app(d[base + X], 1);
      }
    }
    runs.push(len);
    return { box: b, runs };
  }
  /**
   * Builds tiles from row-major runs over a box WITHOUT a dense bbox allocation:
   * band by band (64 rows), a difference array counts rows that fully cover each
   * tile horizontally, so only tiles that end up MIXED are ever materialised.
   */
  static fromRowMajorRuns(box, runs, imageWidth, imageHeight) {
    const m = new TiledMask(imageWidth, imageHeight);
    const { x: bx, y: by, width: bw, height: bh } = box;
    // flatten runs into per-row foreground intervals, band by band
    let ri = 0,
      remaining = runs[0],
      val = 0; // current run
    const diff = new Int32Array(m.tx + 1);
    const partial = new Int32Array(m.tx);
    const bandIntervals = [];
    const ty0 = Math.floor(by / T),
      ty1 = Math.floor((by + bh - 1) / T);
    for (let ty = ty0; ty <= ty1; ty++) {
      diff.fill(0);
      partial.fill(0);
      bandIntervals.length = 0;
      const ya = Math.max(by, ty * T),
        yb = Math.min(by + bh, ty * T + m.th(ty));
      for (let y = ya; y < yb; y++) {
        let x = bx;
        while (x < bx + bw) {
          while (remaining === 0) {
            ri++;
            remaining = runs[ri];
            val ^= 1;
          }
          const n = Math.min(remaining, bx + bw - x);
          if (val === 1) {
            const a = x,
              b = x + n; // [a,b)
            bandIntervals.push(y, a, b);
            const fa = Math.ceil(a / T),
              fb = Math.floor(b / T);
            if (fa < fb) {
              diff[fa]++;
              diff[fb]--;
              if (a < fa * T) partial[fa - 1] += fa * T - a;
              if (b > fb * T) partial[fb] += b - fb * T;
            } else {
              partial[Math.floor(a / T)] += b - a;
            }
          }
          x += n;
          remaining -= n;
        }
      }
      let acc = 0;
      const mixed = [];
      for (let tx = 0; tx < m.tx; tx++) {
        acc += diff[tx];
        const c = acc * m.tw(tx) + partial[tx];
        if (c === 0) continue;
        const i = ty * m.tx + tx;
        if (c === m.cap(i)) {
          m.state[i] = FULL;
          m.pixelCount += c;
        } else {
          m.state[i] = MIXED;
          m.count[i] = c;
          m.pixelCount += c;
          m.data.set(i, new Uint8Array(T * T));
          mixed.push(tx);
        }
      }
      if (mixed.length) {
        for (let k = 0; k < bandIntervals.length; k += 3) {
          const y = bandIntervals[k],
            a = bandIntervals[k + 1],
            b = bandIntervals[k + 2];
          const yy = y - ty * T;
          const ta = Math.floor(a / T),
            tb = Math.floor((b - 1) / T);
          for (let tx = ta; tx <= tb; tx++) {
            const i = ty * m.tx + tx;
            if (m.state[i] !== MIXED) continue;
            const d = m.data.get(i);
            const s = Math.max(a, tx * T) - tx * T,
              e = Math.min(b, tx * T + T) - tx * T;
            d.fill(1, yy * T + s, yy * T + e);
          }
        }
      }
    }
    return m;
  }
  /** COCO column-major runs over the FULL image, from tiles (no dense bbox). */
  cocoColumnMajorRuns() {
    const b = this.bbox();
    const runs = [];
    let cur = 0,
      len = 0;
    const app = (val, n) => {
      if (n <= 0) return;
      if (val === cur) {
        len += n;
        return;
      }
      runs.push(len);
      cur = val;
      len = n;
    };
    if (!b) return [this.W * this.H];
    app(0, b.x * this.H);
    const ty0 = Math.floor(b.y / T),
      ty1 = Math.floor((b.y + b.height - 1) / T);
    for (let x = b.x; x < b.x + b.width; x++) {
      const tx = Math.floor(x / T),
        xx = x % T;
      app(0, b.y);
      for (let ty = ty0; ty <= ty1; ty++) {
        const i = ty * this.tx + tx;
        const ya = Math.max(b.y, ty * T),
          yb = Math.min(b.y + b.height, ty * T + this.th(ty));
        const s = this.state[i];
        if (s !== MIXED) {
          app(s, yb - ya);
          continue;
        }
        const d = this.data.get(i);
        for (let Y = ya; Y < yb; Y++) app(d[(Y - ty * T) * T + xx], 1);
      }
      app(0, this.H - (b.y + b.height));
    }
    app(0, (this.W - (b.x + b.width)) * this.H);
    runs.push(len);
    return runs;
  }
  /** One RGBA pixel per tile (pyramid level log2(T) = 6): coverage -> alpha. */
  renderLevel6(region) {
    const tx0 = Math.floor(region.x / T),
      ty0 = Math.floor(region.y / T);
    const tx1 = Math.floor((region.x + region.width - 1) / T),
      ty1 = Math.floor((region.y + region.height - 1) / T);
    const w = tx1 - tx0 + 1,
      h = ty1 - ty0 + 1;
    const rgba = new Uint8ClampedArray(w * h * 4);
    for (let ty = ty0; ty <= ty1; ty++)
      for (let tx = tx0; tx <= tx1; tx++) {
        const i = ty * this.tx + tx,
          s = this.state[i];
        if (s === EMPTY) continue;
        const a = s === FULL ? 115 : Math.round((115 * this.count[i]) / this.cap(i));
        const o = ((ty - ty0) * w + (tx - tx0)) * 4;
        rgba[o] = 33;
        rgba[o + 1] = 150;
        rgba[o + 2] = 243;
        rgba[o + 3] = a;
      }
    return { w, h, rgba };
  }
  /** Level-0 RGBA for a screen-sized region (high zoom). */
  renderLevel0(region) {
    const rgba = new Uint8ClampedArray(region.width * region.height * 4);
    const tx0 = Math.floor(region.x / T),
      ty0 = Math.floor(region.y / T);
    const tx1 = Math.floor((region.x + region.width - 1) / T),
      ty1 = Math.floor((region.y + region.height - 1) / T);
    for (let ty = ty0; ty <= ty1; ty++)
      for (let tx = tx0; tx <= tx1; tx++) {
        const i = ty * this.tx + tx,
          s = this.state[i];
        if (s === EMPTY) continue;
        const xa = Math.max(region.x, tx * T),
          xb = Math.min(region.x + region.width, tx * T + this.tw(tx));
        const ya = Math.max(region.y, ty * T),
          yb = Math.min(region.y + region.height, ty * T + this.th(ty));
        const d = s === MIXED ? this.data.get(i) : null;
        for (let Y = ya; Y < yb; Y++)
          for (let X = xa; X < xb; X++) {
            if (d && !d[(Y - ty * T) * T + (X - tx * T)]) continue;
            const o = ((Y - region.y) * region.width + (X - region.x)) * 4;
            rgba[o] = 33;
            rgba[o + 1] = 150;
            rgba[o + 2] = 243;
            rgba[o + 3] = 115;
          }
      }
    return rgba;
  }
}

export function encodeVarintsB64(runs) {
  const out = [];
  for (let v of runs) {
    do {
      const b = v % 128;
      v = Math.floor(v / 128);
      out.push(v !== 0 ? b | 0x80 : b);
    } while (v !== 0);
  }
  return Buffer.from(Uint8Array.from(out)).toString('base64');
}
export function decodeVarintsB64(s) {
  const bytes = Buffer.from(s, 'base64');
  const vals = [];
  let cur = 0,
    sh = 0;
  for (const b of bytes) {
    cur += (b & 0x7f) * 2 ** sh;
    if ((b & 0x80) === 0) {
      vals.push(cur);
      cur = 0;
      sh = 0;
    } else sh += 7;
  }
  return vals;
}
