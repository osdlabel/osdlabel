import { describe, expect, it } from 'vitest';
import type { ToolType } from '@osdlabel/annotation';
import {
  CircleTool,
  FreeHandPathTool,
  LineTool,
  PointTool,
  PolylineTool,
  RectangleTool,
  SelectTool,
} from '@osdlabel/fabric-annotations';
import { createAnnotationTool } from '../../src/tool-factory.js';

/**
 * Every `ToolType`, plus `'select'`, mapped to the class the factory must
 * return. Written as a table so a new `ToolType` that nobody wires up fails to
 * compile here rather than silently falling through to `null` at runtime.
 */
const EXPECTED: Record<ToolType | 'select', new (...args: never[]) => unknown> = {
  rectangle: RectangleTool,
  circle: CircleTool,
  line: LineTool,
  point: PointTool,
  polyline: PolylineTool,
  freeHandPath: FreeHandPathTool,
  select: SelectTool,
};

describe('createAnnotationTool', () => {
  // Asserting the concrete class is the point: RectangleTool and CircleTool are
  // both ShapeTool subclasses with identical activate/event surfaces, so a
  // factory that swapped the two cases would satisfy any structural assertion.
  it.each(Object.entries(EXPECTED))('returns a %s tool instance', (type, Expected) => {
    const tool = createAnnotationTool(type as ToolType | 'select');
    expect(tool).toBeInstanceOf(Expected);
  });

  it('does not return the same class for two different tool types', () => {
    const classes = (Object.keys(EXPECTED) as (ToolType | 'select')[]).map(
      (type) => createAnnotationTool(type)?.constructor,
    );
    expect(new Set(classes).size).toBe(classes.length);
  });

  it('returns null for an unrecognized type', () => {
    expect(createAnnotationTool('nonsense' as ToolType)).toBeNull();
  });

  it('constructs the vertex-editing tools without an options argument', () => {
    // PolylineTool, FreeHandPathTool and SelectTool take a VertexEditConfig the
    // factory defaults when `options` is omitted; a missing default would throw
    // or produce a tool with an undefined config.
    for (const type of ['polyline', 'freeHandPath', 'select'] as const) {
      expect(() => createAnnotationTool(type)).not.toThrow();
      expect(createAnnotationTool(type)).not.toBeNull();
    }
  });

  it('accepts an explicit vertexEdit config', () => {
    const tool = createAnnotationTool('select', {
      vertexEdit: { longPressMs: 123, moveTolerancePx: 4 },
    });
    expect(tool).toBeInstanceOf(SelectTool);
  });
});
