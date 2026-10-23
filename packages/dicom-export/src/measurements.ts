import type { VectorGeometry } from '@osdlabel/annotation';
import { measureLength, measurePerimeter, toPhysicalArea } from '@osdlabel/decoration';
import { area } from '@osdlabel/geometry';
import type { PixelSpacing } from '@osdlabel/viewer-api';
import { CODES, ucum, type Code } from './codes.js';

export interface ExportedMeasurement {
  readonly concept: Code;
  readonly value: number;
  readonly unit: Code;
}

/**
 * The measurements an SR carries for a geometry, computed with the same
 * per-axis (anisotropy-exact) functions osdlabel's decorations use, so the
 * report says what the viewer showed. Uncalibrated images get none: DICOM SR
 * has no honest unit for "pixels" in TID 300, and a measurement in an
 * undefined unit is worse than none (the geometry is still exported).
 */
export function measurementsFor(
  g: VectorGeometry,
  spacing: PixelSpacing | undefined,
): ExportedMeasurement[] {
  if (!spacing) return [];
  const out: ExportedMeasurement[] = [];
  switch (g.type) {
    case 'line':
    case 'polyline': {
      const m = measureLength(g, spacing);
      out.push({ concept: CODES.length, value: m.value, unit: ucum(m.unit, false) });
      break;
    }
    case 'rectangle':
    case 'circle':
    case 'polygon': {
      const a = toPhysicalArea(area(g), spacing);
      out.push({ concept: CODES.area, value: a.value, unit: ucum(spacing.unit, true) });
      const p = measurePerimeter(g, spacing);
      out.push({ concept: CODES.perimeter, value: p.value, unit: ucum(p.unit, false) });
      break;
    }
    case 'point':
      break;
  }
  return out;
}
