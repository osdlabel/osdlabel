import type { Annotation, BaseAnnotation, Geometry, Point } from '@osdlabel/annotation';
import type { PixelSpacing } from '@osdlabel/viewer-api';
import type {
  Decoration,
  LineDecoration,
  LineDecorationStyle,
  TextDecoration,
  TextDecorationStyle,
  TextPlacement,
} from './decoration.js';
import type { DecorationProvider } from './provider.js';
import * as geom from './geometry-math.js';
import {
  formatMeasurement,
  toPhysicalArea,
  toPhysicalLength,
  type FormatMeasurementOptions,
  type Measurement,
} from './measurement.js';

// ── createMeasurementProvider ──────────────────────────────────────────────

/** Which measurements to render. All flags default to `false`. */
export interface MeasurementProviderOptions {
  readonly area?: boolean | undefined;
  readonly perimeter?: boolean | undefined;
  readonly length?: boolean | undefined;
  readonly radius?: boolean | undefined;
  readonly format?: FormatMeasurementOptions | undefined;
  /** Custom formatter; receives the metric label and the value+unit. */
  readonly formatLine?: ((label: string, measurement: Measurement) => string) | undefined;
  /** Style applied to the rendered text labels. */
  readonly style?: TextDecorationStyle | undefined;
}

/**
 * A provider that renders one text label per visible annotation containing
 * the requested geometric measurements. Anchors and placement are chosen
 * automatically per geometry type.
 */
export function createMeasurementProvider<E extends object = Record<string, never>>(
  options: MeasurementProviderOptions,
): DecorationProvider<E> {
  return ({ annotations, pixelSpacing }) => {
    const decorations: Decoration[] = [];
    for (const ann of annotations) {
      const lines = computeMeasurementLines(ann.geometry, options, pixelSpacing);
      if (lines.length === 0) continue;
      const placement = anchorPlacementFor(ann.geometry);
      const decoration: TextDecoration = {
        id: `measurement:${ann.id}`,
        type: 'text',
        relatedAnnotationIds: [ann.id],
        text: lines.join('\n'),
        anchor: placement.anchor,
        ...(placement.offset !== undefined ? { offset: placement.offset } : {}),
        placement: placement.placement,
        ...(options.style !== undefined ? { style: options.style } : {}),
      };
      decorations.push(decoration);
    }
    return decorations;
  };
}

function computeMeasurementLines(
  geometry: Geometry,
  options: MeasurementProviderOptions,
  pixelSpacing: PixelSpacing | undefined,
): string[] {
  const fmt = options.format;
  const lines: string[] = [];

  const writeLine = (labelText: string, measurement: Measurement): void => {
    const line = options.formatLine
      ? options.formatLine(labelText, measurement)
      : `${labelText}: ${formatMeasurement(measurement, fmt)}`;
    lines.push(line);
  };

  if (options.radius && geometry.type === 'circle') {
    writeLine('r', toPhysicalLength(geometry.radius, pixelSpacing, 'mean'));
  }
  if (options.area) {
    const a = geom.area(geometry);
    if (a > 0) writeLine('A', toPhysicalArea(a, pixelSpacing));
  }
  if (options.perimeter) {
    const p = geom.perimeter(geometry);
    if (p > 0) writeLine('P', toPhysicalLength(p, pixelSpacing, 'mean'));
  }
  if (options.length) {
    const l = geom.length(geometry);
    if (l > 0 && (geometry.type === 'line' || geometry.type === 'polyline')) {
      writeLine('L', toPhysicalLength(l, pixelSpacing, 'mean'));
    }
  }

  return lines;
}

interface ResolvedAnchor {
  readonly anchor: Point;
  readonly offset?: { readonly x: number; readonly y: number };
  readonly placement: TextPlacement;
}

function anchorPlacementFor(geometry: Geometry): ResolvedAnchor {
  switch (geometry.type) {
    case 'rectangle':
    case 'polygon':
      return { anchor: geom.centroid(geometry), placement: 'center' };
    case 'circle':
      return {
        anchor: { x: geometry.center.x + geometry.radius, y: geometry.center.y },
        offset: { x: 8, y: 0 },
        placement: 'left',
      };
    case 'line':
      return {
        anchor: geom.midpoint(geometry.start, geometry.end),
        offset: { x: 0, y: -6 },
        placement: 'bottom',
      };
    case 'point':
      return {
        anchor: geometry.position,
        offset: { x: 8, y: 0 },
        placement: 'left',
      };
    case 'polyline':
      return { anchor: geom.centroid(geometry), placement: 'center' };
  }
}

// ── createLabelProvider ────────────────────────────────────────────────────

