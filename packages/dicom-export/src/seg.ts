import type { DicomDataset, WriteDataset } from '@osdlabel/dicom';
import { createUid, dicomDateTime, el, seq, writePart10 } from '@osdlabel/dicom';
import type { MaskSnapshot } from '@osdlabel/mask';
import { CODES, codeItem, codeSeq, type Code } from './codes.js';
import { evidenceSequence, patientStudyFrom, type ImageRef } from './context.js';

export const SEGMENTATION_STORAGE = '1.2.840.10008.5.1.4.1.1.66.4';

/** One painted region on one source image. */
export interface SegMask {
  readonly image: ImageRef;
  readonly snapshot: MaskSnapshot;
}

/** One segment: a labelled structure, painted on one or more source images. */
export interface SegSegment {
  readonly label: string;
  readonly category?: Code | undefined;
  readonly type?: Code | undefined;
  /** Recommended display colour as sRGB 0–255; converted to CIELab. */
  readonly rgb?: readonly [number, number, number] | undefined;
  readonly masks: readonly SegMask[];
}

export interface SegmentationOptions {
  readonly source?: DicomDataset | undefined;
  readonly segments: readonly SegSegment[];
  readonly seriesDescription?: string | undefined;
  readonly manufacturer?: string | undefined;
  readonly now?: Date | undefined;
}

export interface BuiltSegmentation {
  readonly dataset: WriteDataset;
  readonly sopInstanceUid: string;
  readonly seriesInstanceUid: string;
  readonly frameCount: number;
  readonly bytes: Uint8Array;
}

