/**
 * The Fabric half of saving a multi-selection edit: making a selection that
 * can only be moved, rotated and scaled uniformly; dissolving it so each
 * member carries its absolute transform; and selecting the same annotations
 * again once the viewer has rebuilt their objects from state.
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  ActiveSelection,
  Circle,
  controlsUtils,
  util,
  type Canvas,
  type FabricObject,
} from 'fabric';
import { DEFAULT_ANNOTATION_STYLE, type Point, type VectorGeometry } from '@osdlabel/annotation';
import { buildFabricObjectFromGeometry } from '../../src/build-fabric-object.js';
import { getFabricOptions } from '../../src/fabric-utils.js';
import {
  configureGroupSelection,
  dissolveGroupSelection,
  isGroupSelection,
  reselectWhenAdded,
} from '../../src/group-selection.js';
import {
  controlNames,
  controlPoint,
  disposeCanvases,
  forward,
  gesture,
  openCanvas,
} from './canvas-harness.js';
import {
  expectHostHandles,
  hostControlSet,
  overrideCreateControls,
  snapshotControls,
} from './host-controls.js';

afterEach(disposeCanvases);

function build(id: string, geometry: VectorGeometry): FabricObject {
  return buildFabricObjectFromGeometry(geometry, getFabricOptions(DEFAULT_ANNOTATION_STYLE, id));
}

const RECT: VectorGeometry = {
  type: 'rectangle',
  origin: { x: 100, y: 100 },
  width: 120,
  height: 60,
  rotation: 30,
};
const CIRCLE: VectorGeometry = { type: 'circle', center: { x: 400, y: 160 }, radius: 50 };

/** A canvas holding a rotated rectangle and a circle, both selected as a group. */
function selectBoth(): {
  canvas: Canvas;
  rect: FabricObject;
  circle: FabricObject;
  selection: ActiveSelection;
} {
  const canvas = openCanvas();
  const rect = build('rect', RECT);
  const circle = build('circle', CIRCLE);
  canvas.add(rect, circle);
  const selection = new ActiveSelection([rect, circle], { canvas });
  canvas.setActiveObject(selection);
  return { canvas, rect, circle, selection };
}

/** Where `object`'s centre is on the canvas, whether or not it is in a group. */
function sceneCentre(object: FabricObject): Point {
  const c = util.transformPoint({ x: 0, y: 0 }, object.calcTransformMatrix());
  return { x: c.x, y: c.y };
}

describe('isGroupSelection', () => {
  it('is true for an ActiveSelection, false for a member or a plain object', () => {
    const { rect, selection } = selectBoth();
    expect(isGroupSelection(selection)).toBe(true);
    expect(isGroupSelection(rect)).toBe(false);
    expect(isGroupSelection(build('lone', CIRCLE))).toBe(false);
  });
});

