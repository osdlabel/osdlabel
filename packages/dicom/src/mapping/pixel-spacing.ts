import type { PixelSpacing } from '@osdlabel/viewer-api';
import type { DicomDataset } from '../dataset.js';
import { item, num, str } from '../dataset.js';
import { TAGS } from '../tags.js';
import { readUltrasoundRegions } from './ultrasound-regions.js';

/** Which attribute a spacing came from. */
export type SpacingSource =
  | 'PixelSpacing'
  | 'PixelMeasuresSequence'
  | 'ImagerPixelSpacing'
  | 'ImagerPixelSpacing/EstimatedRadiographicMagnificationFactor'
  | 'ImagerPixelSpacing/DistanceSourceToPatient'
  | 'NominalScannedPixelSpacing'
  | 'SequenceOfUltrasoundRegions';

/**
 * The plane a spacing is valid in. This is the information a bare
 * `PixelSpacing` loses: for projection radiographs the same image can be
 * measured at the detector or (estimated) at the patient, and the two differ
 * by the geometric magnification — typically 5–20%.
 */
export type SpacingPlane =
  /** Cross-sectional (CT/MR/PET/US 2D) — in the patient. */
  | 'patient'
  /** Projection radiograph at the detector face: patient anatomy is magnified. */
  | 'detector'
  /** Projection radiograph corrected for magnification (an estimate at the patient). */
  | 'estimated-patient'
  /** Projection radiograph calibrated by the modality (geometry or fiducial). */
  | 'calibrated'
  /** Digitised film: the scanner's sampling, unrelated to the patient. */
  | 'scanned-film'
  /** Slide microscopy: the glass slide plane. */
  | 'slide'
  /** Valid only inside one ultrasound region (see `readUltrasoundRegions`). */
  | 'ultrasound-region';

export interface DerivedSpacing {
  /** In osdlabel's terms: x = column (horizontal) spacing, y = row spacing. */
  readonly spacing: PixelSpacing;
  readonly source: SpacingSource;
  readonly plane: SpacingPlane;
}

export interface PixelSpacingResult extends DerivedSpacing {
  /** Other defensible calibrations of the same image (e.g. detector vs. corrected). */
  readonly alternatives: readonly DerivedSpacing[];
  readonly notes: readonly string[];
}

export interface PixelSpacingOptions {
  /** Projection radiographs: prefer the magnification-corrected estimate (default) or the detector plane. */
  readonly projection?: 'estimated-patient' | 'detector';
  /** Report slide-microscopy spacing in µm (default) or mm. */
  readonly microscopyUnit?: 'µm' | 'mm';
  /** Zero-based frame, for per-frame Pixel Measures in enhanced multi-frame objects. */
  readonly frame?: number;
}

const PROJECTION_MODALITIES: ReadonlySet<string> = new Set([
  'DX',
  'CR',
  'MG',
  'IO',
  'XA',
  'RF',
  'PX',
  'DG',
]);

/**
 * DICOM stores spacing as `[row spacing, column spacing]` — vertical first.
 * Swapping the order is the most common DICOM measurement bug, and invisible
 * on the (usual) isotropic images.
 */
function fromRowCol(v: readonly number[], unit: string, scale = 1): PixelSpacing {
  return { x: v[1]! * scale, y: v[0]! * scale, unit };
}

function positive(v: readonly number[] | undefined): v is readonly number[] {
  return !!v && v.length === 2 && v.every((x) => Number.isFinite(x) && x > 0);
}

/**
 * Derives the physical pixel spacing of an image, with its provenance.
 *
 * Precedence follows PS3.3 §10.7.1 ("Pixel Spacing … value order and valid
 * values") and the projection-radiography calibration attributes:
 * functional-group Pixel Measures (enhanced and SM objects) → Pixel Spacing →
 * Imager Pixel Spacing corrected by Estimated Radiographic Magnification
 * Factor or by SID/SOD → Imager Pixel Spacing → Nominal Scanned Pixel
 * Spacing → a single spatial ultrasound region. Returns `undefined` when the
 * image carries no spatial calibration.
 */
