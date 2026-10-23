import type { Vr } from './tags.js';

/**
 * A read-only view of one DICOM dataset — the top level of an instance or one
 * sequence item — independent of how it was encoded.
 *
 * Two backends implement it: {@link readPart10} (a Part 10 file, explicit or
 * implicit VR little endian) and {@link fromDicomJson} (the DICOM JSON model
 * that DICOMweb's metadata endpoints return). Everything above this interface —
 * the mapping to osdlabel inputs, the WSI pyramid, the export round trip — is
 * written once against it, so a host can feed the adapter whichever it has.
 *
 * Tags are numbers, `(group << 16) | element`; use the {@link TAGS} dictionary
 * rather than literals.
 */
export interface DicomDataset {
  /** Whether the attribute is present (it may still be empty). */
  has(tag: number): boolean;
  /** The attribute's VR, from the encoding or, for implicit VR, the dictionary. */
  vr(tag: number): Vr | undefined;
  /** String values, split on `\` for multi-valued VRs and trimmed. `undefined` if absent or empty. */
  strings(tag: number): readonly string[] | undefined;
  /** Numeric values: DS/IS parsed from text, binary VRs read little endian, AT as `(group << 16) | element`. */
  numbers(tag: number): readonly number[] | undefined;
  /** The items of a sequence, or `undefined` if absent. */
  sequence(tag: number): readonly DicomDataset[] | undefined;
  /** Raw value bytes of a binary attribute (a view, not a copy), if the backend holds them inline. */
  bytes(tag: number): Uint8Array | undefined;
  /** Every tag present, ascending. */
  tags(): readonly number[];
}

/** First string value, or `undefined`. */
export function str(ds: DicomDataset, tag: number): string | undefined {
  return ds.strings(tag)?.[0];
}

/** First numeric value, or `undefined` (also when the value is not a finite number). */
export function num(ds: DicomDataset, tag: number): number | undefined {
  const v = ds.numbers(tag)?.[0];
  return v !== undefined && Number.isFinite(v) ? v : undefined;
}

/** All numeric values if there are exactly `n` finite ones, else `undefined`. */
export function nums(ds: DicomDataset, tag: number, n: number): readonly number[] | undefined {
  const v = ds.numbers(tag);
  if (!v || v.length !== n || !v.every(Number.isFinite)) return undefined;
  return v;
}

/** First item of a sequence, or `undefined`. */
export function item(ds: DicomDataset, tag: number): DicomDataset | undefined {
  return ds.sequence(tag)?.[0];
}

/** Formats a tag as `(gggg,eeee)` for messages. */
export function formatTag(tag: number): string {
  const hex = (tag >>> 0).toString(16).padStart(8, '0').toUpperCase();
  return `(${hex.slice(0, 4)},${hex.slice(4)})`;
}
