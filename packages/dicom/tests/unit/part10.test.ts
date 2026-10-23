import { describe, expect, it } from 'vitest';
import { readPart10, TransferSyntax } from '../../src/part10-reader.js';
import { el, formatDS, seq, writePart10 } from '../../src/part10-writer.js';
import { indexFrames, frameData } from '../../src/frames.js';
import { toDicomJson, fromDicomJson } from '../../src/dicom-json.js';
import { toWriteDataset } from '../../src/copy.js';
import { TAGS } from '../../src/tags.js';

const SOP = { sopClassUid: '1.2.840.10008.5.1.4.1.1.7', sopInstanceUid: '1.2.3.4' };

function sample(): Uint8Array {
  return writePart10(
    [
      el('SOPClassUID', SOP.sopClassUid),
      el('SOPInstanceUID', SOP.sopInstanceUid),
      el('PatientName', 'Doe^Jane'),
      el('Rows', 2),
      el('Columns', 3),
      el('PixelSpacing', [0.5, 0.25]),
      el('WindowCenter', [40, -600]),
      el('ImageType', ['ORIGINAL', 'PRIMARY', 'AXIAL']),
      seq('SequenceOfUltrasoundRegions', [
        [
          el('PhysicalDeltaX', 0.01),
          el('RegionLocationMinX0', 5),
          el('PhysicalUnitsXDirection', 3),
        ],
        [el('PhysicalDeltaX', 0.02)],
      ]),
      el('FrameIncrementPointer', TAGS.FrameTime.tag),
      el('PixelData', new Uint8Array([1, 2, 3, 4, 5, 6]), 'OB'),
    ],
    SOP,
  );
}

