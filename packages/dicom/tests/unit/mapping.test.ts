import { describe, expect, it } from 'vitest';
import { derivePixelSpacing } from '../../src/mapping/pixel-spacing.js';
import {
  readUltrasoundRegions,
  toCalibrationRegions,
} from '../../src/mapping/ultrasound-regions.js';
import { applyWindow, deriveDisplayDefaults } from '../../src/mapping/display.js';
import { readFrameTiming } from '../../src/mapping/timing.js';
import {
  buildStack,
  imageToPatient,
  patientToImage,
  readPlaneGeometry,
} from '../../src/mapping/plane.js';
import { toImageSources } from '../../src/mapping/image-sources.js';
import { TAGS } from '../../src/tags.js';
import { ds, json } from './helpers.js';

describe('derivePixelSpacing', () => {
  it('swaps DICOM row/column order into x/y', () => {
    const r = derivePixelSpacing(ds({ Modality: ['CT'], PixelSpacing: [0.7, 0.5] }));
    expect(r?.spacing).toEqual({ x: 0.5, y: 0.7, unit: 'mm' });
    expect(r?.plane).toBe('patient');
  });

  it('corrects Imager Pixel Spacing by ERMF and keeps the detector value as an alternative', () => {
    const r = derivePixelSpacing(
      ds({
        Modality: ['MG'],
        ImagerPixelSpacing: [0.1, 0.1],
        EstimatedRadiographicMagnificationFactor: [1.25],
      }),
    );
    expect(r?.source).toBe('ImagerPixelSpacing/EstimatedRadiographicMagnificationFactor');
    expect(r?.spacing.x).toBeCloseTo(0.08, 12);
    expect(r?.alternatives[0]?.plane).toBe('detector');
  });

  it('defaults to the detector plane without ERMF; SID/SOD is only an alternative', () => {
    const r = derivePixelSpacing(
      ds({
        Modality: ['DX'],
        ImagerPixelSpacing: [0.15, 0.15],
        DistanceSourceToDetector: [1000],
        DistanceSourceToPatient: [800],
      }),
    );
    expect(r?.plane).toBe('detector');
    expect(r?.alternatives.map((a) => a.source)).toContain(
      'ImagerPixelSpacing/DistanceSourceToPatient',
    );
  });

  it('honours a modality calibration of Pixel Spacing', () => {
    const r = derivePixelSpacing(
      ds({
        Modality: ['DX'],
        PixelSpacing: [0.12, 0.12],
        ImagerPixelSpacing: [0.15, 0.15],
        PixelSpacingCalibrationType: ['GEOMETRY'],
      }),
    );
    expect(r?.plane).toBe('calibrated');
    expect(r?.spacing.x).toBe(0.12);
  });

  it('reads slide microscopy spacing from the shared functional groups, in µm', () => {
    const r = derivePixelSpacing(
      ds({
        Modality: ['SM'],
        SharedFunctionalGroupsSequence: [
          json({ PixelMeasuresSequence: [json({ PixelSpacing: [0.0005, 0.0005] })] }),
        ],
      }),
    );
    expect(r?.spacing).toEqual({ x: 0.5, y: 0.5, unit: 'µm' });
    expect(r?.plane).toBe('slide');
  });

  it('flags ultrasound images whose regions a single PixelSpacing cannot describe', () => {
    const region = (x0: number, dx: number, ux: number) =>
      json({
        RegionSpatialFormat: [1],
        RegionDataType: [1],
        RegionLocationMinX0: [x0],
        RegionLocationMinY0: [0],
        RegionLocationMaxX1: [x0 + 99],
        RegionLocationMaxY1: [99],
        PhysicalUnitsXDirection: [ux],
        PhysicalUnitsYDirection: [3],
        PhysicalDeltaX: [dx],
        PhysicalDeltaY: [0.01],
      });
    const r = derivePixelSpacing(
      ds({
        Modality: ['US'],
        SequenceOfUltrasoundRegions: [region(0, 0.01, 3), region(100, 0.004, 4)],
      }),
    );
    expect(r?.source).toBe('SequenceOfUltrasoundRegions');
    expect(r?.spacing).toEqual({ x: 0.1, y: 0.1, unit: 'mm' });
    expect(r?.notes.join(' ')).toMatch(/2 ultrasound regions/);
    expect(r?.notes.join(' ')).toMatch(/non-spatial/);
  });
});

describe('ultrasound regions → calibration regions', () => {
  it('maps cm, s and cm/s axes to DICOM-free calibrations', () => {
    const d = ds({
      SequenceOfUltrasoundRegions: [
        json({
          RegionSpatialFormat: [3],
          RegionDataType: [3],
          RegionLocationMinX0: [10],
          RegionLocationMinY0: [20],
          RegionLocationMaxX1: [109],
          RegionLocationMaxY1: [69],
          PhysicalUnitsXDirection: [4],
          PhysicalUnitsYDirection: [7],
          PhysicalDeltaX: [0.005],
          PhysicalDeltaY: [-0.5],
        }),
      ],
    });
    const [r] = readUltrasoundRegions(d);
    expect(r?.spatialFormat).toBe('spectral');
    expect(r?.dataType).toBe('pw-doppler');
    const [c] = toCalibrationRegions(readUltrasoundRegions(d));
    expect(c).toMatchObject({ x: 10, y: 20, width: 100, height: 50 });
    expect(c?.axisX).toEqual({ perPixel: 0.005, unit: 's', quantity: 'time' });
    expect(c?.axisY).toEqual({ perPixel: 0.5, unit: 'cm/s', quantity: 'velocity' });
  });
});

