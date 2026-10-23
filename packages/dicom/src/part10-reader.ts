import type { DicomDataset } from './dataset.js';
import { formatTag } from './dataset.js';
import { TAGS, type Vr } from './tags.js';

/** Transfer syntaxes the reader understands (all little endian). */
export const TransferSyntax = {
  ImplicitVRLittleEndian: '1.2.840.10008.1.2',
  ExplicitVRLittleEndian: '1.2.840.10008.1.2.1',
  DeflatedExplicitVRLittleEndian: '1.2.840.10008.1.2.1.99',
  ExplicitVRBigEndian: '1.2.840.10008.1.2.2',
  JPEGBaseline8Bit: '1.2.840.10008.1.2.4.50',
  JPEG2000Lossless: '1.2.840.10008.1.2.4.90',
  JPEG2000: '1.2.840.10008.1.2.4.91',
  HTJ2K: '1.2.840.10008.1.2.4.203',
} as const;

/** Where a frame's compressed bytes live inside the file. */
export interface ByteRange {
  readonly offset: number;
  readonly length: number;
}

/** Location of the Pixel Data element's value. */
export interface PixelDataInfo {
  /** Offset of the value (after the element header). */
  readonly offset: number;
  /** Value length; `undefined` for encapsulated (undefined-length) pixel data. */
  readonly length: number | undefined;
  readonly vr: Vr;
  /**
   * For encapsulated pixel data: the Basic Offset Table item (possibly empty)
   * followed by the fragments, as found. `undefined` for native pixel data, or
   * when reading stopped at the Pixel Data header.
   */
  readonly items: readonly ByteRange[] | undefined;
}

export interface Part10ReadOptions {
  /**
   * Stop parsing the top-level dataset at this tag (exclusive) — e.g.
   * `TAGS.PixelData.tag` to read the header only. When the stop tag is Pixel
   * Data its location is still reported.
   */
  readonly untilTag?: number;
}

export interface Part10File {
  /** The bytes the file was read from; byte ranges in this result index into them. */
  readonly source: Uint8Array;
  readonly transferSyntaxUid: string;
  /** Group 0002 (file meta information). Empty when the file has no meta header. */
  readonly meta: DicomDataset;
  readonly dataset: DicomDataset;
  readonly pixelData: PixelDataInfo | undefined;
  /** Bytes consumed by the parse. */
  readonly bytesRead: number;
  /**
   * True when the input ended mid-element: a header-only (HTTP Range) fetch.
   * Everything parsed before that point is returned.
   */
  readonly truncated: boolean;
}

/** Thrown for input the reader cannot handle (as opposed to truncated input). */
export class DicomParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DicomParseError';
  }
}

class Truncated extends Error {}

const ITEM = 0xfffee000;
const ITEM_DELIMITER = 0xfffee00d;
const SEQUENCE_DELIMITER = 0xfffee0dd;
const UNDEFINED = 0xffffffff;

/** VRs encoded with a 2-byte reserved field and a 4-byte length in explicit VR. */
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
const KNOWN_VRS: ReadonlySet<string> = new Set([
  'AE',
  'AS',
  'AT',
  'CS',
  'DA',
  'DS',
  'DT',
  'FD',
  'FL',
  'IS',
  'LO',
  'LT',
  'OB',
  'OD',
  'OF',
  'OL',
  'OV',
  'OW',
  'PN',
  'SH',
  'SL',
  'SQ',
  'SS',
  'ST',
  'SV',
  'TM',
  'UC',
  'UI',
  'UL',
  'UN',
  'UR',
  'US',
  'UT',
  'UV',
]);
/** String VRs whose value is never multi-valued (no `\` splitting). */
const SINGLE_TEXT_VRS: ReadonlySet<string> = new Set(['LT', 'ST', 'UT', 'UR']);
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
  'PN',
  'SH',
  'ST',
  'TM',
  'UC',
  'UI',
  'UR',
  'UT',
]);