describe('Part 10 round trip (writer → reader)', () => {
  it('reads back strings, numbers, binary values and sequences', () => {
    const f = readPart10(sample());
    expect(f.transferSyntaxUid).toBe(TransferSyntax.ExplicitVRLittleEndian);
    expect(f.meta.strings(TAGS.MediaStorageSOPInstanceUID.tag)).toEqual(['1.2.3.4']);
    const d = f.dataset;
    expect(d.strings(TAGS.PatientName.tag)).toEqual(['Doe^Jane']);
    expect(d.numbers(TAGS.Rows.tag)).toEqual([2]);
    expect(d.numbers(TAGS.PixelSpacing.tag)).toEqual([0.5, 0.25]);
    expect(d.numbers(TAGS.WindowCenter.tag)).toEqual([40, -600]);
    expect(d.strings(TAGS.ImageType.tag)).toEqual(['ORIGINAL', 'PRIMARY', 'AXIAL']);
    const regions = d.sequence(TAGS.SequenceOfUltrasoundRegions.tag);
    expect(regions).toHaveLength(2);
    expect(regions![0]!.numbers(TAGS.PhysicalDeltaX.tag)).toEqual([0.01]);
    expect(regions![0]!.numbers(TAGS.RegionLocationMinX0.tag)).toEqual([5]);
    expect(regions![1]!.numbers(TAGS.PhysicalDeltaX.tag)).toEqual([0.02]);
    expect(d.numbers(TAGS.FrameIncrementPointer.tag)).toEqual([TAGS.FrameTime.tag]);
    expect(f.pixelData?.length).toBe(6);
    expect(f.truncated).toBe(false);
  });

  it('stops at untilTag and still reports where Pixel Data starts', () => {
    const f = readPart10(sample(), { untilTag: TAGS.PixelData.tag });
    expect(f.dataset.has(TAGS.PixelData.tag)).toBe(false);
    expect(f.pixelData).toBeDefined();
    expect(f.pixelData!.length).toBe(6);
  });

  it('parses a truncated prefix (an HTTP Range fetch) without throwing', () => {
    const bytes = sample();
    const f = readPart10(bytes.subarray(0, bytes.length - 20));
    expect(f.truncated).toBe(true);
    expect(f.dataset.strings(TAGS.PatientName.tag)).toEqual(['Doe^Jane']);
  });

  it('indexes native frames', () => {
    const f = readPart10(sample());
    const idx = indexFrames(f);
    expect(idx.method).toBe('native');
    expect([...frameData(f.source, idx.frames[0]!)]).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it('reads implicit VR little endian, including a defined-length sequence', () => {
    // (0028,0010) US 2 | (0018,6011) SQ, defined length, one item with (0018,602C) FD
    const parts: number[] = [];
    const u16 = (v: number): void => void parts.push(v & 0xff, v >> 8);
    const u32 = (v: number): void =>
      void parts.push(v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, v >>> 24);
    u16(0x0028);
    u16(0x0010);
    u32(2);
    u16(512);
    const fd = new Uint8Array(new Float64Array([0.125]).buffer);
    const itemBody = [0x18, 0x00, 0x2c, 0x60, 8, 0, 0, 0, ...fd];
    u16(0x0018);
    u16(0x6011);
    u32(8 + itemBody.length);
    u16(0xfffe);
    u16(0xe000);
    u32(itemBody.length);
    parts.push(...itemBody);
    const f = readPart10(new Uint8Array(parts));
    expect(f.transferSyntaxUid).toBe(TransferSyntax.ImplicitVRLittleEndian);
    expect(f.dataset.numbers(TAGS.Rows.tag)).toEqual([512]);
    const items = f.dataset.sequence(TAGS.SequenceOfUltrasoundRegions.tag);
    expect(items?.[0]?.numbers(TAGS.PhysicalDeltaX.tag)).toEqual([0.125]);
  });

  it('indexes encapsulated frames from the Basic Offset Table', () => {
    const frag1 = new Uint8Array([0xff, 0xd8, 1, 2]);
    const frag2 = new Uint8Array([0xff, 0xd8, 3, 4, 5, 6]);
    const items = (len: number): number[] => [
      0xfe,
      0xff,
      0x00,
      0xe0,
      len & 0xff,
      (len >> 8) & 0xff,
      0,
      0,
    ];
    const bot = [0, 0, 0, 0, 12, 0, 0, 0];
    const pixel = new Uint8Array([
      ...items(8),
      ...bot,
      ...items(4),
      ...frag1,
      ...items(6),
      ...frag2,
      0xfe,
      0xff,
      0xdd,
      0xe0,
      0,
      0,
      0,
      0,
    ]);
    const header = writePart10([el('NumberOfFrames', 2), el('Rows', 1), el('Columns', 1)], {
      ...SOP,
    });
    // Append an encapsulated (undefined length) Pixel Data element by hand.
    const px = new Uint8Array([0xe0, 0x7f, 0x10, 0x00, 0x4f, 0x42, 0, 0, 0xff, 0xff, 0xff, 0xff]);
    const all = new Uint8Array(header.length + px.length + pixel.length);
    all.set(header);
    all.set(px, header.length);
    all.set(pixel, header.length + px.length);
    const f = readPart10(all);
    const idx = indexFrames(f);
    expect(idx.method).toBe('basic-offset-table');
    expect([...frameData(f.source, idx.frames[0]!)]).toEqual([...frag1]);
    expect([...frameData(f.source, idx.frames[1]!)]).toEqual([...frag2]);
  });
});

describe('formatDS', () => {
  it('keeps values within 16 characters', () => {
    for (const x of [
      0,
      1,
      -1,
      0.1,
      1 / 3,
      123456789.123456789,
      -0.000012345678912345,
      1e-20,
      6.02e23,
    ]) {
      const s = formatDS(x);
      expect(s.length).toBeLessThanOrEqual(16);
      expect(Math.abs(Number(s) - x)).toBeLessThanOrEqual(Math.abs(x) * 1e-10 + 1e-30);
    }
  });
});

describe('DICOM JSON', () => {
  it('round-trips a Part 10 dataset through toDicomJson / fromDicomJson', () => {
    const f = readPart10(sample());
    const j = toDicomJson(f.dataset, { bulkDataUri: () => 'bulk' });
    const back = fromDicomJson(j);
    expect(back.strings(TAGS.PatientName.tag)).toEqual(['Doe^Jane']);
    expect(back.numbers(TAGS.PixelSpacing.tag)).toEqual([0.5, 0.25]);
    expect(back.numbers(TAGS.FrameIncrementPointer.tag)).toEqual([TAGS.FrameTime.tag]);
    expect(
      back.sequence(TAGS.SequenceOfUltrasoundRegions.tag)?.[1]?.numbers(TAGS.PhysicalDeltaX.tag),
    ).toEqual([0.02]);
    expect(j['7FE00010']).toEqual({ vr: 'OB', BulkDataURI: 'bulk' });
  });

  it('toWriteDataset re-encodes a parsed dataset losslessly', () => {
    const f = readPart10(sample());
    const again = readPart10(writePart10(toWriteDataset(f.dataset), SOP));
    expect(again.dataset.strings(TAGS.PatientName.tag)).toEqual(['Doe^Jane']);
    expect(again.dataset.sequence(TAGS.SequenceOfUltrasoundRegions.tag)).toHaveLength(2);
    expect(again.pixelData?.length).toBe(6);
  });
});
