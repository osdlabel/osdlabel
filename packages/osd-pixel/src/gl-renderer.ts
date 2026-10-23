import type { DisplayTransform, GrayscaleRaster } from '@osdlabel/pixel';
import type { Mat3 } from './mat3.js';
import type { TextureFormat } from './gl-shaders.js';
import {
  FRAGMENT_FLOAT,
  FRAGMENT_R16I,
  FRAGMENT_R16UI,
  FRAGMENT_RG8,
  FRAGMENT_RGBA,
  VERTEX_SHADER,
} from './gl-shaders.js';

type ProgramKind = 'r16i' | 'r16ui' | 'float' | 'rg8' | 'rgba';

interface ProgramInfo {
  readonly program: WebGLProgram;
  readonly uniforms: Map<string, WebGLUniformLocation | null>;
}

/** A tile resident on the GPU. */
export interface TileTexture {
  readonly texture: WebGLTexture;
  readonly kind: ProgramKind;
  readonly width: number;
  readonly height: number;
  readonly bytes: number;
  /** Whether the stored values are signed (RG8 needs it to rebuild the word). */
  readonly signed: boolean;
  /** The smoothing the texture's sampler was created with (float formats only). */
  readonly linear: boolean;
}

/** Counters the benchmark reads. */
export interface RendererStats {
  uploads: number;
  uploadBytes: number;
  uploadMs: number;
  drawCalls: number;
  liveTextures: number;
  liveTextureBytes: number;
}

function compile(gl: WebGL2RenderingContext, type: number, src: string): WebGLShader {
  const s = gl.createShader(type);
  if (!s) throw new Error('createShader failed');
  gl.shaderSource(s, src);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS) && !gl.isContextLost()) {
    throw new Error(`shader compile failed: ${gl.getShaderInfoLog(s) ?? ''}`);
  }
  return s;
}

const UNIFORMS = [
  'u_matrix',
  'u_texScale',
  'u_tex',
  'u_slope',
  'u_intercept',
  'u_center',
  'u_width',
  'u_fn',
  'u_invert',
  'u_smooth',
  'u_opacity',
  'u_signed',
] as const;

const FN_INDEX = { LINEAR: 0, LINEAR_EXACT: 1, SIGMOID: 2 } as const;

/**
 * All GL state for one WebGL2 context: programs, the unit quad, and tile
 * texture upload. Rendering *targets* (own canvas, shared context, one page
 * canvas) sit on top of this; one renderer may serve many viewers.
 */
export class GlRenderer {
  readonly gl: WebGL2RenderingContext;
  readonly stats: RendererStats = {
    uploads: 0,
    uploadBytes: 0,
    uploadMs: 0,
    drawCalls: 0,
    liveTextures: 0,
    liveTextureBytes: 0,
  };
  /** Whether R32F / R16F can be sampled with LINEAR. */
  readonly floatLinear: boolean;
  private readonly _programs = new Map<ProgramKind, ProgramInfo>();
  private readonly _vao: WebGLVertexArrayObject;

  constructor(gl: WebGL2RenderingContext) {
    this.gl = gl;
    this.floatLinear = gl.getExtension('OES_texture_float_linear') !== null;
    const vao = gl.createVertexArray();
    const buf = gl.createBuffer();
    if (!vao || !buf) throw new Error('GL allocation failed');
    this._vao = vao;
    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(
      gl.ARRAY_BUFFER,
      new Float32Array([0, 1, 1, 1, 0, 0, 0, 0, 1, 1, 1, 0]),
      gl.STATIC_DRAW,
    );
    const sources: Record<ProgramKind, string> = {
      r16i: FRAGMENT_R16I,
      r16ui: FRAGMENT_R16UI,
      float: FRAGMENT_FLOAT,
      rg8: FRAGMENT_RG8,
      rgba: FRAGMENT_RGBA,
    };
    const vs = compile(gl, gl.VERTEX_SHADER, VERTEX_SHADER);
    for (const kind of Object.keys(sources) as ProgramKind[]) {
      const program = gl.createProgram();
      if (!program) throw new Error('createProgram failed');
      gl.attachShader(program, vs);
      gl.attachShader(program, compile(gl, gl.FRAGMENT_SHADER, sources[kind]));
      gl.bindAttribLocation(program, 0, 'a_pos');
      gl.linkProgram(program);
      if (!gl.getProgramParameter(program, gl.LINK_STATUS) && !gl.isContextLost()) {
        throw new Error(`link failed (${kind}): ${gl.getProgramInfoLog(program) ?? ''}`);
      }
      const uniforms = new Map<string, WebGLUniformLocation | null>();
      for (const u of UNIFORMS) uniforms.set(u, gl.getUniformLocation(program, u));
      this._programs.set(kind, { program, uniforms });
    }
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
  }

