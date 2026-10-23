import type { DicomDataset } from './dataset.js';
import type { Vr } from './tags.js';

/** A person name in the DICOM JSON model (PS3.18 F.2.2). */
export interface DicomJsonPersonName {
  readonly Alphabetic?: string;
  readonly Ideographic?: string;
  readonly Phonetic?: string;
}

export type DicomJsonValue = string | number | null | DicomJsonPersonName | DicomJsonDataset;

/** One attribute in the DICOM JSON model. */
export interface DicomJsonElement {
  readonly vr: string;
  readonly Value?: readonly DicomJsonValue[];
  readonly InlineBinary?: string;
  readonly BulkDataURI?: string;
}

/**
 * A dataset in the DICOM JSON model, as returned by DICOMweb
 * (`GET …/metadata`, QIDO-RS). Keys are 8-digit upper-case hex tags.
 */
export interface DicomJsonDataset {
  readonly [tag: string]: DicomJsonElement;
}

const TEXT_VRS: ReadonlySet<string> = new Set([
  'AE',
  'AS',
  'CS',
  'DA',
  'DS',
  'DT',
  'IS',
  'LO',
  'LT',
  'SH',
  'ST',
  'TM',
  'UC',
  'UI',
  'UR',
  'UT',
]);
const NUMERIC_VRS: ReadonlySet<string> = new Set([
  'DS',
  'IS',
  'US',
  'SS',
  'UL',
  'SL',
  'FL',
  'FD',
  'SV',
  'UV',
]);

function tagKey(tag: number): string {
  return (tag >>> 0).toString(16).padStart(8, '0').toUpperCase();
}

function isPersonName(v: DicomJsonValue): v is DicomJsonPersonName {
  return (
    typeof v === 'object' &&
    v !== null &&
    !('vr' in v) &&
    ('Alphabetic' in v || 'Ideographic' in v || 'Phonetic' in v)
  );
}

