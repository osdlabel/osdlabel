/* OSD mask-render harness.
 *
 * A 100,000 x 80,000 synthetic image (in-memory tile source) plus a mask shaped
 * like poc-sam's S1 overview result (same frame, box and ring/hole topology as
 * scratchpad/sparse-exp/synth.mjs), rendered one of these ways (?mode=):
 *   base         - image only (baseline)
 *   osd-grid     - mask as an OSD TiledImage backed by a coarse grid at ?d=
 *   osd-sparse   - mask as an OSD TiledImage backed by a sparse level-0 tile store
 *   fabric-grid  - #149's renderer: one canvas of the grid, a FabricImage scaled by d
 *   multi-tiled  - ?n= small masks, one TiledImage each
 *   multi-label  - the same ?n= masks as ONE label-layer TiledImage, colour per mask
 * Other params: ?osd=5|6, ?drawer=canvas|webgl, ?mtpf= (maxTilesPerFrame, default 64),
 * ?immediate=0|1 (immediateRender on mask items, default 1), ?transp=0|1 (mask
 * hasTransparency, default 0 = draw tiles directly, alpha baked in).
 * Driven by run.mjs through window.H.
 */
(function () {
  'use strict';
  const Q = new URLSearchParams(location.search);
  const OSD = window.OpenSeadragon;
  const F = window.fabric;
  const OSD_MAJOR = Number(OSD.version.major);
  const DRAWER = Q.get('drawer') || 'canvas';
  const MODE = Q.get('mode') || 'base';
  const D = parseInt(Q.get('d') || '8', 10);
  const MTPF = parseInt(Q.get('mtpf') || '64', 10);
  const IMMEDIATE = Q.get('immediate') !== '0';
  // Declare mask tiles transparent (default): OSD then composites the layer through its sketch canvas (canvas
  // drawer) or two-pass path (WebGL). transp=0 draws tiles straight onto the image: seams at tile edges on the
  // canvas drawer and wrong (un-premultiplied) colours on the WebGL drawer, measured.
  const TRANSP = Q.get('transp') !== '0';
  const N_MASKS = parseInt(Q.get('n') || '50', 10);
  // Round translucent tile positions (canvas drawer) so adjacent mask tiles do not double-blend at seams.
  const ROUND = Q.get('round') !== '0';
  const FULLREPAINT = Q.get('fullrepaint') === '1';
  function tuneMaskItem(item) {
    item.maxTilesPerFrame = MTPF;
    item.immediateRender = IMMEDIATE;
    if (ROUND && OSD.SUBPIXEL_ROUNDING_OCCURRENCES)
      item.subPixelRoundingForTransparency = OSD.SUBPIXEL_ROUNDING_OCCURRENCES.ALWAYS;
  }

  const IMG_W = 100000;
  const IMG_H = 80000;
  const TS = 256;

  const now = () => performance.now();
  const log = [];

  // ---------------------------------------------------------------------------
  // The S1-like field (port of scratchpad/sparse-exp/synth.mjs)
  // ---------------------------------------------------------------------------
  const FRAME = {
    originX: 31594,
    originY: 16574,
    pixelWidth: 234.379,
    pixelHeight: 234.381,
    width: 256,
    height: 160,
  };
  function buildLogits() {
    const W = FRAME.width,
      H = FRAME.height;
    const L = new Float32Array(W * H);
    const holes = [
      [70, 70, 9],
      [150, 55, 7],
      [175, 100, 10],
      [110, 112, 6],
    ];
    const islets = [
      [12, 10, 5],
      [30, 8, 3.5],
      [10, 30, 3.5],
      [244, 12, 5],
      [226, 7, 3],
      [246, 148, 6],
      [224, 152, 3.5],
      [12, 150, 5],
      [33, 153, 3],
      [8, 128, 3],
    ];
    for (let v = 0; v < H; v++) {
      for (let u = 0; u < W; u++) {
        const p = (u + 0.5 - 128) / 128;
        const q = (v + 0.5 - 80) / 80;
        const d = Math.hypot(p, q);
        const th = Math.atan2(q, p);
        const R =
          0.9 +
          0.16 * Math.cos(4 * th) +
          0.06 * Math.sin(7 * th + 0.5) +
          0.03 * Math.cos(11 * th + 2);
        let val =
          14 * (R - d) + 0.7 * Math.sin(u * 0.37 + v * 0.11) * Math.cos(v * 0.23 - u * 0.07);
        for (const [hu, hv, hr] of holes)
          val = Math.min(val, 6 * (Math.hypot(u + 0.5 - hu, v + 0.5 - hv) / hr - 1));
        for (const [iu, iv, ir] of islets)
          val = Math.max(val, 6 * (1 - Math.hypot(u + 0.5 - iu, v + 0.5 - iv) / ir));
        L[v * W + u] = val;
      }
    }
    return L;
  }
  const LOGITS = buildLogits();
  // Pre-check box, as poc-sam's rasterImageBounds computes it (0.5-cell spill).
  const BOX = (() => {
    const f = FRAME;
    let u0 = f.width,
      v0 = f.height,
      u1 = -1,
      v1 = -1;
    for (let v = 0; v < f.height; v++)
      for (let u = 0; u < f.width; u++)
        if (LOGITS[v * f.width + u] > 0) {
          if (u < u0) u0 = u;
          if (u > u1) u1 = u;
          if (v < v0) v0 = v;
          if (v > v1) v1 = v;
        }
    const x0 = Math.max(0, Math.floor(f.originX + (u0 - 0.5) * f.pixelWidth));
    const y0 = Math.max(0, Math.floor(f.originY + (v0 - 0.5) * f.pixelHeight));
    const x1 = Math.min(IMG_W, Math.ceil(f.originX + (u1 + 1.5) * f.pixelWidth));
    const y1 = Math.min(IMG_H, Math.ceil(f.originY + (v1 + 1.5) * f.pixelHeight));
    return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
  })();
  // Bilinear logit at a continuous level-0 point (pixel centre of pixel X is X + 0.5).
  function logitAt(px, py) {
    const f = FRAME,
      W = f.width,
      H = f.height;
    const u = (px - f.originX) / f.pixelWidth - 0.5;
    const v = (py - f.originY) / f.pixelHeight - 0.5;
    const ua = Math.floor(u),
      va = Math.floor(v);
    const fu = u - ua,
      fv = v - va;
    const u0 = Math.min(W - 1, Math.max(0, ua)),
      u1 = Math.min(W - 1, Math.max(0, ua + 1));
    const r0 = Math.min(H - 1, Math.max(0, va)) * W,
      r1 = Math.min(H - 1, Math.max(0, va + 1)) * W;
    const a = LOGITS[r0 + u0],
      b = LOGITS[r0 + u1],
      c = LOGITS[r1 + u0],
      d = LOGITS[r1 + u1];
    const top = a + (b - a) * fu,
      bot = c + (d - c) * fu;
    return top + (bot - top) * fv;
  }
  const inBox = (X, Y) => X >= BOX.x && X < BOX.x + BOX.w && Y >= BOX.y && Y < BOX.y + BOX.h;

  // ---------------------------------------------------------------------------
  // Stores. Each exposes box (level-0) and renderInto(out32, w, h, X0, Y0, s, color):
  // nearest sampling at output-pixel centres X0 + (i + 0.5) * s.
  // ---------------------------------------------------------------------------
  function makeGridStore(d, box, sample) {
    const gx0 = Math.floor(box.x / d) * d,
      gy0 = Math.floor(box.y / d) * d;
    const gw = Math.ceil((box.x + box.w - gx0) / d),
      gh = Math.ceil((box.y + box.h - gy0) / d);
    const cells = new Uint8Array(gw * gh);
    let set = 0;
    for (let j = 0; j < gh; j++) {
      const Y = gy0 + (j + 0.5) * d;
      for (let i = 0; i < gw; i++) {
        const X = gx0 + (i + 0.5) * d;
        if (sample(X, Y)) {
          cells[j * gw + i] = 1;
          set++;
        }
      }
    }
    const colIdx = new Int32Array(TS);
    return {
      kind: 'grid',
      d,
      box,
      gx0,
      gy0,
      gw,
      gh,
      cells,
      set,
      bytes: cells.byteLength,
      get(X, Y) {
        const i = Math.floor((X - gx0) / d),
          j = Math.floor((Y - gy0) / d);
        return i >= 0 && j >= 0 && i < gw && j < gh && cells[j * gw + i] === 1;
      },
      renderInto(out, w, h, X0, Y0, s, color) {
        for (let i = 0; i < w; i++) {
          const c = Math.floor((X0 + (i + 0.5) * s - gx0) / d);
          colIdx[i] = c >= 0 && c < gw ? c : -1;
        }
        for (let j = 0; j < h; j++) {
          const r = Math.floor((Y0 + (j + 0.5) * s - gy0) / d);
          if (r < 0 || r >= gh) continue;
          const base = r * gw,
            o = j * w;
          for (let i = 0; i < w; i++) {
            const c = colIdx[i];
            if (c >= 0 && cells[base + c] === 1) out[o + i] = color;
          }
        }
      },
      // Brush stamp: set every cell whose centre lies in the disc. Returns the dirty level-0 rect.
      stamp(cx, cy, r) {
        const i0 = Math.max(0, Math.floor((cx - r - gx0) / d)),
          i1 = Math.min(gw - 1, Math.floor((cx + r - gx0) / d));
        const j0 = Math.max(0, Math.floor((cy - r - gy0) / d)),
          j1 = Math.min(gh - 1, Math.floor((cy + r - gy0) / d));
        let changed = 0;
        for (let j = j0; j <= j1; j++)
          for (let i = i0; i <= i1; i++) {
            const X = gx0 + (i + 0.5) * d,
              Y = gy0 + (j + 0.5) * d;
            if ((X - cx) * (X - cx) + (Y - cy) * (Y - cy) <= r * r && cells[j * gw + i] === 0) {
              cells[j * gw + i] = 1;
              changed++;
            }
          }
        return {
          x: gx0 + i0 * d,
          y: gy0 + j0 * d,
          w: (i1 - i0 + 1) * d,
          h: (j1 - j0 + 1) * d,
          changed,
          cells: { i0, i1, j0, j1 },
        };
      },
    };
  }

  const EMPTY = 0,
    FULL = 1,
    MIXED = 2;
  function makeSparseStore(box) {
    const tx0 = Math.floor(box.x / TS),
      ty0 = Math.floor(box.y / TS);
    const tx1 = Math.floor((box.x + box.w - 1) / TS),
      ty1 = Math.floor((box.y + box.h - 1) / TS);
    const ntx = tx1 - tx0 + 1,
      nty = ty1 - ty0 + 1;
    const state = new Uint8Array(ntx * nty);
    const data = new Array(ntx * nty).fill(null);
    let mixed = 0,
      full = 0;
    const f = FRAME;
    for (let ty = 0; ty < nty; ty++) {
      for (let tx = 0; tx < ntx; tx++) {
        const X0 = (tx0 + tx) * TS,
          Y0 = (ty0 + ty) * TS;
        const inside =
          X0 >= box.x && Y0 >= box.y && X0 + TS <= box.x + box.w && Y0 + TS <= box.y + box.h;
        // Model samples whose bilinear support touches the tile.
        const ua = Math.floor((X0 + 0.5 - f.originX) / f.pixelWidth - 0.5),
          ub = Math.floor((X0 + TS - 0.5 - f.originX) / f.pixelWidth - 0.5) + 1;
        const va = Math.floor((Y0 + 0.5 - f.originY) / f.pixelHeight - 0.5),
          vb = Math.floor((Y0 + TS - 0.5 - f.originY) / f.pixelHeight - 0.5) + 1;
        let pos = 0,
          neg = 0;
        for (let v = va; v <= vb; v++)
          for (let u = ua; u <= ub; u++) {
            const val =
              LOGITS[
                Math.min(f.height - 1, Math.max(0, v)) * f.width +
                  Math.min(f.width - 1, Math.max(0, u))
              ];
            if (val > 0) pos++;
            else neg++;
          }
        const k = ty * ntx + tx;
        if (pos === 0) {
          state[k] = EMPTY;
          continue;
        }
        if (neg === 0 && inside) {
          state[k] = FULL;
          full++;
          continue;
        }
        const bytes = new Uint8Array(TS * TS);
        let any = 0;
        for (let y = 0; y < TS; y++) {
          const Y = Y0 + y;
          for (let x = 0; x < TS; x++) {
            const X = X0 + x;
            if (inBox(X, Y) && logitAt(X + 0.5, Y + 0.5) > 0) {
              bytes[y * TS + x] = 1;
              any++;
            }
          }
        }
        if (any === 0) state[k] = EMPTY;
        else if (any === TS * TS) {
          state[k] = FULL;
          full++;
        } else {
          state[k] = MIXED;
          data[k] = bytes;
          mixed++;
        }
      }
    }
    const txr = new Int32Array(TS),
      xin = new Int32Array(TS);
    const store = {
      kind: 'sparse',
      box,
      tx0,
      ty0,
      ntx,
      nty,
      state,
      data,
      get counts() {
        let m = 0,
          fl = 0;
        for (let k = 0; k < state.length; k++) {
          if (state[k] === MIXED) m++;
          else if (state[k] === FULL) fl++;
        }
        return { tiles: state.length, mixed: m, full: fl, empty: state.length - m - fl };
      },
      get bytes() {
        let m = 0;
        for (let k = 0; k < state.length; k++) if (state[k] === MIXED) m++;
        return m * TS * TS + state.byteLength;
      },
      get(X, Y) {
        const tx = Math.floor(X / TS) - tx0,
          ty = Math.floor(Y / TS) - ty0;
        if (tx < 0 || ty < 0 || tx >= ntx || ty >= nty) return false;
        const k = ty * ntx + tx,
          st = state[k];
        if (st === FULL) return true;
        if (st === EMPTY) return false;
        return (
          data[k][(Math.floor(Y) - (ty + ty0) * TS) * TS + (Math.floor(X) - (tx + tx0) * TS)] === 1
        );
      },
      renderInto(out, w, h, X0, Y0, s, color) {
        for (let i = 0; i < w; i++) {
          const X = Math.floor(X0 + (i + 0.5) * s);
          const t = Math.floor(X / TS) - tx0;
          txr[i] = t >= 0 && t < ntx ? t : -1;
          xin[i] = X - (t + tx0) * TS;
        }
        for (let j = 0; j < h; j++) {
          const Y = Math.floor(Y0 + (j + 0.5) * s);
          const t = Math.floor(Y / TS) - ty0;
          if (t < 0 || t >= nty) continue;
          const yo = (Y - (t + ty0) * TS) * TS,
            base = t * ntx,
            o = j * w;
          for (let i = 0; i < w; i++) {
            const tx = txr[i];
            if (tx < 0) continue;
            const st = state[base + tx];
            if (st === FULL) out[o + i] = color;
            else if (st === MIXED && data[base + tx][yo + xin[i]] === 1) out[o + i] = color;
          }
        }
      },
      stamp(cx, cy, r) {
        const X0 = Math.max(box.x, Math.floor(cx - r)),
          X1 = Math.min(box.x + box.w - 1, Math.ceil(cx + r));
        const Y0 = Math.max(box.y, Math.floor(cy - r)),
          Y1 = Math.min(box.y + box.h - 1, Math.ceil(cy + r));
        let changed = 0;
        for (let ty = Math.floor(Y0 / TS); ty <= Math.floor(Y1 / TS); ty++) {
          for (let tx = Math.floor(X0 / TS); tx <= Math.floor(X1 / TS); tx++) {
            const k = (ty - ty0) * ntx + (tx - tx0);
            if (state[k] === FULL) continue;
            let bytes = data[k];
            if (state[k] === EMPTY) {
              bytes = data[k] = new Uint8Array(TS * TS);
              state[k] = MIXED;
            }
            const ya = Math.max(Y0, ty * TS),
              yb = Math.min(Y1, ty * TS + TS - 1);
            const xa = Math.max(X0, tx * TS),
              xb = Math.min(X1, tx * TS + TS - 1);
            for (let Y = ya; Y <= yb; Y++)
              for (let X = xa; X <= xb; X++) {
                const dx = X + 0.5 - cx,
                  dy = Y + 0.5 - cy;
                if (dx * dx + dy * dy <= r * r) {
                  const o = (Y - ty * TS) * TS + (X - tx * TS);
                  if (bytes[o] === 0) {
                    bytes[o] = 1;
                    changed++;
                  }
                }
              }
          }
        }
        return { x: X0, y: Y0, w: X1 - X0 + 1, h: Y1 - Y0 + 1, changed };
      },
    };
    return store;
  }

  // ---------------------------------------------------------------------------
  // Tile sources
  // ---------------------------------------------------------------------------
  const rgba = (r, g, b, a) => ((a << 24) | (b << 16) | (g << 8) | r) >>> 0;
  const TINT = rgba(33, 150, 243, 115); // #149's DEFAULT_MASK_FILL rgba(33,150,243,0.45)
  let sourceSeq = 1;

  // Base image textures: 8 noise tiles, drawn into each base tile with a level tint.
  const TEX = [];
  (function () {
    let seed = 12345;
    const rnd = () => (seed = (seed * 1103515245 + 12345) >>> 0) / 4294967296;
    for (let t = 0; t < 8; t++) {
      const c = document.createElement('canvas');
      c.width = c.height = TS;
      const cx = c.getContext('2d');
      const id = cx.createImageData(TS, TS);
      const u32 = new Uint32Array(id.data.buffer);
      for (let i = 0; i < u32.length; i++) {
        const g = 150 + Math.floor(rnd() * 80);
        u32[i] = rgba(g, Math.floor(g * 0.8), Math.floor(g * 0.9), 255);
      }
      cx.putImageData(id, 0, 0);
      TEX.push(c);
    }
  })();

  // Live tile registry for invalidation: canvas -> record.
  const registry = new Map();
  const stats = { tilesMade: 0, tileMs: 0, maskTilesMade: 0, maskTileMs: 0 };

  function tileGeometry(src, level, x, y) {
    const maxLevel = src.maxLevel;
    const s = Math.pow(2, maxLevel - level); // level-0 px per tile px
    const levelW = src.dimensions.x / s,
      levelH = src.dimensions.y / s;
    const w = Math.max(1, Math.min(TS, Math.ceil(levelW - x * TS)));
    const h = Math.max(1, Math.min(TS, Math.ceil(levelH - y * TS)));
    return { s, w, h, X0: x * TS * s, Y0: y * TS * s };
  }

  /**
   * An OSD tile source whose tiles are produced synchronously from memory.
   * paint(ctx, geom) draws one tile; geom has level-0 origin X0/Y0 relative to
   * the source's own origin, and s (level-0 px per tile px).
   */
  function makeMemorySource({ width, height, paint, paintRect, transparent, kind, owner }) {
    const id = sourceSeq++;
    const src = new OSD.TileSource({ width, height, tileSize: TS, tileOverlap: 0, minLevel: 0 });
    src.getTileUrl = (l, x, y) => `mem://${id}/${l}/${x}_${y}` + (OSD_MAJOR >= 6 ? '' : '');
    src.downloadTileStart = (job) => {
      const tile = job.tile;
      const g = tileGeometry(src, tile.level, tile.x, tile.y);
      const t0 = now();
      const canvas = document.createElement('canvas');
      canvas.width = g.w;
      canvas.height = g.h;
      const ctx = canvas.getContext('2d', { willReadFrequently: false });
      paint(ctx, g);
      const dt = now() - t0;
      stats.tilesMade++;
      stats.tileMs += dt;
      if (kind === 'mask') {
        stats.maskTilesMade++;
        stats.maskTileMs += dt;
      }
      registry.set(src.getTileUrl(tile.level, tile.x, tile.y), {
        kind,
        owner,
        ctx,
        paint,
        paintRect,
        level: tile.level,
        x: tile.x,
        y: tile.y,
        g,
      });
      if (OSD_MAJOR >= 6) job.finish(ctx, null, 'context2d');
      else job.finish(ctx, null);
    };
    src.downloadTileAbort = () => {};
    if (OSD_MAJOR < 6) {
      src.createTileCache = (cache, data) => {
        cache._ctx = data;
      };
      src.destroyTileCache = (cache) => {
        cache._ctx = null;
      };
      src.getTileCacheData = (cache) => cache._ctx;
      src.getTileCacheDataAsImage = (cache) => cache._ctx.canvas;
      src.getTileCacheDataAsContext2D = (cache) => cache._ctx;
    }
    src.hasTransparency = () => !!transparent;
    src._paint = paint;
    src._kind = kind;
    return src;
  }

  function paintBase(ctx, g) {
    const t = TEX[((g.X0 / (TS * g.s)) * 7 + (g.Y0 / (TS * g.s)) * 13) & 7];
    ctx.drawImage(t, 0, 0);
    const lvl = Math.round(Math.log2(g.s));
    ctx.fillStyle = `hsla(${(lvl * 37) % 360}, 45%, 45%, 0.35)`;
    ctx.fillRect(0, 0, g.w, g.h);
  }

  function maskPainter(store, colorRef) {
    return (ctx, g) => {
      const id = ctx.createImageData(g.w, g.h);
      const out = new Uint32Array(id.data.buffer);
      store.renderInto(out, g.w, g.h, store.box.x + g.X0, store.box.y + g.Y0, g.s, colorRef.color);
      ctx.putImageData(id, 0, 0);
    };
  }
  function maskRectPainter(store, colorRef) {
    return (ctx, g, i0, j0, w, h) => {
      if (w <= 0 || h <= 0) return;
      const id = ctx.createImageData(w, h);
      const out = new Uint32Array(id.data.buffer);
      store.renderInto(
        out,
        w,
        h,
        store.box.x + g.X0 + i0 * g.s,
        store.box.y + g.Y0 + j0 * g.s,
        g.s,
        colorRef.color,
      );
      ctx.putImageData(id, i0, j0);
    };
  }

  // ---------------------------------------------------------------------------
  // Viewer + Fabric overlay (mirrors FabricOverlay: canvas appended inside viewer.canvas, sync on update-viewport)
  // ---------------------------------------------------------------------------
  const viewer = OSD({
    element: document.getElementById('viewer'),
    prefixUrl: '',
    showNavigationControl: false,
    animationTime: 0.3,
    maxZoomLevel: 40,
    visibilityRatio: 0.5,
    drawer: DRAWER,
    maxTilesPerFrame: MTPF,
    imageLoaderLimit: 0,
    // OSD 6 only (ignored by 5): upload tile canvases premultiplied so translucent tiles blend correctly.
    drawerOptions: { webgl: { unpackWithPremultipliedAlpha: Q.get('premul') !== '0' } },
  });
  // Drop registry entries when OSD unloads a tile (both 5 and 6 raise tile-unloaded).
  viewer.addHandler('tile-unloaded', (e) => {
    registry.delete(e.tile.getUrl ? e.tile.getUrl() : e.tile.url);
  });
  const prof = { update: 0, draw: 0, fabric: 0, frames: 0 };
  (function instrument() {
    const w = viewer.world;
    const u = w.update.bind(w),
      dr = w.draw.bind(w);
    w.update = function (vc) {
      const t = now();
      const r = u(vc);
      prof.update += now() - t;
      return r;
    };
    w.draw = function () {
      const t = now();
      const r = dr();
      prof.draw += now() - t;
      prof.frames++;
      return r;
    };
  })();

  let fc = null; // fabric canvas
  function setupFabric() {
    const el = document.createElement('canvas');
    el.style.position = 'absolute';
    el.style.top = '0';
    el.style.left = '0';
    el.style.pointerEvents = 'none';
    viewer.canvas.appendChild(el);
    const size = viewer.viewport.getContainerSize();
    el.width = size.x;
    el.height = size.y;
    fc = new F.Canvas(el, {
      selection: false,
      renderOnAddRemove: false,
      skipOffscreen: false,
      enablePointerEvents: true,
    });
    fc.setDimensions({ width: size.x, height: size.y });
    fc.getZoom = () => {
      const v = fc.viewportTransform;
      return Math.sqrt(v[0] * v[0] + v[1] * v[1]);
    };
    viewer.addHandler('update-viewport', syncFabric);
  }
  function computeVpt() {
    const ti = viewer.world.getItemAt(0);
    const p0 = ti.imageToViewerElementCoordinates(new OSD.Point(0, 0));
    const px = ti.imageToViewerElementCoordinates(new OSD.Point(1, 0));
    const py = ti.imageToViewerElementCoordinates(new OSD.Point(0, 1));
    return [px.x - p0.x, px.y - p0.y, py.x - p0.x, py.y - p0.y, p0.x, p0.y];
  }
  function syncFabric() {
    if (!fc || !viewer.world.getItemAt(0)) return;
    const t = now();
    fc.setViewportTransform(computeVpt());
    fc.renderAll();
    prof.fabric += now() - t;
  }

  // ---------------------------------------------------------------------------
  // Scene construction
  // ---------------------------------------------------------------------------
  const scene = {
    store: null,
    maskItem: null,
    maskSrc: null,
    color: { color: TINT },
    fabricMask: null,
    gridCanvas: null,
    masks: [],
    buildMs: 0,
  };

  function addItem(tileSource, opts) {
    return new Promise((resolve, reject) => {
      viewer.addTiledImage(
        Object.assign(
          {
            tileSource,
            success: (e) => resolve(e.item),
            error: (e) => reject(new Error(e.message)),
          },
          opts,
        ),
      );
    });
  }

  async function openBase() {
    const src = makeMemorySource({
      width: IMG_W,
      height: IMG_H,
      paint: paintBase,
      transparent: false,
      kind: 'base',
    });
    await new Promise((resolve) => {
      viewer.addOnceHandler('open', resolve);
      viewer.open(src);
    });
    setupFabric();
    viewer.viewport.goHome(true);
  }

  function buildStore() {
    const t0 = now();
    const sample = (X, Y) => inBox(X, Y) && logitAt(X, Y) > 0;
    if (MODE === 'osd-sparse') scene.store = makeSparseStore(BOX);
    else if (MODE === 'osd-grid' || MODE === 'fabric-grid')
      scene.store = makeGridStore(D, BOX, sample);
    scene.buildMs = now() - t0;
  }

  // Small masks for the multi-mask modes: blobs of radius 1500..4000 px scattered over the slide, d=8 grids.
  function buildMulti() {
    let seed = 777;
    const rnd = () => (seed = (seed * 1103515245 + 12345) >>> 0) / 4294967296;
    const t0 = now();
    for (let k = 0; k < N_MASKS; k++) {
      const r = 1500 + rnd() * 2500;
      const cx = 5000 + rnd() * (IMG_W - 10000),
        cy = 5000 + rnd() * (IMG_H - 10000);
      const box = {
        x: Math.floor(cx - r),
        y: Math.floor(cy - r),
        w: Math.ceil(2 * r),
        h: Math.ceil(2 * r),
      };
      const ph = rnd() * 6;
      const sample = (X, Y) => {
        const a = Math.atan2(Y - cy, X - cx);
        const rr = r * (0.85 + 0.15 * Math.cos(5 * a + ph));
        return (X - cx) ** 2 + (Y - cy) ** 2 <= rr * rr;
      };
      const store = makeGridStore(8, box, sample);
      const hue = (k * 47) % 360;
      const c = hslToRgb(hue / 360, 0.7, 0.5);
      scene.masks.push({ store, color: { color: rgba(c[0], c[1], c[2], 115) } });
    }
    scene.buildMs = now() - t0;
  }
  function hslToRgb(h, s, l) {
    const f = (n) => {
      const k = (n + h * 12) % 12;
      const a = s * Math.min(l, 1 - l);
      return Math.round(255 * (l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1))));
    };
    return [f(0), f(8), f(4)];
  }

  async function addMaskItem(store, colorRef) {
    const src = makeMemorySource({
      width: store.box.w,
      height: store.box.h,
      paint: maskPainter(store, colorRef),
      paintRect: FULLREPAINT ? null : maskRectPainter(store, colorRef),
      transparent: TRANSP,
      kind: 'mask',
      owner: store,
    });
    const item = await addItem(src, {
      x: store.box.x / IMG_W,
      y: store.box.y / IMG_W,
      width: store.box.w / IMG_W,
    });
    tuneMaskItem(item);
    return { item, src };
  }

  // One label layer for many masks: a single image-sized source painting every mask that intersects the tile.
  function labelPainter(masks) {
    return (ctx, g) => {
      const id = ctx.createImageData(g.w, g.h);
      const out = new Uint32Array(id.data.buffer);
      const X1 = g.X0 + g.w * g.s,
        Y1 = g.Y0 + g.h * g.s;
      for (const m of masks) {
        const b = m.store.box;
        if (b.x >= X1 || b.y >= Y1 || b.x + b.w <= g.X0 || b.y + b.h <= g.Y0) continue;
        m.store.renderInto(out, g.w, g.h, g.X0, g.Y0, g.s, m.color.color);
      }
      ctx.putImageData(id, 0, 0);
    };
  }

  function buildFabricGrid(store, colorRef) {
    // #149's buildMaskFabricObject, scaled by d: canvas of gw x gh, one pixel per cell.
    const t0 = now();
    const canvas = document.createElement('canvas');
    canvas.width = store.gw;
    canvas.height = store.gh;
    const ctx = canvas.getContext('2d');
    const id = ctx.createImageData(store.gw, store.gh);
    const out = new Uint32Array(id.data.buffer);
    const cells = store.cells,
      color = colorRef.color;
    for (let i = 0; i < cells.length; i++) if (cells[i] === 1) out[i] = color;
    ctx.putImageData(id, 0, 0);
    const img = new F.FabricImage(canvas, {
      left: store.gx0,
      top: store.gy0,
      originX: 'left',
      originY: 'top',
      scaleX: store.d,
      scaleY: store.d,
      selectable: true,
      evented: true,
      hasControls: false,
      perPixelTargetFind: true,
      imageSmoothing: false,
      objectCaching: false,
    });
    img.id = 'mask-1';
    return { img, canvas, ctx, ms: now() - t0 };
  }

  // ---------------------------------------------------------------------------
  // Waiting / motion helpers
  // ---------------------------------------------------------------------------
  const raf = () => new Promise((r) => requestAnimationFrame(r));
  const nextDraw = () =>
    new Promise((r) => viewer.addOnceHandler('update-viewport', () => r(now())));
  let lastDraw = 0,
    drawCount = 0;
  viewer.addHandler('update-viewport', () => {
    lastDraw = now();
    drawCount++;
  });
  // Polls each frame until every item in `items` is fully loaded and nothing awaits a draw; returns the
  // time of the last draw (the one that put the completed layer on screen) and the frames polled.
  async function untilLoaded(items, maxFrames = 600) {
    let frames = 0;
    for (; frames < maxFrames; frames++) {
      await raf();
      if (items.every((it) => it.getFullyLoaded()) && !viewer.world.needsDraw()) break;
    }
    return { t: lastDraw, frames };
  }
  function allItems() {
    const a = [];
    for (let i = 0; i < viewer.world.getItemCount(); i++) a.push(viewer.world.getItemAt(i));
    return a;
  }
  async function settle(maxFrames = 600) {
    // Wait until every item is fully loaded and nothing is animating; returns frames waited.
    let n = 0;
    for (; n < maxFrames; n++) {
      await raf();
      const loaded = allItems().every((it) => it.getFullyLoaded());
      if (loaded && !viewer.world.needsDraw() && !viewer.isAnimating?.()) {
        await raf();
        await raf();
        if (allItems().every((it) => it.getFullyLoaded())) break;
      }
    }
    return n;
  }
  function resetProf() {
    prof.update = 0;
    prof.draw = 0;
    prof.fabric = 0;
    prof.frames = 0;
  }
  function pct(arr, p) {
    if (!arr.length) return null;
    const a = [...arr].sort((x, y) => x - y);
    return a[Math.min(a.length - 1, Math.floor(p * (a.length - 1) + 0.5))];
  }
  const r2 = (x) => (x == null ? null : Math.round(x * 100) / 100);
  function summarize(recs) {
    const pick = (k) => recs.map((r) => r[k]);
    const out = { frames: recs.length };
    for (const k of ['dt', 'update', 'draw', 'fabric', 'cpu']) {
      const a = pick(k);
      out[k] = { p50: r2(pct(a, 0.5)), p95: r2(pct(a, 0.95)), max: r2(Math.max(...a)) };
    }
    out.longFrames50 = recs.filter((r) => r.dt > 50).length;
    out.fps = r2(1000 / (recs.reduce((s, r) => s + r.dt, 0) / recs.length));
    out.tilesMade = recs.reduce((s, r) => s + r.tiles, 0);
    out.maskTilesMade = recs.reduce((s, r) => s + r.maskTiles, 0);
    out.maskTileMs = r2(recs.reduce((s, r) => s + r.maskTileMs, 0));
    return out;
  }
  function motion(frames, step) {
    return new Promise((resolve) => {
      const recs = [];
      let last = null,
        i = 0,
        t0 = 0,
        m0 = 0,
        mm0 = 0;
      function tick() {
        const tn = now();
        if (last !== null) {
          recs.push({
            dt: tn - last,
            update: prof.update,
            draw: prof.draw,
            fabric: prof.fabric,
            cpu: prof.update + prof.draw + prof.fabric,
            tiles: stats.tilesMade - t0,
            maskTiles: stats.maskTilesMade - m0,
            maskTileMs: stats.maskTileMs - mm0,
          });
        }
        resetProf();
        t0 = stats.tilesMade;
        m0 = stats.maskTilesMade;
        mm0 = stats.maskTileMs;
        last = tn;
        if (i >= frames) {
          resolve(summarize(recs));
          return;
        }
        step(i++);
        requestAnimationFrame(tick);
      }
      requestAnimationFrame(tick);
    });
  }

  // Boundary point: on the box's centre row, scanning left from the right edge to the first covered pixel.
  // Boundary point: the edge of the largest hole (model cell (175,100), radius 10 cells), scanning right
  // from the hole's centre to the first covered pixel, so both sides of the view hold mixed tiles.
  const BOUNDARY = (() => {
    const cx = Math.floor(FRAME.originX + 175 * FRAME.pixelWidth),
      Y = Math.floor(FRAME.originY + 100 * FRAME.pixelHeight);
    for (let X = cx; X < BOX.x + BOX.w; X += 2)
      if (logitAt(X + 0.5, Y + 0.5) > 0) return { x: X, y: Y };
    return { x: cx, y: Y };
  })();

  const baseItem = () => viewer.world.getItemAt(0);
  function vpPoint(x, y) {
    return baseItem().imageToViewportCoordinates(new OSD.Point(x, y));
  }
  function gotoOneToOne(p) {
    const vp = viewer.viewport;
    // 1 image px = 1 screen px.
    const z = baseItem().imageToViewportZoom(1);
    vp.zoomTo(z, null, true);
    vp.panTo(vpPoint(p.x, p.y), true);
  }

  // ---------------------------------------------------------------------------
  // Measurements exposed to run.mjs
  // ---------------------------------------------------------------------------
  function maskCanvasBytes() {
    let n = 0,
      bytes = 0,
      base = 0,
      baseBytes = 0;
    for (const r of registry.values()) {
      const c = r.ctx.canvas;
      if (r.kind === 'mask') {
        n++;
        bytes += c.width * c.height * 4;
      } else {
        base++;
        baseBytes += c.width * c.height * 4;
      }
    }
    return { maskTiles: n, maskTileBytes: bytes, baseTiles: base, baseTileBytes: baseBytes };
  }
  function memory() {
    const m = performance.memory || {};
    return Object.assign(
      {
        jsHeapUsed: m.usedJSHeapSize,
        jsHeapTotal: m.totalJSHeapSize,
        storeBytes: scene.store
          ? scene.store.bytes
          : scene.masks.reduce((s, k) => s + k.store.bytes, 0),
        fabricCanvasBytes: scene.gridCanvas
          ? scene.gridCanvas.width * scene.gridCanvas.height * 4
          : 0,
      },
      maskCanvasBytes(),
    );
  }

  async function setup() {
    await openBase();
    await settle();
    const r = {
      mode: MODE,
      drawer: DRAWER,
      drawerType: viewer.drawer.getType ? viewer.drawer.getType() : null,
      osd: OSD.version.versionStr,
      d: D,
      box: BOX,
      boundary: BOUNDARY,
      mtpf: MTPF,
      immediate: IMMEDIATE,
      transp: TRANSP,
      round: ROUND,
    };
    if (MODE === 'osd-grid' || MODE === 'osd-sparse' || MODE === 'fabric-grid') {
      buildStore();
      r.buildMs = r2(scene.buildMs);
      r.storeBytes = scene.store.bytes;
      if (scene.store.kind === 'grid') {
        r.grid = {
          gw: scene.store.gw,
          gh: scene.store.gh,
          cells: scene.store.gw * scene.store.gh,
          set: scene.store.set,
        };
      } else r.sparse = scene.store.counts;
    } else if (MODE === 'multi-tiled' || MODE === 'multi-label') {
      buildMulti();
      r.buildMs = r2(scene.buildMs);
      r.n = N_MASKS;
    }
    r.memAfterBuild = memory();
    return r;
  }

  // Adds the mask layer(s) at the current view and times until the first frame that shows them complete.
  async function firstFrame() {
    await settle();
    resetProf();
    const tm0 = stats.maskTilesMade,
      tms0 = stats.maskTileMs;
    const t0 = now();
    let frames = 0;
    if (MODE === 'osd-grid' || MODE === 'osd-sparse') {
      const { item, src } = await addMaskItem(scene.store, scene.color);
      scene.maskItem = item;
      scene.maskSrc = src;
    } else if (MODE === 'multi-tiled') {
      for (const m of scene.masks) {
        const { item } = await addMaskItem(m.store, m.color);
        m.item = item;
      }
    } else if (MODE === 'multi-label') {
      const src = makeMemorySource({
        width: IMG_W,
        height: IMG_H,
        paint: labelPainter(scene.masks),
        transparent: TRANSP,
        kind: 'mask',
        owner: 'label',
      });
      const item = await addItem(src, { x: 0, y: 0, width: 1 });
      tuneMaskItem(item);
      scene.maskItem = item;
      scene.maskSrc = src;
    } else if (MODE === 'fabric-grid') {
      const b = buildFabricGrid(scene.store, scene.color);
      scene.fabricMask = b.img;
      scene.gridCanvas = b.canvas;
      scene.gridCtx = b.ctx;
      fc.add(b.img);
      const tr = now();
      syncFabric();
      const firstRender = now() - tr;
      const total = now() - t0;
      await raf();
      return {
        ms: r2(total),
        buildCanvasMs: r2(b.ms),
        firstRenderMs: r2(firstRender),
        frames: 1,
        mem: memory(),
      };
    } else {
      return { ms: 0, frames: 0 };
    }
    const items = MODE === 'multi-tiled' ? scene.masks.map((m) => m.item) : [scene.maskItem];
    const d0 = drawCount;
    const done = await untilLoaded(items);
    return {
      ms: r2(done.t - t0),
      draws: drawCount - d0,
      framesPolled: done.frames,
      maskTiles: stats.maskTilesMade - tm0,
      maskTileMs: r2(stats.maskTileMs - tms0),
      updateMs: r2(prof.update),
      drawMs: r2(prof.draw),
      mem: memory(),
    };
  }

  async function home() {
    viewer.viewport.goHome(true);
    await settle();
  }
  async function oneToOne() {
    gotoOneToOne(BOUNDARY);
    await settle();
  }

  // Overview pan: 8 css px per frame right for 60 frames, then left for 60.
  function panOverview() {
    const vp = viewer.viewport;
    return motion(120, (i) => {
      const dxPx = i < 60 ? 8 : -8;
      const d = vp.deltaPointsFromPixels(new OSD.Point(dxPx, 0), true);
      vp.panBy(d, true);
    });
  }
  // Overview zoom: x1.02 per frame towards the mask centre for 60 frames, then back.
  function zoomOverview() {
    const vp = viewer.viewport;
    const c = vpPoint(BOX.x + BOX.w / 2, BOX.y + BOX.h / 2);
    return motion(120, (i) => {
      vp.zoomBy(i < 60 ? 1.02 : 1 / 1.02, c, true);
    });
  }
  // 1:1 pan along the boundary: 20 css px per frame for 120 frames (2,400 px, ~10 new tile columns).
  function pan11() {
    const vp = viewer.viewport;
    return motion(120, () => {
      vp.panBy(vp.deltaPointsFromPixels(new OSD.Point(0, 20), true), true);
    });
  }
  // Dive: overview to 1:1 on the boundary over 90 frames (geometric zoom), then hold 30 frames.
  function dive() {
    const vp = viewer.viewport;
    const zStart = vp.getZoom(true),
      zEnd = baseItem().imageToViewportZoom(1);
    const cStart = vp.getCenter(true),
      cEnd = vpPoint(BOUNDARY.x, BOUNDARY.y);
    return motion(120, (i) => {
      const t = Math.min(1, (i + 1) / 90);
      const z = zStart * Math.pow(zEnd / zStart, t);
      vp.zoomTo(z, null, true);
      vp.panTo(
        new OSD.Point(cStart.x + (cEnd.x - cStart.x) * t, cStart.y + (cEnd.y - cStart.y) * t),
        true,
      );
    });
  }

  // Re-render the live OSD tiles of `owner` that intersect a level-0 rect (store coordinates), in place.
  function invalidateRegion(owner, rect) {
    let n = 0,
      px = 0;
    const t0 = now();
    const webgl = typeof viewer.drawer._cleanupImageData === 'function';
    for (const rec of registry.values()) {
      if (rec.owner !== owner) continue;
      const canvas = rec.ctx.canvas;
      const g = rec.g;
      const X0 = owner.box ? owner.box.x + g.X0 : g.X0,
        Y0 = owner.box ? owner.box.y + g.Y0 : g.Y0;
      if (
        rect.x >= X0 + g.w * g.s ||
        rect.y >= Y0 + g.h * g.s ||
        rect.x + rect.w <= X0 ||
        rect.y + rect.h <= Y0
      )
        continue;
      if (rec.paintRect && isFinite(rect.w) && !scene.forceFull) {
        // Repaint only the tile pixels the dirty rect covers (+1 px), not the whole tile.
        const i0 = Math.max(0, Math.floor((rect.x - X0) / g.s) - 1),
          j0 = Math.max(0, Math.floor((rect.y - Y0) / g.s) - 1);
        const i1 = Math.min(g.w, Math.ceil((rect.x + rect.w - X0) / g.s) + 1),
          j1 = Math.min(g.h, Math.ceil((rect.y + rect.h - Y0) / g.s) + 1);
        rec.paintRect(rec.ctx, g, i0, j0, i1 - i0, j1 - j0);
        px += (i1 - i0) * (j1 - j0);
      } else {
        rec.paint(rec.ctx, g);
        px += g.w * g.h;
      }
      if (webgl) viewer.drawer._cleanupImageData(canvas);
      n++;
    }
    return { tiles: n, px, ms: now() - t0 };
  }
  function readPixel(x, y) {
    // Screen pixel of the drawer's canvas at image point (x,y).
    const p = baseItem().imageToViewerElementCoordinates(new OSD.Point(x, y));
    const c = viewer.drawer.canvas;
    const ctx = c.getContext('2d');
    const ratio = c.width / viewer.container.clientWidth;
    const d = ctx.getImageData(Math.round(p.x * ratio), Math.round(p.y * ratio), 1, 1).data;
    return [d[0], d[1], d[2], d[3]];
  }
  function readFabricPixel(x, y) {
    const p = baseItem().imageToViewerElementCoordinates(new OSD.Point(x, y));
    const ctx = fc.lowerCanvasEl.getContext('2d');
    const d = ctx.getImageData(Math.round(p.x), Math.round(p.y), 1, 1).data;
    return [d[0], d[1], d[2], d[3]];
  }

  // One brush stamp at (cx,cy) radius r, repainted by the mode's invalidation strategy.
  // strategy: 'inplace' (re-render intersecting live tiles; WebGL drops their textures via the private
  // _cleanupImageData) | 'reset' (TiledImage.reset(), every tile regenerated) | 'osd6' (requestInvalidate) |
  // 'fabric-inplace' (putImageData of the dirty cells into #149's canvas) | 'fabric-rebuild' (#149's commit path).
  async function stamp(cx, cy, r, strategy) {
    const store = scene.store;
    const res = { strategy, r };
    const before = MODE === 'fabric-grid' ? readFabricPixel(cx, cy) : readPixel(cx, cy);
    await raf();
    const t0 = now();
    const dirty = store.stamp(cx, cy, r);
    const t1 = now();
    res.storeMs = r2(t1 - t0);
    res.changed = dirty.changed;
    res.dirty = { w: dirty.w, h: dirty.h };
    if (MODE === 'fabric-grid') {
      if (strategy === 'fabric-rebuild') {
        const b = buildFabricGrid(store, scene.color);
        fc.remove(scene.fabricMask);
        fc.add(b.img);
        scene.fabricMask = b.img;
        scene.gridCanvas = b.canvas;
        scene.gridCtx = b.ctx;
        res.rebuildMs = r2(b.ms);
      } else {
        const { i0, i1, j0, j1 } = dirty.cells;
        const w = i1 - i0 + 1,
          h = j1 - j0 + 1;
        const id = scene.gridCtx.createImageData(w, h);
        const out = new Uint32Array(id.data.buffer);
        for (let j = 0; j < h; j++)
          for (let i = 0; i < w; i++)
            if (store.cells[(j0 + j) * store.gw + i0 + i]) out[j * w + i] = scene.color.color;
        scene.gridCtx.putImageData(id, i0, j0);
      }
      const t2 = now();
      fc.renderAll();
      const t3 = now();
      res.renderMs = r2(t3 - t2);
      res.totalMs = r2(t3 - t0);
      res.after = readFabricPixel(cx, cy);
      res.before = before;
      return res;
    }
    let inv = { tiles: null, ms: 0 };
    if (strategy === 'inplace') inv = invalidateRegion(store, dirty);
    else if (strategy === 'reset') {
      // OSD 5.0.1's reset() leaves _fullyLoaded true, and update() only re-selects tiles when the viewport
      // changed or the item is not fully loaded, so without a viewport change the layer stays blank
      // (measured). OSD 6.1.1's reset() clears _fullyLoaded. Nudge with the private flag on 5.
      scene.maskItem.reset();
      if (OSD_MAJOR < 6) scene.maskItem._needsUpdate = true;
    } else if (strategy === 'reset-nonudge') scene.maskItem.reset();
    else if (strategy === 'osd6event') {
      // OSD 6's documented data path: a tile-invalidated handler replaces the dirty tiles' data.
      inv = invalidateRegion(store, dirty);
      const item = scene.maskItem;
      const handler = async (e) => {
        if (e.tiledImage !== item) return;
        const rec = registry.get(e.tile.getUrl());
        if (!rec) return;
        const g = rec.g,
          X0 = store.box.x + g.X0,
          Y0 = store.box.y + g.Y0;
        if (
          dirty.x >= X0 + g.w * g.s ||
          dirty.y >= Y0 + g.h * g.s ||
          dirty.x + dirty.w <= X0 ||
          dirty.y + dirty.h <= Y0
        )
          return;
        const c = document.createElement('canvas');
        c.width = g.w;
        c.height = g.h;
        const ctx = c.getContext('2d');
        rec.paint(ctx, g);
        await e.setData(ctx, 'context2d');
        res.eventTiles = (res.eventTiles || 0) + 1;
      };
      viewer.addHandler('tile-invalidated', handler);
      await item.requestInvalidate(true, true);
      viewer.removeHandler('tile-invalidated', handler);
      res.invalidatePromiseMs = r2(now() - t1);
    } else if (
      strategy === 'osd6await' ||
      strategy === 'osd6world' ||
      strategy === 'osd6norestore'
    ) {
      // OSD 6: repaint our canvases in place, then await OSD's invalidation pipeline before drawing.
      inv = invalidateRegion(store, dirty);
      if (strategy === 'osd6world') await viewer.world.requestInvalidate(true);
      else await scene.maskItem.requestInvalidate(strategy !== 'osd6norestore', false);
      res.invalidatePromiseMs = r2(now() - t1);
    } else if (strategy === 'osd6') {
      // OSD 6: re-render our canvases in place, then ask OSD to re-process the drawn tiles (public API).
      inv = invalidateRegion(store, dirty);
      scene.maskItem.requestInvalidate(true, true);
    }
    res.invalidateMs = r2(inv.ms);
    res.tilesRepainted = inv.tiles;
    res.pxRepainted = inv.px;
    viewer.forceRedraw();
    const tDraw = await nextDraw();
    res.toDrawMs = r2(tDraw - t0);
    // For 'reset', count draws until the mask is fully loaded again (frames showing an incomplete mask).
    if (strategy === 'reset' || strategy === 'osd6' || strategy === 'reset-nonudge') {
      const d0 = drawCount;
      const done = await untilLoaded([scene.maskItem]);
      res.drawsUntilComplete = drawCount - d0 + 1;
      res.toCompleteMs = r2(done.t - t0);
    }
    await raf();
    res.after = readPixel(cx, cy);
    res.before = before;
    return res;
  }

  // A stroke: `count` stamps along a line, one per frame, each repainted before the next.
  async function stroke(x0, y0, x1, y1, r, count, strategy) {
    const per = [];
    for (let k = 0; k < count; k++) {
      const t = k / (count - 1);
      const s = await stamp(x0 + (x1 - x0) * t, y0 + (y1 - y0) * t, r, strategy);
      per.push(s.toDrawMs ?? s.totalMs);
    }
    return { count, p50: r2(pct(per, 0.5)), p95: r2(pct(per, 0.95)), max: r2(Math.max(...per)) };
  }

  // Selection styling on the OSD layer: dim (setOpacity) and re-tint (repaint every live tile of the mask).
  async function selectionStyle() {
    const res = {};
    await raf();
    let t0 = now();
    scene.maskItem.setOpacity(0.4);
    res.dimToDrawMs = r2((await nextDraw()) - t0);
    scene.maskItem.setOpacity(1);
    await nextDraw();
    t0 = now();
    scene.color.color = rgba(255, 152, 0, 140);
    const inv = invalidateRegion(scene.store, { x: -1e9, y: -1e9, w: 2e9, h: 2e9 });
    viewer.forceRedraw();
    res.retintTiles = inv.tiles;
    res.retintRepaintMs = r2(inv.ms);
    res.retintToDrawMs = r2((await nextDraw()) - t0);
    scene.color.color = TINT;
    invalidateRegion(scene.store, { x: -1e9, y: -1e9, w: 2e9, h: 2e9 });
    viewer.forceRedraw();
    await nextDraw();
    return res;
  }

  // Outline layer: a second TiledImage drawing only boundary pixels of the same store (selection outline).
  function outlinePainter(store, color) {
    return (ctx, g) => {
      const w = g.w + 2,
        h = g.h + 2;
      const cov = new Uint32Array(w * h);
      store.renderInto(cov, w, h, store.box.x + g.X0 - g.s, store.box.y + g.Y0 - g.s, g.s, 1);
      const id = ctx.createImageData(g.w, g.h);
      const out = new Uint32Array(id.data.buffer);
      for (let j = 0; j < g.h; j++)
        for (let i = 0; i < g.w; i++) {
          const k = (j + 1) * w + (i + 1);
          if (cov[k] && (!cov[k - 1] || !cov[k + 1] || !cov[k - w] || !cov[k + w]))
            out[j * g.w + i] = color;
        }
      ctx.putImageData(id, 0, 0);
    };
  }
  async function outline() {
    const store = scene.store;
    resetProf();
    const tm0 = stats.maskTilesMade,
      tms0 = stats.maskTileMs;
    const t0 = now();
    const src = makeMemorySource({
      width: store.box.w,
      height: store.box.h,
      paint: outlinePainter(store, rgba(255, 235, 59, 255)),
      transparent: TRANSP,
      kind: 'mask',
      owner: 'outline',
    });
    const item = await addItem(src, {
      x: store.box.x / IMG_W,
      y: store.box.y / IMG_W,
      width: store.box.w / IMG_W,
    });
    tuneMaskItem(item);
    const done = await untilLoaded([item]);
    const res = {
      ms: r2(done.t - t0),
      tiles: stats.maskTilesMade - tm0,
      tileMs: r2(stats.maskTileMs - tms0),
    };
    viewer.world.removeItem(item);
    await settle();
    return res;
  }

  // Hit testing through Fabric with a proxy object per mask: a box-sized FabricObject whose render, when
  // Fabric probes it for perPixelTargetFind, asks the store about the probed point. Compared with #149's
  // per-pixel probe of a FabricImage (fabric-grid mode).
  class MaskProxy extends F.FabricObject {
    constructor(store, opts) {
      super(
        Object.assign(
          {
            left: store.box.x,
            top: store.box.y,
            width: store.box.w,
            height: store.box.h,
            originX: 'left',
            originY: 'top',
            fill: '',
            stroke: '',
            strokeWidth: 0,
            objectCaching: false,
            perPixelTargetFind: true,
            selectable: true,
            evented: true,
            hasControls: false,
          },
          opts,
        ),
      );
      this.store = store;
    }
    _render(ctx) {
      const canvas = this.canvas;
      if (!canvas || ctx !== canvas.pixelFindContext) return; // draws nothing on the visible canvas
      // The probe pixel (tolerance, tolerance) in object-local coords -> image coords -> store lookup.
      const m = ctx.getTransform().invertSelf();
      const tol = canvas.targetFindTolerance;
      const p = m.transformPoint(new DOMPoint(tol + 0.5, tol + 0.5));
      const X = this.store.box.x + this.store.box.w / 2 + p.x,
        Y = this.store.box.y + this.store.box.h / 2 + p.y;
      if (this.store.get(X, Y)) {
        ctx.save();
        ctx.resetTransform();
        ctx.fillStyle = '#000';
        ctx.fillRect(0, 0, 2 * tol + 1, 2 * tol + 1);
        ctx.restore();
      }
    }
  }
  async function hitTest(n) {
    // n probe points around the boundary at the current view.
    const objs = [];
    let target;
    if (MODE === 'fabric-grid') {
      objs.push(scene.fabricMask);
      target = scene.fabricMask;
    } else {
      const masks = scene.masks.length ? scene.masks.map((m) => m.store) : [scene.store];
      for (const s of masks) {
        const p = new MaskProxy(s);
        p.id = 'proxy';
        fc.add(p);
        objs.push(p);
      }
      target = objs[0];
    }
    const vp = viewer.viewport;
    const times = [];
    let hits = 0,
      agree = 0;
    const store = scene.store || scene.masks[0].store;
    for (let k = 0; k < n; k++) {
      const sx = 100 + ((k * 97) % 824),
        sy = 80 + ((k * 61) % 608);
      const img = baseItem().viewerElementToImageCoordinates(new OSD.Point(sx, sy));
      const scenePt = new F.Point(sx, sy).transform(F.util.invertTransform(fc.viewportTransform));
      const t0 = now();
      const info = fc.searchPossibleTargets(fc.getObjects(), scenePt);
      times.push(now() - t0);
      const hit = !!info.target;
      if (hit) hits++;
      if (hit === store.get(img.x, img.y) || scene.masks.length) agree++;
    }
    if (MODE !== 'fabric-grid') {
      for (const o of objs) fc.remove(o);
      fc.renderAll();
    }
    return {
      probes: n,
      objects: objs.length,
      hits,
      agreeWithStore: agree,
      p50: r2(pct(times, 0.5)),
      p95: r2(pct(times, 0.95)),
      max: r2(Math.max(...times)),
    };
  }

  async function rotateFlip() {
    // OSD rotates and flips every TiledImage, masks included. Sample the drawer canvas at a hole centre
    // (model cell (70,70), expected: no mask) and in tissue 3,500 px to its right (expected: mask), at
    // rotation 0 and at rotation 90 + horizontal flip. Screen points are flip-aware: OSD 5 mirrors the
    // drawer canvas around the container's vertical centre line, which imageToViewerElementCoordinates omits.
    const vp = viewer.viewport;
    const hole = {
      x: FRAME.originX + 70.5 * FRAME.pixelWidth,
      y: FRAME.originY + 70.5 * FRAME.pixelHeight,
    };
    const tissue = { x: hole.x + 3500, y: hole.y };
    const sample = (pt) => {
      const p = baseItem().imageToViewerElementCoordinates(new OSD.Point(pt.x, pt.y));
      const cw = viewer.container.clientWidth;
      const x = vp.getFlip && vp.getFlip() ? cw - p.x : p.x;
      const c = viewer.drawer.canvas,
        ratio = c.width / cw;
      const d = c
        .getContext('2d')
        .getImageData(Math.round(x * ratio), Math.round(p.y * ratio), 1, 1).data;
      return [d[0], d[1], d[2]];
    };
    const expect = { hole: store.get(hole.x, hole.y), tissue: store.get(tissue.x, tissue.y) };
    viewer.forceRedraw();
    await settle();
    const r0 = { hole: sample(hole), tissue: sample(tissue) };
    vp.setRotation(90, true);
    if (vp.setFlip) vp.setFlip(true);
    viewer.forceRedraw();
    await settle();
    await raf();
    const r90f = { hole: sample(hole), tissue: sample(tissue) };
    vp.setRotation(0, true);
    if (vp.setFlip) vp.setFlip(false);
    viewer.forceRedraw();
    await settle();
    return { expect, rot0: r0, rot90flip: r90f };
  }
  const store = { get: (x, y) => scene.store.get(x, y) };
  function setForceFull(v) {
    scene.forceFull = !!v;
  }

  window.H = {
    setForceFull,
    setup,
    firstFrame,
    home,
    oneToOne,
    panOverview,
    zoomOverview,
    pan11,
    dive,
    stamp,
    stroke,
    selectionStyle,
    outline,
    hitTest,
    memory,
    settle,
    rotateFlip,
    get boundary() {
      return BOUNDARY;
    },
    get box() {
      return BOX;
    },
    get stats() {
      return stats;
    },
    get mode() {
      return MODE;
    },
    log,
  };
  window.__ready = true;
})();
