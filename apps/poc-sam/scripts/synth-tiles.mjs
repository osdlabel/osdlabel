// A procedurally generated gigapixel Deep Zoom image, rendered tile by tile on
// demand. Nothing is stored in git: tiles are rendered from a deterministic
// hash-grid scene, PNG-encoded with node:zlib (jpeg-js took ~36 ms a tile and
// made the single-threaded dev server the bottleneck), and cached in memory
// and in apps/poc-sam/.synth-cache/ (git-ignored).
//
// The scene imitates an H&E slide at three scales, so a SAM encode at any
// pyramid level sees structure of a size it can segment:
//   tissue islands (radius 6k–18k px) > glands (r 250–1400 px, purple rim and
//   white lumen) > nuclei (r 5–14 px, dark purple). Below one level pixel the
//   nuclei are folded into the tissue colour (a cheap level-of-detail), which is
//   what an averaging pyramid would show.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CACHE_DIR = path.resolve(HERE, '..', '.synth-cache');

export const SYNTH = Object.freeze({
  name: 'gigapixel',
  width: 100_000,
  height: 80_000,
  tileSize: 254,
  overlap: 1,
  format: 'png',
});

/** Highest DZI level: the one at full resolution. */
export const MAX_LEVEL = Math.ceil(Math.log2(Math.max(SYNTH.width, SYNTH.height)));

