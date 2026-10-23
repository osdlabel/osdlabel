import type { VectorGeometry } from '@osdlabel/annotation';
import type { PixelSpacing } from '@osdlabel/viewer-api';
import type { DicomDataset, WriteDataset, WriteElement } from '@osdlabel/dicom';
import { createUid, dicomDateTime, el, imageToPatient, seq, writePart10 } from '@osdlabel/dicom';
import { CODES, codeSeq, type Code } from './codes.js';
import { evidenceSequence, patientStudyFrom, type ImageRef } from './context.js';
import { toScoord } from './geometry-mapping.js';
import { measurementsFor } from './measurements.js';

export const COMPREHENSIVE_3D_SR = '1.2.840.10008.5.1.4.1.1.88.34';

/** One annotation to report, with the image it was drawn on. */
export interface SrItem {
  readonly id: string;
  readonly geometry: VectorGeometry;
  readonly label?: string | undefined;
  readonly image: ImageRef;
  /** Calibration used for the measurements (normally the ImageSource's `pixelSpacing`). */
  readonly pixelSpacing?: PixelSpacing | undefined;
  /** Coded finding; default `Tissue` (SCT 85756007). Mapping labels to codes is the host's call. */
  readonly finding?: Code | undefined;
}

export interface MeasurementReportOptions {
  /** Source instance whose Patient / Study attributes the report inherits. */
  readonly source?: DicomDataset | undefined;
  readonly items: readonly SrItem[];
  /**
   * `'2d'` (default): SCOORD in image pixels, which round-trips osdlabel's
   * geometry exactly up to float32. `'3d'`: SCOORD3D in the patient frame of
   * reference, for images with plane geometry (CT/MR) — what volume-aware
   * consumers want.
   */
  readonly coordinates?: '2d' | '3d' | undefined;
  readonly seriesDescription?: string | undefined;
  readonly deviceObserverUid?: string | undefined;
  readonly manufacturer?: string | undefined;
  readonly now?: Date | undefined;
}

export interface BuiltReport {
  readonly dataset: WriteDataset;
  readonly sopInstanceUid: string;
  readonly seriesInstanceUid: string;
  readonly bytes: Uint8Array;
}

type Rel = 'CONTAINS' | 'HAS OBS CONTEXT' | 'HAS CONCEPT MOD' | 'INFERRED FROM' | 'SELECTED FROM';

function contentItem(
  rel: Rel | undefined,
  valueType: string,
  concept: Code | undefined,
  rest: WriteElement[],
): WriteDataset {
  return [
    ...(rel ? [el('RelationshipType', rel)] : []),
    el('ValueType', valueType),
    ...(concept ? [codeSeq('ConceptNameCodeSequence', concept)] : []),
    ...rest,
  ];
}

const container = (
  rel: Rel,
  concept: Code,
  children: WriteDataset[],
  template?: string,
): WriteDataset =>
  contentItem(rel, 'CONTAINER', concept, [
    el('ContinuityOfContent', 'SEPARATE'),
    ...(template
      ? [
          seq('ContentTemplateSequence', [
            [el('MappingResource', 'DCMR'), el('TemplateIdentifier', template)],
          ]),
        ]
      : []),
    seq('ContentSequence', children),
  ]);

const text = (rel: Rel, concept: Code, value: string): WriteDataset =>
  contentItem(rel, 'TEXT', concept, [el('TextValue', value)]);
const codeValue = (rel: Rel, concept: Code, value: Code): WriteDataset =>
  contentItem(rel, 'CODE', concept, [codeSeq('ConceptCodeSequence', value)]);
const uidref = (rel: Rel, concept: Code, uid: string): WriteDataset =>
  contentItem(rel, 'UIDREF', concept, [el('UID', uid)]);

function imageItem(rel: Rel, ref: ImageRef): WriteDataset {
  return contentItem(rel, 'IMAGE', undefined, [
    seq('ReferencedSOPSequence', [
      [
        el('ReferencedSOPClassUID', ref.sopClassUid),
        el('ReferencedSOPInstanceUID', ref.sopInstanceUid),
        ...(ref.frameNumber !== undefined ? [el('ReferencedFrameNumber', ref.frameNumber)] : []),
      ],
    ]),
  ]);
}

