import { describe, expect, it } from 'vitest';
import type { ToolType } from '@osdlabel/annotation';
import type {
  AnnotationContext,
  AnnotationContextId,
  ConstraintStatus,
} from '@osdlabel/annotation-context';
import type { AnnotationId } from '@osdlabel/annotation';
import type { ImageId } from '@osdlabel/viewer-api';
import { DEFAULT_KEYBOARD_SHORTCUTS, mapKeyEventToActions } from '../../src/keyboard.js';
import type { KeyboardMappingState } from '../../src/keyboard.js';

const TOOL_TYPES: readonly ToolType[] = [
  'rectangle',
  'circle',
  'line',
  'point',
  'polyline',
  'freeHandPath',
];

const ALL_ENABLED: ConstraintStatus = Object.fromEntries(
  TOOL_TYPES.map((type) => [type, { enabled: true, currentCount: 0, maxCount: null }]),
) as ConstraintStatus;

const STATE: KeyboardMappingState = {
  activeTool: null,
  activeCellIndex: 3,
  gridColumns: 2,
  gridRows: 2,
  selectedAnnotationId: null,
  activeImageId: undefined,
};

describe('mapKeyEventToActions — tonal adjustments', () => {
  it('maps Shift+C to INCREASE_CONTRAST for the active cell', () => {
    const actions = mapKeyEventToActions('C', true, DEFAULT_KEYBOARD_SHORTCUTS, STATE, ALL_ENABLED);
    expect(actions).toEqual([{ type: 'INCREASE_CONTRAST', payload: { cellIndex: 3 } }]);
  });

  it('maps Shift+X to DECREASE_CONTRAST for the active cell', () => {
    const actions = mapKeyEventToActions('X', true, DEFAULT_KEYBOARD_SHORTCUTS, STATE, ALL_ENABLED);
    expect(actions).toEqual([{ type: 'DECREASE_CONTRAST', payload: { cellIndex: 3 } }]);
  });

  it('maps Shift+E / Shift+D to the exposure actions', () => {
    expect(mapKeyEventToActions('E', true, DEFAULT_KEYBOARD_SHORTCUTS, STATE, ALL_ENABLED)).toEqual(
      [{ type: 'INCREASE_EXPOSURE', payload: { cellIndex: 3 } }],
    );
    expect(mapKeyEventToActions('D', true, DEFAULT_KEYBOARD_SHORTCUTS, STATE, ALL_ENABLED)).toEqual(
      [{ type: 'DECREASE_EXPOSURE', payload: { cellIndex: 3 } }],
    );
  });

  it('leaves the unshifted tool shortcuts on c / x alone', () => {
    // 'c' without Shift is the circle tool, not contrast.
    expect(
      mapKeyEventToActions('c', false, DEFAULT_KEYBOARD_SHORTCUTS, STATE, ALL_ENABLED),
    ).toEqual([{ type: 'SET_ACTIVE_TOOL', payload: 'circle' }]);
    // 'x' is unbound.
    expect(
      mapKeyEventToActions('x', false, DEFAULT_KEYBOARD_SHORTCUTS, STATE, ALL_ENABLED),
    ).toEqual([]);
  });
});

