import { Circle } from 'fabric';
import { ShapeTool } from './shape-tool.js';
import type { FabricShapeOptions } from '../fabric-utils.js';
import {
  DEFAULT_POINT_RADIUS,
  type AnnotationStyle,
  type ToolType,
  type Point,
} from '@osdlabel/annotation';

export class PointTool extends ShapeTool<Circle> {
  readonly type: ToolType = 'point';

  protected createPreview(
    imagePoint: Point,
    options: FabricShapeOptions,
    style: AnnotationStyle,
  ): Circle {
    return new Circle({
      ...options,
      left: imagePoint.x,
      top: imagePoint.y,
      radius: style.pointRadius ?? DEFAULT_POINT_RADIUS,
      originX: 'center',
      originY: 'center',
      selectable: false,
      evented: false,
      hasControls: false,
    });
  }

  protected updatePreview(imagePoint: Point, _startPoint: Point): void {
    if (!this.preview) return;

    this.preview.set({
      left: imagePoint.x,
      top: imagePoint.y,
    });
  }
}
