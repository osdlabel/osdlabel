import {
  orthogonalPlane,
  patientToIndex,
  type OrthogonalOrientation,
  type PlaneFrame,
  type Vec3,
  type VolumeGrid,
} from '@osdlabel/spatial';
import { createImageId, type ImageId } from '@osdlabel/viewer-api';

/**
 * Deterministic, reversible ImageIds for volume planes.
 *
 * Under the ImageId-per-plane model an annotation's bucket key IS its plane, so
 * the key must survive `serialize()` / `deserialize()` and a page reload: the
 * same plane must always produce the same id, and the id alone (plus the
 * series' grid for the short form) must give the plane back. Two forms:
 *
 * - `vol:<series>:<axial|coronal|sagittal>:<index>` when the plane is exactly
 *   `orthogonalPlane(grid, orientation, index)` for an integer slice index
 *   (default pixel spacing). Readable, and stable across sessions as long as
 *   the series' grid is: decoding needs that grid.
 * - `vol:<series>:f:<ox>,<oy>,<oz>;<rx>,<ry>,<rz>;<cx>,<cy>,<cz>;<sx>,<sy>;<w>x<h>;<t>`
 *   for every other plane (oblique, off-grid, non-default spacing): the
 *   DICOM-style frame itself, origin quantized to 1 µm, direction cosines to
 *   1e-6, spacing to 1e-6 mm and thickness to 1e-4 mm. It decodes with no grid
 *   and no host registry.
 *
 * `<series>` is URI-encoded so it may contain `:`. Encoding is canonical:
 * `planeImageId(parsePlaneImageId(id).plane)` returns `id` again, which is the
 * property a reload relies on (the viewer re-derives the id from the decoded
 * plane and lands on the same annotation bucket). Two frames that differ by
 * less than the quantum get the same id unless they straddle a rounding
 * boundary; frames produced by the same code path (scrolling, a stored
 * rotation) are bit-identical and never do.
 */
export type PlaneImageIdForm = 'orthogonal' | 'frame';

export interface ParsedPlaneImageId {
  readonly series: string;
  readonly plane: PlaneFrame;
  readonly form: PlaneImageIdForm;
  /** Set for the orthogonal form. */
  readonly orientation?: OrthogonalOrientation | undefined;
  /** Set for the orthogonal form. */
  readonly index?: number | undefined;
}

const PREFIX = 'vol';
const ORIENTATIONS: readonly OrthogonalOrientation[] = ['axial', 'coronal', 'sagittal'];
/** Index axis whose position an orthogonal plane fixes. */
const AXIS: Record<OrthogonalOrientation, number> = { sagittal: 0, coronal: 1, axial: 2 };
const DECIMALS = { position: 3, direction: 6, spacing: 6, thickness: 4 } as const;

function q(x: number, decimals: number): string {
  const f = 10 ** decimals;
  const r = Math.round(x * f) / f;
  return Object.is(r, -0) || r === 0 ? '0' : String(r);
}

const vec = (v: Vec3, d: number): string => `${q(v[0], d)},${q(v[1], d)},${q(v[2], d)}`;

function close(a: number, b: number, eps: number): boolean {
  return Math.abs(a - b) <= eps;
}

function sameFrame(a: PlaneFrame, b: PlaneFrame): boolean {
  const v = (x: Vec3, y: Vec3, eps: number): boolean =>
    close(x[0], y[0], eps) && close(x[1], y[1], eps) && close(x[2], y[2], eps);
  return (
    a.width === b.width &&
    a.height === b.height &&
    v(a.origin, b.origin, 1e-6) &&
    v(a.rowDirection, b.rowDirection, 1e-9) &&
    v(a.columnDirection, b.columnDirection, 1e-9) &&
    close(a.pixelSpacing.x, b.pixelSpacing.x, 1e-9) &&
    close(a.pixelSpacing.y, b.pixelSpacing.y, 1e-9) &&
    close(a.thickness, b.thickness, 1e-9)
  );
}

