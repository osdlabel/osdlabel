import { describe, expect, it } from 'vitest';
import type { Annotation, AnnotationId, Geometry } from '@osdlabel/annotation';
import { createMeasurementProvider, type TextDecoration } from '@osdlabel/decoration';
import type { CalibrationRegion } from '@osdlabel/dicom';
import { createImageId, type ImageIdFields } from '@osdlabel/viewer-api';
import { withCalibrationRegions } from '../src/calibration-regions.js';

const img = createImageId('us');
const other = createImageId('ct');
const ann = (id: string, geometry: Geometry, imageId = img): Annotation<ImageIdFields> => ({
  id: id as AnnotationId,
  geometry,
  toolType: geometry.type === 'line' ? 'line' : 'rectangle',
  createdAt: '',
  updatedAt: '',
  imageId,
});

// A dual layout: B-mode on the left (0.1 mm/px), spectral Doppler on the right (time × velocity).
const regions: CalibrationRegion[] = [
  {
    x: 0,
    y: 0,
    width: 100,
    height: 100,
    axisX: { perPixel: 0.1, unit: 'mm', quantity: 'length' },
    axisY: { perPixel: 0.1, unit: 'mm', quantity: 'length' },
  },
  {
    x: 100,
    y: 0,
    width: 100,
    height: 100,
    axisX: { perPixel: 0.01, unit: 's', quantity: 'time' },
    axisY: { perPixel: 2, unit: 'cm/s', quantity: 'velocity' },
  },
];

const provider = withCalibrationRegions(
  createMeasurementProvider<ImageIdFields>({ length: true }),
  (id) => (id === img ? regions : undefined),
);
const text = (
  anns: Annotation<ImageIdFields>[],
  pixelSpacing?: { x: number; y: number; unit: string },
): string[] =>
  provider({ annotations: anns, selectedAnnotationId: null, pixelSpacing })
    .filter((d): d is TextDecoration => d.type === 'text')
    .map((d) => d.text);

describe('withCalibrationRegions', () => {
  it('measures inside a spatial region with that region’s spacing', () => {
    expect(
      text([ann('a', { type: 'line', start: { x: 10, y: 10 }, end: { x: 40, y: 50 } })]),
    ).toEqual(['L: 5.00 mm']);
  });

  it('reports per-axis extents and their ratio in a time × velocity region', () => {
    const [t] = text([
      ann('b', { type: 'line', start: { x: 110, y: 80 }, end: { x: 160, y: 20 } }),
    ]);
    expect(t).toBe('Δx 0.500 s\nΔy 120.000 cm/s\nΔy/Δx 240.000 cm/s/s');
  });

  it('refuses to measure across regions', () => {
    expect(
      text([ann('c', { type: 'line', start: { x: 50, y: 10 }, end: { x: 150, y: 10 } })]),
    ).toEqual(['spans calibration regions: not measurable']);
  });

  it('leaves images without regions to the inner provider and the image-wide spacing', () => {
    expect(
      text([ann('d', { type: 'line', start: { x: 0, y: 0 }, end: { x: 3, y: 4 } }, other)], {
        x: 2,
        y: 2,
        unit: 'mm',
      }),
    ).toEqual(['L: 10.00 mm']);
  });
});
