import { describe, expect, it } from 'vitest';
import { SegmentationBrushTool } from '@osdlabel/fabric-annotations';
import type { SegmentationBrushToolConfig } from '@osdlabel/fabric-annotations';
import { createAnnotationTool } from '../../src/tool-factory.js';

const brushConfig: SegmentationBrushToolConfig = {
  getBrushRadius: () => 5,
  getImageSize: () => ({ width: 100, height: 100 }),
  getTarget: () => null,
  onCommit: () => {},
  isErasing: () => false,
};

describe('createAnnotationTool — the segmentation brush', () => {
  it('returns null when no brush config is supplied', () => {
    // Documented as degrading gracefully: a host that never wires the brush
    // still gets a working annotator, and the toolbar simply has no brush.
    // Constructing one anyway would hand back a tool whose every callback is
    // undefined, failing on the first stroke instead of the first click.
    expect(createAnnotationTool('segmentationBrush')).toBeNull();
    expect(createAnnotationTool('segmentationBrush', {})).toBeNull();
    expect(createAnnotationTool('segmentationBrush', { segmentationBrush: undefined })).toBeNull();
  });

  it('builds the brush when the config is supplied', () => {
    const tool = createAnnotationTool('segmentationBrush', { segmentationBrush: brushConfig });
    expect(tool).toBeInstanceOf(SegmentationBrushTool);
  });

  it('does not hand the brush config to a different tool', () => {
    // The config is brush-specific; a mix-up would silently produce the wrong
    // tool for a keyboard shortcut or toolbar button.
    const tool = createAnnotationTool('rectangle', { segmentationBrush: brushConfig });
    expect(tool).not.toBeInstanceOf(SegmentationBrushTool);
  });

  it('returns null for a type it does not know', () => {
    expect(createAnnotationTool('nonsense' as never)).toBeNull();
  });
});
