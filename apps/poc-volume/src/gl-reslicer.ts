import type { PlaneIndexMapping } from '@osdlabel/spatial';
import type { ScalarVolume } from '@osdlabel/volume';

/**
 * GPU reslicing: the volume lives in one WebGL2 3D texture, and a plane is a
 * full-screen draw whose fragment shader maps output pixel -> voxel index with
 * the same {@link PlaneIndexMapping} the CPU reslicer uses, then windows to
 * grey. One context serves every MPR cell (they render in turn), so the cost
 * against the page's WebGL-context budget is 1 regardless of cell count.
 *
 * Texture formats:
 * - `r16i`: exact int16, no copy needed but integer textures cannot filter, so
 *   the shader does trilinear itself with 8 `texelFetch`es.
 * - `r16f`: half float, hardware trilinear; int16 HU above 2048 lose 1 HU of
 *   precision per doubling (2 HU steps at 2048-4095). Uploaded from float32.
 * - `r32f`: exact, hardware trilinear (needs OES_texture_float_linear), twice
 *   the memory.
 */
export type GlTextureFormat = 'r16i' | 'r16f' | 'r32f';

const VS = `#version 300 es
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

function fragmentShader(format: GlTextureFormat): string {
  const isInt = format === 'r16i';
  return `#version 300 es