describe('mapKeyEventToActions — annotation context cycling', () => {
  const ctxId = (s: string): AnnotationContextId => s as AnnotationContextId;
  const imgId = (s: string): ImageId => s as ImageId;

  const makeContext = (id: string, imageIds?: readonly ImageId[]): AnnotationContext => ({
    id: ctxId(id),
    label: id,
    tools: [],
    ...(imageIds !== undefined ? { imageIds } : {}),
  });

  const CONTEXTS = [makeContext('a'), makeContext('b'), makeContext('c')];

  const withContexts = (activeContextId: AnnotationContextId | null): KeyboardMappingState => ({
    ...STATE,
    contexts: CONTEXTS,
    activeContextId,
  });

  it("maps '.' to the next context and ',' to the previous one", () => {
    expect(
      mapKeyEventToActions(
        '.',
        false,
        DEFAULT_KEYBOARD_SHORTCUTS,
        withContexts(ctxId('a')),
        ALL_ENABLED,
      ),
    ).toEqual([{ type: 'SET_ACTIVE_CONTEXT', payload: ctxId('b') }]);

    expect(
      mapKeyEventToActions(
        ',',
        false,
        DEFAULT_KEYBOARD_SHORTCUTS,
        withContexts(ctxId('b')),
        ALL_ENABLED,
      ),
    ).toEqual([{ type: 'SET_ACTIVE_CONTEXT', payload: ctxId('a') }]);
  });

  it('wraps around at both ends', () => {
    expect(
      mapKeyEventToActions(
        '.',
        false,
        DEFAULT_KEYBOARD_SHORTCUTS,
        withContexts(ctxId('c')),
        ALL_ENABLED,
      ),
    ).toEqual([{ type: 'SET_ACTIVE_CONTEXT', payload: ctxId('a') }]);

    expect(
      mapKeyEventToActions(
        ',',
        false,
        DEFAULT_KEYBOARD_SHORTCUTS,
        withContexts(ctxId('a')),
        ALL_ENABLED,
      ),
    ).toEqual([{ type: 'SET_ACTIVE_CONTEXT', payload: ctxId('c') }]);
  });

  it("accepts the shifted '>' / '<' variants of the default bindings", () => {
    expect(
      mapKeyEventToActions(
        '>',
        true,
        DEFAULT_KEYBOARD_SHORTCUTS,
        withContexts(ctxId('a')),
        ALL_ENABLED,
      ),
    ).toEqual([{ type: 'SET_ACTIVE_CONTEXT', payload: ctxId('b') }]);

    expect(
      mapKeyEventToActions(
        '<',
        true,
        DEFAULT_KEYBOARD_SHORTCUTS,
        withContexts(ctxId('b')),
        ALL_ENABLED,
      ),
    ).toEqual([{ type: 'SET_ACTIVE_CONTEXT', payload: ctxId('a') }]);
  });

  it('activates the first / last context when none is active yet', () => {
    expect(
      mapKeyEventToActions('.', false, DEFAULT_KEYBOARD_SHORTCUTS, withContexts(null), ALL_ENABLED),
    ).toEqual([{ type: 'SET_ACTIVE_CONTEXT', payload: ctxId('a') }]);

    expect(
      mapKeyEventToActions(',', false, DEFAULT_KEYBOARD_SHORTCUTS, withContexts(null), ALL_ENABLED),
    ).toEqual([{ type: 'SET_ACTIVE_CONTEXT', payload: ctxId('c') }]);
  });

  it('skips contexts not scoped to the active image', () => {
    const state: KeyboardMappingState = {
      ...STATE,
      activeImageId: imgId('img-1'),
      contexts: [makeContext('a'), makeContext('b', [imgId('other')]), makeContext('c')],
      activeContextId: ctxId('a'),
    };
    expect(
      mapKeyEventToActions('.', false, DEFAULT_KEYBOARD_SHORTCUTS, state, ALL_ENABLED),
    ).toEqual([{ type: 'SET_ACTIVE_CONTEXT', payload: ctxId('c') }]);
  });

  it('emits nothing when there is no other context to cycle to', () => {
    const single = withContexts(ctxId('a'));
    expect(
      mapKeyEventToActions(
        '.',
        false,
        DEFAULT_KEYBOARD_SHORTCUTS,
        { ...single, contexts: [makeContext('a')] },
        ALL_ENABLED,
      ),
    ).toEqual([]);

    // No contexts configured at all — the state fields are optional.
    expect(
      mapKeyEventToActions('.', false, DEFAULT_KEYBOARD_SHORTCUTS, STATE, ALL_ENABLED),
    ).toEqual([]);
  });

  it('does not collide with the other punctuation shortcuts', () => {
    const state = withContexts(ctxId('a'));
    // Grid row / column bindings still win on their own keys.
    expect(
      mapKeyEventToActions('[', false, DEFAULT_KEYBOARD_SHORTCUTS, state, ALL_ENABLED),
    ).toEqual([{ type: 'SET_GRID_DIMENSIONS', payload: { columns: 2, rows: 1 } }]);
    expect(
      mapKeyEventToActions('-', false, DEFAULT_KEYBOARD_SHORTCUTS, state, ALL_ENABLED),
    ).toEqual([{ type: 'SET_GRID_DIMENSIONS', payload: { columns: 1, rows: 2 } }]);
  });
});

