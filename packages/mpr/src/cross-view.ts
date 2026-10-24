import type { Geometry, Point } from '@osdlabel/annotation';
import type {
  Decoration,
  DecorationProvider,
  LineDecorationStyle,
  TextDecorationStyle,
} from '@osdlabel/decoration';
import {
  circleZeroChord,
  clipSegmentToImage,
  distanceField,
  evaluateField,
  isParallelField,
  polygonZeroSegments,
  polylineZeroCrossings,
  transferPoint,
  type DistanceField,
  type PlaneFrame,
  type Segment2,
} from '@osdlabel/spatial';
import type { PlanarAnnotation } from './plane-fields.js';

/** What an annotation from another plane looks like in a view. */
export type Projection =
  | { readonly kind: 'marker'; readonly at: Point }
  | { readonly kind: 'segment'; readonly segment: Segment2 };

const CIRCLE_OUTLINE_VERTICES = 48;
const DEG = Math.PI / 180;

/** Closed outline (vertices in order) of an area geometry, or `null` for the others. */
function outlineOf(g: Geometry): readonly Point[] | null {
  switch (g.type) {
    case 'polygon':
      return g.points;
    case 'rectangle': {
      const c = Math.cos(g.rotation * DEG);
      const s = Math.sin(g.rotation * DEG);
      return [
        [0, 0],
        [g.width, 0],
        [g.width, g.height],
        [0, g.height],
      ].map(([x, y]) => ({
        x: g.origin.x + x! * c - y! * s,
        y: g.origin.y + x! * s + y! * c,
      }));
    }
    case 'circle': {
      const out: Point[] = [];
      for (let i = 0; i < CIRCLE_OUTLINE_VERTICES; i++) {
        const t = (i / CIRCLE_OUTLINE_VERTICES) * 2 * Math.PI;
        out.push({
          x: g.center.x + g.radius * Math.cos(t),
          y: g.center.y + g.radius * Math.sin(t),
        });
      }
      return out;
    }
    default:
      return null;
  }
}

/** Polyline vertices of the open (or closed, for areas) shape. */
function verticesOf(g: Geometry): { readonly points: readonly Point[]; readonly closed: boolean } {
  switch (g.type) {
    case 'point':
      return { points: [g.position], closed: false };
    case 'line':
      return { points: [g.start, g.end], closed: false };
    case 'polyline':
      return { points: g.points, closed: false };
    case 'mask':
      return { points: [], closed: false };
    default:
      return { points: outlineOf(g) ?? [], closed: true };
  }
}

/**
 * Project one annotation drawn on `source` into `view`'s image space.
 *
 * - A point shows as a marker when the view passes within `tolerance` mm of it
 *   (default: half the view's slab thickness).
 * - Lines and polylines cross a non-parallel view at points (markers).
 * - Areas (polygon, rectangle, circle) cut a non-parallel view in segments;
 *   a concave polygon can yield several.
 * - Content in a parallel plane within tolerance is drawn as its outline.
 * - Masks are skipped: raster labels are resliced, not projected.
 */
export function projectGeometry(
  geometry: Geometry,
  source: PlaneFrame,
  view: PlaneFrame,
  tolerance = view.thickness / 2,
): Projection[] {
  if (geometry.type === 'mask') return [];
  const f: DistanceField = distanceField(source, view);
  const toView = (p: Point): Point => transferPoint(source, view, p);
  const seg = (a: Point, b: Point): Projection[] => {
    const s = clipSegmentToImage({ start: toView(a), end: toView(b) }, view);
    return s ? [{ kind: 'segment', segment: s }] : [];
  };

  if (isParallelField(f)) {
    if (Math.abs(f.d0) > tolerance) return [];
    const { points, closed } = verticesOf(geometry);
    if (points.length === 1) return [{ kind: 'marker', at: toView(points[0]!) }];
    const out: Projection[] = [];
    const edges = closed ? points.length : points.length - 1;
    for (let i = 0; i < edges; i++) out.push(...seg(points[i]!, points[(i + 1) % points.length]!));
    return out;
  }

  switch (geometry.type) {
    case 'point':
      return Math.abs(evaluateField(f, geometry.position)) <= tolerance
        ? [{ kind: 'marker', at: toView(geometry.position) }]
        : [];
    case 'line':
    case 'polyline': {
      const pts = geometry.type === 'line' ? [geometry.start, geometry.end] : geometry.points;
      return polylineZeroCrossings(pts, f).map((p) => ({ kind: 'marker', at: toView(p) }));
    }
    case 'circle': {
      const chord = circleZeroChord(geometry.center, geometry.radius, f);
      return chord ? seg(chord.start, chord.end) : [];
    }
    case 'polygon':
    case 'rectangle': {
      const outline = outlineOf(geometry)!;
      return polygonZeroSegments(outline, f).flatMap((s) => seg(s.start, s.end));
    }
  }
}

export interface CrossViewStyle {
  readonly line?: LineDecorationStyle | undefined;
  readonly marker?: TextDecorationStyle | undefined;
  /** Glyph used for point markers. Default `'+'`. */
  readonly markerText?: string | undefined;
}

/**
 * Decorations for annotations drawn on other planes, in `view`'s image space:
 * `LineDecoration`s for cut segments, centred `TextDecoration` glyphs for
 * markers. Ids are `xv:<annotationId>:<n>`, stable across recomputation as
 * long as the projection's shape does not change.
 */
export function projectAnnotations(
  annotations: readonly PlanarAnnotation[],
  view: PlaneFrame,
  style?: CrossViewStyle,
): Decoration[] {
  const out: Decoration[] = [];
  for (const a of annotations) {
    const projections = projectGeometry(a.geometry, a.plane, view);
    let n = 0;
    for (const p of projections) {
      const id = `xv:${a.id}:${n++}`;
      if (p.kind === 'segment') {
        out.push({
          type: 'line',
          id,
          relatedAnnotationIds: [a.id],
          start: p.segment.start,
          end: p.segment.end,
          ...(style?.line !== undefined ? { style: style.line } : {}),
        });
      } else {
        out.push({
          type: 'text',
          id,
          relatedAnnotationIds: [a.id],
          text: style?.markerText ?? '+',
          anchor: p.at,
          placement: 'center',
          ...(style?.marker !== undefined ? { style: style.marker } : {}),
        });
      }
    }
  }
  return out;
}

/**
 * A plain osdlabel `DecorationProvider` showing another plane's annotations.
 *
 * It reads its inputs through accessors instead of `ctx.annotations`: the
 * decoration context carries the cell's own annotations, and the whole point
 * here is to show the *other* cells' ones. The cell re-runs it whenever the
 * view plane or the shared annotation set changes.
 */
export function createCrossViewProvider<E extends object = Record<never, never>>(
  getView: () => PlaneFrame,
  getForeignAnnotations: () => readonly PlanarAnnotation[],
  style?: CrossViewStyle,
): DecorationProvider<E> {
  return () => projectAnnotations(getForeignAnnotations(), getView(), style);
}
