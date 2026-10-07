import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { FabricObject } from 'fabric';
import { createAnnotationId, type AnnotationId } from '@osdlabel/annotation';
import { createImageId } from '@osdlabel/viewer-api';
import { createAnnotationContextId } from '@osdlabel/annotation-context';
import { BoundedDenseMaskBuffer, stampCircle } from '@osdlabel/mask';
import { createFabricObjectFromRawData } from '@osdlabel/fabric-annotations';
import {
  DEFAULT_UNSELECTED_MASK_OPACITY,
  applyMaskSelectionStyle,
  desiredMaskTint,
  maskFillFor,
  maskOpacityFor,
  planMaskTintSwaps,
  MaskTintState,
  replaceMaskObject,
  selectedMaskOn,
  swapMaskTints,
  unselectedMaskOpacity,
} from '../../src/mask-style.js';
import { createMaskAnnotation } from '../../src/create-mask-annotation.js';
import { MaskObjectCache } from '../../src/mask-object-cache.js';

/**
 * A stand-in for a Fabric object: `id`, `opacity`, and the `set` the helpers
 * call. Fabric is not needed to test which objects get which opacity, and
 * building real `FabricImage`s would need a canvas the Node environment lacks.
 */
interface FakeObject {
  id?: string;
  opacity: number;
  _readOnly?: boolean;
  maskFill?: string | undefined;
  set(key: string, value: unknown): void;
}
function fake(id: string | undefined, opacity = 1): FakeObject & FabricObject {
  const obj: FakeObject = {
    opacity,
    set(key, value) {
      (obj as unknown as Record<string, unknown>)[key] = value;
    },
  };
  if (id !== undefined) obj.id = id;
  return obj as unknown as FakeObject & FabricObject;
}

vi.mock('@osdlabel/fabric-annotations', async () => {
  const actual = await vi.importActual<typeof import('@osdlabel/fabric-annotations')>(
    '@osdlabel/fabric-annotations',
  );
  return {
    ...actual,
    createFabricObjectFromRawData: vi.fn(),
  };
});
const buildObject = vi.mocked(createFabricObjectFromRawData);

const annId = (s: string): AnnotationId => createAnnotationId(s);

describe('unselectedMaskOpacity', () => {
  it('defaults, and clamps a configured value to 0–1', () => {
    expect(unselectedMaskOpacity(undefined)).toBe(DEFAULT_UNSELECTED_MASK_OPACITY);
    expect(unselectedMaskOpacity({})).toBe(DEFAULT_UNSELECTED_MASK_OPACITY);
    expect(unselectedMaskOpacity({ unselectedOpacity: 0.25 })).toBe(0.25);
    expect(unselectedMaskOpacity({ unselectedOpacity: 3 })).toBe(1);
    expect(unselectedMaskOpacity({ unselectedOpacity: -1 })).toBe(0);
    // A NaN would propagate into every mask's opacity and render nothing.
    expect(unselectedMaskOpacity({ unselectedOpacity: Number.NaN })).toBe(
      DEFAULT_UNSELECTED_MASK_OPACITY,
    );
  });
});

describe('maskOpacityFor / maskFillFor', () => {
  it('leaves every mask at full opacity while nothing is selected', () => {
    expect(maskOpacityFor('a', null, undefined)).toBe(1);
    expect(maskFillFor('a', null, { selectedFill: '#f00' })).toBeUndefined();
  });

  it('dims the others, not the selection, and recolours only the selection', () => {
    const style = { selectedFill: '#f00', unselectedOpacity: 0.3 };
    expect(maskOpacityFor('a', 'a', style)).toBe(1);
    expect(maskOpacityFor('b', 'a', style)).toBe(0.3);
    expect(maskFillFor('a', 'a', style)).toBe('#f00');
    expect(maskFillFor('b', 'a', style)).toBeUndefined();
  });
});

