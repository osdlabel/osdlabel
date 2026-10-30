import { Circle } from 'fabric';
import { ShapeTool } from './shape-tool.js';
import type { FabricShapeOptions } from '../fabric-utils.js';
import type { ToolType, Point } from '@osdlabel/annotation';
import { applyShapeControls } from '../shape-controls.js';

export class CircleTool extends ShapeTool<Circle> {
  readonly type: ToolType = 'circle';

  protected createPreview(imagePoint: Point, options: FabricShapeOptions): Circle {
    // The preview becomes the committed object, so it gets the circle's handles now.
    const circle = new Circle({
      ...options,
      left: imagePoint.x,
      top: imagePoint.y,
      radius: 0,
      originX: 'center',
      originY: 'center',
      selectable: false,
      evented: false,
    });
    applyShapeControls(circle, 'circle');
    return circle;
  }

  protected updatePreview(imagePoint: Point, startPoint: Point): void {
    if (!this.preview) return;

    const dx = imagePoint.x - startPoint.x;
    const dy = imagePoint.y - startPoint.y;
    const radius = Math.sqrt(dx * dx + dy * dy);

    this.preview.set({ radius });
  }

  /** The diameter on screen. */
  protected override previewScreenSize(preview: Circle): number {
    const { left: cx, top: cy, radius } = preview;
    return this.screenDistance({ x: cx - radius, y: cy }, { x: cx + radius, y: cy });
  }
}
