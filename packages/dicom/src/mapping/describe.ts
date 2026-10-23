import type { DicomDataset } from '../dataset.js';
import { num, str } from '../dataset.js';
import { TAGS } from '../tags.js';
import { deriveDisplayDefaults, type DisplayDefaults } from './display.js';
import { derivePixelSpacing, type PixelSpacingResult } from './pixel-spacing.js';
import { readPlaneGeometry, type PlaneGeometry } from './plane.js';
import { readFrameTiming, type FrameTiming } from './timing.js';
import {
  readUltrasoundRegions,
  toCalibrationRegions,
  type CalibrationRegion,
  type UltrasoundRegion,
} from './ultrasound-regions.js';

/** Everything the adapter derives from one instance, in osdlabel-shaped (not DICOM-shaped) terms. */
export interface InstanceDescription {
  readonly modality: string | undefined;
  readonly sopClassUid: string | undefined;
  readonly sopInstanceUid: string | undefined;
  readonly seriesInstanceUid: string | undefined;
  readonly studyInstanceUid: string | undefined;
  readonly rows: number | undefined;
  readonly columns: number | undefined;
  readonly frames: number;
  readonly pixelSpacing: PixelSpacingResult | undefined;
  readonly ultrasoundRegions: readonly UltrasoundRegion[];
  readonly calibrationRegions: readonly CalibrationRegion[];
  readonly display: DisplayDefaults;
  readonly timing: FrameTiming;
  readonly plane: PlaneGeometry | undefined;
}

export function describeInstance(ds: DicomDataset): InstanceDescription {
  const regions = readUltrasoundRegions(ds);
  return {
    modality: str(ds, TAGS.Modality.tag),
    sopClassUid: str(ds, TAGS.SOPClassUID.tag),
    sopInstanceUid: str(ds, TAGS.SOPInstanceUID.tag),
    seriesInstanceUid: str(ds, TAGS.SeriesInstanceUID.tag),
    studyInstanceUid: str(ds, TAGS.StudyInstanceUID.tag),
    rows: num(ds, TAGS.Rows.tag),
    columns: num(ds, TAGS.Columns.tag),
    frames: num(ds, TAGS.NumberOfFrames.tag) ?? 1,
    pixelSpacing: derivePixelSpacing(ds),
    ultrasoundRegions: regions,
    calibrationRegions: toCalibrationRegions(regions),
    display: deriveDisplayDefaults(ds),
    timing: readFrameTiming(ds),
    plane: readPlaneGeometry(ds),
  };
}