/** The orientation and integer slice index `plane` is on `grid`, if it is one of its orthogonal planes. */
export function matchOrthogonalPlane(
  grid: VolumeGrid,
  plane: PlaneFrame,
): { readonly orientation: OrthogonalOrientation; readonly index: number } | null {
  for (const orientation of ORIENTATIONS) {
    // The plane's pixel-(0,0) centre sits on the slice it fixes.
    const index = Math.round(patientToIndex(grid, plane.origin)[AXIS[orientation]]!);
    if (index < 0 || index >= grid.dimensions[AXIS[orientation]]!) continue;
    if (sameFrame(orthogonalPlane(grid, orientation, index), plane)) return { orientation, index };
  }
  return null;
}

function frameKey(f: PlaneFrame): string {
  return [
    vec(f.origin, DECIMALS.position),
    vec(f.rowDirection, DECIMALS.direction),
    vec(f.columnDirection, DECIMALS.direction),
    `${q(f.pixelSpacing.x, DECIMALS.spacing)},${q(f.pixelSpacing.y, DECIMALS.spacing)}`,
    `${f.width}x${f.height}`,
    q(f.thickness, DECIMALS.thickness),
  ].join(';');
}

/**
 * The ImageId of `plane` in `series`. Pass the series' `grid` to get the short
 * orthogonal form for grid-aligned slices; without it every plane gets the
 * frame form.
 */
export function planeImageId(series: string, plane: PlaneFrame, grid?: VolumeGrid): ImageId {
  const s = encodeURIComponent(series);
  const ortho = grid ? matchOrthogonalPlane(grid, plane) : null;
  if (ortho) return createImageId(`${PREFIX}:${s}:${ortho.orientation}:${ortho.index}`);
  return createImageId(`${PREFIX}:${s}:f:${frameKey(plane)}`);
}

function numbers(s: string, n: number): number[] | null {
  const parts = s.split(',');
  if (parts.length !== n) return null;
  const out = parts.map(Number);
  return out.every((x) => Number.isFinite(x)) ? out : null;
}

function parseFrame(key: string): PlaneFrame | null {
  const parts = key.split(';');
  if (parts.length !== 6) return null;
  const [o, r, c, sp, size, t] = parts as [string, string, string, string, string, string];
  const origin = numbers(o, 3);
  const row = numbers(r, 3);
  const col = numbers(c, 3);
  const spacing = numbers(sp, 2);
  const wh = /^(\d+)x(\d+)$/.exec(size);
  const thickness = Number(t);
  if (!origin || !row || !col || !spacing || !wh || !Number.isFinite(thickness)) return null;
  return {
    origin: [origin[0]!, origin[1]!, origin[2]!],
    rowDirection: [row[0]!, row[1]!, row[2]!],
    columnDirection: [col[0]!, col[1]!, col[2]!],
    pixelSpacing: { x: spacing[0]!, y: spacing[1]! },
    width: Number(wh[1]),
    height: Number(wh[2]),
    thickness,
  };
}

/**
 * Decode a plane ImageId. Returns `null` for ids that are not plane ids, and
 * for the orthogonal form when `gridOf` cannot supply the series' grid.
 */
export function parsePlaneImageId(
  id: ImageId | string,
  gridOf?: (series: string) => VolumeGrid | undefined,
): ParsedPlaneImageId | null {
  const first = id.indexOf(':');
  const second = first < 0 ? -1 : id.indexOf(':', first + 1);
  const third = second < 0 ? -1 : id.indexOf(':', second + 1);
  if (third < 0 || id.slice(0, first) !== PREFIX) return null;
  let series: string;
  try {
    series = decodeURIComponent(id.slice(first + 1, second));
  } catch {
    return null;
  }
  const kind = id.slice(second + 1, third);
  const rest = id.slice(third + 1);
  if (kind === 'f') {
    const plane = parseFrame(rest);
    return plane ? { series, plane, form: 'frame' } : null;
  }
  const orientation = ORIENTATIONS.find((o) => o === kind);
  if (!orientation || !/^\d+$/.test(rest)) return null;
  const grid = gridOf?.(series);
  if (!grid) return null;
  const index = Number(rest);
  if (index >= grid.dimensions[AXIS[orientation]]!) return null;
  return {
    series,
    plane: orthogonalPlane(grid, orientation, index),
    form: 'orthogonal',
    orientation,
    index,
  };
}
