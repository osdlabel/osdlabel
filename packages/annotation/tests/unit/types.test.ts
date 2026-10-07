import { describe, it, expect } from 'vitest';
import { createAnnotationId, toolTypeToGeometryType } from '../../src/util.js';
import type { AnnotationId } from '../../src';

describe('Branded ID types', () => {
  it('createAnnotationId produces a branded value', () => {
    const id = createAnnotationId('ann-1');
    expect(id).toBe('ann-1');
    // The value is usable as a string
    const asString: string = id;
    expect(asString).toBe('ann-1');
  });

  it('branded types are not assignable from raw strings', () => {
    // @ts-expect-error - raw string cannot be assigned to AnnotationId
    const _annId: AnnotationId = 'raw-string';

    // Suppress unused variable warnings
    void _annId;
  });
});

describe('Helper functions', () => {
  it('createAnnotationId returns a value that satisfies AnnotationId', () => {
    const id = createAnnotationId('test-id');
    // Can be used where AnnotationId is expected
    const acceptsAnnotationId = (aid: AnnotationId) => aid;
    expect(acceptsAnnotationId(id)).toBe('test-id');
  });
});

describe('toolTypeToGeometryType', () => {
  it('maps each tool to the geometry it produces', () => {
    // The two tools whose names do not match their geometry are the whole
    // reason this function exists.
    expect(toolTypeToGeometryType('segmentationBrush')).toBe('mask');
    expect(toolTypeToGeometryType('freeHandPath')).toBe('polyline');

    expect(toolTypeToGeometryType('rectangle')).toBe('rectangle');
    expect(toolTypeToGeometryType('circle')).toBe('circle');
    expect(toolTypeToGeometryType('line')).toBe('line');
    expect(toolTypeToGeometryType('point')).toBe('point');
    expect(toolTypeToGeometryType('polyline')).toBe('polyline');
  });
});
