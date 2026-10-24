/**
 * Device-independent GPU memory accounting: wrap the WebGL calls that
 * allocate texture, buffer and renderbuffer storage and keep the bytes each
 * live object holds, from its dimensions and internal format. This counts
 * what a page asks the GPU for, independent of how a driver (SwiftShader
 * here) backs it — unlike GPU-process PSS. Default framebuffers (the canvas
 * drawing buffers) and driver-side staging copies are not included.
 *
 * Install before any context is created; prototypes are patched, so every
 * context created later on this page is counted.
 */

/** Bytes per texel of the sized internal formats WebGL2 accepts (plus norm16). */
const SIZED: Record<number, readonly [string, number]> = {
  0x8229: ['R8', 1],
  0x8f94: ['R8_SNORM', 1],
  0x8231: ['R8I', 1],
  0x8232: ['R8UI', 1],
  0x822a: ['R16_EXT', 2],
  0x8233: ['R16I', 2],
  0x8234: ['R16UI', 2],
  0x822d: ['R16F', 2],
  0x8235: ['R32I', 4],
  0x8236: ['R32UI', 4],
  0x822e: ['R32F', 4],
  0x822b: ['RG8', 2],
  0x8237: ['RG8I', 2],
  0x8238: ['RG8UI', 2],
  0x822f: ['RG16F', 4],
  0x8230: ['RG32F', 8],
  0x8051: ['RGB8', 3],
  0x8d62: ['RGB565', 2],
  0x8c3a: ['R11F_G11F_B10F', 4],
  0x881b: ['RGB16F', 6],
  0x8815: ['RGB32F', 12],
  0x8058: ['RGBA8', 4],
  0x8c43: ['SRGB8_ALPHA8', 4],
  0x8056: ['RGBA4', 2],
  0x8057: ['RGB5_A1', 2],
  0x8059: ['RGB10_A2', 4],
  0x8d7c: ['RGBA8UI', 4],
  0x8d8e: ['RGBA8I', 4],
  0x8d76: ['RGBA16UI', 8],
  0x8d88: ['RGBA16I', 8],
  0x881a: ['RGBA16F', 8],
  0x8d70: ['RGBA32UI', 16],
  0x8d82: ['RGBA32I', 16],
  0x8814: ['RGBA32F', 16],
  0x81a5: ['DEPTH_COMPONENT16', 2],
  0x81a6: ['DEPTH_COMPONENT24', 4],
  0x8cac: ['DEPTH_COMPONENT32F', 4],
  0x88f0: ['DEPTH24_STENCIL8', 4],
  0x8cad: ['DEPTH32F_STENCIL8', 8],
  0x8d48: ['STENCIL_INDEX8', 1],
};

/** Unsized formats (WebGL1 style): channels; bytes come from the type. */
const UNSIZED: Record<number, readonly [string, number]> = {
  0x1906: ['ALPHA', 1],
  0x1909: ['LUMINANCE', 1],
  0x190a: ['LUMINANCE_ALPHA', 2],
  0x1907: ['RGB', 3],
  0x1908: ['RGBA', 4],
  0x1902: ['DEPTH_COMPONENT', 1],
  0x84f9: ['DEPTH_STENCIL', 1],
};

const TYPE_BYTES: Record<number, number> = {
  0x1400: 1, // BYTE
  0x1401: 1, // UNSIGNED_BYTE
  0x1402: 2, // SHORT
  0x1403: 2, // UNSIGNED_SHORT
  0x1404: 4, // INT
  0x1405: 4, // UNSIGNED_INT
  0x1406: 4, // FLOAT
  0x140b: 2, // HALF_FLOAT
  0x8d61: 2, // HALF_FLOAT_OES
};
const PACKED_TYPES = new Set([0x8363, 0x8033, 0x8034, 0x84fa, 0x8368, 0x8c3b, 0x8c3e]);

function texelBytes(internalformat: number, type?: number): readonly [string, number] {
  const sized = SIZED[internalformat];
  if (sized) return sized;
  const unsized = UNSIZED[internalformat];
  if (unsized) {
    if (type !== undefined && PACKED_TYPES.has(type)) return [`${unsized[0]}/packed`, 2];
    const tb = type !== undefined ? (TYPE_BYTES[type] ?? 1) : 1;
    return [`${unsized[0]}/${tb * 8}bit`, unsized[1] * tb];
  }
  return [`0x${internalformat.toString(16)}`, 4];
}

interface Allocation {
  readonly kind: 'texture' | 'buffer' | 'renderbuffer';
  readonly format: string;
  bytes: number;
}

