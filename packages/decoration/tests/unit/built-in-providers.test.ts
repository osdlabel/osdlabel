import { describe, expect, it } from 'vitest';
import type { Annotation, AnnotationId, ToolType } from '@osdlabel/annotation';
import type { PixelSpacing } from '@osdlabel/viewer-api';
import {
  createDistanceProvider,
  createLabelProvider,
  createMeasurementProvider,
} from '../../src/built-in-providers.js';
import type { LineDecoration, TextDecoration } from '../../src/decoration.js';

function ann(
  id: string,
  toolType: ToolType,
  geometry: Annotation['geometry'],
  label?: string,
): Annotation {
  const base = {
    id: id as AnnotationId,
    geometry,
    toolType,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  } as const;
  return label !== undefined ? { ...base, label } : base;
}

describe('createMeasurementProvider', () => {
  it('emits a single text decoration per annotation with requested metrics', () => {
    const provider = createMeasurementProvider({ area: true, radius: true });
    const a = ann('c1', 'circle', { type: 'circle', center: { x: 10, y: 10 }, radius: 5 });
    const decorations = provider({ annotations: [a] });
    expect(decorations).toHaveLength(1);
    const d = decorations[0] as TextDecoration;
    expect(d.type).toBe('text');
    expect(d.relatedAnnotationIds).toEqual(['c1']);
    expect(d.text).toContain('r:');
    expect(d.text).toContain('A:');
    // No calibration → values in px
    expect(d.text).toContain('px');
  });

  it('uses pixel spacing to render mm values', () => {
    const provider = createMeasurementProvider({ area: true, radius: true });
    const spacing: PixelSpacing = { x: 0.5, y: 0.5, unit: 'mm' };
    const a = ann('c1', 'circle', { type: 'circle', center: { x: 0, y: 0 }, radius: 4 });
    const [d] = provider({ annotations: [a], pixelSpacing: spacing });
    const text = (d as TextDecoration).text;
    expect(text).toContain('mm');
    // radius: 4 * 0.5 = 2.00 mm
    expect(text).toContain('r: 2.00 mm');
    // area: π·16 px² → π·16·0.25 mm² ≈ 12.57 mm²
    expect(text).toMatch(/A: 12\.5[67] mm²/);
  });

  it('skips annotations whose geometry yields no requested metric', () => {
    const provider = createMeasurementProvider({ area: true });
    const point = ann('p1', 'point', { type: 'point', position: { x: 0, y: 0 } });
    const circle = ann('c1', 'circle', { type: 'circle', center: { x: 0, y: 0 }, radius: 3 });
    const decorations = provider({ annotations: [point, circle] });
    expect(decorations).toHaveLength(1);
    expect(decorations[0]!.relatedAnnotationIds).toEqual(['c1']);
  });

  it('produces stable, annotation-scoped ids for diffing', () => {
    const provider = createMeasurementProvider({ area: true });
    const a = ann('rect-1', 'rectangle', {
      type: 'rectangle',
      origin: { x: 0, y: 0 },
      width: 4,
      height: 4,
      rotation: 0,
    });
    const [d] = provider({ annotations: [a] });
    expect(d!.id).toBe('measurement:rect-1');
  });

  it('emits length for lines when length is requested', () => {
    const provider = createMeasurementProvider({ length: true });
    const a = ann('l1', 'line', {
      type: 'line',
      start: { x: 0, y: 0 },
      end: { x: 3, y: 4 },
    });
    const [d] = provider({ annotations: [a] });
    expect((d as TextDecoration).text).toContain('L: 5.00 px');
  });
});

describe('createLabelProvider', () => {
  it('renders annotation.label as a text decoration', () => {
    const provider = createLabelProvider();
    const a = ann('p1', 'point', { type: 'point', position: { x: 0, y: 0 } }, 'tumor');
    const [d] = provider({ annotations: [a] });
    expect((d as TextDecoration).text).toBe('tumor');
    expect(d!.id).toBe('label:p1');
  });

  it('skips annotations without a label', () => {
    const provider = createLabelProvider();
    const a = ann('p1', 'point', { type: 'point', position: { x: 0, y: 0 } });
    expect(provider({ annotations: [a] })).toEqual([]);
  });

  it('honors a custom extractor', () => {
    const provider = createLabelProvider({ extract: () => 'CUSTOM' });
    const a = ann('p1', 'point', { type: 'point', position: { x: 0, y: 0 } });
    const [d] = provider({ annotations: [a] });
    expect((d as TextDecoration).text).toBe('CUSTOM');
  });
});