/** VR by tag for implicit VR datasets, from the adapter's (deliberately small) dictionary. */
const IMPLICIT_VR: ReadonlyMap<number, Vr> = new Map(
  Object.values(TAGS).map((e) => [e.tag, e.vr] as const),
);

interface RawElement {
  readonly vr: Vr;
  readonly offset: number;
  readonly length: number;
  readonly items: readonly Part10Dataset[] | undefined;
}

interface Ctx {
  readonly bytes: Uint8Array;
  readonly view: DataView;
  readonly decoder: TextDecoder;
}

/**
 * One parsed dataset. Values are decoded lazily from the underlying bytes, so
 * a header parse costs a walk over element headers, not string decoding of
 * every attribute.
 */
class Part10Dataset implements DicomDataset {
  constructor(
    private readonly ctx: Ctx,
    private readonly elements: Map<number, RawElement>,
  ) {}

  has(tag: number): boolean {
    return this.elements.has(tag);
  }

  vr(tag: number): Vr | undefined {
    return this.elements.get(tag)?.vr;
  }

  tags(): readonly number[] {
    return [...this.elements.keys()].sort((a, b) => a - b);
  }

  bytes(tag: number): Uint8Array | undefined {
    const e = this.elements.get(tag);
    if (!e || e.items) return undefined;
    return this.ctx.bytes.subarray(e.offset, e.offset + e.length);
  }

  sequence(tag: number): readonly DicomDataset[] | undefined {
    const e = this.elements.get(tag);
    if (!e) return undefined;
    if (e.items) return e.items;
    if (e.length === 0) return [];
    // A defined-length sequence read as UN (implicit VR, tag not in the
    // dictionary): its value is an implicit VR item list.
    if (e.vr === 'UN') {
      try {
        return readItems(this.ctx, e.offset, e.offset + e.length, false);
      } catch {
        return undefined;
      }
    }
    return undefined;
  }

  strings(tag: number): readonly string[] | undefined {
    const e = this.elements.get(tag);
    if (!e || e.items || e.length === 0) return undefined;
    const vr = effectiveVr(tag, e.vr);
    if (!TEXT_VRS.has(vr) && vr !== 'UN') {
      const n = this.numbers(tag);
      return n?.map(String);
    }
    const raw = this.ctx.decoder.decode(this.ctx.bytes.subarray(e.offset, e.offset + e.length));
    const parts = SINGLE_TEXT_VRS.has(vr) ? [raw] : raw.split('\\');
    const out = parts.map((p) => p.replace(/[\0 ]+$/, '').replace(/^ +/, ''));
    return out.length === 1 && out[0] === '' ? undefined : out;
  }

  numbers(tag: number): readonly number[] | undefined {
    const e = this.elements.get(tag);
    if (!e || e.items || e.length === 0) return undefined;
    const vr = effectiveVr(tag, e.vr);
    const { view } = this.ctx;
    const o = e.offset;
    const n = e.length;
    const out: number[] = [];
    switch (vr) {
      case 'DS':
      case 'IS': {
        const s = this.strings(tag);
        return s?.map((x) => (x === '' ? NaN : Number(x)));
      }
      case 'US':
        for (let i = 0; i + 2 <= n; i += 2) out.push(view.getUint16(o + i, true));
        return out;
      case 'SS':
        for (let i = 0; i + 2 <= n; i += 2) out.push(view.getInt16(o + i, true));
        return out;
      case 'UL':
      case 'OL':
        for (let i = 0; i + 4 <= n; i += 4) out.push(view.getUint32(o + i, true));
        return out;
      case 'SL':
        for (let i = 0; i + 4 <= n; i += 4) out.push(view.getInt32(o + i, true));
        return out;
      case 'FL':
      case 'OF':
        for (let i = 0; i + 4 <= n; i += 4) out.push(view.getFloat32(o + i, true));
        return out;
      case 'FD':
      case 'OD':
        for (let i = 0; i + 8 <= n; i += 8) out.push(view.getFloat64(o + i, true));
        return out;
      case 'UV':
      case 'OV':
        for (let i = 0; i + 8 <= n; i += 8) out.push(Number(view.getBigUint64(o + i, true)));
        return out;
      case 'SV':
        for (let i = 0; i + 8 <= n; i += 8) out.push(Number(view.getBigInt64(o + i, true)));
        return out;
      case 'AT':
        for (let i = 0; i + 4 <= n; i += 4) {
          out.push(((view.getUint16(o + i, true) << 16) | view.getUint16(o + i + 2, true)) >>> 0);
        }
        return out;
      default:
        return undefined;
    }
  }
}