describe('applyMaskSelectionStyle', () => {
  it('sets opacity on mask objects only, and reports whether anything changed', () => {
    const a = fake('a');
    const b = fake('b');
    const rect = fake('r'); // a vector annotation: not in maskIds
    const companion = fake(undefined); // no id: decoration line, preview, cursor
    const objects = [a, b, rect, companion];
    const masks = new Set(['a', 'b']);

    expect(applyMaskSelectionStyle(objects, masks, 'a', undefined)).toBe(true);
    expect(a.opacity).toBe(1);
    expect(b.opacity).toBe(DEFAULT_UNSELECTED_MASK_OPACITY);
    expect(rect.opacity).toBe(1);
    expect(companion.opacity).toBe(1);

    // Same selection again: nothing to do, so no re-render is owed.
    expect(applyMaskSelectionStyle(objects, masks, 'a', undefined)).toBe(false);

    expect(applyMaskSelectionStyle(objects, masks, null, undefined)).toBe(true);
    expect(b.opacity).toBe(1);
  });
});

describe('replaceMaskObject', () => {
  const imageId = createImageId('img');
  const contextId = createAnnotationContextId('ctx');
  function maskAnnotation(id: string) {
    const buffer = new BoundedDenseMaskBuffer({ imageWidth: 100, imageHeight: 100 });
    stampCircle(buffer, 50.5, 50.5, 5, 1);
    return createMaskAnnotation(buffer.snapshot(), { id: annId(id), imageId, contextId });
  }
  function canvasWith(...objects: FabricObject[]) {
    const list = [...objects];
    return {
      list,
      getObjects: () => list,
      insertAt: vi.fn((index: number, ...objs: FabricObject[]) => {
        list.splice(index, 0, ...objs);
        return list.length;
      }),
      remove: vi.fn((...objs: FabricObject[]) => {
        for (const o of objs) {
          const at = list.indexOf(o);
          if (at >= 0) list.splice(at, 1);
        }
        return objs;
      }),
      requestRenderAll: vi.fn(),
    };
  }

  beforeEach(() => {
    buildObject.mockReset();
  });

  it('swaps the object in place, keeping its position in the stack', async () => {
    const before = fake('r1');
    const old = fake('m1');
    old._readOnly = true;
    const after = fake('r2');
    const canvas = canvasWith(before, old, after);
    const replacement = fake('m1');
    buildObject.mockResolvedValue(replacement);
    const prepare = vi.fn();

    await replaceMaskObject(canvas, maskAnnotation('m1'), '#f00', prepare, () => false);

    expect(buildObject).toHaveBeenCalledWith(expect.objectContaining({ id: 'm1' }), {
      maskFill: '#f00',
    });
    expect(prepare).toHaveBeenCalledWith(replacement, old);
    expect(canvas.list).toEqual([before, replacement, after]);
    expect(canvas.requestRenderAll).toHaveBeenCalledTimes(1);
  });

  it('does nothing when the mask is not on the canvas', async () => {
    const canvas = canvasWith(fake('other'));
    await replaceMaskObject(canvas, maskAnnotation('m1'), '#f00', vi.fn(), () => false);
    expect(buildObject).not.toHaveBeenCalled();
    expect(canvas.insertAt).not.toHaveBeenCalled();
  });

  it('drops the replacement if cancelled, or if a rebuild replaced the object meanwhile', async () => {
    const old = fake('m1');
    const canvas = canvasWith(old);
    buildObject.mockResolvedValue(fake('m1'));

    await replaceMaskObject(canvas, maskAnnotation('m1'), '#f00', vi.fn(), () => true);
    expect(canvas.list).toEqual([old]);

    // A rebuild cleared and re-added the canvas while we were decoding: the
    // object we meant to replace is gone, so the stale replacement is dropped.
    const fresh = fake('m1');
    buildObject.mockImplementation(async () => {
      canvas.remove(old);
      canvas.insertAt(0, fresh);
      return fake('m1');
    });
    await replaceMaskObject(canvas, maskAnnotation('m1'), '#f00', vi.fn(), () => false);
    expect(canvas.list).toEqual([fresh]);
  });
});