describe('Delete over a cell with no image', () => {
  const imgId = (s: string): ImageId => s as ImageId;
  const annId = (s: string): AnnotationId => s as AnnotationId;

  it('deletes the selected annotation when the active cell shows an image', () => {
    const state: KeyboardMappingState = {
      ...STATE,
      activeImageId: imgId('img-1'),
      selectedAnnotationId: annId('ann-1'),
    };

    expect(
      mapKeyEventToActions('Delete', false, DEFAULT_KEYBOARD_SHORTCUTS, state, ALL_ENABLED),
    ).toEqual([
      { type: 'DELETE_ANNOTATION', payload: { id: annId('ann-1'), imageId: imgId('img-1') } },
      { type: 'SET_SELECTED_ANNOTATION', payload: null },
    ]);
  });

  it('emits nothing when the active cell has been emptied', () => {
    // Unassigning a cell deliberately leaves `selectedAnnotationId` set, because
    // another cell may still be showing that image. This is what makes that
    // safe: with no active image, Delete is a no-op rather than removing an
    // annotation the user cannot see in the cell they are acting on.
    const state: KeyboardMappingState = {
      ...STATE,
      activeImageId: undefined,
      selectedAnnotationId: annId('ann-1'),
    };

    expect(
      mapKeyEventToActions('Delete', false, DEFAULT_KEYBOARD_SHORTCUTS, state, ALL_ENABLED),
    ).toEqual([]);
  });
});

describe('cell-selection shortcuts are screened against the grid', () => {
  const grid = (gridColumns: number, gridRows: number): KeyboardMappingState => ({
    ...STATE,
    gridColumns,
    gridRows,
  });

  it('selects a cell that the grid renders', () => {
    expect(
      mapKeyEventToActions('4', false, DEFAULT_KEYBOARD_SHORTCUTS, grid(2, 2), ALL_ENABLED),
    ).toEqual([{ type: 'SET_ACTIVE_CELL', payload: 3 }]);
  });

  it('emits nothing for a digit past the end of the grid', () => {
    // The default grid is 1x1, so `2` names a cell nobody can see. Letting it
    // through leaves every action keyed on the active cell editing offscreen
    // state, and the filmstrip's clear affordance vanishes with no visible
    // cause.
    expect(
      mapKeyEventToActions('2', false, DEFAULT_KEYBOARD_SHORTCUTS, grid(1, 1), ALL_ENABLED),
    ).toEqual([]);

    expect(
      mapKeyEventToActions('9', false, DEFAULT_KEYBOARD_SHORTCUTS, grid(1, 1), ALL_ENABLED),
    ).toEqual([]);
  });

  it('counts rows as well as columns when deciding what exists', () => {
    // A guard that only looked at `gridColumns` would reject cell 2 on a 2x2.
    expect(
      mapKeyEventToActions('3', false, DEFAULT_KEYBOARD_SHORTCUTS, grid(2, 2), ALL_ENABLED),
    ).toEqual([{ type: 'SET_ACTIVE_CELL', payload: 2 }]);

    expect(
      mapKeyEventToActions('3', false, DEFAULT_KEYBOARD_SHORTCUTS, grid(2, 1), ALL_ENABLED),
    ).toEqual([]);
  });

  it('always allows the first cell', () => {
    expect(
      mapKeyEventToActions('1', false, DEFAULT_KEYBOARD_SHORTCUTS, grid(1, 1), ALL_ENABLED),
    ).toEqual([{ type: 'SET_ACTIVE_CELL', payload: 0 }]);
  });
});