  /** Upload one tile's stored values in `format`. */
  uploadRaster(raster: GrayscaleRaster, format: TextureFormat, smooth: boolean): TileTexture {
    const gl = this.gl;
    const t0 = performance.now();
    const texture = gl.createTexture();
    if (!texture) throw new Error('createTexture failed');
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    const { width: w, height: h, data } = raster;
    const signed = data instanceof Int16Array;
    let kind: ProgramKind;
    let bytes: number;
    let linear = false;
    if (format === 'r32f' || format === 'r16f') {
      const f = new Float32Array(data.length);
      for (let i = 0; i < data.length; i++) f[i] = data[i]!;
      linear = smooth && (format === 'r16f' || this.floatLinear);
      const filter = linear ? gl.LINEAR : gl.NEAREST;
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
      const internal = format === 'r32f' ? gl.R32F : gl.R16F;
      gl.texImage2D(gl.TEXTURE_2D, 0, internal, w, h, 0, gl.RED, gl.FLOAT, f);
      kind = 'float';
      bytes = w * h * (format === 'r32f' ? 4 : 2);
    } else {
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      if (format === 'rg8') {
        const bytesView = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
        if (data instanceof Uint8Array) {
          throw new Error('rg8 needs 16-bit data');
        }
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RG8, w, h, 0, gl.RG, gl.UNSIGNED_BYTE, bytesView);
        kind = 'rg8';
      } else if (data instanceof Int16Array) {
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.R16I, w, h, 0, gl.RED_INTEGER, gl.SHORT, data);
        kind = 'r16i';
      } else if (data instanceof Uint16Array) {
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.R16UI, w, h, 0, gl.RED_INTEGER, gl.UNSIGNED_SHORT, data);
        kind = 'r16ui';
      } else {
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8UI, w, h, 0, gl.RED_INTEGER, gl.UNSIGNED_BYTE, data);
        kind = 'r16ui';
      }
      bytes = w * h * data.BYTES_PER_ELEMENT;
    }
    this._countUpload(bytes, t0);
    return { texture, kind, width: w, height: h, bytes, signed, linear };
  }

  /** Upload a stock tile's 8-bit canvas (what OSD's own drawers draw). */
  uploadCanvas(
    source: TexImageSource & { width: number; height: number },
    smooth: boolean,
  ): TileTexture {
    const gl = this.gl;
    const t0 = performance.now();
    const texture = gl.createTexture();
    if (!texture) throw new Error('createTexture failed');
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    const filter = smooth ? gl.LINEAR : gl.NEAREST;
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
    const bytes = source.width * source.height * 4;
    this._countUpload(bytes, t0);
    return {
      texture,
      kind: 'rgba',
      width: source.width,
      height: source.height,
      bytes,
      signed: false,
      linear: smooth,
    };
  }

  deleteTexture(t: TileTexture): void {
    this.gl.deleteTexture(t.texture);
    this.stats.liveTextures--;
    this.stats.liveTextureBytes -= t.bytes;
  }

  /**
   * Draw one tile quad. `matrix` maps the unit quad to clip space;
   * `texScale` trims texture padding (edge tiles).
   */
  drawTile(
    t: TileTexture,
    matrix: Mat3,
    texScale: readonly [number, number],
    display: DisplayTransform | null,
    smooth: boolean,
    opacity: number,
  ): void {
    const gl = this.gl;
    const info = this._programs.get(t.kind);
    if (!info) return;
    const u = (name: (typeof UNIFORMS)[number]): WebGLUniformLocation | null =>
      info.uniforms.get(name) ?? null;
    gl.useProgram(info.program);
    gl.bindVertexArray(this._vao);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, t.texture);
    gl.uniform1i(u('u_tex'), 0);
    gl.uniformMatrix3fv(u('u_matrix'), false, matrix);
    gl.uniform2f(u('u_texScale'), texScale[0], texScale[1]);
    gl.uniform1f(u('u_opacity'), opacity);
    if (t.kind !== 'rgba' && display) {
      gl.uniform1f(u('u_slope'), display.rescale.slope);
      gl.uniform1f(u('u_intercept'), display.rescale.intercept);
      gl.uniform1f(u('u_center'), display.window.center);
      gl.uniform1f(u('u_width'), display.window.width);
      gl.uniform1i(u('u_fn'), FN_INDEX[display.window.fn ?? 'LINEAR']);
      gl.uniform1i(u('u_invert'), display.invert ? 1 : 0);
      gl.uniform1i(u('u_smooth'), smooth ? 1 : 0);
      gl.uniform1i(u('u_signed'), t.signed ? 1 : 0);
    }
    gl.drawArrays(gl.TRIANGLES, 0, 6);
    this.stats.drawCalls++;
  }

  private _countUpload(bytes: number, t0: number): void {
    this.stats.uploads++;
    this.stats.uploadBytes += bytes;
    this.stats.uploadMs += performance.now() - t0;
    this.stats.liveTextures++;
    this.stats.liveTextureBytes += bytes;
  }
}