describe('selectedMaskOn', () => {
  it('narrows the global selection to a mask on this image', () => {
    const masks = new Set(['m1', 'm2']);
    expect(selectedMaskOn('m1', masks)).toBe('m1');
    // A rectangle, a mask in another grid cell, a deleted mask: none of these
    // should dim this image's masks with nothing visibly selected.
    expect(selectedMaskOn('r1', masks)).toBeNull();
    expect(selectedMaskOn(null, masks)).toBeNull();
  });
});

describe('desiredMaskTint / planMaskTintSwaps', () => {
  const red = { selectedFill: '#f00' };

  it('wants an override only for a selected mask under a selectedFill', () => {
    expect(desiredMaskTint('m1', red)).toEqual({ id: 'm1', fill: '#f00' });
    expect(desiredMaskTint('m1', undefined)).toBeNull();
    expect(desiredMaskTint(null, red)).toBeNull();
  });

  it('plans nothing when nothing changes', () => {
    expect(planMaskTintSwaps(null, null)).toEqual([]);
    expect(planMaskTintSwaps({ id: 'm1', fill: '#f00' }, { id: 'm1', fill: '#f00' })).toEqual([]);
  });

  it('reverts the mask that lost the override and tints the one that gained it', () => {
    expect(planMaskTintSwaps({ id: 'm1', fill: '#f00' }, { id: 'm2', fill: '#f00' })).toEqual([
      { id: 'm1', fill: undefined },
      { id: 'm2', fill: '#f00' },
    ]);
  });

  it('reverts on deselect, and when selectedFill is turned off', () => {
    // Deciding from the *new* style alone could never revert: with no
    // selectedFill there is nothing to apply, yet a mask still wears the old one.
    expect(planMaskTintSwaps({ id: 'm1', fill: '#f00' }, null)).toEqual([
      { id: 'm1', fill: undefined },
    ]);
  });

  it('re-tints in place when only the colour changes', () => {
    expect(planMaskTintSwaps({ id: 'm1', fill: '#f00' }, { id: 'm1', fill: '#0f0' })).toEqual([
      { id: 'm1', fill: '#0f0' },
    ]);
  });
});

describe('replaceMaskObject leaves a stroke alone', () => {
  it('does not swap an object the brush has hidden for a stroke in progress', async () => {
    // The brush hides the committed object by reference while painting; a
    // swap would show committed and preview together and leave the brush
    // restoring a detached object. The commit rebuilds in the right tint.
    const hidden = fake('m1');
    (hidden as unknown as { visible: boolean }).visible = false;
    const list = [hidden];
    const canvas = {
      getObjects: () => list,
      insertAt: vi.fn(),
      remove: vi.fn(),
      requestRenderAll: vi.fn(),
    };
    const buffer = new BoundedDenseMaskBuffer({ imageWidth: 10, imageHeight: 10 });
    buffer.set(1, 1, 1);
    const annotation = createMaskAnnotation(buffer.snapshot(), {
      id: annId('m1'),
      imageId: createImageId('img'),
      contextId: createAnnotationContextId('ctx'),
    });
    await replaceMaskObject(canvas, annotation, '#f00', vi.fn(), () => false);
    expect(canvas.insertAt).not.toHaveBeenCalled();
  });
});

describe('MaskTintState', () => {
  it('records a tint only once its swap has landed', () => {
    const s = new MaskTintState();
    const first = s.plan({ id: 'a', fill: 'red' });
    expect(first.swaps).toEqual([{ id: 'a', fill: 'red' }]);
    // Nothing landed, so the same plan is wanted again — and the earlier one
    // is superseded, so it cannot land late.
    const again = s.plan({ id: 'a', fill: 'red' });
    expect(again.swaps).toEqual([{ id: 'a', fill: 'red' }]);
    expect(s.isCurrent(first.generation)).toBe(false);
    expect(s.isCurrent(again.generation)).toBe(true);

    s.landed('a', 'red', again.generation);
    expect(s.plan({ id: 'a', fill: 'red' }).swaps).toEqual([]);
  });

  it('ignores a landing from a superseded generation', () => {
    const s = new MaskTintState();
    const stale = s.plan({ id: 'a', fill: 'red' });
    s.plan(null);
    s.landed('a', 'red', stale.generation);
    expect(s.plan(null).swaps).toEqual([]);
  });

  it('plans the revert from what landed, and a rebuild resets the record', () => {
    const s = new MaskTintState();
    const p = s.plan({ id: 'a', fill: 'red' });
    s.landed('a', 'red', p.generation);
    expect(s.plan(null).swaps).toEqual([{ id: 'a', fill: undefined }]);

    // Objects just rebuilt carrying b's tint: a's pending revert is moot.
    const pending = s.plan({ id: 'a', fill: 'red' });
    s.rebuilt({ id: 'b', fill: 'red' });
    expect(s.isCurrent(pending.generation)).toBe(false);
    expect(s.plan(null).swaps).toEqual([{ id: 'b', fill: undefined }]);
  });
});

