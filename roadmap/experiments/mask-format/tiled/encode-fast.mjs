// Band-coalesced row-major encoder: per 64-row band, merge consecutive uniform
// tiles into one segment, so each row costs O(segments in band), not O(tiles in row).
import { T } from './tiled-mask.mjs';
export function rowMajorRunsFast(m) {
  const b = m.bbox();
  if (!b) return { box: null, runs: [] };
  const runs = [];
  let cur = 0,
    len = 0;
  const app = (v, n) => {
    if (n <= 0) return;
    if (v === cur) {
      len += n;
      return;
    }
    runs.push(len);
    cur = v;
    len = n;
  };
  const tx0 = Math.floor(b.x / T),
    tx1 = Math.floor((b.x + b.width - 1) / T);
  const segs = [];
  for (let ty = Math.floor(b.y / T); ty <= Math.floor((b.y + b.height - 1) / T); ty++) {
    segs.length = 0;
    for (let tx = tx0; tx <= tx1; tx++) {
      const i = ty * m.tx + tx,
        s = m.state[i];
      const xa = Math.max(b.x, tx * T),
        xb = Math.min(b.x + b.width, tx * T + m.tw(tx));
      const last = segs[segs.length - 1];
      if (s !== 2 && last && last.s === s) last.xb = xb;
      else segs.push({ s, xa, xb, d: s === 2 ? m.data.get(i) : null, ox: tx * T });
    }
    const ya = Math.max(b.y, ty * T),
      yb = Math.min(b.y + b.height, ty * T + m.th(ty));
    for (let y = ya; y < yb; y++) {
      const yy = (y - ty * T) * T;
      for (const g of segs) {
        if (g.s !== 2) {
          app(g.s, g.xb - g.xa);
          continue;
        }
        const d = g.d;
        let X = g.xa;
        while (X < g.xb) {
          const v = d[yy + X - g.ox];
          let e = X + 1;
          while (e < g.xb && d[yy + e - g.ox] === v) e++;
          app(v, e - X);
          X = e;
        }
      }
    }
  }
  runs.push(len);
  return { box: b, runs };
}
