import { describe, expect, it } from 'vitest';
import type { ImageId } from '@osdlabel/viewer-api';
import { createImageId } from '@osdlabel/viewer-api';
import {
  getCellAssignmentState,
  getGridCellCount,
  CELL_ASSIGNMENT_BORDER_COLOR,
  CELL_ASSIGNMENT_PLACEHOLDER_BACKGROUND,
  CELL_ASSIGNMENT_TITLE,
  CELL_ASSIGNMENT_CLEAR_LABEL,
  CELL_ASSIGNMENT_STATE_LABEL,
  getCellAssignmentLabel,
  type CellAssignmentState,
  type CellAssignmentView,
} from '../../src/cell-assignment.js';

const IMG_A = createImageId('img-a');
const IMG_B = createImageId('img-b');
const IMG_C = createImageId('img-c');

/** A view with a 1-row grid wide enough for the given assignments by default. */
const view = (
  gridAssignments: Record<number, ImageId>,
  activeCellIndex: number,
  gridColumns: number,
  gridRows = 1,
): CellAssignmentView => ({ gridAssignments, activeCellIndex, gridColumns, gridRows });

describe('getGridCellCount', () => {
  it('multiplies both dimensions', () => {
    // Dropping either factor is the regression: a filmstrip that used only
    // `gridColumns` silently disabled the clear affordance for every cell
    // below the first row.
    expect(getGridCellCount(view({}, 0, 2, 2))).toBe(4);
    expect(getGridCellCount(view({}, 0, 3, 1))).toBe(3);
    expect(getGridCellCount(view({}, 0, 1, 3))).toBe(3);
  });
});

describe('getCellAssignmentState', () => {
  it("reports 'active' for the image in the active cell", () => {
    expect(getCellAssignmentState(view({ 0: IMG_A, 1: IMG_B }, 0, 2), IMG_A)).toBe('active');
  });

  it("reports 'other' for an image displayed only in a non-active cell", () => {
    expect(getCellAssignmentState(view({ 0: IMG_A, 1: IMG_B }, 0, 2), IMG_B)).toBe('other');
  });

  it("reports 'none' for an image displayed nowhere", () => {
    expect(getCellAssignmentState(view({ 0: IMG_A, 1: IMG_B }, 0, 2), IMG_C)).toBe('none');
  });

  it("prefers 'active' when the same image fills both the active cell and another", () => {
    // Otherwise the clear affordance would vanish whenever the user put the
    // same image side by side with itself.
    expect(getCellAssignmentState(view({ 0: IMG_A, 1: IMG_A }, 0, 2), IMG_A)).toBe('active');
  });

  it("reports 'none' for every image when the active cell is empty", () => {
    expect(getCellAssignmentState(view({}, 0, 1), IMG_A)).toBe('none');
  });

  it("reports 'other' when the active cell is empty but another cell shows the image", () => {
    // The active cell holding nothing must not make a used image look free —
    // the click assigns, and the border has to say so.
    expect(getCellAssignmentState(view({ 1: IMG_A }, 0, 2), IMG_A)).toBe('other');
  });

  it('counts cells in rows below the first', () => {
    // A view that only multiplied columns would treat cell 3 as out of grid.
    expect(getCellAssignmentState(view({ 3: IMG_A }, 3, 2, 2), IMG_A)).toBe('active');
    expect(getCellAssignmentState(view({ 3: IMG_A }, 0, 2, 2), IMG_A)).toBe('other');
  });

  describe('assignments that outlive a grid shrink', () => {
    // SET_GRID_DIMENSIONS deliberately keeps assignments for pruned cells so a
    // shrink/expand round trip restores them. They must not be reported as
    // visible, or the filmstrip describes cells nobody can see. (The active
    // cell needs no such guard — the reducer keeps it inside the grid.)
    it("does not report 'other' for an image held only by a pruned cell", () => {
      expect(getCellAssignmentState(view({ 0: IMG_A, 1: IMG_B }, 0, 1), IMG_B)).toBe('none');
    });

    it('still reports an image that a visible cell also holds', () => {
      expect(getCellAssignmentState(view({ 0: IMG_A, 1: IMG_A }, 0, 1), IMG_A)).toBe('active');
    });
  });
});

