import { describe, expect, it } from 'vitest';
import type { ToolType } from '@osdlabel/annotation';
import {
  DEFAULT_VERTEX_EDIT_LONG_PRESS_MS,
  DEFAULT_VERTEX_EDIT_MOVE_TOLERANCE_PX,
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

  it('returns null for an unrecognized type', () => {
    expect(createAnnotationTool('nonsense' as ToolType)).toBeNull();
  });

  // The three vertex-editing tools each declare their own VertexEditConfig
  // default, so removing the factory's `?? { ... }` fallback changes nothing
  // observable — the class default fires instead. What *is* worth asserting is
  // that an explicitly-passed config actually reaches the editor, which is the
  // only part of the options path a caller can depend on.
  describe('vertexEdit options', () => {
    /** The config the tool's PolyVertexEditor was constructed with. */
    function editorConfig(tool: unknown): { longPressMs: number; moveTolerancePx: number } {
      const { editor } = tool as {
        editor: { longPressMs: number; moveTolerancePx: number };
      };
      return { longPressMs: editor.longPressMs, moveTolerancePx: editor.moveTolerancePx };
    }

    it.each(['polyline', 'freeHandPath', 'select'] as const)(
      'forwards an explicit config to the %s tool',
      (type) => {
        const tool = createAnnotationTool(type, {
          vertexEdit: { longPressMs: 123, moveTolerancePx: 4 },
        });
        expect(editorConfig(tool)).toEqual({ longPressMs: 123, moveTolerancePx: 4 });
      },
    );

    it.each(['polyline', 'freeHandPath', 'select'] as const)(
      'applies the documented defaults to the %s tool when options are omitted',
      (type) => {
        expect(editorConfig(createAnnotationTool(type))).toEqual({
          longPressMs: DEFAULT_VERTEX_EDIT_LONG_PRESS_MS,
          moveTolerancePx: DEFAULT_VERTEX_EDIT_MOVE_TOLERANCE_PX,
        });
      },
    );
  });
});
