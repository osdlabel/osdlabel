import type { VectorGeometry } from '@osdlabel/annotation';
import type { DicomDataset, WriteDataset } from '@osdlabel/dicom';
import {
  createUid,
  dicomDateTime,
  el,
  imageToPatient,
  seq,
  str,
  TAGS,
  toWriteDataset,
  writePart10,
} from '@osdlabel/dicom';
import { CODES, codeItem, type Code } from './codes.js';
import { evidenceSequence, patientStudyFrom, type ImageRef } from './context.js';
import { toAnn, type AnnGraphicType } from './geometry-mapping.js';

export const MICROSCOPY_BULK_SIMPLE_ANNOTATIONS = '1.2.840.10008.5.1.4.1.1.91.1';

export interface AnnItem {
  readonly geometry: VectorGeometry;
  /** Annotations are grouped by label (and graphic type) into Annotation Groups. */
  readonly label: string;
  readonly category?: Code | undefined;
  readonly type?: Code | undefined;
}

export interface BulkAnnotationOptions {
  /** The slide image (normally the highest-resolution VOLUME instance) the coordinates refer to. */
  readonly image: ImageRef;
  readonly source?: DicomDataset | undefined;
  readonly items: readonly AnnItem[];
  /**
   * `'2D'` (default): image coordinates of the referenced Total Pixel Matrix
   * (Pixel Origin Interpretation VOLUME), written with the SCOORD convention
   * that (0,0) is the top-left corner of the top-left pixel. `'3D'`: slide
   * coordinates in mm, which every pyramid level shares (and which avoid the
   * 2D origin ambiguity CP-2411 addresses).
   */
  readonly coordinates?: '2D' | '3D' | undefined;
  /** Float64 coordinates (Double Point Coordinates Data) instead of float32. */
  readonly double?: boolean | undefined;
  readonly now?: Date | undefined;
}

export interface BuiltBulkAnnotations {
  readonly dataset: WriteDataset;
  readonly sopInstanceUid: string;
  readonly groups: number;
  readonly bytes: Uint8Array;
}

/**
 * Builds a Microscopy Bulk Simple Annotations instance: annotations grouped
 * by (label, graphic type), each group's coordinates in one flat float array
 * — the compact, WSI-scale form (vs. one SR content item per shape).
 */
export function buildBulkAnnotations(options: BulkAnnotationOptions): BuiltBulkAnnotations {
  const mode = options.coordinates ?? '2D';
  const sopInstanceUid = createUid();
  const seriesInstanceUid = createUid();
  const { date, time } = dicomDateTime(options.now);
  const plane = options.image.plane;
  if (mode === '3D' && !plane)
    throw new Error('3D annotations need the slide plane of the referenced image');

  const groups = new Map<
    string,
    { label: string; type: AnnGraphicType; item: AnnItem; shapes: VectorGeometry[] }
  >();
  for (const it of options.items) {
    const t = toAnn(it.geometry).graphicType;
    const key = `${it.label}\u0000${t}`;
    const g = groups.get(key) ?? { label: it.label, type: t, item: it, shapes: [] };
    g.shapes.push(it.geometry);
    groups.set(key, g);
  }

  const groupItems: WriteDataset[] = [...groups.values()].map((g, gi) => {
    const coords: number[] = [];
    const index: number[] = [];
    for (const shape of g.shapes) {
      const { points } = toAnn(shape);
      // Long Primitive Point Index List: 1-based index of each shape's first
      // *value* (not point) in the coordinate array.
      index.push(coords.length + 1);
      for (const p of points) {
        if (mode === '3D') coords.push(...imageToPatient(plane!, p));
        else coords.push(p.x, p.y);
      }
    }
    const data = options.double ? new Float64Array(coords) : new Float32Array(coords);
    const needsIndex = g.type === 'POLYLINE' || g.type === 'POLYGON';
    return [
      el('AnnotationGroupNumber', gi + 1),
      el('AnnotationGroupUID', createUid()),
      el('AnnotationGroupLabel', g.label),
      el('AnnotationGroupGenerationType', 'MANUAL'),
      seq('AnnotationPropertyCategoryCodeSequence', [codeItem(g.item.category ?? CODES.tissue)]),
      seq('AnnotationPropertyTypeCodeSequence', [codeItem(g.item.type ?? CODES.tissue)]),
      el('NumberOfAnnotations', g.shapes.length),
      el('AnnotationAppliesToAllOpticalPaths', 'YES'),
      ...(mode === '3D' ? [el('AnnotationAppliesToAllZPlanes', 'YES')] : []),
      el('GraphicType', g.type),
      options.double ? el('DoublePointCoordinatesData', data) : el('PointCoordinatesData', data),
      ...(needsIndex ? [el('LongPrimitivePointIndexList', new Uint32Array(index))] : []),
    ];
  });

  const dataset: WriteDataset = [
    el('SpecificCharacterSet', 'ISO_IR 192'),
    el('SOPClassUID', MICROSCOPY_BULK_SIMPLE_ANNOTATIONS),
    el('SOPInstanceUID', sopInstanceUid),
    el('InstanceCreationDate', date),
    el('InstanceCreationTime', time),
    ...patientStudyFrom(options.source),
    el('Modality', 'ANN'),
    el('SeriesInstanceUID', seriesInstanceUid),
    el('SeriesNumber', 97),
    el('SeriesDescription', 'osdlabel annotations'),
    // General Series Laterality is Type 2C: carry the source's if it has one.
    // (Writing it empty when the condition is unsatisfied is itself an error.)
    ...(options.source?.has(TAGS.Laterality.tag)
      ? toWriteDataset(options.source, [TAGS.Laterality.tag])
      : []),
    ...(mode === '3D' && plane?.frameOfReferenceUid
      ? [
          el('FrameOfReferenceUID', plane.frameOfReferenceUid),
          el('PositionReferenceIndicator', null),
        ]
      : []),
    el('Manufacturer', 'osdlabel'),
    el('ManufacturerModelName', 'osdlabel-poc'),
    el('DeviceSerialNumber', '0'),
    el('SoftwareVersions', '0.21.0'),
    el('InstanceNumber', 1),
    el('ContentLabel', 'OSDLABEL'),
    el('ContentDescription', null),
    el('ContentDate', date),
    el('ContentTime', time),
    el('ContentCreatorName', null),
    el('AnnotationCoordinateType', mode),
    ...(mode === '2D' ? [el('PixelOriginInterpretation', 'VOLUME')] : []),
    // Required for 2D; kept for 3D too so Common Instance Reference has a referrer.
    seq('ReferencedImageSequence', [
      [
        el('ReferencedSOPClassUID', options.image.sopClassUid),
        el('ReferencedSOPInstanceUID', options.image.sopInstanceUid),
      ],
    ]),
    seq('AnnotationGroupSequence', groupItems),
    evidenceSequence('ReferencedSeriesSequence', [options.image]),
    // Specimen identity travels with slide-derived objects: the Specimen
    // macro is copied verbatim from the source image.
    ...(options.source && str(options.source, TAGS.ContainerIdentifier.tag)
      ? toWriteDataset(options.source, [
          TAGS.ContainerIdentifier.tag,
          TAGS.IssuerOfTheContainerIdentifierSequence.tag,
          TAGS.ContainerTypeCodeSequence.tag,
          TAGS.SpecimenDescriptionSequence.tag,
        ])
      : []),
  ];
  const bytes = writePart10(dataset, {
    sopClassUid: MICROSCOPY_BULK_SIMPLE_ANNOTATIONS,
    sopInstanceUid,
  });
  return { dataset, sopInstanceUid, groups: groupItems.length, bytes };
}