describe('swapMaskTints', () => {
  const snapshot = () => {
    const b = new BoundedDenseMaskBuffer({ imageWidth: 10, imageHeight: 10 });
    b.set(2, 2, 1);
    return b.snapshot();
  };
  const annotation = createMaskAnnotation(snapshot(), {
    id: annId('a'),
    imageId: 'img' as never,
    contextId: 'ctx' as never,
  });
  function host(objects: (FakeObject & FabricObject)[]) {
    const canvas = {
      getObjects: () => objects,
      insertAt: (index: number, ...added: FabricObject[]) => {
        objects.splice(index, 0, ...(added as (FakeObject & FabricObject)[]));
        return objects.length;
      },
      remove: (...removed: FabricObject[]) => {
        for (const o of removed) objects.splice(objects.indexOf(o as FakeObject & FabricObject), 1);
        return removed;
      },
      requestRenderAll: vi.fn(),
    };
    const applyModeToObject = vi.fn();
    const cache = new MaskObjectCache();
    return {
      objects,
      canvas: canvas as unknown as Parameters<typeof replaceMaskObject>[0],
      applyModeToObject,
      cache,
      annotations: new Map([['a', annotation]]),
      opacityFor: () => 0.5,
      isCancelled: () => false,
    };
  }

  it('lands a swap into the record and prepares the replacement', async () => {
    const previous = fake('a');
    previous._readOnly = true;
    const h = host([previous]);
    const next = fake('a');
    buildObject.mockResolvedValueOnce(next);
    const state = new MaskTintState();

    swapMaskTints(state, { id: 'a', fill: 'red' }, h);
    await vi.waitFor(() => expect(h.objects[0]).toBe(next));
    expect(next._readOnly).toBe(true);
    expect(h.applyModeToObject).toHaveBeenCalledWith(next, true);
    expect(next.opacity).toBe(0.5);
    expect(h.cache.get(annotation, 'red')).toBe(next);
    // Landed: reverting is now what a plan for no tint wants.
    expect(state.plan(null).swaps).toEqual([{ id: 'a', fill: undefined }]);
  });

  it('does not record a swap the stroke-hidden mask refused', async () => {
    const hidden = fake('a');
    (hidden as unknown as { visible: boolean }).visible = false;
    const h = host([hidden]);
    const state = new MaskTintState();
    const buildsBefore = buildObject.mock.calls.length;

    swapMaskTints(state, { id: 'a', fill: 'red' }, h);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(buildObject.mock.calls.length).toBe(buildsBefore);
    expect(h.objects[0]).toBe(hidden);
    // Still wanted: the next plan asks for it again instead of believing it landed.
    expect(state.plan({ id: 'a', fill: 'red' }).swaps).toEqual([{ id: 'a', fill: 'red' }]);
  });

  it('drops a swap superseded while it decoded', async () => {
    const previous = fake('a');
    const h = host([previous]);
    let release!: (o: FabricObject) => void;
    buildObject.mockReturnValueOnce(new Promise<FabricObject>((resolve) => (release = resolve)));
    const state = new MaskTintState();

    swapMaskTints(state, { id: 'a', fill: 'red' }, h);
    state.plan(null);
    release(fake('a'));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(h.objects[0]).toBe(previous);
    expect(state.plan(null).swaps).toEqual([]);
  });
});