function scoordItem(
  rel: Rel,
  concept: Code | undefined,
  g: VectorGeometry,
  ref: ImageRef,
  mode: '2d' | '3d',
): WriteDataset {
  const { graphicType, points } = toScoord(g);
  if (mode === '3d') {
    const plane = ref.plane;
    if (!plane || !plane.frameOfReferenceUid) {
      throw new Error(
        `SCOORD3D needs plane geometry and a frame of reference for ${ref.sopInstanceUid}`,
      );
    }
    const xyz = points.flatMap((p) => [...imageToPatient(plane, p)]);
    // SCOORD3D has a POLYGON type; SCOORD's closed POLYLINE maps onto it.
    const closed = graphicType === 'POLYLINE' && g.type !== 'line' && g.type !== 'polyline';
    const type3d = closed ? 'POLYGON' : graphicType === 'CIRCLE' ? 'ELLIPSE' : graphicType;
    const data =
      type3d === 'ELLIPSE' && g.type === 'circle'
        ? [
            { x: g.center.x - g.radius, y: g.center.y },
            { x: g.center.x + g.radius, y: g.center.y },
            { x: g.center.x, y: g.center.y - g.radius },
            { x: g.center.x, y: g.center.y + g.radius },
          ].flatMap((p) => [...imageToPatient(plane, p)])
        : xyz;
    return contentItem(rel, 'SCOORD3D', concept, [
      el('GraphicType', type3d),
      el('GraphicData', new Float32Array(data)),
      el('ReferencedFrameOfReferenceUID', plane.frameOfReferenceUid),
    ]);
  }
  const data = new Float32Array(points.flatMap((p) => [p.x, p.y]));
  return contentItem(rel, 'SCOORD', concept, [
    el('GraphicType', graphicType),
    el('GraphicData', data),
    // A tiled (WSI) source: coordinates are in its Total Pixel Matrix, which
    // is what osdlabel's image space is for a DICOM WSI tile source.
    ...(ref.totalPixelMatrix ? [el('PixelOriginInterpretation', 'VOLUME')] : []),
    seq('ContentSequence', [imageItem('SELECTED FROM', ref)]),
  ]);
}

function numItem(
  rel: Rel,
  concept: Code,
  value: number,
  unit: Code,
  children: WriteDataset[],
): WriteDataset {
  return contentItem(rel, 'NUM', concept, [
    seq('MeasuredValueSequence', [
      [el('NumericValue', value), codeSeq('MeasurementUnitsCodeSequence', unit)],
    ]),
    ...(children.length ? [seq('ContentSequence', children)] : []),
  ]);
}

/** TID 1410 (closed regions) or TID 1501 (lines, points) measurement group for one annotation. */
function measurementGroup(item: SrItem, mode: '2d' | '3d'): WriteDataset {
  const g = item.geometry;
  const tracking = [
    text('HAS OBS CONTEXT', CODES.trackingIdentifier, item.label ?? item.id),
    uidref('HAS OBS CONTEXT', CODES.trackingUniqueIdentifier, createUid()),
    codeValue('CONTAINS', CODES.finding, item.finding ?? CODES.tissue),
  ];
  const ms = measurementsFor(g, item.pixelSpacing);
  const isRegion = g.type === 'rectangle' || g.type === 'circle' || g.type === 'polygon';
  if (isRegion) {
    return container(
      'CONTAINS',
      CODES.measurementGroup,
      [
        ...tracking,
        scoordItem('CONTAINS', CODES.imageRegion, g, item.image, mode),
        ...ms.map((m) => numItem('CONTAINS', m.concept, m.value, m.unit, [])),
      ],
      '1410',
    );
  }
  // TID 1501: measurements inferred from the geometry; a point has none, so
  // it is carried as an Image Region of type POINT inside TID 1410 instead.
  if (g.type === 'point') {
    return container(
      'CONTAINS',
      CODES.measurementGroup,
      [...tracking, scoordItem('CONTAINS', CODES.imageRegion, g, item.image, mode)],
      '1410',
    );
  }
  return container(
    'CONTAINS',
    CODES.measurementGroup,
    [
      ...tracking,
      ...ms.map((m) =>
        numItem('CONTAINS', m.concept, m.value, m.unit, [
          scoordItem('INFERRED FROM', undefined, g, item.image, mode),
        ]),
      ),
      ...(ms.length === 0 ? [scoordItem('CONTAINS', CODES.imageRegion, g, item.image, mode)] : []),
    ],
    '1501',
  );
}

