import type { DicomDataset, PlaneGeometry, WriteDataset, WriteElement } from '@osdlabel/dicom';
import { el, num, seq, str, TAGS, readPlaneGeometry, readSlidePlane } from '@osdlabel/dicom';

/**
 * A source image an export refers to — what DICOM needs to point back at the
 * pixels an annotation was drawn on. Built from the source instance with
 * {@link imageRefFrom}; nothing here is osdlabel state.
 */
export interface ImageRef {
  readonly studyInstanceUid: string;
  readonly seriesInstanceUid: string;
  readonly sopClassUid: string;
  readonly sopInstanceUid: string;
  /** 1-based, for multi-frame sources. */
  readonly frameNumber?: number | undefined;
  readonly rows: number;
  readonly columns: number;
  /** For a tiled (WSI) source: the Total Pixel Matrix size. */
  readonly totalPixelMatrix?: { readonly columns: number; readonly rows: number } | undefined;
  readonly frameOfReferenceUid?: string | undefined;
  readonly plane?: PlaneGeometry | undefined;
}

export function imageRefFrom(ds: DicomDataset, frameNumber?: number): ImageRef {
  const need = (tag: number, name: string): string => {
    const v = str(ds, tag);
    if (v === undefined) throw new Error(`source instance lacks ${name}`);
    return v;
  };
  const tpmCols = num(ds, TAGS.TotalPixelMatrixColumns.tag);
  const tpmRows = num(ds, TAGS.TotalPixelMatrixRows.tag);
  return {
    studyInstanceUid: need(TAGS.StudyInstanceUID.tag, 'StudyInstanceUID'),
    seriesInstanceUid: need(TAGS.SeriesInstanceUID.tag, 'SeriesInstanceUID'),
    sopClassUid: need(TAGS.SOPClassUID.tag, 'SOPClassUID'),
    sopInstanceUid: need(TAGS.SOPInstanceUID.tag, 'SOPInstanceUID'),
    frameNumber,
    rows: num(ds, TAGS.Rows.tag) ?? 0,
    columns: num(ds, TAGS.Columns.tag) ?? 0,
    totalPixelMatrix:
      tpmCols !== undefined && tpmRows !== undefined
        ? { columns: tpmCols, rows: tpmRows }
        : undefined,
    frameOfReferenceUid: str(ds, TAGS.FrameOfReferenceUID.tag),
    plane:
      readPlaneGeometry(ds, frameNumber !== undefined ? { frame: frameNumber - 1 } : {}) ??
      readSlidePlane(ds),
  };
}

/** Copies one attribute (strings or numbers) from a source dataset, as Type 2 (empty if absent). */
function copy(
  ds: DicomDataset | undefined,
  keyword: keyof typeof TAGS,
  type2 = true,
): WriteElement[] {
  const e = TAGS[keyword];
  if (!ds || !ds.has(e.tag)) return type2 ? [el(keyword, null)] : [];
  const vr = ds.vr(e.tag) ?? e.vr;
  const nums =
    vr === 'US' || vr === 'UL' || vr === 'SS' || vr === 'SL' || vr === 'FL' || vr === 'FD';
  if (nums) {
    const n = ds.numbers(e.tag);
    return [el(keyword, n ? [...n] : null)];
  }
  const s = ds.strings(e.tag);
  return [el(keyword, s ? [...s] : null)];
}

/**
 * Patient, General Study and (optionally) clinical-trial-free identity
 * attributes copied from the source so the derived object lands in the same
 * study. Derived objects must never invent patient identity.
 */
export function patientStudyFrom(ds: DicomDataset | undefined): WriteDataset {
  return [
    ...copy(ds, 'PatientName'),
    ...copy(ds, 'PatientID'),
    ...copy(ds, 'PatientBirthDate'),
    ...copy(ds, 'PatientSex'),
    ...copy(ds, 'StudyInstanceUID', false),
    ...copy(ds, 'StudyDate'),
    ...copy(ds, 'StudyTime'),
    ...copy(ds, 'ReferringPhysicianName'),
    ...copy(ds, 'StudyID'),
    ...copy(ds, 'AccessionNumber'),
  ];
}

/** Series / instance references grouped the way Current Requested Procedure Evidence wants them. */
export function evidenceSequence(
  keyword: 'CurrentRequestedProcedureEvidenceSequence' | 'ReferencedSeriesSequence',
  refs: readonly ImageRef[],
): WriteElement {
  const byStudy = new Map<string, Map<string, Map<string, ImageRef>>>();
  for (const r of refs) {
    const s = byStudy.get(r.studyInstanceUid) ?? new Map<string, Map<string, ImageRef>>();
    const se = s.get(r.seriesInstanceUid) ?? new Map<string, ImageRef>();
    se.set(r.sopInstanceUid, r);
    s.set(r.seriesInstanceUid, se);
    byStudy.set(r.studyInstanceUid, s);
  }
  const seriesItems = (
    series: Map<string, Map<string, ImageRef>>,
    instanceSeq: 'ReferencedSOPSequence' | 'ReferencedInstanceSequence',
  ): WriteDataset[] =>
    [...series].map(([seriesUid, instances]) => [
      el('SeriesInstanceUID', seriesUid),
      seq(
        instanceSeq,
        [...instances.values()].map((r) => [
          el('ReferencedSOPClassUID', r.sopClassUid),
          el('ReferencedSOPInstanceUID', r.sopInstanceUid),
        ]),
      ),
    ]);
  if (keyword === 'ReferencedSeriesSequence') {
    // Common Instance Reference module (same-study references).
    const all = new Map<string, Map<string, ImageRef>>();
    for (const s of byStudy.values()) for (const [k, v] of s) all.set(k, v);
    // Common Instance Reference names its instances Referenced Instance Sequence.
    return seq('ReferencedSeriesSequence', seriesItems(all, 'ReferencedInstanceSequence'));
  }
  return seq(
    keyword,
    [...byStudy].map(([studyUid, series]) => [
      el('StudyInstanceUID', studyUid),
      seq('ReferencedSeriesSequence', seriesItems(series, 'ReferencedSOPSequence')),
    ]),
  );
}