precision highp float;
precision highp int;
precision highp ${isInt ? 'isampler3D' : 'sampler3D'};
uniform ${isInt ? 'isampler3D' : 'sampler3D'} uVol;
uniform vec3 uStart;
uniform vec3 uStepX;
uniform vec3 uStepY;
uniform vec3 uDims;
uniform vec2 uWindow; // (lo, 1/width)
uniform float uOutH;
uniform float uFlipY;
out vec4 frag;
void main() {
  vec2 px = floor(gl_FragCoord.xy);
  float row = uFlipY > 0.5 ? uOutH - 1.0 - px.y : px.y;
  vec3 idx = uStart + px.x * uStepX + row * uStepY;
  if (any(lessThan(idx, vec3(0.0))) || any(greaterThan(idx, uDims - 1.0))) {
    frag = vec4(0.0, 0.0, 0.0, 1.0);
    return;
  }
${
  isInt
    ? `  ivec3 i0 = min(ivec3(floor(idx)), ivec3(uDims) - 2);
  vec3 t = idx - vec3(i0);
  float c000 = float(texelFetch(uVol, i0, 0).r);
  float c100 = float(texelFetch(uVol, i0 + ivec3(1, 0, 0), 0).r);
  float c010 = float(texelFetch(uVol, i0 + ivec3(0, 1, 0), 0).r);
  float c110 = float(texelFetch(uVol, i0 + ivec3(1, 1, 0), 0).r);
  float c001 = float(texelFetch(uVol, i0 + ivec3(0, 0, 1), 0).r);
  float c101 = float(texelFetch(uVol, i0 + ivec3(1, 0, 1), 0).r);
  float c011 = float(texelFetch(uVol, i0 + ivec3(0, 1, 1), 0).r);
  float c111 = float(texelFetch(uVol, i0 + ivec3(1, 1, 1), 0).r);
  float v = mix(mix(mix(c000, c100, t.x), mix(c010, c110, t.x), t.y),
                mix(mix(c001, c101, t.x), mix(c011, c111, t.x), t.y), t.z);`
    : `  float v = texture(uVol, (idx + 0.5) / uDims).r;`
}
  float g = clamp((v - uWindow.x) * uWindow.y, 0.0, 1.0);
  frag = vec4(g, g, g, 1.0);
}`;
}

export interface UploadReport {
  readonly format: GlTextureFormat;
  readonly ms: number;
  readonly gpuBytes: number;
  /** Bytes of CPU staging allocated during the upload (float conversion buffers). */
  readonly stagingBytes: number;
  /** WebGL accepted a SharedArrayBuffer-backed view directly. */
  readonly sharedViewAccepted: boolean | null;
  readonly error: string | null;
}

export class GlReslicer {
  readonly canvas: HTMLCanvasElement;
  readonly gl: WebGL2RenderingContext;
  private program: WebGLProgram | null = null;
  private texture: WebGLTexture | null = null;
  private format: GlTextureFormat = 'r16i';
  private dims: readonly [number, number, number] = [0, 0, 0];
  private uniforms = new Map<string, WebGLUniformLocation | null>();

  constructor(maxWidth: number, maxHeight: number) {
    this.canvas = document.createElement('canvas');
    this.canvas.width = maxWidth;
    this.canvas.height = maxHeight;
    const gl = this.canvas.getContext('webgl2', {
      antialias: false,
      depth: false,
      preserveDrawingBuffer: true,
    });
    if (!gl) throw new Error('WebGL2 unavailable');
    this.gl = gl;
  }

  info(): Record<string, unknown> {
    const gl = this.gl;
    const dbg = gl.getExtension('WEBGL_debug_renderer_info');
    return {
      renderer: dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER),
      max3DTextureSize: gl.getParameter(gl.MAX_3D_TEXTURE_SIZE),
      maxTextureSize: gl.getParameter(gl.MAX_TEXTURE_SIZE),
      floatLinear: gl.getExtension('OES_texture_float_linear') !== null,
      norm16: gl.getExtension('EXT_texture_norm16') !== null,
    };
  }

  /** (Re)create the 3D texture in `format` and upload the volume slice by slice. */
  upload(volume: ScalarVolume, format: GlTextureFormat): UploadReport {
    const gl = this.gl;
    if (format === 'r32f') gl.getExtension('OES_texture_float_linear');
    this.dispose();
    const [nx, ny, nz] = volume.grid.dimensions;
    this.dims = [nx, ny, nz];
    this.format = format;
    const t0 = performance.now();
    let sharedViewAccepted: boolean | null = null;
    let stagingBytes = 0;
    let error: string | null = null;
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_3D, tex);
    const filter = format === 'r16i' ? gl.NEAREST : gl.LINEAR;
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MIN_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MAG_FILTER, filter);
    for (const p of [gl.TEXTURE_WRAP_S, gl.TEXTURE_WRAP_T, gl.TEXTURE_WRAP_R]) {
      gl.texParameteri(gl.TEXTURE_3D, p, gl.CLAMP_TO_EDGE);
    }
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    const internal = format === 'r16i' ? gl.R16I : format === 'r16f' ? gl.R16F : gl.R32F;
    gl.texStorage3D(gl.TEXTURE_3D, 1, internal, nx, ny, nz);
    try {
      if (format === 'r16i') {
        for (let k = 0; k < nz; k++) {
          const s = volume.slices[k]!;
          if (k === 0) {
            try {
              gl.texSubImage3D(gl.TEXTURE_3D, 0, 0, 0, 0, nx, ny, 1, gl.RED_INTEGER, gl.SHORT, s);
              sharedViewAccepted = true;
            } catch {
              sharedViewAccepted = false;
            }
            if (sharedViewAccepted) continue;
          }
          if (sharedViewAccepted === false) {
            const copy = new Int16Array(s);
            stagingBytes = copy.byteLength;
            gl.texSubImage3D(gl.TEXTURE_3D, 0, 0, 0, k, nx, ny, 1, gl.RED_INTEGER, gl.SHORT, copy);
          } else {
            gl.texSubImage3D(gl.TEXTURE_3D, 0, 0, 0, k, nx, ny, 1, gl.RED_INTEGER, gl.SHORT, s);
          }
        }
      } else {
        const staging = new Float32Array(nx * ny);
        stagingBytes = staging.byteLength;
        for (let k = 0; k < nz; k++) {
          staging.set(volume.slices[k]!);
          gl.texSubImage3D(gl.TEXTURE_3D, 0, 0, 0, k, nx, ny, 1, gl.RED, gl.FLOAT, staging);
        }
      }
      gl.finish();
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
    const glErr = gl.getError();
    if (glErr !== gl.NO_ERROR && !error) error = `GL error 0x${glErr.toString(16)}`;
    this.texture = tex;
    this.buildProgram(format);
    return {
      format,
      ms: performance.now() - t0,
      gpuBytes: nx * ny * nz * (format === 'r32f' ? 4 : 2),
      stagingBytes,
      sharedViewAccepted,
      error,
    };
  }

  private buildProgram(format: GlTextureFormat): void {
    const gl = this.gl;
    const compile = (type: number, src: string): WebGLShader => {
      const sh = gl.createShader(type)!;
      gl.shaderSource(sh, src);
      gl.compileShader(sh);
      if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
        throw new Error(gl.getShaderInfoLog(sh) ?? 'shader compile failed');
      }
      return sh;
    };
    const prog = gl.createProgram()!;
    gl.attachShader(prog, compile(gl.VERTEX_SHADER, VS));
    gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, fragmentShader(format)));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      throw new Error(gl.getProgramInfoLog(prog) ?? 'link failed');
    }
    this.program = prog;
    this.uniforms.clear();
    for (const u of ['uVol', 'uStart', 'uStepX', 'uStepY', 'uDims', 'uWindow', 'uOutH', 'uFlipY']) {
      this.uniforms.set(u, gl.getUniformLocation(prog, u));
    }
  }

  /**
   * Draw one plane into the lower-left `width x height` of the canvas.
   * `flipY` puts row 0 at the top of the canvas (for drawImage consumers);
   * without it row 0 is the first row readPixels returns.
   */
  render(
    m: PlaneIndexMapping,
    width: number,
    height: number,
    windowCenter: number,
    windowWidth: number,
    flipY: boolean,
  ): void {
    const gl = this.gl;
    if (!this.program || !this.texture) throw new Error('upload first');
    gl.useProgram(this.program);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_3D, this.texture);
    const u = (n: string): WebGLUniformLocation | null => this.uniforms.get(n) ?? null;
    gl.uniform1i(u('uVol'), 0);
    gl.uniform3f(u('uStart'), m.start[0], m.start[1], m.start[2]);
    gl.uniform3f(u('uStepX'), m.stepX[0], m.stepX[1], m.stepX[2]);
    gl.uniform3f(u('uStepY'), m.stepY[0], m.stepY[1], m.stepY[2]);
    gl.uniform3f(u('uDims'), this.dims[0], this.dims[1], this.dims[2]);
    gl.uniform2f(u('uWindow'), windowCenter - windowWidth / 2, 1 / windowWidth);
    gl.uniform1f(u('uOutH'), height);
    gl.uniform1f(u('uFlipY'), flipY ? 1 : 0);
    // With flipY the image must sit at the canvas TOP so drawImage(sx=0, sy=0) finds it.
    const y = flipY ? this.canvas.height - height : 0;
    gl.viewport(0, y, width, height);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  finish(): void {
    this.gl.finish();
  }

  /** Read the last `render(..., flipY = false)` back as row-major RGBA, row 0 first. */
  readPixels(width: number, height: number, out: Uint8Array): void {
    this.gl.readPixels(0, 0, width, height, this.gl.RGBA, this.gl.UNSIGNED_BYTE, out);
  }

  get currentFormat(): GlTextureFormat {
    return this.format;
  }

  dispose(): void {
    if (this.texture) this.gl.deleteTexture(this.texture);
    this.texture = null;
  }
}