export interface LabelProviderOptions {
  /** Style applied to label text. */
  readonly style?: TextDecorationStyle | undefined;
  /**
   * Custom extractor; receives the annotation and should return the text
   * to render, or `undefined` to skip. Defaults to reading `annotation.label`.
   */
  readonly extract?:
    | (<E extends object>(annotation: Annotation<E>) => string | undefined)
    | undefined;
}

/**
 * A provider that renders the `label` field of each visible annotation as
 * a text decoration. Annotations without a label are skipped.
 */
export function createLabelProvider<E extends object = Record<string, never>>(
  options?: LabelProviderOptions,
): DecorationProvider<E> {
  const extract =
    options?.extract ?? ((annotation: BaseAnnotation): string | undefined => annotation.label);
  return ({ annotations }) => {
    const decorations: Decoration[] = [];
    for (const ann of annotations) {
      const text = extract(ann);
      if (!text) continue;
      const placement = anchorPlacementFor(ann.geometry);
      const decoration: TextDecoration = {
        id: `label:${ann.id}`,
        type: 'text',
        relatedAnnotationIds: [ann.id],
        text,
        anchor: placement.anchor,
        ...(placement.offset !== undefined ? { offset: placement.offset } : {}),
        placement: placement.placement,
        ...(options?.style !== undefined ? { style: options.style } : {}),
      };
      decorations.push(decoration);
    }
    return decorations;
  };
}

// ── createDistanceProvider ─────────────────────────────────────────────────

/** A pair of annotations the distance provider will render a connector for. */
export interface AnnotationPair<E extends object = Record<string, never>> {
  readonly a: Annotation<E>;
  readonly b: Annotation<E>;
  /**
   * Optional explicit id for the pair, used for stable decoration ids across
   * recomputations. Defaults to `${a.id}-${b.id}`.
   */
  readonly id?: string | undefined;
}

export interface DistanceProviderOptions<E extends object = Record<string, never>> {
  /**
   * Pure pairing function. Receives all visible annotations and returns the
   * pairs to connect. The library does not invent pairing semantics — callers
   * decide whether to pair consecutive points, look up explicit links via
   * metadata, etc.
   */
  readonly pair: (annotations: readonly Annotation<E>[]) => readonly AnnotationPair<E>[];
  /** If true (default), the connector line is dashed. */
  readonly dashed?: boolean | undefined;
  readonly lineStyle?: LineDecorationStyle | undefined;
  readonly textStyle?: TextDecorationStyle | undefined;
  readonly format?: FormatMeasurementOptions | undefined;
  /**
   * Custom formatter for the distance label. Receives the value + unit and
   * a `defaultFormatter` that applies `format` via `formatMeasurement`, so
   * callers can wrap the standard rendering — e.g.
   * `formatLine: (m, fmt) => 'Distance: ' + fmt(m)`.
   */
  readonly formatLine?:
    | ((measurement: Measurement, defaultFormatter: (m: Measurement) => string) => string)
    | undefined;
}

/**
 * A provider that emits a connector line + distance label for each
 * caller-supplied pair of annotations. Each annotation's anchor is its
 * geometric centroid (see {@link centroid}); distance is in image pixels
 * unless `pixelSpacing` converts it to physical units.
 */
export function createDistanceProvider<E extends object = Record<string, never>>(
  options: DistanceProviderOptions<E>,
): DecorationProvider<E> {
  const dashed = options.dashed ?? true;
  const defaultFormatter = (m: Measurement): string => formatMeasurement(m, options.format);
  return ({ annotations, pixelSpacing }) => {
    const pairs = options.pair(annotations);
    const decorations: Decoration[] = [];
    for (const pair of pairs) {
      const pA = geom.centroid(pair.a.geometry);
      const pB = geom.centroid(pair.b.geometry);
      const pxDistance = geom.distance(pA, pB);
      const measurement = toPhysicalLength(pxDistance, pixelSpacing, 'mean');
      const text = options.formatLine
        ? options.formatLine(measurement, defaultFormatter)
        : defaultFormatter(measurement);
      const pairId = pair.id ?? `${pair.a.id}-${pair.b.id}`;
      const relatedIds = [pair.a.id, pair.b.id] as const;

      const line: LineDecoration = {
        type: 'line',
        id: `distance-line:${pairId}`,
        relatedAnnotationIds: relatedIds,
        start: pA,
        end: pB,
        dashed,
        ...(options.lineStyle !== undefined ? { style: options.lineStyle } : {}),
      };
      const label: TextDecoration = {
        type: 'text',
        id: `distance-text:${pairId}`,
        relatedAnnotationIds: relatedIds,
        text,
        anchor: geom.midpoint(pA, pB),
        offset: { x: 0, y: -6 },
        placement: 'bottom',
        ...(options.textStyle !== undefined ? { style: options.textStyle } : {}),
      };
      decorations.push(line, label);
    }
    return decorations;
  };
}
