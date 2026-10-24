import type { VectorGeometry } from '@osdlabel/annotation';
import { derivePixelSpacing } from '@osdlabel/dicom';
import {
  buildBulkAnnotations,
  buildMeasurementReport,
  buildSegmentation,
  type SegMask,
  type SrItem,
} from '@osdlabel/dicom-export';
import { decodeCanonical, type CanonicalMaskData } from '@osdlabel/mask';
import type { ImageId, PixelSpacing } from '@osdlabel/viewer-api';
import { regionContaining } from './calibration-regions.js';
import type { DicomImageContext } from './dicom-images.js';

/** The fields of an osdlabel annotation the export reads (structurally `OsdAnnotation`). */
export interface ExportableAnnotation {
  readonly id: string;
  readonly imageId: ImageId;
  readonly label?: string | undefined;
  readonly geometry: { readonly type: string };
  readonly rawAnnotationData?:
    | { readonly format: string; readonly data: Record<string, unknown> }
    | undefined;
}

export interface ExportedFile {
  readonly name: string;
  readonly kind: 'SR' | 'SEG' | 'ANN';
  readonly bytes: Uint8Array;
  readonly items: number;
}

function spacingFor(a: ExportableAnnotation, c: DicomImageContext): PixelSpacing | undefined {
  if (c.regions && c.regions.length) {
    const r = regionContaining(a.geometry as VectorGeometry, c.regions);
    if (r && r.axisX.quantity === 'length' && r.axisY.quantity === 'length') {
      return { x: r.axisX.perPixel, y: r.axisY.perPixel, unit: r.axisX.unit };
    }
    return undefined;
  }
  return derivePixelSpacing(c.source)?.spacing;
}

/**
 * osdlabel state → DICOM files. One SR per source series (derived objects
 * stay in their source's study), one SEG per series for brush masks, and for a
 * slide an ANN as well. The host's `DicomImageContext` map is the only DICOM
 * knowledge needed; the annotations are plain osdlabel data.
 */
export function exportToDicom(
  annotations: readonly ExportableAnnotation[],
  context: ReadonlyMap<ImageId, DicomImageContext>,
): ExportedFile[] {
  const bySeries = new Map<
    string,
    { vectors: SrItem[]; masks: SegMask[]; labels: string[]; ctx: DicomImageContext }
  >();
  for (const a of annotations) {
    const c = context.get(a.imageId);
    if (!c) continue;
    const g = bySeries.get(c.series) ?? { vectors: [], masks: [], labels: [], ctx: c };
    if (a.geometry.type === 'mask') {
      const raw = a.rawAnnotationData;
      if (raw?.format === 'osdlabel-mask') {
        g.masks.push({
          image: c.ref,
          snapshot: decodeCanonical(raw.data as unknown as CanonicalMaskData),
        });
        g.labels.push(a.label ?? 'mask');
      }
    } else {
      g.vectors.push({
        id: a.id,
        geometry: a.geometry as VectorGeometry,
        label: a.label ?? `${a.geometry.type}-${a.id.slice(0, 8)}`,
        image: c.ref,
        pixelSpacing: spacingFor(a, c),
      });
    }
    bySeries.set(c.series, g);
  }
  const files: ExportedFile[] = [];
  for (const [series, g] of bySeries) {
    if (g.vectors.length) {
      const sr = buildMeasurementReport({ source: g.ctx.source, items: g.vectors });
      files.push({
        name: `${series}-sr.dcm`,
        kind: 'SR',
        bytes: sr.bytes,
        items: g.vectors.length,
      });
      if (series === 'sm') {
        const ann = buildBulkAnnotations({
          image: g.ctx.ref,
          source: g.ctx.source,
          items: g.vectors.map((v) => ({ geometry: v.geometry, label: v.label ?? 'annotation' })),
        });
        files.push({
          name: `${series}-ann.dcm`,
          kind: 'ANN',
          bytes: ann.bytes,
          items: g.vectors.length,
        });
      }
    }
    if (g.masks.length && series !== 'sm') {
      const seg = buildSegmentation({
        source: g.ctx.source,
        segments: [{ label: g.labels[0] ?? 'brush', rgb: [255, 64, 32], masks: g.masks }],
      });
      files.push({
        name: `${series}-seg.dcm`,
        kind: 'SEG',
        bytes: seg.bytes,
        items: g.masks.length,
      });
    }
  }
  return files;
}
