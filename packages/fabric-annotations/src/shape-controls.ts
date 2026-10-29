import { Control, controlsUtils, type FabricObject, type TransformActionHandler } from 'fabric';
import type { GeometryType } from '@osdlabel/annotation';

/**
 * Scales from a corner proportionally, whatever modifier is held.
 *
 * Fabric's corner handler, `scalingEqually`, scales proportionally only while
 * the canvas's `uniScaleKey` (Shift by default) is up: held, it scales each
 * axis freely. That is what a rectangle's corner should do, so the canvas
 * setting stays as it is, and for the length of this one synchronous call it
 * is set to "always proportional" instead. Fabric's own handler then does the
 * work, flips, centred scaling and locks included.
 */
const scalingEquallyAlways: TransformActionHandler = (eventData, transform, x, y) => {
  const { canvas } = transform.target;
  if (canvas === undefined || !('uniScaleKey' in canvas)) {
    return controlsUtils.scalingEqually(eventData, transform, x, y);
  }
  const { uniformScaling, uniScaleKey } = canvas;
  canvas.uniformScaling = true;
  canvas.uniScaleKey = null;
  try {
    return controlsUtils.scalingEqually(eventData, transform, x, y);
  } finally {
    canvas.uniformScaling = uniformScaling;
    canvas.uniScaleKey = uniScaleKey;
  }
};

/**
 * A side handle that only scales, along its own axis. Fabric's default side
 * handles skew instead while the canvas's `altActionKey` (Shift by default) is
 * held. The action name is the one Fabric's default reports for the scale.
 */
function sideScalingControl(x: number, y: number): Control {
  return new Control({
    x,
    y,
    cursorStyleHandler: controlsUtils.scaleCursorStyleHandler,
    actionHandler: y === 0 ? controlsUtils.scalingX : controlsUtils.scalingY,
    actionName: y === 0 ? 'scaleX' : 'scaleY',
  });
}

/**
 * A rectangle's controls: Fabric's defaults, with side handles that only
 * scale. A skewed rectangle is a parallelogram, which no `RectangleGeometry`
 * describes. Corners keep Fabric's behaviour (proportional, free with Shift),
 * and so does the rotation handle.
 */
function createRectangleControls(): Record<string, Control> {
  return {
    ...controlsUtils.createObjectDefaultControls(),
    ml: sideScalingControl(-0.5, 0),
    mr: sideScalingControl(0.5, 0),
    mt: sideScalingControl(0, -0.5),
    mb: sideScalingControl(0, 0.5),
  };
}

/**
 * A circle's controls: corners that always scale it uniformly, and Fabric's
 * rotation handle. No side handles: one would stretch it along a single axis,
 * or with Shift shear it, into an ellipse that no `CircleGeometry` describes.
 */
function createCircleControls(): Record<string, Control> {
  const { mtr } = controlsUtils.createObjectDefaultControls();
  const corner = (x: number, y: number): Control =>
    new Control({
      x,
      y,
      cursorStyleHandler: controlsUtils.scaleCursorStyleHandler,
      actionHandler: scalingEquallyAlways,
    });
  return {
    tl: corner(-0.5, -0.5),
    tr: corner(0.5, -0.5),
    bl: corner(-0.5, 0.5),
    br: corner(0.5, 0.5),
    ...(mtr !== undefined ? { mtr } : {}),
  };
}

/**
 * Give `object` the handles a shape of `type` gets, so that editing it with
 * them can only make shapes its geometry describes:
 *
 * - `rectangle`: Fabric's default handles, except that the side handles only
 *   scale. Fabric's default side handles skew while Shift is held (its
 *   `altActionKey`), into a parallelogram;
 * - `circle`: four corner handles that always scale it uniformly, Shift or
 *   not, and the rotation handle. No side handles;
 * - anything else is left alone. Lines, polylines and polygons store points
 *   read through the object's whole transform, so a skew or a stretch is part
 *   of what they store; points are built without handles (`hasControls:
 *   false`).
 *
 * Fabric does not serialize controls, so every path that puts an annotation's
 * object on a canvas applies them: the drawing tools, {@link buildFabricObjectFromGeometry}
 * and {@link createFabricObjectFromRawData} all call this. Call it yourself
 * only for a Fabric object of an annotation that you build or revive some
 * other way (for instance with {@link deserializeFabricObject}). Each call
 * installs a fresh set of controls; it changes nothing else on the object.
 */
export function applyShapeControls(object: FabricObject, type: GeometryType): void {
  if (type === 'rectangle') {
    object.controls = createRectangleControls();
  } else if (type === 'circle') {
    object.controls = createCircleControls();
  }
}
