import {
  controlsUtils,
  type Control,
  type FabricObject,
  type TransformActionHandler,
} from 'fabric';
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

/** A set of Fabric controls, by key, as `FabricObject.controls` holds them. */
type ControlSet = Record<string, Control>;

/** What a control must change to: a function of the control as it is. */
type Constraint = (control: Control) => Partial<Control>;

/** Fabric's side handles: they scale one axis, or skew while Shift is held. */
const SIDE_KEYS = ['ml', 'mr', 'mt', 'mb'] as const;

/** The action name a control reports, read from the control (Fabric's own default). */
const fixedActionName: Control['getActionName'] = (_eventData, control) => control.actionName;

/**
 * A side handle that only scales, along its own axis. Fabric's default side
 * handles skew instead while the canvas's `altActionKey` (Shift by default) is
 * held, and report the skew as their action then. The action name is the one
 * Fabric's default reports for the scale. Fabric's skew-aware cursor becomes
 * its scale cursor; a cursor of the host's own is kept.
 */
function scaleOnly(axis: 'X' | 'Y'): Constraint {
  return (control) => ({
    actionHandler: axis === 'X' ? controlsUtils.scalingX : controlsUtils.scalingY,
    actionName: `scale${axis}`,
    getActionName: fixedActionName,
    ...(control.cursorStyleHandler === controlsUtils.scaleSkewCursorStyleHandler
      ? { cursorStyleHandler: controlsUtils.scaleCursorStyleHandler }
      : {}),
  });
}

/** A corner handle that always scales proportionally. */
const scaleUniformly: Constraint = () => ({ actionHandler: scalingEquallyAlways });

/**
 * `control` with `changes`, or `control` itself when it has them already.
 *
 * A copy, never the control: Fabric lets a host share one set of `Control`
 * instances among all its objects (see `InteractiveFabricObject.createControls`),
 * and the others must keep theirs as they are. The copy keeps the control's
 * class and everything else on it, such as its position, size, cursor and
 * renderer.
 */
function withChanges(control: Control, changes: Partial<Control>): Control {
  const keys = Object.keys(changes) as (keyof Control)[];
  if (keys.every((key) => control[key] === changes[key])) return control;
  const copy = Object.create(Object.getPrototypeOf(control) as object) as Control;
  return Object.assign(copy, control, changes);
}

/**
 * `controls` with the keys in `remove` taken out and the controls under the
 * keys of `constrain` changed as it says. Every other control is kept as it
 * is, a key that is absent stays absent, and `controls` itself is never
 * changed. Returns `controls` itself when there is nothing to change, so
 * applying the same constraints again is a no-op.
 */
function constrainControls(
  controls: Readonly<ControlSet>,
  remove: readonly string[],
  constrain: Readonly<Record<string, Constraint>>,
): ControlSet {
  let next: ControlSet | undefined;
  const edit = (): ControlSet => (next ??= { ...controls });
  for (const key of remove) {
    if (controls[key] !== undefined) delete edit()[key];
  }
  for (const [key, constraint] of Object.entries(constrain)) {
    const control = controls[key];
    if (control === undefined) continue;
    const changed = withChanges(control, constraint(control));
    if (changed !== control) edit()[key] = changed;
  }
  return next ?? controls;
}

/**
 * `controls` for an object that may only be scaled uniformly: without
 * Fabric's side handles, and with corner handles that scale proportionally
 * whatever the modifier. Everything else is kept, the rotation handle
 * included if it is there, and the result is `controls` itself when they are
 * constrained already (see `constrainControls`).
 *
 * @internal For circles here, and for multi-selections (`configureGroupSelection`).
 */
export function uniformScaleControls(controls: Readonly<ControlSet>): ControlSet {
  return constrainControls(controls, SIDE_KEYS, {
    tl: scaleUniformly,
    tr: scaleUniformly,
    bl: scaleUniformly,
    br: scaleUniformly,
  });
}

/**
 * Constrain `object`'s handles so that editing it with them can only make
 * shapes a geometry of `type` describes:
 *
 * - `rectangle`: the side handles (`ml`, `mr`, `mt`, `mb`) only scale, along
 *   their own axis. Fabric's default side handles skew while Shift is held
 *   (its `altActionKey`), into a parallelogram, which no `RectangleGeometry`
 *   describes. Corners keep Fabric's behaviour (proportional, free with
 *   Shift), and so does the rotation handle;
 * - `circle`: the side handles are removed, since one would stretch it along
 *   a single axis, or with Shift shear it, into an ellipse that no
 *   `CircleGeometry` describes; and the corner handles (`tl`, `tr`, `bl`,
 *   `br`) always scale it uniformly, Shift or not;
 * - anything else is left alone. Lines, polylines and polygons store points
 *   read through the object's whole transform, so a skew or a stretch is part
 *   of what they store; points are built without handles (`hasControls:
 *   false`).
 *
 * It builds on the controls the object already has, which are the ones its
 * class's `createControls` gave it, and changes only the handlers above: a
 * handle the host removed (the rotation handle, say) stays removed, and a
 * host's renderers, sizes, cursors and extra controls are kept. A control is
 * copied before it is changed, so a set shared among objects is left as it
 * is. Applying it again is a no-op.
 *
 * Fabric does not serialize controls, so every path that puts an annotation's
 * object on a canvas applies them: the drawing tools, {@link buildFabricObjectFromGeometry}
 * and {@link createFabricObjectFromRawData} all call this. Call it yourself
 * only for a Fabric object of an annotation that you build or revive some
 * other way (for instance with {@link deserializeFabricObject}). It changes
 * nothing else on the object.
 */
export function applyShapeControls(object: FabricObject, type: GeometryType): void {
  if (type === 'rectangle') {
    object.controls = constrainControls(object.controls, [], {
      ml: scaleOnly('X'),
      mr: scaleOnly('X'),
      mt: scaleOnly('Y'),
      mb: scaleOnly('Y'),
    });
  } else if (type === 'circle') {
    object.controls = uniformScaleControls(object.controls);
  }
}
