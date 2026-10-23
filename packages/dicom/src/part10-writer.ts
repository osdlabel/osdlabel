import { TAGS, type Keyword, type Vr } from './tags.js';
import { TransferSyntax } from './part10-reader.js';

/** A value to write; its encoding is decided by the element's VR. */
export type WriteValue =
  | string
  | readonly string[]
  | number
  | readonly number[]
  | Uint8Array
  | Uint16Array
  | Uint32Array
  | Float32Array
  | Float64Array
  | readonly WriteDataset[]
  | null;

export interface WriteElement {
  readonly tag: number;
  readonly vr: Vr;
  readonly value: WriteValue;
}

/** A dataset to write: elements in any order (they are sorted by tag). */
export type WriteDataset = readonly WriteElement[];

/** An element by keyword, with the dictionary's VR unless overridden. */
export function el(keyword: Keyword, value: WriteValue, vr?: Vr): WriteElement {
  const e = TAGS[keyword];
  return { tag: e.tag, vr: vr ?? e.vr, value };
}

/** A sequence element. */
export function seq(keyword: Keyword, items: readonly WriteDataset[]): WriteElement {
  return { tag: TAGS[keyword].tag, vr: 'SQ', value: items };
}

const LONG_VRS: ReadonlySet<string> = new Set([
  'OB',
  'OD',
  'OF',
  'OL',
  'OV',
  'OW',
  'SQ',
  'SV',
  'UC',
  'UN',
  'UR',
  'UT',
  'UV',
]);
const SINGLE_TEXT_VRS: ReadonlySet<string> = new Set(['LT', 'ST', 'UT', 'UR']);

/** Formats a number as a DICOM Decimal String (≤ 16 characters). */
export function formatDS(x: number): string {
  if (!Number.isFinite(x)) throw new RangeError(`DS cannot encode ${x}`);
  if (Object.is(x, -0)) return '0';
  const s = String(x);
  if (s.length <= 16) return s;
  // Try fixed and exponential notation at decreasing precision; keep the
  // first (most precise) that fits. Exponential wins for small magnitudes:
  // "-1.23456789e-5" carries more digits than "-0.0000123456789".
  const tidy = (t: string): string => {
    if (t.includes('e')) {
      const [m, e] = t.split('e');
      return `${Number(m)}e${Number(e)}`;
    }
    return t.includes('.') ? t.replace(/0+$/, '').replace(/\.$/, '') : t;
  };
  for (let p = 16; p > 0; p--) {
    const a = tidy(x.toPrecision(p));
    if (a.length <= 16) return a;
    const b = tidy(x.toExponential(p - 1));
    if (b.length <= 16) return b;
  }
  throw new RangeError(`DS cannot encode ${x} in 16 characters`);
}

function formatIS(x: number): string {
  if (!Number.isInteger(x)) throw new RangeError(`IS needs an integer, got ${x}`);
  const s = String(x);
  if (s.length > 12) throw new RangeError(`IS overflow: ${x}`);
  return s;
}

const encoder = new TextEncoder();

function asList<T>(v: T | readonly T[]): readonly T[] {
  return Array.isArray(v) ? (v as readonly T[]) : [v as T];
}

function encodeValue(vr: Vr, value: WriteValue): Uint8Array {
  if (value === null) return new Uint8Array(0);
  if (value instanceof Uint8Array) return pad(value, 0);
  if (
    value instanceof Uint16Array ||
    value instanceof Uint32Array ||
    value instanceof Float32Array ||
    value instanceof Float64Array
  ) {
    // Typed arrays are platform-endian; every platform this runs on is little endian.
    return pad(new Uint8Array(value.buffer, value.byteOffset, value.byteLength), 0);
  }
  switch (vr) {
    case 'US':
    case 'SS':
    case 'UL':
    case 'SL':
    case 'FL':
    case 'FD':
    case 'AT':
    case 'OL':
    case 'OF':
    case 'OD': {
      const nums = asList(value as number | readonly number[]);
      const size = vr === 'US' || vr === 'SS' ? 2 : vr === 'FD' || vr === 'OD' ? 8 : 4;
      const buf = new Uint8Array(nums.length * size);
      const view = new DataView(buf.buffer);
      nums.forEach((n, i) => {
        const o = i * size;
        if (vr === 'US') view.setUint16(o, n, true);
        else if (vr === 'SS') view.setInt16(o, n, true);
        else if (vr === 'UL' || vr === 'OL') view.setUint32(o, n, true);
        else if (vr === 'SL') view.setInt32(o, n, true);
        else if (vr === 'FL' || vr === 'OF') view.setFloat32(o, n, true);
        else if (vr === 'FD' || vr === 'OD') view.setFloat64(o, n, true);
        else {
          view.setUint16(o, n >>> 16, true);
          view.setUint16(o + 2, n & 0xffff, true);
        }
      });
      return buf;
    }
    default: {
      let text: string;
      if (typeof value === 'number' || (Array.isArray(value) && typeof value[0] === 'number')) {
        const nums = asList(value as number | readonly number[]);
        text = nums.map((n) => (vr === 'IS' ? formatIS(n) : formatDS(n))).join('\\');
      } else {
        const strs = asList(value as string | readonly string[]);
        text = SINGLE_TEXT_VRS.has(vr) ? strs.join('') : strs.join('\\');
      }
      return pad(encoder.encode(text), vr === 'UI' ? 0 : 0x20);
    }
  }
}

