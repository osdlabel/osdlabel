import { num } from './dataset.js';
import type { ByteRange, Part10File } from './part10-reader.js';
import { DicomParseError } from './part10-reader.js';
import { TAGS } from './tags.js';

/** Byte ranges making up one frame (encapsulated frames may span fragments). */
export type FrameBytes = readonly ByteRange[];

/** How the frame index was derived — reported because it decides what a Range-only client can do. */
export type FrameIndexMethod =
  | 'native'
  | 'extended-offset-table'
  | 'basic-offset-table'
  | 'one-fragment-per-frame'
  | 'single-frame';

export interface FrameIndex {
  readonly method: FrameIndexMethod;
  readonly frames: readonly FrameBytes[];
}

/**
 * Locates every frame's bytes in a fully read Part 10 file.
 *
 * Native pixel data is sliced by frame size. Encapsulated pixel data uses, in
 * order: the Extended Offset Table, a non-empty Basic Offset Table, one
 * fragment per frame, or (single-frame) all fragments. Anything else would
 * need a codec-aware scan for frame boundaries and is rejected.
 */
export function indexFrames(file: Part10File): FrameIndex {
  const ds = file.dataset;
  const px = file.pixelData;
  if (!px) throw new DicomParseError('no Pixel Data');
  const frameCount = num(ds, TAGS.NumberOfFrames.tag) ?? 1;
  if (px.length !== undefined) {
    const rows = num(ds, TAGS.Rows.tag) ?? 0;
    const cols = num(ds, TAGS.Columns.tag) ?? 0;
    const spp = num(ds, TAGS.SamplesPerPixel.tag) ?? 1;
    const bits = num(ds, TAGS.BitsAllocated.tag) ?? 8;
    const frameBits = rows * cols * spp * bits;
    if (frameBits % 8 !== 0) {
      throw new DicomParseError('native frames that are not byte aligned (1-bit) are not indexed');
    }
    const size = frameBits / 8;
    const frames: FrameBytes[] = [];
    for (let i = 0; i < frameCount; i++)
      frames.push([{ offset: px.offset + i * size, length: size }]);
    return { method: 'native', frames };
  }
  const items = px.items;
  if (!items || items.length === 0)
    throw new DicomParseError('encapsulated pixel data has no items');
  const bot = items[0]!;
  const fragments = items.slice(1);

  const eot = ds.numbers(TAGS.ExtendedOffsetTable.tag);
  const eotLengths = ds.numbers(TAGS.ExtendedOffsetTableLengths.tag);
  if (eot && eotLengths && eot.length === frameCount && eotLengths.length === frameCount) {
    // Offsets are relative to the first byte of the first fragment's item tag.
    const base = (fragments[0]?.offset ?? 0) - 8;
    const frames = eot.map((o, i) => [{ offset: base + o + 8, length: eotLengths[i]! - 8 }]);
    return { method: 'extended-offset-table', frames };
  }

  if (bot.length > 0) {
    const offsets = readBot(file, bot);
    const base = (fragments[0]?.offset ?? 0) - 8;
    // Map each fragment to the frame whose BOT offset it starts at or after.
    const frames: ByteRange[][] = offsets.map(() => []);
    let f = 0;
    for (const frag of fragments) {
      const rel = frag.offset - 8 - base;
      while (f + 1 < offsets.length && rel >= offsets[f + 1]!) f++;
      frames[f]!.push(frag);
    }
    return { method: 'basic-offset-table', frames };
  }
  if (fragments.length === frameCount) {
    return { method: 'one-fragment-per-frame', frames: fragments.map((x) => [x]) };
  }
  if (frameCount === 1) return { method: 'single-frame', frames: [fragments] };
  throw new DicomParseError(
    `${fragments.length} fragments for ${frameCount} frames and no offset table`,
  );
}

function readBot(file: Part10File, bot: ByteRange): number[] {
  // The BOT is a list of UL offsets; we need the raw file bytes it lives in.
  const src = file.source;
  const view = new DataView(src.buffer, src.byteOffset + bot.offset, bot.length);
  const out: number[] = [];
  for (let i = 0; i + 4 <= bot.length; i += 4) out.push(view.getUint32(i, true));
  return out;
}

/** Concatenates a frame's byte ranges out of the file bytes (no copy for the one-range case). */
export function frameData(bytes: Uint8Array, frame: FrameBytes): Uint8Array {
  if (frame.length === 1) {
    const r = frame[0]!;
    return bytes.subarray(r.offset, r.offset + r.length);
  }
  const total = frame.reduce((n, r) => n + r.length, 0);
  const out = new Uint8Array(total);
  let p = 0;
  for (const r of frame) {
    out.set(bytes.subarray(r.offset, r.offset + r.length), p);
    p += r.length;
  }
  return out;
}