/**
 * Builds a DICOM Comprehensive 3D SR carrying a TID 1500 Measurement Report
 * for vector annotations: each annotation becomes a measurement group with its
 * geometry (SCOORD or SCOORD3D) and its length / area / perimeter in UCUM
 * units. Masks are not SR content — export them with {@link buildSegmentation}.
 */
export function buildMeasurementReport(options: MeasurementReportOptions): BuiltReport {
  const mode = options.coordinates ?? '2d';
  const sopInstanceUid = createUid();
  const seriesInstanceUid = createUid();
  const { date, time } = dicomDateTime(options.now);
  const refs = [...new Map(options.items.map((i) => [i.image.sopInstanceUid, i.image])).values()];

  const root: WriteDataset = [
    el('ValueType', 'CONTAINER'),
    codeSeq('ConceptNameCodeSequence', CODES.imagingMeasurementReport),
    el('ContinuityOfContent', 'SEPARATE'),
    seq('ContentTemplateSequence', [
      [el('MappingResource', 'DCMR'), el('TemplateIdentifier', '1500')],
    ]),
    seq('ContentSequence', [
      codeValue('HAS CONCEPT MOD', CODES.languageOfContent, CODES.englishUS),
      codeValue('HAS OBS CONTEXT', CODES.observerType, CODES.device),
      uidref('HAS OBS CONTEXT', CODES.deviceObserverUid, options.deviceObserverUid ?? createUid()),
      codeValue('HAS CONCEPT MOD', CODES.procedureReported, CODES.imagingProcedure),
      container('CONTAINS', CODES.imageLibrary, [
        container(
          'CONTAINS',
          CODES.imageLibraryGroup,
          refs.map((r) => imageItem('CONTAINS', r)),
        ),
      ]),
      container(
        'CONTAINS',
        CODES.imagingMeasurements,
        options.items.map((i) => measurementGroup(i, mode)),
      ),
    ]),
  ];

  const dataset: WriteDataset = [
    el('SpecificCharacterSet', 'ISO_IR 192'),
    el('SOPClassUID', COMPREHENSIVE_3D_SR),
    el('SOPInstanceUID', sopInstanceUid),
    el('InstanceCreationDate', date),
    el('InstanceCreationTime', time),
    ...patientStudyFrom(options.source),
    // SR Document Series
    el('Modality', 'SR'),
    el('SeriesInstanceUID', seriesInstanceUid),
    el('SeriesNumber', 99),
    el('SeriesDescription', options.seriesDescription ?? 'osdlabel measurements'),
    seq('ReferencedPerformedProcedureStepSequence', []),
    // General Equipment
    el('Manufacturer', options.manufacturer ?? 'osdlabel'),
    // SR Document General
    el('InstanceNumber', 1),
    el('CompletionFlag', 'PARTIAL'),
    el('VerificationFlag', 'UNVERIFIED'),
    el('ContentDate', date),
    el('ContentTime', time),
    seq('PerformedProcedureCodeSequence', []),
    evidenceSequence('CurrentRequestedProcedureEvidenceSequence', refs),
    // SR Document Content (root)
    ...root,
  ];
  const bytes = writePart10(dataset, { sopClassUid: COMPREHENSIVE_3D_SR, sopInstanceUid });
  return { dataset, sopInstanceUid, seriesInstanceUid, bytes };
}
