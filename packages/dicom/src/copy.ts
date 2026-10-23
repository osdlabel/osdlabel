import type { DicomDataset } from './dataset.js';
import type { WriteDataset, WriteElement } from './part10-writer.js';

const NUMERIC_BINARY = new Set(['US', 'SS', 'UL', 'SL', 'FL', 'FD', 'AT', 'SV', 'UV']);

/**
 * Re-encodes any {@link DicomDataset} (or one attribute of it) as a
 * {@link WriteDataset}, so derived objects can carry source context verbatim —
 * e.g. the Specimen Description Sequence a slide-derived ANN must repeat.
 */
export function toWriteDataset(ds: DicomDataset, only?: readonly number[]): WriteDataset {
  const out: WriteElement[] = [];
  for (const tag of only ?? ds.tags()) {
    if (!ds.has(tag)) continue;
    const vr = ds.vr(tag) ?? 'UN';
    if (vr === 'SQ') {
      out.push({ tag, vr, value: (ds.sequence(tag) ?? []).map((i) => toWriteDataset(i)) });
    } else if (NUMERIC_BINARY.has(vr)) {
      const n = ds.numbers(tag);
      out.push({ tag, vr, value: n ? [...n] : null });
    } else if (
      vr === 'OB' ||
      vr === 'OW' ||
      vr === 'OF' ||
      vr === 'OD' ||
      vr === 'OL' ||
      vr === 'OV' ||
      vr === 'UN'
    ) {
      out.push({ tag, vr, value: ds.bytes(tag) ?? null });
    } else {
      const s = ds.strings(tag);
      out.push({ tag, vr, value: s ? [...s] : null });
    }
  }
  return out;
}
