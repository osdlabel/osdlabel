import type { ImageId, UIState } from '@osdlabel/viewer-api';

/**
 * The slice of {@link UIState} the cell-assignment helpers read.
 *
 * They take state rather than pre-computed indices so no caller derives the
 * cell count itself — it is `gridColumns * gridRows`, and silently wrong for
 * every cell below the first row if either factor is forgotten.
 */
export type CellAssignmentView = Pick<
  UIState,
  'gridAssignments' | 'activeCellIndex' | 'gridColumns' | 'gridRows'
>;

/**
 * How a filmstrip image relates to the grid cell the user is currently acting
 * on: shown in the active cell, shown in some other visible cell, or not shown
 * at all.
 *
 * Only `'active'` offers the clear control, so the distinction is what lets the
 * highlight match the gestures the thumbnail actually has.
 */
export type CellAssignmentState = 'active' | 'other' | 'none';

/** The grid's size, as {@link getGridCellCount} needs it. */
export type GridDimensions = Pick<UIState, 'gridColumns' | 'gridRows'>;

/**
 * Number of cells the grid currently renders.
 *
 * Takes only the dimensions so every caller that needs the count — including
 * the keyboard mapper, which has no grid assignments — can share it.
 */
export function getGridCellCount(grid: GridDimensions): number {
  return grid.gridColumns * grid.gridRows;
}

/**
 * Whether `imageId` occupies any cell inside the visible grid.
 *
 * Scans indices below the cell count rather than enumerating the record:
 * `SET_GRID_DIMENSIONS` deliberately keeps assignments for pruned cells so a
 * shrink/expand round trip restores them, so the record outlives the grid.
 */
function isShownInAnyCell(view: CellAssignmentView, imageId: ImageId): boolean {
  const cellCount = getGridCellCount(view);
  for (let index = 0; index < cellCount; index += 1) {
    if (view.gridAssignments[index] === imageId) return true;
  }
  return false;
}

/**
 * Derives an image's {@link CellAssignmentState}.
 *
 * Framework-agnostic so the SolidJS and React filmstrips share one definition
 * of the three states rather than each re-deriving them.
 */
export function getCellAssignmentState(
  view: CellAssignmentView,
  imageId: ImageId,
): CellAssignmentState {
  // Both non-`none` states are scoped by the cell count. `'other'` because
  // assignments outlive the cells a shrink pruned. `'active'` because this
  // takes a plain view, not the store: a host driving `osdlabel` with its own
  // state is not bound by the reducer's in-grid invariant, and an out-of-grid
  // active cell must not offer a clear for a cell nobody renders.
  const cellCount = getGridCellCount(view);
  const activeIndex = view.activeCellIndex;
  if (activeIndex >= 0 && activeIndex < cellCount) {
    if (view.gridAssignments[activeIndex] === imageId) return 'active';
  }
  return isShownInAnyCell(view, imageId) ? 'other' : 'none';
}

/**
 * Thumbnail border colour per state. Bright blue marks the image the active
 * cell is showing; the muted blue means "in use, but in another cell".
 *
 * These live here, rather than in each framework's `Filmstrip`, so the two
 * cannot drift into disagreeing about what a colour means — the same reason
 * `VIEWER_CONTROL_SPECS` is shared from here. Keying them on
 * {@link CellAssignmentState} makes a newly added state a compile error at
 * every map. The copy below is not localizable yet; there is no i18n seam.
 */
export const CELL_ASSIGNMENT_BORDER_COLOR: Readonly<Record<CellAssignmentState, string>> = {
  active: '#2196F3',
  other: '#1565C0',
  none: '#333',
};

/** Background for a thumbnail with no image, per state. */
export const CELL_ASSIGNMENT_PLACEHOLDER_BACKGROUND: Readonly<Record<CellAssignmentState, string>> =
  {
    active: '#2a3a5e',
    other: '#252d42',
    none: '#2a2a3e',
  };

/**
 * Hover text per state, describing what pressing the thumbnail does. A
 * thumbnail only ever assigns, so none of these promises a clear — that is the
 * separate badge control.
 *
 * Gesture-neutral ("show", not "click"): next to the thumbnail's `aria-label`
 * the `title` is exposed as its accessible description, so screen-reader and
 * keyboard users hear it too.
 */
export const CELL_ASSIGNMENT_TITLE: Readonly<Record<CellAssignmentState, string>> = {
  active: 'Shown in the active cell',
  other: 'Shown in another cell — also show it in the active cell',
  none: 'Show this image in the active cell',
};

/** Accessible name for the badge control that empties the active cell. */
export const CELL_ASSIGNMENT_CLEAR_LABEL = 'Remove this image from the active cell';

/**
 * Short state phrase for a thumbnail's accessible name. Unlike
 * {@link CELL_ASSIGNMENT_TITLE} (hover text, which describes what pressing it
 * does), this states the thumbnail's state.
 */
export const CELL_ASSIGNMENT_STATE_LABEL: Readonly<Record<CellAssignmentState, string>> = {
  active: 'shown in the active cell',
  other: 'shown in another cell',
  none: 'not shown',
};

/**
 * Accessible name for a filmstrip thumbnail: the image's name and its
 * {@link CellAssignmentState}, e.g. `"Landscape, shown in the active cell"`.
 *
 * The state is part of the name rather than an `aria-description` because
 * support for the latter is uneven, and the three states are exactly what the
 * tri-state border shows sighted users.
 */
export function getCellAssignmentLabel(imageName: string, state: CellAssignmentState): string {
  return `${imageName}, ${CELL_ASSIGNMENT_STATE_LABEL[state]}`;
}