describe('configureGroupSelection', () => {
  it('keeps the corner and rotation handles only, and locks skew', () => {
    const { selection } = selectBoth();
    configureGroupSelection(selection);
    expect(controlNames(selection)).toEqual(['bl', 'br', 'mtr', 'tl', 'tr']);
    expect(selection.lockSkewingX).toBe(true);
    expect(selection.lockSkewingY).toBe(true);
    // Applying it again changes nothing.
    const controls = selection.controls;
    configureGroupSelection(selection);
    expect(selection.controls).toBe(controls);
  });

  it.each([false, true])('scales uniformly from a corner (Shift held: %s)', (shiftKey) => {
    const { canvas, selection } = selectBoth();
    configureGroupSelection(selection);
    const before = { uniformScaling: canvas.uniformScaling, uniScaleKey: canvas.uniScaleKey };

    const from = controlPoint(selection, 'br');
    gesture(canvas, from, { x: from.x + 120, y: from.y + 10 }, { shiftKey });

    expect(selection.scaleX).toBeGreaterThan(1.05);
    expect(selection.scaleY).toBeCloseTo(selection.scaleX, 9);
    // The canvas-wide settings a single object scales by are left as they were.
    expect({ uniformScaling: canvas.uniformScaling, uniScaleKey: canvas.uniScaleKey }).toEqual(
      before,
    );
  });

  it('leaves the rotation handle working', () => {
    const { canvas, selection } = selectBoth();
    configureGroupSelection(selection);
    const centre = selection.getCenterPoint();
    // From the handle, round to the right of the centre: a quarter turn.
    gesture(canvas, controlPoint(selection, 'mtr'), { x: centre.x + 200, y: centre.y });
    expect(selection.angle).toBeCloseTo(90, 0);
  });

  /**
   * A host customises handles the way Fabric documents, by overriding
   * `createControls`, which a selection's constructor reads too. Until the
   * fix the selection got Fabric's corner and rotation handles whatever the
   * host had: a rotation handle it had removed came back, and its renderers
   * were lost.
   */
  describe('on controls a host customised', () => {
    let restore: (() => void) | undefined;
    afterEach(() => {
      restore?.();
      restore = undefined;
    });

    it.each([false, true])(
      "keeps the host's corner handles, and no rotation handle; they scale uniformly (Shift held: %s)",
      (shiftKey) => {
        restore = overrideCreateControls(hostControlSet);
        const { canvas, selection } = selectBoth();
        configureGroupSelection(selection);

        expect(controlNames(selection), 'the removed rotation handle came back').toEqual([
          'bl',
          'br',
          'tl',
          'tr',
        ]);
        expectHostHandles(selection, 'the selection');
        expect(selection.lockSkewingX).toBe(true);
        expect(selection.lockSkewingY).toBe(true);

        const from = controlPoint(selection, 'br');
        gesture(canvas, from, { x: from.x + 120, y: from.y + 10 }, { shiftKey });
        expect(selection.scaleX).toBeGreaterThan(1.05);
        expect(selection.scaleY).toBeCloseTo(selection.scaleX, 9);
      },
    );

    it('leaves a set the host shares among all objects as it was', () => {
      const shared = hostControlSet();
      const before = snapshotControls(shared);
      restore = overrideCreateControls(() => shared);
      const { selection } = selectBoth();
      expect(selection.controls, 'the premise: the selection has the shared set').toBe(shared);

      configureGroupSelection(selection);

      expect(snapshotControls(shared), 'a shared control was changed').toEqual(before);
      expect(selection.controls).not.toBe(shared);
      expect(shared['br']!.actionHandler).toBe(controlsUtils.scalingEqually);
      expect(shared['mr']).toBeDefined();
    });
  });
});

describe('dissolveGroupSelection', () => {
  it('returns the members, each carrying its absolute transform, and clears the selection', () => {
    const { canvas, rect, circle, selection } = selectBoth();
    selection.set({ angle: 40, scaleX: 1.5, scaleY: 1.5, left: selection.left + 30 });
    selection.setCoords();
    const expected = [sceneCentre(rect), sceneCentre(circle)];

    const members = dissolveGroupSelection(canvas, selection);

    expect(members).toEqual([rect, circle]);
    expect(canvas.getActiveObject()).toBeUndefined();
    members.forEach((member, i) => {
      expect(member.group).toBeUndefined();
      // Read off the member alone, with no group to compose: the same place.
      const centre = member.getCenterPoint();
      expect(centre.x).toBeCloseTo(expected[i]!.x, 9);
      expect(centre.y).toBeCloseTo(expected[i]!.y, 9);
      expect(member.scaleX).toBeCloseTo(1.5, 9);
      expect(member.scaleY).toBeCloseTo(1.5, 9);
    });
    expect(rect.angle).toBeCloseTo(70, 9);
    expect(selection.getObjects()).toEqual([]);
  });

  it('dissolves a selection that is no longer the active object', () => {
    const { canvas, rect, selection } = selectBoth();
    selection.set({ left: selection.left + 30 });
    const expected = sceneCentre(rect);
    // Detach it without Fabric dissolving it.
    (canvas as unknown as { _activeObject: FabricObject | undefined })._activeObject = undefined;

    const members = dissolveGroupSelection(canvas, selection);

    expect(members).toHaveLength(2);
    expect(rect.group).toBeUndefined();
    expect(rect.getCenterPoint().x).toBeCloseTo(expected.x, 9);
  });

  it('returns nothing for a selection already dissolved', () => {
    const { canvas, selection } = selectBoth();
    canvas.discardActiveObject();
    expect(dissolveGroupSelection(canvas, selection)).toEqual([]);
  });
});

