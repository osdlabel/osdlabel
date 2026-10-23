/**
 * 3x3 matrices in OpenSeadragon's `Mat3` convention: column-major values
 * (what `uniformMatrix3fv(…, false, …)` expects), `a.multiply(b)` = `a * b`.
 *
 * Re-implemented rather than borrowed from `OpenSeadragon.Mat3` because that
 * class is untyped in `@types/openseadragon`; keeping the exact convention is
 * what makes this drawer's output geometrically identical to OSD's own
 * `WebGLDrawer`, and therefore to the Fabric overlay that tracks OSD.
 */
export type Mat3 = readonly [
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
];

export function translation(tx: number, ty: number): Mat3 {
  return [1, 0, 0, 0, 1, 0, tx, ty, 1];
}

export function scaling(sx: number, sy: number): Mat3 {
  return [sx, 0, 0, 0, sy, 0, 0, 0, 1];
}

/** Same sign convention as `OpenSeadragon.Mat3.makeRotation`. */
export function rotation(angleInRadians: number): Mat3 {
  const c = Math.cos(angleInRadians);
  const s = Math.sin(angleInRadians);
  return [c, -s, 0, s, c, 0, 0, 0, 1];
}

export function multiply(a: Mat3, b: Mat3): Mat3 {
  const [a00, a01, a02, a10, a11, a12, a20, a21, a22] = a;
  const [b00, b01, b02, b10, b11, b12, b20, b21, b22] = b;
  return [
    b00 * a00 + b01 * a10 + b02 * a20,
    b00 * a01 + b01 * a11 + b02 * a21,
    b00 * a02 + b01 * a12 + b02 * a22,
    b10 * a00 + b11 * a10 + b12 * a20,
    b10 * a01 + b11 * a11 + b12 * a21,
    b10 * a02 + b11 * a12 + b12 * a22,
    b20 * a00 + b21 * a10 + b22 * a20,
    b20 * a01 + b21 * a11 + b22 * a21,
    b20 * a02 + b21 * a12 + b22 * a22,
  ];
}

/** Apply to a 2D point (homogeneous w = 1). */
export function transformPoint(m: Mat3, x: number, y: number): { x: number; y: number } {
  return { x: m[0] * x + m[3] * y + m[6], y: m[1] * x + m[4] * y + m[7] };
}

/**
 * OSD's view matrix: viewport coordinates -> clip space. Identical to the
 * one `OpenSeadragon.WebGLDrawer.draw` builds.
 */
export function viewMatrix(
  bounds: { x: number; y: number; width: number; height: number },
  rotationDegrees: number,
  flipped: boolean,
): Mat3 {
  const cx = bounds.x + bounds.width / 2;
  const cy = bounds.y + bounds.height / 2;
  const flip = flipped ? -1 : 1;
  const pos = translation(-cx, -cy);
  const scale = scaling((2 / bounds.width) * flip, -2 / bounds.height);
  const rot = rotation((-rotationDegrees * Math.PI) / 180);
  return multiply(multiply(scale, rot), pos);
}

/** A tile's unit quad -> its viewport rectangle. */
export function tileMatrix(x: number, y: number, w: number, h: number): Mat3 {
  return [w, 0, 0, 0, h, 0, x, y, 1];
}