describe('createDistanceProvider', () => {
  it('emits a line + text decoration per pair', () => {
    const a = ann('p1', 'point', { type: 'point', position: { x: 0, y: 0 } });
    const b = ann('p2', 'point', { type: 'point', position: { x: 3, y: 4 } });
    const provider = createDistanceProvider({
      pair: (anns) => (anns.length === 2 ? [{ a: anns[0]!, b: anns[1]! }] : []),
    });
    const decorations = provider({ annotations: [a, b] });
    expect(decorations).toHaveLength(2);
    const line = decorations.find((d) => d.type === 'line') as LineDecoration;
    const label = decorations.find((d) => d.type === 'text') as TextDecoration;
    expect(line.start).toEqual({ x: 0, y: 0 });
    expect(line.end).toEqual({ x: 3, y: 4 });
    expect(line.dashed).toBe(true);
    expect(line.relatedAnnotationIds).toEqual(['p1', 'p2']);
    expect(label.text).toBe('5.00 px');
    expect(label.anchor).toEqual({ x: 1.5, y: 2 });
    expect(label.relatedAnnotationIds).toEqual(['p1', 'p2']);
  });

  it('uses pixelSpacing to render the distance in physical units', () => {
    const a = ann('p1', 'point', { type: 'point', position: { x: 0, y: 0 } });
    const b = ann('p2', 'point', { type: 'point', position: { x: 6, y: 8 } });
    const spacing: PixelSpacing = { x: 0.5, y: 0.5, unit: 'mm' };
    const provider = createDistanceProvider({
      pair: (anns) => [{ a: anns[0]!, b: anns[1]! }],
    });
    const decorations = provider({ annotations: [a, b], pixelSpacing: spacing });
    const label = decorations.find((d) => d.type === 'text') as TextDecoration;
    // px distance 10, * 0.5 mm/px = 5 mm
    expect(label.text).toBe('5.00 mm');
  });

  it('produces stable pair-scoped ids derived from annotation ids', () => {
    const a = ann('rect-1', 'rectangle', {
      type: 'rectangle',
      origin: { x: 0, y: 0 },
      width: 2,
      height: 2,
      rotation: 0,
    });
    const b = ann('rect-2', 'rectangle', {
      type: 'rectangle',
      origin: { x: 10, y: 10 },
      width: 2,
      height: 2,
      rotation: 0,
    });
    const provider = createDistanceProvider({
      pair: (anns) => [{ a: anns[0]!, b: anns[1]! }],
    });
    const decorations = provider({ annotations: [a, b] });
    const line = decorations.find((d) => d.type === 'line')!;
    const label = decorations.find((d) => d.type === 'text')!;
    expect(line.id).toBe('distance-line:rect-1-rect-2');
    expect(label.id).toBe('distance-text:rect-1-rect-2');
  });

  it('honors an explicit pair id and uses centroids for non-point geometries', () => {
    const a = ann('r1', 'rectangle', {
      type: 'rectangle',
      origin: { x: 0, y: 0 },
      width: 10,
      height: 10,
      rotation: 0,
    });
    const b = ann('r2', 'rectangle', {
      type: 'rectangle',
      origin: { x: 100, y: 0 },
      width: 10,
      height: 10,
      rotation: 0,
    });
    const provider = createDistanceProvider({
      pair: (anns) => [{ a: anns[0]!, b: anns[1]!, id: 'pairX' }],
    });
    const [line] = provider({ annotations: [a, b] }) as [LineDecoration, TextDecoration];
    // Rectangle centroids at (5,5) and (105,5)
    expect(line.start).toEqual({ x: 5, y: 5 });
    expect(line.end).toEqual({ x: 105, y: 5 });
    expect(line.id).toBe('distance-line:pairX');
  });

  it('emits no decorations when pair returns an empty list', () => {
    const a = ann('p1', 'point', { type: 'point', position: { x: 0, y: 0 } });
    const provider = createDistanceProvider({ pair: () => [] });
    expect(provider({ annotations: [a] })).toEqual([]);
  });

  it('honors dashed:false and a one-arg custom formatLine', () => {
    // The defaultFormatter second arg is optional; consumers can ignore it.
    const a = ann('p1', 'point', { type: 'point', position: { x: 0, y: 0 } });
    const b = ann('p2', 'point', { type: 'point', position: { x: 3, y: 4 } });
    const provider = createDistanceProvider({
      pair: (anns) => [{ a: anns[0]!, b: anns[1]! }],
      dashed: false,
      formatLine: (m) => `d=${m.value.toFixed(0)}${m.unit}`,
    });
    const decorations = provider({ annotations: [a, b] });
    const line = decorations.find((d) => d.type === 'line') as LineDecoration;
    const label = decorations.find((d) => d.type === 'text') as TextDecoration;
    expect(line.dashed).toBe(false);
    expect(label.text).toBe('d=5px');
  });

  it('passes a defaultFormatter to formatLine so consumers can wrap the standard output', () => {
    const a = ann('p1', 'point', { type: 'point', position: { x: 0, y: 0 } });
    const b = ann('p2', 'point', { type: 'point', position: { x: 3, y: 4 } });
    const provider = createDistanceProvider({
      pair: (anns) => [{ a: anns[0]!, b: anns[1]! }],
      format: { precision: 1 },
      formatLine: (m, fmt) => `Distance: ${fmt(m)}`,
    });
    const decorations = provider({ annotations: [a, b] });
    const label = decorations.find((d) => d.type === 'text') as TextDecoration;
    // defaultFormatter uses options.format → precision 1 → "5.0 px"
    expect(label.text).toBe('Distance: 5.0 px');
  });
});