describe('reselectWhenAdded', () => {
  /** The rebuild the viewer does after a commit: every annotation object replaced. */
  function rebuild(canvas: Canvas): FabricObject[] {
    const old = canvas.getObjects().filter((o) => o.id);
    canvas.remove(...old);
    const fresh = [build('rect', RECT), build('circle', CIRCLE), build('other', CIRCLE)];
    canvas.add(...fresh);
    return fresh;
  }

  function prepared(): Canvas {
    const { canvas } = selectBoth();
    canvas.discardActiveObject();
    canvas.selection = true;
    return canvas;
  }

  it('selects the rebuilt objects as a configured group once all of them are back', () => {
    const canvas = prepared();
    reselectWhenAdded(canvas, ['rect', 'circle']);
    const fresh = rebuild(canvas);

    const active = canvas.getActiveObject();
    expect(active).toBeInstanceOf(ActiveSelection);
    const members = (active as ActiveSelection).getObjects();
    expect(members).toHaveLength(2);
    expect(members).toContain(fresh[0]);
    expect(members).toContain(fresh[1]);
    expect(controlNames(active!)).toEqual(['bl', 'br', 'mtr', 'tl', 'tr']);
  });

  it('selects a lone object on its own', () => {
    const canvas = prepared();
    reselectWhenAdded(canvas, ['circle']);
    const fresh = rebuild(canvas);
    expect(canvas.getActiveObject()).toBe(fresh[1]);
  });

  it('happens once: a later rebuild selects nothing', () => {
    const canvas = prepared();
    reselectWhenAdded(canvas, ['rect', 'circle']);
    rebuild(canvas);
    canvas.discardActiveObject();
    rebuild(canvas);
    expect(canvas.getActiveObject()).toBeUndefined();
  });

  it('selects nothing while group selection is off (another tool is active)', () => {
    const canvas = prepared();
    canvas.selection = false;
    reselectWhenAdded(canvas, ['rect', 'circle']);
    rebuild(canvas);
    expect(canvas.getActiveObject()).toBeUndefined();
  });

  it('selects nothing once the user has pressed since', () => {
    const canvas = prepared();
    reselectWhenAdded(canvas, ['rect', 'circle']);
    forward(canvas, 'pointerdown', { x: 700, y: 500 });
    forward(canvas, 'pointerup', { x: 700, y: 500 });
    rebuild(canvas);
    expect(canvas.getActiveObject()).toBeUndefined();
  });

  it('leaves alone whatever else has been selected meanwhile', () => {
    const canvas = prepared();
    reselectWhenAdded(canvas, ['rect', 'circle']);
    // Selected by the host, not by a press; without an id, so the rebuild keeps it.
    const elsewhere = new Circle({ left: 600, top: 400, radius: 5 });
    canvas.add(elsewhere);
    canvas.setActiveObject(elsewhere);
    rebuild(canvas);
    expect(canvas.getActiveObject()).toBe(elsewhere);
  });

  it('selects nothing until every id is back, and nothing once cancelled', () => {
    const canvas = prepared();
    const cancel = reselectWhenAdded(canvas, ['rect', 'circle', 'never']);
    rebuild(canvas);
    expect(canvas.getActiveObject()).toBeUndefined();

    const cancelled = reselectWhenAdded(canvas, ['rect', 'circle']);
    cancelled();
    rebuild(canvas);
    expect(canvas.getActiveObject()).toBeUndefined();
    cancel();
  });
});
