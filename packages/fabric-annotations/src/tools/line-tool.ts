import { Line } from 'fabric';
import { ShapeTool } from './shape-tool.js';
import type { FabricShapeOptions } from '../fabric-utils.js';
import type { ToolType, Point } from '@osdlabel/annotation';

export class LineTool extends ShapeTool<Line> {
  readonly type: ToolType = 'line';

  protected createPreview(imagePoint: Point, options: FabricShapeOptions): Line {
    return new Line([imagePoint.x, imagePoint.y, imagePoint.x, imagePoint.y], {
      ...options,
      originX: 'left',
      originY: 'top',
      selectable: false,
      evented: false,
    });
  }

  protected updatePreview(imagePoint: Point, _startPoint: Point): void {
    if (!this.preview) return;

    this.preview.set({
      x2: imagePoint.x,
      y2: imagePoint.y,
    });
  }

  /** The length on screen. */
  protected override previewScreenSize(preview: Line): number {
    return this.screenDistance({ x: preview.x1, y: preview.y1 }, { x: preview.x2, y: preview.y2 });
  }
}
