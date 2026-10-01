import { describe, expect, it } from 'vitest';
import {
  createDistanceProvider,
  createLabelProvider,
  createMeasurementProvider,
} from '../../src/built-in-providers.js';
import type { PixelSpacing } from '@osdlabel/viewer-api';
import type { LineDecoration, TextDecoration } from '../../src/decoration.js';
import { ann, ctx } from './test-helpers.js';

describe('createMeasurementProvider', () => {
  it('emits a single text decoration per annotation with requested metrics', () => {
    const provider = createMeasurementProvider({ area: true, radius: true });
    const a = ann('c1', 'circle', { type: 'circle', center: { x: 10, y: 10 }, radius: 5 });
    const decorations = provider(ctx([a]));
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
    const [d] = provider(ctx([a], { pixelSpacing: spacing }));
    const text = (d as TextDecoration).text;
    expect(text).toContain('mm');
    // radius: 4 * 0.5 = 2.00 mm
    expect(text).toContain('r: 2.00 mm');
    // area: π·16 px² → π·16·0.25 mm² ≈ 12.57 mm²
    expect(text).toMatch(/A: 12\.5[67] mm²/);
  });

  // #187: with 0.1 mm/px across and 0.2 mm/px down, mean spacing labelled both
  // of these 100 px lines "15.00 mm".
  it('converts line lengths per axis on anisotropic images', () => {
    const provider = createMeasurementProvider({ length: true });
    const spacing: PixelSpacing = { x: 0.1, y: 0.2, unit: 'mm' };
    const horizontal = ann('h', 'line', {
      type: 'line',
      start: { x: 0, y: 0 },
      end: { x: 100, y: 0 },
    });
    const vertical = ann('v', 'line', {
      type: 'line',
      start: { x: 0, y: 0 },
      end: { x: 0, y: 100 },
    });
    const decorations = provider(ctx([horizontal, vertical], { pixelSpacing: spacing }));
    expect(decorations).toHaveLength(2);
    const [h, v] = decorations;
    expect((h as TextDecoration).text).toBe('L: 10.00 mm');
    expect((v as TextDecoration).text).toBe('L: 20.00 mm');
  });

  it('converts polyline lengths and perimeters per axis on anisotropic images', () => {
    const provider = createMeasurementProvider({ length: true, perimeter: true });
    const spacing: PixelSpacing = { x: 0.1, y: 0.2, unit: 'mm' };
    const polyline = ann('pl', 'polyline', {
      type: 'polyline',
      points: [
        { x: 0, y: 0 },
        { x: 100, y: 0 },
        { x: 100, y: 100 },
      ],
    });
    const rect = ann('r', 'rectangle', {
      type: 'rectangle',
      origin: { x: 0, y: 0 },
      width: 100,
      height: 50,
      rotation: 0,
    });
    const decorations = provider(ctx([polyline, rect], { pixelSpacing: spacing }));
    expect(decorations).toHaveLength(2);
    const [pl, r] = decorations;
    expect((pl as TextDecoration).text).toBe('L: 30.00 mm');
    // 2·(100·0.1 + 50·0.2); mean spacing gave 2·150·0.15 = 45
    expect((r as TextDecoration).text).toBe('P: 40.00 mm');
  });

  it('keeps the mean-spacing convention for circle radius', () => {
    const provider = createMeasurementProvider({ radius: true });
    const spacing: PixelSpacing = { x: 0.1, y: 0.2, unit: 'mm' };
    const c = ann('c', 'circle', { type: 'circle', center: { x: 0, y: 0 }, radius: 100 });
    const decorations = provider(ctx([c], { pixelSpacing: spacing }));
    expect(decorations).toHaveLength(1);
    const [d] = decorations;
    expect((d as TextDecoration).text).toBe('r: 15.00 mm');
  });

  it('skips annotations whose geometry yields no requested metric', () => {
    const provider = createMeasurementProvider({ area: true });
    const point = ann('p1', 'point', { type: 'point', position: { x: 0, y: 0 } });
    const circle = ann('c1', 'circle', { type: 'circle', center: { x: 0, y: 0 }, radius: 3 });
    const decorations = provider(ctx([point, circle]));
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
    const [d] = provider(ctx([a]));
    expect(d!.id).toBe('measurement:rect-1');
  });

  it('emits length for lines when length is requested', () => {
    const provider = createMeasurementProvider({ length: true });
    const a = ann('l1', 'line', {
      type: 'line',
      start: { x: 0, y: 0 },
      end: { x: 3, y: 4 },
    });
    const [d] = provider(ctx([a]));
    expect((d as TextDecoration).text).toContain('L: 5.00 px');
  });
});

describe('createLabelProvider', () => {
  it('renders annotation.label as a text decoration', () => {
    const provider = createLabelProvider();
    const a = ann('p1', 'point', { type: 'point', position: { x: 0, y: 0 } }, 'tumor');
    const [d] = provider(ctx([a]));
    expect((d as TextDecoration).text).toBe('tumor');
    expect(d!.id).toBe('label:p1');
  });

  it('skips annotations without a label', () => {
    const provider = createLabelProvider();
    const a = ann('p1', 'point', { type: 'point', position: { x: 0, y: 0 } });
    expect(provider(ctx([a]))).toEqual([]);
  });

  it('honors a custom extractor', () => {
    const provider = createLabelProvider({ extract: () => 'CUSTOM' });
    const a = ann('p1', 'point', { type: 'point', position: { x: 0, y: 0 } });
    const [d] = provider(ctx([a]));
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
    const decorations = provider(ctx([a, b]));
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
    const decorations = provider(ctx([a, b], { pixelSpacing: spacing }));
    const label = decorations.find((d) => d.type === 'text') as TextDecoration;
    // px distance 10, * 0.5 mm/px = 5 mm
    expect(label.text).toBe('5.00 mm');
  });

  it('converts the distance per axis on anisotropic images (#187)', () => {
    const a = ann('p1', 'point', { type: 'point', position: { x: 10, y: 10 } });
    const b = ann('p2', 'point', { type: 'point', position: { x: 40, y: 30 } });
    const spacing: PixelSpacing = { x: 0.1, y: 0.2, unit: 'mm' };
    const provider = createDistanceProvider({
      pair: (anns) => [{ a: anns[0]!, b: anns[1]! }],
    });
    const decorations = provider(ctx([a, b], { pixelSpacing: spacing }));
    expect(decorations).toHaveLength(2);
    const label = decorations.find((d) => d.type === 'text') as TextDecoration;
    // hypot(30·0.1, 20·0.2) = hypot(3, 4); mean spacing gave 36.06·0.15 = 5.41
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
    const decorations = provider(ctx([a, b]));
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
    const [line] = provider(ctx([a, b])) as [LineDecoration, TextDecoration];
    // Rectangle centroids at (5,5) and (105,5)
    expect(line.start).toEqual({ x: 5, y: 5 });
    expect(line.end).toEqual({ x: 105, y: 5 });
    expect(line.id).toBe('distance-line:pairX');
  });

  it('emits no decorations when pair returns an empty list', () => {
    const a = ann('p1', 'point', { type: 'point', position: { x: 0, y: 0 } });
    const provider = createDistanceProvider({ pair: () => [] });
    expect(provider(ctx([a]))).toEqual([]);
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
    const decorations = provider(ctx([a, b]));
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
    const decorations = provider(ctx([a, b]));
    const label = decorations.find((d) => d.type === 'text') as TextDecoration;
    // defaultFormatter uses options.format → precision 1 → "5.0 px"
    expect(label.text).toBe('Distance: 5.0 px');
  });
});