/** The VR to decode with: the encoded one, or the dictionary's when the encoding said UN. */
function effectiveVr(tag: number, vr: Vr): Vr {
  if (vr !== 'UN') return vr;
  return IMPLICIT_VR.get(tag) ?? 'UN';
}

function need(ctx: Ctx, pos: number, n: number): void {
  if (pos + n > ctx.bytes.length) throw new Truncated();
}

function readTag(ctx: Ctx, pos: number): number {
  need(ctx, pos, 4);
  return ((ctx.view.getUint16(pos, true) << 16) | ctx.view.getUint16(pos + 2, true)) >>> 0;
}

interface Header {
  readonly tag: number;
  readonly vr: Vr;
  readonly length: number;
  /** Offset of the value. */
  readonly valueOffset: number;
}

function readHeader(ctx: Ctx, pos: number, explicit: boolean): Header {
  const tag = readTag(ctx, pos);
  if (tag === ITEM || tag === ITEM_DELIMITER || tag === SEQUENCE_DELIMITER) {
    need(ctx, pos, 8);
    return { tag, vr: 'UN', length: ctx.view.getUint32(pos + 4, true), valueOffset: pos + 8 };
  }
  if (explicit) {
    need(ctx, pos, 8);
    const vrStr = String.fromCharCode(ctx.bytes[pos + 4]!, ctx.bytes[pos + 5]!);
    if (!KNOWN_VRS.has(vrStr)) {
      throw new DicomParseError(`unknown VR '${vrStr}' at ${formatTag(tag)} (offset ${pos})`);
    }
    const vr = vrStr as Vr;
    if (LONG_VRS.has(vr)) {
      need(ctx, pos, 12);
      return { tag, vr, length: ctx.view.getUint32(pos + 8, true), valueOffset: pos + 12 };
    }
    return { tag, vr, length: ctx.view.getUint16(pos + 6, true), valueOffset: pos + 8 };
  }
  need(ctx, pos, 8);
  const length = ctx.view.getUint32(pos + 4, true);
  const vr: Vr = IMPLICIT_VR.get(tag) ?? (length === UNDEFINED ? 'SQ' : 'UN');
  return { tag, vr, length, valueOffset: pos + 8 };
}

interface ParseResult {
  readonly dataset: Part10Dataset;
  readonly end: number;
  readonly pixelData: PixelDataInfo | undefined;
  readonly truncated: boolean;
}

/**
 * Parses elements from `pos` until `end`, a delimiter (when `stopAtDelimiter`),
 * or `untilTag`. Returns the position after the last consumed byte.
 */
