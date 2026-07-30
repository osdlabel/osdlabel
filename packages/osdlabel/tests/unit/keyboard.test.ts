import { describe, expect, it } from 'vitest';
import type { ToolType } from '@osdlabel/annotation';
import type { ConstraintStatus } from '@osdlabel/annotation-context';
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
