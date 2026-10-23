import { fromDicomJson, type DicomJsonDataset, type DicomJsonValue } from '../../src/dicom-json.js';
import type { DicomDataset } from '../../src/dataset.js';
import { TAGS, type Keyword } from '../../src/tags.js';

type JsonValue = DicomJsonValue | DicomDataset;

/** Builds a DICOM JSON dataset from keyword → values, for terse fixtures. */
export function json(
  attrs: Partial<Record<Keyword, readonly JsonValue[] | readonly DicomJsonDataset[]>>,
): DicomJsonDataset {
  const out: Record<string, { vr: string; Value: readonly DicomJsonValue[] }> = {};
  for (const [k, v] of Object.entries(attrs)) {
    const e = TAGS[k as Keyword];
    out[(e.tag >>> 0).toString(16).padStart(8, '0').toUpperCase()] = {
      vr: e.vr,
      Value: v as readonly DicomJsonValue[],
    };
  }
  return out;
}

/** A dataset from keyword → values. */
export function ds(attrs: Parameters<typeof json>[0]): DicomDataset {
  return fromDicomJson(json(attrs));
}