function readElements(
  ctx: Ctx,
  start: number,
  end: number,
  explicit: boolean,
  stopAtDelimiter: boolean,
  untilTag: number | undefined,
): ParseResult {
  const elements = new Map<number, RawElement>();
  let pos = start;
  let pixelData: PixelDataInfo | undefined;
  let truncated = false;
  try {
    while (pos < end) {
      const h = readHeader(ctx, pos, explicit);
      if (h.tag === ITEM_DELIMITER) {
        if (!stopAtDelimiter) throw new DicomParseError(`unexpected item delimiter at ${pos}`);
        pos = h.valueOffset;
        break;
      }
      if (untilTag !== undefined && h.tag >= untilTag) {
        if (h.tag === TAGS.PixelData.tag) {
          pixelData = {
            offset: h.valueOffset,
            length: h.length === UNDEFINED ? undefined : h.length,
            vr: h.vr,
            items: undefined,
          };
        }
        break;
      }
      if (h.length === UNDEFINED) {
        if (h.tag === TAGS.PixelData.tag) {
          const { items, next } = readFragments(ctx, h.valueOffset);
          pixelData = { offset: h.valueOffset, length: undefined, vr: h.vr, items };
          elements.set(h.tag, { vr: h.vr, offset: h.valueOffset, length: 0, items: undefined });
          pos = next;
          continue;
        }
        // SQ, or UN of undefined length (which PS3.5 6.2.2 says is implicit VR).
        const itemsExplicit = h.vr === 'UN' ? false : explicit;
        const { items, next } = readUndefinedSequence(ctx, h.valueOffset, itemsExplicit);
        elements.set(h.tag, { vr: 'SQ', offset: h.valueOffset, length: 0, items });
        pos = next;
        continue;
      }
      need(ctx, h.valueOffset, h.length);
      if (h.vr === 'SQ') {
        const items = readItems(ctx, h.valueOffset, h.valueOffset + h.length, explicit);
        elements.set(h.tag, { vr: 'SQ', offset: h.valueOffset, length: h.length, items });
      } else {
        elements.set(h.tag, {
          vr: h.vr,
          offset: h.valueOffset,
          length: h.length,
          items: undefined,
        });
        if (h.tag === TAGS.PixelData.tag) {
          pixelData = { offset: h.valueOffset, length: h.length, vr: h.vr, items: undefined };
        }
      }
      pos = h.valueOffset + h.length;
    }
  } catch (err) {
    if (!(err instanceof Truncated)) throw err;
    truncated = true;
  }
  return { dataset: new Part10Dataset(ctx, elements), end: pos, pixelData, truncated };
}

function readItems(ctx: Ctx, start: number, end: number, explicit: boolean): Part10Dataset[] {
  const items: Part10Dataset[] = [];
  let pos = start;
  while (pos < end) {
    const h = readHeader(ctx, pos, explicit);
    if (h.tag === SEQUENCE_DELIMITER) break;
    if (h.tag !== ITEM)
      throw new DicomParseError(`expected item at ${pos}, got ${formatTag(h.tag)}`);
    if (h.length === UNDEFINED) {
      const r = readElements(ctx, h.valueOffset, ctx.bytes.length, explicit, true, undefined);
      if (r.truncated) throw new Truncated();
      items.push(r.dataset);
      pos = r.end;
    } else {
      need(ctx, h.valueOffset, h.length);
      const r = readElements(
        ctx,
        h.valueOffset,
        h.valueOffset + h.length,
        explicit,
        false,
        undefined,
      );
      items.push(r.dataset);
      pos = h.valueOffset + h.length;
    }
  }
  return items;
}

function readUndefinedSequence(
  ctx: Ctx,
  start: number,
  explicit: boolean,
): { items: Part10Dataset[]; next: number } {
  const items: Part10Dataset[] = [];
  let pos = start;
  for (;;) {
    const h = readHeader(ctx, pos, explicit);
    if (h.tag === SEQUENCE_DELIMITER) return { items, next: h.valueOffset };
    if (h.tag !== ITEM)
      throw new DicomParseError(`expected item at ${pos}, got ${formatTag(h.tag)}`);
    if (h.length === UNDEFINED) {
      const r = readElements(ctx, h.valueOffset, ctx.bytes.length, explicit, true, undefined);
      if (r.truncated) throw new Truncated();
      items.push(r.dataset);
      pos = r.end;
    } else {
      need(ctx, h.valueOffset, h.length);
      const r = readElements(
        ctx,
        h.valueOffset,
        h.valueOffset + h.length,
        explicit,
        false,
        undefined,
      );
      items.push(r.dataset);
      pos = h.valueOffset + h.length;
    }
  }
}