describe('deriveDisplayDefaults', () => {
  it('pairs multiple windows with their explanations and keeps rescale', () => {
    const d = deriveDisplayDefaults(
      ds({
        PhotometricInterpretation: ['MONOCHROME2'],
        BitsStored: [12],
        WindowCenter: [40, -600],
        WindowWidth: [400, 1500],
        WindowCenterWidthExplanation: ['SOFT', 'LUNG'],
        RescaleSlope: [1],
        RescaleIntercept: [-1024],
      }),
    );
    expect(d.windows).toEqual([
      { center: 40, width: 400, label: 'SOFT' },
      { center: -600, width: 1500, label: 'LUNG' },
    ]);
    expect(d.rescale.intercept).toBe(-1024);
    expect(d.defaultVoi.kind).toBe('window');
    expect(d.invert).toBe(false);
  });

  it('inverts MONOCHROME1 exactly once, even with Presentation LUT Shape INVERSE', () => {
    const d = deriveDisplayDefaults(
      ds({ PhotometricInterpretation: ['MONOCHROME1'], PresentationLUTShape: ['INVERSE'] }),
    );
    expect(d.invert).toBe(true);
  });

  it('implements the three VOI LUT functions', () => {
    const w = { center: 100, width: 51, label: undefined };
    expect(applyWindow(0, w, 'LINEAR')).toBe(0);
    expect(applyWindow(200, w, 'LINEAR')).toBe(1);
    expect(applyWindow(99.5, w, 'LINEAR')).toBeCloseTo(0.5, 12);
    expect(applyWindow(100, w, 'LINEAR_EXACT')).toBeCloseTo(0.5, 12);
    expect(applyWindow(100, w, 'SIGMOID')).toBeCloseTo(0.5, 12);
  });
});

describe('readFrameTiming', () => {
  it('derives frame start times from Frame Time', () => {
    const t = readFrameTiming(
      ds({
        NumberOfFrames: [3],
        FrameIncrementPointer: ['00181063'],
        FrameTime: [33.3],
        CineRate: [30],
      }),
    );
    expect(t.axis).toBe('time');
    expect(t.frameStartMs).toEqual([0, 33.3, 66.6]);
    expect(t.playbackFps).toBe(30);
  });

  it('knows that a Slice Vector multi-frame is space, not time', () => {
    const t = readFrameTiming(ds({ NumberOfFrames: [227], FrameIncrementPointer: ['00540080'] }));
    expect(t.axis).toBe('space');
    expect(t.frameStartMs).toBeUndefined();
  });

  it('reports NM frames as a product of dimensions', () => {
    const t = readFrameTiming(
      ds({ NumberOfFrames: [64], FrameIncrementPointer: ['00540010', '00540020', '00540050'] }),
    );
    expect(t.axis).toBe('multi');
    expect(t.dimensions).toEqual(['energy', 'detector', 'space']);
  });
});

describe('plane geometry', () => {
  const plane = readPlaneGeometry(
    ds({
      ImagePositionPatient: [-100, -50, 20],
      ImageOrientationPatient: [0.9996573249895, 0, -0.0261769477759, 0, 1, 0],
      PixelSpacing: [0.8, 0.5],
      FrameOfReferenceUID: ['1.2.3'],
    }),
  )!;

  it('maps the TLHC of the TLHC pixel half a pixel before Image Position', () => {
    const p = imageToPatient(plane, { x: 0.5, y: 0.5 });
    expect(p[0]).toBeCloseTo(-100, 12);
    expect(p[1]).toBeCloseTo(-50, 12);
    expect(p[2]).toBeCloseTo(20, 12);
  });

  it('round-trips image ↔ patient on an oblique plane', () => {
    const q = imageToPatient(plane, { x: 123.25, y: 45.75 });
    const back = patientToImage(plane, q);
    expect(back.x).toBeCloseTo(123.25, 9);
    expect(back.y).toBeCloseTo(45.75, 9);
    expect(back.offPlane).toBeCloseTo(0, 9);
  });

  it('orders a stack by position along the normal, not by instance number', () => {
    const slice = (z: number, n: number) =>
      ds({
        SOPInstanceUID: [`1.${n}`],
        InstanceNumber: [n],
        ImagePositionPatient: [0, 0, z],
        ImageOrientationPatient: [1, 0, 0, 0, 1, 0],
        PixelSpacing: [1, 1],
        FrameOfReferenceUID: ['9'],
      });
    const items = [slice(10, 1), slice(0, 2), slice(5, 3), slice(20, 4)];
    const s = buildStack(items, (d) => readPlaneGeometry(d));
    expect(s.slices.map((x) => x.location)).toEqual([0, 5, 10, 20]);
    expect(s.gaps).toEqual([5, 5, 10]);
    expect(s.uniform).toBe(false);
    const sources = toImageSources(items, {
      tileSource: (r) => `x/${r.dataset.strings(TAGS.SOPInstanceUID.tag)?.[0]}`,
    });
    expect(sources.map((x) => x.id)).toEqual(['1.2', '1.3', '1.1', '1.4']);
    expect(sources[0]?.pixelSpacing).toEqual({ x: 1, y: 1, unit: 'mm' });
  });
});
