import { describe, expect, it } from 'vitest';
import type { AnnotationId, Geometry } from '@osdlabel/annotation';
import type { DecorationContext, LineDecoration, TextDecoration } from '@osdlabel/decoration';
import { orthogonalPlane, type PlaneFrame, type VolumeGrid } from '@osdlabel/spatial';
import {
  createCrossViewProvider,
  createReferenceLineProvider,
  projectAnnotations,
  projectGeometry,
  type PlanarAnnotation,
} from '../../src/index.js';

const annId = (s: string): AnnotationId => s as AnnotationId;

const grid: VolumeGrid = {
  dimensions: [512, 512, 400],
  spacing: [0.7, 0.7, 1.25],
  origin: [-179, -179, -250],
  direction: [
    [1, 0, 0],
    [0, 1, 0],
    [0, 0, 1],
  ],
};
const axial = orthogonalPlane(grid, 'axial', 150);
const sagittal = orthogonalPlane(grid, 'sagittal', 100);
const coronal = orthogonalPlane(grid, 'coronal', 200);
/** Image row of axial slice 150 in the coronal / sagittal views. */
const rowOfSlice150 = ((399.5 - 150) * 1.25) / 0.7;

const ann = (id: string, geometry: Geometry, plane: PlaneFrame): PlanarAnnotation => ({
  id: annId(id),
  geometry,
  toolType:
    geometry.type === 'mask'
      ? 'segmentationBrush'
      : geometry.type === 'polygon'
        ? 'polyline'
        : geometry.type,
  createdAt: '',
  updatedAt: '',
  plane,
});

const ctx = (): DecorationContext => ({ annotations: [], selectedAnnotationId: null });

describe('projectGeometry', () => {
  it('shows an axial point as a marker only in views within half a slice', () => {
    const g: Geometry = { type: 'point', position: { x: 100.5, y: 200.5 } };
    const inSag = projectGeometry(g, axial, sagittal);
    expect(inSag).toHaveLength(1);
    const m = inSag[0]!;
    expect(m.kind).toBe('marker');
    if (m.kind !== 'marker') return;
    expect(m.at.x).toBeCloseTo(200.5, 9);
    expect(m.at.y).toBeCloseTo(rowOfSlice150, 9);
    expect(projectGeometry(g, axial, orthogonalPlane(grid, 'sagittal', 101))).toEqual([]);
  });

  it('cuts an axial polygon into a segment in the sagittal view', () => {
    const g: Geometry = {
      type: 'polygon',
      points: [
        { x: 50, y: 50 },
        { x: 150, y: 50 },
        { x: 150, y: 150 },
        { x: 50, y: 150 },
      ],
    };
    const out = projectGeometry(g, axial, sagittal);
    expect(out).toHaveLength(1);
    const s = out[0]!;
    if (s.kind !== 'segment') throw new Error('expected a segment');
    // Horizontal in the sagittal view, at the axial slice's row, spanning j = 50..150.
    expect(s.segment.start.y).toBeCloseTo(rowOfSlice150, 9);
    expect(s.segment.end.y).toBeCloseTo(rowOfSlice150, 9);
    expect(Math.abs(s.segment.end.x - s.segment.start.x)).toBeCloseTo(100, 9);
  });

  it('cuts a coronal circle into a chord in the axial view', () => {
    // Centre at coronal (256, row of slice 150) => voxel (255.5, 200, 150).
    const g: Geometry = { type: 'circle', center: { x: 256, y: rowOfSlice150 }, radius: 30 };
    const out = projectGeometry(g, coronal, axial);
    expect(out).toHaveLength(1);
    const s = out[0]!;
    if (s.kind !== 'segment') throw new Error('expected a segment');
    expect(Math.abs(s.segment.end.x - s.segment.start.x)).toBeCloseTo(60, 6);
    expect(s.segment.start.y).toBeCloseTo(200.5, 9);
  });

  it('crosses a polyline at markers and draws coplanar content as an outline', () => {
    const line: Geometry = { type: 'line', start: { x: 80, y: 100 }, end: { x: 120, y: 100 } };
    const crossing = projectGeometry(line, axial, sagittal);
    expect(crossing).toHaveLength(1);
    expect(crossing[0]!.kind).toBe('marker');
    const tri: Geometry = {
      type: 'polygon',
      points: [
        { x: 10, y: 10 },
        { x: 30, y: 10 },
        { x: 20, y: 30 },
      ],
    };
    const coplanar = projectGeometry(tri, axial, orthogonalPlane(grid, 'axial', 150));
    expect(coplanar).toHaveLength(3);
    expect(projectGeometry(tri, axial, orthogonalPlane(grid, 'axial', 151))).toEqual([]);
  });

  it('handles rotated rectangles and skips masks', () => {
    const rect: Geometry = {
      type: 'rectangle',
      origin: { x: 100.5, y: 100 },
      width: 40,
      height: 40,
      rotation: 45,
    };
    // Rotated about its origin by 45 degrees: the vertical line x = 100.5 runs
    // along the diagonal through the origin, length 40*sqrt(2).
    const out = projectGeometry(rect, axial, sagittal);
    expect(out).toHaveLength(1);
    const s = out[0]!;
    if (s.kind !== 'segment') throw new Error('expected a segment');
    expect(Math.abs(s.segment.end.x - s.segment.start.x)).toBeCloseTo(40 * Math.SQRT2, 6);
    const mask: Geometry = {
      type: 'mask',
      origin: { x: 0, y: 0 },
      width: 1,
      height: 1,
      pixelCount: 1,
    };
    expect(projectGeometry(mask, axial, sagittal)).toEqual([]);
  });
});

describe('providers', () => {
  it('emits stable, annotation-linked decorations through a plain DecorationProvider', () => {
    const annotations = [
      ann('p', { type: 'point', position: { x: 100.5, y: 200.5 } }, axial),
      ann(
        'poly',
        {
          type: 'polygon',
          points: [
            { x: 50, y: 50 },
            { x: 150, y: 50 },
            { x: 100, y: 150 },
          ],
        },
        axial,
      ),
    ];
    const provider = createCrossViewProvider(
      () => sagittal,
      () => annotations,
      { line: { stroke: 'yellow' } },
    );
    const a = provider(ctx());
    const b = provider(ctx());
    expect(a.map((d) => d.id)).toEqual(['xv:p:0', 'xv:poly:0']);
    expect(b).toEqual(a);
    const marker = a[0] as TextDecoration;
    expect(marker.type).toBe('text');
    expect(marker.placement).toBe('center');
    const seg = a[1] as LineDecoration;
    expect(seg.type).toBe('line');
    expect(seg.relatedAnnotationIds).toEqual([annId('poly')]);
    expect(seg.style).toEqual({ stroke: 'yellow' });
    expect(projectAnnotations(annotations, orthogonalPlane(grid, 'sagittal', 300))).toEqual([]);
  });

  it('draws crosshair reference lines that meet at the shared voxel', () => {
    const provider = createReferenceLineProvider(
      () => axial,
      () => [
        { key: 'sag', plane: sagittal, color: 'red' },
        { key: 'cor', plane: coronal, color: 'green' },
        { key: 'ax2', plane: orthogonalPlane(grid, 'axial', 10), color: 'blue' },
      ],
    );
    const lines = provider(ctx()) as LineDecoration[];
    expect(lines.map((l) => l.id)).toEqual(['ref:sag', 'ref:cor']);
    const [sag, cor] = lines;
    expect(sag!.start.x).toBeCloseTo(100.5, 9);
    expect(cor!.start.y).toBeCloseTo(200.5, 9);
    expect(sag!.dashed).toBe(true);
  });
});