/** Walks encapsulated pixel data: the offset table item, then one item per fragment. */
function readFragments(ctx: Ctx, start: number): { items: ByteRange[]; next: number } {
  const items: ByteRange[] = [];
  let pos = start;
  for (;;) {
    need(ctx, pos, 8);
    const tag = readTag(ctx, pos);
    const length = ctx.view.getUint32(pos + 4, true);
    if (tag === SEQUENCE_DELIMITER) return { items, next: pos + 8 };
    if (tag !== ITEM) throw new DicomParseError(`expected fragment item at ${pos}`);
    need(ctx, pos + 8, length);
    items.push({ offset: pos + 8, length });
    pos += 8 + length;
  }
}

function decoderFor(charset: readonly string[] | undefined): TextDecoder {
  // PoC scope: UTF-8 (ISO_IR 192) and the single-byte default/Latin-1.
  // Other character sets (ISO 2022 escapes, GB18030, …) are a known gap.
  if (charset?.some((c) => c === 'ISO_IR 192')) return new TextDecoder('utf-8');
  return new TextDecoder('latin1');
}

/**
 * Reads a DICOM Part 10 file (or a raw implicit VR dataset without a meta
 * header). Supports implicit and explicit VR little endian, with native or
 * encapsulated pixel data; rejects big endian and deflated datasets with a
 * {@link DicomParseError}.
 *
 * Input may be truncated (an HTTP Range prefix of the file): parsing stops at
 * the end of the bytes and `truncated` is set.
 */
export function readPart10(bytes: Uint8Array, options: Part10ReadOptions = {}): Part10File {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let ctx: Ctx = { bytes, view, decoder: new TextDecoder('latin1') };
  let pos = 0;
  const hasPreamble =
    bytes.length >= 132 &&
    bytes[128] === 0x44 &&
    bytes[129] === 0x49 &&
    bytes[130] === 0x43 &&
    bytes[131] === 0x4d;
  if (hasPreamble) pos = 132;

  // File meta information: group 0002, always explicit VR little endian.
  let metaEnd = pos;
  const metaGroup = bytes.length >= pos + 2 && view.getUint16(pos, true) === 0x0002;
  let meta: Part10Dataset = new Part10Dataset(ctx, new Map());
  if (metaGroup) {
    // Parse only group 0002: find its extent by walking headers.
    let p = pos;
    while (p + 8 <= bytes.length && view.getUint16(p, true) === 0x0002) {
      const h = readHeader(ctx, p, true);
      p = h.valueOffset + h.length;
    }
    meta = readElements(ctx, pos, p, true, false, undefined).dataset;
    metaEnd = p;
  }
  const ts = meta.strings(TAGS.TransferSyntaxUID.tag)?.[0] ?? TransferSyntax.ImplicitVRLittleEndian;
  if (ts === TransferSyntax.ExplicitVRBigEndian) {
    throw new DicomParseError('Explicit VR Big Endian (retired) is not supported');
  }
  if (ts === TransferSyntax.DeflatedExplicitVRLittleEndian) {
    throw new DicomParseError('Deflated Explicit VR Little Endian is not supported by readPart10');
  }
  const explicit = ts !== TransferSyntax.ImplicitVRLittleEndian;

  // Pick the text decoder from Specific Character Set before decoding anything.
  const probe = readElements(ctx, metaEnd, bytes.length, explicit, false, 0x00080006);
  ctx = { bytes, view, decoder: decoderFor(probe.dataset.strings(TAGS.SpecificCharacterSet.tag)) };
  if (metaGroup) meta = readElements(ctx, pos, metaEnd, true, false, undefined).dataset;

  const r = readElements(ctx, metaEnd, bytes.length, explicit, false, options.untilTag);
  return {
    source: bytes,
    transferSyntaxUid: ts,
    meta,
    dataset: r.dataset,
    pixelData: r.pixelData,
    bytesRead: r.end,
    truncated: r.truncated,
  };
}