describe('cell-assignment palette', () => {
  // The whole justification for the tri-state is that a user can tell the three
  // apart. Collapsing two of them re-introduces the misleading highlight the
  // change set out to remove, and nothing else in the suite would notice.
  it('renders the three states distinguishably', () => {
    for (const map of [
      CELL_ASSIGNMENT_BORDER_COLOR,
      CELL_ASSIGNMENT_PLACEHOLDER_BACKGROUND,
      CELL_ASSIGNMENT_TITLE,
    ]) {
      const values = Object.values(map);
      expect(new Set(values).size).toBe(values.length);
    }
  });

  // Distinctness alone would let 'other' and 'none' swap: an unused image would
  // render in "in use elsewhere" blue and be tooltipped as shown in another
  // cell. Pin each state to its meaning, not just to being different.
  it('maps each state to copy describing what pressing it does', () => {
    expect(CELL_ASSIGNMENT_TITLE.active).toMatch(/shown in the active cell/i);
    expect(CELL_ASSIGNMENT_TITLE.other).toMatch(/another cell/i);
    expect(CELL_ASSIGNMENT_TITLE.none).toMatch(/^show .* active cell/i);
  });

  it('describes no particular gesture, since it is also the accessible description', () => {
    // With the thumbnail's aria-label set, its title is announced as the
    // description: "click" would be wrong for a keyboard or screen-reader user.
    for (const title of Object.values(CELL_ASSIGNMENT_TITLE)) {
      expect(title).not.toMatch(/click|tap|press/i);
    }
  });

  it('never promises a clear from a thumbnail, since only the badge clears', () => {
    // The tooltips describe the thumbnail's own gesture, which is assign-only.
    // Copy that said "click to remove" would invite exactly the double-click
    // wipe the separate badge exists to prevent.
    for (const title of Object.values(CELL_ASSIGNMENT_TITLE)) {
      expect(title).not.toMatch(/remove|clear/i);
    }
    // The badge carries that wording instead, and is the only thing that does.
    expect(CELL_ASSIGNMENT_CLEAR_LABEL).toMatch(/remove/i);
  });

  it('reserves the brightest border for the cell a click acts on', () => {
    // 'active' is the only state whose click changes the cell in front of the
    // user, so it gets the strongest signal; 'none' the weakest.
    const luminance = (hex: string): number => {
      const full =
        hex.length === 4 ? `#${hex[1]!}${hex[1]!}${hex[2]!}${hex[2]!}${hex[3]!}${hex[3]!}` : hex;
      const n = parseInt(full.slice(1), 16);
      return ((n >> 16) & 0xff) * 0.299 + ((n >> 8) & 0xff) * 0.587 + (n & 0xff) * 0.114;
    };

    expect(luminance(CELL_ASSIGNMENT_BORDER_COLOR.active)).toBeGreaterThan(
      luminance(CELL_ASSIGNMENT_BORDER_COLOR.other),
    );
    expect(luminance(CELL_ASSIGNMENT_BORDER_COLOR.other)).toBeGreaterThan(
      luminance(CELL_ASSIGNMENT_BORDER_COLOR.none),
    );
  });

  it('orders the placeholder backgrounds the same way as the borders', () => {
    // Distinctness alone lets 'other' and 'none' swap here too, which would
    // paint an unused image in the "in use elsewhere" tint. This is the
    // rendered branch whenever an image has no thumbnail.
    const blue = (hex: string): number =>
      parseInt(hex.slice(5, 7), 16) - parseInt(hex.slice(1, 3), 16);

    expect(blue(CELL_ASSIGNMENT_PLACEHOLDER_BACKGROUND.active)).toBeGreaterThan(
      blue(CELL_ASSIGNMENT_PLACEHOLDER_BACKGROUND.other),
    );
    expect(blue(CELL_ASSIGNMENT_PLACEHOLDER_BACKGROUND.other)).toBeGreaterThan(
      blue(CELL_ASSIGNMENT_PLACEHOLDER_BACKGROUND.none),
    );
  });
});

describe('getCellAssignmentState — an out-of-grid active cell is not "active"', () => {
  // These helpers take a plain view rather than the store, and `osdlabel` is the
  // framework-agnostic package: a host driving it with its own state is not
  // bound by the reducer's in-grid invariant. So the helper has to be total for
  // every input its type allows, not just for states the reducer can produce.

  it('does not report "active" for a cell past the end of the grid', () => {
    // 1x1 grid, but the caller's active cell is 7 and cell 7 holds IMG_A.
    const v = view({ 0: IMG_B, 7: IMG_A }, 7, 1, 1);

    expect(getCellAssignmentState(v, IMG_A)).toBe('none');
  });

  it('does not report "active" for a negative cell index', () => {
    const v = view({ [-1 as number]: IMG_A, 0: IMG_B }, -1, 1, 1);

    expect(getCellAssignmentState(v, IMG_A)).toBe('none');
  });

  it('still reports "other" when the image is also in a cell that exists', () => {
    // Scoping 'active' must not swallow the image entirely: cell 0 is real and
    // shows IMG_A, so the thumbnail should still read as in use elsewhere.
    const v = view({ 0: IMG_A, 7: IMG_A }, 7, 1, 1);

    expect(getCellAssignmentState(v, IMG_A)).toBe('other');
  });

  it('offers no clear control for such a cell', () => {
    // `'active'` is what renders the clear badge, so scoping it is what keeps
    // the destructive control off a thumbnail whose cell nobody can see. An
    // assign into that cell is still possible and still harmless — it only
    // overwrites, where a clear would delete the cell's view transform.
    const v = view({ 7: IMG_A }, 7, 1, 1);

    expect(getCellAssignmentState(v, IMG_A)).not.toBe('active');
  });
});

describe('getCellAssignmentLabel', () => {
  it('names the image and states its assignment', () => {
    expect(getCellAssignmentLabel('Landscape', 'active')).toBe(
      'Landscape, shown in the active cell',
    );
    expect(getCellAssignmentLabel('Landscape', 'other')).toBe('Landscape, shown in another cell');
    expect(getCellAssignmentLabel('Landscape', 'none')).toBe('Landscape, not shown');
  });

  it('gives each state a distinct phrase that promises no gesture', () => {
    // The accessible name must tell the three states apart, as the border does
    // for sighted users. It describes state, not an action: "click" would be
    // wrong for a keyboard user, and a thumbnail never clears.
    const states: readonly CellAssignmentState[] = ['active', 'other', 'none'];
    const phrases = states.map((s) => CELL_ASSIGNMENT_STATE_LABEL[s]);
    expect(new Set(phrases).size).toBe(states.length);
    for (const phrase of phrases) {
      expect(phrase).not.toMatch(/click|clear|remove/i);
    }
  });
});