function pad(b: Uint8Array, byte: number): Uint8Array {
  if (b.length % 2 === 0) return b;
  const out = new Uint8Array(b.length + 1);
  out.set(b);
  out[b.length] = byte;
  return out;
}

class ByteSink {
  readonly chunks: Uint8Array[] = [];
  length = 0;
  push(b: Uint8Array): void {
    this.chunks.push(b);
    this.length += b.length;
  }
  header(tag: number, vr: Vr | null, length: number): void {
    const long = vr === null || LONG_VRS.has(vr);
    const b = new Uint8Array(vr === null ? 8 : long ? 12 : 8);
    const v = new DataView(b.buffer);
    v.setUint16(0, tag >>> 16, true);
    v.setUint16(2, tag & 0xffff, true);
    if (vr === null) {
      v.setUint32(4, length, true);
    } else {
      b[4] = vr.charCodeAt(0);
      b[5] = vr.charCodeAt(1);
      if (long) v.setUint32(8, length, true);
      else {
        if (length > 0xffff)
          throw new RangeError(`value of ${tag.toString(16)} too long for VR ${vr}`);
        v.setUint16(6, length, true);
      }
    }
    this.push(b);
  }
  concat(): Uint8Array {
    const out = new Uint8Array(this.length);
    let p = 0;
    for (const c of this.chunks) {
      out.set(c, p);
      p += c.length;
    }
    return out;
  }
}

const UNDEFINED = 0xffffffff;

function writeDataset(sink: ByteSink, ds: WriteDataset): void {
  const sorted = [...ds].sort((a, b) => (a.tag >>> 0) - (b.tag >>> 0));
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i]!.tag === sorted[i - 1]!.tag) {
      throw new Error(`duplicate tag ${sorted[i]!.tag.toString(16)}`);
    }
  }
  for (const e of sorted) {
    if (e.vr === 'SQ') {
      const items = (e.value ?? []) as readonly WriteDataset[];
      sink.header(e.tag, 'SQ', UNDEFINED);
      for (const it of items) {
        sink.header(0xfffee000, null, UNDEFINED);
        writeDataset(sink, it);
        sink.header(0xfffee00d, null, 0);
      }
      sink.header(0xfffee0dd, null, 0);
      continue;
    }
    const v = encodeValue(e.vr, e.value);
    sink.header(e.tag, e.vr, v.length);
    sink.push(v);
  }
}

export interface WritePart10Options {
  readonly sopClassUid: string;
  readonly sopInstanceUid: string;
  /** Default explicit VR little endian; the only syntax this writer encodes. */
  readonly transferSyntaxUid?: typeof TransferSyntax.ExplicitVRLittleEndian;
  readonly implementationClassUid?: string;
  readonly implementationVersionName?: string;
}

/** Root for the PoC's implementation UID (2.25 + a fixed UUID). */
export const IMPLEMENTATION_CLASS_UID = '2.25.80302813137786398554742050926734630921';

/**
 * Writes a Part 10 file: 128-byte preamble, `DICM`, file meta information
 * (with its group length) and the dataset in explicit VR little endian.
 * Sequences and items use undefined length.
 */
export function writePart10(dataset: WriteDataset, options: WritePart10Options): Uint8Array {
  const metaBody = new ByteSink();
  writeDataset(metaBody, [
    el('FileMetaInformationVersion', new Uint8Array([0, 1])),
    el('MediaStorageSOPClassUID', options.sopClassUid),
    el('MediaStorageSOPInstanceUID', options.sopInstanceUid),
    el('TransferSyntaxUID', options.transferSyntaxUid ?? TransferSyntax.ExplicitVRLittleEndian),
    el('ImplementationClassUID', options.implementationClassUid ?? IMPLEMENTATION_CLASS_UID),
    el('ImplementationVersionName', options.implementationVersionName ?? 'OSDLABEL_POC'),
  ]);
  const sink = new ByteSink();
  sink.push(new Uint8Array(128));
  sink.push(encoder.encode('DICM'));
  writeDataset(sink, [el('FileMetaInformationGroupLength', metaBody.length)]);
  for (const c of metaBody.chunks) sink.push(c);
  writeDataset(sink, dataset);
  return sink.concat();
}