export function derivePixelSpacing(
  ds: DicomDataset,
  options: PixelSpacingOptions = {},
): PixelSpacingResult | undefined {
  const modality = str(ds, TAGS.Modality.tag) ?? '';
  const notes: string[] = [];
  const candidates: DerivedSpacing[] = [];

  // 1. Functional groups (enhanced multi-frame, SM): per-frame overrides shared.
  const perFrame = ds.sequence(TAGS.PerFrameFunctionalGroupsSequence.tag);
  const frameItem = options.frame !== undefined ? perFrame?.[options.frame] : undefined;
  const shared = item(ds, TAGS.SharedFunctionalGroupsSequence.tag);
  const measures =
    (frameItem && item(frameItem, TAGS.PixelMeasuresSequence.tag)) ??
    (shared && item(shared, TAGS.PixelMeasuresSequence.tag)) ??
    (perFrame?.[0] && item(perFrame[0], TAGS.PixelMeasuresSequence.tag));
  const fgSpacing = measures?.numbers(TAGS.PixelSpacing.tag);
  if (positive(fgSpacing)) {
    if (modality === 'SM') {
      const unit = options.microscopyUnit ?? 'µm';
      candidates.push({
        spacing: fromRowCol(fgSpacing, unit, unit === 'µm' ? 1000 : 1),
        source: 'PixelMeasuresSequence',
        plane: 'slide',
      });
    } else {
      candidates.push({
        spacing: fromRowCol(fgSpacing, 'mm'),
        source: 'PixelMeasuresSequence',
        plane: 'patient',
      });
    }
  }

  const ps = ds.numbers(TAGS.PixelSpacing.tag);
  const ips = ds.numbers(TAGS.ImagerPixelSpacing.tag);
  const calibrationType = str(ds, TAGS.PixelSpacingCalibrationType.tag);
  const isProjection = PROJECTION_MODALITIES.has(modality) || positive(ips);

  if (isProjection) {
    // Projection radiography. Pixel Spacing is only a patient-plane value when
    // the modality says it calibrated it; vendors routinely copy Imager Pixel
    // Spacing into it, which is the detector plane under another name.
    if (positive(ps) && calibrationType) {
      candidates.push({
        spacing: fromRowCol(ps, 'mm'),
        source: 'PixelSpacing',
        plane: 'calibrated',
      });
      notes.push(`Pixel Spacing calibrated by the modality (${calibrationType})`);
    }
    if (positive(ips)) {
      const ermf = num(ds, TAGS.EstimatedRadiographicMagnificationFactor.tag);
      const sid = num(ds, TAGS.DistanceSourceToDetector.tag);
      const sod = num(ds, TAGS.DistanceSourceToPatient.tag);
      const detector: DerivedSpacing = {
        spacing: fromRowCol(ips, 'mm'),
        source: 'ImagerPixelSpacing',
        plane: 'detector',
      };
      // The modality's own magnification estimate (ERMF) is the sanctioned
      // correction and becomes the default. SID/SOD geometry is only offered
      // as an alternative: Distance Source to Patient is to the table or
      // detector-side skin surface, so it under-corrects for anatomy deeper
      // in the body — a guess the adapter should not make silently.
      const corrected: DerivedSpacing | undefined =
        ermf !== undefined && ermf > 0
          ? {
              spacing: fromRowCol(ips, 'mm', 1 / ermf),
              source: 'ImagerPixelSpacing/EstimatedRadiographicMagnificationFactor',
              plane: 'estimated-patient',
            }
          : undefined;
      const geometric: DerivedSpacing | undefined =
        sid !== undefined && sod !== undefined && sid > 0 && sod > 0 && sod < sid
          ? {
              spacing: fromRowCol(ips, 'mm', sod / sid),
              source: 'ImagerPixelSpacing/DistanceSourceToPatient',
              plane: 'estimated-patient',
            }
          : undefined;
      const preferDetector = options.projection === 'detector';
      if (corrected && !preferDetector) candidates.push(corrected, detector);
      else candidates.push(detector, ...(corrected ? [corrected] : []));
      if (geometric) candidates.push(geometric);
      if (positive(ps) && !calibrationType) {
        const same = Math.abs(ps[0]! - ips[0]!) < 1e-6 && Math.abs(ps[1]! - ips[1]!) < 1e-6;
        notes.push(
          same
            ? 'Pixel Spacing equals Imager Pixel Spacing without a calibration type: detector plane'
            : 'Pixel Spacing differs from Imager Pixel Spacing without a calibration type',
        );
        if (!same)
          candidates.push({
            spacing: fromRowCol(ps, 'mm'),
            source: 'PixelSpacing',
            plane: 'calibrated',
          });
      }
    } else if (positive(ps)) {
      candidates.push({ spacing: fromRowCol(ps, 'mm'), source: 'PixelSpacing', plane: 'detector' });
      notes.push('projection image with Pixel Spacing only: plane unknown, assumed detector');
    }
  } else if (positive(ps)) {
    candidates.push({ spacing: fromRowCol(ps, 'mm'), source: 'PixelSpacing', plane: 'patient' });
  }

  const nominal = ds.numbers(TAGS.NominalScannedPixelSpacing.tag);
  if (positive(nominal)) {
    candidates.push({
      spacing: fromRowCol(nominal, 'mm'),
      source: 'NominalScannedPixelSpacing',
      plane: 'scanned-film',
    });
  }

  const regions = readUltrasoundRegions(ds);
  const spatial = regions.filter(
    (r) => r.x.unit === 'cm' && r.y.unit === 'cm' && r.spatialFormat === '2d',
  );
  if (spatial.length > 0) {
    const r = spatial[0]!;
    candidates.push({
      // Ultrasound regions are in cm; osdlabel measurements read better in mm.
      spacing: { x: r.x.perPixel * 10, y: r.y.perPixel * 10, unit: 'mm' },
      source: 'SequenceOfUltrasoundRegions',
      plane: 'ultrasound-region',
    });
    const distinct = new Set(spatial.map((s) => `${s.x.perPixel}/${s.y.perPixel}`));
    if (regions.length > 1) {
      notes.push(
        `${regions.length} ultrasound regions (${distinct.size} distinct spatial calibration(s)); ` +
          'a single PixelSpacing is only valid inside one of them',
      );
    }
  }
  if (regions.some((r) => r.x.unit !== 'cm' || r.y.unit !== 'cm')) {
    notes.push(
      'ultrasound region(s) with non-spatial axes (time, velocity, …): not expressible as PixelSpacing',
    );
  }

  const best = candidates[0];
  if (!best) return undefined;
  return { ...best, alternatives: candidates.slice(1), notes };
}

/** Convenience: the {@link PixelSpacing} osdlabel takes, or `undefined`. */
export function pixelSpacingOf(
  ds: DicomDataset,
  options?: PixelSpacingOptions,
): PixelSpacing | undefined {
  return derivePixelSpacing(ds, options)?.spacing;
}
