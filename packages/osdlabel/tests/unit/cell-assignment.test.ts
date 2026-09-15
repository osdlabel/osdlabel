import { describe, expect, it } from 'vitest';
import type { ImageId } from '@osdlabel/viewer-api';
import { createImageId } from '@osdlabel/viewer-api';
import {
  getCellAssignmentState,
  resolveFilmstripClick,
  CELL_ASSIGNMENT_BORDER_COLOR,
  CELL_ASSIGNMENT_PLACEHOLDER_BACKGROUND,
  CELL_ASSIGNMENT_TITLE,
} from '../../src/cell-assignment.js';

const IMG_A = createImageId('img-a');
const IMG_B = createImageId('img-b');
const IMG_C = createImageId('img-c');

const assignments = (entries: Record<number, ImageId>): Readonly<Record<number, ImageId>> =>
  entries;

describe('getCellAssignmentState', () => {
  it("reports 'active' for the image in the active cell", () => {
    expect(getCellAssignmentState(assignments({ 0: IMG_A, 1: IMG_B }), 0, IMG_A, 2)).toBe('active');
  });

  it("reports 'other' for an image displayed only in a non-active cell", () => {
    expect(getCellAssignmentState(assignments({ 0: IMG_A, 1: IMG_B }), 0, IMG_B, 2)).toBe('other');
  });

  it("reports 'none' for an image displayed nowhere", () => {
    expect(getCellAssignmentState(assignments({ 0: IMG_A, 1: IMG_B }), 0, IMG_C, 2)).toBe('none');
  });

  it("prefers 'active' when the same image fills both the active cell and another", () => {
    // Otherwise the clear affordance would vanish whenever the user put the
    // same image side by side with itself.
    expect(getCellAssignmentState(assignments({ 0: IMG_A, 1: IMG_A }), 0, IMG_A, 2)).toBe('active');
  });

  it("reports 'none' for every image when the active cell is empty", () => {
    expect(getCellAssignmentState(assignments({}), 0, IMG_A, 1)).toBe('none');
  });

  it("reports 'other' when the active cell is empty but another cell shows the image", () => {
    // The active cell holding nothing must not make a used image look free —
    // the click assigns, and the border has to say so.
    expect(getCellAssignmentState(assignments({ 1: IMG_A }), 0, IMG_A, 2)).toBe('other');
  });

  describe('assignments that outlive a grid shrink', () => {
    // SET_GRID_DIMENSIONS deliberately keeps assignments for pruned cells so a
    // shrink/expand round trip restores them. They must not be reported as
    // visible, or the filmstrip describes cells nobody can see.
    it("does not report 'other' for an image held only by a pruned cell", () => {
      expect(getCellAssignmentState(assignments({ 0: IMG_A, 1: IMG_B }), 0, IMG_B, 1)).toBe('none');
    });

    it("does not report 'active' when activeCellIndex itself is outside the grid", () => {
      // The reducer clamps activeCellIndex, but the helper must not depend on
      // that: a stale index would otherwise render a clear affordance for an
      // offscreen cell, and clicking it would change nothing visible.
      expect(getCellAssignmentState(assignments({ 0: IMG_A, 1: IMG_B }), 1, IMG_B, 1)).toBe('none');
    });

    it('still reports an image that a visible cell also holds', () => {
      expect(getCellAssignmentState(assignments({ 0: IMG_A, 1: IMG_A }), 1, IMG_A, 1)).toBe(
        'other',
      );
    });
  });
});

describe('resolveFilmstripClick', () => {
  it('unassigns the active cell when it already shows the clicked image', () => {
    expect(resolveFilmstripClick(assignments({ 0: IMG_A }), 0, IMG_A, 1)).toEqual({
      type: 'unassign',
      cellIndex: 0,
    });
  });

  it('assigns into the active cell when the image is shown elsewhere', () => {
    expect(resolveFilmstripClick(assignments({ 0: IMG_A, 1: IMG_B }), 1, IMG_A, 2)).toEqual({
      type: 'assign',
      cellIndex: 1,
      imageId: IMG_A,
    });
  });

  it('assigns into the active cell when the image is shown nowhere', () => {
    expect(resolveFilmstripClick(assignments({}), 0, IMG_A, 1)).toEqual({
      type: 'assign',
      cellIndex: 0,
      imageId: IMG_A,
    });
  });

  // The regression this function exists to make untestable-by-inspection:
  // a filmstrip that hardcoded cell 0, or reached for the wrong index, would
  // wipe a cell the user was not acting on. Every E2E path happens to run with
  // the active cell at 0, so only an explicit non-zero case pins it.
  it('always names the ACTIVE cell, never cell 0, when clearing', () => {
    expect(resolveFilmstripClick(assignments({ 0: IMG_A, 1: IMG_B }), 1, IMG_B, 2)).toEqual({
      type: 'unassign',
      cellIndex: 1,
    });
  });

  it('always names the ACTIVE cell, never cell 0, when assigning', () => {
    expect(resolveFilmstripClick(assignments({ 0: IMG_A }), 2, IMG_C, 4)).toEqual({
      type: 'assign',
      cellIndex: 2,
      imageId: IMG_C,
    });
  });
});

describe('cell-assignment palette', () => {
  // The whole justification for the tri-state is that a user can tell the three
  // apart. Collapsing two of them re-introduces the misleading highlight the
  // change set out to remove, and nothing else in the suite would notice.
  it('renders the three states distinguishably', () => {
    const borders = Object.values(CELL_ASSIGNMENT_BORDER_COLOR);
    expect(new Set(borders).size).toBe(borders.length);

    const backgrounds = Object.values(CELL_ASSIGNMENT_PLACEHOLDER_BACKGROUND);
    expect(new Set(backgrounds).size).toBe(backgrounds.length);

    const titles = Object.values(CELL_ASSIGNMENT_TITLE);
    expect(new Set(titles).size).toBe(titles.length);
  });

  it('describes only the active state as clearing the cell', () => {
    expect(CELL_ASSIGNMENT_TITLE.active).toMatch(/remove/i);
    expect(CELL_ASSIGNMENT_TITLE.other).not.toMatch(/remove/i);
    expect(CELL_ASSIGNMENT_TITLE.none).not.toMatch(/remove/i);
  });
});
