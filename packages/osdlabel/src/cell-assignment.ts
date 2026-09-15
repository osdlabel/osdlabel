import type { ImageId, UIState } from '@osdlabel/viewer-api';

/**
 * The slice of {@link UIState} the cell-assignment helpers read.
 *
 * They take the state rather than pre-computed indices so a caller cannot
 * derive one of the inputs wrongly — an earlier revision had each framework's
 * filmstrip compute the cell count itself, and dropping `gridRows` from that
 * product silently disabled the clear affordance for every cell below the
 * first row.
 */
export type CellAssignmentView = Pick<
  UIState,
  'gridAssignments' | 'activeCellIndex' | 'gridColumns' | 'gridRows'
>;

/**
 * How a filmstrip image relates to the grid cell the user is currently acting
 * on.
 *
 * - `'active'` — displayed in the active cell. Clicking it clears that cell.
 * - `'other'`  — displayed in some other visible cell, but not the active one.
 *                Clicking it assigns it into the active cell.
 * - `'none'`   — not displayed in any visible cell. Clicking it assigns it into
 *                the active cell.
 *
 * The distinction between `'active'` and `'other'` is what lets the filmstrip
 * highlight match the gesture it offers: only `'active'` toggles off.
 */
export type CellAssignmentState = 'active' | 'other' | 'none';

/** The grid's size, as {@link getGridCellCount} needs it. */
export type GridDimensions = Pick<UIState, 'gridColumns' | 'gridRows'>;

/**
 * What a click on a filmstrip thumbnail should do.
 *
 * `'noop'` covers an active cell index that is outside the grid. The library's
 * own entry points cannot produce that — the cell-selection shortcuts are
 * screened against the grid size — but `setActiveCell` is public and
 * unvalidated, so a host can. Acting on it would write state for a cell nobody
 * can see, which only surfaces when the grid is later widened.
 */
export type FilmstripClickAction =
  | { readonly type: 'assign'; readonly cellIndex: number; readonly imageId: ImageId }
  | { readonly type: 'unassign'; readonly cellIndex: number }
  | { readonly type: 'noop' };

/**
 * Number of cells the grid currently renders.
 *
 * Takes only the dimensions so every caller that needs the count — including
 * the keyboard mapper, which has no grid assignments — can share it rather than
 * multiplying the two fields itself.
 */
export function getGridCellCount(grid: GridDimensions): number {
  return grid.gridColumns * grid.gridRows;
}

/**
 * Whether the active cell index addresses a cell that is actually on screen.
 *
 * When this is false nothing in the filmstrip can act — {@link
 * resolveFilmstripClick} returns `'noop'` — so the UI should say so rather than
 * keep offering a click that does nothing.
 */
export function hasVisibleActiveCell(view: CellAssignmentView): boolean {
  return view.activeCellIndex >= 0 && view.activeCellIndex < getGridCellCount(view);
}

/**
 * Whether `imageId` occupies any cell inside the visible grid.
 *
 * Scanning indices below the cell count rather than enumerating the record
 * matters: `SET_GRID_DIMENSIONS` deliberately leaves assignments for pruned
 * cells in place so a shrink/expand round trip restores them, so the record
 * outlives the grid and enumeration would count a cell nobody can see.
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
  if (hasVisibleActiveCell(view) && view.gridAssignments[view.activeCellIndex] === imageId) {
    return 'active';
  }
  return isShownInAnyCell(view, imageId) ? 'other' : 'none';
}

/**
 * The image displayed in the active cell, or `undefined` when no visible cell
 * is active.
 *
 * Scoped to the grid for the same reason the state derivation is: assignments
 * for cells pruned by a shrink are deliberately kept, so reading
 * `gridAssignments[activeCellIndex]` directly can name an image that no cell on
 * screen is showing.
 *
 * Both framework contexts expose this as `activeImageId`, and everything keyed
 * on "the active image" reads it from there — tool constraints, the toolbar's
 * selected-annotation lookup behind Convert-to-Rect, the Delete shortcut, and
 * the status bar. Deriving it locally instead reintroduces the hazard: the
 * action would target an image the user cannot see.
 */
export function getActiveCellImageId(view: CellAssignmentView): ImageId | undefined {
  return hasVisibleActiveCell(view) ? view.gridAssignments[view.activeCellIndex] : undefined;
}

/**
 * Resolves a click on a filmstrip thumbnail into the state change it should
 * cause: clicking the image the active cell already shows clears that cell,
 * anything else assigns into it.
 *
 * Pure and shared so both framework filmstrips route a click through one tested
 * decision — in particular one that always names the *active* cell, and that
 * refuses to act at all when no visible cell is active.
 */
export function resolveFilmstripClick(
  view: CellAssignmentView,
  imageId: ImageId,
): FilmstripClickAction {
  // Guarded for the same reason `getCellAssignmentState` never reports
  // `'active'` for an off-grid index: otherwise a click would write an
  // assignment for an invisible cell, changing nothing on screen until a later
  // grid resize made the image appear from nowhere.
  if (!hasVisibleActiveCell(view)) return { type: 'noop' };

  const state = getCellAssignmentState(view, imageId);
  return state === 'active'
    ? { type: 'unassign', cellIndex: view.activeCellIndex }
    : { type: 'assign', cellIndex: view.activeCellIndex, imageId };
}

/**
 * Thumbnail border colour per state. Bright blue is reserved for the cell a
 * click will act on; the muted blue means "in use, but in another cell".
 *
 * These live here, rather than in each framework's `Filmstrip`, so the two
 * cannot drift into disagreeing about what a colour means, for the same reason
 * `VIEWER_CONTROL_SPECS` is shared from here. Keying them on
 * {@link CellAssignmentState} also makes a newly
 * added state a compile error at every map. Note the copy below is not
 * localizable yet; there is no i18n seam in the library.
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

/** Tooltip describing what a click will do, per state. */
export const CELL_ASSIGNMENT_TITLE: Readonly<Record<CellAssignmentState, string>> = {
  active: 'Click to remove this image from the active cell',
  other: 'Shown in another cell — click to also show it in the active cell',
  none: 'Click to show this image in the active cell',
};
