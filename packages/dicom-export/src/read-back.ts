import type { Point, VectorGeometry } from '@osdlabel/annotation';
import type { DicomDataset, PlaneGeometry } from '@osdlabel/dicom';
import { item, num, patientToImage, str, TAGS } from '@osdlabel/dicom';
import type { MaskSnapshot } from '@osdlabel/mask';
import { fromAnn, fromScoord } from './geometry-mapping.js';

/**
 * The import direction: DICOM SR / SEG / ANN back into osdlabel shapes. Used
 * for the round-trip fidelity measurement, and the start of "load existing
 * DICOM annotations into the annotator".
 */

export interface ImportedMeasurement {
  readonly name: string;
  readonly value: number;
  readonly unit: string;
}

export interface ImportedSrGroup {
  readonly trackingIdentifier: string | undefined;
  readonly template: string | undefined;
  readonly referencedSopInstanceUid: string | undefined;
  readonly geometry: VectorGeometry | undefined;
  readonly graphicType: string | undefined;
  readonly measurements: readonly ImportedMeasurement[];
}

const conceptMeaning = (ci: DicomDataset): string | undefined =>
  str(item(ci, TAGS.ConceptNameCodeSequence.tag) ?? ci, TAGS.CodeMeaning.tag);

function children(ci: DicomDataset): readonly DicomDataset[] {
  return ci.sequence(TAGS.ContentSequence.tag) ?? [];
}

function points2(ci: DicomDataset): Point[] {
  const d = ci.numbers(TAGS.GraphicData.tag) ?? [];
  const out: Point[] = [];
  for (let i = 0; i + 1 < d.length; i += 2) out.push({ x: d[i]!, y: d[i + 1]! });
  return out;
}

function scoordOf(
  ci: DicomDataset,
  planes?: (sopInstanceUid: string | undefined) => PlaneGeometry | undefined,
):
  | {
      geometry: VectorGeometry;
      graphicType: string;
      ref: string | undefined;
    }
  | undefined {
  const vt = str(ci, TAGS.ValueType.tag);
  const gt = str(ci, TAGS.GraphicType.tag) ?? '';
  if (vt === 'SCOORD') {
    const img = children(ci).find((c) => str(c, TAGS.ValueType.tag) === 'IMAGE');
    const ref =
      img &&
      str(item(img, TAGS.ReferencedSOPSequence.tag) ?? img, TAGS.ReferencedSOPInstanceUID.tag);
    return { geometry: fromScoord(gt, points2(ci)), graphicType: gt, ref };
  }
  if (vt === 'SCOORD3D') {
    const plane = planes?.(undefined);
    if (!plane) return undefined;
    const d = ci.numbers(TAGS.GraphicData.tag) ?? [];
    const pts: Point[] = [];
    for (let i = 0; i + 2 < d.length; i += 3) {
      const p = patientToImage(plane, [d[i]!, d[i + 1]!, d[i + 2]!]);
      pts.push({ x: p.x, y: p.y });
    }
    const type2d = gt === 'POLYGON' ? 'POLYLINE' : gt === 'ELLIPSE' ? 'ELLIPSE3D' : gt;
    if (type2d === 'ELLIPSE3D') {
      return { geometry: fromAnn('ELLIPSE', pts), graphicType: gt, ref: undefined };
    }
    // SCOORD3D POLYGON repeats its first vertex at the end (unlike ANN's
    // POLYGON, which is implicitly closed) — the same closed form SCOORD's
    // POLYLINE uses, so it maps straight across.
    return { geometry: fromScoord(type2d, pts), graphicType: gt, ref: undefined };
  }
  return undefined;
}

/** Reads the measurement groups of a TID 1500 Measurement Report. */
export function readMeasurementReport(ds: DicomDataset, plane?: PlaneGeometry): ImportedSrGroup[] {
  const root = children(ds);
  const measurements = root.find((c) => conceptMeaning(c) === 'Imaging Measurements');
  if (!measurements) return [];
  return children(measurements).map((group) => {
    const kids = children(group);
    const tracking = kids.find((c) => conceptMeaning(c) === 'Tracking Identifier');
    const template = str(
      item(group, TAGS.ContentTemplateSequence.tag) ?? group,
      TAGS.TemplateIdentifier.tag,
    );
    let geom: ReturnType<typeof scoordOf>;
    const ms: ImportedMeasurement[] = [];
    for (const c of kids) {
      const vt = str(c, TAGS.ValueType.tag);
      if (vt === 'SCOORD' || vt === 'SCOORD3D') geom = scoordOf(c, () => plane) ?? geom;
      if (vt === 'NUM') {
        const mv = item(c, TAGS.MeasuredValueSequence.tag);
        const value = mv ? num(mv, TAGS.NumericValue.tag) : undefined;
        const unit =
          mv && str(item(mv, TAGS.MeasurementUnitsCodeSequence.tag) ?? mv, TAGS.CodeValue.tag);
        if (value !== undefined)
          ms.push({ name: conceptMeaning(c) ?? '?', value, unit: unit ?? '?' });
        const inferred = children(c).find((x) => {
          const v = str(x, TAGS.ValueType.tag);
          return v === 'SCOORD' || v === 'SCOORD3D';
        });
        if (inferred) geom = scoordOf(inferred, () => plane) ?? geom;
      }
    }
    return {
      trackingIdentifier: tracking ? str(tracking, TAGS.TextValue.tag) : undefined,
      template,
      referencedSopInstanceUid: geom?.ref,
      geometry: geom?.geometry,
      graphicType: geom?.graphicType,
      measurements: ms,
    };
  });
}

