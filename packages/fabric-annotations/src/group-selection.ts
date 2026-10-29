import { ActiveSelection, Control, controlsUtils } from 'fabric';
import type { Canvas, FabricObject, TransformActionHandler } from 'fabric';

/**
 * Multi-selections: what this library lets a Fabric `ActiveSelection` do, and
 * how an edit of one is turned back into one edit per annotation.
 *
 * A selection is a group. Fabric reports a move, scale or rotation of it with
 * one `object:modified` whose target is the selection, with every member still
 * inside it and its left/top/scale/angle relative to the selection; it bakes
 * the selection's transform into each member only when the selection is
 * dissolved. Baking a stretch into a rotated member skews it, and a stretched
 * circle is an ellipse, neither of which an annotation's geometry can
 * describe. So a selection here scales only uniformly, which commutes with
 * rotation: whatever is done to it, each member stays a shape of its own kind.
 */

/** Whether `object` is a multi-selection rather than one annotation object. */
export function isGroupSelection(object: FabricObject): object is ActiveSelection {
  return object instanceof ActiveSelection;
}

/**
 * Scale from a corner, uniformly whatever modifier is held. Fabric's corner
 * handler scales freely while the canvas's `uniScaleKey` (Shift) is held, so
 * the canvas's two settings are pinned for the length of the call and then
 * restored: a single object keeps scaling as the canvas says.
 */
const scaleUniformly: TransformActionHandler = (eventData, transform, x, y) => {
  const canvas = transform.target.canvas;
  if (!canvas) return controlsUtils.scalingEqually(eventData, transform, x, y);
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

/** Selections already given their controls, so a repeat is a no-op. */
const configured = new WeakSet<ActiveSelection>();

/**
 * Make `selection` movable, rotatable and uniformly scalable only: its four
 * corner handles scale it proportionally whatever the modifier, its rotation
 * handle turns it, and it has no side handles and cannot be skewed. Idempotent.
 *
 * The select tool applies this to every selection Fabric makes; whoever
 * selects several objects programmatically should too.
 */
export function configureGroupSelection(selection: ActiveSelection): void {
  if (configured.has(selection)) return;
  configured.add(selection);
  const defaults = controlsUtils.createObjectDefaultControls();
  const corner = (x: number, y: number): Control =>
    new Control({
      x,
      y,
      cursorStyleHandler: controlsUtils.scaleCursorStyleHandler,
      actionHandler: scaleUniformly,
    });
  selection.controls = {
    tl: corner(-0.5, -0.5),
    tr: corner(0.5, -0.5),
    bl: corner(-0.5, 0.5),
    br: corner(0.5, 0.5),
    mtr: defaults.mtr,
  };
  selection.lockSkewingX = true;
  selection.lockSkewingY = true;
  selection.setCoords();
}

/**
 * Dissolve `selection`, baking its transform into each member, and return the
 * members: from then on each one's own left/top/scale/angle say where it is
 * painted. Returns nothing for a selection already dissolved (deselecting it
 * did the same baking, and emptied it).
 *
 * The usual case discards it as the canvas's active object, which fires
 * `selection:cleared`. Call it after Fabric has finished the gesture: discarding
 * the target of a transform still in progress ends the transform, and Fabric
 * reports the edit again.
 */
export function dissolveGroupSelection(canvas: Canvas, selection: ActiveSelection): FabricObject[] {
  const members = selection.getObjects();
  if (members.length === 0) return [];
  if (canvas.getActiveObject() === selection) {
    canvas.discardActiveObject();
  } else {
    selection.removeAll();
  }
  canvas.requestRenderAll();
  return members;
}

/**
 * Once objects with every one of `ids` have been added to `canvas`, select
 * them, as a configured multi-selection when there are several. For keeping a
 * selection across the rebuild an edit causes, which replaces every annotation
 * object with a new one built from state. Returns a function that stops
 * waiting.
 *
 * Happens at most once, and not at all if the user presses on the canvas
 * first, if something else is selected by then, or if group selection is off
 * (the select tool is no longer active) when the objects arrive.
 */
export function reselectWhenAdded(canvas: Canvas, ids: readonly string[]): () => void {
  const wanted = new Set(ids);
  const found = new Map<string, FabricObject>();
  let stopped = false;

  const stop = (): void => {
    if (stopped) return;
    stopped = true;
    canvas.off('object:added', onAdded);
    canvas.off('mouse:down', stop);
  };

  function onAdded({ target }: { readonly target: FabricObject }): void {
    const id = target.id;
    if (typeof id !== 'string' || !wanted.has(id)) return;
    found.set(id, target);
    if (found.size < wanted.size) return;
    stop();
    if (!canvas.selection || canvas.getActiveObject()) return;
    // In stacking order, and only what is still on the canvas and selectable.
    const objects = canvas.getObjects().filter((o) => o.id !== undefined && found.get(o.id) === o);
    if (objects.length !== wanted.size || !objects.every((o) => o.selectable)) return;
    const only = objects.length === 1 ? objects[0] : undefined;
    if (only) {
      canvas.setActiveObject(only);
    } else {
      const selection = new ActiveSelection(objects, { canvas });
      configureGroupSelection(selection);
      canvas.setActiveObject(selection);
    }
    canvas.requestRenderAll();
  }

  if (wanted.size === 0) {
    stopped = true;
    return stop;
  }
  canvas.on('object:added', onAdded);
  canvas.on('mouse:down', stop);
  return stop;
}