function decodeBase64(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

class JsonDataset implements DicomDataset {
  private items = new Map<number, readonly DicomDataset[]>();
  constructor(private readonly json: DicomJsonDataset) {}

  private el(tag: number): DicomJsonElement | undefined {
    return this.json[tagKey(tag)];
  }

  has(tag: number): boolean {
    return this.el(tag) !== undefined;
  }

  vr(tag: number): Vr | undefined {
    return this.el(tag)?.vr as Vr | undefined;
  }

  tags(): readonly number[] {
    return Object.keys(this.json)
      .map((k) => parseInt(k, 16))
      .sort((a, b) => a - b);
  }

  bytes(tag: number): Uint8Array | undefined {
    const e = this.el(tag);
    return e?.InlineBinary !== undefined ? decodeBase64(e.InlineBinary) : undefined;
  }

  strings(tag: number): readonly string[] | undefined {
    const e = this.el(tag);
    if (!e?.Value || e.Value.length === 0) return undefined;
    const out: string[] = [];
    for (const v of e.Value) {
      if (v === null) out.push('');
      else if (typeof v === 'string') out.push(v);
      else if (typeof v === 'number') out.push(String(v));
      else if (isPersonName(v)) out.push(v.Alphabetic ?? '');
    }
    return out.length === 0 ? undefined : out;
  }

  numbers(tag: number): readonly number[] | undefined {
    const e = this.el(tag);
    if (!e) return undefined;
    if (e.vr === 'AT') {
      return e.Value?.map((v) => (typeof v === 'string' ? parseInt(v, 16) : NaN));
    }
    if (e.InlineBinary !== undefined) {
      const b = this.bytes(tag)!;
      const view = new DataView(b.buffer, b.byteOffset, b.byteLength);
      const out: number[] = [];
      const step = e.vr === 'OD' || e.vr === 'OV' ? 8 : e.vr === 'OW' ? 2 : e.vr === 'OB' ? 1 : 4;
      for (let i = 0; i + step <= b.length; i += step) {
        if (e.vr === 'OF') out.push(view.getFloat32(i, true));
        else if (e.vr === 'OD') out.push(view.getFloat64(i, true));
        else if (e.vr === 'OL') out.push(view.getUint32(i, true));
        else if (e.vr === 'OW') out.push(view.getUint16(i, true));
        else if (e.vr === 'OB') out.push(view.getUint8(i));
        else if (e.vr === 'OV') out.push(Number(view.getBigUint64(i, true)));
      }
      return out;
    }
    if (!e.Value || e.Value.length === 0) return undefined;
    if (!NUMERIC_VRS.has(e.vr) && !TEXT_VRS.has(e.vr)) return undefined;
    return e.Value.map((v) =>
      typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN,
    );
  }

  sequence(tag: number): readonly DicomDataset[] | undefined {
    const cached = this.items.get(tag);
    if (cached) return cached;
    const e = this.el(tag);
    if (!e || e.vr !== 'SQ') return undefined;
    const items = (e.Value ?? []).flatMap((v) =>
      typeof v === 'object' && v !== null && !isPersonName(v) ? [new JsonDataset(v)] : [],
    );
    this.items.set(tag, items);
    return items;
  }
}

/** Wraps a DICOM JSON model object (one instance's metadata) as a {@link DicomDataset}. */
export function fromDicomJson(json: DicomJsonDataset): DicomDataset {
  return new JsonDataset(json);
}

const BINARY_VRS: ReadonlySet<string> = new Set(['OB', 'OD', 'OF', 'OL', 'OV', 'OW', 'UN']);

function encodeBase64(b: Uint8Array): string {
  let s = '';
  for (let i = 0; i < b.length; i += 0x8000) {
    s += String.fromCharCode(...b.subarray(i, i + 0x8000));
  }
  return btoa(s);
}

export interface ToDicomJsonOptions {
  /**
   * Binary values at or above this size become a `BulkDataURI` (from
   * `bulkDataUri`) instead of `InlineBinary`, as a DICOMweb server would do.
   * Default 1024 bytes.
   */
  readonly inlineBinaryLimit?: number;
  readonly bulkDataUri?: (tag: number) => string;
}

/**
 * Converts any {@link DicomDataset} to the DICOM JSON model. Used by the PoC's
 * emulated DICOMweb server to serve `…/metadata` from Part 10 files; Pixel
 * Data is always referenced by URI.
 */
export function toDicomJson(ds: DicomDataset, options: ToDicomJsonOptions = {}): DicomJsonDataset {
  const limit = options.inlineBinaryLimit ?? 1024;
  const out: Record<string, DicomJsonElement> = {};
  for (const tag of ds.tags()) {
    const vr = ds.vr(tag) ?? 'UN';
    const key = tagKey(tag);
    if (vr === 'SQ') {
      out[key] = { vr, Value: (ds.sequence(tag) ?? []).map((i) => toDicomJson(i, options)) };
      continue;
    }
    if (BINARY_VRS.has(vr) || tag === 0x7fe00010) {
      const b = ds.bytes(tag);
      if (tag === 0x7fe00010 || !b || b.length >= limit) {
        if (options.bulkDataUri) out[key] = { vr, BulkDataURI: options.bulkDataUri(tag) };
        continue;
      }
      out[key] = { vr, InlineBinary: encodeBase64(b) };
      continue;
    }
    if (vr === 'PN') {
      const s = ds.strings(tag);
      out[key] = s ? { vr, Value: s.map((a) => ({ Alphabetic: a })) } : { vr };
      continue;
    }
    if (vr === 'AT') {
      const n = ds.numbers(tag);
      out[key] = n ? { vr, Value: n.map((t) => tagKey(t)) } : { vr };
      continue;
    }
    if (NUMERIC_VRS.has(vr)) {
      const n = ds.numbers(tag);
      out[key] = n ? { vr, Value: n.map((x) => (Number.isFinite(x) ? x : null)) } : { vr };
      continue;
    }
    const s = ds.strings(tag);
    out[key] = s ? { vr, Value: s } : { vr };
  }
  return out;
}
