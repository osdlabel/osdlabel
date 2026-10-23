import { GlRenderer } from './gl-renderer.js';

/**
 * Where a drawer's WebGL output goes, and therefore how many WebGL contexts a
 * grid of viewers costs:
 *
 * - `own`    one WebGL2 context per viewer, drawing straight into the drawer
 *            canvas. N cells = N contexts (Chrome keeps at most 16 live).
 * - `shared` one WebGL2 context (an OffscreenCanvas) for every viewer; each
 *            frame is rendered there, then copied into the cell's 2D canvas.
 *            N cells = 1 context + one GPU->canvas copy per drawn frame.
 * - `page`   one WebGL2 canvas fixed behind the whole page; each viewer
 *            scissors its own rectangle (Cornerstone3D-style). N cells = 1
 *            context, no copy, but the image is no longer inside the cell's
 *            DOM subtree (z-order, clipping and CSS filters stop applying).
 */
export type GlTargetKind = 'own' | 'shared' | 'page';

export interface GlTargetStats {
  contextLost: number;
  contextRestored: number;
  copyMs: number;
}

export interface GlTarget {
  readonly kind: GlTargetKind;
  /** `null` while the context is lost. */
  renderer(): GlRenderer | null;
  /** Bind and clear the region for a `width x height` device-pixel frame. */
  begin(width: number, height: number): boolean;
  /** Present the frame (copy for `shared`; nothing otherwise). */
  end(width: number, height: number): void;
  /** Called after a context restore so the drawer drops stale textures and redraws. */
  onReset(cb: () => void): void;
  release(): void;
  readonly stats: GlTargetStats;
}

const CONTEXT_ATTRS: WebGLContextAttributes = {
  alpha: true,
  premultipliedAlpha: true,
  antialias: false,
  depth: false,
  stencil: false,
};

function newStats(): GlTargetStats {
  return { contextLost: 0, contextRestored: 0, copyMs: 0 };
}

/** One context on the drawer's own canvas. */
export class OwnCanvasTarget implements GlTarget {
  readonly kind = 'own' as const;
  readonly stats = newStats();
  private _renderer: GlRenderer | null;
  private _reset: (() => void) | null = null;
  private readonly _canvas: HTMLCanvasElement;
  private readonly _onLost = (e: Event): void => {
    e.preventDefault(); // ask the browser to restore us later
    this._renderer = null;
    this.stats.contextLost++;
  };
  private readonly _onRestored = (): void => {
    const gl = this._canvas.getContext('webgl2', CONTEXT_ATTRS);
    this._renderer = gl ? new GlRenderer(gl) : null;
    this.stats.contextRestored++;
    this._reset?.();
  };

  constructor(canvas: HTMLCanvasElement) {
    this._canvas = canvas;
    const gl = canvas.getContext('webgl2', CONTEXT_ATTRS);
    if (!gl) throw new Error('WebGL2 unavailable');
    this._renderer = new GlRenderer(gl);
    canvas.addEventListener('webglcontextlost', this._onLost);
    canvas.addEventListener('webglcontextrestored', this._onRestored);
  }

  renderer(): GlRenderer | null {
    return this._renderer;
  }

  begin(width: number, height: number): boolean {
    const r = this._renderer;
    if (!r || r.gl.isContextLost()) return false;
    if (this._canvas.width !== width) this._canvas.width = width;
    if (this._canvas.height !== height) this._canvas.height = height;
    const gl = r.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, width, height);
    gl.disable(gl.SCISSOR_TEST);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    return true;
  }

  end(): void {}

  onReset(cb: () => void): void {
    this._reset = cb;
  }

  release(): void {
    this._canvas.removeEventListener('webglcontextlost', this._onLost);
    this._canvas.removeEventListener('webglcontextrestored', this._onRestored);
    // Free the context now instead of waiting for GC: this is what keeps a
    // destroyed cell from holding one of the page's 16 slots.
    this._renderer?.gl.getExtension('WEBGL_lose_context')?.loseContext();
    this._renderer = null;
  }
}

/** A refcounted singleton context shared by every `shared`/`page` drawer. */
interface Singleton<C> {
  canvas: C;
  renderer: GlRenderer | null;
  refs: number;
  resets: Set<() => void>;
  stats: GlTargetStats;
}

let sharedOffscreen: Singleton<OffscreenCanvas> | null = null;

function acquireShared(): Singleton<OffscreenCanvas> {
  if (!sharedOffscreen) {
    const canvas = new OffscreenCanvas(1, 1);
    const gl = canvas.getContext('webgl2', CONTEXT_ATTRS);
    if (!gl) throw new Error('WebGL2 unavailable');
    const s: Singleton<OffscreenCanvas> = {
      canvas,
      renderer: new GlRenderer(gl),
      refs: 0,
      resets: new Set(),
      stats: newStats(),
    };
    canvas.addEventListener('webglcontextlost', (e) => {
      e.preventDefault();
      s.renderer = null;
      s.stats.contextLost++;
    });
    canvas.addEventListener('webglcontextrestored', () => {
      const gl2 = canvas.getContext('webgl2', CONTEXT_ATTRS);
      s.renderer = gl2 ? new GlRenderer(gl2) : null;
      s.stats.contextRestored++;
      for (const r of s.resets) r();
    });
    sharedOffscreen = s;
  }
  sharedOffscreen.refs++;
  return sharedOffscreen;
}

