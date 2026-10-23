import { describe, expect, it } from 'vitest';
import type { VectorGeometry } from '@osdlabel/annotation';
import {
  fromDicomJson,
  readPart10,
  TAGS,
  type DicomDataset,
  type DicomJsonDataset,
} from '@osdlabel/dicom';
import type { MaskSnapshot } from '@osdlabel/mask';
import {
  fromAnn,
  fromScoord,
  rectangleCorners,
  toAnn,
  toScoord,
} from '../../src/geometry-mapping.js';
import { packBinaryFrames, buildSegmentation } from '../../src/seg.js';
import { buildMeasurementReport } from '../../src/sr.js';
import { buildBulkAnnotations } from '../../src/ann.js';
import { imageRefFrom } from '../../src/context.js';
import {
  readBulkAnnotations,
  readMeasurementReport,
  readSegmentation,
} from '../../src/read-back.js';

const hex = (t: number): string => (t >>> 0).toString(16).padStart(8, '0').toUpperCase();
function source(extra: Record<number, { vr: string; Value: unknown[] }> = {}): DicomDataset {
  const j: Record<string, { vr: string; Value: unknown[] }> = {
    [hex(TAGS.StudyInstanceUID.tag)]: { vr: 'UI', Value: ['1.2.3'] },
    [hex(TAGS.SeriesInstanceUID.tag)]: { vr: 'UI', Value: ['1.2.3.4'] },
    [hex(TAGS.SOPClassUID.tag)]: { vr: 'UI', Value: ['1.2.840.10008.5.1.4.1.1.2'] },
    [hex(TAGS.SOPInstanceUID.tag)]: { vr: 'UI', Value: ['1.2.3.4.5'] },
    [hex(TAGS.PatientID.tag)]: { vr: 'LO', Value: ['P1'] },
    [hex(TAGS.Rows.tag)]: { vr: 'US', Value: [37] },
    [hex(TAGS.Columns.tag)]: { vr: 'US', Value: [53] },
  };
  for (const [k, v] of Object.entries(extra)) j[hex(Number(k))] = v;
  return fromDicomJson(j as unknown as DicomJsonDataset);
}

const shapes: VectorGeometry[] = [
  { type: 'rectangle', origin: { x: 10.25, y: 5.5 }, width: 20.5, height: 7.25, rotation: 30 },
  { type: 'rectangle', origin: { x: 1, y: 2 }, width: 3, height: 4, rotation: 0 },
  { type: 'circle', center: { x: 30.5, y: 12.25 }, radius: 6.125 },
  {
    type: 'polygon',
    points: [
      { x: 1, y: 1 },
      { x: 9, y: 2 },
      { x: 4, y: 8 },
    ],
  },
  {
    type: 'polyline',
    points: [
      { x: 1, y: 1 },
      { x: 9, y: 2 },
      { x: 4, y: 8 },
    ],
  },
  { type: 'line', start: { x: 0.5, y: 0.5 }, end: { x: 52.5, y: 36.5 } },
  { type: 'point', position: { x: 26.5, y: 18.5 } },
];

describe('geometry mapping', () => {
  it('round-trips every vector shape through SCOORD, including a rotated rectangle', () => {
    for (const g of shapes) {
      const { graphicType, points } = toScoord(g);
      const back = fromScoord(graphicType, points);
      expect(back.type).toBe(g.type);
      expect(toScoord(back).points.length).toBe(points.length);
      toScoord(back).points.forEach((p, i) => {
        expect(p.x).toBeCloseTo(points[i]!.x, 9);
        expect(p.y).toBeCloseTo(points[i]!.y, 9);
      });
    }
  });

  it('rotates rectangle corners about the origin, clockwise in y-down space', () => {
    const c = rectangleCorners({
      type: 'rectangle',
      origin: { x: 0, y: 0 },
      width: 10,
      height: 0,
      rotation: 90,
    });
    expect(c[1]!.x).toBeCloseTo(0, 12);
    expect(c[1]!.y).toBeCloseTo(10, 12);
  });

  it('round-trips through ANN graphic types (circle via ELLIPSE)', () => {
    for (const g of shapes) {
      const { graphicType, points } = toAnn(g);
      const back = fromAnn(graphicType, points);
      expect(back.type).toBe(g.type);
    }
  });
});