export interface GlMemorySnapshot {
  /** Bytes held by live textures, buffers and renderbuffers. */
  readonly liveBytes: number;
  readonly peakBytes: number;
  readonly byKind: Record<string, number>;
  /** Live bytes by internal format (textures and renderbuffers) or 'buffer'. */
  readonly byFormat: Record<string, number>;
  /** Every 3D/array texture allocation seen, in order (dims and format). */
  readonly volumeTextures: readonly string[];
}

export interface GlMemoryTracker {
  readonly snapshot: () => GlMemorySnapshot;
}

const TEXTURE_BINDING_TARGET: Record<number, number> = {
  0x0de1: 0x0de1, // TEXTURE_2D
  0x806f: 0x806f, // TEXTURE_3D
  0x8c1a: 0x8c1a, // TEXTURE_2D_ARRAY
  0x8513: 0x8513, // TEXTURE_CUBE_MAP
  0x8515: 0x8513,
  0x8516: 0x8513,
  0x8517: 0x8513,
  0x8518: 0x8513,
  0x8519: 0x8513,
  0x851a: 0x8513,
};

type GL = WebGLRenderingContext | WebGL2RenderingContext;
type Proto = Record<string, unknown>;

export function installGlMemoryTracker(): GlMemoryTracker {
  // Per object: allocation per level/face key.
  const objects = new Map<object, Map<string, Allocation>>();
  const state = new WeakMap<
    GL,
    {
      unit: number;
      textures: Map<string, WebGLTexture | null>;
      buffers: Map<number, WebGLBuffer | null>;
      renderbuffer: WebGLRenderbuffer | null;
    }
  >();
  const volumeTextures: string[] = [];
  let live = 0;
  let peak = 0;
  const st = (gl: GL) => {
    let s = state.get(gl);
    if (!s) {
      s = { unit: 0x84c0, textures: new Map(), buffers: new Map(), renderbuffer: null };
      state.set(gl, s);
    }
    return s;
  };
  const record = (obj: object | null | undefined, key: string, a: Allocation): void => {
    if (!obj) return;
    let m = objects.get(obj);
    if (!m) {
      m = new Map();
      objects.set(obj, m);
    }
    live -= m.get(key)?.bytes ?? 0;
    m.set(key, a);
    live += a.bytes;
    if (live > peak) peak = live;
  };
  const release = (obj: object | null | undefined): void => {
    if (!obj) return;
    const m = objects.get(obj);
    if (!m) return;
    for (const a of m.values()) live -= a.bytes;
    objects.delete(obj);
  };
  const boundTexture = (gl: GL, target: number): WebGLTexture | null => {
    const s = st(gl);
    return s.textures.get(`${s.unit}:${TEXTURE_BINDING_TARGET[target] ?? target}`) ?? null;
  };

  const patch = (proto: Proto, name: string, after: (gl: GL, args: unknown[]) => void): void => {
    const original = proto[name];
    if (typeof original !== 'function') return;
    proto[name] = function (this: GL, ...args: unknown[]) {
      const r = (original as (...a: unknown[]) => unknown).apply(this, args);
      try {
        after(this, args);
      } catch {
        // Accounting must never break the page.
      }
      return r;
    };
  };

  const protos: Proto[] = [];
  if (typeof WebGLRenderingContext !== 'undefined')
    protos.push(WebGLRenderingContext.prototype as unknown as Proto);
  if (typeof WebGL2RenderingContext !== 'undefined')
    protos.push(WebGL2RenderingContext.prototype as unknown as Proto);

  for (const proto of protos) {
    patch(proto, 'activeTexture', (gl, [unit]) => {
      st(gl).unit = unit as number;
    });
    patch(proto, 'bindTexture', (gl, [target, tex]) => {
      const s = st(gl);
      s.textures.set(`${s.unit}:${target as number}`, (tex as WebGLTexture | null) ?? null);
    });
    patch(proto, 'deleteTexture', (_gl, [tex]) => release(tex as object | null));
    patch(proto, 'texImage2D', (gl, args) => {
      const target = args[0] as number;
      const level = args[1] as number;
      const internalformat = args[2] as number;
      let w: number;
      let h: number;
      let type: number;
      if (args.length === 6) {
        // (target, level, internalformat, format, type, source)
        type = args[4] as number;
        const src = args[5] as {
          width?: number;
          height?: number;
          videoWidth?: number;
          videoHeight?: number;
        };
        w = src.videoWidth ?? src.width ?? 0;
        h = src.videoHeight ?? src.height ?? 0;
      } else {
        w = args[3] as number;
        h = args[4] as number;
        type = args[7] as number;
      }
      const [format, bpt] = texelBytes(internalformat, type);
      record(boundTexture(gl, target), `${target}:${level}`, {
        kind: 'texture',
        format,
        bytes: w * h * bpt,
      });
    });
    patch(proto, 'texImage3D', (gl, args) => {
      const [target, level, internalformat, w, h, d] = args as number[];
      const type = args[8] as number;
      const [format, bpt] = texelBytes(internalformat!, type);
      volumeTextures.push(`texImage3D ${w}x${h}x${d} ${format} level ${level}`);
      record(boundTexture(gl, target!), `${target}:${level}`, {
        kind: 'texture',
        format,
        bytes: w! * h! * d! * bpt,
      });
    });
    patch(proto, 'texStorage2D', (gl, args) => {
      const [target, levels, internalformat, w, h] = args as number[];
      const [format, bpt] = texelBytes(internalformat!);
      const faces = target === 0x8513 ? 6 : 1;
      let bytes = 0;
      for (let l = 0; l < levels!; l++) bytes += Math.max(1, w! >> l) * Math.max(1, h! >> l) * bpt;
      record(boundTexture(gl, target!), 'storage', {
        kind: 'texture',
        format,
        bytes: bytes * faces,
      });
    });
    patch(proto, 'texStorage3D', (gl, args) => {
      const [target, levels, internalformat, w, h, d] = args as number[];
      const [format, bpt] = texelBytes(internalformat!);
      const is3D = target === 0x806f;
      let bytes = 0;
      for (let l = 0; l < levels!; l++) {
        const dl = is3D ? Math.max(1, d! >> l) : d!;
        bytes += Math.max(1, w! >> l) * Math.max(1, h! >> l) * dl * bpt;
      }
      volumeTextures.push(
        `texStorage3D ${is3D ? '3D' : '2D_ARRAY'} ${w}x${h}x${d} ${format} levels ${levels}`,
      );
      record(boundTexture(gl, target!), 'storage', { kind: 'texture', format, bytes });
    });
    patch(proto, 'bindBuffer', (gl, [target, buf]) => {
      st(gl).buffers.set(target as number, (buf as WebGLBuffer | null) ?? null);
    });
    patch(proto, 'deleteBuffer', (_gl, [buf]) => release(buf as object | null));
    patch(proto, 'bufferData', (gl, args) => {
      const target = args[0] as number;
      const data = args[1];
      let bytes = 0;
      if (typeof data === 'number') bytes = data;
      else if (ArrayBuffer.isView(data)) {
        const view = data as ArrayBufferView & { BYTES_PER_ELEMENT?: number };
        const per = view.BYTES_PER_ELEMENT ?? 1;
        const offset = (args[3] as number | undefined) ?? 0;
        const length = args[4] as number | undefined;
        bytes = length ? length * per : view.byteLength - offset * per;
      } else if (data instanceof ArrayBuffer || data instanceof SharedArrayBuffer) {
        bytes = data.byteLength;
      }
      record(st(gl).buffers.get(target) ?? null, 'data', {
        kind: 'buffer',
        format: 'buffer',
        bytes,
      });
    });
    patch(proto, 'bindRenderbuffer', (gl, [, rb]) => {
      st(gl).renderbuffer = (rb as WebGLRenderbuffer | null) ?? null;
    });
    patch(proto, 'deleteRenderbuffer', (_gl, [rb]) => release(rb as object | null));
    patch(proto, 'renderbufferStorage', (gl, args) => {
      const [, internalformat, w, h] = args as number[];
      const [format, bpt] = texelBytes(internalformat!);
      record(st(gl).renderbuffer, 'storage', {
        kind: 'renderbuffer',
        format,
        bytes: w! * h! * bpt,
      });
    });
    patch(proto, 'renderbufferStorageMultisample', (gl, args) => {
      const [, samples, internalformat, w, h] = args as number[];
      const [format, bpt] = texelBytes(internalformat!);
      record(st(gl).renderbuffer, 'storage', {
        kind: 'renderbuffer',
        format: `${format}x${samples}`,
        bytes: w! * h! * bpt * Math.max(1, samples!),
      });
    });
  }

  return {
    snapshot: () => {
      const byKind: Record<string, number> = {};
      const byFormat: Record<string, number> = {};
      for (const m of objects.values())
        for (const a of m.values()) {
          byKind[a.kind] = (byKind[a.kind] ?? 0) + a.bytes;
          byFormat[a.format] = (byFormat[a.format] ?? 0) + a.bytes;
        }
      return {
        liveBytes: live,
        peakBytes: peak,
        byKind,
        byFormat,
        volumeTextures: [...volumeTextures],
      };
    },
  };
}
