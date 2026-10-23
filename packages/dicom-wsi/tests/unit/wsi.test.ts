import { describe, expect, it } from 'vitest';
import { fromDicomJson, TAGS, type DicomJsonDataset } from '@osdlabel/dicom';
import { describePyramid, frameNumberFor } from '../../src/pyramid.js';
import { createWsiTileSource } from '../../src/tile-source.js';
import { ensureRgbJpeg } from '../../src/decoders.js';
import { firstMultipartPart, type FrameSource } from '../../src/frame-source.js';

const hex = (t: number): string => (t >>> 0).toString(16).padStart(8, '0').toUpperCase();
type V = { vr: string; Value: unknown[] };

function level(uid: string, w: number, h: number, extra: Record<number, V> = {}): DicomJsonDataset {
  const j: Record<string, V> = {
    [hex(TAGS.SOPInstanceUID.tag)]: { vr: 'UI', Value: [uid] },
    [hex(TAGS.SOPClassUID.tag)]: { vr: 'UI', Value: ['1.2.840.10008.5.1.4.1.1.77.1.6'] },
    [hex(TAGS.Modality.tag)]: { vr: 'CS', Value: ['SM'] },
    [hex(TAGS.ImageType.tag)]: { vr: 'CS', Value: ['DERIVED', 'PRIMARY', 'VOLUME', 'RESAMPLED'] },
    [hex(TAGS.TotalPixelMatrixColumns.tag)]: { vr: 'UL', Value: [w] },
    [hex(TAGS.TotalPixelMatrixRows.tag)]: { vr: 'UL', Value: [h] },
    [hex(TAGS.Columns.tag)]: { vr: 'US', Value: [240] },
    [hex(TAGS.Rows.tag)]: { vr: 'US', Value: [240] },
    [hex(TAGS.NumberOfFrames.tag)]: { vr: 'IS', Value: [Math.ceil(w / 240) * Math.ceil(h / 240)] },
    [hex(TAGS.DimensionOrganizationType.tag)]: { vr: 'CS', Value: ['TILED_FULL'] },
    [hex(TAGS.PhotometricInterpretation.tag)]: { vr: 'CS', Value: ['RGB'] },
  };
  for (const [k, v] of Object.entries(extra)) j[hex(Number(k))] = v;
  return j as unknown as DicomJsonDataset;
}

const instances = [
  {
    dataset: fromDicomJson(level('base', 17927, 6985)),
    transferSyntaxUid: '1.2.840.10008.1.2.4.50',
  },
  { dataset: fromDicomJson(level('l4', 4481, 1746)), transferSyntaxUid: '1.2.840.10008.1.2.4.50' },
  {
    dataset: fromDicomJson(
      level('label', 500, 300, {
        [TAGS.ImageType.tag]: { vr: 'CS', Value: ['ORIGINAL', 'PRIMARY', 'LABEL', 'NONE'] },
      }),
    ),
  },
];

describe('describePyramid', () => {
  it('keeps VOLUME levels in ascending resolution with their true downsample', () => {
    const p = describePyramid(instances);
    expect(p.levels.map((l) => l.sopInstanceUid)).toEqual(['l4', 'base']);
    expect(p.levels[0]!.downsample).toBeCloseTo(4.0007, 3);
    expect(p.associated).toEqual({ LABEL: 'label' });
    expect(p.notes).toEqual([]);
  });

  it('numbers TILED_FULL frames row-major, 1-based', () => {
    const base = describePyramid(instances).levels[1]!;
    expect(base.tilesAcross).toBe(75);
    expect(frameNumberFor(base, 0, 0)).toBe(1);
    expect(frameNumberFor(base, 74, 0)).toBe(75);
    expect(frameNumberFor(base, 0, 1)).toBe(76);
    expect(frameNumberFor(base, 75, 0)).toBeUndefined();
  });

  it('maps TILED_SPARSE frames by Plane Position (Slide)', () => {
    const pos = (c: number, r: number): unknown => ({
      [hex(TAGS.PlanePositionSlideSequence.tag)]: {
        vr: 'SQ',
        Value: [
          {
            [hex(TAGS.ColumnPositionInTotalImagePixelMatrix.tag)]: { vr: 'SL', Value: [c] },
            [hex(TAGS.RowPositionInTotalImagePixelMatrix.tag)]: { vr: 'SL', Value: [r] },
          },
        ],
      },
    });
    const sparse = fromDicomJson(
      level('sp', 480, 480, {
        [TAGS.DimensionOrganizationType.tag]: { vr: 'CS', Value: ['TILED_SPARSE'] },
        [TAGS.PerFrameFunctionalGroupsSequence.tag]: {
          vr: 'SQ',
          Value: [pos(241, 1), pos(1, 241)],
        },
      }),
    );
    const l = describePyramid([{ dataset: sparse }]).levels[0]!;
    expect(frameNumberFor(l, 1, 0)).toBe(1);
    expect(frameNumberFor(l, 0, 1)).toBe(2);
    expect(frameNumberFor(l, 0, 0)).toBeUndefined();
  });
});

describe('createWsiTileSource', () => {
  const pyramid = describePyramid(instances);
  const frames: FrameSource = {
    instances: async () => instances,
    frame: async () => ({ bytes: new Uint8Array(0), transferSyntaxUid: '1.2.840.10008.1.2.4.50' }),
  };
  const ts = createWsiTileSource({ pyramid, frames });

  it('maps OSD levels 1:1 onto DICOM levels with their real scale', () => {
    expect(ts.maxLevel).toBe(1);
    expect(ts.getLevelScale(1)).toBe(1);
    expect(ts.getLevelScale(0)).toBeCloseTo(4481 / 17927, 12);
    expect(ts.getTileWidth(0)).toBe(240);
    expect(ts.getTileUrl(1, 2, 1)).toBe('dicom-wsi:base/frames/78');
  });

  it('reports a TILED_SPARSE hole as a failed tile instead of fetching', () => {
    const sparse = describePyramid([
      {
        dataset: fromDicomJson(
          level('sp', 480, 480, {
            [TAGS.DimensionOrganizationType.tag]: { vr: 'CS', Value: ['TILED_SPARSE'] },
          }),
        ),
      },
    ]);
    const t = createWsiTileSource({ pyramid: sparse, frames });
    let error: string | undefined;
    t.downloadTileStart({
      tile: { level: 0, x: 0, y: 0 },
      userData: {},
      finish: (_d, _r, e) => void (error = e),
    });
    expect(error).toMatch(/not stored/);
  });
});

describe('helpers', () => {
  it('inserts an Adobe APP14 (transform 0) marker into a bare RGB JPEG', () => {
    const bare = new Uint8Array([0xff, 0xd8, 0xff, 0xdb, 0x00, 0x02, 0xff, 0xda]);
    const fixed = ensureRgbJpeg(bare);
    expect(fixed[2]).toBe(0xff);
    expect(fixed[3]).toBe(0xee);
    expect(ensureRgbJpeg(fixed)).toBe(fixed);
  });

  it('extracts the first part of a multipart/related body', () => {
    const body = new TextEncoder().encode(
      '--b\r\nContent-Type: application/octet-stream\r\n\r\nPAYLOAD\r\n--b--\r\n',
    );
    const part = firstMultipartPart(
      body,
      'multipart/related; type="application/octet-stream"; boundary=b',
    );
    expect(new TextDecoder().decode(part)).toBe('PAYLOAD');
  });
});