export interface ImportedSegment {
  readonly segmentNumber: number;
  readonly label: string | undefined;
  /** Per source SOP Instance UID, the mask as a full-frame snapshot cropped to its bounding box. */
  readonly masks: ReadonlyMap<string, MaskSnapshot>;
}

/** Reads a BINARY Segmentation back into per-source-image mask snapshots. */
export function readSegmentation(ds: DicomDataset, pixelData: Uint8Array): ImportedSegment[] {
  const rows = num(ds, TAGS.Rows.tag) ?? 0;
  const cols = num(ds, TAGS.Columns.tag) ?? 0;
  const frames = num(ds, TAGS.NumberOfFrames.tag) ?? 1;
  const perFrame = ds.sequence(TAGS.PerFrameFunctionalGroupsSequence.tag) ?? [];
  const shared = item(ds, TAGS.SharedFunctionalGroupsSequence.tag);
  const segs = new Map<number, { label: string | undefined; masks: Map<string, MaskSnapshot> }>();
  for (const s of ds.sequence(TAGS.SegmentSequence.tag) ?? []) {
    segs.set(num(s, TAGS.SegmentNumber.tag) ?? 0, {
      label: str(s, TAGS.SegmentLabel.tag),
      masks: new Map(),
    });
  }
  const n = rows * cols;
  for (let f = 0; f < frames; f++) {
    const fg = perFrame[f];
    const segId =
      (fg && item(fg, TAGS.SegmentIdentificationSequence.tag)) ??
      (shared && item(shared, TAGS.SegmentIdentificationSequence.tag));
    const segNo = segId ? (num(segId, TAGS.ReferencedSegmentNumber.tag) ?? 0) : 0;
    const der = fg && item(fg, TAGS.DerivationImageSequence.tag);
    const srcItem = der && item(der, TAGS.SourceImageSequence.tag);
    const srcUid = (srcItem && str(srcItem, TAGS.ReferencedSOPInstanceUID.tag)) ?? `frame-${f + 1}`;
    // Unpack this frame's bits (frames are contiguous at the bit level).
    let minX = cols,
      minY = rows,
      maxX = -1,
      maxY = -1;
    const full = new Uint8Array(n);
    const base = f * n;
    for (let i = 0; i < n; i++) {
      const bit = base + i;
      if ((pixelData[bit >> 3]! >> (bit & 7)) & 1) {
        full[i] = 1;
        const x = i % cols;
        const y = (i / cols) | 0;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
    const w = maxX >= minX ? maxX - minX + 1 : 0;
    const h = maxY >= minY ? maxY - minY + 1 : 0;
    const data = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) data[y * w + x] = full[(minY + y) * cols + minX + x]!;
    }
    const snapshot: MaskSnapshot = {
      x: w ? minX : 0,
      y: h ? minY : 0,
      width: w,
      height: h,
      data,
      imageWidth: cols,
      imageHeight: rows,
    };
    const seg = segs.get(segNo) ?? { label: undefined, masks: new Map<string, MaskSnapshot>() };
    seg.masks.set(srcUid, snapshot);
    segs.set(segNo, seg);
  }
  return [...segs].map(([segmentNumber, s]) => ({ segmentNumber, label: s.label, masks: s.masks }));
}

export interface ImportedAnnGroup {
  readonly label: string | undefined;
  readonly graphicType: string;
  readonly geometries: readonly VectorGeometry[];
}

/** Reads Microscopy Bulk Simple Annotations (2D, or 3D given the slide plane). */
export function readBulkAnnotations(ds: DicomDataset, plane?: PlaneGeometry): ImportedAnnGroup[] {
  const threeD = str(ds, TAGS.AnnotationCoordinateType.tag) === '3D';
  return (ds.sequence(TAGS.AnnotationGroupSequence.tag) ?? []).map((g) => {
    const gt = str(g, TAGS.GraphicType.tag) ?? '';
    const count = num(g, TAGS.NumberOfAnnotations.tag) ?? 0;
    const coords =
      g.numbers(TAGS.DoublePointCoordinatesData.tag) ??
      g.numbers(TAGS.PointCoordinatesData.tag) ??
      [];
    const dim = threeD ? 3 : 2;
    const pts: Point[] = [];
    for (let i = 0; i + dim - 1 < coords.length; i += dim) {
      if (threeD) {
        const p = patientToImage(plane!, [coords[i]!, coords[i + 1]!, coords[i + 2]!]);
        pts.push({ x: p.x, y: p.y });
      } else pts.push({ x: coords[i]!, y: coords[i + 1]! });
    }
    const fixed: Record<string, number> = { POINT: 1, RECTANGLE: 4, ELLIPSE: 4 };
    const geometries: VectorGeometry[] = [];
    if (fixed[gt] !== undefined) {
      const k = fixed[gt]!;
      for (let a = 0; a < count; a++) geometries.push(fromAnn(gt, pts.slice(a * k, a * k + k)));
    } else {
      const idx = (g.numbers(TAGS.LongPrimitivePointIndexList.tag) ?? []).map((v) => (v - 1) / dim);
      for (let a = 0; a < idx.length; a++) {
        geometries.push(fromAnn(gt, pts.slice(idx[a]!, idx[a + 1] ?? pts.length)));
      }
    }
    return { label: str(g, TAGS.AnnotationGroupLabel.tag), graphicType: gt, geometries };
  });
}
