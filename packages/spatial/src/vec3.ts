/**
 * A point or direction in the patient frame, in millimetres.
 *
 * The frame is DICOM's patient coordinate system (LPS: +x towards the
 * patient's left, +y posterior, +z superior), but nothing here depends on the
 * handedness: every function is a plain Euclidean operation.
 */
export type Vec3 = readonly [number, number, number];

/** A 2D point in some image's pixel space. Structurally identical to `@osdlabel/annotation`'s `Point`. */
export interface Point2 {
  readonly x: number;
  readonly y: number;
}

export const vec3 = (x: number, y: number, z: number): Vec3 => [x, y, z] as const;

export const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];

export const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];

export const scale = (a: Vec3, s: number): Vec3 => [a[0] * s, a[1] * s, a[2] * s];

/** `a + b * s`, the workhorse of every parametric line / plane expression. */
export const addScaled = (a: Vec3, b: Vec3, s: number): Vec3 => [
  a[0] + b[0] * s,
  a[1] + b[1] * s,
  a[2] + b[2] * s,
];

export const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

export const cross = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];

export const length = (a: Vec3): number => Math.hypot(a[0], a[1], a[2]);

/** Unit vector along `a`. Throws on a zero vector: a direction must have one. */
export function normalize(a: Vec3): Vec3 {
  const l = length(a);
  if (l === 0 || !Number.isFinite(l)) throw new RangeError('cannot normalize a zero vector');
  return scale(a, 1 / l);
}

/**
 * Rotate `v` about the unit `axis` by `radians` (Rodrigues' formula).
 * Used to tilt an oblique plane about its in-plane axes.
 */
export function rotateAbout(v: Vec3, axis: Vec3, radians: number): Vec3 {
  const c = Math.cos(radians);
  const s = Math.sin(radians);
  const k = axis;
  const kxv = cross(k, v);
  const kdv = dot(k, v);
  return [
    v[0] * c + kxv[0] * s + k[0] * kdv * (1 - c),
    v[1] * c + kxv[1] * s + k[1] * kdv * (1 - c),
    v[2] * c + kxv[2] * s + k[2] * kdv * (1 - c),
  ];
}
