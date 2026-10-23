import type { DicomDataset } from '../dataset.js';
import { num } from '../dataset.js';
import { TAGS } from '../tags.js';

/** Physical units of an ultrasound region axis (PS3.3 C.8.5.5.1.15, codes 0–C). */
export type UltrasoundUnit =
  | 'none'
  | 'percent'
  | 'dB'
  | 'cm'
  | 's'
  | 'Hz'
  | 'dB/s'
  | 'cm/s'
  | 'cm2'
  | 'cm2/s'
  | 'cm3'
  | 'cm3/s'
  | 'deg'
  | 'unknown';

const UNITS: readonly UltrasoundUnit[] = [
  'none',
  'percent',
  'dB',
  'cm',
  's',
  'Hz',
  'dB/s',
  'cm/s',
  'cm2',
  'cm2/s',
  'cm3',
  'cm3/s',
  'deg',
];

/** Region Spatial Format (C.8.5.5.1.1). */
export type RegionSpatialFormat =
  | 'none'
  | '2d'
  | 'm-mode'
  | 'spectral'
  | 'waveform'
  | 'graphics'
  | 'unknown';

const FORMATS: readonly RegionSpatialFormat[] = [
  'none',
  '2d',
  'm-mode',
  'spectral',
  'waveform',
  'graphics',
];

/** Region Data Type (C.8.5.5.1.2), the common ones. */
const DATA_TYPES: Readonly<Record<number, string>> = {
  0: 'none',
  1: 'tissue',
  2: 'color-flow',
  3: 'pw-doppler',
  4: 'cw-doppler',
  5: 'doppler-mean-trace',
  6: 'doppler-mode-trace',
  7: 'doppler-max-trace',
  8: 'volume-trace',
  10: 'ecg-trace',
  11: 'pulse-trace',
  12: 'phonocardiogram-trace',
  13: 'gray-bar',
  14: 'color-bar',
  15: 'integrated-backscatter',
  16: 'area-trace',
  17: 'darea-dt',
  18: 'other-physiological',
};

export interface UltrasoundAxis {
  readonly unit: UltrasoundUnit;
  /** Physical units per pixel (Physical Delta X/Y). Signed: velocity axes can point down. */
  readonly perPixel: number;
  /** Reference pixel (relative to the region's top-left) and its physical value, if given. */
  readonly referencePixel: number | undefined;
  readonly referenceValue: number | undefined;
}

export interface UltrasoundRegion {
  /** Inclusive pixel bounds in image space: [x0, x1] × [y0, y1]. */
  readonly x0: number;
  readonly y0: number;
  readonly x1: number;
  readonly y1: number;
  readonly spatialFormat: RegionSpatialFormat;
  readonly dataType: string;
  readonly flags: number;
  readonly x: UltrasoundAxis;
  readonly y: UltrasoundAxis;
}

/**
 * Reads Sequence of Ultrasound Regions (0018,6011).
 *
 * This is where osdlabel's one-`PixelSpacing`-per-image model runs out: one
 * frame can hold several regions, each with its own calibration (a dual B-mode
 * / contrast layout), and a region's axes need not be lengths at all — M-mode
 * is time × depth, spectral Doppler time × velocity. See
 * {@link toCalibrationRegions} for the DICOM-free form the PoC proposes.
 */
export function readUltrasoundRegions(ds: DicomDataset): readonly UltrasoundRegion[] {
  const seq = ds.sequence(TAGS.SequenceOfUltrasoundRegions.tag);
  if (!seq) return [];
  return seq.map((r) => {
    const unitX = num(r, TAGS.PhysicalUnitsXDirection.tag);
    const unitY = num(r, TAGS.PhysicalUnitsYDirection.tag);
    const fmt = num(r, TAGS.RegionSpatialFormat.tag);
    const dt = num(r, TAGS.RegionDataType.tag);
    return {
      x0: num(r, TAGS.RegionLocationMinX0.tag) ?? 0,
      y0: num(r, TAGS.RegionLocationMinY0.tag) ?? 0,
      x1: num(r, TAGS.RegionLocationMaxX1.tag) ?? 0,
      y1: num(r, TAGS.RegionLocationMaxY1.tag) ?? 0,
      spatialFormat: (fmt !== undefined ? FORMATS[fmt] : undefined) ?? 'unknown',
      dataType: (dt !== undefined ? DATA_TYPES[dt] : undefined) ?? `code-${dt ?? '?'}`,
      flags: num(r, TAGS.RegionFlags.tag) ?? 0,
      x: {
        unit: (unitX !== undefined ? UNITS[unitX] : undefined) ?? 'unknown',
        perPixel: num(r, TAGS.PhysicalDeltaX.tag) ?? 0,
        referencePixel: num(r, TAGS.ReferencePixelX0.tag),
        referenceValue: num(r, TAGS.ReferencePixelPhysicalValueX.tag),
      },
      y: {
        unit: (unitY !== undefined ? UNITS[unitY] : undefined) ?? 'unknown',
        perPixel: num(r, TAGS.PhysicalDeltaY.tag) ?? 0,
        referencePixel: num(r, TAGS.ReferencePixelY0.tag),
        referenceValue: num(r, TAGS.ReferencePixelPhysicalValueY.tag),
      },
    };
  });
}

/** The physical quantity an axis measures. */
export type AxisQuantity = 'length' | 'time' | 'velocity' | 'frequency' | 'other';

/** One calibrated axis of a {@link CalibrationRegion}. */
export interface AxisCalibration {
  /** Physical units per image pixel along this axis (absolute value). */
  readonly perPixel: number;
  readonly unit: string;
  readonly quantity: AxisQuantity;
}

/**
 * A DICOM-free calibration for a rectangular part of an image — the shape the
 * PoC proposes for `@osdlabel/viewer-api`. Bounds are image-space pixels with
 * osdlabel's convention ((0,0) = top-left corner of the top-left pixel), so a
 * region covers `[x, x + width) × [y, y + height)`.
 */
export interface CalibrationRegion {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly axisX: AxisCalibration;
  readonly axisY: AxisCalibration;
  /** Free-form tag (e.g. `'tissue'`, `'pw-doppler'`), for display. */
  readonly label?: string | undefined;
}

function axis(a: UltrasoundAxis): AxisCalibration {
  const per = Math.abs(a.perPixel);
  switch (a.unit) {
    case 'cm':
      return { perPixel: per * 10, unit: 'mm', quantity: 'length' };
    case 's':
      return { perPixel: per, unit: 's', quantity: 'time' };
    case 'cm/s':
      return { perPixel: per, unit: 'cm/s', quantity: 'velocity' };
    case 'Hz':
      return { perPixel: per, unit: 'Hz', quantity: 'frequency' };
    default:
      return { perPixel: per, unit: a.unit, quantity: 'other' };
  }
}

/** Maps ultrasound regions to {@link CalibrationRegion}s (skipping regions without a calibrated axis). */
export function toCalibrationRegions(regions: readonly UltrasoundRegion[]): CalibrationRegion[] {
  return regions
    .filter(
      (r) => r.x.perPixel !== 0 && r.y.perPixel !== 0 && r.x.unit !== 'none' && r.y.unit !== 'none',
    )
    .map((r) => ({
      x: r.x0,
      y: r.y0,
      width: r.x1 - r.x0 + 1,
      height: r.y1 - r.y0 + 1,
      axisX: axis(r.x),
      axisY: axis(r.y),
      label: r.dataType,
    }));
}