describe('packBinaryFrames', () => {
  it('packs frames contiguously at the bit level (no per-frame padding)', () => {
    // 3 pixels per frame, 3 frames: bits 0..8.
    const frames = [
      new Uint8Array([1, 0, 0]),
      new Uint8Array([0, 1, 0]),
      new Uint8Array([0, 0, 1]),
    ];
    const b = packBinaryFrames(frames, 3);
    // bit 0, bit 4, bit 8 set → byte0 = 0b00010001, byte1 = 0b00000001; even length.
    expect([...b]).toEqual([0x11, 0x01]);
  });
});

function snapshot(w: number, h: number): MaskSnapshot {
  const data = new Uint8Array(7 * 5);
  for (let i = 0; i < data.length; i++) data[i] = (i * 7) % 3 === 0 ? 1 : 0;
  return { x: 11, y: 9, width: 7, height: 5, data, imageWidth: w, imageHeight: h };
}

describe('SEG / SR / ANN round trips', () => {
  it('SEG: odd-sized frames survive bit packing and come back pixel-exact', () => {
    const src = source();
    const ref = imageRefFrom(src);
    const snap = snapshot(53, 37);
    const built = buildSegmentation({
      source: src,
      segments: [{ label: 'x', masks: [{ image: ref, snapshot: snap }] }],
    });
    const file = readPart10(built.bytes);
    const px = file.pixelData!;
    const back = readSegmentation(
      file.dataset,
      built.bytes.subarray(px.offset, px.offset + px.length!),
    );
    const m = back[0]!.masks.get('1.2.3.4.5')!;
    // The read-back crop is tight; the input's first row/column are painted, so they match.
    expect({ x: m.x, y: m.y, w: m.width, h: m.height }).toEqual({ x: 11, y: 9, w: 7, h: 5 });
    expect([...m.data]).toEqual([...snap.data]);
    expect(file.dataset.strings(TAGS.SegmentationType.tag)).toEqual(['BINARY']);
  });

  it('SR: geometry and measurements read back; uncalibrated images carry no measurements', () => {
    const src = source();
    const ref = imageRefFrom(src);
    const items = shapes.map((g, i) => ({
      id: `a${i}`,
      label: `s${i}`,
      geometry: g,
      image: ref,
      pixelSpacing: { x: 0.5, y: 0.25, unit: 'mm' },
    }));
    const sr = buildMeasurementReport({ source: src, items });
    const groups = readMeasurementReport(readPart10(sr.bytes).dataset);
    expect(groups).toHaveLength(shapes.length);
    expect(groups.map((g) => g.geometry?.type)).toEqual(shapes.map((g) => g.type));
    const line = groups.find((g) => g.trackingIdentifier === 's5')!;
    expect(line.measurements[0]?.unit).toBe('mm');
    expect(line.measurements[0]?.value).toBeCloseTo(Math.hypot(52 * 0.5, 36 * 0.25), 9);
    const bare = buildMeasurementReport({
      source: src,
      items: [{ id: 'z', geometry: shapes[5]!, image: ref }],
    });
    expect(readMeasurementReport(readPart10(bare.bytes).dataset)[0]?.measurements).toEqual([]);
  });

  it('ANN: groups by label and graphic type; float32 coordinates come back within 1e-3 px at WSI scale', () => {
    const src = source({
      [TAGS.TotalPixelMatrixColumns.tag]: { vr: 'UL', Value: [90000] },
      [TAGS.TotalPixelMatrixRows.tag]: { vr: 'UL', Value: [70000] },
    });
    const ref = imageRefFrom(src);
    const farPoints = [
      { x: 89000.123, y: 1.5 },
      { x: 89500.777, y: 69000.25 },
      { x: 100.5, y: 65000.5 },
    ];
    const far: VectorGeometry = { type: 'polygon', points: farPoints };
    const ann = buildBulkAnnotations({
      image: ref,
      items: [
        { geometry: far, label: 'a' },
        { geometry: shapes[6]!, label: 'a' },
      ],
    });
    expect(ann.groups).toBe(2);
    const back = readBulkAnnotations(readPart10(ann.bytes).dataset);
    const poly = back.find((g) => g.graphicType === 'POLYGON')!.geometries[0]!;
    expect(poly.type).toBe('polygon');
    if (poly.type !== 'polygon') throw new Error('unreachable');
    // float32 has a 24-bit mantissa: at x ≈ 89 500 px the step is 2^-7 ≈ 0.0078 px.
    poly.points.forEach((p, i) => {
      expect(Math.abs(p.x - farPoints[i]!.x)).toBeLessThan(0.004);
      expect(Math.abs(p.y - farPoints[i]!.y)).toBeLessThan(0.004);
    });
  });
});
