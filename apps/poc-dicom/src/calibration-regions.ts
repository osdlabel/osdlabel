import type { Annotation, Geometry } from '@osdlabel/annotation';
import type { Decoration, DecorationProvider, TextDecoration } from '@osdlabel/decoration';
import type { CalibrationRegion } from '@osdlabel/dicom';
import { boundingBox } from '@osdlabel/geometry';
import type { ImageId, ImageIdFields } from '@osdlabel/viewer-api';

/** The region wholly containing a geometry's bounding box, if exactly one does. */
export function regionContaining(
  g: Geometry,
  regions: readonly CalibrationRegion[],
): CalibrationRegion | undefined {
  const { min, max } = boundingBox(g);
  const inside = regions.filter(
    (r) => min.x >= r.x && min.y >= r.y && max.x <= r.x + r.width && max.y <= r.y + r.height,
  );
  return inside.length === 1 ? inside[0] : undefined;
}

function axisDelta(g: Geometry): { dx: number; dy: number } {
  const { min, max } = boundingBox(g);
  if (g.type === 'line') return { dx: g.end.x - g.start.x, dy: g.end.y - g.start.y };
  return { dx: max.x - min.x, dy: max.y - min.y };
}

/**
 * Makes any measurement provider calibration-region aware, with no change to
 * osdlabel: per annotation, it finds the one region containing it and either
 * hands the inner provider that region's spacing (both axes lengths in one
 * unit — an ultrasound B-mode pane) or, when the axes measure different
 * quantities (M-mode: time × depth; spectral Doppler: time × velocity),
 * reports per-axis extents and their ratio instead of a meaningless length.
 * An annotation spanning regions (or none) is labelled "not measurable".
 *
 * Images without regions fall through to the inner provider untouched.
 */
export function withCalibrationRegions<E extends ImageIdFields>(
  inner: DecorationProvider<E>,
  regionsFor: (imageId: ImageId) => readonly CalibrationRegion[] | undefined,
): DecorationProvider<E> {
  return (ctx) => {
    const out: Decoration[] = [];
    const plain: Annotation<E>[] = [];
    for (const ann of ctx.annotations) {
      const regions = regionsFor(ann.imageId);
      if (!regions || regions.length === 0) {
        plain.push(ann);
        continue;
      }
      const r = regionContaining(ann.geometry, regions);
      const { min, max } = boundingBox(ann.geometry);
      const label = (text: string): TextDecoration => ({
        id: `region-measurement:${ann.id}`,
        type: 'text',
        relatedAnnotationIds: [ann.id],
        text,
        anchor: { x: max.x, y: min.y },
        placement: 'bottom-left',
      });
      if (!r) {
        out.push(label('spans calibration regions: not measurable'));
        continue;
      }
      const { axisX: ax, axisY: ay } = r;
      if (ax.quantity === 'length' && ay.quantity === 'length' && ax.unit === ay.unit) {
        out.push(
          ...inner({
            ...ctx,
            annotations: [ann],
            pixelSpacing: { x: ax.perPixel, y: ay.perPixel, unit: ax.unit },
          }),
        );
        continue;
      }
      const { dx, dy } = axisDelta(ann.geometry);
      const vx = Math.abs(dx) * ax.perPixel;
      const vy = Math.abs(dy) * ay.perPixel;
      const lines = [`Δx ${vx.toFixed(3)} ${ax.unit}`, `Δy ${vy.toFixed(3)} ${ay.unit}`];
      if (vx > 0) lines.push(`Δy/Δx ${(vy / vx).toFixed(3)} ${ay.unit}/${ax.unit}`);
      out.push(label(lines.join('\n')));
    }
    if (plain.length) out.push(...inner({ ...ctx, annotations: plain }));
    return out;
  };
}