/** Render in the shared context, then copy into this cell's 2D canvas. */
export class SharedContextTarget implements GlTarget {
  readonly kind = 'shared' as const;
  private readonly _s: Singleton<OffscreenCanvas>;
  private readonly _ctx: CanvasRenderingContext2D;
  private readonly _canvas: HTMLCanvasElement;
  private _reset: (() => void) | null = null;

  constructor(cellCanvas: HTMLCanvasElement) {
    this._s = acquireShared();
    this._canvas = cellCanvas;
    const ctx = cellCanvas.getContext('2d');
    if (!ctx) throw new Error('2d context unavailable');
    this._ctx = ctx;
  }

  get stats(): GlTargetStats {
    return this._s.stats;
  }

  renderer(): GlRenderer | null {
    return this._s.renderer;
  }

  begin(width: number, height: number): boolean {
    const r = this._s.renderer;
    if (!r || r.gl.isContextLost()) return false;
    const c = this._s.canvas;
    // Grow-only: resizing reallocates the backbuffer.
    if (c.width < width) c.width = width;
    if (c.height < height) c.height = height;
    if (this._canvas.width !== width) this._canvas.width = width;
    if (this._canvas.height !== height) this._canvas.height = height;
    const gl = r.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, width, height);
    gl.enable(gl.SCISSOR_TEST);
    gl.scissor(0, 0, width, height);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    return true;
  }

  end(width: number, height: number): void {
    const t0 = performance.now();
    const c = this._s.canvas;
    // GL's origin is bottom-left: the frame occupies the canvas's bottom rows.
    this._ctx.globalCompositeOperation = 'copy';
    this._ctx.drawImage(c, 0, c.height - height, width, height, 0, 0, width, height);
    this._s.stats.copyMs += performance.now() - t0;
  }

  onReset(cb: () => void): void {
    if (this._reset) this._s.resets.delete(this._reset);
    this._reset = cb;
    this._s.resets.add(cb);
  }

  release(): void {
    if (this._reset) this._s.resets.delete(this._reset);
    this._s.refs--;
    if (this._s.refs === 0) {
      this._s.renderer?.gl.getExtension('WEBGL_lose_context')?.loseContext();
      sharedOffscreen = null;
    }
  }
}

let pageCanvas: Singleton<HTMLCanvasElement> | null = null;

function acquirePage(): Singleton<HTMLCanvasElement> {
  if (!pageCanvas) {
    const canvas = document.createElement('canvas');
    canvas.dataset['osdlabel'] = 'page-gl-canvas';
    Object.assign(canvas.style, {
      position: 'fixed',
      left: '0',
      top: '0',
      width: '100vw',
      height: '100vh',
      pointerEvents: 'none',
      zIndex: '0',
    });
    document.body.prepend(canvas);
    const gl = canvas.getContext('webgl2', { ...CONTEXT_ATTRS, preserveDrawingBuffer: true });
    if (!gl) throw new Error('WebGL2 unavailable');
    pageCanvas = {
      canvas,
      renderer: new GlRenderer(gl),
      refs: 0,
      resets: new Set(),
      stats: newStats(),
    };
  }
  pageCanvas.refs++;
  return pageCanvas;
}

/** Scissor this cell's rectangle out of one page-wide canvas. */
export class PageCanvasTarget implements GlTarget {
  readonly kind = 'page' as const;
  private readonly _s: Singleton<HTMLCanvasElement>;
  private readonly _container: HTMLElement;
  private _reset: (() => void) | null = null;

  constructor(container: HTMLElement) {
    this._s = acquirePage();
    this._container = container;
  }

  get stats(): GlTargetStats {
    return this._s.stats;
  }

  renderer(): GlRenderer | null {
    return this._s.renderer;
  }

  begin(): boolean {
    const r = this._s.renderer;
    if (!r || r.gl.isContextLost()) return false;
    const dpr = window.devicePixelRatio || 1;
    const c = this._s.canvas;
    const pw = Math.round(window.innerWidth * dpr);
    const ph = Math.round(window.innerHeight * dpr);
    if (c.width !== pw || c.height !== ph) {
      c.width = pw;
      c.height = ph;
    }
    // Layout read per frame: the price of drawing outside the cell's subtree.
    const rect = this._container.getBoundingClientRect();
    const x = Math.round(rect.left * dpr);
    const w = Math.round(rect.width * dpr);
    const h = Math.round(rect.height * dpr);
    const y = ph - Math.round(rect.bottom * dpr);
    const gl = r.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(x, y, w, h);
    gl.enable(gl.SCISSOR_TEST);
    gl.scissor(x, y, w, h);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    return true;
  }

  end(): void {}

  onReset(cb: () => void): void {
    if (this._reset) this._s.resets.delete(this._reset);
    this._reset = cb;
    this._s.resets.add(cb);
  }

  release(): void {
    if (this._reset) this._s.resets.delete(this._reset);
    this._s.refs--;
    if (this._s.refs === 0) {
      this._s.renderer?.gl.getExtension('WEBGL_lose_context')?.loseContext();
      this._s.canvas.remove();
      pageCanvas = null;
    }
  }
}
