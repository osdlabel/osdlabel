/**
 * GLSL ES 3.00 programs for the VOI drawer. One vertex shader; one fragment
 * shader per way of storing 16-bit values in a texture.
 *
 * Every VOI fragment shader reconstructs the *stored* value (interpolating in
 * stored units, before any windowing, which is what makes zoomed-in edges
 * correct), applies the modality rescale, then the VOI function, in float.
 */

/** How a tile's stored values live on the GPU. */
export type TextureFormat =
  /** `R16I` / `R16UI`: exact, 2 B/px, not filterable: manual bilinear (4 texelFetch). */
  | 'r16i'
  /** `R32F`: exact up to 2^24, 4 B/px, filterable where OES_texture_float_linear exists. */
  | 'r32f'
  /** `R16F`: 2 B/px, filterable, but only 11 significant bits (inexact above 2048). */
  | 'r16f'
  /** `RG8` lo/hi bytes: 2 B/px, zero-copy upload from an Int16Array, manual bilinear. */
  | 'rg8';

export const VERTEX_SHADER = `#version 300 es
in vec2 a_pos;
uniform mat3 u_matrix;
uniform vec2 u_texScale;
out vec2 v_tex;
void main() {
  gl_Position = vec4((u_matrix * vec3(a_pos, 1.0)).xy, 0.0, 1.0);
  v_tex = a_pos * u_texScale;
}`;

const VOI_COMMON = `
uniform float u_slope;
uniform float u_intercept;
uniform float u_center;
uniform float u_width;
uniform int u_fn;       // 0 LINEAR, 1 LINEAR_EXACT, 2 SIGMOID
uniform bool u_invert;
uniform bool u_smooth;
uniform float u_opacity;
in vec2 v_tex;
out vec4 outColor;

float voi(float stored) {
  float x = stored * u_slope + u_intercept;
  float y;
  if (u_fn == 0) {
    float w = max(1.0, u_width);
    float lo = u_center - 0.5 - (w - 1.0) / 2.0;
    float hi = u_center - 0.5 + (w - 1.0) / 2.0;
    y = x <= lo ? 0.0 : (x > hi ? 1.0 : (x - (u_center - 0.5)) / (w - 1.0) + 0.5);
  } else if (u_fn == 1) {
    float w = max(1e-6, u_width);
    y = x <= u_center - w / 2.0 ? 0.0 : (x > u_center + w / 2.0 ? 1.0 : (x - u_center) / w + 0.5);
  } else {
    y = 1.0 / (1.0 + exp(-4.0 * (x - u_center) / max(1e-6, u_width)));
  }
  // Quantise like the CPU LUT (round to 8 bits) so both paths match exactly.
  y = floor(y * 255.0 + 0.5) / 255.0;
  return u_invert ? 1.0 - y : y;
}

void emit(float stored) {
  float g = voi(stored) * u_opacity;
  outColor = vec4(g, g, g, u_opacity);
}
`;

/** Manual bilinear over a texelFetch-able sampler; `FETCH(ivec2)` returns a float. */
const MANUAL_BILINEAR = `
float sampleStored() {
  ivec2 size = textureSize(u_tex, 0);
  vec2 p = v_tex * vec2(size);
  if (!u_smooth) {
    return FETCH(clamp(ivec2(floor(p)), ivec2(0), size - 1));
  }
  p -= 0.5;
  ivec2 i0 = ivec2(floor(p));
  vec2 f = p - floor(p);
  ivec2 hi = size - 1;
  float a = FETCH(clamp(i0, ivec2(0), hi));
  float b = FETCH(clamp(i0 + ivec2(1, 0), ivec2(0), hi));
  float c = FETCH(clamp(i0 + ivec2(0, 1), ivec2(0), hi));
  float d = FETCH(clamp(i0 + ivec2(1, 1), ivec2(0), hi));
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}
`;

export const FRAGMENT_R16I = `#version 300 es
precision highp float;
precision highp int;
precision highp isampler2D;
uniform isampler2D u_tex;
${VOI_COMMON}
#define FETCH(ij) float(texelFetch(u_tex, ij, 0).r)
${MANUAL_BILINEAR}
void main() { emit(sampleStored()); }`;

export const FRAGMENT_R16UI = `#version 300 es
precision highp float;
precision highp int;
precision highp usampler2D;
uniform usampler2D u_tex;
${VOI_COMMON}
#define FETCH(ij) float(texelFetch(u_tex, ij, 0).r)
${MANUAL_BILINEAR}
void main() { emit(sampleStored()); }`;

/** R32F / R16F: the hardware filters (LINEAR or NEAREST set on the texture). */
export const FRAGMENT_FLOAT = `#version 300 es
precision highp float;
precision highp sampler2D;
uniform sampler2D u_tex;
${VOI_COMMON}
void main() { emit(texture(u_tex, v_tex).r); }`;

/** RG8: rebuild the 16-bit word from two bytes; u_signed restores two's complement. */
export const FRAGMENT_RG8 = `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;
uniform sampler2D u_tex;
uniform bool u_signed;
${VOI_COMMON}
float word(ivec2 ij) {
  vec2 lh = texelFetch(u_tex, ij, 0).rg * 255.0;
  float v = floor(lh.x + 0.5) + floor(lh.y + 0.5) * 256.0;
  return (u_signed && v >= 32768.0) ? v - 65536.0 : v;
}
#define FETCH(ij) word(ij)
${MANUAL_BILINEAR}
void main() { emit(sampleStored()); }`;

/** Stock 8-bit RGBA tiles (any OSD tile source): no VOI, premultiplied output. */
export const FRAGMENT_RGBA = `#version 300 es
precision highp float;
uniform sampler2D u_tex;
uniform float u_opacity;
in vec2 v_tex;
out vec4 outColor;
void main() { outColor = texture(u_tex, v_tex) * u_opacity; }`;