/** sRGB (0–255) → DICOM CIELab (each 0–65535), D65, as PS3.3 C.10.7.1.1 defines the scaling. */
export function rgbToDicomLab(rgb: readonly [number, number, number]): [number, number, number] {
  const lin = rgb.map((c) => {
    const v = c / 255;
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  const x = (0.4124 * lin[0] + 0.3576 * lin[1] + 0.1805 * lin[2]) / 0.95047;
  const y = 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2];
  const z = (0.0193 * lin[0] + 0.1192 * lin[1] + 0.9505 * lin[2]) / 1.08883;
  const f = (t: number): number => (t > 216 / 24389 ? Math.cbrt(t) : ((24389 / 27) * t + 16) / 116);
  const L = 116 * f(y) - 16;
  const a = 500 * (f(x) - f(y));
  const b = 200 * (f(y) - f(z));
  const clamp = (v: number): number => Math.max(0, Math.min(65535, Math.round(v)));
  return [
    clamp((L * 65535) / 100),
    clamp(((a + 128) * 65535) / 255),
    clamp(((b + 128) * 65535) / 255),
  ];
}

/**
 * Packs frames for BINARY SEG: 1 bit per pixel, LSB first, and — the classic
 * pitfall — frames concatenated at the *bit* level, with no padding between
 * frames (PS3.5 8.1.1). Only the end of the value is padded to even length.
 */
export function packBinaryFrames(
  frames: readonly Uint8Array[],
  pixelsPerFrame: number,
): Uint8Array {
  const totalBits = frames.length * pixelsPerFrame;
  const bytes = new Uint8Array(Math.ceil(totalBits / 8) + (Math.ceil(totalBits / 8) % 2));
  let bit = 0;
  for (const f of frames) {
    for (let i = 0; i < pixelsPerFrame; i++, bit++) {
      if (f[i]) bytes[bit >> 3]! |= 1 << (bit & 7);
    }
  }
  return bytes;
}

/** Expands a cropped snapshot onto the full source frame (Rows × Columns). */
function fullFrame(s: MaskSnapshot, columns: number, rows: number): Uint8Array {
  const out = new Uint8Array(columns * rows);
  for (let y = 0; y < s.height; y++) {
    const ty = s.y + y;
    if (ty < 0 || ty >= rows) continue;
    for (let x = 0; x < s.width; x++) {
      const tx = s.x + x;
      if (tx < 0 || tx >= columns) continue;
      if (s.data[y * s.width + x]) out[ty * columns + tx] = 1;
    }
  }
  return out;
}

/**
 * Builds a BINARY DICOM Segmentation from `@osdlabel/mask` snapshots.
 *
 * One frame per (segment, source image) pair that has painted pixels. With a
 * frame of reference (CT/MR) frames carry Plane Position and the dimension
 * index is (segment, position) — the layout highdicom produces; without one
 * (US, DX) frames are indexed by segment and tied to their source by the
 * Derivation Image Sequence alone.
 *
 * PoC scope: single-frame (non-tiled) sources of equal size. Tiled WSI SEG
 * (Total Pixel Matrix + Plane Position (Slide)) is costed in REPORT.md.
 */
export function buildSegmentation(options: SegmentationOptions): BuiltSegmentation {
  const sopInstanceUid = createUid();
  const seriesInstanceUid = createUid();
  const { date, time } = dicomDateTime(options.now);
  const allMasks = options.segments.flatMap((s) => s.masks);
  const first = allMasks[0]?.image;
  if (!first) throw new Error('segmentation needs at least one mask');
  const { rows, columns } = first;
  if (allMasks.some((m) => m.image.rows !== rows || m.image.columns !== columns)) {
    throw new Error('PoC: all source images must share Rows × Columns');
  }
  const plane = first.plane;
  const forUid = first.frameOfReferenceUid;
  const spatial = !!(plane && forUid && allMasks.every((m) => m.image.plane));
  const dimOrgUid = createUid();

  const frames: Uint8Array[] = [];
  const perFrame: WriteDataset[] = [];
  options.segments.forEach((segment, si) => {
    const segNo = si + 1;
    // Order frames by position along the normal so the position index is monotonic.
    const masks = [...segment.masks].filter((m) => m.snapshot.width > 0 && m.snapshot.height > 0);
    for (const m of masks) {
      frames.push(fullFrame(m.snapshot, columns, rows));
      const ref = m.image;
      perFrame.push([
        seq('DerivationImageSequence', [
          [
            seq('SourceImageSequence', [
              [
                el('ReferencedSOPClassUID', ref.sopClassUid),
                el('ReferencedSOPInstanceUID', ref.sopInstanceUid),
                ...(ref.frameNumber !== undefined
                  ? [el('ReferencedFrameNumber', ref.frameNumber)]
                  : []),
                // Readers (highdicom) refuse to index masks by source without it.
                el('SpatialLocationsPreserved', 'YES'),
                codeSeq('PurposeOfReferenceCodeSequence', CODES.sourceImageForProcessing),
              ],
            ]),
            codeSeq('DerivationCodeSequence', CODES.segmentation),
          ],
        ]),
        seq('FrameContentSequence', [[el('DimensionIndexValues', spatial ? [segNo, 0] : [segNo])]]),
        ...(spatial
          ? [seq('PlanePositionSequence', [[el('ImagePositionPatient', [...ref.plane!.position])]])]
          : []),
        seq('SegmentIdentificationSequence', [[el('ReferencedSegmentNumber', segNo)]]),
      ]);
    }
  });

  // Position index: rank of each distinct position along the normal (1-based).
  if (spatial) {
    const n = plane.normal;
    const loc = (p: readonly number[]): number => p[0]! * n[0] + p[1]! * n[1] + p[2]! * n[2];
    const positions = [
      ...new Set(
        options.segments.flatMap((s) =>
          s.masks.map((m) => loc(m.image.plane!.position).toFixed(4)),
        ),
      ),
    ].sort((a, b) => Number(a) - Number(b));
    let k = 0;
    options.segments.forEach((segment, si) => {
      for (const m of segment.masks) {
        if (m.snapshot.width === 0 || m.snapshot.height === 0) continue;
        const idx = positions.indexOf(loc(m.image.plane!.position).toFixed(4)) + 1;
        const item = perFrame[k]!;
        perFrame[k] = item.map((e) =>
          e.tag === 0x00209111
            ? seq('FrameContentSequence', [[el('DimensionIndexValues', [si + 1, idx])]])
            : e,
        );
        k++;
      }
    });
  }

  const segmentSequence = options.segments.map(
    (s, i): WriteDataset => [
      el('SegmentNumber', i + 1),
      el('SegmentLabel', s.label),
      el('SegmentAlgorithmType', 'MANUAL'),
      seq('SegmentedPropertyCategoryCodeSequence', [codeItem(s.category ?? CODES.tissue)]),
      seq('SegmentedPropertyTypeCodeSequence', [codeItem(s.type ?? CODES.tissue)]),
      ...(s.rgb ? [el('RecommendedDisplayCIELabValue', rgbToDicomLab(s.rgb))] : []),
    ],
  );

  const dimensionIndex: WriteDataset[] = [
    [
      el('DimensionOrganizationUID', dimOrgUid),
      el('DimensionIndexPointer', 0x0062000b),
      el('FunctionalGroupPointer', 0x0062000a),
      el('DimensionDescriptionLabel', 'Referenced Segment Number'),
    ],
    ...(spatial
      ? [
          [
            el('DimensionOrganizationUID', dimOrgUid),
            el('DimensionIndexPointer', 0x00200032),
            el('FunctionalGroupPointer', 0x00209113),
            el('DimensionDescriptionLabel', 'Image Position Patient'),
          ],
        ]
      : []),
  ];

  const shared: WriteDataset = spatial
    ? [
        seq('PlaneOrientationSequence', [
          [el('ImageOrientationPatient', [...plane.rowDirection, ...plane.columnDirection])],
        ]),
        seq('PixelMeasuresSequence', [
          [
            el('PixelSpacing', [plane.spacing.y, plane.spacing.x]),
            el('SliceThickness', plane.sliceThickness ?? plane.spacing.x),
          ],
        ]),
      ]
    : [];

  const refs = [...new Map(allMasks.map((m) => [m.image.sopInstanceUid, m.image])).values()];
  const pixelData = packBinaryFrames(frames, rows * columns);
  const dataset: WriteDataset = [
    el('SpecificCharacterSet', 'ISO_IR 192'),
    el('ImageType', ['DERIVED', 'PRIMARY']),
    el('SOPClassUID', SEGMENTATION_STORAGE),
    el('SOPInstanceUID', sopInstanceUid),
    el('InstanceCreationDate', date),
    el('InstanceCreationTime', time),
    ...patientStudyFrom(options.source),
    el('SeriesDate', date),
    el('SeriesTime', time),
    el('ContentDate', date),
    el('ContentTime', time),
    // Segmentation Series
    el('Modality', 'SEG'),
    el('SeriesInstanceUID', seriesInstanceUid),
    el('SeriesNumber', 98),
    el('SeriesDescription', options.seriesDescription ?? 'osdlabel segmentation'),
    // Frame of Reference (copied: a SEG lives in its source's frame)
    ...(spatial ? [el('FrameOfReferenceUID', forUid), el('PositionReferenceIndicator', null)] : []),
    // General / Enhanced General Equipment
    el('Manufacturer', options.manufacturer ?? 'osdlabel'),
    el('ManufacturerModelName', 'osdlabel-poc'),
    el('DeviceSerialNumber', '0'),
    el('SoftwareVersions', '0.21.0'),
    // General Image
    el('InstanceNumber', 1),
    ...(spatial ? [] : [el('PatientOrientation', null)]),
    // Image Pixel / Segmentation Image
    el('SamplesPerPixel', 1),
    el('PhotometricInterpretation', 'MONOCHROME2'),
    el('NumberOfFrames', frames.length),
    el('Rows', rows),
    el('Columns', columns),
    el('BitsAllocated', 1),
    el('BitsStored', 1),
    el('HighBit', 0),
    el('PixelRepresentation', 0),
    el('LossyImageCompression', '00'),
    el('SegmentationType', 'BINARY'),
    el('SegmentsOverlap', 'NO'),
    el('ContentLabel', 'OSDLABEL'),
    el('ContentDescription', 'Exported from osdlabel'),
    el('ContentCreatorName', null),
    seq('SegmentSequence', segmentSequence),
    // Multi-frame Functional Groups / Dimensions
    seq('DimensionOrganizationSequence', [[el('DimensionOrganizationUID', dimOrgUid)]]),
    seq('DimensionIndexSequence', dimensionIndex),
    ...(spatial ? [el('DimensionOrganizationType', '3D')] : []),
    seq('SharedFunctionalGroupsSequence', [shared]),
    seq('PerFrameFunctionalGroupsSequence', perFrame),
    // Common Instance Reference
    evidenceSequence('ReferencedSeriesSequence', refs),
    el('PixelData', pixelData, 'OB'),
  ];
  const bytes = writePart10(dataset, { sopClassUid: SEGMENTATION_STORAGE, sopInstanceUid });
  return { dataset, sopInstanceUid, seriesInstanceUid, frameCount: frames.length, bytes };
}
