import { Rect } from 'fabric';
import { ShapeTool } from './shape-tool.js';
import type { FabricShapeOptions } from '../fabric-utils.js';
import type { ToolType, Point } from '@osdlabel/annotation';
import { applyShapeControls } from '../shape-controls.js';

export class RectangleTool extends ShapeTool<Rect> {
  readonly type: ToolType = 'rectangle';

  protected createPreview(imagePoint: Point, options: FabricShapeOptions): Rect {
    // Positioned by its centre, which is also how the geometry is read back
    // (see rectangle-anchor.ts). The preview becomes the committed object, so
    // it gets the rectangle's handles now.
    const rect = new Rect({
      ...options,
      left: imagePoint.x,
      top: imagePoint.y,
      width: 0,
      height: 0,
      originX: 'center',
      originY: 'center',
      selectable: false,
      evented: false,
    });
    applyShapeControls(rect, 'rectangle');
    return rect;
  }

  protected updatePreview(imagePoint: Point, startPoint: Point): void {
    if (!this.preview) return;

    this.preview.set({
      width: Math.abs(imagePoint.x - startPoint.x),
      height: Math.abs(imagePoint.y - startPoint.y),
      left: (imagePoint.x + startPoint.x) / 2,
      top: (imagePoint.y + startPoint.y) / 2,
    });
  }

  /** The shorter side on screen: a box thinner than the minimum either way is discarded. */
  protected override previewScreenSize(preview: Rect): number {
    // Unrotated, and positioned by its centre (left/top).
    const { left: cx, top: cy, width, height } = preview;
    return Math.min(
      this.screenDistance({ x: cx - width / 2, y: cy }, { x: cx + width / 2, y: cy }),
      this.screenDistance({ x: cx, y: cy - height / 2 }, { x: cx, y: cy + height / 2 }),
    );
  }
}