export function dziXml() {
  return (
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<Image xmlns="http://schemas.microsoft.com/deepzoom/2008" TileSize="${SYNTH.tileSize}" ` +
    `Overlap="${SYNTH.overlap}" Format="${SYNTH.format}"><Size Width="${SYNTH.width}" Height="${SYNTH.height}"/></Image>\n`
  );
}

// ---------------------------------------------------------------- hashing ---

function fmix32(h) {
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

function hash32(a, b, c) {
  return fmix32(
    fmix32(fmix32(a | 0) ^ Math.imul(b | 0, 0x9e3779b1)) ^ Math.imul(c | 0, 0x7f4a7c15),
  );
}
const rnd = (a, b, c) => hash32(a, b, c) / 4294967296;

// ---------------------------------------------------------------- scene -----

const TISSUE_CELL = 22_000;
const GLAND_CELL = 3_500;
const NUCLEUS_CELL = 36;

/** Tissue islands: a few overlapping discs per coarse cell. */
export function tissueDiscsNear(x0, y0, x1, y1) {
  const out = [];
  const pad = 20_000;
  const i0 = Math.floor((x0 - pad) / TISSUE_CELL);
  const i1 = Math.floor((x1 + pad) / TISSUE_CELL);
  const j0 = Math.floor((y0 - pad) / TISSUE_CELL);
  const j1 = Math.floor((y1 + pad) / TISSUE_CELL);
  for (let j = j0; j <= j1; j++) {
    for (let i = i0; i <= i1; i++) {
      if (rnd(i, j, 1) < 0.2) continue; // some cells are empty glass
      const n = 2 + Math.floor(rnd(i, j, 2) * 3);
      for (let k = 0; k < n; k++) {
        const cx = (i + 0.2 + 0.6 * rnd(i, j, 10 + k)) * TISSUE_CELL;
        const cy = (j + 0.2 + 0.6 * rnd(i, j, 20 + k)) * TISSUE_CELL;
        const r = 5_000 + 9_000 * rnd(i, j, 30 + k);
        if (cx + r < x0 || cx - r > x1 || cy + r < y0 || cy - r > y1) continue;
        out.push({ cx, cy, r });
      }
    }
  }
  return out;
}

export function insideTissue(discs, x, y) {
  for (const d of discs) {
    const dx = x - d.cx;
    const dy = y - d.cy;
    if (dx * dx + dy * dy <= d.r * d.r) return true;
  }
  return false;
}

export function glandsNear(x0, y0, x1, y1) {
  const out = [];
  const pad = 1_500;
  const i0 = Math.floor((x0 - pad) / GLAND_CELL);
  const i1 = Math.floor((x1 + pad) / GLAND_CELL);
  const j0 = Math.floor((y0 - pad) / GLAND_CELL);
  const j1 = Math.floor((y1 + pad) / GLAND_CELL);
  const discs = tissueDiscsNear(x0 - pad, y0 - pad, x1 + pad, y1 + pad);
  for (let j = j0; j <= j1; j++) {
    for (let i = i0; i <= i1; i++) {
      if (rnd(i, j, 3) < 0.45) continue;
      const cx = (i + 0.25 + 0.5 * rnd(i, j, 4)) * GLAND_CELL;
      const cy = (j + 0.25 + 0.5 * rnd(i, j, 5)) * GLAND_CELL;
      const r = 250 + 1_150 * rnd(i, j, 6);
      if (cx + r < x0 || cx - r > x1 || cy + r < y0 || cy - r > y1) continue;
      if (!insideTissue(discs, cx, cy)) continue;
      // Slightly elliptical, so masks are not all circles.
      const ax = 0.75 + 0.5 * rnd(i, j, 7);
      out.push({ cx, cy, r, ax, ay: 1 / ax });
    }
  }
  return out;
}

export function nucleiNear(x0, y0, x1, y1, discs) {
  const out = [];
  const i0 = Math.floor((x0 - 20) / NUCLEUS_CELL);
  const i1 = Math.floor((x1 + 20) / NUCLEUS_CELL);
  const j0 = Math.floor((y0 - 20) / NUCLEUS_CELL);
  const j1 = Math.floor((y1 + 20) / NUCLEUS_CELL);
  for (let j = j0; j <= j1; j++) {
    for (let i = i0; i <= i1; i++) {
      if (rnd(i, j, 8) < 0.55) continue;
      const cx = (i + rnd(i, j, 9)) * NUCLEUS_CELL;
      const cy = (j + rnd(i, j, 11)) * NUCLEUS_CELL;
      if (!insideTissue(discs, cx, cy)) continue;
      out.push({ cx, cy, r: 5 + 9 * rnd(i, j, 12) });
    }
  }
  return out;
}

const BG = [242, 236, 240];
const TISSUE = [226, 162, 196];
const NUCLEUS = [88, 52, 138];
const GLAND_RIM = [176, 104, 168];
const LUMEN = [248, 244, 246];
// Mean nucleus coverage of tissue: P(occupied) * mean area / cell area.
const NUCLEUS_COVERAGE = (0.45 * Math.PI * 9.6 * 9.6) / (NUCLEUS_CELL * NUCLEUS_CELL);

function mix(a, b, t) {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

/**
 * Renders the level-0 rectangle [x0, x0 + w/scale) × [y0, y0 + h/scale) into a
 * w × h RGBA buffer at `scale` level pixels per image pixel.
 */
export function renderRegion(x0, y0, w, h, scale) {
  const out = new Uint8Array(w * h * 4);
  const ix1 = x0 + w / scale;
  const iy1 = y0 + h / scale;
  const discs = tissueDiscsNear(x0, y0, ix1, iy1);
  const nucleiVisible = 5 * scale >= 0.75;
  const tissueColour = nucleiVisible ? TISSUE : mix(TISSUE, NUCLEUS, NUCLEUS_COVERAGE);

  // Background and tissue: per pixel, but tissue discs are few.
  for (let py = 0; py < h; py++) {
    const y = y0 + (py + 0.5) / scale;
    for (let px = 0; px < w; px++) {
      const x = x0 + (px + 0.5) / scale;
      const c = insideTissue(discs, x, y) ? tissueColour : BG;
      const o = (py * w + px) * 4;
      out[o] = c[0];
      out[o + 1] = c[1];
      out[o + 2] = c[2];
      out[o + 3] = 255;
    }
  }

  const paintDisc = (cx, cy, rx, ry, colour) => {
    // Bounding box in output pixels.
    const bx0 = Math.max(0, Math.floor((cx - rx - x0) * scale) - 1);
    const by0 = Math.max(0, Math.floor((cy - ry - y0) * scale) - 1);
    const bx1 = Math.min(w - 1, Math.ceil((cx + rx - x0) * scale) + 1);
    const by1 = Math.min(h - 1, Math.ceil((cy + ry - y0) * scale) + 1);
    const edge = 1 / scale; // one output pixel of antialiasing, in image px
    for (let py = by0; py <= by1; py++) {
      const y = y0 + (py + 0.5) / scale;
      for (let px = bx0; px <= bx1; px++) {
        const x = x0 + (px + 0.5) / scale;
        const dx = (x - cx) / rx;
        const dy = (y - cy) / ry;
        const d = Math.sqrt(dx * dx + dy * dy); // 1 at the rim
        const signed = (d - 1) * Math.min(rx, ry); // image px outside the rim
        const a = Math.max(0, Math.min(1, 0.5 - signed / edge));
        if (a <= 0) continue;
        const o = (py * w + px) * 4;
        out[o] = out[o] + (colour[0] - out[o]) * a;
        out[o + 1] = out[o + 1] + (colour[1] - out[o + 1]) * a;
        out[o + 2] = out[o + 2] + (colour[2] - out[o + 2]) * a;
      }
    }
  };

  for (const g of glandsNear(x0, y0, ix1, iy1)) {
    paintDisc(g.cx, g.cy, g.r * g.ax, g.r * g.ay, GLAND_RIM);
    paintDisc(g.cx, g.cy, g.r * g.ax * 0.72, g.r * g.ay * 0.72, LUMEN);
  }
  if (nucleiVisible) {
    for (const n of nucleiNear(x0, y0, ix1, iy1, discs)) paintDisc(n.cx, n.cy, n.r, n.r, NUCLEUS);
  }
  return out;
}

// ---------------------------------------------------------------- png -------

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'latin1');
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

/** RGBA -> RGB PNG (filter 0 rows, zlib level 6). */
export function encodePng(rgba, w, h) {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) {
    const o = y * (w * 3 + 1);
    raw[o] = 0;
    for (let x = 0; x < w; x++) {
      const si = (y * w + x) * 4;
      const di = o + 1 + x * 3;
      raw[di] = rgba[si];
      raw[di + 1] = rgba[si + 1];
      raw[di + 2] = rgba[si + 2];
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 6 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** PNG (as written by encodePng) -> RGBA. For the server-side region reader. */
export function decodePng(buf) {
  const w = buf.readUInt32BE(16);
  const h = buf.readUInt32BE(20);
  const parts = [];
  let pos = 8;
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('latin1', pos + 4, pos + 8);
    if (type === 'IDAT') parts.push(buf.subarray(pos + 8, pos + 8 + len));
    pos += 12 + len;
  }
  const raw = zlib.inflateSync(Buffer.concat(parts));
  const out = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    const o = y * (w * 3 + 1) + 1;
    for (let x = 0; x < w; x++) {
      out[(y * w + x) * 4] = raw[o + x * 3];
      out[(y * w + x) * 4 + 1] = raw[o + x * 3 + 1];
      out[(y * w + x) * 4 + 2] = raw[o + x * 3 + 2];
      out[(y * w + x) * 4 + 3] = 255;
    }
  }
  return { width: w, height: h, data: out };
}

// ---------------------------------------------------------------- tiles -----

export function levelDims(level) {
  const s = 2 ** (level - MAX_LEVEL);
  return { width: Math.ceil(SYNTH.width * s), height: Math.ceil(SYNTH.height * s), scale: s };
}

/** Level-pixel rectangle a DZI tile covers, overlap included. */
export function tileRect(level, tx, ty) {
  const { width, height } = levelDims(level);
  const ts = SYNTH.tileSize;
  const ov = SYNTH.overlap;
  const x = tx * ts - (tx > 0 ? ov : 0);
  const y = ty * ts - (ty > 0 ? ov : 0);
  const x1 = Math.min(width, (tx + 1) * ts + ov);
  const y1 = Math.min(height, (ty + 1) * ts + ov);
  return { x, y, w: x1 - x, h: y1 - y };
}

export function renderTileRgba(level, tx, ty) {
  const { scale } = levelDims(level);
  const r = tileRect(level, tx, ty);
  return { ...r, rgba: renderRegion(r.x / scale, r.y / scale, r.w, r.h, scale) };
}

const memory = new Map();
const MEMORY_LIMIT = 4000;

export function tileBytes(level, tx, ty) {
  const key = `${level}/${tx}_${ty}`;
  const hit = memory.get(key);
  if (hit) return hit;
  const file = path.join(CACHE_DIR, `${level}`, `${tx}_${ty}.png`);
  let bytes;
  if (fs.existsSync(file)) {
    bytes = fs.readFileSync(file);
  } else {
    const t = renderTileRgba(level, tx, ty);
    bytes = encodePng(t.rgba, t.w, t.h);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, bytes);
  }
  if (memory.size >= MEMORY_LIMIT) memory.delete(memory.keys().next().value);
  memory.set(key, bytes);
  return bytes;
}

/** Connect-style middleware serving /<prefix>gigapixel.dzi and its tiles. */
export function synthTileMiddleware(prefix) {
  const dzi = `${prefix}${SYNTH.name}.dzi`;
  const tileRe = new RegExp(`^${prefix}${SYNTH.name}_files/(\\d+)/(\\d+)_(\\d+)\\.png$`);
  return (req, res, next) => {
    const url = (req.url ?? '').split('?')[0];
    if (!url.startsWith(prefix)) return next();
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    if (url === dzi) {
      res.setHeader('Content-Type', 'application/xml');
      res.end(dziXml());
      return;
    }
    const m = tileRe.exec(url);
    if (!m) {
      res.statusCode = 404;
      res.end();
      return;
    }
    const [level, tx, ty] = [Number(m[1]), Number(m[2]), Number(m[3])];
    const { width, height } = levelDims(level);
    if (
      level > MAX_LEVEL ||
      tx * SYNTH.tileSize >= width ||
      ty * SYNTH.tileSize >= height ||
      tx < 0 ||
      ty < 0
    ) {
      res.statusCode = 404;
      res.end();
      return;
    }
    const bytes = tileBytes(level, tx, ty);
    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Content-Length', bytes.length);
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    res.end(bytes);
  };
}
